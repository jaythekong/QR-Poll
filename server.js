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

// Basic brute-force protection: after 5 failed passcode attempts from one IP,
// lock that IP out of /api/login for 60 seconds.
const loginFails = new Map(); // ip -> { count, lockedUntil }
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 60 * 1000;

function loginLocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
  return 0;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.count = 0;
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  }
  loginFails.set(ip, rec);
  if (loginFails.size > 5000) loginFails.clear(); // crude memory cap
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
function normalizeOptions(list) {
  return (list || []).map((opt, i) => {
    const o = typeof opt === 'string' ? { label: opt } : opt || {};
    return {
      id: String(i),
      label: String(o.label || ''),
      icon: o.icon ? String(o.icon) : '',
      votes: 0
    };
  });
}

// Up to 2 follow-up questions after the main one (3 questions total).
const MAX_FOLLOWUPS = 2;

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = {
    logo: raw.logo || '/logo.svg',
    question: raw.question || 'Cast your vote',
    options: normalizeOptions(raw.options),
    followUps: []
  };
  // Optional follow-up questions shown to each voter after their main vote.
  // Accepts `followUps: []` or the legacy single `followUp: {}`.
  const list = Array.isArray(raw.followUps)
    ? raw.followUps
    : raw.followUp
      ? [raw.followUp]
      : [];
  for (const fu of list.slice(0, MAX_FOLLOWUPS)) {
    if (fu && String(fu.question || '').trim() && Array.isArray(fu.options)) {
      const opts = normalizeOptions(fu.options).filter((o) => o.label);
      if (opts.length >= 2) {
        cfg.followUps.push({ question: String(fu.question).trim(), options: opts });
      }
    }
  }
  return cfg;
}

let poll;
// Poll lifecycle: 'standby' (not started — QR hidden) → 'open' (voting, clock
// ticking) → 'closed'. The host starts it explicitly, open-ended or timed.
let phase = 'standby';
let startedAt = null; // when voting was opened (ms)
let endsAt = null; // auto-close deadline for timed polls (ms), null = open-ended
let closeTimer = null;

function clearCloseTimer() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}
// deviceId -> optionId it voted for (one vote per device, F6). Tracking the
// chosen option lets a voter cancel and re-vote.
const deviceVotes = new Map();
// "deviceId|fuIndex" -> optionId (one answer per device per follow-up question)
const followVotes = new Map();

function resetPoll(reloadConfig) {
  if (reloadConfig || !poll) {
    poll = loadConfig();
  } else {
    poll.options.forEach((o) => (o.votes = 0));
    poll.followUps.forEach((fu) => fu.options.forEach((o) => (o.votes = 0)));
  }
  deviceVotes.clear();
  followVotes.clear();
}

// ---------------------------------------------------------------------------
// Activity log (in-memory; resets on restart, like the vote state)
//   - sessions: one record per open→close voting session
//   - changes:  each retraction / vote change, capturing "from → to"
// ---------------------------------------------------------------------------
const LOG_CAP = 200;
const sessions = [];
let currentSession = null;
const pendingChange = new Map(); // deviceId -> change record awaiting its "to"

function totalVotes() {
  return poll.options.reduce((sum, o) => sum + o.votes, 0);
}
function tallySnapshot() {
  return poll.options.map((o) => ({ label: o.label, votes: o.votes }));
}
function followSnapshot() {
  return poll.followUps.map((fu) => ({
    question: fu.question,
    total: fu.options.reduce((sum, o) => sum + o.votes, 0),
    tally: fu.options.map((o) => ({ label: o.label, votes: o.votes }))
  }));
}
function openSession() {
  currentSession = {
    opened: Date.now(),
    closed: null,
    question: poll.question,
    openTotal: totalVotes(),
    cast: 0, // gross votes cast during this session
    fuCast: 0, // follow-up answers given during this session
    closeTotal: null,
    tally: tallySnapshot(),
    followUps: followSnapshot(),
    changes: [] // retractions / vote changes that happen during this session
  };
  sessions.push(currentSession);
  if (sessions.length > LOG_CAP) sessions.shift();
}
function closeSession() {
  if (currentSession && currentSession.closed == null) {
    currentSession.closed = Date.now();
    currentSession.closeTotal = totalVotes();
    currentSession.tally = tallySnapshot();
    currentSession.followUps = followSnapshot();
  }
}
// Record a retraction against the CURRENT session. The "to" is filled in later
// if the device re-votes (while the same session is still active).
function logChange(fromLabel, deviceId) {
  if (!currentSession) return;
  const change = { from: fromLabel, to: null, at: Date.now() };
  currentSession.changes.push(change);
  if (currentSession.changes.length > LOG_CAP) currentSession.changes.shift();
  pendingChange.set(deviceId, change);
}

resetPoll(true); // boots in standby — the host starts the poll explicitly

function tallyBlock(question, options) {
  const total = options.reduce((sum, o) => sum + o.votes, 0);
  return {
    question,
    total,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      icon: o.icon,
      votes: o.votes,
      percent: total === 0 ? 0 : Math.round((o.votes / total) * 100)
    }))
  };
}

function publicState() {
  const main = tallyBlock(poll.question, poll.options);
  return {
    logo: poll.logo,
    question: poll.question,
    phase,
    open: phase === 'open',
    startedAt,
    endsAt,
    now: Date.now(), // lets clients sync their ticking clock to server time
    total: main.total,
    options: main.options,
    followUps: poll.followUps.map((fu) => tallyBlock(fu.question, fu.options))
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

app.set('trust proxy', 1); // Render/Railway sit behind a proxy — get real IPs
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
  const ip = req.ip || 'unknown';
  const waitMs = loginLocked(ip);
  if (waitMs > 0) {
    return res
      .status(429)
      .json({ error: 'too_many_attempts', retryIn: Math.ceil(waitMs / 1000) });
  }
  const passcode = String((req.body && req.body.passcode) || '');
  if (passcode && safeEqual(passcode, ADMIN_PASSCODE)) {
    loginFails.delete(ip);
    return res.json({ ok: true, token: issueToken() });
  }
  noteLoginFail(ip);
  return res.status(401).json({ error: 'bad_passcode' });
});

// Let a page check whether its stored token is still valid (tokens are
// in-memory, so a server restart invalidates them).
app.get('/api/verify', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ valid: true });
  res.json({ valid: validToken(req.get('x-admin-token')) });
});

// Current poll config (raw), for populating the admin form.
app.get('/api/config', (_req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: 'read_failed' });
  }
});

// Activity log for the admin view: voting sessions + vote changes. This is
// aggregate, non-identifying data (same visibility as the public results), so
// it isn't behind the passcode.
app.get('/api/log', (_req, res) => {
  const liveTotal = totalVotes();
  res.json({
    open: phase === 'open',
    now: Date.now(),
    sessions: sessions.map((s) => ({
      opened: s.opened,
      closed: s.closed,
      question: s.question,
      votes: s.cast, // gross votes cast during the session
      fuCast: s.fuCast || 0, // follow-up answers given during the session
      total: s.closed != null ? s.closeTotal : liveTotal,
      tally: s.closed != null ? s.tally : tallySnapshot(),
      followUps: s.closed != null ? s.followUps || [] : followSnapshot(),
      changes: s.changes.map((c) => ({ from: c.from, to: c.to, at: c.at }))
    }))
  });
});

// Clean an incoming options array from the admin form.
function cleanOptions(list) {
  return Array.isArray(list)
    ? list
        .map((o) => ({
          label: String((o && o.label) || '').trim(),
          icon: String((o && o.icon) || '').trim()
        }))
        .filter((o) => o.label)
    : [];
}

// Save a new poll definition from the admin page, then start a fresh round.
app.post('/api/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const question = String(body.question || '').trim();
  const logo = String(body.logo || '/logo.svg').trim() || '/logo.svg';
  const options = cleanOptions(body.options);

  if (!question) return res.status(400).json({ error: 'question_required' });
  if (options.length < 2) return res.status(400).json({ error: 'need_two_options' });

  const next = { logo, question, options };

  // Optional follow-up questions (max 2): each needs a question and ≥2 options.
  // Accepts `followUps: []` or the legacy single `followUp: {}`. Blocks that are
  // completely empty are dropped; half-filled ones are an error.
  const fuRaw = Array.isArray(body.followUps)
    ? body.followUps
    : body.followUp
      ? [body.followUp]
      : [];
  const followUps = [];
  for (const fu of fuRaw.slice(0, MAX_FOLLOWUPS)) {
    const fuQuestion = String((fu && fu.question) || '').trim();
    const fuOptions = cleanOptions(fu && fu.options);
    if (!fuQuestion && fuOptions.length === 0) continue;
    if (!fuQuestion || fuOptions.length < 2) {
      return res.status(400).json({ error: 'followup_needs_question_and_two_options' });
    }
    followUps.push({ question: fuQuestion, options: fuOptions });
  }
  if (followUps.length) next.followUps = followUps;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch (err) {
    return res.status(500).json({ error: 'write_failed' });
  }

  closeSession(); // the previous poll's session ends here
  resetPoll(true); // reload the freshly written config and zero the counts
  pendingChange.clear();
  clearCloseTimer();
  phase = 'standby'; // the new poll waits for the host to press Start
  startedAt = null;
  endsAt = null;
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

    if (phase !== 'open') return reply({ ok: false, reason: 'closed' });
    if (!deviceId) return reply({ ok: false, reason: 'no_device' });
    if (deviceVotes.has(deviceId)) {
      return reply({ ok: false, reason: 'already_voted', votedFor: deviceVotes.get(deviceId) });
    }

    const option = poll.options.find((o) => o.id === String(optionId));
    if (!option) return reply({ ok: false, reason: 'bad_option' });

    option.votes += 1;
    deviceVotes.set(deviceId, option.id);
    if (currentSession) currentSession.cast += 1;
    // If this vote completes a cancel→re-vote, record where they landed.
    const pend = pendingChange.get(deviceId);
    if (pend) {
      pend.to = option.label;
      pendingChange.delete(deviceId);
    }
    reply({ ok: true, optionId: option.id });
    broadcast(); // F3 — live update to the big screen
  });

  // Voter answers one of the follow-up questions (after their main vote).
  socket.on('followVote', ({ fuIndex, optionId, deviceId } = {}, ack) => {
    const reply = (status) => typeof ack === 'function' && ack(status);

    if (phase !== 'open') return reply({ ok: false, reason: 'closed' });
    const fu = poll.followUps[Number(fuIndex)];
    if (!fu) return reply({ ok: false, reason: 'no_followup' });
    if (!deviceId) return reply({ ok: false, reason: 'no_device' });

    const key = `${deviceId}|${Number(fuIndex)}`;
    if (followVotes.has(key)) return reply({ ok: false, reason: 'already_voted' });

    const option = fu.options.find((o) => o.id === String(optionId));
    if (!option) return reply({ ok: false, reason: 'bad_option' });

    option.votes += 1;
    followVotes.set(key, option.id);
    if (currentSession) currentSession.fuCast += 1;
    reply({ ok: true, optionId: option.id });
    broadcast();
  });

  // Cancel a previous vote so the device can vote again (decrements the count).
  socket.on('cancel', ({ deviceId } = {}, ack) => {
    const reply = (status) => typeof ack === 'function' && ack(status);

    if (phase !== 'open') return reply({ ok: false, reason: 'closed' });
    if (!deviceId || !deviceVotes.has(deviceId)) return reply({ ok: false, reason: 'not_voted' });

    const prevId = deviceVotes.get(deviceId);
    const option = poll.options.find((o) => o.id === prevId);
    if (option && option.votes > 0) option.votes -= 1;
    deviceVotes.delete(deviceId);
    logChange(option ? option.label : String(prevId), deviceId);
    reply({ ok: true });
    broadcast();
  });

  // Host controls (F5). Gated by the admin passcode when one is configured,
  // so an audience member who opens the host URL can't drive the poll.

  // Start voting: open-ended (duration 0/absent) or timed (duration seconds,
  // auto-closes when the clock hits zero).
  function startPoll(durationSec) {
    if (phase === 'open') return;
    clearCloseTimer();
    phase = 'open';
    startedAt = Date.now();
    const secs = Math.min(3600, Math.max(0, Number(durationSec) || 0));
    endsAt = secs > 0 ? startedAt + secs * 1000 : null;
    openSession(); // begin a new voting session
    if (endsAt) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (phase === 'open') {
          phase = 'closed';
          closeSession();
          broadcast();
        }
      }, endsAt - startedAt);
    }
    broadcast();
  }

  // Each host event acks so the page can react (e.g. a stale token after a
  // server restart re-locks the controls instead of failing silently).
  function denied(ack) {
    if (typeof ack === 'function') ack({ ok: false, reason: 'unauthorized' });
    return true;
  }
  function granted(ack) {
    if (typeof ack === 'function') ack({ ok: true });
  }

  socket.on('host:start', (payload, ack) => {
    if (!socketIsAdmin(payload)) return denied(ack);
    startPoll(payload && payload.duration);
    granted(ack);
  });
  // Back-compat alias (older host pages) — starts open-ended.
  socket.on('host:open', (payload, ack) => {
    if (!socketIsAdmin(payload)) return denied(ack);
    startPoll(0);
    granted(ack);
  });
  socket.on('host:close', (payload, ack) => {
    if (!socketIsAdmin(payload)) return denied(ack);
    if (phase === 'open') {
      phase = 'closed';
      clearCloseTimer();
      closeSession(); // end the session, snapshotting its final tally
    }
    broadcast();
    granted(ack);
  });
  socket.on('host:reset', (payload, ack) => {
    if (!socketIsAdmin(payload)) return denied(ack);
    closeSession(); // end the current session before clearing counts
    resetPoll(true); // reload config so edited question/options take effect
    pendingChange.clear();
    clearCloseTimer();
    phase = 'standby'; // back to "press Start" — QR hidden until then
    startedAt = null;
    endsAt = null;
    broadcast();
    granted(ack);
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
