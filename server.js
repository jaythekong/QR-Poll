'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'poll.config.json');

// No authentication: this is an internal tool — the admin page and host
// controls are open to anyone who can reach the server.

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
      end: !!o.end, // if chosen, the voter skips any remaining questions
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

resetPoll(true); // seed from file; the DB (if any) overrides this on boot

// ---------------------------------------------------------------------------
// Persistence: the whole app state is serialized to / restored from the DB
// (store.js). Saves are debounced so a burst of votes is one write.
// ---------------------------------------------------------------------------

function reviveOption(o, i) {
  return {
    id: o && o.id != null ? String(o.id) : String(i),
    label: String((o && o.label) || ''),
    icon: o && o.icon ? String(o.icon) : '',
    end: !!(o && o.end),
    votes: Number(o && o.votes) || 0
  };
}

function serializeState() {
  return {
    v: 1,
    config: { logo: poll.logo, question: poll.question, options: poll.options, followUps: poll.followUps },
    phase,
    startedAt,
    endsAt,
    deviceVotes: [...deviceVotes],
    followVotes: [...followVotes],
    sessions
  };
}

function hydrateState(s) {
  const c = s.config || {};
  poll = {
    logo: c.logo || '/logo.svg',
    question: c.question || 'Cast your vote',
    options: (c.options || []).map(reviveOption),
    followUps: (c.followUps || []).map((fu) => ({
      question: String(fu.question || ''),
      options: (fu.options || []).map(reviveOption)
    }))
  };
  phase = s.phase || 'standby';
  startedAt = s.startedAt || null;
  endsAt = s.endsAt || null;
  deviceVotes.clear();
  (s.deviceVotes || []).forEach(([k, v]) => deviceVotes.set(k, v));
  followVotes.clear();
  (s.followVotes || []).forEach(([k, v]) => followVotes.set(k, v));
  sessions.length = 0;
  (s.sessions || []).forEach((x) => sessions.push(x));
  currentSession = [...sessions].reverse().find((x) => x.closed == null) || null;
}

let saveTimer = null;
let savePending = false;
function persist() {
  if (!store.enabled) return;
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!savePending) return;
    savePending = false;
    try {
      await store.save(serializeState());
    } catch (e) {
      console.error('  [db] save failed:', e.message);
    }
  }, 400);
}

function tallyBlock(question, options) {
  const total = options.reduce((sum, o) => sum + o.votes, 0);
  return {
    question,
    total,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      icon: o.icon,
      end: !!o.end,
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

// Current poll config for populating the admin form (from live state, which
// is DB-backed when persistence is on — so it reflects your latest save).
app.get('/api/config', (_req, res) => {
  res.json(currentConfig());
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
          icon: String((o && o.icon) || '').trim(),
          end: !!(o && o.end)
        }))
        .filter((o) => o.label)
    : [];
}

// Save a new poll definition from the admin page, then start a fresh round.
app.post('/api/config', (req, res) => {
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
  persist();
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
app.post('/api/upload', (req, res) => {
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

// Poll lifecycle helpers (module scope so boot can resume a running timer).
function scheduleAutoClose() {
  clearCloseTimer();
  if (phase !== 'open' || !endsAt) return;
  const rem = endsAt - Date.now();
  if (rem <= 0) {
    phase = 'closed';
    closeSession();
    return;
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (phase === 'open') {
      phase = 'closed';
      closeSession();
      broadcast();
      persist();
    }
  }, rem);
}

function startPoll(durationSec) {
  if (phase === 'open') return;
  clearCloseTimer();
  phase = 'open';
  startedAt = Date.now();
  const secs = Math.min(3600, Math.max(0, Number(durationSec) || 0));
  endsAt = secs > 0 ? startedAt + secs * 1000 : null;
  openSession(); // begin a new voting session
  scheduleAutoClose();
  broadcast();
  persist();
}

// The current poll config (no vote counts) for the admin form.
function currentConfig() {
  const strip = (o) => ({ label: o.label, icon: o.icon, end: !!o.end });
  return {
    logo: poll.logo,
    question: poll.question,
    options: poll.options.map(strip),
    followUps: poll.followUps.map((fu) => ({ question: fu.question, options: fu.options.map(strip) }))
  };
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
    persist();
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
    persist();
  });

  // Cancel a previous vote so the device can vote again. Changing a vote
  // restarts the whole flow, so the device's follow-up answers are wiped too
  // (decremented) and it will be asked every question again from Q1.
  socket.on('cancel', ({ deviceId } = {}, ack) => {
    const reply = (status) => typeof ack === 'function' && ack(status);

    if (phase !== 'open') return reply({ ok: false, reason: 'closed' });
    if (!deviceId || !deviceVotes.has(deviceId)) return reply({ ok: false, reason: 'not_voted' });

    const prevId = deviceVotes.get(deviceId);
    const option = poll.options.find((o) => o.id === prevId);
    if (option && option.votes > 0) option.votes -= 1;
    deviceVotes.delete(deviceId);

    // Undo this device's follow-up answers as well.
    poll.followUps.forEach((fu, i) => {
      const key = `${deviceId}|${i}`;
      const pickedId = followVotes.get(key);
      if (pickedId != null) {
        const fuOpt = fu.options.find((o) => o.id === pickedId);
        if (fuOpt && fuOpt.votes > 0) fuOpt.votes -= 1;
        followVotes.delete(key);
      }
    });

    logChange(option ? option.label : String(prevId), deviceId);
    reply({ ok: true });
    broadcast();
    persist();
  });

  // Host controls (F5) — open to everyone (internal tool, no passcode).
  socket.on('host:start', (payload) => startPoll(payload && payload.duration));
  socket.on('host:open', () => startPoll(0)); // back-compat: open-ended
  socket.on('host:close', () => {
    if (phase === 'open') {
      phase = 'closed';
      clearCloseTimer();
      closeSession(); // end the session, snapshotting its final tally
    }
    broadcast();
    persist();
  });
  socket.on('host:reset', () => {
    closeSession(); // end the current session before clearing counts
    resetPoll(true); // reload config so edited question/options take effect
    pendingChange.clear();
    clearCloseTimer();
    phase = 'standby'; // back to "press Start" — QR hidden until then
    startedAt = null;
    endsAt = null;
    broadcast();
    persist();
  });
});

// Flush the latest state to the DB on shutdown (Render sends SIGTERM on
// redeploy), so the last few votes before a restart aren't lost.
async function flushAndExit() {
  try {
    if (store.enabled) await store.save(serializeState());
  } catch (e) {
    console.error('  [db] shutdown save failed:', e.message);
  }
  process.exit(0);
}
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);

// Boot: restore state from the DB (if configured), then start serving.
(async () => {
  let restored = false;
  if (store.enabled) {
    try {
      const saved = await store.init();
      if (saved && saved.config) {
        hydrateState(saved);
        scheduleAutoClose(); // resume a running timed poll, or close if it expired
        restored = true;
      } else {
        persist(); // seed the DB with the file-based default
      }
    } catch (e) {
      console.error('  [db] init failed — running in-memory only:', e.message);
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Live QR Poll is running\n');
    console.log(`  Host / big screen:  http://localhost:${PORT}/  (or ${PUBLIC_ORIGIN}/)`);
    console.log(`  Voter page (QR):    ${VOTER_URL}`);
    console.log('\n  No passcode — internal tool; admin & controls are open.');
    if (store.enabled) {
      console.log(`  Persistence:        DATABASE (Postgres) — ${restored ? 'state restored' : 'seeded fresh'}`);
    } else {
      console.log('  Persistence:        NONE (in-memory) — set DATABASE_URL to persist');
    }
    console.log('\n  Open the host page on the projector. Phones scan the QR to vote.\n');
  });
})();
