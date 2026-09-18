// ============================================================
// Carcinome Home Care — Live Case Timeline
// WhatsApp-style chat ledger: messages + case_events merged
// chronologically, relay copies collapsed under the original,
// delivery ticks, realtime inserts, auto-scroll.
//
//   renderTimeline(container, caseId)   → Promise<cleanupFn>
//   subscribeTimeline(caseId, onInsert) → { unsubscribe() }
// ============================================================

import { getSupabase } from '../supabase.js';
import { escapeHtml, formatActor, formatRelativeTime, formatDateTime } from '../utils/formatters.js';
import { icon } from './icons.js';

const IST = 'Asia/Kolkata';

const ROLE_EMOJI = {
  patient: '🧑',
  nurse: '🩺',
  doctor: '🥼',
  ops: '🛟',
  supplier: '📦',
};

// Events that read as a clearly good / bad moment get tinted chips.
const GOOD_EVENTS = /verified|assigned|consented|paid|completed|care_done|delivered|approved|registered/;
const BAD_EVENTS = /failed|locked|cancelled|expired|error|nudge|escalat/;

// ---- delivery ticks ----
// pending ✓ (faint) · accepted ✓ · sent/delivered ✓✓ · read ✓✓ (blue) ·
// failed ! (red, error tooltip)
function ticksFor(msg) {
  const status = msg.status || 'pending';
  if (status === 'failed') {
    let err = '';
    try { err = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error || {}); } catch {}
    return `<span class="msg-ticks failed" title="${escapeHtml(err).slice(0, 400)}">!</span>`;
  }
  if (status === 'read') return '<span class="msg-ticks read">✓✓</span>';
  if (status === 'delivered' || status === 'sent') return '<span class="msg-ticks">✓✓</span>';
  if (status === 'accepted') return '<span class="msg-ticks">✓</span>';
  return '<span class="msg-ticks pending">✓</span>';
}

function istDay(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: IST });
}

// Body of one bubble: text (escaped) or a media/doc row.
function bubbleBody(msg) {
  const type = msg.msg_type || 'text';
  const body = msg.body || '';
  if (type === 'document' || type === 'image' || type === 'video' || type === 'audio' || type === 'sticker') {
    const label = body || (capitalize(type) + ' attachment');
    return `<span class="msg-doc">${icon('fileText')}${escapeHtml(label)}</span>`;
  }
  if (body) return escapeHtml(body);
  return `<span class="faint">[${escapeHtml(type)}]</span>`;
}

function senderLine(msg, participants) {
  const p = participants.get(msg.phone);
  const role = msg.participant_role || p?.role || null;
  const emoji = ROLE_EMOJI[role] || '💬';
  const name = p?.display_name || (role ? capitalize(role) : msg.phone || 'Unknown');
  return `<div class="msg-sender"><span class="msg-emoji">${emoji}</span>${escapeHtml(name)}</div>`;
}

// One message bubble (also used for the relay-group parent).
function renderMsg(msg, participants, relayCopies, openGroups) {
  const out = msg.direction === 'out';
  const failed = msg.status === 'failed';
  const tpl = msg.template_name
    ? `<div><span class="tpl-chip">${icon('send')}${escapeHtml(msg.template_name)}</span></div>`
    : '';
  const copies = relayCopies.get(msg.id) || [];
  const isOpen = openGroups.has(msg.id);

  const relayHtml = copies.length ? `
    <button class="relay-toggle ${isOpen ? 'open' : ''}" data-relay-toggle="${msg.id}">
      ${icon('users')} relayed to ${copies.length} ${copies.length === 1 ? 'person' : 'people'} <span class="car">▾</span>
    </button>
    <div class="relay-group ${isOpen ? 'open' : ''}" data-relay-group="${msg.id}">
      ${copies.map(c => {
        const p = participants.get(c.phone);
        const role = c.participant_role || p?.role;
        const who = p?.display_name || (role ? capitalize(role) : c.phone);
        return `<div class="relay-row">${ticksFor(c)}<span class="rr-who">${ROLE_EMOJI[role] || ''} ${escapeHtml(who)}</span><span>${formatTime(c.created_at)}</span></div>`;
      }).join('')}
    </div>` : '';

  return `
    <div class="msg ${out ? 'out' : 'in'} ${failed ? 'failed' : ''}" data-msg-id="${msg.id}">
      ${!out ? senderLine(msg, participants) : ''}
      <div class="msg-bubble">${tpl}${bubbleBody(msg)}</div>
      <div class="msg-meta" title="${escapeHtml(formatDateTime(msg.created_at))}">
        <span>${formatTime(msg.created_at)}</span>
        ${out ? ticksFor(msg) : ''}
      </div>
      ${relayHtml}
    </div>`;
}

function renderEvent(evt) {
  const type = String(evt.event_type || 'event');
  const tone = GOOD_EVENTS.test(type) ? 'evt-good' : BAD_EVENTS.test(type) ? 'evt-bad' : '';
  const actorLabel = formatActor(evt.actor);
  const actor = actorLabel ? ` · ${escapeHtml(actorLabel)}` : '';
  return `
    <div class="evt-chip ${tone}" title="${escapeHtml(JSON.stringify(evt.data || {})).slice(0, 400)}">
      <span>${escapeHtml(capitalize(type))}${actor}</span>
      <span class="evt-when">${formatTime(evt.created_at)}</span>
    </div>`;
}

// ---- Merge messages + events chronologically and render the full list ----
function renderList(chatEl, state) {
  const { messages, events, participants, openGroups } = state;

  // Relay copies thread under their original; originals render in the flow.
  const relayCopies = new Map();   // parentId -> [copies]
  const roots = [];
  for (const m of messages) {
    if (m.relay_of != null) {
      if (!relayCopies.has(m.relay_of)) relayCopies.set(m.relay_of, []);
      relayCopies.get(m.relay_of).push(m);
    } else {
      roots.push(m);
    }
  }
  // Orphan relay copies (original outside the fetch window) render normally.
  const rootIds = new Set(roots.map(m => m.id));
  for (const [parentId, copies] of [...relayCopies]) {
    if (!rootIds.has(parentId)) {
      relayCopies.delete(parentId);
      roots.push(...copies);
    }
  }
  roots.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const items = [
    ...roots.map(m => ({ kind: 'msg', at: m.created_at, m })),
    ...events.map(e => ({ kind: 'evt', at: e.created_at, e })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  if (!items.length) {
    chatEl.innerHTML = `<div class="chat-empty">No messages or events on this case yet.<br>Everything WhatsApp will appear here live.</div>`;
    return;
  }

  let html = '';
  let lastDay = '';
  for (const it of items) {
    const day = istDay(it.at);
    if (day && day !== lastDay) {
      html += `<div class="chat-day">${day}</div>`;
      lastDay = day;
    }
    html += it.kind === 'msg'
      ? renderMsg(it.m, participants, relayCopies, openGroups)
      : renderEvent(it.e);
  }
  chatEl.innerHTML = html;

  // Expander wiring — state survives re-renders via openGroups.
  chatEl.querySelectorAll('[data-relay-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.relayToggle);
      const group = chatEl.querySelector(`[data-relay-group="${id}"]`);
      const nowOpen = !openGroups.has(id);
      if (nowOpen) openGroups.add(id); else openGroups.delete(id);
      btn.classList.toggle('open', nowOpen);
      group?.classList.toggle('open', nowOpen);
    });
  });
}

function scrollToBottom(chatEl) {
  chatEl.scrollTop = chatEl.scrollHeight;
}
function isNearBottom(chatEl) {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
}

// ============================================================
// subscribeTimeline — raw realtime INSERT feed for a case.
// onInsert(row, table) is called for every new messages /
// case_events row of this case. Returns { unsubscribe() }.
// ============================================================
export function subscribeTimeline(caseId, onInsert) {
  const sb = getSupabase();
  const channel = sb
    .channel(`case-timeline-${caseId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `case_id=eq.${caseId}` },
      (payload) => { try { onInsert(payload.new, 'messages'); } catch (e) { console.error('[timeline] onInsert failed:', e); } })
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `case_id=eq.${caseId}` },
      (payload) => { try { onInsert(payload.new, 'messages:update'); } catch (e) { console.error('[timeline] onUpdate failed:', e); } })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'case_events', filter: `case_id=eq.${caseId}` },
      (payload) => { try { onInsert(payload.new, 'case_events'); } catch (e) { console.error('[timeline] onInsert failed:', e); } })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') console.warn('[timeline] realtime channel error for case', caseId);
    });

  return {
    unsubscribe() {
      try { sb.removeChannel(channel); } catch (e) { console.warn('[timeline] unsubscribe failed:', e); }
    },
  };
}

// ============================================================
// renderTimeline — fetch + render + live updates + auto-scroll.
// Returns a cleanup function; call it when leaving the page.
// ============================================================
export async function renderTimeline(container, caseId) {
  const sb = getSupabase();
  container.innerHTML = `<div class="chat" data-case-chat="${caseId}"><div class="chat-loading"><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div></div></div>`;
  const chatEl = container.querySelector('.chat');

  const state = {
    messages: [],
    events: [],
    participants: new Map(),   // phone -> {role, display_name}
    openGroups: new Set(),     // expanded relay groups (message ids)
  };

  // ---- initial fetch (messages asc + events + participants) ----
  try {
    const [msgRes, evtRes, partRes] = await Promise.all([
      sb.from('messages').select('*').eq('case_id', caseId).order('created_at', { ascending: true }).limit(800),
      sb.from('case_events').select('*').eq('case_id', caseId).order('created_at', { ascending: true }).limit(400),
      sb.from('case_participants').select('phone, role, display_name').eq('case_id', caseId),
    ]);
    if (msgRes.error) throw msgRes.error;
    if (evtRes.error) throw evtRes.error;
    state.messages = msgRes.data || [];
    state.events = evtRes.data || [];
    // A phone can hold several roles (two-phone rehearsals) — keep the
    // highest-priority role as the phone's display identity.
    const rolePrio = { patient: 0, nurse: 1, doctor: 2, supplier: 3, ops: 4 };
    (partRes.data || [])
      .slice()
      .sort((a, b) => (rolePrio[b.role] ?? 9) - (rolePrio[a.role] ?? 9)) // low prio first, high prio overwrites
      .forEach(p => state.participants.set(p.phone, p));
  } catch (e) {
    console.error('[timeline] fetch failed:', e);
    chatEl.innerHTML = `<div class="chat-empty">Could not load the timeline.<br>${escapeHtml(e.message || 'Unknown error')}</div>`;
    return () => {};
  }

  renderList(chatEl, state);
  scrollToBottom(chatEl);

  // ---- realtime ----
  const sub = subscribeTimeline(caseId, (row, table) => {
    if (!chatEl.isConnected) return;
    const keepPinned = isNearBottom(chatEl);

    if (table === 'messages') {
      if (!state.messages.some(m => m.id === row.id)) state.messages.push(row);
    } else if (table === 'messages:update') {
      const i = state.messages.findIndex(m => m.id === row.id);
      if (i >= 0) state.messages[i] = row; else state.messages.push(row);
    } else if (table === 'case_events') {
      if (!state.events.some(ev => ev.id === row.id)) state.events.push(row);
    }

    renderList(chatEl, state);
    if (keepPinned) scrollToBottom(chatEl);
  });

  return function cleanup() {
    sub.unsubscribe();
  };
}
