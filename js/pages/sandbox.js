// #sandbox — WhatsApp delivery test bench.
// Send a message to ANY number and watch its real delivery status live
// (pending → accepted → sent → delivered → read / failed + Meta's error).
// Use case: "the nurse says she never got it" → send her a test here; if this
// delivers, the automated sends were delivering too.
import { getSupabase } from '../supabase.js';
import { adminAction } from '../utils/api.js';
import { showToast } from '../components/toast.js';
import { escapeHtml, formatRelativeTime, maskPhone } from '../utils/formatters.js';
import { validateIndianPhone } from '../utils/validators.js';

const LS_KEY = 'carcinome_sandbox_msg_ids';
const STATUS_META = {
  pending:   { label: 'PENDING',   cls: 'sb-st-pending',   hint: 'Queued in our ledger' },
  accepted:  { label: 'ACCEPTED',  cls: 'sb-st-accepted',  hint: 'Meta accepted the send' },
  sent:      { label: 'SENT ✓',    cls: 'sb-st-sent',      hint: 'Left Meta, one tick' },
  delivered: { label: 'DELIVERED ✓✓', cls: 'sb-st-delivered', hint: 'Reached their phone' },
  read:      { label: 'READ ✓✓',   cls: 'sb-st-read',      hint: 'They opened it' },
  failed:    { label: 'FAILED ✗',  cls: 'sb-st-failed',    hint: 'Did not go through' },
};
const TERMINAL = new Set(['read', 'failed']);

let pollTimer = null;
let renderSeq = 0;

function loadIds() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveId(id) {
  const ids = loadIds().filter((x) => x !== id);
  ids.unshift(id);
  localStorage.setItem(LS_KEY, JSON.stringify(ids.slice(0, 30)));
}

function injectStyles() {
  if (document.getElementById('sandbox-page-style')) return;
  const s = document.createElement('style');
  s.id = 'sandbox-page-style';
  s.textContent = `
    .sb-grid { display: grid; grid-template-columns: minmax(320px, 440px) 1fr; gap: 20px; align-items: start; }
    @media (max-width: 960px) { .sb-grid { grid-template-columns: 1fr; } }
    .sb-window-note { border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-top: 8px; display: none; }
    .sb-window-note.open { display: block; background: var(--ok-soft, #e7f6ec); }
    .sb-window-note.closed { display: block; background: var(--warn-soft, #fdf3e3); }
    .sb-mode-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
    .sb-mode { border: 1px solid var(--border, #dcd6cb); border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer; background: transparent; }
    .sb-mode.active { background: var(--primary, #0F8A5F); color: #fff; border-color: var(--primary, #0F8A5F); }
    .sb-send-row { margin-top: 14px; display: flex; gap: 10px; align-items: center; }
    .sb-item { border: 1px solid var(--border, #e5e0d6); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; background: var(--surface, #fff); }
    .sb-item-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .sb-item-body { font-size: 13px; color: var(--ink-soft, #555); margin-top: 6px; word-break: break-word; }
    .sb-status { font-family: var(--font-mono, monospace); font-size: 11.5px; padding: 3px 9px; border-radius: 999px; letter-spacing: .04em; }
    .sb-st-pending { background: var(--surface-3, #eee); } .sb-st-accepted { background: var(--primary-soft, #e1f4eb); }
    .sb-st-sent { background: var(--primary-soft, #e1f4eb); } .sb-st-delivered { background: var(--primary-soft-2, #bfe7d4); color: var(--primary-press, #0a6545); }
    .sb-st-read { background: var(--ok-soft, #cfe9db); color: var(--ok, #175c37); } .sb-st-failed { background: var(--danger-soft, #f8dcd7); color: var(--danger, #8c2318); }
    .sb-via { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; }
    .sb-err { margin-top: 8px; font-size: 12px; background: var(--danger-soft, #fbf1ef); border-radius: 8px; padding: 8px 10px; color: var(--danger, #7c2d21); white-space: pre-wrap; word-break: break-word; }
    .sb-empty { text-align: center; color: var(--ink-soft, #777); padding: 34px 10px; font-size: 14px; }
    .sb-live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #2fa35c; margin-right: 6px; animation: sbpulse 1.6s infinite; }
    @keyframes sbpulse { 50% { opacity: .35; } }
  `;
  document.head.appendChild(s);
}

async function fetchRows(ids) {
  if (!ids.length) return [];
  const sb = getSupabase();
  const { data, error } = await sb
    .from('messages')
    .select('id, phone, body, template_name, msg_type, status, status_at, error, created_at')
    .in('id', ids)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

function renderRow(r) {
  const st = STATUS_META[r.status] ?? STATUS_META.pending;
  const via = r.msg_type === 'template' ? `template · ${r.template_name ?? ''}` : 'free text';
  let err = '';
  if (r.status === 'failed' && r.error) {
    const e = typeof r.error === 'string' ? r.error : (r.error.message ?? JSON.stringify(r.error));
    err = `<div class="sb-err">${escapeHtml(String(e).slice(0, 400))}</div>`;
  }
  const live = TERMINAL.has(r.status) ? '' : '<span class="sb-live-dot"></span>';
  return `
    <div class="sb-item" data-msg-id="${r.id}">
      <div class="sb-item-head">
        <strong>${escapeHtml(maskPhone(r.phone))}</strong>
        <span class="sb-via">${escapeHtml(via)}</span>
        <span class="sb-status ${st.cls}" title="${escapeHtml(st.hint)}">${live}${st.label}</span>
      </div>
      <div class="sb-item-body">${escapeHtml((r.body ?? '').slice(0, 220))}</div>
      <div class="sb-item-body" style="opacity:.6">sent ${formatRelativeTime(r.created_at)}${r.status_at ? ` · status ${formatRelativeTime(r.status_at)}` : ''}</div>
      ${err}
    </div>`;
}

export default async function render(container) {
  injectStyles();
  const seq = ++renderSeq;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  container.innerHTML = `
    <div class="page-head"><h1>Sandbox</h1></div>
    <div class="info-banner" style="margin-bottom:16px">
      Delivery test bench. Send a WhatsApp message to any number and watch the real ticks below —
      if a test delivers here, the automated messages were reaching that number too.
      Sends go from the live business number and are logged in the Messages ledger like everything else.
    </div>
    <div class="sb-grid">
      <div class="card">
        <h3 style="margin-top:0">Send a test message</h3>
        <label class="form-label" for="sb-phone">Recipient WhatsApp number</label>
        <input class="form-input" id="sb-phone" type="tel" placeholder="98765 43210 or 919876543210" autocomplete="off" />
        <div class="sb-window-note" id="sb-window-note"></div>
        <label class="form-label" for="sb-text" style="margin-top:12px">Message</label>
        <textarea class="form-input" id="sb-text" rows="4" maxlength="900" placeholder="Hello! This is a test message from the Carcinome team."></textarea>
        <div class="sb-mode-row" role="radiogroup" aria-label="Send mode">
          <button type="button" class="sb-mode active" data-mode="auto" title="Free text if their 24h window is open, template otherwise — same logic the automated system uses">Auto (recommended)</button>
          <button type="button" class="sb-mode" data-mode="template" title="Force the approved care_update template — deliverable regardless of the 24h window">Force template</button>
          <button type="button" class="sb-mode" data-mode="text" title="Force free text — only delivers inside their 24h window; use to test window behaviour">Force free text</button>
        </div>
        <div class="sb-send-row">
          <button class="btn btn-primary" id="sb-send">Send test</button>
          <span id="sb-send-note" style="font-size:12.5px;opacity:.65"></span>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Recent test sends <span style="font-weight:400;font-size:12px;opacity:.6">(live — updates as Meta reports delivery)</span></h3>
        <div id="sb-list"><div class="sb-empty">No test sends yet. Statuses update live: SENT ✓ → DELIVERED ✓✓ → READ.</div></div>
      </div>
    </div>`;

  const phoneEl = container.querySelector('#sb-phone');
  const textEl = container.querySelector('#sb-text');
  const noteEl = container.querySelector('#sb-window-note');
  const listEl = container.querySelector('#sb-list');
  const sendBtn = container.querySelector('#sb-send');
  const sendNote = container.querySelector('#sb-send-note');
  let mode = 'auto';
  let sending = false;

  container.querySelectorAll('.sb-mode').forEach((b) => {
    b.addEventListener('click', () => {
      container.querySelectorAll('.sb-mode').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      mode = b.dataset.mode;
    });
  });

  // Window check on blur: is their 24h customer-service window open?
  phoneEl.addEventListener('blur', async () => {
    const v = validateIndianPhone(phoneEl.value);
    noteEl.className = 'sb-window-note';
    if (!v.ok) return;
    try {
      const sb = getSupabase();
      const { data } = await sb
        .from('conversation_state')
        .select('last_inbound_at')
        .eq('phone', v.normalized)
        .maybeSingle();
      const open = !!data?.last_inbound_at &&
        Date.now() - new Date(data.last_inbound_at).getTime() < 23 * 3600 * 1000;
      if (open) {
        noteEl.className = 'sb-window-note open';
        noteEl.textContent = `✅ 24h window open (they last messaged us ${formatRelativeTime(data.last_inbound_at)}) — free text will deliver.`;
      } else {
        noteEl.className = 'sb-window-note closed';
        noteEl.textContent = data?.last_inbound_at
          ? `🕐 Window closed (last heard ${formatRelativeTime(data.last_inbound_at)}) — Auto mode will use the care_update template.`
          : '🕐 This number has never messaged us — Auto mode will use the care_update template.';
      }
    } catch { /* non-fatal */ }
  });

  async function refreshList() {
    if (seq !== renderSeq || !listEl.isConnected) { clearInterval(pollTimer); pollTimer = null; return; }
    const ids = loadIds();
    if (!ids.length) return;
    try {
      const rows = await fetchRows(ids);
      if (seq !== renderSeq) return;
      listEl.innerHTML = rows.length
        ? rows.map(renderRow).join('')
        : '<div class="sb-empty">No test sends yet.</div>';
      if (rows.every((r) => TERMINAL.has(r.status)) && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch { /* keep old list */ }
  }

  function ensurePolling() {
    if (!pollTimer) pollTimer = setInterval(refreshList, 2500);
  }

  sendBtn.addEventListener('click', async () => {
    if (sending) return;
    const v = validateIndianPhone(phoneEl.value);
    if (!v.ok) { showToast('Enter a valid Indian mobile number', 'error'); phoneEl.focus(); return; }
    const text = textEl.value.trim();
    if (!text) { showToast('Write a message first', 'error'); textEl.focus(); return; }

    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    sendNote.textContent = '';
    try {
      const r = await adminAction('send_test_message', { to: v.normalized, text, mode });
      if (r.message_id) saveId(r.message_id);
      if (r.ok) {
        showToast(`Sent via ${r.via === 'template' ? 'care_update template' : 'free text'} — watch the ticks`, 'success');
        sendNote.textContent = r.window_open ? '24h window was open.' : 'Window closed → template path.';
        textEl.value = '';
      } else {
        showToast('Send failed — see the error below', 'error');
        sendNote.textContent = (r.error || '').slice(0, 120);
      }
      await refreshList();
      ensurePolling();
    } catch (e) {
      showToast(e.message || 'Send failed', 'error');
    } finally {
      sending = false;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send test';
    }
  });

  await refreshList();
  if (loadIds().length) ensurePolling();
}
