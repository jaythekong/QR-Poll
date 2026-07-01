'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'poll.config.json');

// ---------------------------------------------------------------------------
// Admin auth (passcode gate)
//   - A passcode is required for every privileged action: editing the poll
//     (POST /api/config), uploading images, and the host controls
//     (open / close / reset). Public read-only surfaces — the host screen, the
//     live results, the QR code and voting — stay open.
//   - The passcode comes from the ADMIN_PASSCODE env var; if unset it falls back
//     to the built-in default below, so the gate is ALWAYS on (you can't ship
//     an unprotected poll by forgetting to set the var). Override the env var to
//     rotate it without a code change.
//   - NOTE: the default below is committed to the repo. If this repo is PUBLIC,
//     anyone can read it — set ADMIN_PASSCODE in your host (Render/Railway) to a
//     private value instead, or keep the repo private.
// State is in-memory, matching the app's single-instance model.
// ---------------------------------------------------------------------------
const DEFAULT_PASSCODE = 'firstwave';
const ADMIN_PASSCODE = (process.env.ADMIN_PASSCODE || DEFAULT_PASSCODE).trim();
const AUTH_REQUIRED = ADMIN_PASSCODE.length > 0;
const adminTokens = new Set(); // tokens handed out to authenticated admins

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false; // length leak is acceptable here
  return crypto.timingSafeEqual(ab, bb);
}

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  // Soft cap so a long-lived process can't accumulate tokens without bound.
  if (adminTokens.size > 200) {
    adminTokens.delete(adminTokens.values().next().value);
  }
  return token;
}

function validToken(token) {
  return typeof token === 'string' && token.length > 0 && adminTokens.has(token);
}

// Express guard for privileged HTTP routes.
function requireAdmin(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  if (validToken(req.get('x-admin-token'))) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Guard for privileged socket events; the client passes { token } in the payload.
function socketIsAdmin(payload) {
  if (!AUTH_REQUIRED) return true;
  return validToken(payload && payload.token);
}

// ---------------------------------------------------------------------------
// Poll state (in-memory — single active poll, per the PRD's v1 scope)
// ---------------------------------------------------------------------------

// An option in the config may be a plain string ("ChatGPT") or an object
// ({ label, icon }). Normalize both to { id, label, icon, votes }.
function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return {
    logo: raw.logo || '/logo.svg',
    question: raw.question || 'Cast your vote',
    options: (raw.options || []).map((opt, i) => {
      const o = typeof opt === 'string' ? { label: opt } : opt || {};
      return {
        id: String(i),
        label: String(o.label || ''),
        icon: o.icon ? String(o.icon) : '',
        votes: 0
      };
    })
  };
}

let poll;
let open = true;
// deviceId -> optionId it voted for (one vote per device, F6). Tracking the
// chosen option lets a voter cancel and re-vote.
const deviceVotes = new Map();

function resetPoll(reloadConfig) {
  if (reloadConfig || !poll) {
    poll = loadConfig();
  } else {
    poll.options.forEach((o) => (o.votes = 0));
  }
  deviceVotes.clear();
}

resetPoll(true);

function publicState() {
  const total = poll.options.reduce((sum, o) => sum + o.votes, 0);
  return {
    logo: poll.logo,
    question: poll.question,
    open,
    total,
    options: poll.options.map((o) => ({
      id: o.id,
      label: o.label,
      icon: o.icon,
      votes: o.votes,
      percent: total === 0 ? 0 : Math.round((o.votes / total) * 100)
    }))
  };
}

// ---------------------------------------------------------------------------
// Network: figure out a LAN address so phones in the room can reach the host
// ---------------------------------------------------------------------------

function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// The QR code must point at a URL voters can actually reach.
//  - In production set PUBLIC_URL (e.g. https://poll.example.com).
//  - Render and Railway expose their public URL automatically, so we detect it.
//  - Locally we fall back to the LAN address so phones on the same Wi-Fi can scan.
function publicOrigin() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://${lanAddress()}:${PORT}`;
}
const PUBLIC_ORIGIN = publicOrigin();
const VOTER_URL = `${PUBLIC_ORIGIN}/vote`;

// ---------------------------------------------------------------------------
// HTTP + Socket.io
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '6mb' })); // room for base64 image uploads
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'host.html'))
);
app.get('/vote', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'vote.html'))
);
app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

// Whether the admin surfaces need a passcode (lets the client show the right UI).
app.get('/api/auth-status', (_req, res) => {
  res.json({ required: AUTH_REQUIRED });
});

// Exchange the passcode for a session token used on privileged requests.
app.post('/api/login', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ ok: true, token: '' });
  const passcode = String((req.body && req.body.passcode) || '');
  if (passcode && safeEqual(passcode, ADMIN_PASSCODE)) {
    return res.json({ ok: true, token: issueToken() });
  }
  return res.status(401).json({ error: 'bad_passcode' });
});

// Current poll config (raw), for populating the admin form.
app.get('/api/config', (_req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: 'read_failed' });
  }
});

// Save a new poll definition from the admin page, then start a fresh round.
app.post('/api/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const question = String(body.question || '').trim();
  const logo = String(body.logo || '/logo.svg').trim() || '/logo.svg';
  const options = Array.isArray(body.options)
    ? body.options
        .map((o) => ({
          label: String((o && o.label) || '').trim(),
          icon: String((o && o.icon) || '').trim()
        }))
        .filter((o) => o.label)
    : [];

  if (!question) return res.status(400).json({ error: 'question_required' });
  if (options.length < 2) return res.status(400).json({ error: 'need_two_options' });

  const next = { logo, question, options };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch (err) {
    return res.status(500).json({ error: 'write_failed' });
  }

  resetPoll(true); // reload the freshly written config and zero the counts
  open = true;
  broadcast();
  res.json({ ok: true, config: next });
});

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
};

// Accept a base64 data URL, save it under /public/uploads, return its path.
app.post('/api/upload', requireAdmin, (req, res) => {
  const dataUrl = (req.body && req.body.dataUrl) || '';
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m || !MIME_EXT[m[1]]) return res.status(400).json({ error: 'bad_image' });
  const ext = MIME_EXT[m[1]];
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
  } catch (err) {
    return res.status(500).json({ error: 'save_failed' });
  }
  res.json({ ok: true, path: `/uploads/${name}` });
});

// Host page fetches the QR code (data URL) for the voter link.
app.get('/api/qr', async (_req, res) => {
  try {
    const dataUrl = await QRCode.toDataURL(VOTER_URL, {
      margin: 1,
      width: 480,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.json({ url: VOTER_URL, qr: dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'qr_failed' });
  }
});

function broadcast() {
  io.emit('state', publicState());
}

// Live presence: how many phones are currently on the voter page.
let viewers = 0;
function broadcastPresence() {
  io.emit('presence', { viewers });
}

io.on('connection', (socket) => {
  socket.emit('state', publicState());
  socket.emit('presence', { viewers });

  // Each page announces its role; only voter pages count as "watching".
  socket.on('hello', ({ role } = {}) => {
    if (socket.data.counted) return; // guard against a double hello
    socket.data.role = role;
    if (role === 'vote') {
      viewers += 1;
      socket.data.counted = true;
      broadcastPresence();
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.counted && socket.data.role === 'vote') {
      viewers = Math.max(0, viewers - 1);
      broadcastPresence();
    }
  });

  // Voter taps an option (F2). One vote per device (F6).
  socket.on('vote', ({ optionId, deviceId } = {}, ack) => {
    const reply = (status) => typeof ack === 'function' && ack(status);

    if (!open) return reply({ ok: false, reason: 'closed' });
    if (!deviceId) return reply({ ok: false, reason: 'no_device' });
    if (deviceVotes.has(deviceId)) {
      return reply({ ok: false, reason: 'already_voted', votedFor: deviceVotes.get(deviceId) });
    }

    const option = poll.options.find((o) => o.id === String(optionId));
    if (!option) return reply({ ok: false, reason: 'bad_option' });

    option.votes += 1;
    deviceVotes.set(deviceId, option.id);
    reply({ ok: true, optionId: option.id });
    broadcast(); // F3 — live update to the big screen
  });

  // Cancel a previous vote so the device can vote again (decrements the count).
  socket.on('cancel', ({ deviceId } = {}, ack) => {
    const reply = (status) => typeof ack === 'function' && ack(status);

    if (!open) return reply({ ok: false, reason: 'closed' });
    if (!deviceId || !deviceVotes.has(deviceId)) return reply({ ok: false, reason: 'not_voted' });

    const prevId = deviceVotes.get(deviceId);
    const option = poll.options.find((o) => o.id === prevId);
    if (option && option.votes > 0) option.votes -= 1;
    deviceVotes.delete(deviceId);
    reply({ ok: true });
    broadcast();
  });

  // Host controls (F5). Gated by the admin passcode when one is configured,
  // so an audience member who opens the host URL can't drive the poll.
  socket.on('host:open', (payload) => {
    if (!socketIsAdmin(payload)) return;
    open = true;
    broadcast();
  });
  socket.on('host:close', (payload) => {
    if (!socketIsAdmin(payload)) return;
    open = false;
    broadcast();
  });
  socket.on('host:reset', (payload) => {
    if (!socketIsAdmin(payload)) return;
    resetPoll(true); // reload config so edited question/options take effect
    open = true;
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Live QR Poll is running\n');
  console.log(`  Host / big screen:  http://localhost:${PORT}/  (or ${PUBLIC_ORIGIN}/)`);
  console.log(`  Voter page (QR):    ${VOTER_URL}`);
  const usingDefault = ADMIN_PASSCODE === DEFAULT_PASSCODE && !process.env.ADMIN_PASSCODE;
  console.log(
    `\n  Admin passcode:     ENABLED${usingDefault ? ' (built-in default — set ADMIN_PASSCODE to override)' : ' (from ADMIN_PASSCODE)'}`
  );
  console.log('\n  Open the host page on the projector. Phones scan the QR to vote.\n');
});
