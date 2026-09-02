// ============================================================
// Carcinome Home Care — #messages
// Global WhatsApp ledger explorer: every inbound + outbound
// message, filterable, paginated, exportable. Read-only page —
// no WhatsApp-triggering actions live here.
// ============================================================

import { getSupabase } from '../supabase.js';
import { CONFIG } from '../config.js';
import { showToast } from '../components/toast.js';
import {
  formatDateTime,
  formatRelativeTime,
  maskPhone,
  capitalize,
  escapeHtml,
  exportToCSV,
  renderSkeleton,
} from '../utils/formatters.js';

// ---- page-scoped styles (injected once, id-guarded) ----
const STYLE_ID = 'messages-page-style';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .msg-filter-bar { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: flex-end; padding: var(--s4); border-bottom: 1px solid var(--line); }
    .msg-filter-bar .field { min-width: 130px; flex: 0 1 auto; }
    .msg-filter-bar .field.grow { flex: 1 1 170px; max-width: 240px; }
    .msg-filter-bar .field > label { white-space: nowrap; }
    .msg-toolbar-right { display: flex; gap: var(--s2); align-items: center; margin-left: auto; flex-wrap: wrap; }
    .msg-chip-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); }
    .msg-dir-arrow { font-weight: 800; font-size: 15px; line-height: 1; }
    .msg-dir-arrow.in  { color: var(--ok); }
    .msg-dir-arrow.out { color: var(--primary); }
    .msg-row-failed td { background: var(--danger-soft); }
    .msg-body-cell { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg-expand-btn { border: none; background: none; color: var(--primary); font: var(--t-xs); font-weight: 700; cursor: pointer; padding: 0 2px; }
    .msg-expand-btn:hover { text-decoration: underline; }
    .msg-detail-row td { background: var(--bg-sunken); white-space: normal; padding: var(--s4) var(--s5); }
    .msg-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--s3); }
    .msg-detail-grid .k { font: var(--t-mono-label); color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 3px; }
    .msg-detail-grid .v { font: var(--t-sm); color: var(--ink); overflow-wrap: anywhere; white-space: pre-wrap; }
    .msg-detail-full { grid-column: 1 / -1; }
    .msg-error-box { background: var(--surface); border: 1px solid var(--danger); border-radius: var(--r-sm); padding: var(--s3); font-family: var(--font-mono); font-size: 11.5px; color: var(--danger); overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow-y: auto; }
    .msg-billable { color: var(--warn); font-weight: 800; cursor: help; }
    .msg-free { color: var(--ink-4); }
    .msg-auto-wrap { display: inline-flex; align-items: center; gap: 8px; font: var(--t-xs); font-weight: 600; color: var(--ink-2); }
    .msg-case-link { color: var(--primary); font-family: var(--font-mono); font-size: 12px; text-decoration: none; font-weight: 600; }
    .msg-case-link:hover { text-decoration: underline; }
    /* ---- mobile cards ---- */
    .msg-cards { display: none; }
    .msg-card { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); padding: var(--s3) var(--s4); }
    .msg-card.failed { border-color: var(--danger); background: var(--danger-soft); }
    .msg-card-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .msg-card-top .who { font: var(--t-body-strong); font-size: 13.5px; }
    .msg-card-top .when { margin-left: auto; font: var(--t-mono); font-size: 10.5px; color: var(--ink-3); }
    .msg-card-body { font: var(--t-sm); color: var(--ink-2); margin-top: 6px; overflow-wrap: anywhere; }
    .msg-card-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; font: var(--t-xs); color: var(--ink-3); }
    .msg-card .msg-error-box { margin-top: 8px; }
    @media (max-width: 760px) {
      .msg-table-wrap { display: none; }
      .msg-cards { display: flex; flex-direction: column; gap: var(--s2); padding: var(--s3); }
      .msg-filter-bar .field, .msg-filter-bar .field.grow { flex: 1 1 45%; max-width: none; min-width: 0; }
      .msg-toolbar-right { margin-left: 0; width: 100%; justify-content: space-between; }
    }
  `;
  document.head.appendChild(style);
}

// ---- constants ----
const MSG_STATUSES = ['pending', 'accepted', 'sent', 'delivered', 'read', 'failed'];
const EXPORT_CAP = 2000;
const AUTO_REFRESH_MS = 20000;

// ---- status ticks (WhatsApp-style) ----
function statusTicks(status) {
  switch (status) {
    case 'pending':   return `<span class="msg-ticks pending" title="Pending — not yet accepted by Meta">◌</span>`;
    case 'accepted':  return `<span class="msg-ticks" title="Accepted by Meta">✓</span>`;
    case 'sent':      return `<span class="msg-ticks" title="Sent">✓</span>`;
    case 'delivered': return `<span class="msg-ticks" title="Delivered">✓✓</span>`;
    case 'read':      return `<span class="msg-ticks read" title="Read">✓✓</span>`;
    case 'failed':    return `<span class="msg-ticks failed" title="Failed — expand row for error">✕</span>`;
    default:          return `<span class="msg-ticks">${escapeHtml(status || '—')}</span>`;
  }
}

function statusBadge(status) {
  const map = {
    pending: 'badge-neutral', accepted: 'badge-info', sent: 'badge-info',
    delivered: 'badge-success', read: 'badge-success', failed: 'badge-danger',
  };
  return `<span class="badge ${map[status] || 'badge-neutral'}">${escapeHtml(capitalize(status || '—'))}</span>`;
}

function truncate(str, max = 110) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function prettyJson(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

// ============================================================
// Page module
// ============================================================
export default async function render(container, params) {
  injectStyles();

  // ---- state ----
  const state = {
    direction: 'all',        // all | in | out
    status: 'all',           // all | <msg_status>
    kind: 'all',             // all | template | freeform
    phone: '',               // digits substring
    caseCode: '',            // joined cases.case_code ilike
    from: '',                // yyyy-mm-dd (IST day)
    to: '',                  // yyyy-mm-dd (IST day, inclusive)
    page: 0,
    pageSize: CONFIG.DEFAULT_PAGE_SIZE || 25,
    total: 0,
    rows: [],
    loading: false,
    autoRefresh: false,
  };
  const expanded = new Set(); // message ids with open detail row
  let refreshTimer = null;
  let fetchSeq = 0; // ignore out-of-order responses

  // ---- shell ----
  container.innerHTML = `
    <div class="card card-flush" id="msg-page">
      <div class="card-head">
        <div>
          <h3>Message Ledger</h3>
          <div class="card-subtitle">Every WhatsApp message, in and out — delivery states, billing, case links.</div>
        </div>
        <div class="msg-toolbar-right">
          <label class="msg-auto-wrap" title="Refresh this list automatically every ${AUTO_REFRESH_MS / 1000}s">
            <span class="switch">
              <input type="checkbox" id="msg-auto-refresh" />
              <span class="knob"></span>
            </span>
            Auto-refresh
          </label>
          <button class="btn btn-secondary btn-sm" id="msg-export-btn" title="Export the current filter to CSV (up to ${EXPORT_CAP} rows)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
        </div>
      </div>

      <div class="msg-chip-row" id="msg-chips">
        <button class="fchip on" data-chip="all">All messages</button>
        <button class="fchip" data-chip="failed">⚠ Failed only</button>
        <button class="fchip" data-chip="in">↙ Inbound</button>
        <button class="fchip" data-chip="out">↗ Outbound</button>
        <button class="fchip" data-chip="billable">₹ Billable</button>
      </div>

      <div class="msg-filter-bar">
        <div class="field">
          <label for="msg-f-direction">Direction</label>
          <select class="select" id="msg-f-direction">
            <option value="all">All</option>
            <option value="in">Inbound ↙</option>
            <option value="out">Outbound ↗</option>
          </select>
        </div>
        <div class="field">
          <label for="msg-f-status">Status</label>
          <select class="select" id="msg-f-status">
            <option value="all">All</option>
            ${MSG_STATUSES.map(s => `<option value="${s}">${capitalize(s)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="msg-f-kind">Kind</label>
          <select class="select" id="msg-f-kind">
            <option value="all">All</option>
            <option value="template">Template</option>
            <option value="freeform">Free-form</option>
          </select>
        </div>
        <div class="field grow">
          <label for="msg-f-phone">Phone</label>
          <input class="input" id="msg-f-phone" type="search" inputmode="numeric" placeholder="e.g. 98765…" autocomplete="off" />
        </div>
        <div class="field grow">
          <label for="msg-f-case">Case code</label>
          <input class="input" id="msg-f-case" type="search" placeholder="CASE-2026-…" autocomplete="off" />
        </div>
        <div class="field">
          <label for="msg-f-from">From (IST)</label>
          <input class="input" id="msg-f-from" type="date" />
        </div>
        <div class="field">
          <label for="msg-f-to">To (IST)</label>
          <input class="input" id="msg-f-to" type="date" />
        </div>
        <div class="field">
          <label>&nbsp;</label>
          <button class="btn btn-ghost btn-sm" id="msg-f-clear" title="Clear all filters">Clear</button>
        </div>
      </div>

      <div id="msg-results" aria-live="polite"></div>

      <div class="table-pagination" id="msg-pagination" hidden>
        <span id="msg-page-info"></span>
        <div class="page-buttons">
          <button class="btn btn-secondary btn-sm" id="msg-prev">← Prev</button>
          <button class="btn btn-secondary btn-sm" id="msg-next">Next →</button>
        </div>
      </div>
    </div>
  `;

  const el = (id) => container.querySelector(`#${id}`);
  const resultsEl = el('msg-results');

  // ============================================================
  // Query building (shared by page fetch + CSV export)
  // ============================================================
  // 'billable' is a pseudo direction filter driven by the quick chip.
  let billableOnly = false;

  function buildQuery({ forExport = false } = {}) {
    const sb = getSupabase();
    const caseSearch = state.caseCode.trim();
    // The join is only forced inner when we actually filter on it —
    // otherwise messages with no case (unknown numbers) must still appear.
    const selectCols = caseSearch
      ? 'id, wamid, direction, case_id, phone, participant_role, msg_type, template_name, body, status, status_at, error, pricing_category, billable, relay_of, created_at, cases!inner(case_code)'
      : 'id, wamid, direction, case_id, phone, participant_role, msg_type, template_name, body, status, status_at, error, pricing_category, billable, relay_of, created_at, cases(case_code)';

    let q = sb.from('messages').select(selectCols, { count: forExport ? undefined : 'exact' });

    if (state.direction !== 'all') q = q.eq('direction', state.direction);
    if (state.status !== 'all') q = q.eq('status', state.status);
    if (state.kind === 'template') q = q.not('template_name', 'is', null);
    if (state.kind === 'freeform') q = q.is('template_name', null);
    if (billableOnly) q = q.eq('billable', true);

    const phoneDigits = state.phone.replace(/\D/g, '');
    if (phoneDigits) q = q.like('phone', `%${phoneDigits}%`);

    if (caseSearch) {
      // escape LIKE wildcards typed by the user
      const safe = caseSearch.replace(/[%_\\]/g, (m) => '\\' + m);
      q = q.ilike('cases.case_code', `%${safe}%`);
    }

    // Date inputs are IST calendar days.
    if (state.from) {
      const d = new Date(`${state.from}T00:00:00+05:30`);
      if (!isNaN(d)) q = q.gte('created_at', d.toISOString());
    }
    if (state.to) {
      const d = new Date(`${state.to}T00:00:00+05:30`);
      if (!isNaN(d)) {
        d.setDate(d.getDate() + 1); // inclusive end-of-day
        q = q.lt('created_at', d.toISOString());
      }
    }

    q = q.order('created_at', { ascending: false }).order('id', { ascending: false });
    return q;
  }

  // ============================================================
  // Fetch + render results
  // ============================================================
  async function fetchPage({ silent = false } = {}) {
    const seq = ++fetchSeq;
    state.loading = true;
    if (!silent) resultsEl.innerHTML = `<div style="padding: var(--s4)">${renderSkeleton(6)}</div>`;

    try {
      const fromIdx = state.page * state.pageSize;
      const { data, count, error } = await buildQuery()
        .range(fromIdx, fromIdx + state.pageSize - 1);

      if (seq !== fetchSeq) return; // a newer fetch superseded this one
      if (error) throw error;

      state.rows = data || [];
      state.total = count ?? 0;
      // If the page we asked for fell off the end (filter narrowed), snap back.
      if (state.rows.length === 0 && state.total > 0 && state.page > 0) {
        state.page = Math.max(0, Math.ceil(state.total / state.pageSize) - 1);
        return fetchPage({ silent });
      }
      renderResults();
    } catch (err) {
      if (seq !== fetchSeq) return;
      console.error('[messages] fetch failed:', err);
      resultsEl.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <h3>Couldn't load the ledger</h3>
          <p>${escapeHtml(err.message || 'Unknown error')}</p>
          <button class="btn btn-secondary" id="msg-retry">Retry</button>
        </div>`;
      resultsEl.querySelector('#msg-retry')?.addEventListener('click', () => fetchPage());
      el('msg-pagination').hidden = true;
      if (!silent) showToast('Failed to load messages: ' + (err.message || 'unknown error'), 'error');
    } finally {
      if (seq === fetchSeq) state.loading = false;
    }
  }

  function hasActiveFilters() {
    return state.direction !== 'all' || state.status !== 'all' || state.kind !== 'all'
      || billableOnly || state.phone.trim() !== '' || state.caseCode.trim() !== ''
      || state.from !== '' || state.to !== '';
  }

  function renderResults() {
    if (state.rows.length === 0) {
      const filtered = hasActiveFilters();
      resultsEl.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <h3>${filtered ? 'No messages match these filters' : 'No messages yet'}</h3>
          <p>${filtered
            ? 'Try widening the date range or clearing a filter — every message the system sends or receives lands here.'
            : 'Once WhatsApp traffic starts flowing (registrations, offers, replies), the full ledger appears here in real time.'}</p>
          ${filtered ? '<button class="btn btn-secondary" id="msg-empty-clear">Clear filters</button>' : ''}
        </div>`;
      resultsEl.querySelector('#msg-empty-clear')?.addEventListener('click', clearFilters);
      el('msg-pagination').hidden = true;
      return;
    }

    // ---- desktop table ----
    const tableRows = state.rows.map((m) => {
      const failed = m.status === 'failed';
      const isOpen = expanded.has(m.id);
      const caseCode = m.cases?.case_code || null;
      const bodyText = m.body || (m.msg_type && m.msg_type !== 'text' ? `[${m.msg_type}]` : '');
      const needsExpand = (m.body && m.body.length > 110) || failed || m.error;
      const main = `
        <tr class="clickable ${failed ? 'msg-row-failed' : ''}" data-msg-id="${m.id}" title="Click to ${isOpen ? 'collapse' : 'expand'} details">
          <td class="cell-mono" style="white-space:nowrap" title="${escapeHtml(formatRelativeTime(m.created_at))}">${escapeHtml(formatDateTime(m.created_at))}</td>
          <td><span class="msg-dir-arrow ${m.direction}" title="${m.direction === 'in' ? 'Inbound' : 'Outbound'}">${m.direction === 'in' ? '↙' : '↗'}</span></td>
          <td class="cell-mono">${escapeHtml(maskPhone(m.phone))}</td>
          <td>${m.participant_role ? `<span class="badge badge-neutral">${escapeHtml(capitalize(m.participant_role))}</span>` : '<span class="msg-free">—</span>'}</td>
          <td class="cell-mono">${escapeHtml(m.msg_type || '—')}</td>
          <td>${m.template_name
            ? `<span class="tpl-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>${escapeHtml(m.template_name)}</span>`
            : '<span class="msg-free">free-form</span>'}</td>
          <td class="msg-body-cell" title="${escapeHtml(truncate(bodyText, 400))}">${escapeHtml(truncate(bodyText))}${needsExpand ? ` <button class="msg-expand-btn" data-msg-id="${m.id}">${isOpen ? 'less' : 'more'}</button>` : ''}</td>
          <td style="text-align:center">${m.direction === 'out' ? statusTicks(m.status) : statusBadge(m.status)}</td>
          <td style="text-align:center">${m.billable
            ? `<span class="msg-billable" title="Billable conversation${m.pricing_category ? ' — ' + escapeHtml(m.pricing_category) : ''}">₹</span>`
            : '<span class="msg-free" title="Free (within 24h window or unbilled)">—</span>'}</td>
          <td>${caseCode && m.case_id
            ? `<a class="msg-case-link" href="#cases/${escapeHtml(m.case_id)}" data-nolink>${escapeHtml(caseCode)}</a>`
            : '<span class="msg-free">—</span>'}</td>
        </tr>`;
      const detail = isOpen ? `
        <tr class="msg-detail-row" data-detail-for="${m.id}">
          <td colspan="10">${renderDetail(m)}</td>
        </tr>` : '';
      return main + detail;
    }).join('');

    // ---- mobile cards ----
    const cards = state.rows.map((m) => {
      const failed = m.status === 'failed';
      const isOpen = expanded.has(m.id);
      const caseCode = m.cases?.case_code || null;
      const bodyText = m.body || (m.msg_type && m.msg_type !== 'text' ? `[${m.msg_type}]` : '');
      return `
        <div class="msg-card ${failed ? 'failed' : ''}" data-msg-id="${m.id}">
          <div class="msg-card-top">
            <span class="msg-dir-arrow ${m.direction}">${m.direction === 'in' ? '↙' : '↗'}</span>
            <span class="who cell-mono">${escapeHtml(maskPhone(m.phone))}</span>
            ${m.participant_role ? `<span class="badge badge-neutral">${escapeHtml(capitalize(m.participant_role))}</span>` : ''}
            ${m.direction === 'out' ? statusTicks(m.status) : statusBadge(m.status)}
            <span class="when">${escapeHtml(formatRelativeTime(m.created_at))}</span>
          </div>
          <div class="msg-card-body">${escapeHtml(isOpen ? (bodyText || '—') : truncate(bodyText))}</div>
          <div class="msg-card-meta">
            <span class="cell-mono">${escapeHtml(formatDateTime(m.created_at))}</span>
            ${m.template_name ? `<span class="tpl-chip">${escapeHtml(m.template_name)}</span>` : `<span>${escapeHtml(m.msg_type || '')}</span>`}
            ${m.billable ? '<span class="msg-billable">₹ billable</span>' : ''}
            ${caseCode && m.case_id ? `<a class="msg-case-link" href="#cases/${escapeHtml(m.case_id)}" data-nolink>${escapeHtml(caseCode)}</a>` : ''}
            <button class="msg-expand-btn" data-msg-id="${m.id}">${isOpen ? 'less' : 'details'}</button>
          </div>
          ${isOpen ? `<div style="margin-top:8px">${renderDetail(m)}</div>` : ''}
        </div>`;
    }).join('');

    resultsEl.innerHTML = `
      <div class="table-wrap msg-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>When (IST)</th><th></th><th>Phone</th><th>Role</th><th>Type</th>
              <th>Template</th><th>Message</th><th>Status</th><th>₹</th><th>Case</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div class="msg-cards">${cards}</div>
    `;

    // pagination
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    const first = state.page * state.pageSize + 1;
    const last = Math.min(state.total, (state.page + 1) * state.pageSize);
    el('msg-page-info').textContent = `${first}–${last} of ${state.total} · page ${state.page + 1}/${totalPages}`;
    el('msg-prev').disabled = state.page <= 0;
    el('msg-next').disabled = state.page >= totalPages - 1;
    el('msg-pagination').hidden = false;
  }

  function renderDetail(m) {
    const errorBlock = m.error
      ? `<div class="msg-detail-full">
           <div class="k">Error detail</div>
           <div class="msg-error-box">${escapeHtml(typeof m.error === 'string' ? m.error : prettyJson(m.error))}</div>
         </div>`
      : '';
    return `
      <div class="msg-detail-grid">
        <div class="msg-detail-full">
          <div class="k">Full message</div>
          <div class="v">${escapeHtml(m.body || '(no text body)')}</div>
        </div>
        ${errorBlock}
        <div><div class="k">Direction</div><div class="v">${m.direction === 'in' ? 'Inbound ↙' : 'Outbound ↗'}</div></div>
        <div><div class="k">Status</div><div class="v">${statusBadge(m.status)}${m.status_at ? ` <span class="cell-mono">${escapeHtml(formatDateTime(m.status_at))}</span>` : ''}</div></div>
        <div><div class="k">Type</div><div class="v cell-mono">${escapeHtml(m.msg_type || '—')}</div></div>
        <div><div class="k">Template</div><div class="v cell-mono">${escapeHtml(m.template_name || '—')}</div></div>
        <div><div class="k">Billing</div><div class="v">${m.billable ? '₹ billable' : 'free'}${m.pricing_category ? ` · ${escapeHtml(m.pricing_category)}` : ''}</div></div>
        <div><div class="k">Relay of</div><div class="v cell-mono">${m.relay_of ? '#' + escapeHtml(String(m.relay_of)) : '—'}</div></div>
        <div class="msg-detail-full"><div class="k">WAMID</div><div class="v cell-mono" style="font-size:11px">${escapeHtml(m.wamid || '— (never accepted by Meta)')}</div></div>
      </div>`;
  }

  // ============================================================
  // Filter events
  // ============================================================
  function syncChips() {
    const chips = container.querySelectorAll('#msg-chips .fchip');
    let active = 'all';
    if (billableOnly) active = 'billable';
    else if (state.status === 'failed' && state.direction === 'all') active = 'failed';
    else if (state.direction === 'in' && state.status === 'all') active = 'in';
    else if (state.direction === 'out' && state.status === 'all') active = 'out';
    if (hasActiveFilters() && active === 'all') active = null; // custom combo — no chip lit
    chips.forEach(c => c.classList.toggle('on', c.dataset.chip === active));
  }

  function applyAndFetch() {
    state.page = 0;
    syncChips();
    fetchPage();
  }

  el('msg-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    const kind = chip.dataset.chip;
    billableOnly = kind === 'billable';
    state.direction = (kind === 'in' || kind === 'out') ? kind : 'all';
    state.status = kind === 'failed' ? 'failed' : 'all';
    el('msg-f-direction').value = state.direction;
    el('msg-f-status').value = state.status;
    applyAndFetch();
  });

  el('msg-f-direction').addEventListener('change', (e) => { state.direction = e.target.value; billableOnly = false; applyAndFetch(); });
  el('msg-f-status').addEventListener('change', (e) => { state.status = e.target.value; billableOnly = false; applyAndFetch(); });
  el('msg-f-kind').addEventListener('change', (e) => { state.kind = e.target.value; applyAndFetch(); });
  el('msg-f-from').addEventListener('change', (e) => { state.from = e.target.value; applyAndFetch(); });
  el('msg-f-to').addEventListener('change', (e) => { state.to = e.target.value; applyAndFetch(); });

  let debounceTimer = null;
  function debounced(fn) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fn, 350);
  }
  el('msg-f-phone').addEventListener('input', (e) => {
    debounced(() => { state.phone = e.target.value; applyAndFetch(); });
  });
  el('msg-f-case').addEventListener('input', (e) => {
    debounced(() => { state.caseCode = e.target.value; applyAndFetch(); });
  });

  function clearFilters() {
    state.direction = 'all'; state.status = 'all'; state.kind = 'all';
    state.phone = ''; state.caseCode = ''; state.from = ''; state.to = '';
    billableOnly = false;
    el('msg-f-direction').value = 'all';
    el('msg-f-status').value = 'all';
    el('msg-f-kind').value = 'all';
    el('msg-f-phone').value = '';
    el('msg-f-case').value = '';
    el('msg-f-from').value = '';
    el('msg-f-to').value = '';
    applyAndFetch();
  }
  el('msg-f-clear').addEventListener('click', clearFilters);

  // ---- pagination ----
  el('msg-prev').addEventListener('click', () => {
    if (state.page > 0) { state.page--; fetchPage(); }
  });
  el('msg-next').addEventListener('click', () => {
    const totalPages = Math.ceil(state.total / state.pageSize);
    if (state.page < totalPages - 1) { state.page++; fetchPage(); }
  });

  // ---- row expand (event delegation over both table + cards) ----
  resultsEl.addEventListener('click', (e) => {
    if (e.target.closest('a[data-nolink]')) return; // let case links navigate
    const trigger = e.target.closest('.msg-expand-btn') || e.target.closest('tr.clickable[data-msg-id]');
    if (!trigger) return;
    const id = Number(trigger.dataset.msgId || trigger.closest('[data-msg-id]')?.dataset.msgId);
    if (!id) return;
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderResults();
  });

  // ============================================================
  // CSV export of the current filter
  // ============================================================
  el('msg-export-btn').addEventListener('click', async () => {
    const btn = el('msg-export-btn');
    btn.disabled = true;
    const prevHtml = btn.innerHTML;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    try {
      const { data, error } = await buildQuery({ forExport: true }).limit(EXPORT_CAP);
      if (error) throw error;
      if (!data || data.length === 0) {
        showToast('Nothing to export for the current filter.', 'warning');
        return;
      }
      exportToCSV(data, 'message_ledger', [
        { label: 'Created (IST)', accessor: (r) => formatDateTime(r.created_at) },
        { label: 'Direction', key: 'direction' },
        { label: 'Phone', key: 'phone' },
        { label: 'Role', key: 'participant_role' },
        { label: 'Type', key: 'msg_type' },
        { label: 'Template', key: 'template_name' },
        { label: 'Body', key: 'body' },
        { label: 'Status', key: 'status' },
        { label: 'Status at (IST)', accessor: (r) => r.status_at ? formatDateTime(r.status_at) : '' },
        { label: 'Billable', accessor: (r) => r.billable ? 'yes' : 'no' },
        { label: 'Pricing category', key: 'pricing_category' },
        { label: 'Case code', accessor: (r) => r.cases?.case_code || '' },
        { label: 'Case ID', key: 'case_id' },
        { label: 'WAMID', key: 'wamid' },
        { label: 'Error', accessor: (r) => r.error ? (typeof r.error === 'string' ? r.error : JSON.stringify(r.error)) : '' },
      ]);
      showToast(
        data.length >= EXPORT_CAP
          ? `Exported the first ${EXPORT_CAP} rows — narrow the filter for a complete slice.`
          : `Exported ${data.length} message${data.length === 1 ? '' : 's'}.`,
        'success'
      );
    } catch (err) {
      console.error('[messages] export failed:', err);
      showToast('Export failed: ' + (err.message || 'unknown error'), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = prevHtml;
    }
  });

  // ============================================================
  // Auto-refresh (silent — refreshes the results region only)
  // ============================================================
  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }
  el('msg-auto-refresh').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    stopAutoRefresh();
    if (state.autoRefresh) {
      refreshTimer = setInterval(() => {
        // Page was navigated away or the tab is hidden — don't waste queries.
        if (!container.isConnected) { stopAutoRefresh(); return; }
        if (document.hidden || state.loading) return;
        fetchPage({ silent: true });
      }, AUTO_REFRESH_MS);
      showToast('Auto-refresh on — ledger updates every ' + (AUTO_REFRESH_MS / 1000) + 's.', 'info', 2500);
    }
  });

  // Deep-link support: #messages?failed=1 style params from other pages.
  if (params && (params.failed === '1' || params.filter === 'failed')) {
    state.status = 'failed';
    el('msg-f-status').value = 'failed';
    syncChips();
  }

  // ---- initial load ----
  await fetchPage();
}
