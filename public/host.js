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
  mainDonut: document.getElementById('mainDonut'),
  mainTotal: document.getElementById('mainTotal'),
  mainLegend: document.getElementById('mainLegend'),
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

// Each question is a donut chart with a colour legend.
const FU_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4', '#f43f5e', '#a3e635'];
const color = (i) => FU_COLORS[i % FU_COLORS.length];

const mainRefs = { ids: '', donut: el.mainDonut, total: el.mainTotal, legend: el.mainLegend, counts: [], pcts: [] };
const followBlocks = []; // one donut chart per follow-up question

// Build/update one donut + legend. Rebuilds the legend only when options change.
function renderDonut(refs, options, total) {
  const ids = options.map((o) => o.id).join(',');
  if (ids !== refs.ids) {
    refs.ids = ids;
    refs.legend.innerHTML = options
      .map(
        (o, j) => `<li>
          <i style="background:${color(j)}"></i>
          <span class="lg-label">${iconHtml(o.icon)}<span class="lg-text">${escapeHtml(o.label)}</span></span>
          <b class="lg-count">0</b><span class="lg-pct">0%</span>
        </li>`
      )
      .join('');
    refs.counts = [...refs.legend.querySelectorAll('.lg-count')];
    refs.pcts = [...refs.legend.querySelectorAll('.lg-pct')];
  }
  options.forEach((o, j) => {
    refs.counts[j].textContent = o.votes;
    refs.pcts[j].textContent = o.percent + '%';
  });
  refs.total.textContent = total;

  if (total > 0) {
    let acc = 0;
    const segs = options
      .map((o, j) => {
        const from = acc;
        acc += (o.votes / total) * 100;
        return `${color(j)} ${from}% ${acc}%`;
      })
      .join(', ');
    refs.donut.style.background = `conic-gradient(${segs})`;
  } else {
    refs.donut.style.background = 'var(--panel-2)';
  }
}

// One donut card per follow-up question, laid out side by side below the main.
function renderFollowUps(fus) {
  if (followBlocks.length !== fus.length) {
    el.followBlocks.innerHTML = '';
    followBlocks.length = 0;
    for (let i = 0; i < fus.length; i++) {
      const div = document.createElement('div');
      div.className = 'followup chart';
      div.innerHTML = `<h2 class="follow-h"></h2>
        <div class="donut"><b class="donut-total">0</b></div>
        <ul class="legend"></ul>`;
      el.followBlocks.appendChild(div);
      followBlocks.push({
        qEl: div.querySelector('.follow-h'),
        ids: '',
        donut: div.querySelector('.donut'),
        total: div.querySelector('.donut-total'),
        legend: div.querySelector('.legend'),
        counts: [],
        pcts: []
      });
    }
  }
  fus.forEach((fu, i) => {
    followBlocks[i].qEl.textContent = fu.question;
    renderDonut(followBlocks[i], fu.options, fu.total);
  });
}

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

function render(state) {
  if (el.logo.getAttribute('src') !== state.logo) el.logo.src = state.logo;
  el.question.textContent = state.question;
  el.total.textContent = state.total;

  renderDonut(mainRefs, state.options, state.total);
  const fus = state.followUps || [];
  renderFollowUps(fus);

  // Let CSS lay out however many follow-up donuts there are.
  document.documentElement.style.setProperty('--fus-count', Math.max(1, fus.length));

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
