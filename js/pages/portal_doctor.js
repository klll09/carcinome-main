// ============================================================
// Carcinome Home Care — the doctor dashboard (#portal/home, role=doctor)
//
// A referring doctor asks one question about a patient they sent us: "where
// has this got to, and is anyone waiting on me?" So the page is a roster, not
// a feed — one line per referred patient, current state, and an explicit
// "waiting on" when something is stalled.
//
// This is the web form of `_shared/digest.ts:buildStatusDigest`, which already
// answers exactly this over WhatsApp when a doctor texts STATUS. Same facts,
// same order — a doctor who uses both should never see them disagree.
// ============================================================

import { fetchHome } from '../portal/api.js';
import { renderPortalShell, portalNotice, portalSkeleton } from '../portal/shell.js';
import { chatCard, bindChatCard } from './portal_home.js';
import { icon } from '../components/icons.js';
import { escapeHtml, formatDateTime, formatRelativeTime } from '../utils/formatters.js';

const STATE = {
  registered: 'Registered', offering: 'Finding a nurse', assigned: 'Nurse assigned',
  consented: 'Consented', otp_sent: 'Nurse arriving', in_care: 'Session running',
  care_done: 'Session done', awaiting_payment: 'Awaiting payment', paid: 'Settled',
};

export default async function render(session) {
  const content = renderPortalShell(session.profile, {
    title: session.profile?.full_name || 'Your patients',
    subtitle: 'Every patient you referred, from consent through discharge.',
  });
  content.innerHTML = portalSkeleton(3);

  let data;
  try {
    data = await fetchHome('doctor');
  } catch (err) {
    content.innerHTML = chatCard('doctor') + portalNotice(
      'error', 'Could not load your patients', err.message,
      '<button class="pt-btn pt-btn-ghost" type="button" onclick="location.reload()">Try again</button>',
    );
    bindChatCard();
    return;
  }

  const rows = data.patients ?? [];
  const waiting = rows.filter((r) => r.waiting_on);
  // The roster shows what is NOT already surfaced above. Listing everything in
  // both places put the same card on screen twice, which reads as a bug and
  // buries the two that actually need attention.
  const rest = rows.filter((r) => !r.waiting_on);
  const blocks = [chatCard('doctor')];

  // Anything stalled goes first — it is the only part of this page that might
  // need the doctor to act, or to know we are chasing someone.
  if (waiting.length) {
    blocks.push(`
      <section class="pt-section">
        <h2 class="pt-h2 pt-h2-warn">${icon('clock')}Waiting on someone</h2>
        <p class="pt-section-note">Our team is chasing each of these. Nothing is required from you.</p>
        ${waiting.map((r) => patientRow(r, true)).join('')}
      </section>`);
  }

  blocks.push(`
    <section class="pt-section">
      <h2 class="pt-h2">${icon('users')}${waiting.length ? 'Everything else, on track' : 'Your referred patients'}</h2>
      ${rest.length ? rest.map((r) => patientRow(r)).join('')
        : rows.length
          ? `<div class="pt-empty">${icon('checkCircle')}<p>Nothing else outstanding — every other referral is moving.</p></div>`
          : `<div class="pt-empty">${icon('inbox')}<p>No active referrals right now.</p></div>`}
    </section>`);

  const withChemo = rows.filter((r) => r.next_chemo_at);
  if (withChemo.length) {
    blocks.push(`
      <section class="pt-section">
        <h2 class="pt-h2">${icon('calendar')}Next chemotherapy dates</h2>
        ${withChemo.map((r) => `
          <div class="pt-chemo-row">
            <span>${escapeHtml(r.patient_name)}</span>
            <strong>${escapeHtml(formatDateTime(r.next_chemo_at))}</strong>
          </div>`).join('')}
        <p class="pt-section-note">Reply <strong>NEXT &lt;date&gt;</strong> on WhatsApp to set or change a date.</p>
      </section>`);
  }

  content.innerHTML = blocks.join('');
  bindChatCard();
}

function patientRow(r, highlight = false) {
  return `
    <article class="pt-card pt-session ${highlight ? 'is-overdue' : ''}">
      <div class="pt-card-top">
        <span class="pt-when">${escapeHtml(formatDateTime(r.scheduled_at))}</span>
        <span class="pt-chip pt-chip-${escapeHtml(r.status)}">${escapeHtml(STATE[r.status] ?? r.status)}</span>
      </div>
      <h3 class="pt-patient">${escapeHtml(r.patient_name)}</h3>
      <div class="pt-sub">
        ${escapeHtml(r.cancer_type || '')}${r.cancer_type ? ' · ' : ''}${escapeHtml(r.care_label)} · ${escapeHtml(r.case_code)}
      </div>

      <dl class="pt-kv pt-kv-wide">
        <div><dt>Nurse</dt><dd>${escapeHtml(r.nurse_name || 'Not yet assigned')}</dd></div>
        ${r.last_event ? `<div><dt>Last</dt><dd>${escapeHtml(r.last_event.label)} · ${escapeHtml(formatRelativeTime(r.last_event.at))}</dd></div>` : ''}
      </dl>

      ${r.waiting_on ? `
        <div class="pt-next pt-next-do">
          <span class="pt-next-label">Waiting on</span>
          <span>${escapeHtml(r.waiting_on)}</span>
        </div>` : ''}
    </article>`;
}
