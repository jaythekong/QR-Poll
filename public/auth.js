'use strict';

// Shared admin-auth helper for the host and admin pages.
//  - Stores the session token (sessionStorage, with in-memory fallback).
//  - Verifies a stored token against the server (restarts invalidate tokens).
//  - Shows a styled passcode modal instead of the browser prompt().
window.PollAuth = (function () {
  const KEY = 'qrpoll_admin_token';
  let memToken = '';

  function getToken() {
    try {
      return sessionStorage.getItem(KEY) || memToken;
    } catch {
      return memToken;
    }
  }

  function setToken(t) {
    memToken = t || '';
    try {
      if (t) sessionStorage.setItem(KEY, t);
      else sessionStorage.removeItem(KEY);
    } catch {
      /* sessionStorage unavailable — memToken covers it */
    }
  }

  async function login(passcode) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode })
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const err = new Error('locked');
      err.retryIn = j.retryIn || 60;
      throw err;
    }
    if (!res.ok) throw new Error('bad_passcode');
    setToken((await res.json()).token);
  }

  // True if the stored token is still accepted by the server; clears it if not.
  async function verify() {
    if (!getToken()) return false;
    try {
      const res = await fetch('/api/verify', { headers: { 'x-admin-token': getToken() } });
      const j = await res.json();
      if (!j.valid) setToken('');
      return !!j.valid;
    } catch {
      return false;
    }
  }

  // --- passcode modal --------------------------------------------------------
  let modal = null;

  function buildModal() {
    if (modal) return modal;
    const wrap = document.createElement('div');
    wrap.className = 'auth-overlay hidden';
    wrap.innerHTML = `
      <div class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        <h3 id="authTitle">Admin passcode</h3>
        <p class="auth-sub">Enter the passcode to unlock the poll controls.</p>
        <input type="password" class="auth-input" autocomplete="current-password" placeholder="Passcode" />
        <div class="auth-err hidden"></div>
        <div class="auth-actions">
          <button type="button" class="btn ghost auth-cancel">Cancel</button>
          <button type="button" class="btn primary auth-submit">Unlock</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    modal = {
      wrap,
      input: wrap.querySelector('.auth-input'),
      err: wrap.querySelector('.auth-err'),
      submit: wrap.querySelector('.auth-submit'),
      cancel: wrap.querySelector('.auth-cancel')
    };
    return modal;
  }

  // Shows the modal; resolves true once logged in, false if the user cancels.
  function requestPasscode() {
    const m = buildModal();
    m.wrap.classList.remove('hidden');
    m.input.value = '';
    m.err.classList.add('hidden');
    setTimeout(() => m.input.focus(), 50);

    return new Promise((resolve) => {
      let busy = false;

      function done(ok) {
        m.wrap.classList.add('hidden');
        m.submit.onclick = m.cancel.onclick = m.input.onkeydown = m.wrap.onclick = null;
        resolve(ok);
      }

      function fail(text) {
        m.err.textContent = text;
        m.err.classList.remove('hidden');
        m.input.select();
      }

      async function attempt() {
        if (busy) return;
        const passcode = m.input.value;
        if (!passcode) return fail('Enter the passcode');
        busy = true;
        m.submit.disabled = true;
        try {
          await login(passcode);
          done(true);
        } catch (e) {
          fail(
            e && e.retryIn
              ? `Too many attempts — try again in ${e.retryIn}s`
              : 'Wrong passcode'
          );
        } finally {
          busy = false;
          m.submit.disabled = false;
        }
      }

      m.submit.onclick = attempt;
      m.cancel.onclick = () => done(false);
      m.input.onkeydown = (e) => {
        if (e.key === 'Enter') attempt();
        if (e.key === 'Escape') done(false);
      };
      m.wrap.onclick = (e) => {
        if (e.target === m.wrap) done(false);
      };
    });
  }

  return { getToken, setToken, verify, requestPasscode };
})();
