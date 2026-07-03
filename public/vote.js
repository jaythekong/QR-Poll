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
  waitBanner: document.getElementById('waitBanner'),
  timeBanner: document.getElementById('timeBanner'),
  timeLeft: document.getElementById('timeLeft'),
  question: document.getElementById('question'),
  options: document.getElementById('options'),
  pick: document.getElementById('pick'),
  myResults: document.getElementById('myResults'),
  revotePick: document.getElementById('revotePick'),
  revoteNote: document.getElementById('revoteNote'),
  changeBtn: document.getElementById('changeBtn'),
  revoteYes: document.getElementById('revoteYes'),
  revoteNo: document.getElementById('revoteNo'),
  followView: document.getElementById('followView'),
  followTag: document.getElementById('followTag'),
  followQuestion: document.getElementById('followQuestion'),
  followOptions: document.getElementById('followOptions'),
  followSkip: document.getElementById('followSkip'),
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
let followIdx = 0; // which follow-up question this device is on (this round)
let followBusy = false; // guard against double-tapping a follow-up option
let myVoteId = null; // the option this device voted for (for re-vote/confirm)
let myFollowPicks = {}; // fuIndex -> optionId this device answered
const labels = new Map(); // optionId -> label

function labelFor(optionId) {
  return labels.get(optionId) || labels.get(localStorage.getItem('qrpoll_voted')) || '';
}

// Show exactly one of the screens.
function showView(name) {
  el.voteView.classList.toggle('hidden', name !== 'vote');
  el.thanksView.classList.toggle('hidden', name !== 'thanks');
  el.revoteView.classList.toggle('hidden', name !== 'revote');
  el.followView.classList.toggle('hidden', name !== 'follow');
}

// Walk through the follow-up questions in order; thanks screen at the end.
function nextFollowUp() {
  const fus = (lastState && lastState.followUps) || [];
  if (followIdx < fus.length) showFollowUp(fus, followIdx);
  else showThanks(myVoteId);
}

function showFollowUp(fus, i) {
  const fu = fus[i];
  el.followTag.textContent =
    fus.length > 1
      ? `✓ Vote counted · question ${i + 2} of ${fus.length + 1}`
      : '✓ Vote counted · one more quick question';
  el.followQuestion.textContent = fu.question;
  el.followOptions.innerHTML = '';
  followBusy = false;
  for (const o of fu.options) {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.innerHTML = `${iconHtml(o.icon)}<span>${escapeHtml(o.label)}</span>
      <span class="tick"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>`;
    btn.addEventListener('click', () => castFollowVote(o.id, btn));
    el.followOptions.appendChild(btn);
  }
  showView('follow');
}

function castFollowVote(optionId, btn) {
  if (followBusy) return;
  followBusy = true;
  [...el.followOptions.children].forEach((b) => (b.disabled = true));
  btn.classList.add('chosen');
  const fu = ((lastState && lastState.followUps) || [])[followIdx];
  const picked = fu && fu.options.find((o) => o.id === optionId);
  socket.emit('followVote', { fuIndex: followIdx, optionId, deviceId }, (res) => {
    if (res && res.ok) myFollowPicks[followIdx] = optionId;
    // "End early" answers skip any remaining questions.
    if (picked && picked.end) {
      setTimeout(() => showThanks(myVoteId), 280);
    } else {
      followIdx += 1;
      setTimeout(nextFollowUp, 280);
    }
  });
}

function showThanks(optionId) {
  myVoteId = optionId;
  el.pick.textContent = labelFor(optionId);
  showView('thanks');
  renderMyResults(lastState);
}

// The final screen lists just this voter's own choices — the live tallies
// belong on the big screen.
function renderMyResults(s) {
  if (!s) return;

  const row = (question, options, pickedId) => {
    const picked = options.find((o) => o.id === pickedId);
    if (!picked) return '';
    return `<div class="ans-row">
      <span class="ans-q">${escapeHtml(question)}</span>
      <span class="ans-a">${iconHtml(picked.icon)}<span>${escapeHtml(picked.label)}</span></span>
    </div>`;
  };

  let html = row(s.question, s.options, myVoteId);
  (s.followUps || []).forEach((fu, i) => {
    html += row(fu.question, fu.options, myFollowPicks[i]);
  });
  el.myResults.innerHTML = html
    ? `<div class="ans-title">Your answers</div>${html}`
    : '';
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
      myVoteId = optionId;
      // "End early" options skip the remaining questions entirely.
      const picked = (lastState.options || []).find((o) => o.id === optionId);
      if (picked && picked.end) {
        setTimeout(() => showThanks(optionId), 280);
      } else {
        setTimeout(nextFollowUp, 280); // follow-up questions first, thanks after
      }
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
      // Changing a vote restarts the whole flow: main question AND all
      // follow-ups again from Q1 (the server wiped our previous answers).
      voted = false;
      myVoteId = null;
      followIdx = 0;
      myFollowPicks = {};
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
el.followSkip.addEventListener('click', () => {
  followIdx += 1; // skip just this question, then continue the sequence
  nextFollowUp();
});

let lastState = null;
function applyState() {
  if (!lastState) return;
  const s = lastState;
  isOpen = s.open;

  if (el.logo.getAttribute('src') !== s.logo) el.logo.src = s.logo;
  el.question.textContent = s.question;

  const phase = s.phase || (s.open ? 'open' : 'closed');
  el.status.className = 'pill ' + (phase === 'open' ? 'live' : phase === 'closed' ? 'closed' : '');
  el.statusText.textContent = phase === 'open' ? 'Open' : phase === 'standby' ? 'Not started' : 'Closed';
  el.waitBanner.classList.toggle('hidden', phase !== 'standby');
  el.closedBanner.classList.toggle('hidden', phase !== 'closed');

  // Countdown for timed polls (mirrors the big screen's clock).
  clockRef = { phase, endsAt: s.endsAt };
  serverOffset = (s.now || Date.now()) - Date.now();
  tickTimeLeft();

  // Rebuild option buttons if the set changed (poll reset to new options).
  const ids = s.options.map((o) => o.id).join(',');
  if (ids !== [...labels.keys()].join(',')) {
    voted = false; // new round
    followIdx = 0;
    myFollowPicks = {};
    buildOptions(s.options);
  } else {
    [...el.options.children].forEach((b) => (b.disabled = !isOpen || voted));
  }
}

socket.on('state', (s) => {
  lastState = s;
  if (!voted) applyState();
});

// --- countdown for timed polls ----------------------------------------------
let clockRef = { phase: 'standby', endsAt: null };
let serverOffset = 0;

function tickTimeLeft() {
  if (clockRef.phase !== 'open' || !clockRef.endsAt) {
    el.timeBanner.classList.add('hidden');
    return;
  }
  const left = Math.max(0, clockRef.endsAt - (Date.now() + serverOffset));
  const secs = Math.round(left / 1000);
  el.timeLeft.textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  el.timeBanner.classList.remove('hidden');
}
setInterval(tickTimeLeft, 500);

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
