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
  mainChart: document.getElementById('mainChart'),
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
  followBlocks: document.getElementById('followBlocks'),
  countdownScreen: document.getElementById('countdownScreen'),
  cdBackdrop: document.getElementById('cdBackdrop'),
  cdLogo: document.getElementById('cdLogo'),
  cdTime: document.getElementById('cdTime'),
  cdDone: document.getElementById('cdDone'),
  cdScreenStart: document.getElementById('cdScreenStart'),
  cdScreenPause: document.getElementById('cdScreenPause'),
  cdScreenReset: document.getElementById('cdScreenReset'),
  cdBuddy: document.getElementById('cdBuddy'),
  cdConfetti: document.getElementById('cdConfetti')
};

// No passcode — internal tool; the controls work for everyone.

// Each question renders as a donut or a bar chart (per-poll chartType), with a
// shared colour palette.
const FU_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4', '#f43f5e', '#a3e635'];
const color = (i) => FU_COLORS[i % FU_COLORS.length];

const mainChart = { container: el.mainChart, key: '', els: null };
const followBlocks = []; // one chart controller per follow-up question

// (Re)build a chart's DOM for the given type + options; store element refs.
function buildChart(refs, options, type, hasHeading) {
  const c = refs.container;
  c.classList.toggle('bars-mode', type === 'bar');
  const head = hasHeading ? '<h2 class="follow-h"></h2>' : '';
  if (type === 'bar') {
    const rows = options
      .map(
        (o, j) => `<div class="bar-row">
          <span class="bar-label">${iconHtml(o.icon)}<span class="bl-text">${escapeHtml(o.label)}</span></span>
          <span class="bar-track"><span class="bar-fill" style="background:${color(j)}"></span></span>
          <span class="bar-meta"><b class="bar-count">0</b><span class="bar-pct">0%</span></span>
        </div>`
      )
      .join('');
    c.innerHTML = `${head}<div class="bars">${rows}</div>`;
    refs.els = {
      head: c.querySelector('.follow-h'),
      fills: [...c.querySelectorAll('.bar-fill')],
      counts: [...c.querySelectorAll('.bar-count')],
      pcts: [...c.querySelectorAll('.bar-pct')]
    };
  } else {
    const legend = options
      .map(
        (o, j) => `<li>
          ${o.icon ? '' : `<i style="background:${color(j)}"></i>`}
          <span class="lg-label">${iconHtml(o.icon)}<span class="lg-text">${escapeHtml(o.label)}</span></span>
          <b class="lg-count">0</b><span class="lg-pct">0%</span>
        </li>`
      )
      .join('');
    c.innerHTML = `${head}<div class="donut"><b class="donut-total">0</b></div><ul class="legend">${legend}</ul>`;
    refs.els = {
      head: c.querySelector('.follow-h'),
      donut: c.querySelector('.donut'),
      total: c.querySelector('.donut-total'),
      counts: [...c.querySelectorAll('.lg-count')],
      pcts: [...c.querySelectorAll('.lg-pct')]
    };
  }
}

// Draw/update a chart; rebuilds DOM only when the type or option set changes.
function drawChart(refs, options, total, type, questionText) {
  const key = type + '|' + options.map((o) => o.id).join(',');
  if (refs.key !== key) {
    refs.key = key;
    buildChart(refs, options, type, questionText != null);
  }
  const e = refs.els;
  if (e.head && questionText != null) e.head.textContent = questionText;
  options.forEach((o, j) => {
    e.counts[j].textContent = o.votes;
    e.pcts[j].textContent = o.percent + '%';
  });
  if (type === 'bar') {
    const max = Math.max(1, ...options.map((o) => o.votes));
    options.forEach((o, j) => (e.fills[j].style.width = (o.votes / max) * 100 + '%'));
  } else {
    e.total.textContent = total;
    if (total > 0) {
      let acc = 0;
      const segs = options
        .map((o, j) => {
          const from = acc;
          acc += (o.votes / total) * 100;
          return `${color(j)} ${from}% ${acc}%`;
        })
        .join(', ');
      e.donut.style.background = `conic-gradient(${segs})`;
    } else {
      e.donut.style.background = 'var(--panel-2)';
    }
  }
}

// One chart card per follow-up question, laid out below the main.
function renderFollowUps(fus, type) {
  if (followBlocks.length !== fus.length) {
    el.followBlocks.innerHTML = '';
    followBlocks.length = 0;
    for (let i = 0; i < fus.length; i++) {
      const div = document.createElement('div');
      div.className = 'followup chart';
      el.followBlocks.appendChild(div);
      followBlocks.push({ container: div, key: '', els: null });
    }
  }
  fus.forEach((fu, i) => drawChart(followBlocks[i], fu.options, fu.total, type, fu.question));
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

  const chartType = state.chartType === 'bar' ? 'bar' : 'donut';
  drawChart(mainChart, state.options, state.total, chartType); // no heading (the <h1> is the question)
  const fus = state.followUps || [];
  renderFollowUps(fus, chartType);

  // Let CSS lay out however many follow-up charts there are.
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

  // Countdown mode (full-screen), switched from admin.
  const scr = state.screen || 'poll';
  el.countdownScreen.classList.toggle('hidden', scr !== 'countdown');
  const c = state.countdown || {};
  cdRef = { running: !!c.running, endsAt: c.endsAt, remainingMs: c.remainingMs, durationSec: c.durationSec };
  if (el.cdLogo.getAttribute('src') !== state.logo) el.cdLogo.src = state.logo;
  el.cdLogo.classList.toggle('hidden', c.showLogo === false); // admin show/hide
  const bd = c.backdrop || '';
  const bdUrl = bd ? `url("${bd.replace(/"/g, '%22')}")` : '';
  if (el.cdBackdrop.style.backgroundImage !== bdUrl) el.cdBackdrop.style.backgroundImage = bdUrl;
  el.cdBackdrop.classList.toggle('no-image', !bd);
  // Big-screen controls reflect running state.
  el.cdScreenStart.classList.toggle('hidden', !!c.running);
  el.cdScreenPause.classList.toggle('hidden', !c.running);
  tickCd();

  // Pixel character (animated on the countdown screen).
  const wantBuddy = scr === 'countdown' && c.buddy && c.buddySprite;
  setBuddySprite(c.buddySprite || '');
  el.cdConfetti.classList.toggle('hidden', scr !== 'countdown');
  buddyEnabled = !!wantBuddy; // the loop decides visibility (delayed 20s in)

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

// --- countdown timer ---------------------------------------------------------
let cdRef = { running: false, endsAt: null, remainingMs: 0, durationSec: 0 };

function fmtCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function tickCd() {
  const { running, endsAt, remainingMs } = cdRef;
  const ms = running && endsAt ? endsAt - (Date.now() + serverOffset) : remainingMs || 0;
  const showDone = ms <= 0 && running;
  el.cdTime.classList.toggle('hidden', showDone); // hide the 0:00 at the end
  el.cdDone.classList.toggle('hidden', !showDone); // show the big "Time's up!"
  if (!showDone) el.cdTime.textContent = fmtCountdown(ms);
}
setInterval(tickCd, 200);

// Load the buddy sprite and knock out a white/near-white background via a
// flood-fill from the edges (so interior whites like shoes/lanyard survive).
let buddySpriteRaw = null;
let buddyIsGif = false;
function setBuddySprite(path) {
  if (path === buddySpriteRaw) return;
  buddySpriteRaw = path;
  if (!path) {
    el.cdBuddy.removeAttribute('src');
    return;
  }
  // Animated GIFs play themselves — use directly (canvas processing would
  // freeze them to a single frame). They usually carry their own transparency.
  buddyIsGif = /\.gif(\?|$)/i.test(path);
  if (buddyIsGif) {
    el.cdBuddy.src = path;
    return;
  }
  const img = new Image();
  img.onload = () => {
    try {
      el.cdBuddy.src = removeWhiteBackground(img);
    } catch {
      el.cdBuddy.src = path; // fallback if the canvas is tainted
    }
  };
  img.onerror = () => (el.cdBuddy.src = path);
  img.src = path;
}

function removeWhiteBackground(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  const id = cx.getImageData(0, 0, w, h);
  const d = id.data;
  const near = (i) => d[i] > 232 && d[i + 1] > 232 && d[i + 2] > 232 && d[i + 3] > 8;
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { stack.push(0, y, w - 1, y); }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (seen[p]) continue;
    seen[p] = 1;
    if (!near(p * 4)) continue;
    d[p * 4 + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  cx.putImageData(id, 0, 0);
  return cv.toDataURL('image/png');
}

// --- pixel character animator -------------------------------------------------
// Whole-sprite animation: the buddy walks the ground, bobs, jumps, exercises,
// rests when paused, and celebrates (with confetti) when the timer hits zero.
let buddyEnabled = false;
const buddy = {
  x: 0.5, // fraction of width
  face: 1, // 1 = right, -1 = left
  speed: 0.033, // fraction of width per second (slow, gentle stroll)
  y: 0, // px above ground (for jumps/bounces)
  vy: 0,
  squash: 1, // scaleY
  state: 'walk',
  stateT: 0,
  nextAt: 3
};
const GRAV = 1900; // px/s^2 — lower = floatier, slower jumps
const confetti = [];

function buddyPickState(excited) {
  const r = Math.random();
  if (excited) {
    buddy.state = r < 0.45 ? 'jump' : r < 0.75 ? 'exercise' : 'walk';
    buddy.nextAt = 1.4 + Math.random() * 1.2;
  } else {
    // Calm: mostly walk/idle, the occasional jump or exercise.
    buddy.state = r < 0.5 ? 'walk' : r < 0.75 ? 'idle' : r < 0.9 ? 'jump' : 'exercise';
    buddy.nextAt = 3 + Math.random() * 3.5;
  }
  buddy.stateT = 0;
  if (buddy.state === 'jump' && buddy.y <= 0) buddy.vy = 700 + Math.random() * 180;
}

function spawnConfetti(w) {
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4'];
  for (let i = 0; i < 40; i++) {
    confetti.push({
      x: Math.random() * w,
      y: -10,
      vx: (Math.random() - 0.5) * 240,
      vy: 120 + Math.random() * 260,
      s: 5 + Math.random() * 7,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 10,
      color: colors[(Math.random() * colors.length) | 0],
      life: 2.6
    });
  }
}

let buddyLast = performance.now();
function animateBuddy(nowT) {
  const dt = Math.min(0.05, (nowT - buddyLast) / 1000);
  buddyLast = nowT;
  const screenEl = el.countdownScreen;
  const cdVisible = !screenEl.classList.contains('hidden');

  // Confetti canvas
  const cv = el.cdConfetti;
  const W = screenEl.clientWidth || window.innerWidth;
  const H = screenEl.clientHeight || window.innerHeight;
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;

  // The buddy only appears once the countdown has been running for 20s.
  const remaining = cdRef.running && cdRef.endsAt
    ? cdRef.endsAt - (Date.now() + serverOffset)
    : cdRef.remainingMs || 0;
  const elapsed = (cdRef.durationSec || 0) * 1000 - remaining;
  const shown = buddyEnabled && cdVisible && elapsed >= 20000;
  el.cdBuddy.classList.toggle('hidden', !shown);

  if (shown) {
    const done = remaining <= 0 && (cdRef.running || cdRef.durationSec > 0);
    const excited = cdRef.running && remaining > 0 && remaining <= 10000;

    // Behaviour: pace slowly back and forth while running; rest when paused;
    // celebrate at zero.
    if (done && cdRef.running) buddy.state = 'celebrate';
    else if (!cdRef.running) buddy.state = 'rest';
    else buddy.state = 'walk';

    const s = buddy.state;
    const t = nowT / 1000;
    if (s === 'walk') {
      buddy.x += buddy.speed * buddy.face * dt;
      if (buddy.x <= 0.08) { buddy.x = 0.08; buddy.face = 1; } // turn around at edges
      if (buddy.x >= 0.92) { buddy.x = 0.92; buddy.face = -1; }
      buddy.squash = 1 + Math.sin(t * 4.5) * 0.02;
      buddy.y = Math.abs(Math.sin(t * 4.5)) * 3;
    } else if (s === 'idle') {
      buddy.squash = 1 + Math.sin(t * 1.7) * 0.02;
      buddy.y = 0;
    } else if (s === 'exercise') {
      buddy.y = Math.abs(Math.sin(t * 6)) * 18;
      buddy.squash = 1 - Math.cos(t * 6) * 0.045;
    } else if (s === 'rest') {
      buddy.squash += (0.86 - buddy.squash) * Math.min(1, dt * 6);
      buddy.y += (0 - buddy.y) * Math.min(1, dt * 6);
    } else if (s === 'jump' || s === 'celebrate') {
      buddy.vy -= GRAV * dt;
      buddy.y += buddy.vy * dt;
      if (buddy.y <= 0) {
        buddy.y = 0;
        if (s === 'celebrate') buddy.vy = 780 + Math.random() * 160; // keep hopping
        else { buddy.state = 'walk'; buddy.vy = 0; }
      }
      buddy.squash = buddy.y > 2 ? 1.06 : 0.94;
    }

    // Confetti bursts during celebration.
    if (s === 'celebrate') {
      buddy._cf = (buddy._cf || 0) - dt;
      if (buddy._cf <= 0) { spawnConfetti(W); buddy._cf = 0.7; }
    }

    // Position the sprite (origin bottom-centre for squash + facing flip).
    // For a GIF, don't apply squash — it would distort the sprite's own frames.
    const groundBottom = H * 0.05;
    const sq = buddyIsGif ? 1 : buddy.squash;
    // The sprite's art faces the opposite way to our movement sign, so negate
    // it — the character faces the direction it's actually walking.
    el.cdBuddy.style.left = buddy.x * W + 'px';
    el.cdBuddy.style.bottom = groundBottom + buddy.y + 'px';
    el.cdBuddy.style.transform = `translateX(-50%) scaleX(${-buddy.face}) scaleY(${sq})`;
  }

  // Draw confetti (independent of buddy so the burst finishes).
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  for (let i = confetti.length - 1; i >= 0; i--) {
    const p = confetti[i];
    p.vy -= 0; // gravity pulls down (screen y grows down): keep falling
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.life -= dt;
    if (p.life <= 0 || p.y > H + 20) { confetti.splice(i, 1); continue; }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.min(1, p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
    ctx.restore();
  }

  requestAnimationFrame(animateBuddy);
}
requestAnimationFrame(animateBuddy);

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

// Countdown controls on the big screen.
el.cdScreenStart.addEventListener('click', () => socket.emit('cd:start'));
el.cdScreenPause.addEventListener('click', () => socket.emit('cd:pause'));
el.cdScreenReset.addEventListener('click', () => socket.emit('cd:reset'));

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
