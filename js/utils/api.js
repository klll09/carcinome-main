// ============================================================
// Carcinome Home Care — Edge-function + Storage helpers
//   adminAction(action, params)  → POST /functions/v1/admin-actions
//   uploadCaseDoc(file, prefix)  → Storage 'case-docs' bucket
// ============================================================

import { CONFIG } from '../config.js';
import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { navigate } from '../router.js';

// ---- Get the current session access token (with storage fallback) ----
async function getAccessToken() {
  const sb = getSupabase();
  try {
    const { data } = await Promise.race([
      sb.auth.getSession(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getSession timeout')), 4000)),
    ]);
    if (data?.session?.access_token) return data.session.access_token;
  } catch (e) {
    console.warn('[api] getSession failed, trying localStorage:', e.message);
  }
  // Fallback: the token Supabase already persisted locally.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      const session = value?.currentSession || value;
      if (session?.access_token) return session.access_token;
    }
  } catch {}
  return null;
}

function bounceToLogin(message) {
  showToast(message, 'error');
  navigate('login');
}

// ---- adminAction: POST { action, ...params } to admin-actions ----
// Throws Error(message) on any failure; resolves the JSON body on success.
export async function adminAction(action, params = {}) {
  const token = await getAccessToken();
  if (!token) {
    bounceToLogin('Your session has expired. Please sign in again.');
    throw new Error('Not signed in');
  }

  let res;
  try {
    res = await fetch(`${CONFIG.FUNCTIONS_URL}/admin-actions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...params }),
    });
  } catch (netErr) {
    console.error('[api] adminAction network failure:', action, netErr);
    throw new Error('Network error — could not reach the server. Check your connection and retry.');
  }

  if (res.status === 401) {
    bounceToLogin('Your session has expired. Please sign in again.');
    throw new Error('Session expired');
  }

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const msg = body?.error || body?.message || `Request failed (HTTP ${res.status})`;
    console.error('[api] adminAction error:', action, res.status, body);
    throw new Error(msg);
  }
  return body;
}

// ---- uploadCaseDoc: upload a file to the private 'case-docs' bucket ----
// Path: uploads/{ts}_{prefix?}_{filename}. Returns the storage path.
export async function uploadCaseDoc(file, prefix = '') {
  if (!file) throw new Error('No file selected');
  const MAX_BYTES = 50 * 1024 * 1024; // bucket limit
  if (file.size > MAX_BYTES) throw new Error('File is too large (max 50 MB)');

  const sb = getSupabase();
  const safeName = String(file.name || 'document')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-120);
  const safePrefix = prefix ? String(prefix).replace(/[^\w\-]+/g, '_').slice(0, 60) + '_' : '';
  const path = `uploads/${Date.now()}_${safePrefix}${safeName}`;

  const { data, error } = await sb.storage
    .from('case-docs')
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });

  if (error) {
    console.error('[api] uploadCaseDoc failed:', error);
    if (/jwt|token|not.*authorized|401/i.test(error.message || '')) {
      bounceToLogin('Your session has expired. Please sign in again.');
    }
    throw new Error(error.message || 'Upload failed');
  }
  return data?.path || path;
}

// ---- signedDocUrl: short-lived URL for viewing a private case doc ----
export async function signedDocUrl(path, expiresInSec = 600) {
  if (!path) throw new Error('No document path');
  const sb = getSupabase();
  const { data, error } = await sb.storage.from('case-docs').createSignedUrl(path, expiresInSec);
  if (error) {
    console.error('[api] signedDocUrl failed:', error);
    throw new Error(error.message || 'Could not open document');
  }
  return data.signedUrl;
}
