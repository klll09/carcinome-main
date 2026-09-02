// ============================================================
// Carcinome Home Care — #welcome (the front door)
//
// The first screen anyone who is not already signed in sees. Three doors for
// the people the service exists for, and one for the team.
//
// THE ADMIN DOOR IS FAIL-CLOSED. It renders only after the server has said
// portal.show_admin_login is true. If the config call fails, is slow, or the
// flag is off, the door stays hidden — a production build must not flash the
// staff entrance because a fetch was in flight. #login always works when
// typed directly, so hiding it never locks the team out.
// ============================================================

import { portalConfig, getPortalSession, sampleLogin } from '../portal/api.js';
import { navigate } from '../router.js';
import { icon } from '../components/icons.js';
import { showToast } from '../components/toast.js';
import { CONFIG } from '../config.js';

const DOORS = [
  {
    role: 'patient',
    glyph: 'heart',
    title: 'I am a patient',
    sub: 'or family of a patient',
    blurb: 'See your session time, your nurse, your bill and your discharge summary.',
  },
  {
    role: 'nurse',
    glyph: 'stethoscope',
    title: 'I am a nurse',
    sub: 'Carcinome care team',
    blurb: 'Your visits for today, open case offers and the reports you owe.',
  },
  {
    role: 'doctor',
    glyph: 'clipboard',
    title: 'I am a doctor',
    sub: 'referring physician',
    blurb: 'Follow every patient you referred, from consent through discharge.',
  },
];

export default async function render() {
  // Somebody already signed in should never be shown the door again.
  if (getPortalSession()) { navigate('portal/home'); return; }

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="lp-page">
      <div class="lp-inner">
        <div class="lp-brand">
          <span class="lp-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
          </span>
          <div>
            <div class="lp-word">Carcinome</div>
            <div class="lp-tag">Home Care</div>
          </div>
        </div>

        <div class="lp-lede">
          <h1>Oncology care, brought home.</h1>
          <p>${CONFIG.SAMPLE_LOGIN
            ? 'Choose a role to open its dashboard. This build signs you straight in as a sample account — no password, no verification.'
            : 'Sign in to see your part of the care. We will send a link to your WhatsApp — there is no password to remember.'}</p>
        </div>

        <div class="lp-doors">
          ${DOORS.map((d) => `
            <button class="lp-door" type="button" data-role="${d.role}">
              <span class="lp-door-icon">${icon(d.glyph)}</span>
              <span class="lp-door-body">
                <span class="lp-door-title">${d.title}</span>
                <span class="lp-door-sub">${d.sub}</span>
                <span class="lp-door-blurb">${d.blurb}</span>
              </span>
              <span class="lp-door-go">${icon('chevronRight')}</span>
            </button>`).join('')}
        </div>

        <div class="lp-help">
          ${CONFIG.SAMPLE_LOGIN ? 'Sample data only — nothing here touches a real patient record.' : 'Not sure which to pick? Reply on WhatsApp and the care team will help.'}
        </div>

        <!-- Populated only when the server confirms the flag. See header. -->
        <div class="lp-staff" id="lp-staff" hidden></div>
      </div>
    </div>`;

  // ── The door click ────────────────────────────────────────────────────────
  // In demo mode a door signs you STRAIGHT in — no phone form, no magic link,
  // no waiting for a WhatsApp that a local build cannot send. The login page
  // still exists and still works; it is simply not on the path when there is
  // no way to complete the verification it asks for.
  //
  // Production (SAMPLE_LOGIN false) keeps the real route: door → phone → link.
  for (const btn of app.querySelectorAll('.lp-door')) {
    btn.addEventListener('click', async () => {
      const role = btn.dataset.role;
      if (!CONFIG.SAMPLE_LOGIN) { navigate(`portal/login?role=${role}`); return; }

      btn.disabled = true;
      btn.classList.add('is-busy');
      try {
        await sampleLogin(role);
        navigate('portal/home');
      } catch (err) {
        console.error('[landing] sample sign-in failed:', err);
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.classList.remove('is-busy');
      }
    });
  }

  // Demo mode shows the staff door unconditionally, so the admin portal is
  // reachable without the backend deployed. Production keeps the fail-closed
  // behaviour: the door appears only once the server confirms the flag.
  if (CONFIG.SAMPLE_LOGIN) {
    showStaffDoor();
    return;
  }

  try {
    const cfg = await portalConfig();
    if (cfg?.show_admin_login) showStaffDoor();
  } catch (err) {
    // Fail closed and stay quiet: a visitor does not need to know the staff
    // door exists, and the three portal doors above already work.
    console.warn('[landing] portal config unavailable — staff door stays hidden:', err.message);
  }
}

function showStaffDoor() {
  const staff = document.getElementById('lp-staff');
  if (!staff) return; // navigated away while the config was in flight
  staff.hidden = false;
  staff.innerHTML = `
    <span class="lp-staff-rule"></span>
    <button class="lp-staff-link" type="button" id="lp-admin">
      ${icon('lock')}<span>Carcinome team sign-in</span>
    </button>`;
  document.getElementById('lp-admin')?.addEventListener('click', () => navigate('login'));
}
