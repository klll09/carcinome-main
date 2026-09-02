// ============================================================
// Carcinome Home Care — #suppliers ("Marketplace")
// Equipment/pharma suppliers who receive equipment-prep WhatsApp
// messages. CRUD is direct table access under RLS (admin-only) —
// per CONTRACTS, entity CRUD does NOT go through admin-actions.
// No WhatsApp sends originate from this page.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import {
  escapeHtml, maskPhone, formatPhone, formatDate, renderSkeleton,
} from '../utils/formatters.js';
import { validateIndianPhone, validateRequired } from '../utils/validators.js';

const STYLE_ID = 'suppliers-page-styles';

const LANG_LABELS = { en: 'English', hi: 'हिंदी' };

// Module state for the current render (re-created on each navigation).
let suppliers = [];
let searchTerm = '';

// ---- page-scoped styles (injected once, id-guarded) ----
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .sup-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--s5); align-items: start; }
    @media (max-width: 960px) { .sup-grid { grid-template-columns: 1fr; } }
    .sup-phone-list { display: flex; flex-direction: column; gap: var(--s2); }
    .sup-phone-chip {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--r-md);
      background: var(--bg-sunken); font-family: var(--font-mono); font-size: 13px; color: var(--ink);
    }
    .sup-phone-chip svg { width: 15px; height: 15px; color: var(--ink-3); flex: none; }
    .sup-phone-none { font: var(--t-sm); color: var(--ink-4); font-style: italic; padding: 4px 0; }
    .sup-role-label { font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); margin: var(--s4) 0 var(--s2); }
    .sup-role-label:first-of-type { margin-top: 0; }
    .sup-count { font: var(--t-mono); font-size: 11.5px; color: var(--ink-3); }
  `;
  document.head.appendChild(style);
}

// ---- data ----
async function fetchSuppliers() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('suppliers')
    .select('id, name, phone, language_pref, is_active, opted_out, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message || 'Could not load suppliers');
  return data || [];
}

async function fetchOpsSettings() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('settings')
    .select('key, value')
    .in('key', ['ops_phones', 'supervisor_phones']);
  if (error) throw new Error(error.message || 'Could not load settings');
  const map = { ops_phones: [], supervisor_phones: [] };
  for (const row of data || []) {
    if (Array.isArray(row.value)) map[row.key] = row.value;
  }
  return map;
}

// ---- table region ----
function filteredSuppliers() {
  const q = searchTerm.trim().toLowerCase();
  if (!q) return suppliers;
  const qDigits = q.replace(/\D/g, '');
  return suppliers.filter((s) =>
    (s.name || '').toLowerCase().includes(q) ||
    (qDigits && String(s.phone || '').includes(qDigits))
  );
}

function supplierRow(s) {
  const langBadge = s.language_pref === 'hi'
    ? '<span class="badge badge-violet">हिंदी</span>'
    : '<span class="badge badge-info">English</span>';
  const optedOut = s.opted_out
    ? ' <span class="badge badge-danger" title="This supplier sent STOP — WhatsApp messages are suppressed">Opted out</span>'
    : '';
  return `
    <tr data-id="${s.id}">
      <td class="cell-clamp" title="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong>${optedOut}</td>
      <td class="cell-mono" title="Full number hidden — used only for WhatsApp sends">${escapeHtml(maskPhone(s.phone))}</td>
      <td>${langBadge}</td>
      <td class="cell-mono">${formatDate(s.created_at)}</td>
      <td>
        <label class="switch" title="${s.is_active ? 'Active — receives equipment-prep messages' : 'Inactive — skipped for new cases'}">
          <input type="checkbox" data-toggle-active data-id="${s.id}" ${s.is_active ? 'checked' : ''} />
          <span class="knob"></span>
        </label>
      </td>
    </tr>`;
}

function renderTableRegion(region) {
  const list = filteredSuppliers();
  const activeCount = suppliers.filter((s) => s.is_active).length;

  if (suppliers.length === 0) {
    region.innerHTML = `
      <div class="empty">
        <div class="ico-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
        </div>
        <h4>No suppliers yet</h4>
        <p>Add your first equipment supplier. Once added, they automatically get a WhatsApp heads-up whenever a case that needs equipment is registered.</p>
        <button class="btn btn-primary" data-add-supplier>Add your first supplier</button>
      </div>`;
    region.querySelector('[data-add-supplier]')?.addEventListener('click', openAddModal);
    return;
  }

  const rows = list.map(supplierRow).join('');
  const emptySearch = `
    <tr><td colspan="5">
      <div class="empty" style="padding: var(--s6)">
        <h4>No matches</h4>
        <p>No supplier matches “${escapeHtml(searchTerm)}”. Try a different name or phone.</p>
      </div>
    </td></tr>`;

  region.innerHTML = `
    <div class="table-wrap">
      <table class="data-table data">
        <thead>
          <tr>
            <th>Supplier</th>
            <th>Phone</th>
            <th>Language</th>
            <th>Added</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>${rows || emptySearch}</tbody>
      </table>
    </div>
    <div class="table-pagination">
      <span class="sup-count">${suppliers.length} supplier${suppliers.length === 1 ? '' : 's'} · ${activeCount} active</span>
      <span class="sup-count">${list.length !== suppliers.length ? `${list.length} shown` : ''}</span>
    </div>`;

  // Active toggles — non-destructive both ways, but deactivating changes
  // who gets WhatsApp prep messages, so confirm the OFF direction.
  region.querySelectorAll('[data-toggle-active]').forEach((input) => {
    input.addEventListener('change', () => onToggleActive(input, region));
  });
}

async function onToggleActive(input, region) {
  const id = input.getAttribute('data-id');
  const supplier = suppliers.find((s) => s.id === id);
  if (!supplier) return;
  const next = input.checked;

  const apply = async () => {
    input.disabled = true;
    try {
      const sb = getSupabase();
      const { error } = await sb.from('suppliers').update({ is_active: next }).eq('id', id);
      if (error) throw new Error(error.message || 'Update failed');
      supplier.is_active = next;
      showToast(
        next
          ? `${supplier.name} is active — they'll get equipment-prep messages for new cases.`
          : `${supplier.name} deactivated — new cases will skip them.`,
        'success'
      );
    } catch (err) {
      console.error('[suppliers] toggle failed:', err);
      input.checked = !next; // revert the switch
      showToast(err.message || 'Could not update supplier', 'error');
    } finally {
      input.disabled = false;
      renderTableRegion(region); // refresh counts + tooltips
    }
  };

  if (!next) {
    // Revert visually until confirmed; confirm because it silently changes
    // WhatsApp routing for every future case.
    input.checked = true;
    confirmModal(
      `Deactivate <strong>${escapeHtml(supplier.name)}</strong>? They will stop receiving equipment-prep WhatsApp messages for new cases. Existing case threads are not affected.`,
      async () => { input.checked = false; await apply(); },
      { title: 'Deactivate supplier', confirmLabel: 'Deactivate', danger: true }
    );
  } else {
    await apply();
  }
}

// ---- Add Supplier modal ----
function openAddModal() {
  const overlay = showModal({
    title: 'Add Supplier',
    content: `
      <form id="sup-add-form" novalidate>
        <div class="form-group">
          <label class="form-label" for="sup-name">Supplier name <span class="required">*</span></label>
          <input class="form-input" id="sup-name" type="text" maxlength="120" placeholder="e.g. MedEquip Pharma, Andheri" autocomplete="off" required />
          <span class="form-error" id="sup-name-err" hidden></span>
        </div>
        <div class="form-group">
          <label class="form-label" for="sup-phone">WhatsApp number <span class="required">*</span></label>
          <input class="form-input" id="sup-phone" type="tel" inputmode="numeric" placeholder="98765 43210" autocomplete="off" required />
          <span class="form-hint">Indian mobile — saved as +91 and used for all WhatsApp messages to this supplier.</span>
          <span class="form-error" id="sup-phone-err" hidden></span>
        </div>
        <div class="form-group">
          <label class="form-label" for="sup-lang">Message language</label>
          <select class="form-select" id="sup-lang">
            <option value="en" selected>English</option>
            <option value="hi">हिंदी (Hindi)</option>
          </select>
          <span class="form-hint">Templates go out in this language (falls back to English until the Hindi variant is approved).</span>
        </div>
      </form>`,
    footer: `
      <button class="btn btn-secondary" data-sup-cancel type="button">Cancel</button>
      <button class="btn btn-primary" data-sup-save type="button" form="sup-add-form">Add supplier</button>
    `,
  });

  const form = overlay.querySelector('#sup-add-form');
  const saveBtn = overlay.querySelector('[data-sup-save]');
  overlay.querySelector('[data-sup-cancel]').addEventListener('click', () => closeModal());

  const setFieldError = (fieldId, message) => {
    const input = overlay.querySelector(`#${fieldId}`);
    const err = overlay.querySelector(`#${fieldId}-err`);
    if (message) {
      input?.classList.add('error');
      if (err) { err.textContent = message; err.hidden = false; }
    } else {
      input?.classList.remove('error');
      if (err) { err.hidden = true; }
    }
  };

  let submitting = false;
  const submit = async () => {
    if (submitting) return; // guard against double-fire (click + form submit)
    const name = overlay.querySelector('#sup-name').value.trim();
    const phoneRaw = overlay.querySelector('#sup-phone').value;
    const lang = overlay.querySelector('#sup-lang').value === 'hi' ? 'hi' : 'en';

    const nameErr = validateRequired(name, 'Supplier name');
    setFieldError('sup-name', nameErr);
    const phoneCheck = validateIndianPhone(phoneRaw);
    setFieldError('sup-phone', phoneCheck.ok ? null : phoneCheck.error);
    if (nameErr || !phoneCheck.ok) return;

    // Friendly duplicate check before hitting the unique constraint.
    const dup = suppliers.find((s) => s.phone === phoneCheck.normalized);
    if (dup) {
      setFieldError('sup-phone', `That number already belongs to “${dup.name}”.`);
      return;
    }

    submitting = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('suppliers')
        .insert({ name, phone: phoneCheck.normalized, language_pref: lang })
        .select('id, name, phone, language_pref, is_active, opted_out, created_at')
        .single();
      if (error) {
        // 23505 = unique violation on phone (raced past the client-side check)
        if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
          throw new Error('A supplier with this phone number already exists.');
        }
        throw new Error(error.message || 'Could not add supplier');
      }
      suppliers.unshift(data);
      closeModal();
      showToast(`${data.name} added to the marketplace. They'll get equipment-prep messages on new case registrations.`, 'success');
      const region = document.getElementById('sup-table-region');
      if (region) renderTableRegion(region);
    } catch (err) {
      console.error('[suppliers] insert failed:', err);
      showToast(err.message || 'Could not add supplier', 'error');
      submitting = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add supplier';
    }
  };

  saveBtn.addEventListener('click', submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  setTimeout(() => overlay.querySelector('#sup-name')?.focus(), 60);
}

// ---- ops / supervisor numbers (read-only, from settings) ----
function phoneChips(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '<div class="sup-phone-none">None configured</div>';
  }
  return list.map((p) => `
    <div class="sup-phone-chip">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      <span>${escapeHtml(formatPhone(p))}</span>
    </div>`).join('');
}

function renderOpsRegion(region, opsSettings, loadError) {
  if (loadError) {
    region.innerHTML = `
      <div class="card">
        <div class="card-header"><h3 class="card-title">Team numbers</h3></div>
        <p style="font: var(--t-sm); color: var(--ink-3); margin: 0 0 var(--s3)">Couldn't load the configured numbers: ${escapeHtml(loadError)}</p>
        <button class="btn btn-secondary btn-sm" data-ops-retry>Retry</button>
      </div>`;
    region.querySelector('[data-ops-retry]')?.addEventListener('click', async () => {
      region.innerHTML = `<div class="card">${renderSkeleton(3)}</div>`;
      try {
        renderOpsRegion(region, await fetchOpsSettings(), null);
      } catch (err) {
        renderOpsRegion(region, null, err.message);
      }
    });
    return;
  }

  region.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Team numbers</h3>
        <span class="badge badge-neutral" title="Configured in Settings">Read-only</span>
      </div>
      <p style="font: var(--t-sm); color: var(--ink-3); margin: 0 0 var(--s4)">
        These numbers join every case thread automatically — Ops as full relay participants, supervisors for SLA nudges and OTP-lockout alerts.
      </p>
      <div class="sup-role-label">Ops numbers</div>
      <div class="sup-phone-list">${phoneChips(opsSettings.ops_phones)}</div>
      <div class="sup-role-label">Supervisor numbers</div>
      <div class="sup-phone-list">${phoneChips(opsSettings.supervisor_phones)}</div>
      <div style="margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line)">
        <a class="btn btn-secondary btn-sm" href="#settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          Edit in Settings
        </a>
      </div>
    </div>`;
}

// ---- main render ----
export default async function render(container /*, params */) {
  injectStyles();
  searchTerm = '';

  container.innerHTML = `
    <div class="info-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <p>
        <strong>How the marketplace works:</strong> active suppliers automatically receive an
        <em>equipment-prep</em> WhatsApp message the moment a case is registered, and an update
        with the nurse's name once a nurse is assigned. No manual messaging needed from here.
      </p>
    </div>
    <div class="sup-grid">
      <div class="card card-flush">
        <div class="card-head">
          <h3>Suppliers</h3>
          <button class="btn btn-primary btn-sm" id="sup-add-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Supplier
          </button>
        </div>
        <div class="table-toolbar">
          <div class="table-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input class="form-input" id="sup-search" type="search" placeholder="Search name or phone…" autocomplete="off" />
          </div>
        </div>
        <div id="sup-table-region" style="padding: 0 var(--s4) var(--s2)">${renderSkeleton(5)}</div>
      </div>
      <div id="sup-ops-region">
        <div class="card">${renderSkeleton(3)}</div>
      </div>
    </div>`;

  container.querySelector('#sup-add-btn').addEventListener('click', openAddModal);

  const tableRegion = container.querySelector('#sup-table-region');
  const opsRegion = container.querySelector('#sup-ops-region');

  container.querySelector('#sup-search').addEventListener('input', (e) => {
    searchTerm = e.target.value || '';
    renderTableRegion(tableRegion);
  });

  // Load both regions independently — one failing must not blank the other.
  const [supRes, opsRes] = await Promise.allSettled([fetchSuppliers(), fetchOpsSettings()]);

  const renderTableError = (message) => {
    suppliers = [];
    tableRegion.innerHTML = `
      <div class="empty">
        <div class="ico-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <h4>Couldn't load suppliers</h4>
        <p>${escapeHtml(message || 'Unknown error')}</p>
        <button class="btn btn-secondary" data-sup-retry>Retry</button>
      </div>`;
    tableRegion.querySelector('[data-sup-retry]')?.addEventListener('click', async () => {
      tableRegion.innerHTML = renderSkeleton(5);
      try {
        suppliers = await fetchSuppliers();
        renderTableRegion(tableRegion);
      } catch (err) {
        console.error('[suppliers] retry failed:', err);
        renderTableError(err.message);
      }
    });
  };

  if (supRes.status === 'fulfilled') {
    suppliers = supRes.value;
    renderTableRegion(tableRegion);
  } else {
    console.error('[suppliers] load failed:', supRes.reason);
    renderTableError(supRes.reason?.message);
  }

  if (opsRes.status === 'fulfilled') {
    renderOpsRegion(opsRegion, opsRes.value, null);
  } else {
    console.error('[suppliers] settings load failed:', opsRes.reason);
    renderOpsRegion(opsRegion, null, opsRes.reason?.message || 'Unknown error');
  }
}
