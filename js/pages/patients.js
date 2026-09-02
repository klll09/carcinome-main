// ============================================================
// Carcinome Home Care - Patients page
//   #patients      → searchable list + Register Patient modal
//   #patients/:id  → patient detail (editable) + case history
//
// Data access: direct Supabase queries (RLS admin). Anything
// that triggers WhatsApp goes through adminAction() only.
// All timestamps display IST; datetime-local inputs are IST.
// ============================================================

import { getSupabase } from '../supabase.js';
import { adminAction, uploadCaseDoc } from '../utils/api.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { validateIndianPhone, validatePinCode } from '../utils/validators.js';
import { navigate } from '../router.js';
import {
  escapeHtml, maskPhone, formatPhone, formatDateTime, formatRelativeTime,
  formatINR, caseStatusBadge, caseStatusLabel, careTypeLabel, lineTypeLabel,
  CARE_TYPES, LINE_TYPES, renderSkeleton,
} from '../utils/formatters.js';

const OPEN_EXCLUDE = ['archived', 'cancelled'];

// ------------------------------------------------------------
// Manual journey steps: send one WhatsApp step on demand against a
// patient's live case. Each maps to a status-guarded admin-action
// (the server re-checks applicability; `statuses` here is just so the
// menu greys out steps that make no sense yet).
// Not to be confused with Journeys (#journeys, the reference canvas)
// or WhatsApp forms (#forms, the real Meta in-chat forms).
// ------------------------------------------------------------
const MANUAL_STEPS = [
  { key: 'consent',  emoji: '🛡️', label: 'Send consent form',   action: 'send_consent',
    statuses: ['assigned', 'consented', 'otp_sent', 'in_care'],
    success: 'Consent form sent to the patient on WhatsApp.' },
  { key: 'otp',      emoji: '🔑', label: 'Issue arrival OTP',    action: 'issue_otp',
    statuses: ['assigned', 'consented', 'otp_sent', 'in_care'],
    success: 'Arrival OTP sent to the patient.' },
  { key: 'avail',    emoji: '🩺', label: 'Availability check',   action: 'check_availability',
    statuses: ['assigned', 'consented', 'otp_sent'],
    success: 'Availability check sent. The nurse gets Yes/No buttons.' },
  { key: 'feedback', emoji: '⭐', label: 'Send feedback form',   action: 'send_feedback_invite',
    statuses: ['care_done', 'awaiting_payment', 'paid'],
    success: 'Feedback form sent to the patient on WhatsApp.' },
  { key: 'invoice',  emoji: '🧾', label: 'Resend invoice',       action: 'resend_invoice',
    statuses: ['care_done', 'awaiting_payment', 'paid'],
    success: 'Invoice re-sent to the patient.' },
];

const CANCER_TYPE_SUGGESTIONS = [
  'Breast', 'Lung', 'Colorectal', 'Ovarian', 'Cervical', 'Prostate',
  'Leukemia', 'Lymphoma', 'Oral', 'Stomach', 'Liver', 'Pancreatic',
  'Head & Neck', 'Multiple Myeloma', 'Brain', 'Kidney', 'Bladder',
];

// ------------------------------------------------------------
// IST helpers - datetime-local inputs are ALWAYS IST wall time,
// independent of the device timezone (IST has no DST → fixed +05:30).
// ------------------------------------------------------------
function istToIso(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue + ':00+05:30');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function istNowLocalValue() {
  // Shift the clock by +5:30 so the UTC fields of toISOString read IST wall time.
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16);
}

// ------------------------------------------------------------
// Page-scoped styles (injected once)
// ------------------------------------------------------------
function injectStyles() {
  if (document.getElementById('pt-page-styles')) return;
  const style = document.createElement('style');
  style.id = 'pt-page-styles';
  style.textContent = `
    .pt-count { font: var(--t-sm); color: var(--ink-3); margin-top: 4px; }
    .pt-back { margin-bottom: var(--s4); }
    .pt-back a { display: inline-flex; align-items: center; gap: 6px; font: var(--t-sm); font-weight: 600; color: var(--ink-3); text-decoration: none; }
    .pt-back a:hover { color: var(--primary); }
    tr.pt-row-optout td { opacity: 0.62; }

    .pt-sect { display: flex; align-items: center; gap: 10px; font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.12em; color: var(--primary); margin: var(--s6) 0 var(--s4); }
    .pt-sect:first-child { margin-top: 0; }
    .pt-sect::after { content: ""; flex: 1; height: 1px; background: var(--line); }

    .pt-radio-row { display: flex; gap: var(--s5); align-items: center; flex-wrap: wrap; }
    .pt-radio-row label { display: inline-flex; gap: 8px; align-items: center; font: var(--t-sm); cursor: pointer; }

    .pt-seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--r-pill); overflow: hidden; background: var(--surface); }
    .pt-seg button { border: none; background: none; padding: 7px 14px; font: var(--t-xs); font-weight: 700; color: var(--ink-2); cursor: pointer; white-space: nowrap; transition: background var(--fast) var(--ease), color var(--fast) var(--ease); }
    .pt-seg button + button { border-left: 1px solid var(--line); }
    .pt-seg button.on { background: var(--grad-primary); color: #fff; }
    .pt-seg button:disabled { opacity: 0.5; cursor: not-allowed; }

    .pt-doc-pick { position: relative; }
    .pt-doc-results { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--sh-3); z-index: 60; max-height: 230px; overflow-y: auto; padding: var(--s1); display: none; }
    .pt-doc-results.open { display: block; }
    .pt-doc-item { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 9px 11px; border: none; background: none; border-radius: var(--r-sm); cursor: pointer; font: var(--t-sm); color: var(--ink); }
    .pt-doc-item:hover, .pt-doc-item:focus-visible { background: var(--bg-sunken); outline: none; }
    .pt-doc-item .sub { font: var(--t-xs); color: var(--ink-3); }
    .pt-doc-none { padding: 10px 11px; font: var(--t-xs); color: var(--ink-3); }

    .pt-chip { display: inline-flex; align-items: center; gap: 8px; background: var(--primary-soft); color: var(--primary); border-radius: var(--r-pill); padding: 6px 8px 6px 13px; font: var(--t-sm); font-weight: 600; max-width: 100%; }
    .pt-chip .pt-chip-x { border: none; background: none; cursor: pointer; color: inherit; display: flex; padding: 2px; border-radius: 50%; }
    .pt-chip .pt-chip-x:hover { background: rgba(0,0,0,0.08); }

    .pt-sups { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--s2); }
    .pt-sup { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 9px 11px; transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease); }
    .pt-sup:hover { border-color: var(--ink-3); }
    .pt-sup:has(input:checked) { border-color: var(--primary); background: var(--primary-tint, var(--primary-soft)); }
    .pt-sup .sub { display: block; font: var(--t-xs); color: var(--ink-3); }

    .pt-existing { display: flex; align-items: center; gap: 12px; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px; }
    .pt-existing .who { min-width: 0; }
    .pt-existing .who .nm { font: var(--t-body-strong); color: var(--ink); }
    .pt-existing .who .sub { font: var(--t-mono); font-size: 11.5px; color: var(--ink-3); }

    .pt-lang-note { font: var(--t-xs); color: var(--ink-3); }
    .pt-detail-grid { display: grid; grid-template-columns: 1fr; gap: var(--s5); }
    .pt-cases-card { margin-top: var(--s5); }
    .pt-addr { white-space: pre-wrap; }

    /* Start-care-journey split button + "send a step now" menu */
    .pt-step-split { display: inline-flex; }
    .pt-step-split .pt-step-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .pt-step-split .pt-step-caret { border-top-left-radius: 0; border-bottom-left-radius: 0; padding-left: 9px; padding-right: 9px; border-left: 1px solid rgba(255,255,255,0.28); }
    .pt-step-split .pt-step-main svg, .pt-step-split .pt-step-caret svg { width: 15px; height: 15px; }
    .pt-step-menu { min-width: 244px; }
    .pt-step-head { font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); padding: 6px 10px 4px; }
    .pt-step-empty { font: var(--t-xs); color: var(--ink-3); margin: 0; padding: 2px 10px 8px; line-height: 1.5; }
    .pt-step-target { font: var(--t-xs); color: var(--ink-2); padding: 2px 10px 6px; }
    .pt-step-case { padding: 4px 10px 8px; }
    .pt-step-case label { display: block; font: var(--t-xs); color: var(--ink-3); margin-bottom: 4px; }
    .pt-step-item { font-weight: 600; color: var(--ink); }
    .pt-step-item:disabled { opacity: 0.42; cursor: not-allowed; }
    .pt-step-item:disabled:hover { background: none; color: var(--ink); }
    .pt-step-emoji { width: 18px; text-align: center; flex: none; }

    @media (max-width: 640px) {
      .detail-actions { width: 100%; }
      .detail-actions .btn { flex: 1; }
      .pt-step-split { flex: 1 1 100%; }
      .pt-step-split .pt-step-caret { flex: 0 0 auto; }
      .pt-step-menu { right: auto; left: 0; }
    }
  `;
  document.head.appendChild(style);
}

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

function langBadge(pref) {
  return pref === 'hi'
    ? '<span class="badge badge-violet">हिंदी</span>'
    : '<span class="badge badge-info">EN</span>';
}

function markError(el) {
  if (!el) return;
  el.classList.add('error');
  el.addEventListener('input', () => el.classList.remove('error'), { once: true });
}

function fail(errors, el, message) {
  errors.push({ el, message });
}

function reportErrors(errors) {
  if (!errors.length) return false;
  errors.forEach((e) => markError(e.el));
  showToast(errors[0].message, 'warning');
  errors[0].el?.focus?.();
  return true;
}

function busyButton(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy ? '<div class="spinner" style="margin:0 auto"></div>' : label;
}

function errorState(container, title, err, retryLabel, onRetry) {
  container.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(err?.message || 'Unknown error')}</p>
      <button class="btn btn-secondary" id="pt-retry">${escapeHtml(retryLabel)}</button>
    </div>`;
  container.querySelector('#pt-retry')?.addEventListener('click', onRetry);
}

// ============================================================
// ENTRY
// ============================================================
export default async function render(container, params) {
  injectStyles();
  if (params && params.id) {
    await renderDetail(container, params.id);
  } else {
    await renderList(container);
  }
}

// ============================================================
// LIST - #patients
// ============================================================
async function renderList(container) {
  container.innerHTML = renderSkeleton(7);

  const sb = getSupabase();
  const { data: patients, error } = await sb
    .from('patients')
    .select('id, patient_code, full_name, phone, wa_number, cancer_type, locality, language_pref, opted_out, created_at, cases(id, status)')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.error('[patients] list load failed:', error);
    errorState(container, 'Could not load patients', error, 'Retry', () => renderList(container));
    return;
  }

  const list = patients || [];

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Patients</h1>
        <p class="pt-count" id="pt-count-line">${list.length} patient${list.length === 1 ? '' : 's'} registered</p>
      </div>
      <button class="btn btn-primary" id="pt-register-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Register Patient
      </button>
    </div>
    <div class="card card-flush">
      <div class="table-toolbar">
        <div class="table-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input class="form-input" id="pt-search" type="search" placeholder="Search name, code, phone, cancer type…" autocomplete="off" />
        </div>
        <span class="hint" id="pt-result-count"></span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Code</th><th>Patient</th><th>Phone</th><th>Cancer type</th>
              <th>Open cases</th><th>Lang</th><th>Registered</th>
            </tr>
          </thead>
          <tbody id="pt-tbody"></tbody>
        </table>
      </div>
    </div>`;

  const tbody = container.querySelector('#pt-tbody');
  const resultCount = container.querySelector('#pt-result-count');
  const searchInput = container.querySelector('#pt-search');

  function openCount(p) {
    return (p.cases || []).filter((c) => !OPEN_EXCLUDE.includes(c.status)).length;
  }

  function drawRows() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const filtered = !q ? list : list.filter((p) =>
      [p.full_name, p.patient_code, p.phone, p.wa_number, p.cancer_type, p.locality]
        .some((v) => String(v || '').toLowerCase().includes(q)));

    resultCount.textContent = q ? `${filtered.length} of ${list.length}` : '';

    if (!list.length) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
            <h3>No patients yet</h3>
            <p>Register the first patient to kick off the WhatsApp care loop - referral acks, nurse offers and equipment prep all fire from one form.</p>
            <button class="btn btn-primary" id="pt-empty-register">Register your first patient</button>
          </div>
        </td></tr>`;
      tbody.querySelector('#pt-empty-register')?.addEventListener('click', () => openRegisterModal(null));
      return;
    }

    if (!filtered.length) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state" style="padding: var(--s6)">
            <h3>No matches</h3>
            <p>No patient matches “${escapeHtml(q)}”. Try a shorter search, or register them as new.</p>
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((p) => {
      const open = openCount(p);
      return `
        <tr class="row-link ${p.opted_out ? 'pt-row-optout' : ''}" data-id="${escapeHtml(p.id)}" tabindex="0" aria-label="Open ${escapeHtml(p.full_name)}">
          <td class="cell-mono">${escapeHtml(p.patient_code)}</td>
          <td>
            <strong>${escapeHtml(p.full_name)}</strong>
            ${p.opted_out ? ' <span class="badge badge-danger">Opted out</span>' : ''}
            ${p.locality ? `<div class="hint">${escapeHtml(p.locality)}</div>` : ''}
          </td>
          <td class="cell-mono">${escapeHtml(maskPhone(p.wa_number || p.phone))}</td>
          <td class="cell-clamp">${escapeHtml(p.cancer_type || '-')}</td>
          <td>${open > 0 ? `<span class="badge badge-primary">${open} open</span>` : '<span class="hint">-</span>'}</td>
          <td>${langBadge(p.language_pref)}</td>
          <td class="hint">${escapeHtml(formatRelativeTime(p.created_at))}</td>
        </tr>`;
    }).join('');
  }

  drawRows();
  searchInput.addEventListener('input', drawRows);

  tbody.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) navigate(`patients/${row.dataset.id}`);
  });
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('tr[data-id]');
    if (row) navigate(`patients/${row.dataset.id}`);
  });

  container.querySelector('#pt-register-btn')?.addEventListener('click', () => openRegisterModal(null));
}

// ============================================================
// REGISTER PATIENT + CASE - the money form
//   existingPatient: pass a patient row to register a new case
//   for someone already on file (patient section locked).
// ============================================================
async function openRegisterModal(existingPatient) {
  const sb = getSupabase();

  // Reference data in parallel; none of it is fatal if it fails.
  // Nurses: only the ones register_case will actually accept. Its validation is
  // `exists AND is_active AND NOT opted_out` (admin-actions/index.ts step 2b),
  // so anyone else in the list would only be a 400 waiting to happen. Note
  // is_eligible is NOT part of that test: an eligible-off nurse can still be
  // named by hand, she just is not in the broadcast pool - the option label
  // below says exactly that rather than hiding her.
  const [docsRes, supsRes, nursesRes, pricingRes] = await Promise.all([
    sb.from('doctors').select('id, full_name, phone, specialty, language_pref').order('full_name').limit(1000),
    sb.from('suppliers').select('id, name, phone').eq('is_active', true).order('name').limit(500),
    sb.from('nurses').select('id, full_name, phone, is_eligible')
      .eq('is_active', true).eq('opted_out', false).order('full_name').limit(500),
    sb.rpc('get_setting', { p_key: 'pricing' }),
  ]);
  if (docsRes.error) console.error('[patients] doctors load failed:', docsRes.error);
  if (supsRes.error) console.error('[patients] suppliers load failed:', supsRes.error);
  if (nursesRes.error) console.error('[patients] nurses load failed:', nursesRes.error);
  if (pricingRes.error) console.error('[patients] pricing load failed:', pricingRes.error);

  const doctors = docsRes.data || [];
  const suppliers = supsRes.data || [];
  const nurses = nursesRes.data || [];
  const poolSize = nurses.filter((n) => n.is_eligible).length;
  const pricing = (pricingRes.data && typeof pricingRes.data === 'object') ? pricingRes.data : {};

  let selectedDoctor = null;
  let docMode = doctors.length ? 'existing' : 'new';
  // 'broadcast' is the normal path and stays the default: offers go to the whole
  // pool and the first Yes wins. 'direct' is the deliberate exception the owner
  // asked for ("usme nurse fill nahi rehta") and skips the broadcast entirely.
  let nurseMode = 'broadcast';
  let caseAddrTouched = false;
  let submitting = false;

  const patientSection = existingPatient ? `
    <div class="pt-existing">
      <div class="avatar" style="background: var(--grad-primary)">${escapeHtml(initials(existingPatient.full_name))}</div>
      <div class="who">
        <div class="nm">${escapeHtml(existingPatient.full_name)}</div>
        <div class="sub">${escapeHtml(existingPatient.patient_code)} · ${escapeHtml(formatPhone(existingPatient.wa_number || existingPatient.phone))}</div>
      </div>
    </div>
    ${existingPatient.opted_out ? '<div class="warn-banner" style="margin-top:var(--s3)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><p>This patient has opted out of WhatsApp messages. Registration will still create the case, but patient messages may not be sent.</p></div>' : ''}
  ` : `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="rp-name">Full name <span class="required">*</span></label>
        <input class="form-input" id="rp-name" type="text" placeholder="e.g. Meera Sharma" autocomplete="off" />
      </div>
      <div class="form-group">
        <label class="form-label" for="rp-phone">Phone <span class="required">*</span></label>
        <input class="form-input" id="rp-phone" type="tel" inputmode="numeric" placeholder="98765 43210" autocomplete="off" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="rp-wa">WhatsApp number <span class="required">*</span></label>
        <input class="form-input" id="rp-wa" type="tel" inputmode="numeric" placeholder="Same as phone" disabled />
        <label class="check"><input type="checkbox" id="rp-wa-same" checked /> <span>WhatsApp is the same as phone</span></label>
      </div>
      <div class="form-group">
        <label class="form-label" for="rp-cancer">Cancer type <span class="required">*</span></label>
        <input class="form-input" id="rp-cancer" type="text" list="rp-cancer-list" placeholder="e.g. Breast" autocomplete="off" />
        <datalist id="rp-cancer-list">${CANCER_TYPE_SUGGESTIONS.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="rp-address">Address <span class="required">*</span></label>
      <textarea class="form-textarea" id="rp-address" rows="2" placeholder="House / street / area - where the nurse should reach"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="rp-locality">Locality</label>
        <input class="form-input" id="rp-locality" type="text" placeholder="e.g. Andheri West" autocomplete="off" />
      </div>
      <div class="form-group">
        <label class="form-label" for="rp-pincode">PIN code</label>
        <input class="form-input" id="rp-pincode" type="text" inputmode="numeric" maxlength="6" placeholder="400058" autocomplete="off" />
      </div>
    </div>
    <div class="form-group">
      <span class="form-label">Message language</span>
      <div class="pt-radio-row" role="radiogroup" aria-label="Patient language preference">
        <label><input type="radio" name="rp-lang" value="en" checked /> English</label>
        <label><input type="radio" name="rp-lang" value="hi" /> हिंदी (Hindi)</label>
      </div>
      <span class="pt-lang-note">All WhatsApp messages to the patient go out in this language.</span>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="rp-poc-name">Carcinome POC name</label>
        <input class="form-input" id="rp-poc-name" type="text" placeholder="Intern who owns this family" autocomplete="off" />
      </div>
      <div class="form-group">
        <label class="form-label" for="rp-poc-phone">POC WhatsApp number</label>
        <input class="form-input" id="rp-poc-phone" type="tel" placeholder="Gets milestone logs + STATUS digests" autocomplete="off" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="rp-notes">Patient notes</label>
      <textarea class="form-textarea" id="rp-notes" rows="2" placeholder="Allergies, mobility, caregiver contact…"></textarea>
    </div>`;

  const doctorSection = `
    <div class="form-group">
      <div class="pt-seg" role="tablist" aria-label="Referring doctor mode">
        <button type="button" data-docmode="existing" ${doctors.length ? '' : 'disabled title="No doctors on file yet"'}>Pick existing</button>
        <button type="button" data-docmode="new">New doctor</button>
        <button type="button" data-docmode="none">No doctor</button>
      </div>
    </div>
    <div id="rd-existing-wrap">
      <div class="form-group pt-doc-pick">
        <label class="form-label" for="rd-search">Search doctors</label>
        <input class="form-input" id="rd-search" type="text" placeholder="Type a name or phone…" autocomplete="off" />
        <div class="pt-doc-results" id="rd-results"></div>
      </div>
      <div class="form-group" id="rd-selected" style="display:none"></div>
    </div>
    <div id="rd-new-wrap" style="display:none">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="rd-name">Doctor name <span class="required">*</span></label>
          <input class="form-input" id="rd-name" type="text" placeholder="Dr. …" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label" for="rd-phone">Doctor phone <span class="required">*</span></label>
          <input class="form-input" id="rd-phone" type="tel" inputmode="numeric" placeholder="98765 43210" autocomplete="off" />
        </div>
      </div>
      <div class="form-group">
        <span class="form-label">Doctor language</span>
        <div class="pt-radio-row">
          <label><input type="radio" name="rd-lang" value="en" checked /> English</label>
          <label><input type="radio" name="rd-lang" value="hi" /> हिंदी (Hindi)</label>
        </div>
      </div>
    </div>
    <div id="rd-none-wrap" style="display:none">
      <p class="hint">No referring doctor - the case is created without doctor updates.</p>
    </div>`;

  const caseSection = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="rc-line">Line type <span class="required">*</span></label>
        <select class="form-select" id="rc-line">
          <option value="">Select line type…</option>
          ${LINE_TYPES.map((t) => `<option value="${t}">${escapeHtml(lineTypeLabel(t))}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="rc-care">Care type <span class="required">*</span></label>
        <select class="form-select" id="rc-care">
          <option value="">Select care type…</option>
          ${CARE_TYPES.map((t) => `<option value="${t}">${escapeHtml(careTypeLabel(t))}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="rc-when">Scheduled at (IST) <span class="required">*</span></label>
        <input class="form-input" id="rc-when" type="datetime-local" min="${istNowLocalValue()}" />
        <span class="form-hint">Session start time, Indian Standard Time.</span>
      </div>
      <div class="form-group">
        <label class="form-label" for="rc-price">Price override (₹)</label>
        <input class="form-input" id="rc-price" type="number" min="0" step="0.01" placeholder="Leave blank for standard price" />
        <span class="form-hint" id="rc-price-hint"></span>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="rc-address">Session address <span class="required">*</span></label>
      <textarea class="form-textarea" id="rc-address" rows="2" placeholder="Prefilled from the patient address - edit if the session happens elsewhere"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label" for="rc-equip">Equipment notes</label>
      <textarea class="form-textarea" id="rc-equip" rows="2" placeholder="Infusion pump, IV set, medicines to arrange…"></textarea>
    </div>
    <div class="form-group">
      <span class="form-label">Nurse</span>
      <div class="pt-seg" role="tablist" aria-label="How this case gets a nurse">
        <button type="button" data-nursemode="broadcast" class="on">Offer to the pool</button>
        <button type="button" data-nursemode="direct" ${nurses.length ? '' : 'disabled title="No nurse can be messaged right now"'}>Assign one now</button>
      </div>
      <div id="rn-broadcast-wrap">
        <p class="hint">Normal path. The offer goes to ${poolSize} nurse${poolSize === 1 ? '' : 's'} in the pool and the first Yes gets the case.${poolSize ? '' : ' <strong>Nobody is in the pool right now</strong>, so no offer will reach anyone - check the Nurses page.'}</p>
      </div>
      <div id="rn-direct-wrap" style="display:none">
        <select class="form-select" id="rc-nurse">
          <option value="">Choose the nurse…</option>
          ${nurses.map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.full_name)} · ${escapeHtml(formatPhone(n.phone))}${n.is_eligible ? '' : ' (not in the offer pool)'}</option>`).join('')}
        </select>
        <p class="hint">She is assigned straight away and <strong>no offer is sent to anyone else</strong>. She gets the full address and the arrival protocol, the family and the doctor are told her name, and the consent form goes out.</p>
      </div>
    </div>
    <div class="form-group">
      <span class="form-label">Suppliers to notify</span>
      ${suppliers.length ? `
        <div class="pt-sups" id="rc-sups">
          ${suppliers.map((s) => `
            <label class="check pt-sup">
              <input type="checkbox" value="${escapeHtml(s.id)}" />
              <span>${escapeHtml(s.name)}<span class="sub">${escapeHtml(formatPhone(s.phone))}</span></span>
            </label>`).join('')}
        </div>` : '<p class="hint">No active suppliers yet - add them under Marketplace. You can register the case without one.</p>'}
    </div>
    <div class="form-group">
      <label class="form-label" for="rc-pdf">Discharge summary (PDF)</label>
      <input class="form-input" id="rc-pdf" type="file" accept=".pdf,application/pdf" />
      <span class="form-hint">Optional - the hospital discharge summary, if the family shared one.</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="rc-notes">Case notes</label>
      <textarea class="form-textarea" id="rc-notes" rows="2" placeholder="Anything the nurse or team should know"></textarea>
    </div>`;

  const overlay = showModal({
    title: existingPatient ? `New case - ${escapeHtml(existingPatient.full_name)}` : 'Register Patient',
    size: 'lg',
    content: `
      <form id="rp-form" novalidate>
        <div class="pt-sect">Patient</div>
        ${patientSection}
        <div class="pt-sect">Referring doctor</div>
        ${doctorSection}
        <div class="pt-sect">Care session</div>
        ${caseSection}
      </form>`,
    footer: `
      <button class="btn btn-secondary" data-rp-cancel>Cancel</button>
      <button class="btn btn-primary" data-rp-submit>Register &amp; send WhatsApp</button>`,
  });

  const $ = (sel) => overlay.querySelector(sel);
  const submitBtn = $('[data-rp-submit]');
  const SUBMIT_LABEL = 'Register &amp; send WhatsApp';

  $('[data-rp-cancel]').addEventListener('click', () => closeModal());

  // ---- patient section wiring (new patient only) ----
  if (!existingPatient) {
    const phoneEl = $('#rp-phone');
    const waEl = $('#rp-wa');
    const sameEl = $('#rp-wa-same');
    const syncWa = () => { if (sameEl.checked) waEl.value = phoneEl.value; };
    phoneEl.addEventListener('input', syncWa);
    sameEl.addEventListener('change', () => {
      waEl.disabled = sameEl.checked;
      if (sameEl.checked) syncWa(); else waEl.focus();
    });

    // Patient address prefills session address until it's hand-edited.
    const pAddr = $('#rp-address');
    const cAddr = $('#rc-address');
    pAddr.addEventListener('input', () => { if (!caseAddrTouched) cAddr.value = pAddr.value; });
  } else {
    $('#rc-address').value = existingPatient.address || '';
  }
  $('#rc-address').addEventListener('input', () => { caseAddrTouched = true; });

  // ---- doctor section wiring ----
  const segButtons = overlay.querySelectorAll('[data-docmode]');
  function setDocMode(mode) {
    docMode = mode;
    segButtons.forEach((b) => b.classList.toggle('on', b.dataset.docmode === mode));
    $('#rd-existing-wrap').style.display = mode === 'existing' ? '' : 'none';
    $('#rd-new-wrap').style.display = mode === 'new' ? '' : 'none';
    $('#rd-none-wrap').style.display = mode === 'none' ? '' : 'none';
  }
  segButtons.forEach((b) => b.addEventListener('click', () => setDocMode(b.dataset.docmode)));

  // ---- nurse section wiring ----
  // Leaving 'direct' clears the select, so a nurse picked and then abandoned
  // cannot be submitted by a mode toggle nobody looked at again.
  const nurseSegButtons = overlay.querySelectorAll('[data-nursemode]');
  const nurseSelect = $('#rc-nurse');
  function setNurseMode(mode) {
    nurseMode = mode;
    nurseSegButtons.forEach((b) => b.classList.toggle('on', b.dataset.nursemode === mode));
    $('#rn-broadcast-wrap').style.display = mode === 'broadcast' ? '' : 'none';
    $('#rn-direct-wrap').style.display = mode === 'direct' ? '' : 'none';
    if (mode !== 'direct' && nurseSelect) nurseSelect.value = '';
  }
  nurseSegButtons.forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    setNurseMode(b.dataset.nursemode);
  }));
  setDocMode(docMode);

  const docSearch = $('#rd-search');
  const docResults = $('#rd-results');
  const docSelectedWrap = $('#rd-selected');

  function drawDoctorChip() {
    if (!selectedDoctor) {
      docSelectedWrap.style.display = 'none';
      docSelectedWrap.innerHTML = '';
      docSearch.parentElement.style.display = '';
      return;
    }
    docSearch.parentElement.style.display = 'none';
    docSelectedWrap.style.display = '';
    docSelectedWrap.innerHTML = `
      <span class="pt-chip">
        <span>🥼 ${escapeHtml(selectedDoctor.full_name)} · ${escapeHtml(formatPhone(selectedDoctor.phone))}</span>
        <button type="button" class="pt-chip-x" aria-label="Clear doctor">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </span>`;
    docSelectedWrap.querySelector('.pt-chip-x').addEventListener('click', () => {
      selectedDoctor = null;
      drawDoctorChip();
      docSearch.value = '';
      docSearch.focus();
    });
  }

  function drawDoctorResults() {
    const q = (docSearch.value || '').trim().toLowerCase();
    if (!q) { docResults.classList.remove('open'); docResults.innerHTML = ''; return; }
    const matches = doctors.filter((d) =>
      [d.full_name, d.phone, d.specialty].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 8);
    docResults.innerHTML = matches.length
      ? matches.map((d, i) => `
          <button type="button" class="pt-doc-item" data-doc-idx="${i}">
            <span>${escapeHtml(d.full_name)}</span>
            <span class="sub">${escapeHtml(formatPhone(d.phone))}${d.specialty ? ' · ' + escapeHtml(d.specialty) : ''}</span>
          </button>`).join('')
      : '<div class="pt-doc-none">No doctor matches - switch to “New doctor” to add them.</div>';
    docResults.classList.add('open');
    docResults.querySelectorAll('[data-doc-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedDoctor = matches[Number(btn.dataset.docIdx)];
        docResults.classList.remove('open');
        drawDoctorChip();
      });
    });
  }
  docSearch?.addEventListener('input', drawDoctorResults);
  docSearch?.addEventListener('focus', drawDoctorResults);

  // ---- price hint from settings.pricing ----
  const careEl = $('#rc-care');
  const priceHint = $('#rc-price-hint');
  function drawPriceHint() {
    const def = pricing[careEl.value];
    priceHint.textContent = (def !== undefined && def !== null && careEl.value)
      ? `Standard price for ${careTypeLabel(careEl.value)}: ${formatINR(def)} - leave blank to use it.`
      : '';
  }
  careEl.addEventListener('change', drawPriceHint);

  // ---- submit ----
  submitBtn.addEventListener('click', async () => {
    if (submitting) return;
    const errors = [];

    // Patient
    let patientPayload = null;
    if (!existingPatient) {
      const name = $('#rp-name').value.trim();
      const phoneV = validateIndianPhone($('#rp-phone').value);
      const same = $('#rp-wa-same').checked;
      const waV = same ? phoneV : validateIndianPhone($('#rp-wa').value);
      const cancer = $('#rp-cancer').value.trim();
      const address = $('#rp-address').value.trim();
      const pincode = $('#rp-pincode').value.trim();
      const pinErr = validatePinCode(pincode);
      if (!name) fail(errors, $('#rp-name'), 'Patient name is required');
      if (!phoneV.ok) fail(errors, $('#rp-phone'), `Patient phone: ${phoneV.error}`);
      if (!same && !waV.ok) fail(errors, $('#rp-wa'), `WhatsApp number: ${waV.error}`);
      if (!cancer) fail(errors, $('#rp-cancer'), 'Cancer type is required');
      if (!address) fail(errors, $('#rp-address'), 'Patient address is required');
      if (pinErr) fail(errors, $('#rp-pincode'), pinErr);
      const pocPhoneRaw = $('#rp-poc-phone')?.value.trim() ?? '';
      let pocPhoneNorm = null;
      if (pocPhoneRaw) {
        const pocV = validateIndianPhone(pocPhoneRaw);
        if (!pocV.ok) fail(errors, $('#rp-poc-phone'), `POC number: ${pocV.error}`);
        else pocPhoneNorm = pocV.normalized;
      }
      patientPayload = {
        full_name: name,
        phone: phoneV.normalized,
        wa_number: waV.normalized,
        cancer_type: cancer,
        address,
        locality: $('#rp-locality').value.trim() || null,
        pincode: pincode || null,
        language_pref: overlay.querySelector('input[name="rp-lang"]:checked')?.value || 'en',
        notes: $('#rp-notes').value.trim() || null,
        poc_name: $('#rp-poc-name')?.value.trim() || null,
        poc_phone: pocPhoneNorm,
      };
    }

    // Doctor
    let doctorPayload = null;
    let doctorId = null;
    if (docMode === 'existing') {
      if (!selectedDoctor) fail(errors, docSearch, 'Pick a referring doctor, or choose “New doctor” / “No doctor”');
      else doctorId = selectedDoctor.id;
    } else if (docMode === 'new') {
      const dn = $('#rd-name').value.trim();
      const dpV = validateIndianPhone($('#rd-phone').value);
      if (!dn) fail(errors, $('#rd-name'), 'Doctor name is required');
      if (!dpV.ok) fail(errors, $('#rd-phone'), `Doctor phone: ${dpV.error}`);
      doctorPayload = {
        full_name: dn,
        phone: dpV.normalized,
        language_pref: overlay.querySelector('input[name="rd-lang"]:checked')?.value || 'en',
      };
    }

    // Case
    const lineType = $('#rc-line').value;
    const careType = $('#rc-care').value;
    const whenLocal = $('#rc-when').value;
    const scheduledIso = istToIso(whenLocal);
    const caseAddress = $('#rc-address').value.trim();
    const priceRaw = $('#rc-price').value.trim();
    let priceInr = null;
    if (!lineType) fail(errors, $('#rc-line'), 'Select the line type');
    if (!careType) fail(errors, $('#rc-care'), 'Select the care type');
    if (!scheduledIso) fail(errors, $('#rc-when'), 'Set the session date & time (IST)');
    if (!caseAddress) fail(errors, $('#rc-address'), 'Session address is required');
    if (priceRaw !== '') {
      priceInr = Number(priceRaw);
      if (!isFinite(priceInr) || priceInr < 0 || priceInr > 99999999) {
        fail(errors, $('#rc-price'), 'Price override must be a valid amount');
      }
    }

    // Nurse (optional). Only validated in 'direct' mode - the whole point of
    // the default is that leaving it alone is correct.
    const directNurseId = nurseMode === 'direct' ? (nurseSelect?.value || '') : '';
    if (nurseMode === 'direct' && !directNurseId) {
      fail(errors, nurseSelect, 'Pick the nurse, or switch back to “Offer to the pool”');
    }

    // Discharge PDF
    const file = $('#rc-pdf').files[0] || null;
    if (file) {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
      if (!isPdf) fail(errors, $('#rc-pdf'), 'Discharge summary must be a PDF file');
      else if (file.size > 50 * 1024 * 1024) fail(errors, $('#rc-pdf'), 'Discharge PDF is too large (max 50 MB)');
    }

    if (reportErrors(errors)) return;

    submitting = true;
    busyButton(submitBtn, true, SUBMIT_LABEL);
    try {
      let dischargePath = null;
      if (file) {
        dischargePath = await uploadCaseDoc(file, 'discharge');
      }

      const params = {
        line_type: lineType,
        care_type: careType,
        scheduled_at: scheduledIso,
        address: caseAddress,
        equipment_notes: $('#rc-equip').value.trim() || null,
        price_inr: priceInr,
        supplier_ids: Array.from(overlay.querySelectorAll('#rc-sups input:checked')).map((i) => i.value),
        notes: $('#rc-notes').value.trim() || null,
        discharge_upload_path: dischargePath,
      };
      if (existingPatient) params.patient_id = existingPatient.id;
      else params.patient = patientPayload;
      if (doctorId) params.doctor_id = doctorId;
      if (doctorPayload) params.doctor = doctorPayload;
      // Omitted entirely on the normal path: register_case branches on the key
      // being present, so sending nurse_id: null would be the same as absent
      // but reads like an intention nobody had.
      if (directNurseId) params.nurse_id = directNurseId;

      const res = await adminAction('register_case', params);
      const code = res?.case_code || 'Case';
      // res.assigned is the server's answer, not ours: it says "we accepted a
      // nurse", so the toast reports what actually happened rather than what
      // the form asked for.
      const nurseName = nurses.find((n) => n.id === directNurseId)?.full_name || 'the nurse';
      showToast(
        res?.assigned
          ? `${code} registered - ${nurseName} assigned directly, no offers sent to anyone else`
          : `${code} registered - offers are going to the nurse pool now`,
        'success', 6000);
      closeModal();
      if (res?.case_id) navigate(`cases/${res.case_id}`);
      else navigate('cases');
    } catch (err) {
      console.error('[patients] register_case failed:', err);
      // The three nurse 400s arrive as bare error codes (adminAction hands the
      // page body.error as a string). They all fire BEFORE the case row is
      // inserted, so nothing was created and re-submitting is safe - say so,
      // because "nurse_inactive" on its own reads like a half-made case.
      const nurseName = nurses.find((n) => n.id === directNurseId)?.full_name || 'That nurse';
      const NURSE_ERRORS = {
        nurse_not_found: `${nurseName} is no longer on file. Close and reopen this form, then pick again. Nothing was created.`,
        nurse_inactive: `${nurseName} has been deactivated since this form opened. Pick someone else or switch back to “Offer to the pool”. Nothing was created.`,
        nurse_opted_out: `${nurseName} has sent STOP on WhatsApp, so she would never receive the case. Pick someone else or switch back to “Offer to the pool”. Nothing was created.`,
      };
      const friendly = NURSE_ERRORS[String(err.message || '').trim()];
      if (friendly) markError(nurseSelect);
      showToast(friendly || err.message || 'Registration failed', 'error', friendly ? 9000 : 7000);
      submitting = false;
      busyButton(submitBtn, false, SUBMIT_LABEL);
    }
  });
}

// ============================================================
// DETAIL - #patients/:id
// ============================================================
async function renderDetail(container, id) {
  container.innerHTML = renderSkeleton(6);

  const sb = getSupabase();
  const [patientRes, casesRes] = await Promise.all([
    sb.from('patients').select('*').eq('id', id).maybeSingle(),
    sb.from('cases')
      .select('id, case_code, status, line_type, care_type, scheduled_at, price_inr, created_at, nurse:nurses(full_name)')
      .eq('patient_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (patientRes.error) {
    console.error('[patients] detail load failed:', patientRes.error);
    errorState(container, 'Could not load this patient', patientRes.error, 'Retry', () => renderDetail(container, id));
    return;
  }
  const patient = patientRes.data;
  if (!patient) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a7.5 7.5 0 0 1 13 0"/></svg>
        <h3>Patient not found</h3>
        <p>This patient may have been removed, or the link is stale.</p>
        <a class="btn btn-secondary" href="#patients">Back to all patients</a>
      </div>`;
    return;
  }
  if (casesRes.error) console.error('[patients] case history load failed:', casesRes.error);
  const cases = casesRes.data || [];
  const openCases = cases.filter((c) => !OPEN_EXCLUDE.includes(c.status)).length;

  container.innerHTML = `
    <div class="pt-back"><a href="#patients">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>
      All patients</a>
    </div>
    <div class="detail-head">
      <div class="detail-id">
        <div class="avatar avatar-lg" style="background: var(--grad-primary)">${escapeHtml(initials(patient.full_name))}</div>
        <div class="detail-name">
          <h1>${escapeHtml(patient.full_name)}</h1>
          <div class="detail-sub">
            <span class="cell-mono">${escapeHtml(patient.patient_code)}</span>
            ${langBadge(patient.language_pref)}
            ${patient.opted_out ? '<span class="badge badge-danger">Opted out of WhatsApp</span>' : ''}
            ${openCases ? `<span class="badge badge-primary">${openCases} open case${openCases === 1 ? '' : 's'}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="detail-actions">
        <div class="pt-seg" aria-label="Message language">
          <button type="button" id="pt-lang-en" class="${patient.language_pref === 'en' ? 'on' : ''}">English</button>
          <button type="button" id="pt-lang-hi" class="${patient.language_pref === 'hi' ? 'on' : ''}">हिंदी</button>
        </div>
        <button class="btn btn-secondary" id="pt-edit-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          Edit
        </button>
        <button class="btn ${patient.opted_out ? 'btn-secondary' : 'btn-danger'}" id="pt-optout-btn">
          ${patient.opted_out ? 'Reactivate messages' : 'Mark opted out'}
        </button>
        <div class="dropdown pt-step-split" id="pt-step-dd">
          <button class="btn btn-primary pt-step-main" id="pt-newcase-btn" title="Kick off a fresh care journey for this patient">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
            Start care journey
          </button>
          <button class="btn btn-primary pt-step-caret" id="pt-step-toggle" aria-haspopup="true" aria-expanded="false" title="Send a single step now on an open case">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="dropdown-menu pt-step-menu" id="pt-step-menu" role="menu"></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="kv">
        <div><div class="k">Phone</div><div class="v cell-mono">${escapeHtml(formatPhone(patient.phone))}</div></div>
        <div><div class="k">WhatsApp</div><div class="v cell-mono">${escapeHtml(formatPhone(patient.wa_number))}</div></div>
        <div><div class="k">Cancer type</div><div class="v">${escapeHtml(patient.cancer_type || '-')}</div></div>
        <div><div class="k">Locality</div><div class="v ${patient.locality ? '' : 'dim'}">${escapeHtml(patient.locality || 'Not set')}</div></div>
        <div><div class="k">PIN code</div><div class="v ${patient.pincode ? '' : 'dim'}">${escapeHtml(patient.pincode || 'Not set')}</div></div>
        <div><div class="k">Registered</div><div class="v">${escapeHtml(formatDateTime(patient.created_at))}</div></div>
        <div><div class="k">Carcinome POC</div><div class="v ${patient.poc_phone ? '' : 'dim'}">${patient.poc_phone ? `${escapeHtml(patient.poc_name || 'POC')} · ${escapeHtml(formatPhone(patient.poc_phone))}` : 'Not set'}</div></div>
        <div style="grid-column: 1 / -1"><div class="k">Address</div><div class="v pt-addr">${escapeHtml(patient.address || '-')}</div></div>
        ${patient.notes ? `<div style="grid-column: 1 / -1"><div class="k">Notes</div><div class="v pt-addr">${escapeHtml(patient.notes)}</div></div>` : ''}
      </div>
    </div>

    <div class="card card-flush pt-cases-card">
      <div class="card-head">
        <h3>Case history</h3>
        <span class="badge badge-neutral">${cases.length} total</span>
      </div>
      ${cases.length ? `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>Case</th><th>Status</th><th>Care</th><th>Line</th>
              <th>Scheduled (IST)</th><th>Nurse</th><th>Price</th>
            </tr></thead>
            <tbody id="pt-cases-tbody">
              ${cases.map((c) => `
                <tr class="row-link" data-case-id="${escapeHtml(c.id)}" tabindex="0">
                  <td class="cell-mono">${escapeHtml(c.case_code)}</td>
                  <td>${caseStatusBadge(c.status)}</td>
                  <td>${escapeHtml(careTypeLabel(c.care_type))}</td>
                  <td>${escapeHtml(lineTypeLabel(c.line_type))}</td>
                  <td>${escapeHtml(formatDateTime(c.scheduled_at))}</td>
                  <td class="${c.nurse?.full_name ? '' : 'hint'}">${escapeHtml(c.nurse?.full_name || '-')}</td>
                  <td class="cell-num">${c.price_inr != null ? escapeHtml(formatINR(c.price_inr)) : '-'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `
        <div class="empty-state" style="padding: var(--s6)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <h3>No cases yet</h3>
          <p>Start the first care session for ${escapeHtml(patient.full_name)} - nurse offers and equipment prep fire from one form.</p>
          <button class="btn btn-primary" id="pt-empty-newcase">Register a case</button>
        </div>`}
    </div>`;

  const refresh = () => renderDetail(container, id);

  // Case row navigation
  const casesTbody = container.querySelector('#pt-cases-tbody');
  if (casesTbody) {
    const go = (e) => {
      const row = e.target.closest('tr[data-case-id]');
      if (row) navigate(`cases/${row.dataset.caseId}`);
    };
    casesTbody.addEventListener('click', go);
    casesTbody.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e); });
  }

  // New case (existing patient prefilled). "Start care journey" = the kickoff.
  const openNewCase = () => openRegisterModal(patient);
  container.querySelector('#pt-newcase-btn')?.addEventListener('click', openNewCase);
  container.querySelector('#pt-empty-newcase')?.addEventListener('click', openNewCase);

  // "Send a step now" menu (the ▾ next to Start care journey)
  wireManualSteps(container, patient, cases, () => renderDetail(container, id));

  // Language toggle - direct table update
  async function setLang(lang) {
    if (lang === patient.language_pref) return;
    const { error } = await sb.from('patients').update({ language_pref: lang }).eq('id', id);
    if (error) {
      console.error('[patients] language update failed:', error);
      showToast(error.message || 'Could not update language', 'error');
      return;
    }
    showToast(`Messages to ${patient.full_name} will now go out in ${lang === 'hi' ? 'Hindi' : 'English'}`, 'success');
    refresh();
  }
  container.querySelector('#pt-lang-en')?.addEventListener('click', () => setLang('en'));
  container.querySelector('#pt-lang-hi')?.addEventListener('click', () => setLang('hi'));

  // Opt-out toggle - confirmed, direct table update
  container.querySelector('#pt-optout-btn')?.addEventListener('click', () => {
    const optingOut = !patient.opted_out;
    confirmModal(
      optingOut
        ? `Stop all WhatsApp messages to <strong>${escapeHtml(patient.full_name)}</strong>? Reminders, invoices and care updates will no longer be sent to them.`
        : `Resume WhatsApp messages to <strong>${escapeHtml(patient.full_name)}</strong>? Only do this if the patient asked to hear from us again.`,
      async () => {
        const { error } = await sb.from('patients').update({ opted_out: optingOut }).eq('id', id);
        if (error) {
          console.error('[patients] opt-out update failed:', error);
          showToast(error.message || 'Could not update opt-out status', 'error');
          return;
        }
        showToast(optingOut ? 'Patient marked as opted out' : 'Patient messages reactivated', 'success');
        refresh();
      },
      {
        title: optingOut ? 'Mark opted out' : 'Reactivate messages',
        confirmLabel: optingOut ? 'Stop messages' : 'Reactivate',
        danger: optingOut,
      },
    );
  });

  // Edit modal - direct table update
  container.querySelector('#pt-edit-btn')?.addEventListener('click', () => openEditModal(patient, refresh));
}

// ------------------------------------------------------------
// wireManualSteps: the "Send a step now ▾" menu next to Start care
// journey. Sends a single WhatsApp step (consent / OTP / availability /
// feedback / invoice) on demand against one of the patient's live cases.
// The whole journey still kicks off from "Start care journey"; this is
// for re-sending a step that did not land, or nudging one manually.
// ------------------------------------------------------------
function wireManualSteps(container, patient, cases, refresh) {
  const dd = container.querySelector('#pt-step-dd');
  const toggle = container.querySelector('#pt-step-toggle');
  const menu = container.querySelector('#pt-step-menu');
  if (!dd || !toggle || !menu) return;

  const liveCases = (cases || []).filter((c) => !OPEN_EXCLUDE.includes(c.status));
  let targetId = liveCases[0]?.id || null;
  let firing = false;

  const paintMenu = () => {
    if (!liveCases.length) {
      menu.innerHTML = `
        <div class="pt-step-head">Send a step now</div>
        <p class="pt-step-empty">No open case for ${escapeHtml(patient.full_name)}. Use <strong>Start care journey</strong> to begin one; every step then fires automatically.</p>`;
      return;
    }
    const target = liveCases.find((c) => c.id === targetId) || liveCases[0];
    const status = target.status;
    const picker = liveCases.length > 1
      ? `<div class="pt-step-case">
           <label for="pt-step-case-sel">Act on case</label>
           <select class="form-select" id="pt-step-case-sel">
             ${liveCases.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === target.id ? 'selected' : ''}>${escapeHtml(c.case_code)} · ${escapeHtml(caseStatusLabelSafe(c.status))}</option>`).join('')}
           </select>
         </div>`
      : `<div class="pt-step-target">On <strong>${escapeHtml(target.case_code)}</strong> · ${escapeHtml(caseStatusLabelSafe(status))}</div>`;

    menu.innerHTML = `
      <div class="pt-step-head">Send a step now</div>
      ${picker}
      <div class="dropdown-divider"></div>
      ${MANUAL_STEPS.map((s) => {
        const ok = s.statuses.includes(status);
        return `<button class="dropdown-item pt-step-item" role="menuitem" data-step="${s.key}" ${ok ? '' : 'disabled'}
          title="${ok ? `Send now on ${escapeHtml(target.case_code)}` : `Not available while the case is “${escapeHtml(caseStatusLabelSafe(status))}”`}">
          <span class="pt-step-emoji">${s.emoji}</span><span class="pt-step-lbl">${escapeHtml(s.label)}</span>
        </button>`;
      }).join('')}`;

    const sel = menu.querySelector('#pt-step-case-sel');
    sel?.addEventListener('change', () => { targetId = sel.value; paintMenu(); });
  };

  const isOpen = () => menu.classList.contains('active');
  // Outside-click / Escape live only while the menu is open, then unbind:
  // renderDetail re-renders on every refresh, so persistent document
  // listeners would pile up.
  const onDocClick = (e) => { if (!dd.contains(e.target)) close(); };
  const onDocKey = (e) => { if (e.key === 'Escape') close(); };
  const open = () => {
    paintMenu();
    menu.classList.add('active');
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
  };
  const close = () => {
    menu.classList.remove('active');
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
  };

  toggle.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-step]');
    if (!item || item.disabled || firing) return;
    const step = MANUAL_STEPS.find((s) => s.key === item.dataset.step);
    if (!step || !targetId) return;
    firing = true;
    const orig = item.innerHTML;
    item.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      await adminAction(step.action, { case_id: targetId });
      showToast(step.success, 'success');
      close();
      refresh();
    } catch (err) {
      console.error('[patients] manual step failed:', step.action, err);
      showToast(err.message || 'Could not send that step', 'error');
      if (item.isConnected) item.innerHTML = orig;
    } finally {
      firing = false;
    }
  });
}

// Local status label: mirrors formatters.caseStatusLabel without a hard
// import dependency (keeps the menu resilient if a new status appears).
function caseStatusLabelSafe(status) {
  try { return caseStatusLabel(status); } catch { return String(status || 'unknown'); }
}

// ------------------------------------------------------------
// Edit patient fields (direct table update under RLS)
// ------------------------------------------------------------
function openEditModal(patient, onSaved) {
  const sb = getSupabase();
  let saving = false;

  const overlay = showModal({
    title: `Edit - ${escapeHtml(patient.full_name)}`,
    size: 'lg',
    content: `
      <form id="pe-form" novalidate>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="pe-name">Full name <span class="required">*</span></label>
            <input class="form-input" id="pe-name" type="text" value="${escapeHtml(patient.full_name)}" />
          </div>
          <div class="form-group">
            <label class="form-label" for="pe-cancer">Cancer type <span class="required">*</span></label>
            <input class="form-input" id="pe-cancer" type="text" list="pe-cancer-list" value="${escapeHtml(patient.cancer_type || '')}" />
            <datalist id="pe-cancer-list">${CANCER_TYPE_SUGGESTIONS.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="pe-phone">Phone <span class="required">*</span></label>
            <input class="form-input" id="pe-phone" type="tel" inputmode="numeric" value="${escapeHtml(patient.phone)}" />
          </div>
          <div class="form-group">
            <label class="form-label" for="pe-wa">WhatsApp number <span class="required">*</span></label>
            <input class="form-input" id="pe-wa" type="tel" inputmode="numeric" value="${escapeHtml(patient.wa_number)}" />
            <span class="form-hint">Changing this moves future messages to the new number.</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="pe-address">Address <span class="required">*</span></label>
          <textarea class="form-textarea" id="pe-address" rows="2">${escapeHtml(patient.address || '')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="pe-locality">Locality</label>
            <input class="form-input" id="pe-locality" type="text" value="${escapeHtml(patient.locality || '')}" />
          </div>
          <div class="form-group">
            <label class="form-label" for="pe-pincode">PIN code</label>
            <input class="form-input" id="pe-pincode" type="text" inputmode="numeric" maxlength="6" value="${escapeHtml(patient.pincode || '')}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="pe-poc-name">Carcinome POC name</label>
            <input class="form-input" id="pe-poc-name" type="text" value="${escapeHtml(patient.poc_name || '')}" placeholder="Intern who owns this family" />
          </div>
          <div class="form-group">
            <label class="form-label" for="pe-poc-phone">POC WhatsApp number</label>
            <input class="form-input" id="pe-poc-phone" type="tel" inputmode="numeric" value="${escapeHtml(patient.poc_phone || '')}" placeholder="Gets milestone logs + STATUS digests" />
            <span class="form-hint">Applied to NEW cases registered after this change.</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="pe-notes">Notes</label>
          <textarea class="form-textarea" id="pe-notes" rows="2">${escapeHtml(patient.notes || '')}</textarea>
        </div>
      </form>`,
    footer: `
      <button class="btn btn-secondary" data-pe-cancel>Cancel</button>
      <button class="btn btn-primary" data-pe-save>Save changes</button>`,
  });

  const $ = (sel) => overlay.querySelector(sel);
  overlay.querySelector('[data-pe-cancel]').addEventListener('click', () => closeModal());

  const saveBtn = overlay.querySelector('[data-pe-save]');
  saveBtn.addEventListener('click', async () => {
    if (saving) return;
    const errors = [];
    const name = $('#pe-name').value.trim();
    const cancer = $('#pe-cancer').value.trim();
    const phoneV = validateIndianPhone($('#pe-phone').value);
    const waV = validateIndianPhone($('#pe-wa').value);
    const address = $('#pe-address').value.trim();
    const pincode = $('#pe-pincode').value.trim();
    const pinErr = validatePinCode(pincode);

    if (!name) fail(errors, $('#pe-name'), 'Name is required');
    if (!cancer) fail(errors, $('#pe-cancer'), 'Cancer type is required');
    if (!phoneV.ok) fail(errors, $('#pe-phone'), `Phone: ${phoneV.error}`);
    if (!waV.ok) fail(errors, $('#pe-wa'), `WhatsApp number: ${waV.error}`);
    if (!address) fail(errors, $('#pe-address'), 'Address is required');
    if (pinErr) fail(errors, $('#pe-pincode'), pinErr);
    const pocPhoneRaw = $('#pe-poc-phone').value.trim();
    let pocPhoneNorm = null;
    if (pocPhoneRaw) {
      const pocV = validateIndianPhone(pocPhoneRaw);
      if (!pocV.ok) fail(errors, $('#pe-poc-phone'), `POC number: ${pocV.error}`);
      else pocPhoneNorm = pocV.normalized;
    }
    if (reportErrors(errors)) return;

    saving = true;
    busyButton(saveBtn, true, 'Save changes');
    try {
      const { error } = await sb.from('patients').update({
        full_name: name,
        cancer_type: cancer,
        phone: phoneV.normalized,
        wa_number: waV.normalized,
        address,
        locality: $('#pe-locality').value.trim() || null,
        pincode: pincode || null,
        notes: $('#pe-notes').value.trim() || null,
        poc_name: $('#pe-poc-name').value.trim() || null,
        poc_phone: pocPhoneNorm,
      }).eq('id', patient.id);
      if (error) throw new Error(error.message || 'Update failed');
      showToast('Patient updated', 'success');
      closeModal();
      if (typeof onSaved === 'function') onSaved();
    } catch (err) {
      console.error('[patients] edit save failed:', err);
      showToast(err.message || 'Could not save changes', 'error');
      saving = false;
      busyButton(saveBtn, false, 'Save changes');
    }
  });
}
