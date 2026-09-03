// _shared/db.ts — service-role Supabase client (edge runtime only; never shipped to browser)
import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * Resolves the privileged Supabase key for this project.
 *
 * Projects on the new key system (JWT Signing Keys) don't populate the legacy
 * SUPABASE_SERVICE_ROLE_KEY — instead Supabase injects SUPABASE_SECRET_KEYS, a
 * JSON dictionary keyed by name (the default key is named "default").
 * Older projects still on legacy keys only have SUPABASE_SERVICE_ROLE_KEY.
 * Try the new format first, then fall back so this works on either project type.
 */
export function getServiceKey(): string {
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw) as Record<string, string>;
      const key = parsed['default'] ?? Object.values(parsed)[0];
      if (key) return key;
    } catch (e) {
      console.error('getServiceKey: failed to parse SUPABASE_SECRET_KEYS:', e);
    }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('getServiceKey: no SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY available');
}

export const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  getServiceKey(),
  { auth: { persistSession: false } },
);

/** Read one settings row's JSONB value. Returns null when missing (never throws). */
export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  try {
    const { data, error } = await db.from('settings').select('value').eq('key', key).maybeSingle();
    if (error) {
      console.error(`getSetting(${key}) failed:`, error.message);
      return null;
    }
    return (data?.value ?? null) as T | null;
  } catch (e) {
    console.error(`getSetting(${key}) exception:`, e);
    return null;
  }
}