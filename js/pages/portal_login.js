// ============================================================
// Carcinome Home Care — #portal/login?role=patient|nurse|doctor
//
// Ask for a phone number, send a one-time link to WhatsApp. Two states on one
// page: the form, then "check your WhatsApp".
//
// THE SUCCESS SCREEN IS THE SAME WHATEVER HAPPENS. The server answers every
// request_link identically — unknown number, opted-out, rate-limited or sent —
// because "is this number a cancer patient?" is itself a sensitive question
// and this form must not answer it. So this page must not leak the difference
// either: no "we couldn't find you", no different wording. The screen says
// what we did (sent a link IF the number is registered), which is honest and
// tells an attacker nothing.
//
// The link goes to the number ON FILE, never to the number typed here. Typing
// a stranger's number sends the link to that stranger, not to you.
// ============================================================

import { requestLoginLink, getPortalSession, sampleLogin } from '../portal/api.js';
import { CONFIG } from '../config.js';
import { navigate } from '../router.js';
import { showToast } from '../components/toast.js';
import { validateIndianPhone } from '../utils/validators.js';
import { escapeHtml } from '../utils/formatters.js';
import { icon } from '../components/icons.js';

const ROLE_COPY = {
  patient: { word: 'patient', line: 'Enter the mobile number your care is registered against.' },
  nurse: { word: 'nurse', line: 'Enter the mobile number Carcinome has on your nurse profile.' },
  doctor: { word: 'doctor', line: 'Enter the mobile number you receive patient updates on.' },
};

const RESEND_COOLDOWN_MS = 45_000;

export default async function render(_container, params = {}) {
  if (getPortalSession()) { navigate('portal/home'); return; }

  const role = ROLE_COPY[params.role] ? params.role : 'patient';
  const copy = ROLE_COPY[role];
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="lp-page">
      <div class="lp-inner lp-inner-narrow">
        <button class="pt-back" type="button" id="pl-back">${icon('arrowLeft')}<span>Back</span></button>

        <div class="lp-lede">
          <h1>Sign in as a ${escapeHtml(copy.word)}</h1>
          <p>${escapeHtml(copy.line)} We will send you a WhatsApp message with a link that signs you in — no password needed.</p>
        </div>

        <div class="pt-card" id="pl-stage"></div>
      </div>
    </div>`;

  document.getElementById('pl-back')?.addEventListener('click', () => navigate('welcome'));
  renderForm();

  // ---- Stage 1: the form ----------------------------------------------------
  function renderForm(prefill = '') {
    const stage = document.getElementById('pl-stage');
    stage.innerHTML = `
      <form id="pl-form" novalidate>
        <label class="pt-label" for="pl-phone">WhatsApp mobile number</label>
        <div class="pt-phone">
          <span class="pt-phone-cc">+91</span>
          <input class="pt-input" id="pl-phone" type="tel" inputmode="numeric" autocomplete="tel-national"
                 placeholder="98765 43210" maxlength="14" value="${escapeHtml(prefill)}" />
        </div>
        <div class="pt-field-error" id="pl-error" hidden></div>
        <button class="pt-btn pt-btn-primary" type="submit" id="pl-submit">Send my sign-in link</button>
        <p class="pt-fineprint">The link is sent to the number registered with Carcinome and works once, for 15 minutes.</p>
      </form>
      ${CONFIG.SAMPLE_LOGIN ? sampleBlock() : ''}`;

    const input = document.getElementById('pl-phone');
    input?.focus();
    document.getElementById('pl-form').addEventListener('submit', onSubmit);
    document.getElementById('pl-sample')?.addEventListener('click', onSampleLogin);
  }

  // Demo only — CONFIG.SAMPLE_LOGIN. The server gates this independently, so a
  // production build cannot be talked into issuing one of these.
  function sampleBlock() {
    return `
      <div class="pt-sample">
        <span class="pt-sample-rule"></span>
        <p class="pt-sample-note">Demo build — no WhatsApp needed.</p>
        <button class="pt-btn pt-btn-ghost" type="button" id="pl-sample">
          ${icon('userCheck')}<span>Sign in as a sample ${escapeHtml(copy.word)}</span>
        </button>
      </div>`;
  }

  async function onSampleLogin() {
    const btn = document.getElementById('pl-sample');
    btn.disabled = true;
    btn.innerHTML = '<span class="pt-spinner"></span>Signing in…';
    try {
      await sampleLogin(role);
      navigate('portal/home');
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.innerHTML = `${icon('userCheck')}<span>Sign in as a sample ${escapeHtml(copy.word)}</span>`;
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('pl-phone');
    const errEl = document.getElementById('pl-error');
    const btn = document.getElementById('pl-submit');
    const raw = input.value.trim();

    // Shape validation only — whether the number is REGISTERED is never
    // revealed here, and this check does not consult the server.
    const v = validateIndianPhone(raw);
    if (!v.ok) {
      errEl.textContent = v.error;
      errEl.hidden = false;
      input.focus();
      return;
    }
    errEl.hidden = true;

    btn.disabled = true;
    btn.innerHTML = '<span class="pt-spinner"></span>Sending…';
    try {
      await requestLoginLink(role, v.normalized);
      renderSent(raw);
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Send my sign-in link';
    }
  }

  // ---- Stage 2: sent (identical for every outcome) --------------------------
  function renderSent(typed) {
    const stage = document.getElementById('pl-stage');
    stage.innerHTML = `
      <div class="pt-sent">
        <span class="pt-sent-icon">${icon('message')}</span>
        <h2>Check your WhatsApp</h2>
        <p>
          If <strong>${escapeHtml(typed)}</strong> is registered with Carcinome Home Care, a sign-in link is
          on its way to it now. Open the message and tap the link on this device.
        </p>
        <ul class="pt-sent-notes">
          <li>The link works once and expires in 15 minutes.</li>
          <li>It always goes to the number we have on file, not to a number typed here.</li>
          <li>Nothing arrived? The number may not be registered — reply to any Carcinome message and the team will help.</li>
        </ul>
        <button class="pt-btn pt-btn-ghost" type="button" id="pl-resend" disabled>Send another link</button>
        <button class="pt-btn pt-btn-link" type="button" id="pl-change">Use a different number</button>
      </div>`;

    document.getElementById('pl-change')?.addEventListener('click', () => renderForm(typed));

    // Cooldown before a resend: the server rate-limits per destination number
    // anyway, and a button that silently does nothing is worse than a disabled
    // one that says when it wakes up.
    const resend = document.getElementById('pl-resend');
    let left = Math.ceil(RESEND_COOLDOWN_MS / 1000);
    resend.textContent = `Send another link (${left}s)`;
    const tick = setInterval(() => {
      left -= 1;
      if (!document.body.contains(resend)) { clearInterval(tick); return; }
      if (left <= 0) {
        clearInterval(tick);
        resend.disabled = false;
        resend.textContent = 'Send another link';
      } else {
        resend.textContent = `Send another link (${left}s)`;
      }
    }, 1000);

    resend.addEventListener('click', async () => {
      resend.disabled = true;
      resend.innerHTML = '<span class="pt-spinner"></span>Sending…';
      const v = validateIndianPhone(typed);
      try {
        if (v.ok) await requestLoginLink(role, v.normalized);
        showToast('If that number is registered, another link is on its way.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      resend.textContent = 'Send another link';
    });
  }
}
