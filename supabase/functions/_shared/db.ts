// _shared/db.ts — service-role Supabase client (edge runtime only; never shipped to browser)
import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * Resolves the privileged Supabase key for this project.
 * Supports both the new secret-key format and legacy service-role keys.
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

  throw new Error(
    'getServiceKey: no SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY available',
  );
}

const serviceKey = getServiceKey();

/**
 * New Supabase secret keys must be sent through the `apikey` header.
 * Prevent the client from also sending sb_secret keys as Bearer tokens.
 * Legacy JWT service-role keys keep their standard Authorization behavior.
 */
const serviceKeyFetch: typeof fetch = (input, init) => {
  if (!serviceKey.startsWith('sb_secret_')) {
    return fetch(input, init);
  }

  const headers = new Headers(init?.headers);

  if (headers.get('Authorization') === `Bearer ${serviceKey}`) {
    headers.delete('Authorization');
  }

  return fetch(input, { ...init, headers });
};

export const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  serviceKey,
  {
    auth: { persistSession: false },
    global: { fetch: serviceKeyFetch },
  },
);

/** Read one settings row's JSONB value. Returns null when missing (never throws). */
export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  try {
    const { data, error } = await db
      .from('settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

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