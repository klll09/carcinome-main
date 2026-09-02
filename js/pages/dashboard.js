// ============================================================
// Carcinome Home Care — #dashboard
//   • Stat tiles from rpc get_dashboard_stats()
//   • "Needs action": offering >3h, invoices paid_claimed
//     (verify → adminAction mark_paid_verified), locked OTPs,
//     failed messages (24h)
//   • "Today's schedule": today's sessions (IST day), time /
//     patient / nurse / status
//   • Auto-refresh every 60s (silent — no skeleton flash)
// ============================================================

import { getSupabase } from '../supabase.js';
import { adminAction } from '../utils/api.js';
import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import {
  formatTime, formatDateTime, formatRelativeTime, formatPhone, formatINR,
  caseStatusBadge, careTypeLabel, escapeHtml, renderSkeleton,
} from '../utils/formatters.js';

// ---- page-scoped styles (injected once) ----
const STYLE_ID = 'dashboard-page-css';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .dash-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: var(--s4); margin-bottom: var(--s6); }
    .dash-stat { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s3); text-decoration: none; }
    .dash-stat.alerting { border-color: color-mix(in srgb, var(--danger) 38%, var(--line)); }
    .dash-stat.alerting .stat-icon { background: var(--danger-soft); color: var(--danger); }
    .dash-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: var(--s5); align-items: start; }
    @media (max-width: 1100px) { .dash-grid { grid-template-columns: 1fr; } }
    .na-group + .na-group { margin-top: var(--s4); }
    .na-group-title { display: flex; align-items: center; gap: 8px; font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); padding: 0 var(--s2) var(--s2); }
    .na-group-title .n { font-family: var(--font-mono); background: var(--bg-sunken); color: var(--ink-2); border-radius: var(--r-pill); padding: 1px 8px; font-size: 10.5px; }
    .na-row { display: flex; align-items: center; gap: var(--s3); padding: 10px var(--s2); border-top: 1px solid var(--line); min-width: 0; }
    .na-row:hover { background: var(--surface-3); }
    .na-main { flex: 1; min-width: 0; }
    .na-title { font: var(--t-body-strong); font-size: 14px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .na-title a { color: inherit; text-decoration: none; }
    .na-title a:hover { color: var(--primary); text-decoration: underline; }
    .na-sub { font: var(--t-xs); color: var(--ink-3); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .na-side { flex: none; display: flex; align-items: center; gap: var(--s2); }
    .na-age { font: var(--t-mono); font-size: 11px; color: var(--warn); white-space: nowrap; }
    .na-age.hot { color: var(--danger); }
    .dash-allclear { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: var(--s7) var(--s4); color: var(--ink-3); }
    .dash-allclear .ico { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: var(--ok-soft); color: var(--ok); }
    .dash-allclear .ico svg { width: 22px; height: 22px; }
    .dash-allclear h4 { font: 700 15.5px/1.3 var(--font-display); color: var(--ink-2); }
    .dash-refreshed { font: var(--t-mono); font-size: 10.5px; color: var(--ink-4); white-space: nowrap; }
    .sched-time { font-family: var(--font-mono); font-size: 12.5px; color: var(--ink); white-space: nowrap; }
    .sched-unassigned { color: var(--ink-4); font-style: italic; }
    @media (max-width: 640px) {
      .dash-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s3); }
      .na-row { flex-wrap: wrap; }
      .na-side { margin-left: auto; }
    }
  `;
  document.head.appendChild(style);
}

// ---- IST helpers ----
const IST_OFFSET_MS = 5.5 * 3600 * 1000; // IST is always UTC+5:30
function istDayBoundsUtcIso() {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const startMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 24 * 3600 * 1000).toISOString() };
}

// ---- render-generation guard: a stale async load must never paint ----
let renderSeq = 0;
let refreshTimer = null;

// ---- icons ----
const I = {
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  nurse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>',
  rupee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a6 5 0 0 0 6-5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
};

// ============================================================
// Data loading
// ============================================================
async function loadStats(sb) {
  const { data, error } = await sb.rpc('get_dashboard_stats');
  if (error) throw error;
  return data || {};
}

async function loadNeedsAction(sb) {
  const cutoff3h = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [offering, invoices, lockedOtps, failedMsgs] = await Promise.allSettled([
    sb.from('cases')
      .select('id, case_code, created_at, scheduled_at, care_type, patients(full_name)')
      .eq('status', 'offering')
      .lt('created_at', cutoff3h)
      .order('created_at', { ascending: true })
      .limit(20),
    sb.from('invoices')
      .select('id, invoice_no, total_inr, paid_claimed_at, case_id, cases(case_code, patients(full_name))')
      .eq('status', 'paid_claimed')
      .order('paid_claimed_at', { ascending: true })
      .limit(20),
    sb.from('otps')
      .select('id, case_id, expected_from_phone, attempts, created_at, cases(case_code, patients(full_name))')
      .eq('status', 'locked')
      .order('created_at', { ascending: false })
      .limit(20),
    sb.from('messages')
      .select('id, phone, participant_role, msg_type, template_name, error, created_at, case_id')
      .eq('status', 'failed')
      .gt('created_at', cutoff24h)
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

  const unwrap = (settled, label) => {
    if (settled.status === 'rejected') { console.error(`[dashboard] ${label} query threw:`, settled.reason); return []; }
    if (settled.value.error) { console.error(`[dashboard] ${label} query failed:`, settled.value.error); return []; }
    return settled.value.data || [];
  };

  return {
    offering: unwrap(offering, 'offering>3h'),
    invoices: unwrap(invoices, 'paid_claimed'),
    lockedOtps: unwrap(lockedOtps, 'locked otps'),
    failedMsgs: unwrap(failedMsgs, 'failed messages'),
  };
}

async function loadSchedule(sb) {
  const { start, end } = istDayBoundsUtcIso();
  const { data, error } = await sb.from('cases')
    .select('id, case_code, scheduled_at, status, care_type, patients(full_name), nurses(full_name)')
    .gte('scheduled_at', start)
    .lt('scheduled_at', end)
    .not('status', 'in', '(archived,cancelled,paid)')
    .order('scheduled_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return data || [];
}

// ============================================================
// Renderers
// ============================================================
function statTile({ label, value, icon, href, alerting }) {
  const inner = `
    <div>
      <div class="stat-value">${value === null || value === undefined ? '—' : Number(value)}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
    </div>
    <div class="stat-icon">${icon}</div>`;
  const cls = `stat-card dash-stat${alerting ? ' alerting' : ''}`;
  return href
    ? `<a class="${cls}" href="${href}">${inner}</a>`
    : `<div class="${cls}">${inner}</div>`;
}

function renderStats(el, stats) {
  const s = stats || {};
  el.innerHTML = [
    statTile({ label: "Today's sessions", value: s.today_sessions, icon: I.calendar, href: '#cases' }),
    statTile({ label: 'Awaiting nurse', value: s.awaiting_nurse, icon: I.nurse, href: '#cases', alerting: Number(s.awaiting_nurse) > 0 }),
    statTile({ label: 'Payments to verify', value: s.payments_to_verify, icon: I.rupee, alerting: Number(s.payments_to_verify) > 0 }),
    statTile({ label: 'Failed msgs (24h)', value: s.failed_msgs_24h, icon: I.alert, href: '#messages?failed=1', alerting: Number(s.failed_msgs_24h) > 0 }),
    statTile({ label: 'Locked OTPs', value: s.locked_otps, icon: I.lock, alerting: Number(s.locked_otps) > 0 }),
    statTile({ label: 'Open cases', value: s.open_cases, icon: I.folder, href: '#cases' }),
  ].join('');
}

function caseLink(caseId, text) {
  return `<a href="#cases/${escapeHtml(caseId)}">${escapeHtml(text)}</a>`;
}

function ageSpan(ts, hotAfterHrs = 6) {
  if (!ts) return '';
  const hrs = (Date.now() - new Date(ts).getTime()) / 3600000;
  return `<span class="na-age${hrs >= hotAfterHrs ? ' hot' : ''}">${escapeHtml(formatRelativeTime(ts))}</span>`;
}

function naGroup(title, count, rowsHtml) {
  if (!rowsHtml) return '';
  return `
    <div class="na-group">
      <div class="na-group-title">${escapeHtml(title)} <span class="n">${count}</span></div>
      ${rowsHtml}
    </div>`;
}

function renderNeedsAction(el, na) {
  const offeringRows = na.offering.map((c) => `
    <div class="na-row">
      <div class="na-main">
        <div class="na-title">${caseLink(c.id, `${c.patients?.full_name || 'Unknown patient'} · ${c.case_code}`)}</div>
        <div class="na-sub">${escapeHtml(careTypeLabel(c.care_type))} · session ${escapeHtml(formatDateTime(c.scheduled_at))} · no nurse accepted yet</div>
      </div>
      <div class="na-side">${ageSpan(c.created_at)}</div>
    </div>`).join('');

  const invoiceRows = na.invoices.map((inv) => `
    <div class="na-row">
      <div class="na-main">
        <div class="na-title">${caseLink(inv.case_id, `${inv.cases?.patients?.full_name || 'Unknown patient'} · ${inv.invoice_no}`)}</div>
        <div class="na-sub">${escapeHtml(formatINR(inv.total_inr))} claimed paid ${escapeHtml(formatRelativeTime(inv.paid_claimed_at))} · ${escapeHtml(inv.cases?.case_code || '')}</div>
      </div>
      <div class="na-side">
        <button class="btn btn-success btn-sm" data-verify-case="${escapeHtml(inv.case_id)}" data-invoice-no="${escapeHtml(inv.invoice_no)}" data-amount="${escapeHtml(formatINR(inv.total_inr))}">
          ${I.check} Verify
        </button>
      </div>
    </div>`).join('');

  const otpRows = na.lockedOtps.map((o) => `
    <div class="na-row">
      <div class="na-main">
        <div class="na-title">${caseLink(o.case_id, `${o.cases?.patients?.full_name || 'Unknown patient'} · ${o.cases?.case_code || 'case'}`)}</div>
        <div class="na-sub">OTP locked after ${Number(o.attempts) || 5} wrong attempts from ${escapeHtml(formatPhone(o.expected_from_phone))} — re-issue from the case page</div>
      </div>
      <div class="na-side">${ageSpan(o.created_at, 1)}</div>
    </div>`).join('');

  const msgRows = na.failedMsgs.map((m) => {
    const what = m.template_name ? `Template ${m.template_name}` : `${m.msg_type || 'message'}`;
    let reason = '';
    try {
      const e = m.error;
      reason = (e && (e.message || e.error?.message || e.details)) || (typeof e === 'string' ? e : '');
    } catch { /* ignore */ }
    const title = m.case_id
      ? caseLink(m.case_id, `${what} → ${formatPhone(m.phone)}`)
      : escapeHtml(`${what} → ${formatPhone(m.phone)}`);
    return `
      <div class="na-row">
        <div class="na-main">
          <div class="na-title">${title}</div>
          <div class="na-sub">${escapeHtml(reason || 'Send failed — see Messages for full error')}</div>
        </div>
        <div class="na-side">${ageSpan(m.created_at, 12)}</div>
      </div>`;
  }).join('');

  const groups =
    naGroup('Awaiting nurse for 3+ hours', na.offering.length, offeringRows) +
    naGroup('Payments claimed — verify', na.invoices.length, invoiceRows) +
    naGroup('Locked OTPs', na.lockedOtps.length, otpRows) +
    naGroup('Failed messages (24h)', na.failedMsgs.length, msgRows);

  el.innerHTML = groups || `
    <div class="dash-allclear">
      <div class="ico">${I.check}</div>
      <h4>All clear</h4>
      <p>No stuck offers, unverified payments, locked OTPs or failed messages right now.</p>
    </div>`;
}

function renderSchedule(el, rows) {
  if (!rows.length) {
    el.innerHTML = `
      <div class="dash-allclear">
        <div class="ico">${I.calendar}</div>
        <h4>No sessions scheduled today</h4>
        <p>New sessions appear here as soon as a case is registered for today (IST).</p>
      </div>`;
    return;
  }
  const body = rows.map((c) => `
    <tr class="clickable row-link" data-case-href="#cases/${escapeHtml(c.id)}" tabindex="0">
      <td class="sched-time">${escapeHtml(formatTime(c.scheduled_at))}</td>
      <td class="cell-clamp">${escapeHtml(c.patients?.full_name || 'Unknown patient')}</td>
      <td class="cell-clamp">${c.nurses?.full_name ? escapeHtml(c.nurses.full_name) : '<span class="sched-unassigned">Unassigned</span>'}</td>
      <td>${caseStatusBadge(c.status)}</td>
      <td class="cell-mono">${escapeHtml(c.case_code)}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="table-wrap">
      <table class="data data-table">
        <thead><tr><th>Time (IST)</th><th>Patient</th><th>Nurse</th><th>Status</th><th>Case</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// ============================================================
// Verify payment action
// ============================================================
function handleVerifyClick(btn, refresh) {
  const caseId = btn.dataset.verifyCase;
  const invoiceNo = btn.dataset.invoiceNo || 'this invoice';
  const amount = btn.dataset.amount || '';
  confirmModal(
    `Mark <strong>${escapeHtml(invoiceNo)}</strong>${amount ? ` (${escapeHtml(amount)})` : ''} as paid &amp; verified?<br><br>` +
    `This confirms the money actually arrived and sends a payment-received message on WhatsApp to the case participants. It cannot be undone from here.`,
    async () => {
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
      try {
        await adminAction('mark_paid_verified', { case_id: caseId });
        showToast(`${invoiceNo} marked as paid & verified`, 'success');
        await refresh(); // repaint stats + needs-action + schedule regions
      } catch (err) {
        console.error('[dashboard] mark_paid_verified failed:', err);
        showToast(err.message || 'Could not verify the payment', 'error');
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = original; }
      }
    },
    { title: 'Verify payment', confirmLabel: 'Yes, payment received', danger: false },
  );
}

// ============================================================
// Page entry
// ============================================================
export default async function render(container) {
  injectStyles();
  const seq = ++renderSeq;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  // Fresh root each render → the delegated click listener never duplicates.
  const root = document.createElement('div');
  root.id = 'dash-root';
  root.innerHTML = `
    <div class="dash-stats" id="dash-stats">
      ${Array.from({ length: 6 }, () => '<div class="skeleton" style="height:96px;border-radius:var(--r-lg)"></div>').join('')}
    </div>
    <div class="dash-grid">
      <div class="card card-flush">
        <div class="card-head">
          <h3>Needs action</h3>
          <span class="dash-refreshed" id="dash-refreshed-at"></span>
        </div>
        <div id="dash-actions" style="padding: var(--s3) var(--s4) var(--s4)">${renderSkeleton(4)}</div>
      </div>
      <div class="card card-flush">
        <div class="card-head"><h3>Today's schedule</h3></div>
        <div id="dash-schedule" style="padding: 0 var(--s4) var(--s4)">
          <div style="padding-top: var(--s4)">${renderSkeleton(5)}</div>
        </div>
      </div>
    </div>`;
  container.replaceChildren(root);

  const statsEl = root.querySelector('#dash-stats');
  const actionsEl = root.querySelector('#dash-actions');
  const scheduleEl = root.querySelector('#dash-schedule');
  const refreshedEl = root.querySelector('#dash-refreshed-at');

  let refreshing = false;
  async function refresh() {
    if (refreshing || seq !== renderSeq || !root.isConnected) return;
    refreshing = true;
    try {
      const sb = getSupabase();
      const [stats, na, sched] = await Promise.allSettled([
        loadStats(sb), loadNeedsAction(sb), loadSchedule(sb),
      ]);
      if (seq !== renderSeq || !root.isConnected) return; // page navigated away mid-flight

      if (stats.status === 'fulfilled') renderStats(statsEl, stats.value);
      else {
        console.error('[dashboard] get_dashboard_stats failed:', stats.reason);
        statsEl.innerHTML = `
          <div class="card" style="grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:var(--s3);flex-wrap:wrap">
            <span style="font:var(--t-sm);color:var(--ink-2)">Could not load the summary tiles — ${escapeHtml(stats.reason?.message || 'network error')}</span>
            <button class="btn btn-secondary btn-sm" data-dash-retry>Retry</button>
          </div>`;
      }

      if (na.status === 'fulfilled') renderNeedsAction(actionsEl, na.value);
      else {
        console.error('[dashboard] needs-action load failed:', na.reason);
        actionsEl.innerHTML = `<div class="dash-allclear"><h4>Could not load</h4><p>${escapeHtml(na.reason?.message || 'Network error')}</p><button class="btn btn-secondary btn-sm" data-dash-retry>Retry</button></div>`;
      }

      if (sched.status === 'fulfilled') renderSchedule(scheduleEl, sched.value);
      else {
        console.error('[dashboard] schedule load failed:', sched.reason);
        scheduleEl.innerHTML = `<div class="dash-allclear"><h4>Could not load today's schedule</h4><p>${escapeHtml(sched.reason?.message || 'Network error')}</p><button class="btn btn-secondary btn-sm" data-dash-retry>Retry</button></div>`;
      }

      if (refreshedEl) refreshedEl.textContent = `updated ${formatTime(new Date().toISOString())}`;
    } catch (err) {
      // Defensive: getSupabase() can throw if the CDN client never loaded.
      console.error('[dashboard] refresh failed:', err);
      if (seq === renderSeq) showToast(err.message || 'Dashboard refresh failed', 'error');
    } finally {
      refreshing = false;
    }
  }

  // Delegated clicks: verify buttons, retry buttons, schedule row links.
  root.addEventListener('click', (e) => {
    const verifyBtn = e.target.closest('[data-verify-case]');
    if (verifyBtn) { handleVerifyClick(verifyBtn, refresh); return; }
    if (e.target.closest('[data-dash-retry]')) { refresh(); return; }
    if (e.target.closest('a')) return; // real links navigate themselves
    const row = e.target.closest('[data-case-href]');
    if (row) window.location.hash = row.dataset.caseHref;
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest?.('[data-case-href]');
    if (row) window.location.hash = row.dataset.caseHref;
  });

  await refresh();

  // Auto-refresh every 60s while this render is still mounted.
  refreshTimer = setInterval(() => {
    if (seq !== renderSeq || !root.isConnected) {
      clearInterval(refreshTimer);
      refreshTimer = null;
      return;
    }
    refresh();
  }, 60000);
}
