// ============================================================
// Carcinome Home Care — #nurses
// Nurse pool management: eligibility + active toggles (direct
// table updates under RLS), offer accept-rate stats, live
// assignment counts, Add Nurse modal, deactivate w/ confirm.
// WhatsApp sends are NOT triggered from this page — eligible
// nurses receive case offers automatically at registration.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { escapeHtml, maskPhone, formatDate, renderSkeleton } from '../utils/formatters.js';
import { validateIndianPhone } from '../utils/validators.js';
import { adminAction } from '../utils/api.js';

// A nurse is "currently on" a case while it hasn't reached a terminal state.
const LIVE_STATUSES = ['assigned', 'consented', 'otp_sent', 'in_care', 'care_done', 'awaiting_payment'];

const LANG_LABELS = { en: 'English', hi: 'हिंदी' };

// ---- page state (re-fetched on every render; search survives refreshes) ----
const state = {
  nurses: [],
  offerStats: new Map(),   // nurse_id → { accepted, total }
  assignments: new Map(),  // nurse_id → live case count
  search: '',
  filter: 'all',           // all | pool | excluded | inactive
  loading: false,
};

// ============================================================ offer pool
// THE test that decides whether a nurse ever hears about a case. It is not a
// guess: admin-actions/index.ts registerCase selects the broadcast pool with
//   .eq('is_eligible', true).eq('is_active', true).eq('opted_out', false)
// and every one of the three has to hold. Keep this function in step with that
// query, and nothing else on this page.
//
// Why it exists: the roster used to show two switches and an "Opted out" chip
// and left the AND to the reader, so a nurse who was eligible-but-inactive
// looked fine and silently received nothing. The owner's recurring question -
// "why did that nurse not get anything?" - is this AND, and now it is a column.
function poolStatus(n) {
  const reasons = [];
  // Ordered by how final each one is: STOP is the nurse's own decision and no
  // dashboard switch overrides it, so it is named first.
  if (n.opted_out) reasons.push('sent STOP on WhatsApp');
  if (!n.is_active) reasons.push('not active');
  if (!n.is_eligible) reasons.push('Eligible switch is off');
  return { inPool: reasons.length === 0, reasons };
}

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

async function issueLogin(btn, role, id, name, emailValue, passwordValue, container) {
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
    if (container) await refresh(container);
  } catch (err) {
    console.error('[issueLogin] failed:', err);
    showToast(err.message || 'Could not create login', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ============================================================ styles (once)
function injectStyles() {
  if (document.getElementById('nurses-page-styles')) return;
  const style = document.createElement('style');
  style.id = 'nurses-page-styles';
  style.textContent = `
    .nurses-toolbar { display:flex; align-items:center; gap:var(--s3); flex-wrap:wrap; }
    .nurses-toolbar .table-search { min-width: 220px; }
    .nurse-cell { display:flex; align-items:center; gap:11px; min-width:0; }
    .nurse-cell .avatar { background: var(--grad-accent, #0E7C6B); }
    .nurse-cell .nc-name { font-weight:650; color:var(--ink); }
    .nurse-cell .nc-sub { font: var(--t-xs); color: var(--ink-3); margin-top:1px; }
    .offer-stat { display:inline-flex; align-items:baseline; gap:6px; font-variant-numeric: tabular-nums; }
    .offer-stat .os-frac { font-family: var(--font-mono); font-size:12.5px; color:var(--ink-2); }
    .offer-stat .os-pct { font: var(--t-xs); font-weight:700; }
    .offer-stat .os-pct.good { color: var(--ok); }
    .offer-stat .os-pct.mid { color: var(--warn); }
    .offer-stat .os-pct.low { color: var(--danger); }
    .nurse-row.inactive td { opacity: 0.55; }
    .nurse-row.inactive td .switch { opacity: 1; }
    /* offer pool cell: the badge answers "does she get offers", the line under
       it answers "why not" - both in the same column so neither can be missed */
    .pool-cell { min-width: 150px; }
    .pool-why { display:block; font: var(--t-xs); color: var(--ink-3); margin-top:4px; line-height:1.35; }
    .pool-summary { display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px; }
    .pool-summary .ps-fig { display:inline-flex; align-items:baseline; gap:7px; }
    .pool-summary .ps-n { font: 700 17px var(--font-mono); font-variant-numeric: tabular-nums; }
    .pool-summary .ps-n.in { color: var(--ok); }
    .pool-summary .ps-n.out { color: var(--danger); }
    .pool-summary .ps-lbl { font: var(--t-xs); color: var(--ink-2); }
    .skills-chips { display:flex; flex-wrap:wrap; gap:6px; }
    .skill-chip { display:inline-flex; align-items:center; gap:6px; padding:4px 10px;
      background: var(--accent-soft, #E2F2EE); color: var(--accent-deep, #0B6A5B);
      border-radius: var(--r-pill); font: var(--t-xs); font-weight:600; }
    .skill-chip button { border:none; background:none; color:inherit; cursor:pointer;
      font-size:13px; line-height:1; padding:0; display:flex; opacity:.7; }
    .skill-chip button:hover { opacity:1; }
    @media (max-width: 720px) {
      .nurses-toolbar { align-items: stretch; flex-direction: column; }
      .nurses-toolbar .table-search { max-width: none; }
      .nurses-toolbar .btn { width: 100%; }
    }
  `;
  document.head.appendChild(style);
}

// ============================================================ data
async function fetchAll() {
  const sb = getSupabase();
  const [nursesRes, offersRes, casesRes] = await Promise.all([
    sb.from('nurses').select('*').order('full_name', { ascending: true }),
    sb.from('case_offers').select('nurse_id, response'),
    sb.from('cases').select('assigned_nurse_id, status')
      .not('assigned_nurse_id', 'is', null)
      .in('status', LIVE_STATUSES),
  ]);

  if (nursesRes.error) throw new Error(nursesRes.error.message || 'Could not load nurses');
  state.nurses = nursesRes.data || [];

  // Offer stats degrade gracefully — a stats failure must not blank the roster.
  state.offerStats = new Map();
  if (offersRes.error) {
    console.error('[nurses] case_offers load failed:', offersRes.error);
  } else {
    for (const o of offersRes.data || []) {
      const s = state.offerStats.get(o.nurse_id) || { accepted: 0, total: 0 };
      s.total += 1;
      if (o.response === 'yes') s.accepted += 1;
      state.offerStats.set(o.nurse_id, s);
    }
  }

  state.assignments = new Map();
  if (casesRes.error) {
    console.error('[nurses] cases load failed:', casesRes.error);
  } else {
    for (const c of casesRes.data || []) {
      state.assignments.set(c.assigned_nurse_id, (state.assignments.get(c.assigned_nurse_id) || 0) + 1);
    }
  }
}

function skillsList(skills) {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills.filter(s => typeof s === 'string' && s.trim());
  if (Array.isArray(skills.tags)) return skills.tags.filter(s => typeof s === 'string' && s.trim());
  return [];
}

function filteredNurses() {
  const q = state.search.trim().toLowerCase();
  return state.nurses.filter(n => {
    // 'pool' / 'excluded' are the real broadcast test, not the Eligible switch
    // on its own - that switch is only one of the three conditions.
    if (state.filter === 'pool' && !poolStatus(n).inPool) return false;
    if (state.filter === 'excluded' && poolStatus(n).inPool) return false;
    if (state.filter === 'inactive' && n.is_active) return false;
    if (!q) return true;
    const hay = `${n.full_name} ${n.phone} ${skillsList(n.skills).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });
}

// ============================================================ render
export default async function render(container) {
  injectStyles();

  container.innerHTML = `
    <div id="nurse-pool-summary"></div>

    <div class="card card-flush">
      <div class="table-toolbar nurses-toolbar">
        <div class="table-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input class="form-input" id="nurse-search" type="search" placeholder="Search name, phone or skill…" autocomplete="off" />
        </div>
        <div class="chip-row" id="nurse-filters"></div>
        <button class="btn btn-primary" id="btn-add-nurse" style="margin-left:auto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          Add Nurse
        </button>
      </div>
      <div id="nurses-region" style="padding: var(--s4)">${renderSkeleton(6)}</div>
    </div>
  `;

  // ---- toolbar bindings ----
  const searchEl = container.querySelector('#nurse-search');
  searchEl.value = state.search;
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchEl.value;
      renderRegion(container);
    }, 160);
  });

  container.querySelector('#btn-add-nurse').addEventListener('click', () => openAddNurseModal(container));

  container.querySelector('#nurse-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderFilterChips(container);
    renderRegion(container);
  });

  // ---- delegated row actions (survive region re-renders) ----
  const region = container.querySelector('#nurses-region');
  region.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-toggle]');
    if (input) handleToggle(container, input);
  });
  region.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'deactivate') requestDeactivate(container, btn.dataset.id);
    if (btn.dataset.action === 'add-first') openAddNurseModal(container);
    if (btn.dataset.action === 'edit') openEditNurseModal(container, btn.dataset.id);
  });

  await refresh(container);
}

async function refresh(container) {
  if (state.loading) return;
  state.loading = true;
  try {
    await fetchAll();
    renderPoolSummary(container);
    renderFilterChips(container);
    renderRegion(container);
  } catch (err) {
    console.error('[nurses] load failed:', err);
    const region = container.querySelector('#nurses-region');
    if (region) {
      region.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <h3>Couldn't load the nurse pool</h3>
          <p>${escapeHtml(err.message || 'Unknown error')}</p>
          <button class="btn btn-secondary" onclick="location.reload()">Reload</button>
        </div>`;
    }
    showToast(err.message || 'Could not load nurses', 'error');
  } finally {
    state.loading = false;
  }
}

// The banner that answers "how many nurses can actually be reached", above the
// roster and before anyone starts reading rows. Rendered from the same
// poolStatus() the column uses, so the headline and the rows cannot disagree.
function renderPoolSummary(container) {
  const wrap = container.querySelector('#nurse-pool-summary');
  if (!wrap) return;
  const total = state.nurses.length;
  if (!total) { wrap.innerHTML = ''; return; }

  const inPool = state.nurses.filter(n => poolStatus(n).inPool).length;
  const out = total - inPool;

  // Count each exclusion reason separately: one nurse can fail two conditions,
  // so these overlap and deliberately do not sum to `out`.
  const stopped = state.nurses.filter(n => n.opted_out).length;
  const inactive = state.nurses.filter(n => !n.is_active).length;
  const paused = state.nurses.filter(n => !n.is_eligible).length;
  const breakdown = [
    stopped ? `${stopped} opted out` : '',
    inactive ? `${inactive} not active` : '',
    paused ? `${paused} with Eligible off` : '',
  ].filter(Boolean).join(' · ');

  const warn = out > 0;
  wrap.innerHTML = `
    <div class="${warn ? 'warn-banner' : 'info-banner'}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <div style="min-width:0">
        <div class="pool-summary">
          <span class="ps-fig"><span class="ps-n in">${inPool}</span><span class="ps-lbl">in the offer pool</span></span>
          <span class="ps-fig"><span class="ps-n out">${out}</span><span class="ps-lbl">receive no offers at all</span></span>
        </div>
        <p style="margin:6px 0 0">
          A nurse is sent a case offer only when <strong>all three</strong> hold: active, Eligible on, and she has not sent STOP.
          ${warn ? `The ${out} excluded nurse${out === 1 ? '' : 's'} will never see a new case, however many are open${breakdown ? ` (${escapeHtml(breakdown)})` : ''}.` : 'Every nurse on the roster is currently reachable.'}
        </p>
      </div>
    </div>`;
}

function renderFilterChips(container) {
  const wrap = container.querySelector('#nurse-filters');
  if (!wrap) return;
  const poolCount = state.nurses.filter(n => poolStatus(n).inPool).length;
  const inactiveCount = state.nurses.filter(n => !n.is_active).length;
  const chips = [
    { key: 'all', label: 'All', n: state.nurses.length },
    { key: 'pool', label: 'In offer pool', n: poolCount },
    { key: 'excluded', label: 'Gets no offers', n: state.nurses.length - poolCount },
    { key: 'inactive', label: 'Inactive', n: inactiveCount },
  ];
  wrap.innerHTML = chips.map(c => `
    <button class="fchip ${state.filter === c.key ? 'on' : ''}" data-filter="${c.key}" type="button">
      ${c.label} <span class="n">${c.n}</span>
    </button>
  `).join('');
}

function renderRegion(container) {
  const region = container.querySelector('#nurses-region');
  if (!region) return;

  if (state.nurses.length === 0) {
    region.style.padding = 'var(--s4)';
    region.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
        <h3>No nurses in the pool yet</h3>
        <p>Add your first nurse — once she's eligible, every new case registration will send her a WhatsApp offer automatically.</p>
        <button class="btn btn-primary" data-action="add-first">Add your first nurse</button>
      </div>`;
    return;
  }

  const rows = filteredNurses();
  if (rows.length === 0) {
    region.style.padding = 'var(--s4)';
    region.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <h3>No matches</h3>
        <p>No nurse matches this search and filter. Try a different name, phone digits or skill.</p>
      </div>`;
    return;
  }

  region.style.padding = '0';
  region.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Nurse</th>
            <th>Phone</th>
            <th>Language</th>
            <th>Offer pool</th>
            <th>Offers accepted</th>
            <th>Live cases</th>
            <th>Eligible</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(n => nurseRowHtml(n)).join('')}
        </tbody>
      </table>
    </div>
    <div class="table-pagination"><span>${rows.length} of ${state.nurses.length} nurse${state.nurses.length === 1 ? '' : 's'}</span></div>
  `;
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

function offerStatHtml(nurseId) {
  const s = state.offerStats.get(nurseId);
  if (!s || s.total === 0) return `<span class="cell-mono" style="color:var(--ink-4)">no offers yet</span>`;
  const pct = Math.round((s.accepted / s.total) * 100);
  const cls = pct >= 60 ? 'good' : pct >= 30 ? 'mid' : 'low';
  return `
    <span class="offer-stat" title="${s.accepted} accepted out of ${s.total} offers sent">
      <span class="os-frac">${s.accepted}/${s.total}</span>
      <span class="os-pct ${cls}">${pct}%</span>
    </span>`;
}

// The one cell that says, per nurse, whether a case offer can reach her - and
// when it cannot, exactly which condition is in the way. Every reason is
// actionable from this same row (the two switches) except STOP, which only the
// nurse can undo by messaging the number again, so that one says so.
function poolCellHtml(n) {
  const { inPool, reasons } = poolStatus(n);
  if (inPool) {
    return `<span class="badge badge-ok" title="Active, Eligible on, not opted out - she is sent every new case offer">Gets offers</span>`;
  }
  const why = reasons.join(' · ');
  const fixable = !n.opted_out;
  return `
    <span class="badge badge-danger" title="No case offer is sent to this nurse">No offers</span>
    <span class="pool-why">${escapeHtml(why)}${fixable ? '' : '<br/>Only she can undo this, by messaging us again'}</span>`;
}

function nurseRowHtml(n) {
  const skills = skillsList(n.skills);
  const liveCount = state.assignments.get(n.id) || 0;
  const skillsLine = skills.length
    ? escapeHtml(skills.slice(0, 3).join(' · ')) + (skills.length > 3 ? ` +${skills.length - 3}` : '')
    : `Added ${escapeHtml(formatDate(n.created_at))}`;
  return `
    <tr class="nurse-row ${n.is_active ? '' : 'inactive'}" data-id="${n.id}">
      <td class="cell-clamp">
        <div class="nurse-cell">
          <span class="avatar avatar-sm">${escapeHtml(initials(n.full_name))}</span>
          <div style="min-width:0">
            <div class="nc-name">${escapeHtml(n.full_name)}${n.opted_out ? ' <span class="badge badge-danger" title="This nurse sent STOP on WhatsApp — no messages will be sent to her">Opted out</span>' : ''}</div>
            <div class="nc-sub">${skillsLine}</div>
          </div>
        </div>
      </td>
      <td class="cell-mono" title="Full number hidden">${escapeHtml(maskPhone(n.phone))}</td>
      <td><span class="badge ${n.language_pref === 'hi' ? 'badge-violet' : 'badge-neutral'}">${escapeHtml(LANG_LABELS[n.language_pref] || n.language_pref)}</span></td>
      <td class="pool-cell">${poolCellHtml(n)}</td>
      <td>${offerStatHtml(n.id)}</td>
      <td class="cell-num">${liveCount === 0 ? '<span style="color:var(--ink-4)">0</span>' : `<span class="badge badge-primary">${liveCount}</span>`}</td>
      <td>
        <label class="switch" title="${n.is_active ? 'Receive new case offers' : 'Activate this nurse first'}">
          <input type="checkbox" data-toggle="is_eligible" data-id="${n.id}" ${n.is_eligible ? 'checked' : ''} ${n.is_active ? '' : 'disabled'} />
          <span class="knob"></span>
        </label>
      </td>
      <td>
        <label class="switch" title="${n.is_active ? 'Deactivate (removes from pool)' : 'Reactivate'}">
          <input type="checkbox" data-toggle="is_active" data-id="${n.id}" ${n.is_active ? 'checked' : ''} />
          <span class="knob"></span>
        </label>
      </td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${n.id}" title="Edit ${escapeHtml(n.full_name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        ${n.is_active ? `
          <button class="btn btn-ghost btn-sm" data-action="deactivate" data-id="${n.id}" title="Deactivate ${escapeHtml(n.full_name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
            Deactivate
          </button>` : `<span class="badge badge-neutral">Inactive</span>`}
      </td>
    </tr>`;
}

// ============================================================ Edit Nurse modal
// Mainly exists so the team can set/change a nurse's portal login email
// without opening the Supabase SQL Editor — everything else here was already
// editable via the toggles above, but email had no UI path at all.
function openEditNurseModal(container, id) {
  const nurse = state.nurses.find((x) => x.id === id);
  if (!nurse) return;

  const overlay = showModal({
    title: `Edit ${nurse.full_name}`,
    size: 'lg',
    content: `
      <form id="edit-nurse-form" novalidate>
        <div class="form-row">
                    <div class="form-group">
            <label class="form-label" for="en-email">Portal login email <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
            <input class="form-input" id="en-email" type="email" placeholder="nurse@example.com" value="${escapeHtml(nurse.email || '')}" autocomplete="off" />
            <span class="form-error" data-err="email" hidden></span>
          </div>
          <div class="form-group">
            <label class="form-label" for="en-password">Password <span style="text-transform:none;letter-spacing:0">(leave blank to auto-generate)</span></label>
            <div style="display:flex; gap:var(--s2); align-items:flex-start">
              <input class="form-input" id="en-password" type="text" placeholder="Type a password, or leave blank" autocomplete="new-password" style="flex:1" />
              <button class="btn btn-secondary" id="en-issue-login" type="button" style="white-space:nowrap">
                ${nurse.auth_user_id ? 'Set password' : 'Create login'}
              </button>
            </div>
            <span class="form-hint">Save the email above first if you just changed it, then set the password here. No Supabase dashboard needed.</span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="en-email">Portal login email <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
            <input class="form-input" id="en-email" type="email" placeholder="nurse@example.com" value="${escapeHtml(nurse.email || '')}" autocomplete="off" />
            <span class="form-hint">
              This lets her sign in to the nurse dashboard with a password instead of WhatsApp.
              You still need to create a matching Supabase Auth user (Authentication → Users)
              with this exact email — this field only links the two records together.
            </span>
            <span class="form-error" data-err="email" hidden></span>
          </div>
          <div class="form-group">
            <label class="form-label" for="en-lang">Language</label>
            <select class="form-select" id="en-lang">
              <option value="en" ${nurse.language_pref !== 'hi' ? 'selected' : ''}>English</option>
              <option value="hi" ${nurse.language_pref === 'hi' ? 'selected' : ''}>हिंदी (Hindi)</option>
            </select>
          </div>
        </div>
      </form>
    `,
    footer: `
      <button class="btn btn-secondary" data-en-cancel type="button">Cancel</button>
      <button class="btn btn-primary" data-en-save type="button">Save changes</button>
    `,
  });

  const $ = (sel) => overlay.querySelector(sel);
  const setErr = (key, msg) => {
    const el = overlay.querySelector(`[data-err="${key}"]`);
    const input = { name: $('#en-name'), phone: $('#en-phone'), email: $('#en-email') }[key];
    if (msg) { el.textContent = msg; el.hidden = false; input.classList.add('error'); }
    else { el.hidden = true; input.classList.remove('error'); }
  };

  $('[data-en-cancel]').addEventListener('click', () => closeModal());
  
  $('#en-issue-login').addEventListener('click', (e) => {
    issueLogin(e.currentTarget, 'nurse', id, nurse.full_name, $('#en-email').value, $('#en-password').value, container);
  });

  const saveBtn = $('[data-en-save]');
  saveBtn.addEventListener('click', async () => {
    const name = $('#en-name').value.trim();
    const phoneCheck = validateIndianPhone($('#en-phone').value);
    const emailRaw = $('#en-email').value.trim().toLowerCase();

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
      email: emailRaw || null,
      language_pref: $('#en-lang').value === 'hi' ? 'hi' : 'en',
    };

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    const sb = getSupabase();
    const { error } = await sb.from('nurses').update(patch).eq('id', id);
    if (error) {
      if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
        setErr(/phone/i.test(error.message || '') ? 'phone' : 'email', 'Already in use by another nurse');
      } else {
        showToast(error.message || 'Could not save changes', 'error');
      }
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
      return;
    }
    Object.assign(nurse, patch);
    closeModal();
    showToast(`${name} updated`, 'success');
    renderRegion(container);
  });

  requestAnimationFrame(() => $('#en-name')?.focus());
}

// ============================================================ mutations
async function updateNurse(container, id, patch, successMsg) {
  const sb = getSupabase();
  const { error } = await sb.from('nurses').update(patch).eq('id', id);
  if (error) {
    console.error('[nurses] update failed:', error);
    showToast(error.message || 'Update failed', 'error');
    // revert the optimistic UI by re-rendering from the last known state
    renderPoolSummary(container);
    renderFilterChips(container);
    renderRegion(container);
    return false;
  }
  // apply locally + re-render the region only (no full page reload)
  const n = state.nurses.find(x => x.id === id);
  if (n) Object.assign(n, patch);
  renderPoolSummary(container);
  renderFilterChips(container);
  renderRegion(container);
  if (successMsg) showToast(successMsg, 'success');
  return true;
}

function handleToggle(container, input) {
  const id = input.dataset.id;
  const field = input.dataset.toggle;
  const nurse = state.nurses.find(x => x.id === id);
  if (!nurse) return;

  // Both switches are only ONE of the three pool conditions, so the toast has to
  // be checked against the other two before it promises anything. Flipping
  // Eligible on for a nurse who has sent STOP changes nothing she will ever see,
  // and the old copy said "will receive new case offers" regardless.
  const stillBlocked = (patch) => poolStatus({ ...nurse, ...patch }).reasons;

  if (field === 'is_eligible') {
    const on = input.checked;
    const blocked = stillBlocked({ is_eligible: on });
    updateNurse(container, id, { is_eligible: on },
      on
        ? (blocked.length
          ? `${nurse.full_name} still gets no offers: ${blocked.join(', ')}`
          : `${nurse.full_name} will receive new case offers`)
        : `${nurse.full_name} is paused, no new offers`);
    return;
  }

  if (field === 'is_active') {
    if (!input.checked) {
      // Turning OFF is destructive — put the switch back and go through confirm.
      input.checked = true;
      requestDeactivate(container, id);
    } else {
      const blocked = stillBlocked({ is_active: true });
      updateNurse(container, id, { is_active: true },
        blocked.length
          ? `${nurse.full_name} reactivated, but still gets no offers: ${blocked.join(', ')}`
          : `${nurse.full_name} reactivated, she will receive new case offers`);
    }
  }
}

function requestDeactivate(container, id) {
  const nurse = state.nurses.find(x => x.id === id);
  if (!nurse) return;
  const liveCount = state.assignments.get(id) || 0;
  const liveWarning = liveCount > 0
    ? `<br/><br/><strong>Heads up:</strong> she is currently on <strong>${liveCount} live case${liveCount === 1 ? '' : 's'}</strong>. Deactivating does not reassign them — do that from each case's page.`
    : '';
  confirmModal(
    `Deactivate <strong>${escapeHtml(nurse.full_name)}</strong>? She will stop receiving case offers and disappear from assignment lists. Her history stays intact and you can reactivate her anytime.${liveWarning}`,
    () => updateNurse(container, id, { is_active: false }, `${nurse.full_name} deactivated`),
    { title: 'Deactivate nurse', confirmLabel: 'Deactivate', danger: true },
  );
}

// ============================================================ Add Nurse modal
function openAddNurseModal(container) {
  const skills = [];

  const overlay = showModal({
    title: 'Add Nurse',
    size: 'lg',
    content: `
      <form id="add-nurse-form" novalidate>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="an-name">Full name <span class="required">*</span></label>
            <input class="form-input" id="an-name" type="text" placeholder="e.g. Anita Sharma" autocomplete="off" required />
            <span class="form-error" data-err="name" hidden></span>
          </div>
          <div class="form-group">
            <label class="form-label" for="an-phone">WhatsApp number <span class="required">*</span></label>
            <input class="form-input" id="an-phone" type="tel" inputmode="numeric" placeholder="10-digit mobile, e.g. 98765 43210" autocomplete="off" required />
            <span class="form-hint">This is where case offers arrive. Must be on WhatsApp.</span>
            <span class="form-error" data-err="phone" hidden></span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="an-lang">Language</label>
            <select class="form-select" id="an-lang">
              <option value="en" selected>English</option>
              <option value="hi">हिंदी (Hindi)</option>
            </select>
            <span class="form-hint">Templates and messages go out in this language.</span>
          </div>
          <div class="form-group">
            <label class="form-label" for="an-skill">Skills <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
            <input class="form-input" id="an-skill" type="text" placeholder="Type a skill, press Enter — e.g. chemo port" autocomplete="off" />
            <div class="skills-chips" id="an-skill-chips" style="margin-top:6px"></div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="an-email">Portal login email <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
          <input class="form-input" id="an-email" type="email" placeholder="nurse@example.com" autocomplete="off" />
          <span class="form-hint">Lets her sign in to the nurse dashboard with a password. Create a matching Supabase Auth user with this same email afterwards.</span>
          <span class="form-error" data-err="email" hidden></span>
        </div>
        <div class="form-group">
          <label class="form-label" for="an-notes">Notes <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
          <textarea class="form-textarea" id="an-notes" rows="2" placeholder="Availability, locality, anything the team should know"></textarea>
        </div>
      </form>
    `,
    footer: `
      <button class="btn btn-secondary" data-an-cancel type="button">Cancel</button>
      <button class="btn btn-primary" data-an-save type="button">Add Nurse</button>
    `,
  });

  const $ = (sel) => overlay.querySelector(sel);

  // ---- skills chips ----
  const skillInput = $('#an-skill');
  const chipsWrap = $('#an-skill-chips');
  function renderChips() {
    chipsWrap.innerHTML = skills.map((s, i) => `
      <span class="skill-chip">${escapeHtml(s)}
        <button type="button" data-chip-rm="${i}" aria-label="Remove ${escapeHtml(s)}">×</button>
      </span>`).join('');
  }
  function addSkillFromInput() {
    const raw = skillInput.value.trim().replace(/,+$/, '').trim();
    if (!raw) return;
    if (raw.length > 60) { showToast('Keep each skill under 60 characters', 'warning'); return; }
    if (!skills.some(s => s.toLowerCase() === raw.toLowerCase())) skills.push(raw);
    skillInput.value = '';
    renderChips();
  }
  skillInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkillFromInput(); }
  });
  skillInput.addEventListener('blur', addSkillFromInput);
  chipsWrap.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-chip-rm]');
    if (!rm) return;
    skills.splice(Number(rm.dataset.chipRm), 1);
    renderChips();
  });

  // ---- inline validation helpers ----
  function setErr(key, msg) {
    const el = overlay.querySelector(`[data-err="${key}"]`);
    const input = key === 'name' ? $('#an-name') : $('#an-phone');
    if (msg) { el.textContent = msg; el.hidden = false; input.classList.add('error'); }
    else { el.hidden = true; input.classList.remove('error'); }
  }
  $('#an-name').addEventListener('input', () => setErr('name', null));
  $('#an-phone').addEventListener('input', () => setErr('phone', null));

  $('[data-an-cancel]').addEventListener('click', () => closeModal());

  // ---- save ----
  const saveBtn = $('[data-an-save]');
  saveBtn.addEventListener('click', async () => {
    addSkillFromInput(); // capture a half-typed skill

    const name = $('#an-name').value.trim();
    const phoneCheck = validateIndianPhone($('#an-phone').value);
    const emailRaw = $('#an-email').value.trim().toLowerCase();
    let bad = false;
    if (!name) { setErr('name', 'Full name is required'); bad = true; }
    if (!phoneCheck.ok) { setErr('phone', phoneCheck.error); bad = true; }
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      const el = overlay.querySelector('[data-err="email"]');
      el.textContent = 'Enter a valid email address'; el.hidden = false;
      bad = true;
    }
    if (bad) return;

    const row = {
      full_name: name,
      phone: phoneCheck.normalized,
      email: emailRaw || null,
      language_pref: $('#an-lang').value === 'hi' ? 'hi' : 'en',
      skills: { tags: skills },
      notes: $('#an-notes').value.trim() || null,
      // is_eligible / is_active default true in the schema
    };

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const sb = getSupabase();
      const { error } = await sb.from('nurses').insert(row);
      if (error) {
        if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
          setErr('phone', 'A nurse with this phone number already exists');
        } else {
          showToast(error.message || 'Could not add the nurse', 'error');
        }
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add Nurse';
        return;
      }
      closeModal();
      showToast(`${name} added — she's eligible and will receive offers for new cases`, 'success');
      await refresh(container);
    } catch (err) {
      console.error('[nurses] insert failed:', err);
      showToast(err.message || 'Could not add the nurse', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add Nurse';
    }
  });

  // Focus the first field once the modal is in the DOM.
  requestAnimationFrame(() => $('#an-name')?.focus());
}