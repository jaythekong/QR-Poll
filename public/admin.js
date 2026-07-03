'use strict';

const $ = (sel) => document.querySelector(sel);
const optionList = $('#optionList');
const optionTpl = $('#optionTpl');

let logoValue = '/logo.svg';

// --- admin auth ------------------------------------------------------------
// When the server has an ADMIN_PASSCODE set, privileged requests need a token.
// Token storage + the passcode modal live in the shared PollAuth (auth.js).

let authRequired = false;

function adminHeaders() {
  const t = PollAuth.getToken();
  return authRequired && t ? { 'x-admin-token': t } : {};
}

// Make sure we hold a valid token before a privileged action. Returns false if
// the user cancels the passcode modal.
async function ensureAuth() {
  if (!authRequired) return true;
  if (PollAuth.getToken()) return true;
  return PollAuth.requestPasscode();
}

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
  if (!(await ensureAuth())) throw new Error('not authorized');
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ dataUrl })
  });
  if (res.status === 401) {
    PollAuth.setToken('');
    throw new Error('not authorized');
  }
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

// --- follow-up question blocks (max 2 → 3 questions total) -------------------

const followList = $('#followList');
const MAX_FOLLOWUPS = 2;

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
    return { label: row.querySelector('.opt-label').value.trim(), icon };
  });
}

// --- load + save -----------------------------------------------------------

function flash(text, ok) {
  const el = $('#msg');
  el.textContent = text;
  el.className = 'save-msg ' + (ok ? 'ok' : 'err');
  if (ok) setTimeout(() => (el.textContent = ''), 3000);
}

async function load() {
  const cfg = await (await fetch('/api/config')).json();
  setLogo(cfg.logo);
  $('#brandLogo').src = cfg.logo || '/logo.svg';
  $('#question').value = cfg.question || '';
  optionList.innerHTML = '';
  const opts = (cfg.options || []).map((o) => (typeof o === 'string' ? { label: o } : o));
  (opts.length ? opts : [{}, {}]).forEach((o) => addOptionRow(o));

  // Follow-up questions (optional; accepts legacy single `followUp` too)
  followList.innerHTML = '';
  const fus = Array.isArray(cfg.followUps) ? cfg.followUps : cfg.followUp ? [cfg.followUp] : [];
  fus.slice(0, MAX_FOLLOWUPS).forEach(addFollowBlock);
  updateFollowAddBtn();
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = $('#question').value.trim();
  const options = collectOptions().filter((o) => o.label);

  if (!question) return flash('Add a poll name / question', false);
  if (options.length < 2) return flash('Add at least 2 named options', false);

  // Follow-ups: empty blocks are dropped; a half-filled one is an error.
  const followUps = collectFollowUps().filter((fu) => fu.question || fu.options.length);
  for (const fu of followUps) {
    if (!fu.question || fu.options.length < 2) {
      return flash('Each follow-up needs a question and at least 2 options', false);
    }
  }
  const payload = { logo: logoValue, question, options };
  if (followUps.length) payload.followUps = followUps;

  if (!(await ensureAuth())) return flash('Admin passcode required to save', false);

  $('#saveBtn').disabled = true;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders() },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) {
      PollAuth.setToken('');
      flash('Passcode expired — try saving again', false);
      return;
    }
    const data = await res.json();
    if (res.ok) {
      $('#brandLogo').src = logoValue;
      flash('Saved. Votes reset — press Start poll on the big screen when ready.', true);
    } else {
      flash('Could not save (' + (data.error || 'error') + ')', false);
    }
  } catch {
    flash('Could not save — is the server running?', false);
  } finally {
    $('#saveBtn').disabled = false;
  }
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

// Discover whether a passcode is required, then load the current poll. We
// prompt for the passcode up front so editing feels unlocked, not blocked.
async function init() {
  try {
    authRequired = (await (await fetch('/api/auth-status')).json()).required;
  } catch { authRequired = false; }
  await load();
  fetchLog();
  setInterval(fetchLog, 5000); // keep the activity log live
  // A stored token may have gone stale (server restart) — verify, and show the
  // passcode modal if we don't hold a valid one.
  if (authRequired && !(await PollAuth.verify())) PollAuth.requestPasscode();
}

init().catch(() => flash('Could not load current poll', false));
