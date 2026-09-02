// ============================================================
// Carcinome Home Care - Cases (board + case cockpit)
//   #cases      → status-grouped board with filters
//   #cases/:id  → detail: stepper, action panel, participants,
//                 documents, summaries, live timeline
// Data reads: direct Supabase (RLS admin). WhatsApp-triggering
// actions: adminAction() only. All timestamps IST.
// ============================================================

import { getSupabase } from '../supabase.js';
import { adminAction, signedDocUrl } from '../utils/api.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { renderTimeline, subscribeTimeline } from '../components/caseTimeline.js';
import { icon } from '../components/icons.js';
import { navigate } from '../router.js';
import {
  formatDateTime, formatRelativeTime, formatINR, maskPhone,
  escapeHtml, caseStatusBadge, caseStatusLabel, careTypeLabel,
  lineTypeLabel, capitalize, invoiceStatusBadge, renderSkeleton,
  CASE_STATUSES,
} from '../utils/formatters.js';

const ROLE_EMOJI = { patient: '🧑', nurse: '🩺', doctor: '🥼', ops: '🛟', supplier: '📦', poc: '🧭' };

const LIVE_STATUSES = ['registered', 'offering', 'assigned', 'consented', 'otp_sent', 'in_care', 'care_done', 'awaiting_payment', 'paid'];
const ASSIGNED_PLUS = ['assigned', 'consented', 'otp_sent', 'in_care'];
const BILLING_STATUSES = ['care_done', 'awaiting_payment'];

// Main lifecycle rail (cancelled renders as a dead terminal step).
const STEPPER_STAGES = [
  ['registered', 'Registered'],
  ['offering', 'Offering'],
  ['assigned', 'Assigned'],
  ['consented', 'Consented'],
  ['otp_sent', 'OTP Sent'],
  ['in_care', 'In Care'],
  ['care_done', 'Care Done'],
  ['awaiting_payment', 'Payment'],
  ['paid', 'Paid'],
  ['archived', 'Archived'],
];

const BOARD_GROUPS = [
  { key: 'needs_nurse', label: 'Needs a nurse', statuses: ['registered', 'offering'] },
  { key: 'assigned', label: 'Assigned & prep', statuses: ['assigned', 'consented', 'otp_sent'] },
  { key: 'in_care', label: 'In care', statuses: ['in_care'] },
  { key: 'billing', label: 'Billing', statuses: ['care_done', 'awaiting_payment'] },
  { key: 'paid', label: 'Paid', statuses: ['paid'] },
  { key: 'closed', label: 'Closed', statuses: ['archived', 'cancelled'] },
];

// ============================================================
// TEST TRIGGERS - fire one real stage action against THIS case
// ============================================================
// Asked for in these words: "also for testing, give trigger buttons, all
// properly templatized". There is no dry-run mode anywhere in this system, so
// every button below sends REAL WhatsApp messages to REAL phones through the
// same admin-action the automatic path uses. That is why each row states its
// audience in plain English BEFORE it fires, and why the log it writes is built
// from the response body rather than from "the request did not throw".
//
// The dishonesty this exists to remove: js/utils/api.js adminAction() throws
// only on a non-2xx, and several of these actions answer HTTP 200 with
// { ok: false }. issue_otp does it every time the code fails to reach the
// patient - the worst failure in the product, because the nurse is then told to
// ask the family for a number nobody received - and the older act() helper
// toasted "Arrival OTP sent to the patient." on exactly that response.
// runTrigger() reads res.ok, so a 200 that did nothing is logged as a failure.
//
// `blocked` mirrors the server's own preconditions (the line numbers are in each
// comment) so a button that cannot work says why instead of spending a round
// trip to be told. The server re-checks every one of them; this is courtesy,
// not security.
const OTP_BLOCKED_STATUSES = ['cancelled', 'archived', 'paid', 'care_done', 'awaiting_payment'];
const AVAIL_STATUSES = ['assigned', 'consented', 'otp_sent'];
const FEEDBACK_STATUSES = ['care_done', 'awaiting_payment', 'paid'];

const who = (person, fallback) => (person?.full_name ? person.full_name : fallback);
const okWord = (v) => (v ? 'delivered to WhatsApp' : 'FAILED');

// Several actions hand back the raw Meta error, which is an OBJECT
// ({ message, code, error_data… }), not a string. Interpolating it prints
// "[object Object]" - a testing surface that says that has told you nothing.
function errText(e) {
  if (e === null || e === undefined || e === '') return 'no reason given';
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

const CASE_TRIGGERS = [
  {
    key: 'consent',
    action: 'send_consent',
    icon: 'shieldCheck',
    label: 'Send the consent form',
    audience: (d) =>
      `The patient ${who(d.kase.patient, 'on this case')} and nobody else. It goes as the in-chat consent form if her 24-hour window is open, or as the consent_flow_invite template if it is closed. The POC participant row is created or refreshed first, so the signed answer has somewhere to mirror to.`,
    blocked: (d) => (d.kase.patient ? null : 'This case has no patient row, so there is nobody to send it to.'),
    detail: (res) => [res.via === 'template'
      ? 'Carrier: consent_flow_invite template (her 24-hour window was closed)'
      : 'Carrier: in-chat consent flow'],
  },
  {
    key: 'otp',
    action: 'issue_otp',
    icon: 'key',
    label: 'Issue the arrival code',
    audience: (d) =>
      `TWO people. The patient ${who(d.kase.patient, 'on this case')} gets a fresh 6-digit arrival code, and the nurse ${who(d.kase.nurse, 'assigned')} is told to ask the family for it at the door. Any previous code for this case stops working. If the patient's copy fails, the ops number is paged too.`,
    // admin-actions/index.ts:1023-1027
    blocked: (d) => {
      if (OTP_BLOCKED_STATUSES.includes(d.kase.status))
        return `The server refuses this while the case is "${caseStatusLabel(d.kase.status)}".`;
      if (!d.kase.assigned_nurse_id) return 'No nurse is assigned. The code is a two-sided check and the nurse has to receive her half.';
      return null;
    },
    detail: (res) => {
      const rows = [
        `Patient copy: ${okWord(res.patient_send_ok)}${res.patient_via ? ` (${res.patient_via})` : ''}`,
        `Nurse copy: ${okWord(res.nurse_send_ok)}`,
      ];
      if (res.expires_at) rows.push(`Code expires ${formatDateTime(res.expires_at)} IST`);
      if (res.patient_send_error) rows.push(`WhatsApp said: ${errText(res.patient_send_error)}`);
      return rows;
    },
  },
  {
    key: 'avail',
    action: 'check_availability',
    icon: 'userCheck',
    label: 'Ask the nurse if she is going',
    audience: (d) =>
      `The assigned nurse ${who(d.kase.nurse, 'on this case')} only, with Yes and No buttons. A No, or silence past the reply window in Settings, hands the case to a standby nurse automatically without anyone tapping anything. A check that is already pending is re-sent with a fresh deadline instead of stacking a second question.`,
    // _shared/availability.ts:341-346
    blocked: (d) => {
      if (!d.kase.assigned_nurse_id) return 'No nurse is assigned, so there is nobody to ask.';
      if (d.kase.arrival_verified_at) return 'She has already verified her arrival, so the question is settled.';
      if (!AVAIL_STATUSES.includes(d.kase.status))
        return `The server refuses this while the case is "${caseStatusLabel(d.kase.status)}".`;
      return null;
    },
    detail: (res) => [res.resent
      ? 'A pending check was re-sent with a fresh deadline'
      : 'A new check was opened'],
  },
  {
    key: 'report',
    action: null,
    icon: 'fileText',
    label: 'Send the completion report form',
    audience: () =>
      'The assigned nurse would get the completion_v1 form. There is NO admin action for it and this button cannot fire one.',
    // Honest dead end rather than a missing row. sendCompletionFlow lives in
    // wa-webhook/handlers/_common.ts:798 and every call site is inbound
    // (buttons.ts:773, intent.ts:514 and :592, text.ts:1124), so the dashboard
    // has no way in. Saying so here is worth more than pretending the stage
    // does not exist: it tells the tester how to trigger it for real.
    blocked: () =>
      'Only the webhook can send this form. The nurse gets it when she taps the care-complete button, messages DONE, or the patient confirms the session ended - and only while the case is In Care. To test it, have the nurse send DONE on WhatsApp.',
    detail: () => [],
  },
  {
    key: 'docs',
    action: 'regenerate_docs',
    icon: 'refresh',
    label: 'Regenerate the documents',
    audience: () =>
      'NOBODY receives a message. This rebuilds the invoice and discharge PDFs on the server and uploads fresh WhatsApp media ids for them (media ids expire, which is why a resend regenerates first). Safe to run at any time.',
    blocked: () => null,
    detail: (res) => [
      `Invoice PDF: ${res.invoice?.ok ? 'rebuilt' : `FAILED, ${errText(res.invoice?.error)}`}`,
      `Discharge PDF: ${res.discharge?.ok ? 'rebuilt' : `FAILED, ${errText(res.discharge?.error)}`}`,
    ],
  },
  {
    key: 'invoice',
    action: 'resend_invoice',
    icon: 'receipt',
    label: 'Resend the invoice',
    audience: (d) =>
      `The patient ${who(d.kase.patient, 'on this case')} only: the invoice PDF as a WhatsApp document, and if her 24-hour window is open, the UPI Review-and-Pay card and the "I have paid" button as well. The PDF is regenerated first, so an edited amount goes out correctly.`,
    // admin-actions/index.ts:1220-1222
    blocked: (d) => {
      if (!d.invoice) return 'No invoice exists for this case yet. Regenerate the documents first.';
      if (d.invoice.status === 'void') return 'This invoice is void and the server will not send it.';
      return null;
    },
    detail: (res) => [
      `Invoice ${res.invoice_no ?? '(number not returned)'}`,
      res.order_details
        ? 'UPI Review-and-Pay card sent as well'
        : 'No UPI card: her 24-hour window was closed, so only the PDF went',
    ],
  },
  {
    key: 'feedback',
    action: 'send_feedback_invite',
    icon: 'star',
    label: 'Send the feedback form',
    audience: (d) =>
      `The patient ${who(d.kase.patient, 'on this case')} only, as the feedback_invite template with the rating form attached.`,
    // admin-actions/index.ts:1644-1649
    blocked: (d) => {
      if (!FEEDBACK_STATUSES.includes(d.kase.status))
        return `Feedback only applies after care is complete. This case is "${caseStatusLabel(d.kase.status)}".`;
      if (d.feedback) return 'This family has already sent their feedback, and the server will not ask twice.';
      return null;
    },
    detail: () => [],
  },
  {
    key: 'poc',
    action: 'sync_poc',
    icon: 'users',
    label: 'Rebuild the POC participant row',
    audience: () =>
      "NOBODY receives a message. It rewrites this case's POC participant row from the POC number on the patient, so the mirrored milestone messages have somewhere to land. Run it after editing the POC on the patient, or when the POC is getting nothing.",
    blocked: (d) => (d.kase.status === 'archived'
      ? 'Archiving deactivates every participant on purpose, and this will not resurrect one.'
      : null),
    detail: (res) => [
      `Cases touched: ${res.synced ?? 0}`,
      res.changed ? `Rows changed: ${res.changed}` : 'Nothing needed changing, the row was already correct',
    ],
  },
];

// ---- page-scoped styles (injected once) ----
function injectStyles() {
  if (document.getElementById('cases-page-style')) return;
  const style = document.createElement('style');
  style.id = 'cases-page-style';
  style.textContent = `
    /* board */
    .cs-toolbar { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin-bottom: var(--s5); }
    .cs-toolbar .table-search { flex: 1 1 240px; max-width: 380px; }
    .cs-toolbar .form-select { width: auto; min-width: 170px; }
    .cs-board { display: grid; grid-template-columns: repeat(auto-fill, minmax(295px, 1fr)); gap: var(--s4); align-items: start; }
    .cs-board > * { min-width: 0; }
    .cs-col { background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-lg); padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
    .cs-col-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); padding: 4px 6px 8px; }
    .cs-col-head .t { font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); }
    .cs-col-head .n { font: 700 12px var(--font-mono); background: var(--surface); border: 1px solid var(--line); color: var(--ink-2); min-width: 22px; height: 22px; padding: 0 6px; border-radius: var(--r-pill); display: inline-grid; place-items: center; }
    .cs-col-empty { font: var(--t-xs); color: var(--ink-4); text-align: center; padding: var(--s4) 0 var(--s3); }
    .cs-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px; cursor: pointer; box-shadow: var(--hi), var(--sh-1); transition: transform var(--base) var(--ease), box-shadow var(--base) var(--ease), border-color var(--base) var(--ease); }
    .cs-card:hover { transform: translateY(-2px); box-shadow: var(--hi), var(--sh-2); border-color: var(--line-2); }
    .cs-card:focus-visible { outline: none; box-shadow: var(--ring); }
    .cs-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s2); }
    .cs-code { font: var(--t-mono); font-size: 11px; color: var(--ink-3); letter-spacing: 0.02em; }
    .cs-name { font: var(--t-body-strong); font-size: 14.5px; color: var(--ink); margin-top: 2px; overflow-wrap: anywhere; }
    .cs-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font: var(--t-xs); color: var(--ink-3); }
    .cs-meta span { display: inline-flex; align-items: center; gap: 5px; }
    .cs-meta svg { width: 12px; height: 12px; flex: none; }
    .cs-meta .unassigned { color: var(--warn); font-weight: 600; }
    .cs-yes { display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; font: var(--t-xs); font-weight: 700; color: var(--ok); background: var(--ok-soft); border-radius: var(--r-pill); padding: 2px 9px; }
    /* detail */
    .cs-detail-meta { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 6px; font: var(--t-mono); font-size: 11.5px; color: var(--ink-3); }
    .cs-detail-meta a { color: var(--primary); text-decoration: none; font-weight: 600; }
    .cs-detail-meta a:hover { text-decoration: underline; }
    .cs-back { display: inline-flex; align-items: center; gap: 6px; font: var(--t-sm); font-weight: 600; color: var(--ink-3); text-decoration: none; margin-bottom: var(--s3); }
    .cs-back:hover { color: var(--primary); }
    .cs-back svg { width: 15px; height: 15px; }
    .cs-section-title { display: flex; align-items: center; gap: 8px; font: 700 15px/1.25 var(--font-display); letter-spacing: -0.015em; color: var(--ink); }
    .cs-section-title svg { width: 16px; height: 16px; color: var(--primary); }
    /* offers */
    .cs-offer-row { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--line); }
    .cs-offer-row:last-child { border-bottom: none; }
    .cs-offer-row.rank1 { background: linear-gradient(90deg, var(--ok-soft), transparent 70%); border-radius: var(--r-sm); padding-left: 10px; margin-left: -10px; }
    .cs-rank { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font: 700 12.5px var(--font-mono); background: var(--bg-sunken); color: var(--ink-2); border: 1px solid var(--line-strong); }
    .cs-offer-row.rank1 .cs-rank { background: var(--grad-ok, var(--ok)); background-color: var(--ok); color: #fff; border-color: transparent; }
    .cs-offer-who { flex: 1; min-width: 0; }
    .cs-offer-who .n { font: var(--t-body-strong); font-size: 14px; overflow-wrap: anywhere; }
    .cs-offer-who .m { font: var(--t-mono); font-size: 10.5px; color: var(--ink-3); margin-top: 1px; }
    .cs-offer-counts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: var(--s3); }
    .cs-assign-row { display: flex; gap: var(--s2); align-items: center; margin-top: var(--s3); flex-wrap: wrap; }
    .cs-assign-row .form-select { flex: 1 1 200px; min-width: 0; }
    /* action buttons */
    .cs-actions-grid { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); }
    /* participants */
    .cs-part-row { display: flex; align-items: center; gap: 11px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .cs-part-row:last-child { border-bottom: none; }
    .cs-part-emoji { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-size: 16px; background: var(--bg-sunken); border: 1px solid var(--line); }
    .cs-part-who { flex: 1; min-width: 0; }
    .cs-part-who .n { font: var(--t-body-strong); font-size: 13.5px; overflow-wrap: anywhere; }
    .cs-part-who .m { font: var(--t-mono); font-size: 10.5px; color: var(--ink-3); margin-top: 1px; }
    .cs-part-row.inactive { opacity: 0.55; }
    /* documents */
    .cs-doc-row { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; padding: 11px 12px; margin-top: var(--s2); background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-md); cursor: pointer; font: var(--t-sm); color: var(--ink); transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease); }
    .cs-doc-row:hover { border-color: var(--primary); background: var(--surface); }
    .cs-doc-row svg { width: 17px; height: 17px; color: var(--primary); flex: none; }
    .cs-doc-row .grow { flex: 1; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
    .cs-doc-row .ext { color: var(--ink-4); }
    /* invoice */
    .cs-inv-table th, .cs-inv-table td { padding: 9px 10px; }
    .cs-inv-total td { font-weight: 700; border-top: 2px solid var(--line-2); }
    .cs-inv-meta { display: flex; gap: 6px 14px; flex-wrap: wrap; margin-top: var(--s3); font: var(--t-mono); font-size: 11px; color: var(--ink-3); }
    /* summaries */
    .cs-sum { padding: var(--s3) 0; border-bottom: 1px solid var(--line); }
    .cs-sum:last-child { border-bottom: none; padding-bottom: 0; }
    .cs-sum .h { display: flex; align-items: center; gap: 7px; font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-3); margin-bottom: 7px; }
    .cs-sum .stars { color: var(--warn); letter-spacing: 2px; }
    /* ops composer */
    .cs-ops-box { display: flex; flex-direction: column; gap: var(--s2); margin-top: var(--s3); }
    .cs-ops-box .row { display: flex; justify-content: flex-end; }
    /* test triggers: the audience line is the point of the row, so it gets the
       readable width and the button is pushed to its own line under it */
    .cs-trig { padding: 12px 0; border-bottom: 1px solid var(--line); }
    .cs-trig:last-of-type { border-bottom: none; padding-bottom: 0; }
    .cs-trig-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .cs-trig-top .lbl { font: var(--t-body-strong); font-size: 13.5px; color: var(--ink); }
    .cs-trig-top svg { width: 15px; height: 15px; color: var(--primary); flex: none; }
    .cs-trig-who { font: var(--t-xs); color: var(--ink-2); line-height: 1.5; margin: 5px 0 0; overflow-wrap: anywhere; }
    .cs-trig-blocked { font: var(--t-xs); color: var(--warn); line-height: 1.5; margin: 6px 0 0; }
    .cs-trig-act { margin-top: 8px; }
    .cs-trig-log { margin-top: var(--s4); padding-top: var(--s4); border-top: 1px solid var(--line); }
    .cs-trig-entry { display: flex; gap: 9px; padding: 8px 0; border-bottom: 1px dashed var(--line); }
    .cs-trig-entry:last-child { border-bottom: none; padding-bottom: 0; }
    .cs-trig-entry .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; }
    .cs-trig-entry.ok .dot { background: var(--ok); }
    .cs-trig-entry.bad .dot { background: var(--danger); }
    .cs-trig-entry .body { min-width: 0; flex: 1; }
    .cs-trig-entry .hl { font: var(--t-sm); color: var(--ink); overflow-wrap: anywhere; }
    .cs-trig-entry.bad .hl { color: var(--danger); font-weight: 650; }
    .cs-trig-entry .meta { font: var(--t-mono); font-size: 10.5px; color: var(--ink-3); margin-bottom: 2px; }
    .cs-trig-entry .facts { margin: 4px 0 0; padding-left: 15px; font: var(--t-xs); color: var(--ink-2); line-height: 1.55; }
    .cs-trig-entry .facts li { overflow-wrap: anywhere; }
    /* invoice editor modal */
    .cs-li-row { display: grid; grid-template-columns: minmax(0, 1fr) 120px 36px; gap: var(--s2); align-items: center; margin-bottom: var(--s2); }
    .cs-li-foot { display: grid; grid-template-columns: 1fr 120px; gap: var(--s2); align-items: center; margin-top: var(--s3); padding-top: var(--s3); border-top: 1px solid var(--line); }
    .cs-li-foot .lbl { text-align: right; font: var(--t-sm); color: var(--ink-2); font-weight: 600; padding-right: 4px; }
    .cs-li-total { font: 700 16px var(--font-display); text-align: right; }
    @media (max-width: 640px) {
      .cs-board { grid-template-columns: 1fr; }
      .cs-assign-row .btn { flex: 1; }
    }
  `;
  document.head.appendChild(style);
}

// ============================================================
// Page-leave cleanup (timeline realtime channels etc.)
// ============================================================
let detailCleanups = [];
let hashWatcherBound = false;

function runDetailCleanup() {
  const fns = detailCleanups;
  detailCleanups = [];
  for (const fn of fns) {
    try { fn(); } catch (e) { console.warn('[cases] cleanup failed:', e); }
  }
}

function bindHashWatcher() {
  if (hashWatcherBound) return;
  hashWatcherBound = true;
  window.addEventListener('hashchange', () => {
    if (!window.location.hash.startsWith('#cases')) runDetailCleanup();
  });
}

// ============================================================
// Entry
// ============================================================
export default async function render(container, params = {}) {
  injectStyles();
  bindHashWatcher();
  runDetailCleanup(); // leaving a previous detail view within #cases

  if (params.id) {
    await renderDetail(container, String(params.id).split('/')[0]);
  } else {
    await renderBoard(container);
  }
}

// ============================================================
// LIST VIEW - status-grouped board
// ============================================================
async function renderBoard(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Cases</h1>
        <p style="font:var(--t-sm);color:var(--ink-3);margin-top:4px">Every home-care case, grouped by where it is in the loop.</p>
      </div>
      <button class="btn btn-secondary btn-sm" id="cs-refresh-board">${icon('refresh')} Refresh</button>
    </div>
    <div class="cs-toolbar">
      <div class="table-search">
        ${icon('search')}
        <input class="form-input" id="cs-search" type="search" placeholder="Search patient or case code…" autocomplete="off" />
      </div>
      <select class="form-select" id="cs-status-filter" aria-label="Filter by status">
        <option value="">All statuses</option>
        ${CASE_STATUSES.map(s => `<option value="${s}">${escapeHtml(caseStatusLabel(s))}</option>`).join('')}
      </select>
    </div>
    <div id="cs-board-area">${renderSkeleton(6)}</div>
  `;

  const boardArea = container.querySelector('#cs-board-area');
  let allCases = [];

  async function fetchCases() {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('cases')
      .select('id, case_code, status, care_type, line_type, scheduled_at, assigned_nurse_id, created_at, patient:patients(full_name, patient_code), nurse:nurses(full_name), offers:case_offers(response)')
      .order('scheduled_at', { ascending: true })
      .limit(500);
    if (error) throw error;
    return data || [];
  }

  function currentFilters() {
    return {
      q: (container.querySelector('#cs-search')?.value || '').trim().toLowerCase(),
      status: container.querySelector('#cs-status-filter')?.value || '',
    };
  }

  function cardHtml(c) {
    const yesCount = (c.offers || []).filter(o => o.response === 'yes').length;
    const nurseHtml = c.nurse?.full_name
      ? `<span>${icon('stethoscope')}${escapeHtml(c.nurse.full_name)}</span>`
      : `<span class="unassigned">${icon('alertCircle')}Unassigned</span>`;
    return `
      <div class="cs-card" role="link" tabindex="0" data-case-id="${escapeHtml(c.id)}" aria-label="Open case ${escapeHtml(c.case_code)}">
        <div class="cs-card-top">
          <div style="min-width:0">
            <div class="cs-code">${escapeHtml(c.case_code)}</div>
            <div class="cs-name">${escapeHtml(c.patient?.full_name || 'Unknown patient')}</div>
          </div>
          ${caseStatusBadge(c.status)}
        </div>
        <div class="cs-meta">
          <span>${icon('droplet')}${escapeHtml(careTypeLabel(c.care_type))}</span>
          <span>${icon('calendar')}${escapeHtml(formatDateTime(c.scheduled_at))}</span>
          ${nurseHtml}
        </div>
        ${(c.status === 'offering' || c.status === 'registered')
          ? `<div class="cs-yes">${icon('userCheck')}${yesCount} nurse${yesCount === 1 ? '' : 's'} said Yes</div>`
          : ''}
      </div>`;
  }

  function paintBoard() {
    const { q, status } = currentFilters();
    let rows = allCases;
    if (status) rows = rows.filter(c => c.status === status);
    if (q) {
      rows = rows.filter(c =>
        (c.patient?.full_name || '').toLowerCase().includes(q) ||
        (c.case_code || '').toLowerCase().includes(q) ||
        (c.patient?.patient_code || '').toLowerCase().includes(q));
    }

    if (!allCases.length) {
      boardArea.innerHTML = `
        <div class="empty-state">
          ${icon('clipboard')}
          <h3>No cases yet</h3>
          <p>Register a patient to open the first home-care case. Everything - offers, consent, OTP, invoice - will run from this board.</p>
          <button class="btn btn-primary" id="cs-goto-patients">${icon('userPlus')} Go to Patients</button>
        </div>`;
      boardArea.querySelector('#cs-goto-patients')?.addEventListener('click', () => navigate('patients'));
      return;
    }

    if (!rows.length) {
      boardArea.innerHTML = `
        <div class="empty-state">
          ${icon('search')}
          <h3>No matching cases</h3>
          <p>No case matches your current search or status filter. Try clearing the filters.</p>
        </div>`;
      return;
    }

    const groups = BOARD_GROUPS
      .filter(g => !status || g.statuses.includes(status))
      .map(g => ({ ...g, rows: rows.filter(c => g.statuses.includes(c.status)) }));

    boardArea.innerHTML = `
      <div class="cs-board">
        ${groups.map(g => `
          <div class="cs-col">
            <div class="cs-col-head"><span class="t">${escapeHtml(g.label)}</span><span class="n">${g.rows.length}</span></div>
            ${g.rows.length ? g.rows.map(cardHtml).join('') : '<div class="cs-col-empty">No cases here</div>'}
          </div>`).join('')}
      </div>`;
  }

  // one delegated click/keyboard handler for the whole board
  boardArea.addEventListener('click', (e) => {
    const card = e.target.closest('[data-case-id]');
    if (card) navigate(`cases/${card.dataset.caseId}`);
  });
  boardArea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-case-id]');
    if (card) { e.preventDefault(); navigate(`cases/${card.dataset.caseId}`); }
  });

  container.querySelector('#cs-search').addEventListener('input', paintBoard);
  container.querySelector('#cs-status-filter').addEventListener('change', paintBoard);

  async function load(btn) {
    if (btn) { btn.disabled = true; }
    try {
      allCases = await fetchCases();
      paintBoard();
    } catch (e) {
      console.error('[cases] board load failed:', e);
      boardArea.innerHTML = `
        <div class="empty-state">
          ${icon('alertTriangle')}
          <h3>Could not load cases</h3>
          <p>${escapeHtml(e.message || 'Unknown error')}</p>
          <button class="btn btn-secondary" id="cs-retry">Try again</button>
        </div>`;
      boardArea.querySelector('#cs-retry')?.addEventListener('click', () => load());
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  container.querySelector('#cs-refresh-board').addEventListener('click', (e) => load(e.currentTarget));
  await load();
}

// ============================================================
// DETAIL VIEW - the cockpit
// ============================================================
async function fetchDetail(id) {
  const sb = getSupabase();
  const [caseRes, offersRes, partsRes, invRes, consentRes, complRes, fbRes, nursesRes, availRes] = await Promise.all([
    sb.from('cases').select('*, patient:patients(id, full_name, patient_code, wa_number, cancer_type, address, language_pref), doctor:doctors(id, full_name, phone), supplier:suppliers(id, name, phone), nurse:nurses(id, full_name, phone)').eq('id', id).maybeSingle(),
    sb.from('case_offers').select('*, nurse:nurses(id, full_name, phone)').eq('case_id', id).order('response_rank', { ascending: true, nullsFirst: false }),
    sb.from('case_participants').select('*').eq('case_id', id).order('created_at', { ascending: true }),
    sb.from('invoices').select('*').eq('case_id', id).maybeSingle(),
    sb.from('consents').select('*').eq('case_id', id).maybeSingle(),
    sb.from('completion_reports').select('*').eq('case_id', id).maybeSingle(),
    sb.from('feedback').select('*').eq('case_id', id).maybeSingle(),
    sb.from('nurses').select('id, full_name, phone').eq('is_eligible', true).eq('is_active', true).order('full_name'),
    sb.from('availability_checks').select('*, nurse:nurses(id, full_name)').eq('case_id', id).order('sent_at', { ascending: false }).limit(6),
  ]);
  if (caseRes.error) throw caseRes.error;
  if (!caseRes.data) throw new Error('Case not found - it may have been removed.');
  // Non-fatal secondary errors: log and continue with what we have.
  for (const [label, res] of [['offers', offersRes], ['participants', partsRes], ['invoice', invRes], ['consent', consentRes], ['completion', complRes], ['feedback', fbRes], ['nurses', nursesRes], ['availability', availRes]]) {
    if (res.error) console.warn(`[cases] ${label} fetch failed:`, res.error);
  }
  return {
    kase: caseRes.data,
    offers: offersRes.data || [],
    participants: partsRes.data || [],
    invoice: invRes.data || null,
    consent: consentRes.data || null,
    completion: complRes.data || null,
    feedback: fbRes.data || null,
    eligibleNurses: nursesRes.data || [],
    availability: availRes.data || [],
  };
}

async function renderDetail(container, id) {
  container.innerHTML = `
    <a class="cs-back" href="#cases">${icon('arrowLeft')} All cases</a>
    <div id="cs-detail-body">${renderSkeleton(6)}</div>
  `;
  const body = container.querySelector('#cs-detail-body');

  let d;
  try {
    d = await fetchDetail(id);
  } catch (e) {
    console.error('[cases] detail load failed:', e);
    body.innerHTML = `
      <div class="empty-state">
        ${icon('alertTriangle')}
        <h3>Could not open this case</h3>
        <p>${escapeHtml(e.message || 'Unknown error')}</p>
        <button class="btn btn-secondary" onclick="location.hash='cases'">Back to cases</button>
      </div>`;
    return;
  }

  // ---- persistent skeleton: head + stepper re-render, timeline mounts once ----
  body.innerHTML = `
    <div id="cs-head"></div>
    <div class="card" style="margin-bottom:var(--s5);padding:var(--s4) var(--s5)" id="cs-stepper"></div>
    <div class="case-grid">
      <div class="stack" style="gap:var(--s5)" id="cs-left"></div>
      <div class="stack" style="gap:var(--s5)" id="cs-right">
        <div class="card card-flush">
          <div class="card-head">
            <span class="cs-section-title">${icon('message')} Case timeline</span>
            <span class="live-dot">Live</span>
          </div>
          <div style="padding:var(--s3)" id="cs-timeline"></div>
        </div>
      </div>
    </div>
  `;

  const headEl = body.querySelector('#cs-head');
  const stepperEl = body.querySelector('#cs-stepper');
  const leftEl = body.querySelector('#cs-left');

  let refreshing = false;
  async function refresh() {
    if (refreshing || !leftEl.isConnected) return;
    refreshing = true;
    try {
      d = await fetchDetail(id);
      paint();
    } catch (e) {
      console.error('[cases] refresh failed:', e);
      showToast('Could not refresh the case: ' + (e.message || 'unknown error'), 'error');
    } finally {
      refreshing = false;
    }
  }

  // Newest-first record of the triggers fired from this tab. It lives here and
  // not in the DOM because paint() replaces leftEl wholesale on every refresh,
  // and refresh() runs after every trigger - a log kept in the markup would
  // erase itself the moment it had something to say.
  const triggerLog = [];

  function paint() {
    if (!leftEl.isConnected) return;
    headEl.innerHTML = headHtml(d);
    stepperEl.innerHTML = stepperHtml(d.kase.status);
    leftEl.innerHTML = [
      actionPanelHtml(d),
      opsPanelHtml(d),
      triggersPanelHtml(d, triggerLog),
      participantsHtml(d),
      documentsHtml(d),
      summariesHtml(d),
    ].filter(Boolean).join('');
  }

  paint();

  // ---- live timeline (mounted once; own realtime channel) ----
  const timelineCleanup = await renderTimeline(body.querySelector('#cs-timeline'), id);
  detailCleanups.push(timelineCleanup);

  // ---- second lightweight subscription: refresh the action panel on new
  // case_events (status moves, offer responses, payments all log events) ----
  let refreshTimer = null;
  const sub = subscribeTimeline(id, (_row, table) => {
    if (table !== 'case_events') return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(), 600);
  });
  detailCleanups.push(() => { clearTimeout(refreshTimer); sub.unsubscribe(); });

  // ============================================================
  // one delegated handler for every action in head + left column
  // ============================================================
  async function busy(btn, fn) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      await fn();
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = orig; }
    }
  }

  async function act(btn, action, params, successMsg) {
    await busy(btn, async () => {
      try {
        await adminAction(action, params);
        showToast(successMsg, 'success');
        await refresh();
      } catch (e) {
        showToast(e.message || 'Action failed', 'error');
      }
    });
  }

  // One trigger, start to finish: confirm once, fire, log the truth, repaint.
  // Deliberately NOT act(): act() shows a success toast whenever adminAction
  // does not throw, which is precisely the lie this panel exists to remove.
  async function runTrigger(btn, spec) {
    await busy(btn, async () => {
      let res = null;
      let err = null;
      try {
        res = await adminAction(spec.action, { case_id: d.kase.id });
      } catch (e) {
        err = e;
      }
      const out = triggerOutcome(spec, res, err);
      triggerLog.unshift({
        at: new Date().toLocaleTimeString('en-IN', { hour12: false }),
        label: spec.label,
        ok: out.ok,
        headline: out.headline,
        facts: out.facts,
      });
      // Keep the panel readable during a long test run; the console keeps everything.
      if (triggerLog.length > 12) triggerLog.length = 12;
      console.log('[cases] trigger', spec.action, { ok: out.ok, response: res, error: err });
      showToast(out.ok ? out.headline : `${spec.label} failed: ${out.headline}`, out.ok ? 'success' : 'error', out.ok ? 4000 : 9000);
      // paint() FIRST, then refresh(). refresh() early-returns while another
      // refresh is in flight - and one usually is, because the action just wrote
      // case_events and the realtime subscription schedules its own - so relying
      // on it alone would sometimes drop the outcome the tester is waiting for.
      // paint() reads the log by closure, so this shows it immediately and the
      // refresh that follows re-renders it with fresh case data.
      paint();
      await refresh();
    });
  }

  function nurseName(nurseId) {
    const n = d.eligibleNurses.find(x => x.id === nurseId)
      || d.offers.map(o => o.nurse).find(x => x && x.id === nurseId);
    return n ? n.full_name : 'this nurse';
  }

  async function onAction(btn) {
    const action = btn.dataset.action;
    const caseId = d.kase.id;

    switch (action) {
      case 'refresh':
        await busy(btn, refresh);
        break;

      case 'assign': { // from ranked Accept list (primary path - no confirm)
        const nurseId = btn.dataset.nurse;
        if (!nurseId) return;
        await act(btn, 'assign_nurse', { case_id: caseId, nurse_id: nurseId },
          `${nurseName(nurseId)} assigned - confirmations are going out on WhatsApp.`);
        break;
      }

      case 'assign-override': { // manual override dropdown
        const sel = leftEl.querySelector('#cs-override-nurse');
        const nurseId = sel?.value;
        if (!nurseId) { showToast('Pick a nurse to assign first', 'warning'); return; }
        confirmModal(
          `Assign <strong>${escapeHtml(nurseName(nurseId))}</strong> to this case manually? This overrides the ranked Accept order and notifies everyone on WhatsApp.`,
          () => act(btn, 'assign_nurse', { case_id: caseId, nurse_id: nurseId }, `${nurseName(nurseId)} assigned.`),
          { title: 'Manual assignment', confirmLabel: 'Assign nurse', danger: false },
        );
        break;
      }

      case 'reassign': {
        const sel = leftEl.querySelector('#cs-reassign-nurse');
        const nurseId = sel?.value;
        if (!nurseId) { showToast('Pick the new nurse first', 'warning'); return; }
        confirmModal(
          `Reassign this case from <strong>${escapeHtml(d.kase.nurse?.full_name || 'the current nurse')}</strong> to <strong>${escapeHtml(nurseName(nurseId))}</strong>? Both nurses and the patient will be notified on WhatsApp.`,
          () => act(btn, 'reassign_nurse', { case_id: caseId, nurse_id: nurseId }, `Case reassigned to ${nurseName(nurseId)}.`),
          { title: 'Reassign nurse', confirmLabel: 'Reassign' },
        );
        break;
      }

      case 'send-consent':
        await act(btn, 'send_consent', { case_id: caseId }, 'Consent form sent to the patient on WhatsApp.');
        break;

      case 'check-availability':
        await act(btn, 'check_availability', { case_id: caseId },
          'Availability check sent. The nurse gets Yes/No buttons; No or silence triggers the standby.');
        break;

      case 'issue-otp':
        await act(btn, 'issue_otp', { case_id: caseId }, 'Arrival OTP sent to the patient.');
        break;

      case 'regenerate-docs':
        await act(btn, 'regenerate_docs', { case_id: caseId }, 'Invoice + discharge summary are being regenerated.');
        break;

      case 'resend-invoice':
        await act(btn, 'resend_invoice', { case_id: caseId }, 'Invoice re-sent to the patient.');
        break;

      case 'send-feedback':
        await act(btn, 'send_feedback_invite', { case_id: caseId }, 'Feedback form sent to the patient on WhatsApp.');
        break;

      case 'mark-paid': {
        const total = d.invoice ? formatINR(d.invoice.total_inr) : formatINR(d.kase.price_inr);
        confirmModal(
          `Confirm that <strong>${total}</strong> has actually landed in the bank / UPI account for invoice <strong>${escapeHtml(d.invoice?.invoice_no || '')}</strong>? This fires the payment-received message to the patient, doctor and team.`,
          () => act(btn, 'mark_paid_verified', { case_id: caseId }, 'Payment verified - receipts are going out.'),
          { title: 'Verify payment', confirmLabel: 'Yes, payment received', danger: false },
        );
        break;
      }

      case 'trigger': {
        const spec = CASE_TRIGGERS.find((t) => t.key === btn.dataset.trigger);
        if (!spec || !spec.action) return;
        // Re-check the precondition at tap time: the panel may have been painted
        // before a realtime event moved the status underneath it.
        const stop = spec.blocked(d);
        if (stop) { showToast(stop, 'warning', 8000); await refresh(); return; }
        confirmModal(
          `<strong>${escapeHtml(spec.label)}</strong> on ${escapeHtml(d.kase.case_code)}.<br/><br/>${escapeHtml(spec.audience(d))}<br/><br/>This is a real send. Go ahead?`,
          () => runTrigger(btn, spec),
          { title: 'Fire this trigger', confirmLabel: 'Yes, fire it', danger: false },
        );
        break;
      }

      case 'edit-invoice':
        openInvoiceEditor(d, refresh);
        break;

      case 'send-ops': {
        const ta = leftEl.querySelector('#cs-ops-text');
        const text = (ta?.value || '').trim();
        if (!text) { showToast('Type a message first', 'warning'); return; }
        await busy(btn, async () => {
          try {
            await adminAction('send_manual_message', { case_id: caseId, text });
            showToast('Sent as Ops - it will appear in the timeline.', 'success');
            const ta2 = leftEl.querySelector('#cs-ops-text');
            if (ta2) ta2.value = '';
          } catch (e) {
            showToast(e.message || 'Send failed', 'error');
          }
        });
        break;
      }

      case 'cancel-case':
        openCancelModal(d, refresh);
        break;

      case 'archive-case':
        confirmModal(
          `Archive case <strong>${escapeHtml(d.kase.case_code)}</strong>? It moves off the active board (the full timeline is kept).`,
          () => act(btn, 'archive_case', { case_id: caseId }, 'Case archived.'),
          { title: 'Archive case', confirmLabel: 'Archive', danger: false },
        );
        break;

      case 'open-doc': {
        const path = btn.dataset.path;
        if (!path) return;
        // open a blank tab synchronously so the popup blocker allows it
        const win = window.open('', '_blank');
        await busy(btn, async () => {
          try {
            const url = await signedDocUrl(path, 600);
            if (win) win.location.href = url;
            else window.open(url, '_blank');
          } catch (e) {
            if (win) win.close();
            const missing = /not.*found|does not exist|404/i.test(e.message || '');
            showToast(missing ? 'That document has not been generated yet.' : (e.message || 'Could not open document'), missing ? 'warning' : 'error');
          }
        });
        break;
      }

      default:
        console.warn('[cases] unknown action:', action);
    }
  }

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    onAction(btn).catch(err => {
      console.error('[cases] action failed:', err);
      showToast(err.message || 'Something went wrong', 'error');
    });
  });
}

// ============================================================
// Detail - HTML builders (pure, re-render safe)
// ============================================================
function headHtml(d) {
  const c = d.kase;
  return `
    <div class="detail-head">
      <div class="detail-id">
        <div class="detail-name" style="min-width:0">
          <h1>${escapeHtml(c.case_code)}</h1>
          <div class="cs-detail-meta">
            ${caseStatusBadge(c.status)}
            <a href="#patients/${escapeHtml(c.patient?.id || '')}">${icon('user')} ${escapeHtml(c.patient?.full_name || 'Unknown patient')}</a>
            <span>${escapeHtml(careTypeLabel(c.care_type))} · ${escapeHtml(lineTypeLabel(c.line_type))}</span>
            <span>${icon('calendar')} ${escapeHtml(formatDateTime(c.scheduled_at))} IST</span>
            ${c.price_inr != null ? `<span>${escapeHtml(formatINR(c.price_inr))}</span>` : ''}
            ${c.next_chemo_at ? `<span style="color:var(--primary);font-weight:700">📅 Next chemo: ${escapeHtml(formatDateTime(c.next_chemo_at))}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn btn-secondary btn-sm" data-action="refresh">${icon('refresh')} Refresh</button>
      </div>
    </div>`;
}

function stepperHtml(status) {
  const idx = STEPPER_STAGES.findIndex(([s]) => s === status);
  const cancelled = status === 'cancelled';
  return `
    <div class="case-stepper">
      ${STEPPER_STAGES.map(([s, label], i) => {
        const cls = cancelled ? '' : (i < idx ? 'done' : i === idx ? 'now' : '');
        return `<div class="cstep ${cls}"><div class="cstep-dot"></div><div class="cstep-lbl">${escapeHtml(label)}</div></div>`;
      }).join('')}
      ${cancelled ? '<div class="cstep dead"><div class="cstep-dot"></div><div class="cstep-lbl">Cancelled</div></div>' : ''}
    </div>`;
}

// ---- ACTION PANEL - adapts to status ----
function actionPanelHtml(d) {
  const c = d.kase;
  const status = c.status;

  let inner = '';
  if (status === 'registered' || status === 'offering') {
    inner = offeringPanelHtml(d);
  } else if (ASSIGNED_PLUS.includes(status)) {
    inner = assignedPanelHtml(d);
  } else if (BILLING_STATUSES.includes(status) || ((status === 'paid' || status === 'archived') && d.invoice)) {
    inner = invoicePanelHtml(d);
  }

  if (status === 'paid') {
    inner += `
      <div class="cs-actions-grid">
        <button class="btn btn-primary" data-action="archive-case">${icon('archive')} Archive case</button>
      </div>`;
  }

  if (status === 'cancelled') {
    inner = `
      <div class="warn-banner" style="margin-bottom:0">
        ${icon('ban')}
        <p><strong>This case was cancelled.</strong>${c.cancelled_reason ? ' Reason: ' + escapeHtml(c.cancelled_reason) : ''} The timeline below remains as the audit record.</p>
      </div>`;
  } else if (status === 'archived' && !d.invoice) {
    inner = `<p style="font:var(--t-sm);color:var(--ink-3);margin:0">This case is archived. The timeline below remains as the audit record.</p>`;
  }

  // cancel is available on any live, not-yet-paid status
  const canCancel = LIVE_STATUSES.includes(status) && status !== 'paid';
  const cancelHtml = canCancel
    ? `<div style="margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid var(--line)">
         <button class="btn btn-danger btn-sm" data-action="cancel-case">${icon('ban')} Cancel this case</button>
       </div>`
    : '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="cs-section-title">${icon('activity')} Actions - ${escapeHtml(caseStatusLabel(status))}</span>
      </div>
      ${inner || '<p style="font:var(--t-sm);color:var(--ink-3);margin:0">No stage actions right now.</p>'}
      ${cancelHtml}
    </div>`;
}

function offeringPanelHtml(d) {
  const yes = d.offers.filter(o => o.response === 'yes')
    .sort((a, b) => (a.response_rank ?? 999) - (b.response_rank ?? 999));
  const pending = d.offers.filter(o => o.response === 'pending').length;
  const declined = d.offers.filter(o => o.response === 'no').length;

  const respondMins = (o) => {
    if (!o.responded_at || !o.sent_at) return null;
    const mins = Math.max(0, Math.round((new Date(o.responded_at) - new Date(o.sent_at)) / 60000));
    return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const yesRows = yes.length ? yes.map((o, i) => {
    const rank = o.response_rank ?? (i + 1);
    const rt = respondMins(o);
    return `
      <div class="cs-offer-row ${rank === 1 ? 'rank1' : ''}">
        <div class="cs-rank">#${rank}</div>
        <div class="cs-offer-who">
          <div class="n">${escapeHtml(o.nurse?.full_name || 'Unknown nurse')}</div>
          <div class="m">${escapeHtml(maskPhone(o.nurse?.phone))} · accepted ${escapeHtml(formatRelativeTime(o.responded_at))}${rt ? ` · replied in ${escapeHtml(rt)}` : ''}</div>
        </div>
        <button class="btn ${rank === 1 ? 'btn-primary' : 'btn-secondary'} btn-sm" data-action="assign" data-nurse="${escapeHtml(o.nurse?.id || '')}">
          ${icon('userCheck')} Assign
        </button>
      </div>`;
  }).join('') : `
    <div class="empty-state" style="padding:var(--s5) var(--s3)">
      ${icon('clock')}
      <h3>No nurse has accepted yet</h3>
      <p>Offers went to ${d.offers.length || 'the eligible'} nurse${d.offers.length === 1 ? '' : 's'}. The first Yes lands here ranked #1 - or assign someone manually below.</p>
    </div>`;

  const overrideOptions = d.eligibleNurses
    .map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.full_name)} - ${escapeHtml(maskPhone(n.phone))}</option>`)
    .join('');

  return `
    ${yesRows}
    <div class="cs-offer-counts">
      <span class="badge badge-ok">${yes.length} yes</span>
      <span class="badge badge-neutral">${pending} pending</span>
      <span class="badge badge-danger">${declined} declined</span>
    </div>
    <div style="margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid var(--line)">
      <div class="form-label" style="margin-bottom:7px">Manual override - assign any eligible nurse</div>
      <div class="cs-assign-row" style="margin-top:0">
        <select class="form-select" id="cs-override-nurse">
          <option value="">Choose a nurse…</option>
          ${overrideOptions}
        </select>
        <button class="btn btn-secondary" data-action="assign-override">Assign</button>
      </div>
    </div>`;
}

function availabilityBadge(resp) {
  if (resp === 'yes') return '<span class="badge badge-ok">Confirmed going</span>';
  if (resp === 'no') return '<span class="badge badge-danger">Can’t go</span>';
  if (resp === 'timeout') return '<span class="badge badge-neutral">No reply</span>';
  if (resp === 'cancelled') return '<span class="badge badge-neutral">Superseded</span>';
  return '<span class="badge badge-warning">Waiting…</span>';
}

function inMinutes(ts) {
  const mins = Math.round((new Date(ts).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins <= 0) return 'any moment now (next cron sweep)';
  return mins === 1 ? 'in 1 min' : `in ${mins} min`;
}

function availabilityHtml(d) {
  const rows = d.availability || [];
  const latest = rows[0] || null;
  const list = rows.slice(0, 4).map(a => `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 0;border-bottom:1px solid var(--line);font:var(--t-xs);color:var(--ink-2)">
      <span>${a.kind === 'standby' ? '🔁 Standby' : '🩺 Assigned'}</span>
      <strong>${escapeHtml(a.nurse?.full_name || '-')}</strong>
      ${availabilityBadge(a.response)}
      <span style="color:var(--ink-4)">asked ${escapeHtml(formatRelativeTime(a.sent_at))}${a.response === 'pending' ? ` · ${a.kind === 'standby' ? 'next standby tried' : 'standby auto-triggers'} ${escapeHtml(inMinutes(a.deadline_at))}` : ''}</span>
    </div>`).join('');

  return `
    <div style="margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid var(--line)">
      <div class="form-label" style="margin-bottom:7px">Availability check: "are you going?"</div>
      ${list || '<p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 var(--s2)">Not asked yet. The nurse gets Yes/No buttons; No or silence past the reply window triggers the standby nurse automatically.</p>'}
      ${latest && latest.response === 'pending' && latest.kind === 'standby'
        ? `<p style="font:var(--t-xs);color:var(--warn);font-weight:600;margin:var(--s2) 0 0">🔁 A standby ping is in progress. Wait for the reply or the auto-timeout, or reassign manually below.</p>`
        : `<div class="cs-actions-grid" style="margin-top:var(--s2)">
            <button class="btn ${latest && latest.response === 'pending' ? 'btn-secondary' : 'btn-primary'} btn-sm" data-action="check-availability">
              ${icon('userCheck')} ${latest && latest.response === 'pending' ? 'Re-send availability check' : 'Availability check'}
            </button>
          </div>`}
    </div>`;
}

function assignedPanelHtml(d) {
  const c = d.kase;
  const consented = !!c.consented_at || !!d.consent;
  const reassignOptions = d.eligibleNurses
    .filter(n => n.id !== c.assigned_nurse_id)
    .map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.full_name)} - ${escapeHtml(maskPhone(n.phone))}</option>`)
    .join('');

  return `
    <div class="kv" style="margin-bottom:var(--s4)">
      <div><div class="k">Assigned nurse</div><div class="v">🩺 ${escapeHtml(c.nurse?.full_name || '-')}</div></div>
      <div><div class="k">Assigned at</div><div class="v ${c.assigned_at ? '' : 'dim'}">${escapeHtml(formatDateTime(c.assigned_at))}</div></div>
      <div><div class="k">Consent</div><div class="v ${consented ? '' : 'dim'}">${consented ? '✓ ' + escapeHtml(formatDateTime(c.consented_at || d.consent?.created_at)) : 'Not yet'}</div></div>
      <div><div class="k">Arrival verified</div><div class="v ${c.arrival_verified_at ? '' : 'dim'}">${c.arrival_verified_at ? '✓ ' + escapeHtml(formatDateTime(c.arrival_verified_at)) : 'Not yet'}</div></div>
    </div>
    <div class="cs-actions-grid">
      ${!consented ? `<button class="btn btn-primary btn-sm" data-action="send-consent">${icon('shieldCheck')} Send consent form</button>` : ''}
      <button class="btn btn-secondary btn-sm" data-action="issue-otp">${icon('key')} Issue arrival OTP</button>
    </div>
    <p class="hint" style="margin:var(--s2) 0 0">The consent form itself (its questions, and which form the system sends) lives in <a href="#forms/consent">WhatsApp forms</a>.</p>
    ${!c.arrival_verified_at ? availabilityHtml(d) : ''}
    <div style="margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid var(--line)">
      <div class="form-label" style="margin-bottom:7px">Reassign to a different nurse</div>
      <div class="cs-assign-row" style="margin-top:0">
        <select class="form-select" id="cs-reassign-nurse">
          <option value="">Choose the new nurse…</option>
          ${reassignOptions}
        </select>
        <button class="btn btn-secondary" data-action="reassign">Reassign</button>
      </div>
    </div>`;
}

function invoicePanelHtml(d) {
  const inv = d.invoice;
  const c = d.kase;

  if (!inv) {
    return `
      <div class="info-banner" style="margin-bottom:var(--s3)">
        ${icon('info')}
        <p>No invoice exists for this case yet. It is normally created automatically when the nurse submits the completion report - regenerate the documents to retry.</p>
      </div>
      <div class="cs-actions-grid" style="margin-top:0">
        <button class="btn btn-secondary btn-sm" data-action="regenerate-docs">${icon('refresh')} Regenerate docs</button>
      </div>`;
  }

  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  const itemRows = items.map(it => {
    const label = it?.label ?? it?.name ?? it?.description ?? 'Item';
    const amount = Number(it?.amount_inr ?? it?.amount ?? it?.price_inr ?? it?.price ?? 0);
    return `<tr><td>${escapeHtml(label)}</td><td class="cell-num">${escapeHtml(formatINR(amount))}</td></tr>`;
  }).join('') || `<tr><td colspan="2" style="color:var(--ink-4)">No line items</td></tr>`;

  const editable = inv.status === 'draft' || inv.status === 'sent';
  const verified = inv.status === 'paid_verified';

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--s2);flex-wrap:wrap;margin-bottom:var(--s3)">
      <span class="cell-mono">${escapeHtml(inv.invoice_no)}</span>
      ${invoiceStatusBadge(inv.status)}
    </div>
    <div class="table-wrap">
      <table class="data cs-inv-table">
        <thead><tr><th>Line item</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>
          ${itemRows}
          ${Number(inv.discount_inr) > 0 ? `<tr><td>Discount</td><td class="cell-num">−${escapeHtml(formatINR(inv.discount_inr))}</td></tr>` : ''}
          <tr class="cs-inv-total"><td>Total</td><td class="cell-num">${escapeHtml(formatINR(inv.total_inr))}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="cs-inv-meta">
      ${inv.upi_vpa ? `<span>UPI ${escapeHtml(inv.upi_vpa)}</span>` : ''}
      ${inv.sent_at ? `<span>sent ${escapeHtml(formatDateTime(inv.sent_at))}</span>` : ''}
      ${inv.paid_claimed_at ? `<span>claimed ${escapeHtml(formatDateTime(inv.paid_claimed_at))}</span>` : ''}
      ${inv.paid_verified_at ? `<span>verified ${escapeHtml(formatDateTime(inv.paid_verified_at))}</span>` : ''}
    </div>
    ${inv.status === 'paid_claimed' ? `
      <div class="info-banner" style="margin:var(--s3) 0 0">
        ${icon('alertCircle')}
        <p><strong>The patient tapped "I've paid".</strong> Check the bank / UPI app, then verify below - verification is what fires the payment-received receipts.</p>
      </div>` : ''}
    <div class="cs-actions-grid">
      ${editable ? `<button class="btn btn-secondary btn-sm" data-action="edit-invoice">${icon('edit')} Edit line items & price</button>` : ''}
      ${!verified && c.status !== 'archived' ? `<button class="btn btn-secondary btn-sm" data-action="regenerate-docs">${icon('refresh')} Regenerate docs</button>` : ''}
      ${!verified && c.status !== 'archived' ? `<button class="btn btn-secondary btn-sm" data-action="resend-invoice">${icon('send')} Resend invoice</button>` : ''}
      ${!verified && BILLING_STATUSES.includes(c.status) ? `<button class="btn btn-success btn-sm" data-action="mark-paid">${icon('checkCircle')} Mark paid (verified)</button>` : ''}
      ${['care_done', 'awaiting_payment', 'paid'].includes(c.status) && !d.feedback ? `<button class="btn btn-secondary btn-sm" data-action="send-feedback">${icon('message')} Send feedback form</button>` : ''}
    </div>
    ${!editable && !verified ? `<p class="hint" style="margin-top:var(--s2)">Line items lock once a payment is claimed or verified.</p>` : ''}`;
}

// ---- send as Ops (any live status) ----
function opsPanelHtml(d) {
  if (!LIVE_STATUSES.includes(d.kase.status)) return '';
  return `
    <div class="card">
      <div class="card-header">
        <span class="cs-section-title">${icon('send')} Message as Ops</span>
      </div>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 var(--s2)">Goes into the case relay as 🛟 Ops - every active participant receives it (template fallback if their 24h window is closed).</p>
      <div class="cs-ops-box">
        <textarea class="form-textarea" id="cs-ops-text" rows="3" maxlength="1000" placeholder="Type a message to everyone on this case…"></textarea>
        <div class="row">
          <button class="btn btn-primary btn-sm" data-action="send-ops">${icon('send')} Send to case</button>
        </div>
      </div>
    </div>`;
}

// ---- test triggers (every stage, on demand, with the audience spelled out) ----
// `log` is the newest-first list of what this browser tab actually fired. It is
// deliberately NOT persisted: it is a record of THIS testing session, and a
// stale outcome from yesterday reading "delivered" would be worse than nothing.
function triggersPanelHtml(d, log) {
  const rows = CASE_TRIGGERS.map((t) => {
    let blocked = null;
    // A throwing precondition must not take the whole panel down with it - the
    // panel IS the debugging surface.
    try { blocked = t.blocked(d); } catch (e) {
      console.error('[cases] trigger precondition threw:', t.key, e);
      blocked = 'Could not work out whether this can run. Check the console.';
    }
    return `
      <div class="cs-trig">
        <div class="cs-trig-top">${icon(t.icon)}<span class="lbl">${escapeHtml(t.label)}</span>
          ${blocked ? '<span class="badge badge-neutral">Not available</span>' : ''}
        </div>
        <p class="cs-trig-who">${escapeHtml(t.audience(d))}</p>
        ${blocked ? `<p class="cs-trig-blocked">${escapeHtml(blocked)}</p>` : `
          <div class="cs-trig-act">
            <button class="btn btn-secondary btn-sm" data-action="trigger" data-trigger="${escapeHtml(t.key)}">
              ${icon('send')} Fire it now
            </button>
          </div>`}
      </div>`;
  }).join('');

  const logHtml = log.length ? `
    <div class="cs-trig-log">
      <div class="form-label" style="margin-bottom:7px">What you fired in this tab</div>
      ${log.map(entryHtml).join('')}
    </div>` : '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="cs-section-title">${icon('play')} Test triggers</span>
      </div>
      <div class="warn-banner" style="margin:0 0 var(--s2)">
        ${icon('alertTriangle')}
        <p>These are the real sends, not a simulation. Every one of them puts a WhatsApp message on a real phone and writes a real row on the timeline. Each button says who it reaches before you tap it.</p>
      </div>
      ${rows}
      ${logHtml}
    </div>`;
}

function entryHtml(e) {
  return `
    <div class="cs-trig-entry ${e.ok ? 'ok' : 'bad'}">
      <span class="dot"></span>
      <div class="body">
        <div class="meta">${escapeHtml(e.at)} · ${escapeHtml(e.label)} · ${e.ok ? 'ok' : 'failed'}</div>
        <div class="hl">${escapeHtml(e.headline)}</div>
        ${e.facts.length ? `<ul class="facts">${e.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`;
}

// Turn one admin-action round trip into one honest log entry.
//   err  set  → non-2xx, adminAction already unwrapped body.error into message
//   res.ok false → HTTP 200 and the action still did not do its job
// Anything else is a success, and only then are the spec's detail rows read.
function triggerOutcome(spec, res, err) {
  if (err) return { ok: false, headline: err.message || 'The request failed', facts: [] };
  const body = res || {};
  if (body.ok === false) {
    return {
      ok: false,
      headline: body.error
        ? errText(body.error)
        : 'The server answered ok:false and gave no reason. Check the edge-function logs.',
      facts: safeFacts(spec, body),
    };
  }
  return { ok: true, headline: `${spec.label}: done.`, facts: safeFacts(spec, body) };
}

function safeFacts(spec, body) {
  try {
    return (spec.detail(body) || []).filter((f) => typeof f === 'string' && f.trim());
  } catch (e) {
    console.error('[cases] trigger detail threw:', spec.key, e);
    return ['Could not read the details out of the response. Check the console.'];
  }
}

// ---- participants ----
function participantsHtml(d) {
  const rows = d.participants.length ? d.participants.map(p => `
    <div class="cs-part-row ${p.active ? '' : 'inactive'}">
      <div class="cs-part-emoji">${ROLE_EMOJI[p.role] || '💬'}</div>
      <div class="cs-part-who">
        <div class="n">${escapeHtml(p.display_name)}</div>
        <div class="m">${escapeHtml(capitalize(p.role))} · ${escapeHtml(maskPhone(p.phone))}</div>
      </div>
      <span class="badge ${p.relay === 'full' ? 'badge-teal' : p.relay === 'milestones' ? 'badge-info' : 'badge-neutral'}">${escapeHtml(p.relay)}</span>
      ${p.active ? '' : '<span class="badge badge-neutral">left</span>'}
    </div>`).join('')
    : '<p style="font:var(--t-sm);color:var(--ink-3);margin:0">No participants yet - they are added when the case registration fan-out runs.</p>';

  return `
    <div class="card">
      <div class="card-header">
        <span class="cs-section-title">${icon('users')} Participants</span>
        <span class="badge badge-neutral">${d.participants.filter(p => p.active).length} active</span>
      </div>
      ${rows}
    </div>`;
}

// ---- documents (signed URLs on click) ----
function documentsHtml(d) {
  const c = d.kase;
  const docs = [];
  if (c.discharge_upload_path) {
    docs.push({ path: c.discharge_upload_path, label: 'Hospital discharge (uploaded at registration)' });
  }
  if (d.invoice?.pdf_path) {
    docs.push({ path: d.invoice.pdf_path, label: `Invoice PDF - ${d.invoice.invoice_no}` });
  }
  const summaryReady = d.completion || ['care_done', 'awaiting_payment', 'paid', 'archived'].includes(c.status);
  if (summaryReady) {
    docs.push({ path: `cases/${c.id}/discharge_summary.pdf`, label: 'Discharge summary PDF' });
  }

  const rows = docs.length ? docs.map(doc => `
    <button class="cs-doc-row" data-action="open-doc" data-path="${escapeHtml(doc.path)}">
      ${icon('fileText')}
      <span class="grow">${escapeHtml(doc.label)}</span>
      <span class="ext">${icon('externalLink')}</span>
    </button>`).join('')
    : '<p style="font:var(--t-sm);color:var(--ink-3);margin:0">No documents yet. The invoice and discharge summary appear here once care completes.</p>';

  return `
    <div class="card">
      <div class="card-header">
        <span class="cs-section-title">${icon('fileText')} Documents</span>
      </div>
      ${rows}
    </div>`;
}

// ---- consent / completion / feedback summaries ----
function summariesHtml(d) {
  const blocks = [];

  if (d.consent) {
    blocks.push(`
      <div class="cs-sum">
        <div class="h">${icon('shieldCheck')} Consent · ${escapeHtml(formatDateTime(d.consent.created_at))}</div>
        <div style="font:var(--t-sm)">
          ${d.consent.agreed ? '<span class="badge badge-ok">Agreed</span>' : '<span class="badge badge-danger">Not agreed</span>'}
          ${d.consent.signed_name ? ` &nbsp;Signed by <strong>${escapeHtml(d.consent.signed_name)}</strong>` : ''}
          ${d.consent.relationship ? ` (${escapeHtml(d.consent.relationship)})` : ''}
        </div>
      </div>`);
  }

  if (d.completion) {
    const r = d.completion;
    blocks.push(`
      <div class="cs-sum">
        <div class="h">${icon('checkCircle')} Completion report · ${escapeHtml(formatDateTime(r.created_at))}</div>
        <div class="kv" style="margin-top:var(--s2)">
          <div><div class="k">Meds administered</div><div class="v">${escapeHtml(r.meds_administered || '-')}</div></div>
          <div><div class="k">Session</div><div class="v">${escapeHtml(r.started_hhmm || '-')} → ${escapeHtml(r.ended_hhmm || '-')}</div></div>
          <div><div class="k">Complications</div><div class="v ${/major/i.test(r.complications || '') ? '' : 'dim'}">${escapeHtml(r.complications || 'None')}</div></div>
          ${r.complication_notes ? `<div><div class="k">Complication notes</div><div class="v">${escapeHtml(r.complication_notes)}</div></div>` : ''}
          ${r.notes ? `<div><div class="k">Notes</div><div class="v">${escapeHtml(r.notes)}</div></div>` : ''}
        </div>
      </div>`);
  }

  if (d.feedback) {
    const f = d.feedback;
    const stars = (n) => Number.isInteger(n) && n >= 1 && n <= 5
      ? `<span class="stars">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : '-';
    blocks.push(`
      <div class="cs-sum">
        <div class="h">${icon('star')} Patient feedback · ${escapeHtml(formatDateTime(f.created_at))}</div>
        <div style="font:var(--t-sm);display:flex;flex-direction:column;gap:5px">
          <span>Overall: ${stars(f.overall_rating)} &nbsp; Nurse: ${stars(f.nurse_rating)}</span>
          <span>Would recommend: ${f.recommend === true ? 'Yes' : f.recommend === false ? 'No' : '-'}</span>
          ${f.comments ? `<span style="color:var(--ink-2)">“${escapeHtml(f.comments)}”</span>` : ''}
        </div>
      </div>`);
  }

  if (!blocks.length) return '';
  return `
    <div class="card">
      <div class="card-header">
        <span class="cs-section-title">${icon('clipboard')} Forms & feedback</span>
      </div>
      ${blocks.join('')}
    </div>`;
}

// ============================================================
// Modals
// ============================================================
function openCancelModal(d, onDone) {
  const overlay = showModal({
    title: `Cancel ${escapeHtml(d.kase.case_code)}`,
    content: `
      <p style="margin:0 0 var(--s3);font:var(--t-sm);color:var(--ink-2)">
        Cancelling notifies the assigned people on WhatsApp and closes the case permanently. Give a short reason - it goes on the audit trail.
      </p>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label" for="cs-cancel-reason">Reason <span class="required">*</span></label>
        <textarea class="form-textarea" id="cs-cancel-reason" rows="3" maxlength="500" placeholder="e.g. Patient admitted to hospital, session no longer needed"></textarea>
      </div>`,
    footer: `
      <button class="btn btn-secondary" data-cancel>Keep the case</button>
      <button class="btn btn-danger" data-confirm>${icon('ban')} Cancel case</button>`,
  });

  overlay.querySelector('[data-cancel]').addEventListener('click', () => closeModal());
  overlay.querySelector('[data-confirm]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const reason = (overlay.querySelector('#cs-cancel-reason')?.value || '').trim();
    if (!reason) { showToast('A cancellation reason is required', 'warning'); return; }
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      await adminAction('cancel_case', { case_id: d.kase.id, reason });
      closeModal();
      showToast('Case cancelled - notifications are going out.', 'success');
      await onDone();
    } catch (err) {
      showToast(err.message || 'Cancel failed', 'error');
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${icon('ban')} Cancel case`; }
    }
  });
}

function openInvoiceEditor(d, onDone) {
  const inv = d.invoice;
  if (!inv) return;

  const normalize = (it) => ({
    label: String(it?.label ?? it?.name ?? it?.description ?? 'Item'),
    amount: Number(it?.amount_inr ?? it?.amount ?? it?.price_inr ?? it?.price ?? 0) || 0,
  });
  let items = Array.isArray(inv.line_items) && inv.line_items.length
    ? inv.line_items.map(normalize)
    : [{ label: careTypeLabel(d.kase.care_type), amount: Number(d.kase.price_inr) || 0 }];
  let discount = Number(inv.discount_inr) || 0;

  const content = document.createElement('div');
  content.addEventListener('input', onAnyInput); // once - survives paintEditor re-renders

  function totals() {
    const subtotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const total = Math.max(0, subtotal - (Number(discount) || 0));
    return { subtotal, total };
  }

  function syncFromInputs() {
    content.querySelectorAll('[data-li-row]').forEach(row => {
      const i = Number(row.dataset.liRow);
      if (!items[i]) return;
      items[i].label = row.querySelector('[data-li-label]')?.value ?? items[i].label;
      items[i].amount = Number(row.querySelector('[data-li-amount]')?.value) || 0;
    });
    discount = Number(content.querySelector('#cs-li-discount')?.value) || 0;
  }

  function paintEditor() {
    const { subtotal, total } = totals();
    content.innerHTML = `
      ${inv.status !== 'draft' ? `
        <div class="warn-banner" style="margin-bottom:var(--s4)">
          ${icon('alertTriangle')}
          <p>This invoice was already sent to the patient. After saving, run <strong>Regenerate docs</strong> and <strong>Resend invoice</strong> so the PDF matches.</p>
        </div>` : ''}
      <div class="cs-li-row" style="margin-bottom:6px">
        <div class="form-label">Line item</div>
        <div class="form-label" style="text-align:right">Amount ₹</div>
        <div></div>
      </div>
      ${items.map((it, i) => `
        <div class="cs-li-row" data-li-row="${i}">
          <input class="form-input" data-li-label maxlength="120" value="${escapeHtml(it.label)}" placeholder="Description" />
          <input class="form-input" data-li-amount type="number" min="0" step="0.01" value="${it.amount}" style="text-align:right" />
          <button class="btn btn-ghost btn-icon btn-sm" data-li-remove="${i}" title="Remove line" ${items.length <= 1 ? 'disabled' : ''}>${icon('trash')}</button>
        </div>`).join('')}
      <button class="btn btn-ghost btn-sm" data-li-add>${icon('plus')} Add line item</button>
      <div class="cs-li-foot">
        <div class="lbl">Subtotal</div>
        <div class="cs-li-total" data-li-subtotal>${escapeHtml(formatINR(subtotal))}</div>
        <div class="lbl">Discount ₹</div>
        <input class="form-input" id="cs-li-discount" type="number" min="0" step="0.01" value="${discount}" style="text-align:right" />
        <div class="lbl">Total (also becomes the case price)</div>
        <div class="cs-li-total" data-li-total>${escapeHtml(formatINR(total))}</div>
      </div>`;

    content.querySelector('[data-li-add]').addEventListener('click', () => {
      syncFromInputs();
      items.push({ label: '', amount: 0 });
      paintEditor();
    });
    content.querySelectorAll('[data-li-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        syncFromInputs();
        items.splice(Number(btn.dataset.liRemove), 1);
        if (!items.length) items.push({ label: '', amount: 0 });
        paintEditor();
      });
    });
  }

  function onAnyInput() {
    syncFromInputs();
    const { subtotal, total } = totals();
    const sEl = content.querySelector('[data-li-subtotal]');
    const tEl = content.querySelector('[data-li-total]');
    if (sEl) sEl.textContent = formatINR(subtotal);
    if (tEl) tEl.textContent = formatINR(total);
  }

  const overlay = showModal({
    title: `Edit invoice ${escapeHtml(inv.invoice_no)}`,
    content,
    size: 'lg',
    footer: `
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>${icon('check')} Save invoice</button>`,
  });
  paintEditor();

  overlay.querySelector('[data-cancel]').addEventListener('click', () => closeModal());
  overlay.querySelector('[data-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    syncFromInputs();

    const cleaned = items
      .map(it => ({ label: String(it.label || '').trim(), amount_inr: Math.round((Number(it.amount) || 0) * 100) / 100 }))
      .filter(it => it.label || it.amount_inr > 0);
    if (!cleaned.length) { showToast('Add at least one line item', 'warning'); return; }
    if (cleaned.some(it => !it.label)) { showToast('Every line item needs a description', 'warning'); return; }
    if (cleaned.some(it => it.amount_inr < 0)) { showToast('Amounts cannot be negative', 'warning'); return; }

    const subtotal = Math.round(cleaned.reduce((s, it) => s + it.amount_inr, 0) * 100) / 100;
    const disc = Math.round((Number(discount) || 0) * 100) / 100;
    if (disc < 0) { showToast('Discount cannot be negative', 'warning'); return; }
    if (disc > subtotal) { showToast('Discount cannot exceed the subtotal', 'warning'); return; }
    const total = Math.round((subtotal - disc) * 100) / 100;

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const sb = getSupabase();
      const { error: invErr } = await sb.from('invoices')
        .update({ line_items: cleaned, subtotal_inr: subtotal, discount_inr: disc, total_inr: total })
        .eq('id', inv.id);
      if (invErr) throw invErr;
      const { error: caseErr } = await sb.from('cases')
        .update({ price_inr: total })
        .eq('id', d.kase.id);
      if (caseErr) throw caseErr;

      closeModal();
      showToast(`Invoice updated - new total ${formatINR(total)}.`, 'success');
      await onDone();
    } catch (err) {
      console.error('[cases] invoice save failed:', err);
      showToast(err.message || 'Could not save the invoice', 'error');
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${icon('check')} Save invoice`; }
    }
  });
}
