// _shared/db.ts — service-role Supabase client (edge runtime only; never shipped to browser)
import { createClient } from 'npm:@supabase/supabase-js@2';

export const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
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
