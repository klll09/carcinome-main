// ============================================================
// Carcinome Home Care — Supabase Client (singleton)
// ============================================================

import { CONFIG } from './config.js';

let supabase = null;

export function getSupabase() {
  if (supabase) return supabase;

  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    // Don't return null silently — surface the failure so the boot watchdog
    // and any caller can render a useful error instead of hanging.
    const err = new Error(
      'Supabase JS library failed to load (CDN blocked or network unreachable). ' +
      'Check that cdn.jsdelivr.net is reachable from this device.'
    );
    console.error(err);
    throw err;
  }

  supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  return supabase;
}
