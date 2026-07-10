'use strict';

const $ = (sel) => document.querySelector(sel);
const optionList = $('#optionList');
const optionTpl = $('#optionTpl');

// --- drag-to-reorder --------------------------------------------------------
// Rows are draggable only while a .drag-handle is held (so inputs stay usable).
function afterElement(container, itemSel, y) {
  const els = [...container.querySelectorAll(itemSel + ':not(.dragging)')];
  let best = null;
  let bestOffset = -Infinity;
  for (const c of els) {
    const box = c.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > bestOffset) {
      bestOffset = offset;
      best = c;
    }
  }
  return best;
}

function makeSortable(container, itemSel, onDrop) {
  let dragEl = null;
  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const it = handle.closest(itemSel);
    if (it && container.contains(it)) it.setAttribute('draggable', 'true');
  });
  container.addEventListener('dragstart', (e) => {
    const it = e.target.closest(itemSel);
    if (!it) return;
    dragEl = it;
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  container.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const after = afterElement(container, itemSel, e.clientY);
    if (after == null) container.appendChild(dragEl);
    else container.insertBefore(dragEl, after);
  });
  container.addEventListener('dragend', () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    dragEl.removeAttribute('draggable');
    dragEl = null;
    if (onDrop) onDrop();
  });
}

let logoValue = '/logo.svg';

// No passcode — internal tool; the admin page and controls are open.

// --- poll controls (start / close / reset) -----------------------------------

const socket = io();
socket.on('connect', () => socket.emit('hello', { role: 'admin' }));

let pollState = null;
let clockRef = { phase: 'standby', startedAt: null, endsAt: null };
let serverOffset = 0;

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function tickCtrlClock() {
  const { phase, startedAt, endsAt } = clockRef;
  const clock = $('#ctrlClock');
  if (phase !== 'open' || !startedAt) {
    clock.classList.add('hidden');
    return;
  }
  const now = Date.now() + serverOffset;
  clock.classList.remove('hidden');
  $('#ctrlClockText').textContent = endsAt ? fmtClock(endsAt - now) : fmtClock(now - startedAt);
}
setInterval(tickCtrlClock, 500);

function renderControls(s) {
  const phase = s.phase || (s.open ? 'open' : 'closed');
  const pill = $('#phasePill');
  if (phase === 'open') {
    pill.className = 'pill live';
    $('#phaseText').textContent = 'Live';
  } else if (phase === 'standby') {
    pill.className = 'pill';
    $('#phaseText').textContent = 'Ready to start';
  } else {
    pill.className = 'pill closed';
    $('#phaseText').textContent = 'Voting closed';
  }
  $('#startBtn').classList.toggle('hidden', phase === 'open');
  $('#duration').classList.toggle('hidden', phase === 'open');
  $('#closeBtn').classList.toggle('hidden', phase !== 'open');
  $('#startBtn').textContent = phase === 'closed' ? 'Start again' : 'Start poll';

  clockRef = { phase, startedAt: s.startedAt, endsAt: s.endsAt };
  serverOffset = (s.now || Date.now()) - Date.now();
  tickCtrlClock();
}

socket.on('state', (s) => {
  pollState = s;
  renderControls(s);
  renderScreen(s);
});

function hostEmit(event, extra) {
  socket.emit(event, extra || {});
}

$('#startBtn').addEventListener('click', () =>
  hostEmit('host:start', { duration: Number($('#duration').value) })
);
$('#closeBtn').addEventListener('click', () => hostEmit('host:close'));
$('#resetBtn').addEventListener('click', () => {
  if (confirm('Reset all votes and reload the poll question/options?')) {
    hostEmit('host:reset');
  }
});

// --- big screen mode + countdown -------------------------------------------

let cdRef = { running: false, endsAt: null, remainingMs: 0 };

function fmtCd(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function tickCdRemain() {
  const { running, endsAt, remainingMs } = cdRef;
  const ms = running && endsAt ? endsAt - (Date.now() + serverOffset) : remainingMs || 0;
  $('#cdRemain').innerHTML = '⏱ <b>' + fmtCd(ms) + '</b>';
}
setInterval(tickCdRemain, 250);

let backdropSet = false;

function renderScreen(s) {
  const mode = s.screen || 'poll';
  $('#screenText').textContent = mode === 'countdown' ? 'Countdown' : 'Poll';
  $('#screenPill').className = 'pill' + (mode === 'countdown' ? ' live' : '');
  $('#showPollBtn').classList.toggle('active', mode === 'poll');
  $('#showCountdownBtn').classList.toggle('active', mode === 'countdown');
  $('#cdPanel').classList.toggle('dim', mode !== 'countdown');

  const c = s.countdown || {};
  cdRef = { running: !!c.running, endsAt: c.endsAt, remainingMs: c.remainingMs };
  $('#cdStartBtn').classList.toggle('hidden', c.running);
  $('#cdPauseBtn').classList.toggle('hidden', !c.running);
  if (document.activeElement !== $('#cdShowLogo')) $('#cdShowLogo').checked = c.showLogo !== false;
  if (document.activeElement !== $('#cdShowBuddy')) $('#cdShowBuddy').checked = !!c.buddy;
  const sp = c.buddySprite || '';
  if ($('#cdBuddyPreview').dataset.sp !== sp) {
    $('#cdBuddyPreview').dataset.sp = sp;
    $('#cdBuddyPreview').style.backgroundImage = sp ? `url("${sp}")` : '';
    $('#cdBuddyPreview').classList.toggle('empty', !sp);
  }
  tickCdRemain();

  // Backdrop preview (only overwrite when it changes, so we don't fight typing).
  const bd = c.backdrop || '';
  const url = bd ? `url("${bd}")` : '';
  if ($('#cdBackdropPreview').dataset.bd !== bd) {
    $('#cdBackdropPreview').dataset.bd = bd;
    $('#cdBackdropPreview').style.backgroundImage = url;
    $('#cdBackdropPreview').classList.toggle('empty', !bd);
  }
  backdropSet = !!bd;
}

$('#showPollBtn').addEventListener('click', () => socket.emit('screen:set', { mode: 'poll' }));
$('#showCountdownBtn').addEventListener('click', () => socket.emit('screen:set', { mode: 'countdown' }));

function applyDuration() {
  const min = Math.max(0, Number($('#cdMin').value) || 0);
  const sec = Math.min(59, Math.max(0, Number($('#cdSec').value) || 0));
  socket.emit('cd:set', { durationSec: min * 60 + sec });
}
$('#cdSetBtn').addEventListener('click', applyDuration);
$('#cdMin').addEventListener('change', applyDuration);
$('#cdSec').addEventListener('change', applyDuration);
document.querySelectorAll('.cd-preset').forEach((b) =>
  b.addEventListener('click', () => {
    const sec = Number(b.dataset.sec);
    $('#cdMin').value = Math.floor(sec / 60);
    $('#cdSec').value = sec % 60;
    socket.emit('cd:set', { durationSec: sec });
  })
);
$('#cdStartBtn').addEventListener('click', () => socket.emit('cd:start'));
$('#cdPauseBtn').addEventListener('click', () => socket.emit('cd:pause'));
$('#cdResetBtn').addEventListener('click', () => socket.emit('cd:reset'));

// Backdrop upload / remove (reuses the image upload endpoint).
$('#cdBackdropUploadBtn').addEventListener('click', () => $('#cdBackdropFile').click());
$('#cdBackdropFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const path = await uploadImage(file);
    socket.emit('cd:backdrop', { path });
  } catch {
    flash('Backdrop upload failed', false);
  }
  e.target.value = '';
});
$('#cdBackdropRemoveBtn').addEventListener('click', () => socket.emit('cd:backdrop', { path: '' }));
$('#cdShowLogo').addEventListener('change', (e) => socket.emit('cd:logo', { show: e.target.checked }));
$('#cdShowBuddy').addEventListener('change', (e) => socket.emit('cd:buddy', { show: e.target.checked }));
$('#cdBuddyUploadBtn').addEventListener('click', () => $('#cdBuddyFile').click());
$('#cdBuddyFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const path = await uploadImage(file);
    socket.emit('cd:sprite', { path }); // turns the buddy on server-side
  } catch {
    flash('Character upload failed', false);
  }
  e.target.value = '';
});
$('#cdBuddyRemoveBtn').addEventListener('click', () => socket.emit('cd:sprite', { path: '' }));

// --- helpers ---------------------------------------------------------------

function isImagePath(v) {
  return /^(\/|https?:|data:)/.test(v || '');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function uploadImage(file) {
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl })
  });
  if (!res.ok) throw new Error('upload failed');
  return (await res.json()).path;
}

function renderIconPreview(previewEl, value) {
  if (isImagePath(value)) {
    previewEl.innerHTML = `<img src="${value}" alt="" />`;
  } else {
    previewEl.textContent = value || '◯';
  }
}

// --- logo ------------------------------------------------------------------

function setLogo(value) {
  logoValue = value || '/logo.svg';
  $('#logoImg').src = logoValue;
}

$('#logoUploadBtn').addEventListener('click', () => $('#logoFile').click());
$('#logoResetBtn').addEventListener('click', () => setLogo('/logo.svg'));
$('#logoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    setLogo(await uploadImage(file));
  } catch {
    flash('Logo upload failed', false);
  }
  e.target.value = '';
});

// --- option rows -----------------------------------------------------------

function addOptionRow(opt = {}, list = optionList, minKeep = 2) {
  const node = optionTpl.content.firstElementChild.cloneNode(true);
  const iconInput = node.querySelector('.opt-icon');
  const labelInput = node.querySelector('.opt-label');
  const preview = node.querySelector('.icon-preview');
  const fileInput = node.querySelector('.opt-file');

  // icon may be an emoji or an image path; only show emoji text in the field
  const icon = opt.icon || '';
  iconInput.value = isImagePath(icon) ? '' : icon;
  iconInput.dataset.image = isImagePath(icon) ? icon : '';
  labelInput.value = opt.label || '';
  renderIconPreview(preview, icon);

  // "End early" toggle: voters who pick this option skip remaining questions.
  const endBtn = node.querySelector('.opt-end');
  endBtn.classList.toggle('on', !!opt.end);
  endBtn.addEventListener('click', () => endBtn.classList.toggle('on'));

  iconInput.addEventListener('input', () => {
    iconInput.dataset.image = ''; // typing an emoji clears any uploaded image
    renderIconPreview(preview, iconInput.value);
  });

  node.querySelector('.opt-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const pathStr = await uploadImage(file);
      iconInput.value = '';
      iconInput.dataset.image = pathStr;
      renderIconPreview(preview, pathStr);
    } catch {
      flash('Icon upload failed', false);
    }
    e.target.value = '';
  });

  node.querySelector('.opt-remove').addEventListener('click', () => {
    if (list.children.length <= minKeep) return flash(`Keep at least ${minKeep} options`, false);
    node.remove();
  });

  list.appendChild(node);
}

$('#addOption').addEventListener('click', () => addOptionRow());
makeSortable(optionList, '.option-row'); // reorder the main question's options

// --- follow-up question blocks (max 2 → 3 questions total) -------------------

const followList = $('#followList');
const MAX_FOLLOWUPS = 20; // effectively no limit

function updateFollowAddBtn() {
  $('#addFollowUp').classList.toggle('hidden', followList.children.length >= MAX_FOLLOWUPS);
}

function addFollowBlock(fu = {}) {
  if (followList.children.length >= MAX_FOLLOWUPS) return;
  const block = document.createElement('div');
  block.className = 'follow-block';
  block.innerHTML = `
    <div class="follow-block-head">
      <input type="text" class="fu-question" placeholder="Follow-up question" maxlength="160" />
      <button type="button" class="btn ghost fu-remove" title="Remove this question">✕</button>
    </div>
    <div class="option-rows fu-options"></div>
    <button type="button" class="btn ghost add fu-add-opt">+ Add option</button>`;
  block.querySelector('.fu-question').value = fu.question || '';
  const list = block.querySelector('.fu-options');
  const opts = (fu.options || []).map((o) => (typeof o === 'string' ? { label: o } : o));
  (opts.length ? opts : [{}, {}]).forEach((o) => addOptionRow(o, list, 0));
  block.querySelector('.fu-add-opt').addEventListener('click', () => addOptionRow({}, list, 0));
  makeSortable(list, '.option-row'); // reorder this follow-up's options
  block.querySelector('.fu-remove').addEventListener('click', () => {
    block.remove();
    updateFollowAddBtn();
  });
  followList.appendChild(block);
  updateFollowAddBtn();
}

$('#addFollowUp').addEventListener('click', () => addFollowBlock());

function collectFollowUps() {
  return [...followList.querySelectorAll('.follow-block')].map((block) => ({
    question: block.querySelector('.fu-question').value.trim(),
    options: collectOptions(block.querySelector('.fu-options')).filter((o) => o.label)
  }));
}

function collectOptions(list = optionList) {
  return [...list.querySelectorAll('.option-row')].map((row) => {
    const iconInput = row.querySelector('.opt-icon');
    const icon = iconInput.dataset.image || iconInput.value.trim();
    return {
      label: row.querySelector('.opt-label').value.trim(),
      icon,
      end: row.querySelector('.opt-end').classList.contains('on')
    };
  });
}

// --- load + save -----------------------------------------------------------

function flash(text, ok) {
  const el = $('#msg');
  el.textContent = text;
  el.className = 'save-msg ' + (ok ? 'ok' : 'err');
  if (ok) setTimeout(() => (el.textContent = ''), 3000);
}

// --- poll library ----------------------------------------------------------

let editingId = null; // library poll currently in the editor (null = new/unsaved)
let activeLiveId = null; // library poll currently on screen

// Chart-type segmented control (donut / bar).
let chartType = 'donut';
function setChartType(t) {
  chartType = t === 'bar' ? 'bar' : 'donut';
  $('#chartDonutBtn').classList.toggle('active', chartType === 'donut');
  $('#chartBarBtn').classList.toggle('active', chartType === 'bar');
}
$('#chartDonutBtn').addEventListener('click', () => setChartType('donut'));
$('#chartBarBtn').addEventListener('click', () => setChartType('bar'));

// Fill the editor form from a poll definition.
function fillEditor(def) {
  $('#pollNameInput').value = def.name || '';
  setChartType(def.chartType === 'bar' ? 'bar' : 'donut');
  setLogo(def.logo);
  $('#brandLogo').src = def.logo || '/logo.svg';
  $('#question').value = def.question || '';
  optionList.innerHTML = '';
  const opts = (def.options || []).map((o) => (typeof o === 'string' ? { label: o } : o));
  (opts.length ? opts : [{}, {}]).forEach((o) => addOptionRow(o));
  followList.innerHTML = '';
  const fus = Array.isArray(def.followUps) ? def.followUps : def.followUp ? [def.followUp] : [];
  fus.slice(0, MAX_FOLLOWUPS).forEach(addFollowBlock);
  updateFollowAddBtn();
}

// Switch between the poll list and the focused editor screen.
function openEditor() {
  $('.admin').classList.add('editing');
  window.scrollTo(0, 0);
}
function closeEditor() {
  $('.admin').classList.remove('editing');
  window.scrollTo(0, 0);
}

function clearEditor() {
  editingId = null;
  fillEditor({ name: '', logo: '/logo.svg', question: '', options: [{}, {}], followUps: [] });
  $('#editorTitle').textContent = 'New poll';
  $('#editingActive').classList.add('hidden');
  renderPollList(lastLibrary);
}

function editPoll(id) {
  return loadPoll(id).then(openEditor);
}

// Validate the form and build the payload, or flash an error and return null.
function buildPayload() {
  const question = $('#question').value.trim();
  const options = collectOptions().filter((o) => o.label);
  if (!question) return flash('Add a question', false), null;
  if (options.length < 2) return flash('Add at least 2 named options', false), null;
  const followUps = collectFollowUps().filter((fu) => fu.question || fu.options.length);
  for (const fu of followUps) {
    if (!fu.question || fu.options.length < 2) {
      return flash('Each follow-up needs a question and at least 2 options', false), null;
    }
  }
  const payload = { name: $('#pollNameInput').value.trim() || question, logo: logoValue, question, chartType, options };
  if (followUps.length) payload.followUps = followUps;
  return payload;
}

let lastLibrary = { activeId: null, polls: [] };

function renderPollList(data) {
  lastLibrary = data;
  activeLiveId = data.activeId;
  $('#pollList').innerHTML = data.polls
    .map((p) => {
      const sub =
        `${escapeText(p.question)} · ${p.options} option${p.options === 1 ? '' : 's'}` +
        (p.followUps ? ` · ${p.followUps} follow-up${p.followUps === 1 ? '' : 's'}` : '');
      return `<div class="poll-item${p.active ? ' active' : ''}${p.id === editingId ? ' editing' : ''}" data-id="${p.id}">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <div class="pi-main">
          <div class="pi-name">${escapeText(p.name)}${p.active ? ' <span class="pi-badge">on screen</span>' : ''}</div>
          <div class="pi-sub">${sub}</div>
        </div>
        <div class="pi-actions">
          <button type="button" class="btn ghost pi-edit" data-id="${p.id}">Edit</button>
          <button type="button" class="btn ghost pi-dup" data-id="${p.id}" title="Duplicate poll">⧉</button>
          <button type="button" class="btn ${p.active ? 'ghost' : 'primary'} pi-activate" data-id="${p.id}"${p.active ? ' disabled' : ''}>${p.active ? 'On screen' : 'Put on screen'}</button>
          <button type="button" class="btn ghost pi-del" data-id="${p.id}" title="Delete poll">🗑</button>
        </div>
      </div>`;
    })
    .join('');
  $('#pollList').querySelectorAll('.pi-edit').forEach((b) => b.addEventListener('click', () => editPoll(b.dataset.id)));
  $('#pollList').querySelectorAll('.pi-activate').forEach((b) => b.addEventListener('click', () => activatePoll(b.dataset.id)));
  $('#pollList').querySelectorAll('.pi-dup').forEach((b) => b.addEventListener('click', () => duplicatePoll(b.dataset.id)));
  $('#pollList').querySelectorAll('.pi-del').forEach((b) => b.addEventListener('click', () => deletePoll(b.dataset.id)));
}

async function duplicatePoll(id) {
  const res = await fetch('/api/polls/' + id + '/duplicate', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return flash('Could not duplicate', false);
  await refreshList();
  flash('Duplicated.', true);
  loadPoll(data.id); // open the copy for editing
}

// Persist the library order after a drag-and-drop reorder of the list.
async function saveLibraryOrder() {
  const order = [...document.querySelectorAll('#pollList .poll-item')].map((el) => el.dataset.id);
  try {
    await fetch('/api/polls/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order })
    });
  } catch {
    /* order will resync on next refresh */
  }
}

async function refreshList() {
  const data = await (await fetch('/api/polls')).json();
  renderPollList(data);
  return data;
}

async function loadPoll(id) {
  const res = await fetch('/api/polls/' + id);
  if (!res.ok) return flash('Could not load poll', false);
  const def = await res.json();
  editingId = id;
  fillEditor(def);
  $('#editorTitle').textContent = 'Edit poll';
  $('#editingActive').classList.toggle('hidden', id !== activeLiveId);
  renderPollList(lastLibrary);
}

async function savePoll(activate) {
  const payload = buildPayload();
  if (!payload) return;
  $('#saveBtn').disabled = true;
  $('#saveActivateBtn').disabled = true;
  try {
    const res = await fetch(editingId ? '/api/polls/' + editingId : '/api/polls', {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return flash('Could not save (' + (data.error || 'error') + ')', false);
    editingId = data.id;
    $('#brandLogo').src = logoValue;
    $('#editorTitle').textContent = 'Edit poll';
    if (activate) {
      const a = await fetch('/api/polls/' + editingId + '/activate', { method: 'POST' });
      flash(a.ok ? 'Saved & on screen — press Start on the big screen.' : 'Saved, but could not put on screen', a.ok);
    } else {
      flash('Saved to library.', true);
    }
    await refreshList();
    $('#editingActive').classList.toggle('hidden', editingId !== activeLiveId);
    closeEditor(); // return to the poll list after saving
  } catch {
    flash('Could not save — is the server running?', false);
  } finally {
    $('#saveBtn').disabled = false;
    $('#saveActivateBtn').disabled = false;
  }
}

async function activatePoll(id) {
  if (!confirm('Put this poll on screen now? It resets that poll’s votes and switches the big screen.')) return;
  const res = await fetch('/api/polls/' + id + '/activate', { method: 'POST' });
  if (!res.ok) return flash('Could not put on screen', false);
  flash('On screen — press Start on the big screen.', true);
  await refreshList();
  $('#editingActive').classList.toggle('hidden', editingId !== activeLiveId);
}

async function deletePoll(id) {
  if (!confirm('Delete this poll from the library?')) return;
  const res = await fetch('/api/polls/' + id, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return flash(data.error === 'last_poll' ? 'Can’t delete the only poll' : 'Could not delete', false);
  if (editingId === id) editingId = null;
  const lib = await refreshList();
  if (!editingId && lib.activeId) loadPoll(lib.activeId);
}

$('#newPollBtn').addEventListener('click', () => {
  clearEditor();
  openEditor();
});
$('#editorBack').addEventListener('click', closeEditor);
$('#saveActivateBtn').addEventListener('click', () => savePoll(true));
makeSortable($('#pollList'), '.poll-item', saveLibraryOrder); // reorder the library
$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  savePoll(false);
});

// --- activity log ----------------------------------------------------------

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(a, b) {
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

function changeRow(c) {
  const to = c.to
    ? `<b>${escapeText(c.to)}</b>`
    : `<span class="muted">retracted (no new vote)</span>`;
  return `<div class="chg-row">
    <span class="muted">${fmtTime(c.at)}</span>
    <span><b>${escapeText(c.from)}</b> → ${to}</span>
  </div>`;
}

function renderLog(data) {
  const sessions = data.sessions;

  // Summary — aggregated across every session's own changes.
  const totalCast = sessions.reduce((sum, s) => sum + (s.votes || 0), 0);
  const totalFu = sessions.reduce((sum, s) => sum + (s.fuCast || 0), 0);
  const retracted = sessions.reduce((sum, s) => sum + s.changes.length, 0);
  const switched = sessions.reduce(
    (sum, s) => sum + s.changes.filter((c) => c.to && c.to !== c.from).length,
    0
  );
  $('#logSummary').innerHTML =
    `<span><b>${sessions.length}</b> session${sessions.length === 1 ? '' : 's'}</span>` +
    `<span><b>${totalCast}</b> votes cast</span>` +
    `<span><b>${totalFu}</b> follow-up answer${totalFu === 1 ? '' : 's'}</span>` +
    `<span><b>${retracted}</b> retraction${retracted === 1 ? '' : 's'}</span>` +
    `<span><b>${switched}</b> vote change${switched === 1 ? '' : 's'}</span>`;

  // Sessions (newest first), each with its OWN changes/retractions nested inside.
  $('#sessionCount').textContent = `(${sessions.length})`;
  const rev = [...sessions].reverse();
  $('#logSessions').innerHTML = rev.length
    ? rev
        .map((s, i) => {
          const n = sessions.length - i;
          const live = s.closed == null;
          const when = live
            ? `Opened ${fmtTime(s.opened)} · <span class="live-tag">open now</span>`
            : `${fmtTime(s.opened)} – ${fmtTime(s.closed)} · ${fmtDuration(s.opened, s.closed)}`;
          const tally = s.tally
            .filter((t) => t.votes > 0)
            .map((t) => `${escapeText(t.label)} ${t.votes}`)
            .join(' · ') || '—';
          // Per-session follow-up results (question + its tally).
          const fuBlock = (s.followUps || [])
            .map((fu) => {
              const ft = fu.tally
                .filter((t) => t.votes > 0)
                .map((t) => `${escapeText(t.label)} ${t.votes}`)
                .join(' · ') || '—';
              return `<div class="log-fu"><span class="muted">↳ ${escapeText(fu.question)}</span> <span class="tally">${ft}</span> <span class="muted">(${fu.total} answer${fu.total === 1 ? '' : 's'})</span></div>`;
            })
            .join('');
          const chg = [...s.changes].reverse();
          const changesBlock = chg.length
            ? `<div class="session-changes">${chg.map(changeRow).join('')}</div>`
            : `<div class="session-changes empty">No vote changes this session</div>`;
          return `<div class="log-row">
            <div class="log-row-top"><b>Session ${n}</b> <span class="muted">${when}</span></div>
            <div class="log-q">${escapeText(s.question)}</div>
            <div class="log-stats"><span class="chip">${s.votes} cast</span> <span class="tally">${tally}</span></div>
            ${fuBlock}
            <div class="session-changes-label">Changes &amp; retractions (${s.changes.length})</div>
            ${changesBlock}
          </div>`;
        })
        .join('')
    : '<div class="log-empty">No sessions yet.</div>';
}

async function fetchLog() {
  try {
    const data = await (await fetch('/api/log')).json();
    renderLog(data);
  } catch {
    /* transient — the next refresh will retry */
  }
}

$('#logRefresh').addEventListener('click', fetchLog);

async function init() {
  const lib = await refreshList(); // populate the poll library list
  // Start with the poll that's currently on screen loaded in the editor.
  const startId = lib.activeId || (lib.polls[0] && lib.polls[0].id);
  if (startId) await loadPoll(startId);
  else clearEditor();
  fetchLog();
  setInterval(fetchLog, 5000); // keep the activity log live
}

init().catch(() => flash('Could not load the poll library', false));
