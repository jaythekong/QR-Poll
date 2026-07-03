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
  resetBtn: document.getElementById('resetBtn'),
  closeBtn: document.getElementById('closeBtn'),
  startBtn: document.getElementById('startBtn'),
  duration: document.getElementById('duration'),
  clock: document.getElementById('clock'),
  clockText: document.getElementById('clockText'),
  qrWait: document.getElementById('qrWait'),
  qrLive: document.getElementById('qrLive'),
  viewers: document.getElementById('viewers'),
  viewerCount: document.getElementById('viewerCount'),
  followBlocks: document.getElementById('followBlocks')
};

// No passcode — internal tool; the controls work for everyone.

const rows = new Map(); // optionId -> { fill, count, pct, label }
const followBlocks = []; // one { qEl, barsEl, rows } per follow-up question

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

function buildRows(container, rowMap, options) {
  container.innerHTML = '';
  rowMap.clear();
  for (const o of options) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${iconHtml(o.icon)}<span class="bl-text">${escapeHtml(o.label)}</span></div>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <div class="bar-meta"><span class="count">0</span><span class="pct">0%</span></div>`;
    container.appendChild(row);
    rowMap.set(o.id, {
      label: o.label,
      fill: row.querySelector('.bar-fill'),
      count: row.querySelector('.count'),
      pct: row.querySelector('.pct')
    });
  }
}

// One results block per follow-up question, live-updating like the main bars.
function renderFollowUps(fus) {
  if (followBlocks.length !== fus.length) {
    el.followBlocks.innerHTML = '';
    followBlocks.length = 0;
    for (let i = 0; i < fus.length; i++) {
      const div = document.createElement('div');
      div.className = 'followup';
      div.innerHTML = `<h2 class="follow-h"></h2><div class="bars"></div>`;
      el.followBlocks.appendChild(div);
      followBlocks.push({
        qEl: div.querySelector('.follow-h'),
        barsEl: div.querySelector('.bars'),
        rows: new Map()
      });
    }
  }
  fus.forEach((fu, i) => {
    const b = followBlocks[i];
    b.qEl.textContent = fu.question;
    renderBars(b.barsEl, b.rows, fu.options);
  });
}

// Rebuild the bar rows only when the option set changes, then update widths.
function renderBars(container, rowMap, options) {
  const ids = options.map((o) => o.id).join(',');
  if (ids !== [...rowMap.keys()].join(',')) buildRows(container, rowMap, options);
  const max = Math.max(1, ...options.map((o) => o.votes));
  for (const o of options) {
    const r = rowMap.get(o.id);
    if (!r) continue;
    r.fill.style.width = (o.votes / max) * 100 + '%';
    r.count.textContent = o.votes;
    r.pct.textContent = o.percent + '%';
  }
}

function render(state) {
  if (el.logo.getAttribute('src') !== state.logo) el.logo.src = state.logo;
  el.question.textContent = state.question;
  el.total.textContent = state.total;

  renderBars(el.bars, rows, state.options);
  renderFollowUps(state.followUps || []);

  const phase = state.phase || (state.open ? 'open' : 'closed');

  // QR is only shown while voting is open ("start poll" reveals it).
  el.qrLive.classList.toggle('hidden', phase !== 'open');
  el.qrWait.classList.toggle('hidden', phase === 'open');
  el.qrWait.querySelector('.qr-wait-icon').textContent = phase === 'closed' ? '■' : '▶';
  el.qrWait.querySelector('.qr-wait-title').textContent =
    phase === 'closed' ? 'Voting has ended' : "Poll hasn't started yet";
  el.qrWait.querySelector('.qr-wait-sub').innerHTML =
    phase === 'closed'
      ? 'Press <b>Start again</b> to reopen voting'
      : 'Press <b>Start poll</b> to show the QR code';

  if (phase === 'open') {
    el.status.className = 'pill live';
    el.statusText.textContent = 'Live';
  } else if (phase === 'standby') {
    el.status.className = 'pill';
    el.statusText.textContent = 'Ready to start';
  } else {
    el.status.className = 'pill closed';
    el.statusText.textContent = 'Voting closed';
  }

  // Ticking clock: count down when timed, count up when open-ended.
  clockRef = { phase, startedAt: state.startedAt, endsAt: state.endsAt };
  serverOffset = (state.now || Date.now()) - Date.now();
  tickClock();

  // Start/Close controls per phase.
  el.closeBtn.classList.toggle('hidden', phase !== 'open');
  el.startBtn.classList.toggle('hidden', phase === 'open');
  el.duration.classList.toggle('hidden', phase === 'open');
  el.startBtn.textContent = phase === 'closed' ? 'Start again' : 'Start poll';
}

// --- ticking clock -----------------------------------------------------------
let clockRef = { phase: 'standby', startedAt: null, endsAt: null };
let serverOffset = 0;

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function tickClock() {
  const { phase, startedAt, endsAt } = clockRef;
  if (phase !== 'open' || !startedAt) {
    el.clock.classList.add('hidden');
    return;
  }
  const now = Date.now() + serverOffset;
  el.clock.classList.remove('hidden');
  el.clock.classList.toggle('closing', !!endsAt && endsAt - now < 11000);
  el.clockText.textContent = endsAt ? fmtClock(endsAt - now) : fmtClock(now - startedAt);
}
setInterval(tickClock, 500);

let lastState = null;
socket.on('state', (state) => {
  lastState = state;
  render(state);
});

el.closeBtn.addEventListener('click', () => socket.emit('host:close'));
el.startBtn.addEventListener('click', () =>
  socket.emit('host:start', { duration: Number(el.duration.value) })
);
el.resetBtn.addEventListener('click', () => {
  if (confirm('Reset all votes and reload the poll question/options?')) {
    socket.emit('host:reset');
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
