'use strict';

const socket = io();

const el = {
  logo: document.getElementById('logo'),
  question: document.getElementById('question'),
  bars: document.getElementById('bars'),
  total: document.getElementById('total'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  qr: document.getElementById('qr'),
  url: document.getElementById('url'),
  unlockBtn: document.getElementById('unlockBtn'),
  resetBtn: document.getElementById('resetBtn'),
  closeBtn: document.getElementById('closeBtn'),
  openBtn: document.getElementById('openBtn'),
  viewers: document.getElementById('viewers'),
  viewerCount: document.getElementById('viewerCount')
};

// --- admin auth ------------------------------------------------------------
// The host screen is public (anyone in the room may open it), so the control
// buttons must be gated when the server has an ADMIN_PASSCODE. Until unlocked,
// the controls are hidden and the server rejects host:* events without a token.
const TOKEN_KEY = 'qrpoll_admin_token';
let authRequired = false;
let unlocked = true; // becomes false once we learn a passcode is required

function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(t) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

// Reflect lock state in the UI: when locked, only the Unlock button shows.
function applyLock() {
  if (unlocked) {
    el.unlockBtn.classList.add('hidden');
    el.resetBtn.classList.remove('hidden');
    // close/open visibility is owned by render() based on poll state
  } else {
    el.unlockBtn.classList.remove('hidden');
    el.resetBtn.classList.add('hidden');
    el.closeBtn.classList.add('hidden');
    el.openBtn.classList.add('hidden');
  }
}

async function unlock() {
  const passcode = prompt('Enter the admin passcode to control the poll:');
  if (passcode == null) return;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode })
    });
    if (!res.ok) throw new Error('bad');
    setToken((await res.json()).token);
    unlocked = true;
    applyLock();
  } catch {
    alert('Wrong passcode.');
  }
}

// Attach the token to host control events when auth is on.
function ctrl() {
  return authRequired ? { token: getToken() } : undefined;
}

(async function initAuth() {
  try {
    authRequired = (await (await fetch('/api/auth-status')).json()).required;
  } catch { authRequired = false; }
  if (authRequired && !getToken()) {
    unlocked = false;
  }
  applyLock();
})();

const rows = new Map(); // optionId -> { fill, count, pct, label }

// This is the big screen, not a voter — announce so it isn't counted as watching.
socket.on('connect', () => socket.emit('hello', { role: 'host' }));
socket.on('presence', ({ viewers }) => {
  el.viewerCount.textContent = viewers;
});

// Load the QR code for the voter link once.
fetch('/api/qr')
  .then((r) => r.json())
  .then(({ url, qr }) => {
    el.qr.src = qr;
    el.url.textContent = url;
  })
  .catch(() => (el.url.textContent = 'Could not generate QR code'));

function buildRows(options) {
  el.bars.innerHTML = '';
  rows.clear();
  for (const o of options) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${iconHtml(o.icon)}<span class="bl-text">${escapeHtml(o.label)}</span></div>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <div class="bar-meta"><span class="count">0</span><span class="pct">0%</span></div>`;
    el.bars.appendChild(row);
    rows.set(o.id, {
      label: o.label,
      fill: row.querySelector('.bar-fill'),
      count: row.querySelector('.count'),
      pct: row.querySelector('.pct')
    });
  }
}

function render(state) {
  if (el.logo.getAttribute('src') !== state.logo) el.logo.src = state.logo;
  el.question.textContent = state.question;
  el.total.textContent = state.total;

  // Rebuild rows if the option set changed (e.g. after a reset w/ new config).
  const ids = state.options.map((o) => o.id).join(',');
  if (ids !== [...rows.keys()].join(',')) buildRows(state.options);

  const max = Math.max(1, ...state.options.map((o) => o.votes));
  for (const o of state.options) {
    const r = rows.get(o.id);
    if (!r) continue;
    r.fill.style.width = (o.votes / max) * 100 + '%';
    r.count.textContent = o.votes;
    r.pct.textContent = o.percent + '%';
  }

  if (state.open) {
    el.status.className = 'pill live';
    el.statusText.textContent = 'Live';
  } else {
    el.status.className = 'pill closed';
    el.statusText.textContent = 'Voting closed';
  }

  // Close/Open toggle is only meaningful (and only shown) once unlocked.
  if (unlocked) {
    el.closeBtn.classList.toggle('hidden', !state.open);
    el.openBtn.classList.toggle('hidden', state.open);
  } else {
    el.closeBtn.classList.add('hidden');
    el.openBtn.classList.add('hidden');
  }
}

let lastState = null;
socket.on('state', (state) => {
  lastState = state;
  render(state);
});

el.unlockBtn.addEventListener('click', async () => {
  await unlock();
  if (lastState) render(lastState);
});
el.closeBtn.addEventListener('click', () => socket.emit('host:close', ctrl()));
el.openBtn.addEventListener('click', () => socket.emit('host:open', ctrl()));
el.resetBtn.addEventListener('click', () => {
  if (confirm('Reset all votes and reload the poll question/options?')) {
    socket.emit('host:reset', ctrl());
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// An icon is either an image path/URL or an emoji/text glyph.
function iconHtml(icon) {
  if (!icon) return '';
  if (/^(\/|https?:|data:)/.test(icon)) {
    return `<img class="opt-ico" src="${escapeHtml(icon)}" alt="" />`;
  }
  return `<span class="opt-ico glyph">${escapeHtml(icon)}</span>`;
}
