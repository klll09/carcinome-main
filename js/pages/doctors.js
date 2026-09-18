// ============================================================
// Carcinome Home Care — #doctors
// Doctor roster: add/edit, specialty, relay preference, portal
// login (email/password via Auth Admin API — no SQL editor).
// Doctors are attached to cases by hand at registration; there is
// no broadcast pool like nurses have, so no eligibility switches.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { escapeHtml, maskPhone, formatDate, renderSkeleton } from '../utils/formatters.js';
import { validateIndianPhone } from '../utils/validators.js';
import { adminAction } from '../utils/api.js';

const LIVE_STATUSES = ['assigned', 'consented', 'otp_sent', 'in_care', 'care_done', 'awaiting_payment'];
const LANG_LABELS = { en: 'English', hi: 'हिंदी' };
const RELAY_LABELS = { full: 'Every message', milestones: 'Milestones only', muted: 'Muted' };

const state = {
  doctors: [],
  assignments: new Map(), // doctor_id → live case count
  search: '',
  loading: false,
};

function injectStyles() {
  if (document.getElementById('doctors-page-styles')) return;
  const style = document.createElement('style');
  style.id = 'doctors-page-styles';
  style.textContent = `
    .doctors-toolbar { display:flex; align-items:center; gap:var(--s3); flex-wrap:wrap; }
    .doctors-toolbar .table-search { min-width: 220px; }
    .doctor-cell { display:flex; align-items:center; gap:11px; min-width:0; }
    .doctor-cell .avatar { background: var(--grad-accent, #0E7C6B); }
    .doctor-cell .dc-name { font-weight:650; color:var(--ink); }
    .doctor-cell .dc-sub { font: var(--t-xs); color: var(--ink-3); margin-top:1px; }
    .login-cell { display:flex; flex-direction:column; gap:2px; }
    .login-cell .lc-email { font: var(--t-xs); color: var(--ink-2); }
    @media (max-width: 720px) {
      .doctors-toolbar { align-items: stretch; flex-direction: column; }
      .doctors-toolbar .table-search { max-width: none; }
      .doctors-toolbar .btn { width: 100%; }
    }
  `;
  document.head.appendChild(style);
}

async function fetchAll() {
  const sb = getSupabase();
  const [docsRes, casesRes] = await Promise.all([
    sb.from('doctors').select('*').order('full_name', { ascending: true }),
    sb.from('cases').select('doctor_id, status')
      .not('doctor_id', 'is', null)
      .in('status', LIVE_STATUSES),
  ]);

  if (docsRes.error) throw new Error(docsRes.error.message || 'Could not load doctors');
  state.doctors = docsRes.data || [];

  state.assignments = new Map();
  if (casesRes.error) {
    console.error('[doctors] cases load failed:', casesRes.error);
  } else {
    for (const c of casesRes.data || []) {
      state.assignments.set(c.doctor_id, (state.assignments.get(c.doctor_id) || 0) + 1);
    }
  }
}

function filteredDoctors() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.doctors;
  return state.doctors.filter((d) => {
    const hay = `${d.full_name} ${d.phone} ${d.specialty || ''} ${d.email || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

export default async function render(container) {
  injectStyles();

  container.innerHTML = `
    <div class="card card-flush">
      <div class="table-toolbar doctors-toolbar">
        <div class="table-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input class="form-input" id="doctor-search" type="search" placeholder="Search name, phone or specialty…" autocomplete="off" />
        </div>
        <button class="btn btn-primary" id="btn-add-doctor" style="margin-left:auto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          Add Doctor
        </button>
      </div>
      <div id="doctors-region" style="padding: var(--s4)">${renderSkeleton(6)}</div>
    </div>
  `;

  const searchEl = container.querySelector('#doctor-search');
  searchEl.value = state.search;
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchEl.value;
      renderRegion(container);
    }, 160);
  });

  container.querySelector('#btn-add-doctor').addEventListener('click', () => openAddDoctorModal(container));

  const region = container.querySelector('#doctors-region');
  region.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'add-first') openAddDoctorModal(container);
    if (btn.dataset.action === 'edit') openEditDoctorModal(container, btn.dataset.id);
  });

  await refresh(container);
}

async function refresh(container) {
  if (state.loading) return;
  state.loading = true;
  try {
    await fetchAll();
    renderRegion(container);
  } catch (err) {
    console.error('[doctors] load failed:', err);
    const region = container.querySelector('#doctors-region');
    if (region) {
      region.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <h3>Couldn't load doctors</h3>
          <p>${escapeHtml(err.message || 'Unknown error')}</p>
          <button class="btn btn-secondary" onclick="location.reload()">Reload</button>
        </div>`;
    }
    showToast(err.message || 'Could not load doctors', 'error');
  } finally {
    state.loading = false;
  }
}

function renderRegion(container) {
  const region = container.querySelector('#doctors-region');
  if (!region) return;

  if (state.doctors.length === 0) {
    region.style.padding = 'var(--s4)';
    region.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
        <h3>No doctors yet</h3>
        <p>Add your first doctor — you'll be able to attach them to cases at registration.</p>
        <button class="btn btn-primary" data-action="add-first">Add your first doctor</button>
      </div>`;
    return;
  }

  const rows = filteredDoctors();
  if (rows.length === 0) {
    region.style.padding = 'var(--s4)';
    region.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <h3>No matches</h3>
        <p>No doctor matches this search. Try a different name, phone or specialty.</p>
      </div>`;
    return;
  }

  region.style.padding = '0';
  region.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Doctor</th>
            <th>Phone</th>
            <th>Specialty</th>
            <th>Language</th>
            <th>Relay</th>
            <th>Portal login</th>
            <th>Live cases</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((d) => doctorRowHtml(d)).join('')}
        </tbody>
      </table>
    </div>
    <div class="table-pagination"><span>${rows.length} of ${state.doctors.length} doctor${state.doctors.length === 1 ? '' : 's'}</span></div>
  `;
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function loginCellHtml(d) {
  if (!d.email) return `<span class="badge badge-neutral">No login set</span>`;
  if (!d.auth_user_id) return `<span class="badge badge-warn" title="Email saved but no password created yet">Email saved, no login yet</span>`;
  return `<span class="badge badge-ok" title="Can sign in with this email + password">${escapeHtml(d.email)}</span>`;
}

function doctorRowHtml(d) {
  const liveCount = state.assignments.get(d.id) || 0;
  return `
    <tr data-id="${d.id}">
      <td class="cell-clamp">
        <div class="doctor-cell">
          <span class="avatar avatar-sm">${escapeHtml(initials(d.full_name))}</span>
          <div style="min-width:0">
            <div class="dc-name">${escapeHtml(d.full_name)}${d.opted_out ? ' <span class="badge badge-danger" title="This doctor sent STOP on WhatsApp — no messages will be sent">Opted out</span>' : ''}</div>
            <div class="dc-sub">Added ${escapeHtml(formatDate(d.created_at))}</div>
          </div>
        </div>
      </td>
      <td class="cell-mono" title="Full number hidden">${escapeHtml(maskPhone(d.phone))}</td>
      <td>${escapeHtml(d.specialty || '—')}</td>
      <td><span class="badge ${d.language_pref === 'hi' ? 'badge-violet' : 'badge-neutral'}">${escapeHtml(LANG_LABELS[d.language_pref] || d.language_pref)}</span></td>
      <td>${escapeHtml(RELAY_LABELS[d.default_relay] || d.default_relay)}</td>
      <td>${loginCellHtml(d)}</td>
      <td class="cell-num">${liveCount === 0 ? '<span style="color:var(--ink-4)">0</span>' : `<span class="badge badge-primary">${liveCount}</span>`}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${d.id}" title="Edit ${escapeHtml(d.full_name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
      </td>
    </tr>`;
}

// ---- shared: show a one-time credentials modal after set_staff_login ----
function showCredentialsModal(name, email, password, created) {
  const overlay = showModal({
    title: created ? 'Login created' : 'Password reset',
    size: 'md',
    content: `
      <p>${created ? `A portal login was created for` : `The portal password was reset for`} <strong>${escapeHtml(name)}</strong>.
      Copy this now — it won't be shown again. Share it with them directly.</p>
      <div class="form-group" style="margin-top:var(--s3)">
        <label class="form-label">Email</label>
        <input class="form-input" readonly value="${escapeHtml(email)}" onclick="this.select()" />
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input class="form-input" readonly value="${escapeHtml(password)}" onclick="this.select()" />
      </div>
    `,
    footer: `<button class="btn btn-primary" data-cred-close type="button">Done</button>`,
  });
  overlay.querySelector('[data-cred-close]').addEventListener('click', () => closeModal());
}

async function issueLogin(btn, role, id, name, emailValue, passwordValue) {
  const email = String(emailValue || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Enter a valid email first, then save', 'warning');
    return;
  }
  const password = String(passwordValue || '').trim();
  if (password && password.length < 6) {
    showToast('Password must be at least 6 characters', 'warning');
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const res = await adminAction('set_staff_login', { role, id, email, password: password || undefined });
    showCredentialsModal(name, res.email, res.password, res.created);
  } catch (err) {
    console.error('[issueLogin] failed:', err);
    showToast(err.message || 'Could not create login', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ============================================================ Edit Doctor modal
function openEditDoctorModal(container, id) {
  const doctor = state.doctors.find((x) => x.id === id);
  if (!doctor) return;

  const overlay = showModal({
    title: `Edit ${doctor.full_name}`,
    size: 'lg',
    content: `
      <form id="edit-doctor-form" novalidate>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="ed-name">Full name <span class="required">*</span></label>
            <input class="form-input" id="ed-name" type="text" value="${escapeHtml(doctor.full_name || '')}" required />
            <span class="form-error" data-err="name" hidden></span>
          </div>
          <div class="form-group">
            <label class="form-label" for="ed-phone">WhatsApp number <span class="required">*</span></label>
            <input class="form-input" id="ed-phone" type="tel" inputmode="numeric" value="${escapeHtml(doctor.phone || '')}" required />
            <span class="form-error" data-err="phone" hidden></span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="ed-specialty">Specialty</label>
            <input class="form-input" id="ed-specialty" type="text" value="${escapeHtml(doctor.specialty || '')}" placeholder="e.g. Medical Oncology" />
          </div>
          <div class="form-group">
            <label class="form-label" for="ed-lang">Language</label>
            <select class="form-select" id="ed-lang">
              <option value="en" ${doctor.language_pref !== 'hi' ? 'selected' : ''}>English</option>
              <option value="hi" ${doctor.language_pref === 'hi' ? 'selected' : ''}>हिंदी (Hindi)</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="ed-relay">Relay preference</label>
          <select class="form-select" id="ed-relay">
            <option value="full" ${doctor.default_relay === 'full' ? 'selected' : ''}>Every message</option>
            <option value="milestones" ${doctor.default_relay !== 'full' && doctor.default_relay !== 'muted' ? 'selected' : ''}>Milestones only</option>
            <option value="muted" ${doctor.default_relay === 'muted' ? 'selected' : ''}>Muted</option>
          </select>
        </div>
                <div class="form-group">
          <label class="form-label" for="ed-email">Portal login email <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
          <input class="form-input" id="ed-email" type="email" placeholder="doctor@example.com" value="${escapeHtml(doctor.email || '')}" autocomplete="off" />
          <span class="form-error" data-err="email" hidden></span>
        </div>
        <div class="form-group">
          <label class="form-label" for="ed-password">Password <span style="text-transform:none;letter-spacing:0">(leave blank to auto-generate)</span></label>
          <div style="display:flex; gap:var(--s2); align-items:flex-start">
            <input class="form-input" id="ed-password" type="text" placeholder="Type a password, or leave blank" autocomplete="new-password" style="flex:1" />
            <button class="btn btn-secondary" id="ed-issue-login" type="button" style="white-space:nowrap">
              ${doctor.auth_user_id ? 'Set password' : 'Create login'}
            </button>
          </div>
          <span class="form-hint">Save the email above first if you just changed it, then set the password here. No Supabase dashboard needed.</span>
        </div>
      </form>
    `,
    footer: `
      <button class="btn btn-secondary" data-ed-cancel type="button">Cancel</button>
      <button class="btn btn-primary" data-ed-save type="button">Save changes</button>
    `,
  });

  const $ = (sel) => overlay.querySelector(sel);
  const setErr = (key, msg) => {
    const el = overlay.querySelector(`[data-err="${key}"]`);
    const input = { name: $('#ed-name'), phone: $('#ed-phone'), email: $('#ed-email') }[key];
    if (msg) { el.textContent = msg; el.hidden = false; input.classList.add('error'); }
    else { el.hidden = true; input.classList.remove('error'); }
  };

  $('[data-ed-cancel]').addEventListener('click', () => closeModal());

  $('#ed-issue-login').addEventListener('click', (e) => {
  issueLogin(e.currentTarget, 'doctor', id, doctor.full_name, $('#ed-email').value, $('#ed-password').value);
  });

  const saveBtn = $('[data-ed-save]');
  saveBtn.addEventListener('click', async () => {
    const name = $('#ed-name').value.trim();
    const phoneCheck = validateIndianPhone($('#ed-phone').value);
    const emailRaw = $('#ed-email').value.trim().toLowerCase();

    let bad = false;
    if (!name) { setErr('name', 'Full name is required'); bad = true; } else setErr('name', null);
    if (!phoneCheck.ok) { setErr('phone', phoneCheck.error); bad = true; } else setErr('phone', null);
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      setErr('email', 'Enter a valid email address'); bad = true;
    } else setErr('email', null);
    if (bad) return;

    const patch = {
      full_name: name,
      phone: phoneCheck.normalized,
      specialty: $('#ed-specialty').value.trim() || null,
      language_pref: $('#ed-lang').value === 'hi' ? 'hi' : 'en',
      default_relay: $('#ed-relay').value,
      email: emailRaw || null,
    };

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    const sb = getSupabase();
    const { error } = await sb.from('doctors').update(patch).eq('id', id);
    if (error) {
      if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
        setErr(/phone/i.test(error.message || '') ? 'phone' : 'email', 'Already in use by another doctor');
      } else {
        showToast(error.message || 'Could not save changes', 'error');
      }
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
      return;
    }
    Object.assign(doctor, patch);
    closeModal();
    showToast(`${name} updated`, 'success');
    renderRegion(container);
  });

  requestAnimationFrame(() => $('#ed-name')?.focus());
}

// ============================================================ Add Doctor modal
function openAddDoctorModal(container) {
  const overlay = showModal({
    title: 'Add Doctor',
    size: 'lg',
    content: `
      <form id="add-doctor-form" novalidate>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="ad-name">Full name <span class="required">*</span></label>
            <input class="form-input" id="ad-name" type="text" placeholder="e.g. Dr Rohan Mehta" autocomplete="off" required />
            <span class="form-error" data-err="name" hidden></span>
          </div>
          <div class="form-group">
            <label class="form-label" for="ad-phone">WhatsApp number <span class="required">*</span></label>
            <input class="form-input" id="ad-phone" type="tel" inputmode="numeric" placeholder="10-digit mobile, e.g. 98765 43210" autocomplete="off" required />
            <span class="form-error" data-err="phone" hidden></span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="ad-specialty">Specialty</label>
            <input class="form-input" id="ad-specialty" type="text" placeholder="e.g. Medical Oncology" autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label" for="ad-lang">Language</label>
            <select class="form-select" id="ad-lang">
              <option value="en" selected>English</option>
              <option value="hi">हिंदी (Hindi)</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="ad-relay">Relay preference</label>
          <select class="form-select" id="ad-relay">
            <option value="full">Every message</option>
            <option value="milestones" selected>Milestones only</option>
            <option value="muted">Muted</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="ad-email">Portal login email <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
          <input class="form-input" id="ad-email" type="email" placeholder="doctor@example.com" autocomplete="off" />
          <span class="form-hint">Add the doctor first, then open Edit to create their password.</span>
          <span class="form-error" data-err="email" hidden></span>
        </div>
      </form>
    `,
    footer: `
      <button class="btn btn-secondary" data-ad-cancel type="button">Cancel</button>
      <button class="btn btn-primary" data-ad-save type="button">Add Doctor</button>
    `,
  });

  const $ = (sel) => overlay.querySelector(sel);
  function setErr(key, msg) {
    const el = overlay.querySelector(`[data-err="${key}"]`);
    const input = { name: $('#ad-name'), phone: $('#ad-phone'), email: $('#ad-email') }[key];
    if (msg) { el.textContent = msg; el.hidden = false; input.classList.add('error'); }
    else { el.hidden = true; input.classList.remove('error'); }
  }
  $('#ad-name').addEventListener('input', () => setErr('name', null));
  $('#ad-phone').addEventListener('input', () => setErr('phone', null));

  $('[data-ad-cancel]').addEventListener('click', () => closeModal());

  const saveBtn = $('[data-ad-save]');
  saveBtn.addEventListener('click', async () => {
    const name = $('#ad-name').value.trim();
    const phoneCheck = validateIndianPhone($('#ad-phone').value);
    const emailRaw = $('#ad-email').value.trim().toLowerCase();
    let bad = false;
    if (!name) { setErr('name', 'Full name is required'); bad = true; }
    if (!phoneCheck.ok) { setErr('phone', phoneCheck.error); bad = true; }
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      setErr('email', 'Enter a valid email address'); bad = true;
    }
    if (bad) return;

    const row = {
      full_name: name,
      phone: phoneCheck.normalized,
      specialty: $('#ad-specialty').value.trim() || null,
      language_pref: $('#ad-lang').value === 'hi' ? 'hi' : 'en',
      default_relay: $('#ad-relay').value,
      email: emailRaw || null,
    };

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const sb = getSupabase();
      const { error } = await sb.from('doctors').insert(row);
      if (error) {
        if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
          setErr('phone', 'A doctor with this phone number already exists');
        } else {
          showToast(error.message || 'Could not add the doctor', 'error');
        }
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add Doctor';
        return;
      }
      closeModal();
      showToast(`${name} added`, 'success');
      await refresh(container);
    } catch (err) {
      console.error('[doctors] insert failed:', err);
      showToast(err.message || 'Could not add the doctor', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add Doctor';
    }
  });

  requestAnimationFrame(() => $('#ad-name')?.focus());
}