// ============================================================
// Carcinome Home Care — #settings
// Editable cards backed by the settings table (key/value jsonb,
// saved via upsert), WhatsApp template health (wa_templates),
// admin password change, and read-only endpoint reference.
// ============================================================

import { CONFIG } from '../config.js';
import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import {
  escapeHtml, formatDateTime, careTypeLabel, CARE_TYPES,
} from '../utils/formatters.js';
import { validateIndianPhone, validatePassword } from '../utils/validators.js';

// ---- page-scoped styles (injected once) ----
const STYLE_ID = 'settings-page-styles';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: var(--s5); align-items: start; }
    .settings-grid .card { min-width: 0; }
    .settings-span { grid-column: 1 / -1; }
    .sp-price-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding: 9px 0; border-bottom: 1px solid var(--line); }
    .sp-price-row:last-of-type { border-bottom: none; }
    .sp-price-row .sp-price-lbl { font: var(--t-sm); font-weight: 600; color: var(--ink); }
    .sp-price-row .sp-inr { position: relative; width: 132px; flex: none; }
    .sp-price-row .sp-inr::before { content: "\\20B9"; position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--ink-3); font: var(--t-sm); pointer-events: none; }
    .sp-price-row .sp-inr input { padding-left: 26px; text-align: right; font-variant-numeric: tabular-nums; }
    .sp-chips { display: flex; flex-wrap: wrap; gap: 8px; min-height: 34px; align-items: center; }
    .sp-chip { display: inline-flex; align-items: center; gap: 7px; padding: 5px 6px 5px 12px; background: var(--primary-soft); color: var(--primary); border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: var(--r-pill); font: var(--t-mono); font-size: 12px; font-weight: 600; }
    .sp-chip button { display: grid; place-items: center; width: 18px; height: 18px; border: none; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; padding: 0; line-height: 1; font-size: 13px; opacity: 0.75; }
    .sp-chip button:hover { opacity: 1; background: color-mix(in srgb, currentColor 15%, transparent); }
    .sp-chips-empty { font: var(--t-xs); color: var(--ink-4); font-style: italic; }
    .sp-chip-add { display: flex; gap: var(--s2); margin-top: var(--s3); }
    .sp-chip-add .form-input { flex: 1; min-width: 0; }
    .sp-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding: 11px 0; border-bottom: 1px solid var(--line); }
    .sp-toggle-row:last-of-type { border-bottom: none; }
    .sp-toggle-row .sp-toggle-name { font: var(--t-sm); font-weight: 600; color: var(--ink); }
    .sp-toggle-row .sp-toggle-desc { font: var(--t-xs); color: var(--ink-3); margin-top: 2px; }
    .sp-endpoint { display: flex; align-items: center; gap: var(--s2); margin-top: var(--s2); }
    .sp-endpoint code { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; color: var(--ink-2); background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 9px 12px; overflow-x: auto; white-space: nowrap; scrollbar-width: thin; }
    .sp-note { display: flex; gap: 9px; align-items: flex-start; font: var(--t-xs); color: var(--ink-3); margin-top: var(--s3); }
    .sp-note code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-xs); padding: 1px 6px; white-space: nowrap; }
    .sp-save-row { display: flex; justify-content: flex-end; padding-top: var(--s4); margin-top: var(--s3); border-top: 1px solid var(--line); }
    @media (max-width: 720px) { .settings-grid { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(style);
}

// ---- settings keys this page manages ----
const KEYS = [
  'pricing', 'upi_vpa', 'business_name', 'supervisor_phones', 'ops_phones',
  'sla_offer_hours', 'otp_ttl_min', 'toggles', 'availability',
];

const TOGGLE_DEFS = [
  { key: 'relay', name: 'Relay hub', desc: 'Fan participant messages out to the rest of the case group.' },
  { key: 'reminders', name: 'Session reminders', desc: '24-hour and morning-of reminders to patients and nurses.' },
  { key: 'feedback_chaser', name: 'Feedback chaser', desc: 'Follow up when a feedback form goes unanswered.' },
];

const PHONE_LISTS = [
  { key: 'supervisor_phones', title: 'Supervisor numbers', desc: 'Receive SLA nudges and OTP-lockout alerts. Added to every case.' },
  { key: 'ops_phones', title: 'Ops numbers', desc: 'Joined to every case relay hub as the Carcinome ops voice.' },
];

// ---- module state (rebuilt on each render) ----
let S = null; // { settings: Map, saving: Set }

function sval(key, fallback) {
  const v = S.settings.get(key);
  return v === undefined || v === null ? fallback : v;
}

async function loadSettings(sb) {
  const { data, error } = await sb.from('settings').select('key, value').in('key', KEYS);
  if (error) throw new Error(error.message || 'Could not load settings');
  const map = new Map();
  for (const row of data || []) map.set(row.key, row.value);
  return map;
}

// Upsert one settings key. Returns true on success (toasts either way).
async function saveSetting(key, value, successMsg) {
  const sb = getSupabase();
  const profile = getCurrentProfile();
  const { error } = await sb.from('settings').upsert(
    { key, value, updated_at: new Date().toISOString(), updated_by: profile?.id ?? null },
    { onConflict: 'key' },
  );
  if (error) {
    console.error('[settings] save failed:', key, error);
    showToast(error.message || `Could not save ${key}`, 'error');
    return false;
  }
  S.settings.set(key, value);
  showToast(successMsg || 'Saved', 'success');
  return true;
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>'; }
  else if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success', 2000);
  } catch {
    showToast('Could not copy — select the text manually', 'warning');
  }
}

// ============================================================ PRICING
function renderPricing(el) {
  const pricing = sval('pricing', {});
  el.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">Pricing</div>
        <div class="card-subtitle">Default price per care type. Editable per case at registration.</div>
      </div>
    </div>
    ${CARE_TYPES.map(ct => `
      <div class="sp-price-row">
        <span class="sp-price-lbl">${escapeHtml(careTypeLabel(ct))}</span>
        <span class="sp-inr">
          <input class="form-input" type="number" min="0" step="50" inputmode="numeric"
                 data-price="${ct}" value="${pricing[ct] != null ? escapeHtml(String(pricing[ct])) : ''}" placeholder="0" />
        </span>
      </div>
    `).join('')}
    <div class="sp-save-row"><button class="btn btn-primary btn-sm" data-save-pricing>Save pricing</button></div>
  `;
  el.querySelector('[data-save-pricing]').addEventListener('click', async (e) => {
    const next = {};
    for (const ct of CARE_TYPES) {
      const raw = el.querySelector(`[data-price="${ct}"]`).value.trim();
      const n = Number(raw);
      if (raw === '' || isNaN(n) || n < 0) {
        showToast(`Enter a valid price for "${careTypeLabel(ct)}"`, 'warning');
        return;
      }
      next[ct] = Math.round(n * 100) / 100;
    }
    busy(e.currentTarget, true);
    const ok = await saveSetting('pricing', next, 'Pricing updated');
    busy(el.querySelector('[data-save-pricing]'), false);
    if (ok) renderPricing(el);
  });
}

// ============================================================ BILLING (UPI + business name)
function renderBilling(el) {
  el.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">Billing identity</div>
        <div class="card-subtitle">Used on invoices and the WhatsApp UPI Pay button.</div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="sp-upi">UPI VPA</label>
      <input class="form-input" id="sp-upi" type="text" autocomplete="off" spellcheck="false"
             value="${escapeHtml(String(sval('upi_vpa', '')))}" placeholder="carcinome@upi" />
      <span class="form-hint">Patients pay this ID directly — double-check before saving.</span>
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label class="form-label" for="sp-bizname">Business name</label>
      <input class="form-input" id="sp-bizname" type="text"
             value="${escapeHtml(String(sval('business_name', '')))}" placeholder="Carcinome Home Care" />
      <span class="form-hint">Shown as the payee on order details and invoices.</span>
    </div>
    <div class="sp-save-row"><button class="btn btn-primary btn-sm" data-save-billing>Save billing</button></div>
  `;
  el.querySelector('[data-save-billing]').addEventListener('click', async () => {
    const vpa = el.querySelector('#sp-upi').value.trim();
    const biz = el.querySelector('#sp-bizname').value.trim();
    if (!/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(vpa)) {
      showToast('Enter a valid UPI VPA, e.g. carcinome@upi', 'warning');
      return;
    }
    if (!biz) { showToast('Business name is required', 'warning'); return; }

    const doSave = async () => {
      const btn = el.querySelector('[data-save-billing]');
      busy(btn, true);
      const ok1 = await saveSetting('upi_vpa', vpa, 'UPI VPA updated');
      const ok2 = await saveSetting('business_name', biz, 'Business name updated');
      busy(el.querySelector('[data-save-billing]'), false);
      if (ok1 && ok2) renderBilling(el);
    };

    // Changing where money lands is destructive-adjacent — always confirm.
    if (vpa !== String(sval('upi_vpa', ''))) {
      confirmModal(
        `Future invoices and Pay buttons will direct payments to <strong>${escapeHtml(vpa)}</strong>. Continue?`,
        doSave,
        { title: 'Change UPI VPA?', confirmLabel: 'Yes, change it', danger: true },
      );
    } else {
      await doSave();
    }
  });
}

// ============================================================ PHONE CHIP LISTS
function renderPhoneCard(el, def) {
  const phones = Array.isArray(sval(def.key, [])) ? sval(def.key, []) : [];
  el.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">${escapeHtml(def.title)}</div>
        <div class="card-subtitle">${escapeHtml(def.desc)}</div>
      </div>
    </div>
    <div class="sp-chips">
      ${phones.length
        ? phones.map(p => `
            <span class="sp-chip">${escapeHtml(String(p))}
              <button type="button" data-remove-phone="${escapeHtml(String(p))}" aria-label="Remove ${escapeHtml(String(p))}">&times;</button>
            </span>`).join('')
        : `<span class="sp-chips-empty">No numbers yet — new cases won't include this role until one is added.</span>`}
    </div>
    <div class="sp-chip-add">
      <input class="form-input" type="tel" inputmode="tel" placeholder="98765 43210" data-phone-input autocomplete="off" />
      <button class="btn btn-secondary btn-sm" data-add-phone>Add</button>
    </div>
  `;

  const input = el.querySelector('[data-phone-input]');
  const addBtn = el.querySelector('[data-add-phone]');

  const addPhone = async () => {
    const res = validateIndianPhone(input.value);
    if (!res.ok) { showToast(res.error, 'warning'); input.focus(); return; }
    if (phones.includes(res.normalized)) {
      showToast('That number is already on the list', 'info');
      input.value = ''; return;
    }
    busy(addBtn, true);
    const ok = await saveSetting(def.key, [...phones, res.normalized], `${def.title}: number added`);
    busy(el.querySelector('[data-add-phone]'), false);
    if (ok) renderPhoneCard(el, def);
  };

  addBtn.addEventListener('click', addPhone);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPhone(); } });

  el.querySelectorAll('[data-remove-phone]').forEach(btn => {
    btn.addEventListener('click', () => {
      const phone = btn.getAttribute('data-remove-phone');
      confirmModal(
        `Remove <strong>${escapeHtml(phone)}</strong> from ${escapeHtml(def.title.toLowerCase())}? It will no longer be added to new cases (existing cases keep their participants).`,
        async () => {
          const ok = await saveSetting(def.key, phones.filter(p => String(p) !== phone), 'Number removed');
          if (ok) renderPhoneCard(el, def);
        },
        { title: 'Remove number?', confirmLabel: 'Remove', danger: true },
      );
    });
  });
}

// ============================================================ AUTOMATION (SLA + OTP + toggles)
function renderAutomation(el) {
  const toggles = sval('toggles', {});
  const avail = sval('availability', {});
  el.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">Automation</div>
        <div class="card-subtitle">Scheduler behavior and safety timers.</div>
      </div>
    </div>
    <div class="form-row" style="margin-bottom:var(--s2)">
      <div class="form-group">
        <label class="form-label" for="sp-sla">Offer SLA (hours)</label>
        <input class="form-input" id="sp-sla" type="number" min="1" max="72" step="1" inputmode="numeric"
               value="${escapeHtml(String(sval('sla_offer_hours', 6)))}" />
        <span class="form-hint">No nurse accepted in this window → supervisor nudge.</span>
      </div>
      <div class="form-group">
        <label class="form-label" for="sp-otp">OTP validity (minutes)</label>
        <input class="form-input" id="sp-otp" type="number" min="5" max="240" step="5" inputmode="numeric"
               value="${escapeHtml(String(sval('otp_ttl_min', 30)))}" />
        <span class="form-hint">Arrival codes expire after this long.</span>
      </div>
    </div>
    <div class="form-row" style="margin-bottom:var(--s2)">
      <div class="form-group">
        <label class="form-label" for="sp-avail-timeout">Availability reply window (minutes)</label>
        <input class="form-input" id="sp-avail-timeout" type="number" min="2" max="180" step="1" inputmode="numeric"
               value="${escapeHtml(String(avail.timeout_min ?? 20))}" />
        <span class="form-hint">"Are you going?" unanswered this long → the standby nurse is triggered.</span>
      </div>
      <div class="form-group">
        <label class="form-label" for="sp-avail-before">Auto-check before session (minutes)</label>
        <input class="form-input" id="sp-avail-before" type="number" min="15" max="720" step="15" inputmode="numeric"
               value="${escapeHtml(String(avail.check_before_min ?? 120))}" />
        <span class="form-hint">With auto-check on, the nurse is asked this long before the session.</span>
      </div>
    </div>
    <div class="sp-save-row" style="margin-top:0;border-top:none;padding-top:0;padding-bottom:var(--s4)">
      <button class="btn btn-primary btn-sm" data-save-timers>Save timers</button>
    </div>
    <div class="sp-toggle-row">
      <div>
        <div class="sp-toggle-name">Auto availability check</div>
        <div class="sp-toggle-desc">Automatically ask the assigned nurse "are you going?" before every session. Off = the case-page button only; the no-reply standby cascade always runs.</div>
      </div>
      <label class="switch">
        <input type="checkbox" data-avail-auto ${avail.auto_check === true ? 'checked' : ''} />
        <span class="knob"></span>
      </label>
    </div>
    ${TOGGLE_DEFS.map(t => `
      <div class="sp-toggle-row">
        <div>
          <div class="sp-toggle-name">${escapeHtml(t.name)}</div>
          <div class="sp-toggle-desc">${escapeHtml(t.desc)}</div>
        </div>
        <label class="switch">
          <input type="checkbox" data-toggle="${t.key}" ${toggles[t.key] !== false ? 'checked' : ''} />
          <span class="knob"></span>
        </label>
      </div>
    `).join('')}
  `;

  el.querySelector('[data-save-timers]').addEventListener('click', async (e) => {
    const sla = Number(el.querySelector('#sp-sla').value);
    const otp = Number(el.querySelector('#sp-otp').value);
    const availTimeout = Number(el.querySelector('#sp-avail-timeout').value);
    const availBefore = Number(el.querySelector('#sp-avail-before').value);
    if (!Number.isFinite(sla) || sla < 1 || sla > 72) { showToast('Offer SLA must be between 1 and 72 hours', 'warning'); return; }
    if (!Number.isFinite(otp) || otp < 5 || otp > 240) { showToast('OTP validity must be between 5 and 240 minutes', 'warning'); return; }
    if (!Number.isFinite(availTimeout) || availTimeout < 2 || availTimeout > 180) { showToast('Availability reply window must be 2–180 minutes', 'warning'); return; }
    if (!Number.isFinite(availBefore) || availBefore < 15 || availBefore > 720) { showToast('Auto-check window must be 15–720 minutes', 'warning'); return; }
    busy(e.currentTarget, true);
    const ok1 = await saveSetting('sla_offer_hours', Math.round(sla), 'Offer SLA updated');
    const ok2 = await saveSetting('otp_ttl_min', Math.round(otp), 'OTP validity updated');
    const availNow = sval('availability', {});
    const ok3 = await saveSetting(
      'availability',
      { ...availNow, timeout_min: Math.round(availTimeout), check_before_min: Math.round(availBefore) },
      'Availability timers updated',
    );
    busy(el.querySelector('[data-save-timers]'), false);
    if (ok1 && ok2 && ok3) renderAutomation(el);
  });

  el.querySelector('[data-avail-auto]').addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const current = sval('availability', {});
    input.disabled = true;
    const ok = await saveSetting(
      'availability',
      { timeout_min: 20, check_before_min: 120, ...current, auto_check: input.checked },
      `Auto availability check turned ${input.checked ? 'on' : 'off'}`,
    );
    input.disabled = false;
    if (!ok) input.checked = !input.checked;
  });

  el.querySelectorAll('[data-toggle]').forEach(input => {
    input.addEventListener('change', async () => {
      const key = input.getAttribute('data-toggle');
      const def = TOGGLE_DEFS.find(t => t.key === key);
      const current = sval('toggles', {});
      const next = { ...current, [key]: input.checked };
      input.disabled = true;
      const ok = await saveSetting('toggles', next, `${def?.name || key} turned ${input.checked ? 'on' : 'off'}`);
      input.disabled = false;
      if (!ok) input.checked = !input.checked; // revert on failure
    });
  });
}

// ============================================================ TEMPLATE HEALTH
function templateStatusPill(row) {
  const st = String(row.status || '').toUpperCase();
  if (st === 'APPROVED') return `<span class="badge badge-success"><span class="dot"></span>Approved</span>`;
  if (st === 'PENDING' || st === 'IN_APPEAL') return `<span class="badge badge-warning"><span class="dot"></span>Pending</span>`;
  if (st === 'REJECTED') {
    const reason = row.rejection_reason ? ` title="${escapeHtml(row.rejection_reason)}"` : '';
    return `<span class="badge badge-danger" style="cursor:help"${reason}><span class="dot"></span>Rejected</span>`;
  }
  return `<span class="badge badge-neutral">${escapeHtml(st || 'DRAFT')}</span>`;
}

async function renderTemplateHealth(el) {
  el.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">WhatsApp template health</div>
        <div class="card-subtitle">Approval status per template and language, synced from Meta.</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-refresh-templates>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
        Refresh
      </button>
    </div>
    <div data-template-body>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
    </div>
    <div class="sp-note">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <span>Statuses here reflect the last sync. Run <code>node scripts/bootstrap_wa.mjs --sync-only</code> to refresh from Meta.</span>
    </div>
  `;

  const body = el.querySelector('[data-template-body]');
  el.querySelector('[data-refresh-templates]').addEventListener('click', () => renderTemplateHealth(el));

  let rows = [];
  try {
    const { data, error } = await getSupabase()
      .from('wa_templates')
      .select('name, language, category, status, rejection_reason, last_synced_at')
      .order('name', { ascending: true })
      .order('language', { ascending: true });
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    console.error('[settings] wa_templates load failed:', err);
    body.innerHTML = `
      <div class="empty-state">
        <h3>Couldn't load templates</h3>
        <p>${escapeHtml(err.message || 'Unknown error')}</p>
      </div>`;
    return;
  }

  if (!rows.length) {
    body.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <h3>No templates registered yet</h3>
        <p>Run <strong>scripts/bootstrap_wa.mjs</strong> to create and register the WhatsApp template catalog with Meta.</p>
      </div>`;
    return;
  }

  const rejected = rows.filter(r => String(r.status).toUpperCase() === 'REJECTED').length;
  body.innerHTML = `
    ${rejected ? `
      <div class="warn-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <p>${rejected} template${rejected > 1 ? 's' : ''} rejected — hover the status for Meta's reason, fix the copy in <strong>wa/templates.catalog.mjs</strong> and re-run the bootstrap.</p>
      </div>` : ''}
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Template</th><th>Lang</th><th>Category</th><th>Status</th><th>Last synced</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="cell-mono">${escapeHtml(r.name)}</td>
              <td class="cell-mono">${escapeHtml(r.language)}</td>
              <td>${escapeHtml(r.category || '—')}</td>
              <td>${templateStatusPill(r)}</td>
              <td class="cell-mono">${formatDateTime(r.last_synced_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================ PASSWORD CHANGE
function renderPassword(el) {
  el.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">Admin password</div>
        <div class="card-subtitle">Changes the password for the signed-in admin account.</div>
      </div>
    </div>
    <form data-pw-form autocomplete="off">
      <div class="form-group">
        <label class="form-label" for="sp-pw1">New password</label>
        <input class="form-input" id="sp-pw1" type="password" autocomplete="new-password" required />
        <span class="form-hint">At least 8 characters, with upper- and lowercase letters and a number.</span>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label" for="sp-pw2">Confirm new password</label>
        <input class="form-input" id="sp-pw2" type="password" autocomplete="new-password" required />
      </div>
      <div class="sp-save-row"><button type="submit" class="btn btn-primary btn-sm" data-save-pw>Change password</button></div>
    </form>
  `;
  el.querySelector('[data-pw-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const pw1 = el.querySelector('#sp-pw1').value;
    const pw2 = el.querySelector('#sp-pw2').value;
    const problem = validatePassword(pw1);
    if (problem) { showToast(problem, 'warning'); return; }
    if (pw1 !== pw2) { showToast('Passwords do not match', 'warning'); return; }

    confirmModal(
      'Change the admin password now? You will use the new password from your next sign-in.',
      async () => {
        const btn = el.querySelector('[data-save-pw]');
        busy(btn, true);
        try {
          const { error } = await getSupabase().auth.updateUser({ password: pw1 });
          if (error) throw error;
          showToast('Password changed', 'success');
          renderPassword(el); // clear the form
        } catch (err) {
          console.error('[settings] password change failed:', err);
          showToast(err.message || 'Could not change the password', 'error');
          busy(el.querySelector('[data-save-pw]'), false);
        }
      },
      { title: 'Change password?', confirmLabel: 'Change it', danger: false },
    );
  });
}

// ============================================================ ENDPOINTS (read-only)
function renderEndpoints(el) {
  const fnUrl = CONFIG.FUNCTIONS_URL;
  const webhookUrl = `${fnUrl}/wa-webhook`;
  const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  el.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">Endpoints</div>
        <div class="card-subtitle">Reference only — configured in code and the Meta App Dashboard.</div>
      </div>
    </div>
    <div class="form-label">Edge functions base</div>
    <div class="sp-endpoint">
      <code>${escapeHtml(fnUrl)}</code>
      <button class="btn btn-ghost btn-icon btn-sm" data-copy="${escapeHtml(fnUrl)}" title="Copy" aria-label="Copy functions URL">${copyIcon}</button>
    </div>
    <div class="form-label" style="margin-top:var(--s4)">WhatsApp webhook (Meta App Dashboard callback URL)</div>
    <div class="sp-endpoint">
      <code>${escapeHtml(webhookUrl)}</code>
      <button class="btn btn-ghost btn-icon btn-sm" data-copy="${escapeHtml(webhookUrl)}" title="Copy" aria-label="Copy webhook URL">${copyIcon}</button>
    </div>
    <div class="sp-note">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <span>The verify token lives in Supabase secrets (<code>WA_VERIFY_TOKEN</code>) — it is never shown here.</span>
    </div>
  `;
  el.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => copyText(btn.getAttribute('data-copy')));
  });
}

// ============================================================ PAGE ENTRY
export default async function render(container) {
  injectStyles();
  S = { settings: new Map() };

  container.innerHTML = `
    <div class="settings-grid">
      ${'<div class="card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div></div>'.repeat(4)}
    </div>
  `;

  let sb;
  try {
    sb = getSupabase();
    S.settings = await loadSettings(sb);
  } catch (err) {
    console.error('[settings] load failed:', err);
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <h3>Couldn't load settings</h3>
        <p>${escapeHtml(err.message || 'Unknown error')}</p>
        <button class="btn btn-secondary" data-retry>Try again</button>
      </div>`;
    container.querySelector('[data-retry]')?.addEventListener('click', () => render(container));
    return;
  }

  // The route may have changed while we were loading.
  if (!container.isConnected) return;

  container.innerHTML = `
    <div class="settings-grid">
      <div class="card" id="sp-pricing"></div>
      <div class="card" id="sp-billing"></div>
      <div class="card" id="sp-phones-supervisor_phones"></div>
      <div class="card" id="sp-phones-ops_phones"></div>
      <div class="card" id="sp-automation"></div>
      <div class="card" id="sp-password"></div>
      <div class="card settings-span" id="sp-templates"></div>
      <div class="card settings-span" id="sp-endpoints"></div>
    </div>
  `;

  renderPricing(container.querySelector('#sp-pricing'));
  renderBilling(container.querySelector('#sp-billing'));
  for (const def of PHONE_LISTS) {
    renderPhoneCard(container.querySelector(`#sp-phones-${def.key}`), def);
  }
  renderAutomation(container.querySelector('#sp-automation'));
  renderPassword(container.querySelector('#sp-password'));
  renderEndpoints(container.querySelector('#sp-endpoints'));
  await renderTemplateHealth(container.querySelector('#sp-templates'));
}
