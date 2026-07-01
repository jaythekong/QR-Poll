'use strict';

const $ = (sel) => document.querySelector(sel);
const optionList = $('#optionList');
const optionTpl = $('#optionTpl');

let logoValue = '/logo.svg';

// --- admin auth ------------------------------------------------------------
// When the server has an ADMIN_PASSCODE set, privileged requests need a token.
// We obtain one by POSTing the passcode to /api/login and keep it for the tab.

const TOKEN_KEY = 'qrpoll_admin_token';
let authRequired = false;

function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(t) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* sessionStorage unavailable — token lives only in memory below */ }
  memToken = t || '';
}
let memToken = '';
function token() { return getToken() || memToken; }

function adminHeaders() {
  return authRequired && token() ? { 'x-admin-token': token() } : {};
}

async function login(passcode) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode })
  });
  if (!res.ok) throw new Error('bad_passcode');
  setToken((await res.json()).token);
}

// Make sure we hold a valid token before a privileged action. Returns false if
// the user cancels or the passcode is wrong.
async function ensureAuth() {
  if (!authRequired) return true;
  if (token()) return true;
  const passcode = prompt('Enter the admin passcode to manage this poll:');
  if (passcode == null) return false;
  try { await login(passcode); return true; }
  catch { flash('Wrong passcode', false); return false; }
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
    setToken('');
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

function addOptionRow(opt = {}) {
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
    if (optionList.children.length <= 2) return flash('Keep at least 2 options', false);
    node.remove();
  });

  optionList.appendChild(node);
}

$('#addOption').addEventListener('click', () => addOptionRow());

function collectOptions() {
  return [...optionList.querySelectorAll('.option-row')].map((row) => {
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
  (opts.length ? opts : [{}, {}]).forEach(addOptionRow);
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = $('#question').value.trim();
  const options = collectOptions().filter((o) => o.label);

  if (!question) return flash('Add a poll name / question', false);
  if (options.length < 2) return flash('Add at least 2 named options', false);

  if (!(await ensureAuth())) return flash('Admin passcode required to save', false);

  $('#saveBtn').disabled = true;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders() },
      body: JSON.stringify({ logo: logoValue, question, options })
    });
    if (res.status === 401) {
      setToken('');
      flash('Passcode expired — try saving again', false);
      return;
    }
    const data = await res.json();
    if (res.ok) {
      $('#brandLogo').src = logoValue;
      flash('Saved — poll is live. Votes reset.', true);
    } else {
      flash('Could not save (' + (data.error || 'error') + ')', false);
    }
  } catch {
    flash('Could not save — is the server running?', false);
  } finally {
    $('#saveBtn').disabled = false;
  }
});

// Discover whether a passcode is required, then load the current poll. We
// prompt for the passcode up front so editing feels unlocked, not blocked.
async function init() {
  try {
    authRequired = (await (await fetch('/api/auth-status')).json()).required;
  } catch { authRequired = false; }
  await load();
  if (authRequired && !token()) ensureAuth();
}

init().catch(() => flash('Could not load current poll', false));
