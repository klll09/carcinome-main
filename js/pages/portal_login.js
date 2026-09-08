// ============================================================
// Carcinome Home Care — #portal/login?role=patient|nurse|doctor
//
// Patients receive a WhatsApp magic link.
// Nurses and doctors use their Carcinome email address and password.
//
// Visually this mirrors the admin sign-in screen (js/app.js renderLoginPage)
// on purpose — same .login-split / .login-hero / .login-card shell, same
// form-* and btn-* classes — so "sign in" looks and feels like one product
// whether you are staff, a nurse, a doctor or a patient's family, instead of
// the plain unstyled form this page used before.
// ============================================================

import {
  requestLoginLink,
  passwordLogin,
  getPortalSession,
  sampleLogin,
  setPortalSession,
} from '../portal/api.js';
import { CONFIG } from '../config.js';
import { navigate } from '../router.js';
import { showToast } from '../components/toast.js';
import { validateEmail, validateIndianPhone } from '../utils/validators.js';
import { escapeHtml } from '../utils/formatters.js';
import { icon } from '../components/icons.js';

const ROLE_COPY = {
  patient: {
    word: 'patient',
    kicker: 'Patient access',
    eyebrow: 'Oncology care, at home',
    heading: 'Your care team, <em>one link</em> away.',
    sub: 'Session times, your assigned nurse, invoices and discharge summaries — everything the family needs to track, sent straight to WhatsApp.',
    line: 'Enter the mobile number your care is registered against.',
    tail: 'We will send you a WhatsApp message with a link that signs you in — no password needed.',
  },
  nurse: {
    word: 'nurse',
    kicker: 'Nurse access',
    eyebrow: 'Home-care, coordinated',
    heading: 'Every visit, <em>one dashboard</em>.',
    sub: 'Today\u2019s sessions, open case offers, arrival codes and the reports you owe — all in one place, in the order your day actually happens.',
    line: 'Use the email address and password issued for your Carcinome nurse account.',
    tail: 'Your portal access is separate from the admin dashboard.',
  },
  doctor: {
    word: 'doctor',
    kicker: 'Doctor access',
    eyebrow: 'Referrals, tracked',
    heading: 'Every patient, <em>one view</em>.',
    sub: 'Every case you referred, from consent through discharge, with a clear "waiting on" the moment something stalls.',
    line: 'Use the email address and password issued for your Carcinome doctor account.',
    tail: 'Your portal access is separate from the admin dashboard.',
  },
};

const RESEND_COOLDOWN_MS = 45_000;

export default async function render(_container, params = {}) {
  if (getPortalSession()) {
    navigate('portal/home');
    return;
  }

  const role = ROLE_COPY[params.role] ? params.role : 'patient';
  const copy = ROLE_COPY[role];
  const usesEmailPassword = role === 'nurse' || role === 'doctor';
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="login-page">
      <div class="login-split">
        <aside class="login-hero">
          <div class="lh-brand">
            <div class="logo-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            </div>
            <div>
              <div class="lh-word">Carcinome</div>
              <div class="lh-tag">Home Care</div>
            </div>
          </div>
          <div class="lh-statement">
            <p class="lh-eyebrow">${escapeHtml(copy.eyebrow)}</p>
            <h1>${copy.heading}</h1>
            <p class="lh-sub">${escapeHtml(copy.sub)}</p>
          </div>
          <div class="lh-foot">
            <svg class="lh-ecg" viewBox="0 0 280 40" fill="none" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 20 H92 L104 20 112 7 122 33 130 20 H188 L196 20 202 12 208 27 214 20 H280" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="lh-mono">WhatsApp-first · Consent-led · Made with care</span>
          </div>
        </aside>

        <div class="login-card">
          <div class="card" id="pl-card">
            <button class="btn btn-ghost btn-sm" type="button" id="pl-back" style="margin-bottom:var(--space-4, 16px)">
              ${icon('arrowLeft')}<span>Back</span>
            </button>
            <div class="lc-head">
              <div class="lc-kicker">${escapeHtml(copy.kicker)}</div>
              <h2>Sign in as a ${escapeHtml(copy.word)}</h2>
              <p>${escapeHtml(copy.line)} ${escapeHtml(copy.tail)}</p>
            </div>
            <div id="pl-stage"></div>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('pl-back')?.addEventListener('click', () => {
    navigate('welcome');
  });

  renderForm();

  function renderForm(prefill = '') {
    const stage = document.getElementById('pl-stage');

    stage.innerHTML = `
      <form id="pl-form" novalidate>
        ${
          usesEmailPassword
            ? `
              <div class="form-group">
                <label class="form-label" for="pl-email">Email address</label>
                <input
                  class="form-input"
                  id="pl-email"
                  type="email"
                  inputmode="email"
                  autocomplete="username"
                  placeholder="you@example.com"
                  value="${escapeHtml(prefill)}"
                />
              </div>
              <div class="form-group">
                <label class="form-label" for="pl-password">Password</label>
                <input
                  class="form-input"
                  id="pl-password"
                  type="password"
                  autocomplete="current-password"
                  placeholder="••••••••"
                />
              </div>
            `
            : `
              <div class="form-group">
                <label class="form-label" for="pl-phone">WhatsApp mobile number</label>
                <div class="pt-phone">
                  <span class="pt-phone-cc">+91</span>
                  <input
                    class="form-input"
                    id="pl-phone"
                    type="tel"
                    inputmode="numeric"
                    autocomplete="tel-national"
                    placeholder="98765 43210"
                    maxlength="14"
                    value="${escapeHtml(prefill)}"
                  />
                </div>
              </div>
            `
        }

        <div class="form-error" id="pl-error" hidden></div>

        <button class="btn btn-primary btn-lg" style="width:100%" type="submit" id="pl-submit">
          ${usesEmailPassword ? 'Sign In' : 'Send my sign-in link'}
        </button>

        <p style="text-align:center;margin-top:var(--space-4, 16px);font-size:var(--font-xs, 12px);color:var(--color-text-muted, var(--ink-3))">
          ${
            usesEmailPassword
              ? 'Contact the Carcinome team if you need access or a password reset.'
              : 'The link is sent to the number registered with Carcinome and works once, for 15 minutes.'
          }
        </p>
      </form>

      ${CONFIG.SAMPLE_LOGIN ? sampleBlock() : ''}
    `;

    const input = document.getElementById(
      usesEmailPassword ? 'pl-email' : 'pl-phone',
    );

    input?.focus();

    document
      .getElementById('pl-form')
      ?.addEventListener('submit', onSubmit);

    document
      .getElementById('pl-sample')
      ?.addEventListener('click', onSampleLogin);
  }

  function sampleBlock() {
    return `
      <div style="margin-top:var(--space-5, 20px);padding-top:var(--space-5, 20px);border-top:1px solid var(--border, #E7E9EC);text-align:center">
        <p style="font-size:var(--font-xs, 12px);color:var(--color-text-muted, var(--ink-3));margin:0 0 10px">Demo build — no WhatsApp needed.</p>
        <button class="btn btn-ghost" type="button" id="pl-sample" style="width:100%">
          ${icon('userCheck')}
          <span>Sign in as a sample ${escapeHtml(copy.word)}</span>
        </button>
      </div>
    `;
  }

  async function onSampleLogin() {
    const btn = document.getElementById('pl-sample');

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

    try {
      await sampleLogin(role);
      navigate('portal/home');
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.innerHTML = `
        ${icon('userCheck')}
        <span>Sign in as a sample ${escapeHtml(copy.word)}</span>
      `;
    }
  }

  async function onSubmit(event) {
    event.preventDefault();

    const errEl = document.getElementById('pl-error');
    const btn = document.getElementById('pl-submit');
    const input = document.getElementById(
      usesEmailPassword ? 'pl-email' : 'pl-phone',
    );

    const raw = input.value.trim();
    const password = usesEmailPassword
      ? document.getElementById('pl-password').value
      : '';

    if (usesEmailPassword) {
      if (!validateEmail(raw)) {
        errEl.textContent = 'Enter a valid email address.';
        errEl.hidden = false;
        input.focus();
        return;
      }

      if (!password) {
        errEl.textContent = 'Enter your password.';
        errEl.hidden = false;
        document.getElementById('pl-password').focus();
        return;
      }
    } else {
      const phoneCheck = validateIndianPhone(raw);

      if (!phoneCheck.ok) {
        errEl.textContent = phoneCheck.error;
        errEl.hidden = false;
        input.focus();
        return;
      }
    }

    errEl.hidden = true;
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner" style="margin:0 auto"></div>`;

    try {
      if (usesEmailPassword) {
        const result = await passwordLogin(role, raw, password);

        setPortalSession({
          token: result.session,
          expires_at: result.expires_at,
          profile: result.profile,
        });

        navigate('portal/home');
        return;
      }

      const phoneCheck = validateIndianPhone(raw);

      await requestLoginLink(role, phoneCheck.normalized);
      renderSent(raw);
    } catch (err) {
      if (usesEmailPassword && err.message === 'invalid_credentials') {
        errEl.textContent =
          'Email or password is incorrect, or this account has not been enabled.';
        errEl.hidden = false;
      } else {
        showToast(err.message, 'error');
      }

      btn.disabled = false;
      btn.textContent = usesEmailPassword
        ? 'Sign In'
        : 'Send my sign-in link';
    }
  }

  function renderSent(typed) {
    const stage = document.getElementById('pl-stage');

    stage.innerHTML = `
      <div style="text-align:center">
        <span class="pt-sent-icon">${icon('message')}</span>
        <h3 style="margin:14px 0 8px">Check your WhatsApp</h3>

        <p style="color:var(--color-text-muted, var(--ink-2));font-size:var(--font-sm, 14px)">
          If <strong>${escapeHtml(typed)}</strong> is registered with
          Carcinome Home Care, a sign-in link is on its way now.
          Open the message and tap the link on this device.
        </p>

        <ul style="text-align:left;color:var(--color-text-muted, var(--ink-3));font-size:var(--font-xs, 12px);line-height:1.6;margin:16px 0">
          <li>The link works once and expires in 15 minutes.</li>
          <li>It always goes to the number we have on file, not to a number typed here.</li>
          <li>Nothing arrived? The number may not be registered — reply to any Carcinome message and the team will help.</li>
        </ul>

        <button class="btn btn-ghost" style="width:100%" type="button" id="pl-resend" disabled>
          Send another link
        </button>

        <button class="btn btn-ghost" style="width:100%;margin-top:8px" type="button" id="pl-change">
          Use a different number
        </button>
      </div>
    `;

    document
      .getElementById('pl-change')
      ?.addEventListener('click', () => renderForm(typed));

    const resend = document.getElementById('pl-resend');
    let left = Math.ceil(RESEND_COOLDOWN_MS / 1000);

    resend.textContent = `Send another link (${left}s)`;

    const tick = setInterval(() => {
      left -= 1;

      if (!document.body.contains(resend)) {
        clearInterval(tick);
        return;
      }

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
      resend.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

      const phoneCheck = validateIndianPhone(typed);

      try {
        if (phoneCheck.ok) {
          await requestLoginLink(role, phoneCheck.normalized);
        }

        showToast(
          'If that number is registered, another link is on its way.',
          'success',
        );
      } catch (err) {
        showToast(err.message, 'error');
      }

      resend.textContent = 'Send another link';
    });
  }
}