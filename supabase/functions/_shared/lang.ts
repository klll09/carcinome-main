// _shared/lang.ts — language preference resolution for any phone number.
// Checks patients (wa_number/phone), then nurses, doctors, suppliers. Default 'en'.
import { db } from './db.ts';
import { normPhone } from './phone.ts';

export type Lang = 'en' | 'hi';

export async function langFor(phone: string): Promise<Lang> {
  const p = normPhone(phone);
  if (!p) return 'en';
  try {
    const pt = await db
      .from('patients')
      .select('language_pref')
      .or(`wa_number.eq.${p},phone.eq.${p}`)
      .limit(1);
    if (pt.data && pt.data.length > 0) return pt.data[0].language_pref === 'hi' ? 'hi' : 'en';

    for (const table of ['nurses', 'doctors', 'suppliers'] as const) {
      const r = await db.from(table).select('language_pref').eq('phone', p).limit(1);
      if (r.data && r.data.length > 0) return r.data[0].language_pref === 'hi' ? 'hi' : 'en';
    }
  } catch (e) {
    console.error('langFor exception:', e);
  }
  return 'en';
}

/** Pick from a bilingual pair. */
export function pick(lang: Lang, pair: { en: string; hi: string }): string {
  return lang === 'hi' ? pair.hi : pair.en;
}
