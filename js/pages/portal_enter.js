// ============================================================
// Carcinome Home Care — #portal/enter?t=<token>
//
// Where a magic link lands. Exchanges the one-time token for a session, then
// gets the token out of the URL immediately: a link in browser history, in a
// screenshot, or in a shoulder-surfed address bar is a credential lying in
// the open. history.replaceState is used (not a navigate) so the tokened URL
// leaves the history stack entirely rather than sitting one Back press away.
//
// The token is single-use server-side, so a refresh of this page after a
// successful sign-in cannot re-redeem — that is why a live session short-
// circuits straight to the dashboard instead of trying again.
// ============================================================

import { verifyLoginToken, setPortalSession, getPortalSession } from '../portal/api.js';
import { navigate } from '../router.js';
import { icon } from '../components/icons.js';
import { escapeHtml } from '../utils/formatters.js';

export default async function render(_container, params = {}) {
  const token = params.t || params.token || '';
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="lp-page">
      <div class="lp-inner lp-inner-narrow">
        <div class="pt-card pt-center" id="pe-stage">
          <span class="pt-spinner pt-spinner-lg"></span>
          <h2>Signing you in…</h2>
          <p class="pt-muted">One moment.</p>
        </div>
      </div>
    </div>`;

  // Already signed in (a refresh, or a second tap on a burnt link).
  if (!token && getPortalSession()) { navigate('portal/home'); return; }

  if (!token) {
    fail('That link is incomplete', 'Please open the full link from your WhatsApp message.');
    return;
  }

  try {
    const res = await verifyLoginToken(token);
    setPortalSession({ token: res.session, expires_at: res.expires_at, profile: res.profile });

    // Burn the token out of the URL before rendering anything else.
    history.replaceState(null, '', '#portal/home');
    navigate('portal/home');
  } catch (err) {
    history.replaceState(null, '', '#portal/enter');
    fail('That link did not work', err.message);
  }

  function fail(heading, detail) {
    const stage = document.getElementById('pe-stage');
    if (!stage) return;
    stage.innerHTML = `
      <span class="pt-sent-icon pt-sent-icon-warn">${icon('alertCircle')}</span>
      <h2>${escapeHtml(heading)}</h2>
      <p class="pt-muted">${escapeHtml(detail)}</p>
      <button class="pt-btn pt-btn-primary" type="button" id="pe-again">Get a new link</button>`;
    document.getElementById('pe-again')?.addEventListener('click', () => navigate('welcome'));
  }
}
