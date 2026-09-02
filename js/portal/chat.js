// ============================================================
// Carcinome Home Care — Socket.IO chat client
//
// Shared by the portal chat page and the admin chat page. The only difference
// between them is the credential handed to the server:
//   portal → the portal session bearer  (kind: 'portal')
//   admin  → the Supabase access token  (kind: 'admin')
// Everything about WHO SEES WHAT is decided server-side from that credential;
// this module never asks for a room it was not given.
//
// socket.io-client is loaded from a CDN in index.html (window.io) to keep the
// SPA's no-build-step property. If it is blocked, connect() fails loudly
// rather than leaving a dead chat pane.
// ============================================================

import { CONFIG } from '../config.js';
import { getPortalSession } from './api.js';

let socket = null;
// The server's view of who we are, from the 'ready' frame. Callers need it to
// tell their own messages apart from everyone else's, and asking the server is
// the only trustworthy answer — the client's own guess can be stale.
let identity = null;

/** { role, kind, name } once connected, else null. */
export function getChatIdentity() {
  return identity;
}

/** Resolve the credential for whichever app is asking. */
async function credentials() {
  const portal = getPortalSession();
  if (portal?.token) return { token: portal.token, kind: 'portal' };

  // Admin: reuse the live Supabase access token.
  try {
    const { getSupabase } = await import('../supabase.js');
    const { data } = await getSupabase().auth.getSession();
    if (data?.session?.access_token) return { token: data.session.access_token, kind: 'admin' };
  } catch (e) {
    console.warn('[chat] no admin session available:', e.message);
  }
  return null;
}

/**
 * Connect (or reuse an existing connection). Resolves once the server has
 * accepted the credential, so callers can assume an authorised socket.
 */
export async function connectChat() {
  if (socket?.connected) return socket;
  if (typeof window.io !== 'function') {
    throw new Error('Chat could not load. The socket.io script may be blocked on this network.');
  }
  const creds = await credentials();
  if (!creds) throw new Error('You are not signed in.');

  return await new Promise((resolve, reject) => {
    socket = window.io(CONFIG.CHAT_URL, {
      auth: creds,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      timeout: 8000,
    });

    const fail = (err) => {
      const m = String(err?.message ?? err);
      // "Is it running?" is a question, not help. The chat is the one part of
      // this that genuinely needs a second process, so when it is missing, say
      // exactly what to type — that is almost always the actual problem.
      const unreachable =
        `Could not reach the chat server at ${CONFIG.CHAT_URL}.\n\n` +
        `Start it with:  cd server && npm install && npm run demo\n\n` +
        `The dashboards work without it — only chat needs a live socket.`;
      reject(new Error(
        m === 'not_authorised' ? 'This sign-in is no longer valid. Please sign in again.'
          : m === 'no_credentials' ? 'You are not signed in.'
          : unreachable,
      ));
    };

    socket.once('ready', (who) => { identity = who; resolve(socket); });
    socket.once('connect_error', fail);
  });
}

export function disconnectChat() {
  if (socket) { socket.disconnect(); socket = null; }
  identity = null;
}

/** Promise wrapper over socket.io acks — every server handler answers one. */
function ask(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('Not connected to chat.'));
    const timer = setTimeout(() => reject(new Error('The chat server did not respond.')), 10_000);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      if (res?.ok) resolve(res);
      else reject(new Error(friendly(res?.error)));
    });
  });
}

const FRIENDLY = {
  forbidden: 'You do not have access to that conversation.',
  rate_limited: 'You are sending messages very quickly — please wait a moment.',
  empty: 'Type a message first.',
  rooms_failed: 'Could not load your conversations.',
  join_failed: 'Could not open that conversation.',
  send_failed: 'Your message could not be sent. Please try again.',
};
const friendly = (code) => FRIENDLY[code] || code || 'Something went wrong.';

export const listRooms = async () => (await ask('rooms:list', {})).rooms;
export const joinRoom = async (caseId) => (await ask('room:join', { caseId })).messages;
export const sendMessage = async (caseId, text) => (await ask('message:send', { caseId, text })).message;

export function onMessage(handler) {
  socket?.on('message:new', handler);
  return () => socket?.off('message:new', handler);
}

export function onTyping(handler) {
  socket?.on('typing', handler);
  return () => socket?.off('typing', handler);
}

export function emitTyping(caseId, on) {
  socket?.emit('typing', { caseId, on });
}
