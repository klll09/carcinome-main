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

export const SESSION_KEY = 'carcinome_portal_session';

// ---- Session storage -------------------------------------------------------

/** { token, expires_at, profile: { role, id, full_name, language_pref } } | null */
export function getPortalSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.token || !s?.profile?.role) return null;

    if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }

    return s;
  } catch {
    return null;
  }
}

function dropChatSocket() {
  import('./chat.js').then((m) => m.disconnectChat()).catch(() => {
    // Chat may never have been loaded.
  });
}

export function setPortalSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {}

  dropChatSocket();
}

export function clearPortalSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}

  dropChatSocket();
}

// ---- Transport -------------------------------------------------------------

export function portalEndpoint() {
  return CONFIG.SAMPLE_LOGIN
    ? `${CONFIG.CHAT_URL}/portal`
    : `${CONFIG.FUNCTIONS_URL}/portal`;
}

export async function portalRequest(action, params = {}, { auth = true } = {}) {
  const session = auth ? getPortalSession() : null;

  if (session && isSampleSession(session)) {
    const local = sampleAnswer(action, session);
    if (local !== undefined) return local;
  }

  const headers = { 'Content-Type': 'application/json' };

  if (session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }

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

  try {
    body = await res.json();
  } catch {
    // Non-JSON response.
  }

  if (res.status === 401 && auth) {
    clearPortalSession();
    throw new Error('Your sign-in has expired. Please sign in again.');
  }

  if (!res.ok || body?.ok === false) {
    const msg = body?.error || `Request failed (HTTP ${res.status})`;
    console.error('[portal] error:', action, res.status, body);
    throw new Error(friendlyError(msg));
  }

  return body;
}

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

export const portalConfig = () =>
  portalRequest('config', {}, { auth: false });

export const requestLoginLink = (role, phone) =>
  portalRequest('request_link', { role, phone }, { auth: false });

export const passwordLogin = (role, email, password) =>
  portalRequest(
    'password_login',
    { role, email, password },
    { auth: false },
  );

export const verifyLoginToken = (token) =>
  portalRequest('verify', { token }, { auth: false });

export const fetchNurseHome = () =>
  portalRequest('nurse_home');

export const fetchPatientHome = () =>
  portalRequest('patient_home');

export const fetchDoctorHome = () =>
  portalRequest('doctor_home');

export function fetchHome(role) {
  return portalRequest(`${role}_home`);
}

export async function sampleLogin(role) {
  if (!CONFIG.SAMPLE_LOGIN) {
    throw new Error('Sample sign-in is not available on this build.');
  }

  const session = makeSampleSession(role);
  setPortalSession(session);
  return session.profile;
}

export async function portalLogout() {
  try {
    await portalRequest('logout');
  } catch {
    // Revoking is best-effort.
  }

  clearPortalSession();
}