// _shared/doctor.ts — the observer mirrors. Every patient-facing moment gets
// an observer-phrased copy ("Hey doctor, we got this…") so the referring
// doctor AND the patient's Carcinome POC (the intern who owns that family)
// follow the whole case as a log — never the raw chat dump.
// Respects MUTE (relay='muted' participant row) unless evenIfMuted; milestones
// participants DO receive mirrors — that is what milestones mode means.
import { db } from './db.ts';
import { type Lang, pick } from './lang.ts';
import { logEvent } from './log.ts';
import { paramSafe, sendSmart } from './wa.ts';

export type MirrorOpts = {
  evenIfMuted?: boolean;
  event?: string; // optional case_events entry
  data?: Record<string, unknown>;
};

type DoctorRow = { id: string; full_name: string; phone: string; language_pref: string; opted_out: boolean };

/**
 * Send a doctor-phrased mirror message for a case moment.
 * Window-aware (free text when open, care_update template otherwise).
 * Returns true when a send was attempted.
 */
export async function notifyDoctor(
  caseId: string,
  text: { en: string; hi: string } | string,
  opts: MirrorOpts = {},
): Promise<boolean> {
  // Set only when the doctor copy was actually SENT — the POC hook dedupes a
  // doubled poc==doctor phone against this, so a muted/opted-out doctor never
  // silently swallows the POC's log line too.
  let deliveredToPhone: string | null = null;
  try {
    const { data: c, error } = await db
      .from('cases')
      .select('id, case_code, doctors:doctor_id(id, full_name, phone, language_pref, opted_out)')
      .eq('id', caseId)
      .maybeSingle();
    if (error || !c) return false;
    const doctor = c.doctors as unknown as DoctorRow | null;
    if (!doctor?.phone || doctor.opted_out) return false;

    if (!opts.evenIfMuted) {
      const { data: part } = await db
        .from('case_participants')
        .select('relay')
        .eq('case_id', caseId)
        .eq('phone', doctor.phone)
        .eq('role', 'doctor')
        .eq('active', true)
        .maybeSingle();
      if (part?.relay === 'muted') return false;
    }

    const lang: Lang = doctor.language_pref === 'hi' ? 'hi' : 'en';
    const body = typeof text === 'string' ? text : pick(lang, text);
    await sendSmart(
      doctor.phone,
      body,
      { name: 'care_update', lang, params: ['Carcinome Team', paramSafe(body, 250)] },
      { caseId, role: 'doctor' },
    );
    deliveredToPhone = doctor.phone;
    if (opts.event) await logEvent(caseId, opts.event, 'system', opts.data ?? {});
    return true;
  } catch (e) {
    console.error('notifyDoctor exception:', e);
    return false;
  } finally {
    // The POC observes every doctor-mirrored moment too — one hook covers all
    // existing mirror call sites. Never throws.
    try {
      await notifyPoc(caseId, text, { skipPhone: deliveredToPhone });
    } catch (e) {
      console.error('notifyPoc via notifyDoctor failed:', e);
    }
  }
}

/**
 * Send a log-style update to the case's POC participant(s) — the intern who
 * owns this family's follow-up. Skips muted/inactive rows; skipPhone dedupes
 * a doubled phone that already received this moment in another role.
 * (A POC number that is ALSO in the supervisor/ops lists can still see a team
 * alert plus the 📔 line for the same beat — accepted: different framings.)
 */
export async function notifyPoc(
  caseId: string,
  text: { en: string; hi: string } | string,
  opts: { skipPhone?: string | null } = {},
): Promise<boolean> {
  try {
    const { data: parts } = await db
      .from('case_participants')
      .select('phone, display_name, relay')
      .eq('case_id', caseId)
      .eq('role', 'poc')
      .eq('active', true)
      .neq('relay', 'muted');
    let sent = false;
    for (const part of parts ?? []) {
      if (!part.phone || part.phone === (opts.skipPhone ?? null)) continue;
      const body = typeof text === 'string' ? text : text.en; // POC = internal team → English log line
      await sendSmart(
        part.phone,
        `📔 ${body}`,
        { name: 'care_update', lang: 'en', params: ['Carcinome Team', paramSafe(body, 250)] },
        { caseId, role: 'poc' },
      );
      sent = true;
    }
    return sent;
  } catch (e) {
    console.error('notifyPoc exception:', e);
    return false;
  }
}
