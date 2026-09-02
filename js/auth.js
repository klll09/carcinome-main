// ============================================================
// Carcinome Home Care — Auth Module
// Login, logout, session management. Single admin role —
// no impersonation, no multi-role helpers.
// ============================================================

import { getSupabase } from './supabase.js';

let currentUser = null;
let currentProfile = null;

// ---- Get current session & profile ----
export function getCurrentUser() { return currentUser; }
export function getCurrentProfile() { return currentProfile; }

// The only gate in this app: an active admin profile.
export function isAdmin() {
  return currentProfile?.role === 'admin' && currentProfile?.is_active === true;
}

// ---- Helper: wrap a promise with a hard timeout ----
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ---- Read the Supabase session directly from localStorage ----
// Supabase JS persists sessions at key "sb-{project-ref}-auth-token".
// If getSession() hangs on its network refresh, we still want to honor the
// session that's already stored locally — the user logged in successfully,
// the access_token is right there, we should let them into the app.
function readSessionFromStorage() {
  if (typeof localStorage === 'undefined') return null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const value = JSON.parse(raw);
      // Some Supabase versions wrap the session under a "currentSession" key.
      const session = value?.currentSession || value;
      if (session?.access_token && session?.user) {
        // A token that expired long ago is a zombie: booting with it renders
        // an unauthenticated shell where RLS rejects everything and there is
        // no way back to the login screen. Within 48h we still accept it —
        // getSession() may refresh it once the network cooperates.
        const expiresAt = Number(session.expires_at || 0);   // epoch seconds
        if (expiresAt && Date.now() / 1000 - expiresAt > 48 * 3600) {
          console.warn('[auth] stored session expired long ago — ignoring it');
          continue;
        }
        return session;
      }
    } catch (e) {
      console.warn('[auth] could not parse stored session at', key, e);
    }
  }
  return null;
}

// ---- Initialize auth (check existing session) ----
// Two-stage: try the official getSession (which can hit the network to
// refresh the token), and if it times out OR errors, fall back to whatever
// Supabase already wrote to localStorage. RLS will reject any stale token
// at the DB layer — but the user reaches the app shell instead of being
// stranded on the login screen.
export async function initAuth() {
  const sb = getSupabase();
  if (!sb) return null;

  let session = null;

  // Stage 1: try the official client (fast path)
  try {
    const { data, error } = await withTimeout(sb.auth.getSession(), 4000, 'getSession');
    if (!error && data?.session?.user) {
      session = data.session;
    } else if (error) {
      console.warn('[auth] getSession returned error:', error.message);
    }
  } catch (timeoutErr) {
    console.warn('[auth] ' + timeoutErr.message + ' — falling back to localStorage');
  }

  // Stage 2: localStorage fallback
  if (!session) {
    session = readSessionFromStorage();
    if (session) console.log('[auth] using cached session from localStorage');
  }

  if (!session?.user) {
    currentUser = null;
    currentProfile = null;
    return null;
  }

  currentUser = session.user;
  // Profile load MUST be awaited (the shell shows the admin's name and the
  // isAdmin gate depends on it) — but never let a hung request strand the
  // user on the boot screen: time out, boot anyway, retry in background.
  let profileStatus = 'error';
  try {
    profileStatus = await withTimeout(loadProfile(), 6000, 'loadProfile');
  } catch (err) {
    console.warn('[auth] loadProfile failed:', err);
    setTimeout(() => loadProfile().catch(() => {}), 1500);
  }
  // Definitively unusable session (profile row gone, or token rejected):
  // tear it down and land on the login screen — never boot a broken shell.
  if (profileStatus === 'missing' || profileStatus === 'invalid') {
    console.warn('[auth] session has no usable profile (' + profileStatus + ') — signing out');
    await clearSession();
    return null;
  }
  return session;
}

// ---- Load user profile from profiles table ----
// Returns a status the callers act on:
//   'ok'      — profile loaded
//   'missing' — query succeeded, no row: the account has no profile.
//   'invalid' — the token itself was rejected (expired / bad JWT).
//   'error'   — transient failure (network, RLS hiccup); worth retrying.
async function loadProfile() {
  if (!currentUser) return 'error';
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .maybeSingle();

  if (error) {
    console.error('[auth] failed to load profile:', error);
    return /jwt|token|expired|invalid/i.test(error.message || '') ? 'invalid' : 'error';
  }

  if (!data) {
    console.error('[auth] profile not found for user ID:', currentUser.id);
    return 'missing';
  }

  currentProfile = data;
  return 'ok';
}

// ---- Hard session teardown ----
// Used when the session is unusable (no profile row / rejected token):
// best-effort server sign-out, then guarantee the local tokens are gone so
// the next boot lands cleanly on the login screen instead of a broken shell.
export async function clearSession() {
  try { await withTimeout(getSupabase().auth.signOut(), 3000, 'signOut'); }
  catch (e) { console.warn('[auth] signOut during teardown failed:', e.message); }
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) stale.push(key);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch {}
  currentUser = null;
  currentProfile = null;
}

// ---- Sign In ----
// This dashboard is admin-only: a successful password sign-in whose profile
// is definitively not an active admin gets torn down with a clear message.
// A transient profile-load failure does NOT block login (RLS at the DB layer
// is the real gate — a non-admin sees empty pages, not data).
export async function signIn(email, password) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  currentUser = data.user;
  try {
    const status = await loadProfile();
    // We JUST authenticated, so 'missing' here is definitive, not a network
    // blip: the account exists in auth but has no profile row.
    if (status === 'missing') {
      await clearSession();
      throw new Error('This account has no admin profile. Please contact the Carcinome tech team.');
    }
    if (status === 'ok' && !isAdmin()) {
      await clearSession();
      throw new Error('This dashboard is for Carcinome admins only.');
    }
  } catch (err) {
    if (/admin profile|admins only/.test(err.message || '')) throw err;
    console.warn('[auth] loadProfile after signIn failed:', err);
  }
  return data;
}

// ---- Sign Out ----
export async function signOut() {
  const sb = getSupabase();
  const { error } = await sb.auth.signOut();
  if (error) throw new Error(error.message);
  currentUser = null;
  currentProfile = null;
}
