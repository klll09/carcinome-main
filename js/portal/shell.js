// ============================================================
// Carcinome Home Care — Portal shell (patient / nurse / doctor)
//
// Deliberately NOT the admin shell. The admin runs a whole service from a
// desk; a nurse reads this on a phone between two homes, and a patient's
// family reads it on the worst day of their year. So: one column, big type,
// no sidebar, no nav rail, nothing to get lost in. Everything a portal page
// needs is the header (who am I, how do I leave) and one content well.
// ============================================================

import { portalLogout } from './api.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../utils/formatters.js';
import { icon } from '../components/icons.js';
import { showToast } from '../components/toast.js';

const ROLE_WORD = { patient: 'Patient', nurse: 'Nurse', doctor: 'Doctor' };

/**
 * Paint the portal chrome into #app and hand back the content element.
 * Pages render into the returned node, never into #app directly, so the
 * header survives a re-render of the page body.
 */
export function renderPortalShell(profile, { title, subtitle = '' } = {}) {
  const app = document.getElementById('app');
  const name = profile?.full_name || 'there';
  const roleWord = ROLE_WORD[profile?.role] || '';

  app.innerHTML = `
    <div class="pt-shell">
      <header class="pt-header">
        <div class="pt-header-in">
          <div class="pt-brand">
            <span class="pt-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            </span>
            <span class="pt-brand-text">
              <span class="pt-brand-name">Carcinome</span>
              <span class="pt-brand-sub">Home Care${roleWord ? ` · ${escapeHtml(roleWord)}` : ''}</span>
            </span>
          </div>
          <button class="pt-signout" id="pt-signout" type="button">
            ${icon('logOut')}<span>Sign out</span>
          </button>
        </div>
      </header>

      <main class="pt-main">
        <div class="pt-greet">
          <h1>${escapeHtml(title || `Hello, ${name}`)}</h1>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <div id="pt-content"></div>
      </main>

      <footer class="pt-footer">
        Carcinome Home Care · Jarurat Care Foundation<br />
        For anything urgent, reply on WhatsApp — the care team reads every message.
      </footer>
    </div>`;

  document.getElementById('pt-signout')?.addEventListener('click', async () => {
    const btn = document.getElementById('pt-signout');
    if (btn) btn.disabled = true;
    await portalLogout();
    showToast('Signed out.', 'success');
    navigate('welcome');
  });

  return document.getElementById('pt-content');
}

/** Full-width message panel — used for empty states and load failures. */
export function portalNotice(kind, heading, detail, actionHtml = '') {
  const glyph = kind === 'error' ? 'alertCircle' : kind === 'ok' ? 'checkCircle' : 'info';
  return `
    <div class="pt-notice pt-notice-${escapeHtml(kind)}">
      <span class="pt-notice-icon">${icon(glyph)}</span>
      <div>
        <div class="pt-notice-head">${escapeHtml(heading)}</div>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
        ${actionHtml}
      </div>
    </div>`;
}

/** Skeleton rows while a portal page loads. */
export function portalSkeleton(rows = 3) {
  return `<div class="pt-skel">${
    Array.from({ length: rows }, () => '<div class="pt-skel-card"></div>').join('')
  }</div>`;
}
