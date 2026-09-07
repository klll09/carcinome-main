// ============================================================
// Carcinome Home Care — #portal/login?role=patient|nurse|doctor
//
// Patients receive a WhatsApp magic link.
// Nurses and doctors use their Carcinome email address and password.
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
    line: 'Enter the mobile number your care is registered against.',
  },
  nurse: {
    word: 'nurse',
    line: 'Use the email address and password issued for your Carcinome nurse account.',
  },
  doctor: {
    word: 'doctor',
    line: 'Use the email address and password issued for your Carcinome doctor account.',
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
    <div class="lp-page">
      <div class="lp-inner lp-inner-narrow">
        <button class="pt-back" type="button" id="pl-back">
          ${icon('arrowLeft')}
          <span>Back</span>
        </button>

        <div class="lp-lede">
          <h1>Sign in as a ${escapeHtml(copy.word)}</h1>
          <p>
            ${escapeHtml(copy.line)}
            ${
              usesEmailPassword
                ? 'Your portal access is separate from the admin dashboard.'
                : 'We will send you a WhatsApp message with a link that signs you in — no password needed.'
            }
          </p>
        </div>

        <div class="pt-card" id="pl-stage"></div>
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
              <label class="pt-label" for="pl-email">Email address</label>
              <input
                class="pt-input"
                id="pl-email"
                type="email"
                inputmode="email"
                autocomplete="username"
                placeholder="you@example.com"
                value="${escapeHtml(prefill)}"
              />

              <label class="pt-label" for="pl-password" style="margin-top:16px">
                Password
              </label>
              <input
                class="pt-input"
                id="pl-password"
                type="password"
                autocomplete="current-password"
                placeholder="Enter your password"
              />
            `
            : `
              <label class="pt-label" for="pl-phone">WhatsApp mobile number</label>
              <div class="pt-phone">
                <span class="pt-phone-cc">+91</span>
                <input
                  class="pt-input"
                  id="pl-phone"
                  type="tel"
                  inputmode="numeric"
                  autocomplete="tel-national"
                  placeholder="98765 43210"
                  maxlength="14"
                  value="${escapeHtml(prefill)}"
                />
              </div>
            `
        }

        <div class="pt-field-error" id="pl-error" hidden></div>

        <button class="pt-btn pt-btn-primary" type="submit" id="pl-submit">
          ${usesEmailPassword ? 'Sign in' : 'Send my sign-in link'}
        </button>

        <p class="pt-fineprint">
          ${
            usesEmailPassword
              ? 'Use the email account set up for your Carcinome role. Contact the Carcinome team if you need access or a password reset.'
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
      <div class="pt-sample">
        <span class="pt-sample-rule"></span>
        <p class="pt-sample-note">Demo build — no WhatsApp needed.</p>

        <button class="pt-btn pt-btn-ghost" type="button" id="pl-sample">
          ${icon('userCheck')}
          <span>Sign in as a sample ${escapeHtml(copy.word)}</span>
        </button>
      </div>
    `;
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
    btn.innerHTML = `
      <span class="pt-spinner"></span>
      ${usesEmailPassword ? 'Signing in…' : 'Sending…'}
    `;

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
        ? 'Sign in'
        : 'Send my sign-in link';
    }
  }

  function renderSent(typed) {
    const stage = document.getElementById('pl-stage');

    stage.innerHTML = `
      <div class="pt-sent">
        <span class="pt-sent-icon">${icon('message')}</span>
        <h2>Check your WhatsApp</h2>

        <p>
          If <strong>${escapeHtml(typed)}</strong> is registered with
          Carcinome Home Care, a sign-in link is on its way now.
          Open the message and tap the link on this device.
        </p>

        <ul class="pt-sent-notes">
          <li>The link works once and expires in 15 minutes.</li>
          <li>It always goes to the number we have on file, not to a number typed here.</li>
          <li>Nothing arrived? The number may not be registered — reply to any Carcinome message and the team will help.</li>
        </ul>

        <button class="pt-btn pt-btn-ghost" type="button" id="pl-resend" disabled>
          Send another link
        </button>

        <button class="pt-btn pt-btn-link" type="button" id="pl-change">
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
      resend.innerHTML = '<span class="pt-spinner"></span>Sending…';

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