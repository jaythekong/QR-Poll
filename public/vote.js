'use strict';

const socket = io();

const el = {
  logo: document.getElementById('logo'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  voteView: document.getElementById('voteView'),
  thanksView: document.getElementById('thanksView'),
  revoteView: document.getElementById('revoteView'),
  closedBanner: document.getElementById('closedBanner'),
  question: document.getElementById('question'),
  options: document.getElementById('options'),
  pick: document.getElementById('pick'),
  revotePick: document.getElementById('revotePick'),
  revoteNote: document.getElementById('revoteNote'),
  changeBtn: document.getElementById('changeBtn'),
  revoteYes: document.getElementById('revoteYes'),
  revoteNo: document.getElementById('revoteNo'),
  viewers: document.getElementById('viewers'),
  viewerCount: document.getElementById('viewerCount')
};

// Tell the server this is a voter page so it counts toward "people watching".
socket.on('connect', () => socket.emit('hello', { role: 'vote' }));
socket.on('presence', ({ viewers }) => {
  el.viewerCount.textContent = viewers;
  el.viewers.classList.toggle('hidden', !viewers);
});

// Stable per-device id so the server can enforce one vote per device (F6).
let deviceId = localStorage.getItem('qrpoll_device');
if (!deviceId) {
  deviceId = 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('qrpoll_device', deviceId);
}

let isOpen = true;
let voted = false; // has this device voted in the *current* poll round
let myVoteId = null; // the option this device voted for (for re-vote/confirm)
const labels = new Map(); // optionId -> label

function labelFor(optionId) {
  return labels.get(optionId) || labels.get(localStorage.getItem('qrpoll_voted')) || '';
}

// Show exactly one of the three screens.
function showView(name) {
  el.voteView.classList.toggle('hidden', name !== 'vote');
  el.thanksView.classList.toggle('hidden', name !== 'thanks');
  el.revoteView.classList.toggle('hidden', name !== 'revote');
}

function showThanks(optionId) {
  myVoteId = optionId;
  el.pick.textContent = labelFor(optionId);
  showView('thanks');
}

// "You've already voted for X — cancel and vote again?"
function showRevote(optionId) {
  myVoteId = optionId;
  el.revotePick.textContent = labelFor(optionId);
  el.revoteNote.classList.add('hidden');
  showView('revote');
}

function buildOptions(options) {
  el.options.innerHTML = '';
  labels.clear();
  for (const o of options) {
    labels.set(o.id, o.label);
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.disabled = !isOpen || voted;
    btn.innerHTML = `${iconHtml(o.icon)}<span>${escapeHtml(o.label)}</span>
      <span class="tick"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>`;
    btn.addEventListener('click', () => castVote(o.id, btn));
    el.options.appendChild(btn);
  }
}

function castVote(optionId, btn) {
  if (!isOpen || voted) return;
  voted = true;
  [...el.options.children].forEach((b) => (b.disabled = true));
  btn.classList.add('chosen');

  socket.emit('vote', { optionId, deviceId }, (res) => {
    if (res && res.ok) {
      localStorage.setItem('qrpoll_voted', optionId);
      setTimeout(() => showThanks(optionId), 280);
    } else if (res && res.reason === 'already_voted') {
      // This device already has a vote on record → offer to cancel & re-vote.
      btn.classList.remove('chosen');
      showRevote(res.votedFor || localStorage.getItem('qrpoll_voted'));
    } else {
      // Poll closed or other rejection — return to the buttons.
      voted = false;
      btn.classList.remove('chosen');
      applyState();
    }
  });
}

// Cancel this device's vote (server decrements the count) and reopen voting.
function cancelVote() {
  if (!isOpen) {
    el.revoteNote.textContent = "Voting is closed — you can't change your vote now.";
    el.revoteNote.classList.remove('hidden');
    return;
  }
  el.revoteYes.disabled = true;
  socket.emit('cancel', { deviceId }, (res) => {
    el.revoteYes.disabled = false;
    if (res && res.ok) {
      voted = false;
      myVoteId = null;
      localStorage.removeItem('qrpoll_voted');
      [...el.options.children].forEach((b) => b.classList.remove('chosen'));
      applyState(); // re-enables the buttons for the current state
      showView('vote');
    } else if (res && res.reason === 'closed') {
      el.revoteNote.textContent = "Voting is closed — you can't change your vote now.";
      el.revoteNote.classList.remove('hidden');
    } else {
      // Nothing on record to cancel — just let them vote.
      voted = false;
      applyState();
      showView('vote');
    }
  });
}

el.changeBtn.addEventListener('click', () => showRevote(myVoteId));
el.revoteYes.addEventListener('click', cancelVote);
el.revoteNo.addEventListener('click', () => showThanks(myVoteId));

let lastState = null;
function applyState() {
  if (!lastState) return;
  const s = lastState;
  isOpen = s.open;

  if (el.logo.getAttribute('src') !== s.logo) el.logo.src = s.logo;
  el.question.textContent = s.question;

  el.status.className = 'pill ' + (s.open ? 'live' : 'closed');
  el.statusText.textContent = s.open ? 'Open' : 'Closed';
  el.closedBanner.classList.toggle('hidden', s.open);

  // Rebuild option buttons if the set changed (poll reset to new options).
  const ids = s.options.map((o) => o.id).join(',');
  if (ids !== [...labels.keys()].join(',')) {
    voted = false; // new round
    buildOptions(s.options);
  } else {
    [...el.options.children].forEach((b) => (b.disabled = !isOpen || voted));
  }
}

socket.on('state', (s) => {
  lastState = s;
  if (!voted) applyState();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function iconHtml(icon) {
  if (!icon) return '';
  if (/^(\/|https?:|data:)/.test(icon)) {
    return `<img class="opt-ico" src="${escapeHtml(icon)}" alt="" />`;
  }
  return `<span class="opt-ico glyph">${escapeHtml(icon)}</span>`;
}
