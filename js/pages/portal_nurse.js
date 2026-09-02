// ============================================================
// Carcinome Home Care — the nurse dashboard (#portal/home, role=nurse)
//
// Read on a phone, one-handed, between two homes — sometimes standing at a
// gate. So the page answers one question at a time, in the order the day
// actually happens, and the most time-critical thing is always at the top:
//
//   1. an arrival code waiting on her RIGHT NOW
//   2. an "are you going?" we asked and she has not answered
//   3. sessions that ran past their date and never closed out
//   4. today's visits
//   5. offers she has not replied to
//   6. the rest of the week
//
// THIS PAGE IS A WINDOW, NOT A CONTROL PANEL. Every action in this system —
// accepting an offer, verifying arrival, submitting the report — happens in
// the WhatsApp thread, because that is where the ledger, the delivery
// receipts and the relay live. Duplicating those actions here would create a
// second write path into case state and two places to get idempotency wrong.
// So each card ends in a WhatsApp link, and the copy says what to send.
// ============================================================

import { fetchHome } from '../portal/api.js';
import { renderPortalShell, portalNotice, portalSkeleton } from '../portal/shell.js';
import { chatCard, bindChatCard } from './portal_home.js';
import { icon } from '../components/icons.js';
import { escapeHtml, formatDateTime, formatTime, formatRelativeTime } from '../utils/formatters.js';

const STATUS_WORD = {
  assigned: 'Assigned',
  consented: 'Consent signed',
  otp_sent: 'Arrival code sent',
  in_care: 'Session running',
  care_done: 'Report submitted',
  awaiting_payment: 'Report submitted',
  paid: 'Settled',
};

export default async function render(session) {
  const content = renderPortalShell(session.profile, {
    title: `Hello, ${firstName(session.profile?.full_name)}`,
    subtitle: todayLine(),
  });
  content.innerHTML = portalSkeleton(3);

  let data;
  try {
    data = await fetchHome('nurse');
  } catch (err) {
    // The chat is served by a different process from the dashboard payload, so
    // one being down must not take the other with it — a nurse who cannot see
    // her rota can still reach the family.
    content.innerHTML = chatCard('nurse') + portalNotice(
      'error',
      'Could not load your day',
      err.message,
      '<button class="pt-btn pt-btn-ghost" type="button" onclick="location.reload()">Try again</button>',
    );
    bindChatCard();
    return;
  }

  const wa = data.wa_number ? `https://wa.me/${data.wa_number}` : null;
  const blocks = [chatCard('nurse')];

  // ── 1. Arrival code outstanding ──────────────────────────────────────────
  if (data.arrival) {
    blocks.push(`
      <section class="pt-alert pt-alert-do">
        <div class="pt-alert-head">${icon('key')}<span>Arrival code waiting</span></div>
        <p>
          You are at <strong>${escapeHtml(data.arrival.case_code)}</strong>. Ask the family for the
          <strong>6-digit arrival number</strong> and send it on WhatsApp — that starts the session.
        </p>
        <p class="pt-alert-meta">
          Expires ${escapeHtml(formatTime(data.arrival.expires_at))}${
            data.arrival.attempts > 0 ? ` · ${data.arrival.attempts} wrong attempt(s) so far` : ''
          }
        </p>
        ${waButton(wa, 'Send the code on WhatsApp')}
      </section>`);
  }

  // ── 2. Unanswered availability check ─────────────────────────────────────
  for (const c of data.availability || []) {
    blocks.push(`
      <section class="pt-alert pt-alert-ask">
        <div class="pt-alert-head">${icon('userCheck')}<span>${
          c.kind === 'standby' ? 'Can you cover this session?' : 'Are you going to this session?'
        }</span></div>
        <p>
          <strong>${escapeHtml(c.case_code)}</strong>${
            c.scheduled_at ? ` · ${escapeHtml(formatDateTime(c.scheduled_at))}` : ''
          }. Reply <strong>YES</strong> or <strong>NO</strong> on WhatsApp, or tap the buttons in that message.
        </p>
        <p class="pt-alert-meta">
          Please answer by ${escapeHtml(formatTime(c.deadline_at))} — after that we ask the standby nurse.
        </p>
        ${waButton(wa, 'Answer on WhatsApp')}
      </section>`);
  }

  // ── 3. Ran past its date and never closed ────────────────────────────────
  if ((data.overdue || []).length) {
    blocks.push(`
      <section class="pt-section">
        <h2 class="pt-h2 pt-h2-warn">${icon('alertTriangle')}Needs closing out</h2>
        <p class="pt-section-note">These sessions are past their scheduled time and still open.</p>
        ${data.overdue.map((c) => sessionCard(c, wa, true)).join('')}
      </section>`);
  }

  // ── 4. Today ─────────────────────────────────────────────────────────────
  blocks.push(`
    <section class="pt-section">
      <h2 class="pt-h2">${icon('calendar')}Today</h2>
      ${
        (data.today || []).length
          ? data.today.map((c) => sessionCard(c, wa, false)).join('')
          : `<div class="pt-empty">${icon('checkCircle')}<p>No visits scheduled for today.</p></div>`
      }
    </section>`);

  // ── 5. Open offers — LOCALITY ONLY, never the address ────────────────────
  if ((data.offers || []).length) {
    blocks.push(`
      <section class="pt-section">
        <h2 class="pt-h2">${icon('inbox')}Case offers waiting on you</h2>
        <p class="pt-section-note">
          Tap Accept or Decline in the WhatsApp offer message. The full address is shared once a case is assigned to you.
        </p>
        ${data.offers.map((o) => `
          <article class="pt-card pt-offer">
            <div class="pt-card-top">
              <span class="pt-code">${escapeHtml(o.case_code)}</span>
              <span class="pt-ago">asked ${escapeHtml(formatRelativeTime(o.sent_at))}</span>
            </div>
            <div class="pt-offer-care">${escapeHtml(o.care_label)} · ${escapeHtml(o.line_label)}</div>
            <dl class="pt-kv">
              <div><dt>When</dt><dd>${escapeHtml(formatDateTime(o.scheduled_at))}</dd></div>
              <div><dt>Area</dt><dd>${escapeHtml(o.area)}</dd></div>
            </dl>
            ${waButton(wa, 'Reply on WhatsApp', true)}
          </article>`).join('')}
      </section>`);
  }

  // ── 6. Rest of the week ──────────────────────────────────────────────────
  if ((data.upcoming || []).length) {
    blocks.push(`
      <section class="pt-section">
        <h2 class="pt-h2">${icon('clock')}Coming up this week</h2>
        ${data.upcoming.map((c) => sessionCard(c, wa, false)).join('')}
      </section>`);
  }

  // ── Standing figures ─────────────────────────────────────────────────────
  const s = data.stats || {};
  const acceptRate = s.offers_total ? Math.round((s.offers_accepted / s.offers_total) * 100) : null;
  // Two <span>s rather than a <br>: the narrow layout puts these on one line,
  // and a hidden <br> collapses the words together ("completedin the last…").
  const stat = (n, a, b = '') =>
    `<div class="pt-stat"><span class="pt-stat-n">${n}</span>` +
    `<span class="pt-stat-l"><span>${a}</span>${b ? ` <span>${b}</span>` : ''}</span></div>`;
  blocks.push(`
    <section class="pt-stats">
      ${stat(s.completed_30d ?? 0, 'sessions completed', 'in the last 30 days')}
      ${stat(s.offers_accepted ?? 0, 'offers accepted', `of ${s.offers_total ?? 0} received`)}
      ${stat(acceptRate === null ? '—' : `${acceptRate}%`, 'acceptance rate')}
    </section>
    ${
      data.nurse?.is_eligible === false
        ? portalNotice(
          'info',
          'You are not in the offer pool right now',
          'New case offers are not being sent to you. The Carcinome team can put you back in the pool whenever you are ready.',
        )
        : ''
    }`);

  content.innerHTML = blocks.join('');
  bindChatCard();
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function sessionCard(c, wa, overdue) {
  const tone = c.next_step?.tone || 'wait';
  return `
    <article class="pt-card pt-session ${overdue ? 'is-overdue' : ''}">
      <div class="pt-card-top">
        <span class="pt-when">${escapeHtml(overdue ? formatDateTime(c.scheduled_at) : formatTime(c.scheduled_at))}</span>
        <span class="pt-chip pt-chip-${escapeHtml(c.status)}">${escapeHtml(STATUS_WORD[c.status] || c.status)}</span>
      </div>
      <h3 class="pt-patient">${escapeHtml(c.patient_name)}</h3>
      <div class="pt-sub">${escapeHtml(c.care_label)} · ${escapeHtml(c.line_label)} · ${escapeHtml(c.case_code)}</div>

      <div class="pt-address">${icon('mapPin')}<span>${escapeHtml(c.address)}</span></div>
      ${c.equipment_notes ? `<div class="pt-equip">${icon('package')}<span>${escapeHtml(c.equipment_notes)}</span></div>` : ''}

      <div class="pt-next pt-next-${escapeHtml(tone)}">
        <span class="pt-next-label">${tone === 'do' ? 'Your move' : tone === 'done' ? 'Done' : 'Waiting'}</span>
        <span>${escapeHtml(c.next_step?.action || '')}</span>
      </div>
      ${tone === 'done' ? '' : waButton(wa, 'Open the case chat', true)}
    </article>`;
}

function waButton(wa, label, ghost = false) {
  if (!wa) return '';
  return `<a class="pt-btn ${ghost ? 'pt-btn-ghost' : 'pt-btn-primary'} pt-btn-wa"
             href="${escapeHtml(wa)}" target="_blank" rel="noopener noreferrer">
            ${icon('message')}<span>${escapeHtml(label)}</span>
          </a>`;
}

function firstName(full) {
  return String(full || 'there').trim().split(/\s+/)[0];
}

function todayLine() {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
