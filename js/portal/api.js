// ============================================================
// Carcinome Home Care — Portal client (patient / nurse / doctor)
//
// The portal NEVER queries Supabase directly. RLS is admin-only, so the
// publishable key can read nothing — which is exactly why it is safe to
// commit — and the portal does not weaken that. Every read goes through the
// `portal` edge function, which holds the service key and scopes each query
// to the signed-in person. See supabase/functions/portal/index.ts.
//
// The session token is a bearer credential kept in localStorage. That is the
// same exposure the admin app already accepts for its Supabase session, and
// the token is revocable server-side (portal_sessions.revoked_at), single-
// person, and read-only in effect: nothing in the portal can move a case.
// ============================================================

import { CONFIG } from '../config.js';
import { isSampleSession, makeSampleSession, sampleAnswer } from './sample.js';

const SESSION_KEY = 'carcinome_portal_session';

// ---- Session storage -------------------------------------------------------

/** { token, expires_at, profile: { role, id, full_name, language_pref } } | null */
export function getPortalSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.token || !s?.profile?.role) return null;
    // An expired token is a zombie: keeping it renders a shell where every
    // call 401s and there is no obvious way back to the door.
    if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/**
 * Any change of identity MUST drop a live chat socket.
 *
 * The socket is authenticated once, at handshake, and connectChat() reuses it
 * while it stays connected. So without this, signing out and back in as
 * somebody else on the same device leaves the socket authenticated as the
 * person who LEFT — and the server, correctly trusting its own handshake,
 * serves their room list and their messages to whoever is now sitting there.
 * On a shared family phone that is a real disclosure, not a cosmetic bug.
 *
 * Imported dynamically because chat.js imports this module; a static import
 * would be a cycle.
 */
function dropChatSocket() {
  import('./chat.js').then((m) => m.disconnectChat()).catch(() => { /* chat never loaded */ });
}

export function setPortalSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  dropChatSocket();
}

export function clearPortalSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  dropChatSocket();
}

// ---- Transport -------------------------------------------------------------

/**
 * POST { action, ...params } to the portal function.
 * Resolves the JSON body on success; throws Error(message) otherwise.
 * A 401 on a session-guarded action clears the stored session, so the caller
 * can simply navigate back to the door.
 */
/**
 * Where portal calls go. In demo mode the chat server exposes the SAME action
 * protocol at /portal (server/index.mjs), so sample logins work with nothing
 * deployed; in production this is the real edge function.
 */
export function portalEndpoint() {
  return CONFIG.SAMPLE_LOGIN ? `${CONFIG.CHAT_URL}/portal` : `${CONFIG.FUNCTIONS_URL}/portal`;
}

export async function portalRequest(action, params = {}, { auth = true } = {}) {
  const session = auth ? getPortalSession() : null;

  // A sample session is answered from js/portal/sample.js and never reaches
  // the network — that is what makes the demo work with nothing running.
  // Actions sample.js does not stand in for fall through to the real request.
  if (session && isSampleSession(session)) {
    const local = sampleAnswer(action, session);
    if (local !== undefined) return local;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(portalEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...params }),
    });
  } catch (netErr) {
    console.error('[portal] network failure:', action, netErr);
    throw new Error('Could not reach Carcinome. Check your connection and try again.');
  }

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }

  if (res.status === 401 && auth) {
    clearPortalSession();
    throw new Error('Your sign-in has expired. Please request a new link.');
  }
  if (!res.ok || body?.ok === false) {
    const msg = body?.error || `Request failed (HTTP ${res.status})`;
    console.error('[portal] error:', action, res.status, body);
    throw new Error(friendlyError(msg));
  }
  return body;
}

// Server error codes are terse on purpose (they are also log lines). Families
// and nurses should not read `link_invalid` on their phone.
const FRIENDLY = {
  link_invalid: 'That sign-in link has already been used or has expired. Please request a new one.',
  account_unavailable: 'This account is not active right now. Please contact the Carcinome team.',
  not_signed_in: 'Please sign in again.',
  wrong_role: 'This page is not available for your account.',
  portal_disabled: 'The portal is temporarily unavailable. Please contact the Carcinome team.',
  invalid_role: 'Please choose whether you are a patient, a nurse or a doctor.',
  missing_token: 'That link is incomplete. Please open the full link from your WhatsApp message.',
};

function friendlyError(code) {
  return FRIENDLY[code] || code;
}

// ---- Convenience wrappers --------------------------------------------------

export const portalConfig = () => portalRequest('config', {}, { auth: false });
export const requestLoginLink = (role, phone) => portalRequest('request_link', { role, phone }, { auth: false });
export const verifyLoginToken = (token) => portalRequest('verify', { token }, { auth: false });
export const fetchNurseHome = () => portalRequest('nurse_home');
export const fetchPatientHome = () => portalRequest('patient_home');
export const fetchDoctorHome = () => portalRequest('doctor_home');

/** The dashboard payload for whichever role is signed in. */
export function fetchHome(role) {
  return portalRequest(`${role}_home`);
}

/**
 * Sign in as a sample person. Entirely local — no server, no WhatsApp, no
 * network at all — so the three dashboards open with nothing deployed.
 * Guarded by CONFIG.SAMPLE_LOGIN, which must be false in production.
 */
export async function sampleLogin(role) {
  if (!CONFIG.SAMPLE_LOGIN) throw new Error('Sample sign-in is not available on this build.');
  const session = makeSampleSession(role);
  setPortalSession(session);
  return session.profile;
}

export async function portalLogout() {
  try { await portalRequest('logout'); } catch { /* revoking is best-effort */ }
  clearPortalSession();
}
