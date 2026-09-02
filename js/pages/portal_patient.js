// ============================================================
// Carcinome Home Care — the patient dashboard (#portal/home, role=patient)
//
// Read by a family on the worst day of their year, often by someone elderly,
// often on a phone in a hospital corridor. So the register is different from
// the nurse's: no jargon, no case-management vocabulary, one plain sentence
// about what happens next, and never a number they have to interpret.
//
// "Your nurse", not "assigned_nurse_id". "Your bill is ready", not
// "awaiting_payment". The case code is present but small — it is for us, not
// for them.
//
// Like every portal page, this SHOWS and WhatsApp DOES: paying, consenting and
// asking a question all happen in the chat thread they already have.
// ============================================================

import { fetchHome } from '../portal/api.js';
import { renderPortalShell, portalNotice, portalSkeleton } from '../portal/shell.js';
import { chatCard, bindChatCard } from './portal_home.js';
import { icon } from '../components/icons.js';
import { escapeHtml, formatDateTime, formatINR } from '../utils/formatters.js';

// Plain-language state, in the family's words rather than the schema's.
const STATE = {
  registered: { label: 'Finding your nurse', tone: 'wait' },
  offering: { label: 'Finding your nurse', tone: 'wait' },
  assigned: { label: 'Nurse confirmed', tone: 'ok' },
  consented: { label: 'Ready for your session', tone: 'ok' },
  otp_sent: { label: 'Your nurse is on the way', tone: 'live' },
  in_care: { label: 'Session in progress', tone: 'live' },
  care_done: { label: 'Session complete', tone: 'ok' },
  awaiting_payment: { label: 'Bill ready', tone: 'do' },
  paid: { label: 'Settled — thank you', tone: 'ok' },
};

export default async function render(session) {
  const content = renderPortalShell(session.profile, {
    title: `Hello, ${firstName(session.profile?.full_name)}`,
    subtitle: 'Everything about your home care, in one place.',
  });
  content.innerHTML = portalSkeleton(2);

  let data;
  try {
    data = await fetchHome('patient');
  } catch (err) {
    content.innerHTML = chatCard('patient') + portalNotice(
      'error', 'Could not load your care right now', err.message,
      '<button class="pt-btn pt-btn-ghost" type="button" onclick="location.reload()">Try again</button>',
    );
    bindChatCard();
    return;
  }

  const wa = data.wa_number ? `https://wa.me/${data.wa_number}` : null;
  const cases = data.cases ?? [];
  const live = cases.filter((c) => !['paid', 'archived', 'cancelled'].includes(c.status));
  const past = cases.filter((c) => ['paid', 'archived'].includes(c.status));

  const blocks = [chatCard('patient')];

  if (data.next_chemo_at) {
    blocks.push(`
      <section class="pt-alert pt-alert-ask">
        <div class="pt-alert-head">${icon('calendar')}<span>Your next chemotherapy</span></div>
        <p><strong>${escapeHtml(formatDateTime(data.next_chemo_at))}</strong>. Our team will contact you before
        the date to arrange the home-care session — there is nothing you need to do now.</p>
      </section>`);
  }

  blocks.push(`
    <section class="pt-section">
      <h2 class="pt-h2">${icon('heartPulse')}Your care</h2>
      ${live.length ? live.map((c) => caseCard(c, wa)).join('')
        : `<div class="pt-empty">${icon('checkCircle')}<p>No sessions are scheduled right now.</p></div>`}
    </section>`);

  if (past.length) {
    blocks.push(`
      <section class="pt-section">
        <h2 class="pt-h2">${icon('archive')}Past sessions</h2>
        ${past.map((c) => caseCard(c, wa, true)).join('')}
      </section>`);
  }

  content.innerHTML = blocks.join('');
  bindChatCard();
}

function caseCard(c, wa, muted = false) {
  const state = STATE[c.status] ?? { label: c.status, tone: 'wait' };
  const tone = c.next_step?.tone ?? 'wait';
  return `
    <article class="pt-card pt-session ${muted ? 'is-past' : ''}">
      <div class="pt-card-top">
        <span class="pt-when">${escapeHtml(formatDateTime(c.scheduled_at))}</span>
        <span class="pt-chip pt-chip-${escapeHtml(c.status)}">${escapeHtml(state.label)}</span>
      </div>
      <h3 class="pt-patient">${escapeHtml(c.care_label)}</h3>
      <div class="pt-sub">${escapeHtml(c.line_label)} · ${escapeHtml(c.case_code)}</div>

      <dl class="pt-kv pt-kv-wide">
        <div><dt>Nurse</dt><dd>${escapeHtml(c.nurse_name || 'Being confirmed')}</dd></div>
        ${c.doctor_name ? `<div><dt>Doctor</dt><dd>${escapeHtml(c.doctor_name)}</dd></div>` : ''}
        <div><dt>Where</dt><dd>${escapeHtml(c.address)}</dd></div>
        ${c.invoice ? `<div><dt>Bill</dt><dd>${escapeHtml(formatINR(c.invoice.total_inr))} · ${escapeHtml(invoiceWord(c.invoice.status))}</dd></div>` : ''}
      </dl>

      ${(c.documents ?? []).length ? `
        <div class="pt-docs">
          ${c.documents.map((d) => `<span class="pt-doc">${icon('fileText')}${escapeHtml(d.label)}</span>`).join('')}
          <p class="pt-doc-note">Sent to you on WhatsApp — open the chat to download.</p>
        </div>` : ''}

      ${c.next_step?.action ? `
        <div class="pt-next pt-next-${escapeHtml(tone)}">
          <span class="pt-next-label">${tone === 'do' ? 'What to do next' : tone === 'done' ? 'All done' : 'What happens next'}</span>
          <span>${escapeHtml(c.next_step.action)}</span>
        </div>` : ''}

      ${muted || !wa ? '' : `<a class="pt-btn pt-btn-ghost pt-btn-wa" href="${escapeHtml(wa)}" target="_blank" rel="noopener noreferrer">
        ${icon('message')}<span>Open my care chat</span></a>`}
    </article>`;
}

function invoiceWord(status) {
  return {
    draft: 'being prepared', sent: 'awaiting payment',
    paid_claimed: 'payment being confirmed', paid_verified: 'paid — thank you', void: 'cancelled',
  }[status] ?? status;
}

function firstName(full) {
  return String(full || 'there').trim().split(/\s+/)[0];
}
