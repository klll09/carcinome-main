// ============================================================
// Carcinome Home Care — the chat view (rooms + thread + composer)
//
// One component, two hosts: the portal page wraps it in the portal shell, the
// admin page drops it into the dashboard. The UI is identical because the
// conversation is identical — the ONLY difference is which rooms the server
// hands back, which is decided from the credential, not from anything here.
//
// Role glyphs match the WhatsApp relay (🧑 🩺 🥼 🛟 📦) so a message reads the
// same on a phone and on the web. That is the point of keeping one thread.
// ============================================================

import {
  connectChat, getChatIdentity, listRooms, joinRoom, sendMessage, onMessage, emitTyping, onTyping,
} from './chat.js';
import { escapeHtml, formatRelativeTime, formatDateTime } from '../utils/formatters.js';
import { icon } from '../components/icons.js';

const ROLE_EMOJI = { patient: '🧑', nurse: '🩺', doctor: '🥼', ops: '🛟', supplier: '📦', poc: '🧭' };
const ROLE_WORD = { patient: 'Patient', nurse: 'Nurse', doctor: 'Doctor', ops: 'Care team', supplier: 'Supplier', poc: 'POC' };

/**
 * Mount the chat into `container`. Returns a cleanup function the host page
 * must call on navigate — otherwise the socket listeners outlive the DOM they
 * are writing into.
 */
export async function mountChatView(container, { title = 'Case chats' } = {}) {
  container.innerHTML = `<div class="ch-boot"><span class="pt-spinner pt-spinner-lg"></span><p>Connecting…</p></div>`;

  let rooms = [];
  let activeId = null;
  let me = null;
  const offs = [];

  try {
    await connectChat();
    me = getChatIdentity();   // the server's answer, captured on the ready frame
    rooms = await listRooms();
  } catch (err) {
    container.innerHTML = `
      <div class="ch-boot ch-boot-error">
        ${icon('alertCircle')}
        <h3>Chat is unavailable</h3>
        <p>${escapeHtml(err.message)}</p>
        <button class="pt-btn pt-btn-ghost" type="button" onclick="location.reload()">Try again</button>
      </div>`;
    return () => {};
  }

  container.innerHTML = `
    <div class="ch-wrap" data-view="list">
      <aside class="ch-rooms">
        <div class="ch-rooms-head">
          <span>${escapeHtml(title)}</span>
          <span class="ch-count">${rooms.length}</span>
        </div>
        <div class="ch-room-list" id="ch-room-list">${renderRoomList(rooms)}</div>
      </aside>
      <section class="ch-thread" id="ch-thread">${emptyThread()}</section>
    </div>`;

  const wrap = container.querySelector('.ch-wrap');
  const listEl = container.querySelector('#ch-room-list');
  const threadEl = container.querySelector('#ch-thread');

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.ch-room');
    if (row) openRoom(row.dataset.id);
  });

  // Live messages: append when the room is open, bump the room row otherwise
  // so an unread conversation is visible without polling.
  offs.push(onMessage((m) => {
    const room = rooms.find((r) => r.id === m.case_id);
    if (room) { room.last_body = m.body; room.last_at = m.created_at; }
    if (m.case_id === activeId) {
      appendBubble(m);
    } else if (room) {
      room.unread = (room.unread ?? 0) + 1;
      listEl.innerHTML = renderRoomList(rooms, activeId);
    }
  }));

  offs.push(onTyping(({ name, on }) => {
    const el = container.querySelector('#ch-typing');
    if (el) el.textContent = on ? `${name} is typing…` : '';
  }));

  if (rooms.length === 1) openRoom(rooms[0].id);

  async function openRoom(caseId) {
    const room = rooms.find((r) => r.id === caseId);
    if (!room) return;
    activeId = caseId;
    room.unread = 0;
    listEl.innerHTML = renderRoomList(rooms, activeId);
    wrap.dataset.view = 'thread';
    threadEl.innerHTML = `<div class="ch-boot"><span class="pt-spinner"></span></div>`;

    let messages;
    try {
      messages = await joinRoom(caseId);
    } catch (err) {
      threadEl.innerHTML = `<div class="ch-boot ch-boot-error">${icon('alertCircle')}<p>${escapeHtml(err.message)}</p></div>`;
      return;
    }

    threadEl.innerHTML = `
      <header class="ch-head">
        <button class="ch-back" type="button" id="ch-back" aria-label="Back to conversations">${icon('arrowLeft')}</button>
        <div class="ch-head-text">
          <div class="ch-head-title">${escapeHtml(room.patient_name)}</div>
          <div class="ch-head-sub">${escapeHtml(room.case_code)} · ${escapeHtml(memberLine(room))}</div>
        </div>
      </header>
      <div class="ch-msgs" id="ch-msgs">${
        messages.length ? messages.map(bubble).join('') : `<div class="ch-empty">No messages yet. Say hello.</div>`
      }</div>
      <div class="ch-typing" id="ch-typing"></div>
      <form class="ch-composer" id="ch-composer">
        <textarea id="ch-input" rows="1" placeholder="Write a message…" maxlength="2000"></textarea>
        <button class="ch-send" type="submit" aria-label="Send">${icon('send')}</button>
      </form>`;

    threadEl.querySelector('#ch-back').addEventListener('click', () => {
      wrap.dataset.view = 'list';
      activeId = null;
    });

    const form = threadEl.querySelector('#ch-composer');
    const input = threadEl.querySelector('#ch-input');

    // Enter sends, Shift+Enter makes a new line — and the box grows with the
    // text instead of scrolling a single cramped line.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
      emitTyping(caseId, input.value.length > 0);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.style.height = 'auto';
      emitTyping(caseId, false);
      try {
        // The server echoes to the whole room INCLUDING us, so the bubble is
        // painted by the message:new handler — never twice.
        await sendMessage(caseId, text);
      } catch (err) {
        input.value = text;
        threadEl.querySelector('#ch-typing').textContent = err.message;
      }
    });

    input.focus();
    scrollDown();
  }

  function appendBubble(m) {
    const box = threadEl.querySelector('#ch-msgs');
    if (!box) return;
    box.querySelector('.ch-empty')?.remove();
    box.insertAdjacentHTML('beforeend', bubble(m));
    scrollDown();
  }

  function scrollDown() {
    const box = threadEl.querySelector('#ch-msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function bubble(m) {
    const mine = me && m.sender_name === me.name && m.role === me.role;
    return `
      <div class="ch-msg ${mine ? 'is-mine' : ''}">
        <div class="ch-msg-meta">
          <span class="ch-msg-who">${ROLE_EMOJI[m.role] ?? '💬'} ${escapeHtml(m.sender_name)}</span>
          <span class="ch-msg-role">${escapeHtml(ROLE_WORD[m.role] ?? '')}</span>
          ${m.via === 'whatsapp' ? '<span class="ch-via">via WhatsApp</span>' : ''}
          <time datetime="${escapeHtml(m.created_at)}" title="${escapeHtml(formatDateTime(m.created_at))}">${escapeHtml(formatRelativeTime(m.created_at))}</time>
        </div>
        <div class="ch-msg-body">${escapeHtml(m.body)}</div>
      </div>`;
  }

  return () => { for (const off of offs) off?.(); };
}

function renderRoomList(rooms, activeId = null) {
  if (!rooms.length) {
    return `<div class="ch-empty">No case conversations yet.<br />One appears here as soon as a case is registered for you.</div>`;
  }
  return rooms.map((r) => `
    <button class="ch-room ${r.id === activeId ? 'is-active' : ''}" type="button" data-id="${escapeHtml(r.id)}">
      <span class="ch-room-top">
        <span class="ch-room-name">${escapeHtml(r.patient_name)}</span>
        ${r.unread ? `<span class="ch-unread">${r.unread}</span>` : ''}
      </span>
      <span class="ch-room-sub">${escapeHtml(r.case_code)} · ${escapeHtml(r.care_label)}</span>
      <span class="ch-room-members">${escapeHtml(memberLine(r))}</span>
    </button>`).join('');
}

/** "🧑 Meera · 🩺 Asha · 🥼 Dr Mehta" — who is actually in this room. */
function memberLine(room) {
  return (room.members ?? [])
    .map((m) => `${ROLE_EMOJI[m.role] ?? ''} ${firstWords(m.name)}`)
    .join(' · ') || 'No members yet';
}

function firstWords(name) {
  const parts = String(name || '').split(/\s+/);
  return parts.length > 2 ? parts.slice(0, 2).join(' ') : String(name || '');
}

function emptyThread() {
  return `<div class="ch-empty ch-empty-thread">Choose a conversation to open it.</div>`;
}
