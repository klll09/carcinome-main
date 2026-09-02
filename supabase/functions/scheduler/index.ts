// scheduler/index.ts — time-driven jobs (CONTRACTS §scheduler).
// verify_jwt OFF; the ONLY auth is header `x-cron-secret` === CRON_SECRET.
// POST { job } ∈ reminders_24h | reminders_morning | otp_issue | otp_expiry |
//               sla_nudge | feedback_chaser | archiver
// Every job is idempotent (case_events dedupe — partial unique index for the
// once-ever events, explicit event queries for the repeatable ones) and returns
// { job, processed, actions: [...] } for observability.
import { db, getSetting } from '../_shared/db.ts';
import { autoAvailabilityChecks, reapAvailabilityTimeouts } from '../_shared/availability.ts';
import { notifyDoctor } from '../_shared/doctor.ts';
import { langFor, pick, type Lang } from '../_shared/lang.ts';
import { logEvent } from '../_shared/log.ts';
import { issueOtp, sendOtpMessages } from '../_shared/otp.ts';
import { normPhone } from '../_shared/phone.ts';
import { paramSafe, sendFlow, sendSmart, sendTemplate } from '../_shared/wa.ts';

const HOUR = 3600_000;
const IST_OFFSET = 5.5 * HOUR;
const BATCH = 200;

type JobResult = { job: string; processed: number; actions: unknown[] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Constant-time string compare (fixed-length XOR loop over utf8 bytes). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length === bb.length ? 0 : 1;
  const n = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i % (ab.length || 1)] ?? 0) ^ (bb[i % (bb.length || 1)] ?? 0);
  }
  return diff === 0;
}

function fmtIST(ts: string | Date | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return String(ts);
  }
}

function langOf(pref: string | null | undefined): Lang {
  return pref === 'hi' ? 'hi' : 'en';
}

function nonce8(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ─── case_events helpers ─────────────────────────────────────────────────────
async function eventExists(caseId: string, eventType: string): Promise<boolean> {
  const { data, error } = await db
    .from('case_events')
    .select('id')
    .eq('case_id', caseId)
    .eq('event_type', eventType)
    .limit(1);
  if (error) {
    console.error(`eventExists(${eventType}) failed:`, error.message);
    return true; // fail safe: assume done, don't double-send
  }
  return (data ?? []).length > 0;
}

async function lastEventAt(caseId: string, eventType: string): Promise<string | null> {
  const { data, error } = await db
    .from('case_events')
    .select('created_at')
    .eq('case_id', caseId)
    .eq('event_type', eventType)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error(`lastEventAt(${eventType}) failed:`, error.message);
    return new Date().toISOString(); // fail safe: pretend just-fired
  }
  return data?.[0]?.created_at ?? null;
}

async function eventCount(caseId: string, eventType: string): Promise<number> {
  const { count, error } = await db
    .from('case_events')
    .select('id', { count: 'exact', head: true })
    .eq('case_id', caseId)
    .eq('event_type', eventType);
  if (error) {
    console.error(`eventCount(${eventType}) failed:`, error.message);
    return 99; // fail safe
  }
  return count ?? 0;
}

// ─── shared senders ──────────────────────────────────────────────────────────
const DEFAULT_SCREENS: Record<string, string> = {
  consent_v1: 'INFO',
  completion_v1: 'REPORT',
  feedback_v1: 'FEEDBACK',
};

async function getFlowRef(name: string): Promise<{ id: string; screen: string } | null> {
  const ids = await getSetting<Record<string, unknown>>('flow_ids');
  const v = ids?.[name];
  if (!v) return null;
  if (typeof v === 'string') return { id: v, screen: DEFAULT_SCREENS[name] ?? 'START' };
  const obj = v as { id?: string; screen?: string };
  if (!obj.id) return null;
  return { id: obj.id, screen: obj.screen ?? DEFAULT_SCREENS[name] ?? 'START' };
}

async function isWindowOpen(phone: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('open_window', { p_phone: normPhone(phone) });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

const CARE_LABELS: Record<string, string> = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemotherapy infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};

async function careLabel(careType: string): Promise<string> {
  const l = (await getSetting<Record<string, string>>('care_type_labels')) ?? {};
  return l[careType] ?? CARE_LABELS[careType] ?? careType;
}

type SchedCase = {
  id: string;
  case_code: string;
  status: string;
  care_type: string;
  scheduled_at: string;
  address: string;
  consented_at: string | null;
  completed_at: string | null;
  created_at: string;
  patients: { id: string; full_name: string; wa_number: string; language_pref: string; locality: string | null; pincode: string | null } | null;
  nurses: { id: string; full_name: string; phone: string; language_pref: string } | null;
};

const CASE_SELECT =
  'id, case_code, status, care_type, scheduled_at, address, consented_at, completed_at, created_at, ' +
  'patients:patient_id(id, full_name, wa_number, language_pref, locality, pincode), ' +
  'nurses:assigned_nurse_id(id, full_name, phone, language_pref)';

async function sendConsentChaser(c: SchedCase): Promise<void> {
  const p = c.patients;
  if (!p) return;
  const lang = langOf(p.language_pref);
  const token = `consent_v1:${c.id}:${nonce8()}`;
  const flow = await getFlowRef('consent_v1');
  if (flow && (await isWindowOpen(p.wa_number))) {
    const summary = `${c.case_code} • ${await careLabel(c.care_type)} • ${fmtIST(c.scheduled_at)}`;
    await sendFlow(
      p.wa_number,
      {
        flowId: flow.id,
        flowToken: token,
        cta: pick(lang, { en: 'Open consent form', hi: 'सहमति फ़ॉर्म खोलें' }),
        screen: flow.screen,
        data: { summary },
        bodyText: pick(lang, {
          en: `Reminder: your home-care session (case ${c.case_code}) is today and we still need your signed consent. Please submit the form below before the nurse arrives.`,
          hi: `आपका होम-केयर सेशन (केस ${c.case_code}) आज है और हमें अभी भी आपकी हस्ताक्षरित सहमति चाहिए। कृपया नर्स के आने से पहले नीचे दिया गया फ़ॉर्म जमा करें।`,
        }),
      },
      { caseId: c.id, role: 'patient' },
    );
  } else {
    await sendTemplate(p.wa_number, 'consent_flow_invite', lang, [p.full_name, c.case_code], {
      caseId: c.id,
      role: 'patient',
      flowToken: token,
    });
  }
  await logEvent(c.id, 'consent_chased', 'scheduler', {});
  await notifyDoctor(c.id, {
    en: `📋 ${c.case_code} (${p.full_name}): consent is still pending on the day of the session — the form has been re-sent to the patient.`,
    hi: `📋 ${c.case_code} (${p.full_name}): सेशन के दिन भी सहमति लंबित है — फ़ॉर्म रोगी को दोबारा भेज दिया गया है।`,
  });
}

/** Both session reminders for one case (patient + nurse). */
async function sendSessionReminders(c: SchedCase): Promise<{ patient: boolean; nurse: boolean }> {
  const schedFmt = fmtIST(c.scheduled_at);
  let patientOk = false;
  let nurseOk = false;
  if (c.patients) {
    const r = await sendTemplate(
      c.patients.wa_number,
      'infusion_reminder_patient',
      langOf(c.patients.language_pref),
      [schedFmt, c.nurses?.full_name ?? 'from our team'],
      { caseId: c.id, role: 'patient' },
    );
    patientOk = r.ok;
  }
  if (c.nurses && c.patients) {
    const r = await sendTemplate(
      c.nurses.phone,
      'infusion_reminder_nurse',
      langOf(c.nurses.language_pref),
      [c.patients.full_name, schedFmt, paramSafe(c.address, 250)],
      { caseId: c.id, role: 'nurse' },
    );
    nurseOk = r.ok;
    // Arrival protocol reminder — typed announcement, code-verified presence.
    const nlang = langOf(c.nurses.language_pref);
    const arrivalTip = pick(nlang, {
      en: `📍 When you REACH ${c.patients.full_name}'s home, simply send a message here (for example: "Reached"). We will then verify your arrival with the 6-digit number the family has.`,
      hi: `📍 जब आप ${c.patients.full_name} के घर पहुंच जाएं, तो बस यहां एक संदेश भेज दें (जैसे: "Pahunch gayi")। फिर परिवार के पास मौजूद 6-अंकों के नंबर से आपका आगमन सत्यापित होगा।`,
    });
    await sendSmart(
      c.nurses.phone,
      arrivalTip,
      { name: 'care_update', lang: nlang, params: ['Carcinome Team', paramSafe(arrivalTip, 500)] },
      { caseId: c.id, role: 'nurse' },
    );
  }
  // Doctor mirror — session reminders went out to their patient.
  if (patientOk) {
    await notifyDoctor(c.id, {
      en: `⏰ ${c.case_code} (${c.patients?.full_name ?? 'patient'}): session reminder sent — home care is scheduled for ${schedFmt} with nurse ${c.nurses?.full_name ?? 'to be confirmed'}.`,
      hi: `⏰ ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): सेशन रिमाइंडर भेजा गया — होम केयर ${schedFmt} पर नर्स ${c.nurses?.full_name ?? '(पुष्टि शेष)'} के साथ निर्धारित है।`,
    });
  }
  return { patient: patientOk, nurse: nurseOk };
}

async function teamPhones(): Promise<string[]> {
  const sup = ((await getSetting<string[]>('supervisor_phones')) ?? []).map(normPhone).filter(Boolean);
  const ops = ((await getSetting<string[]>('ops_phones')) ?? []).map(normPhone).filter(Boolean);
  return [...new Set([...sup, ...ops])];
}

// ════════════════════════════════════════════════════════════════════════════
// Jobs
// ════════════════════════════════════════════════════════════════════════════

/** T-24h reminders: sessions scheduled in [now+23h, now+25h]. Dedupe: reminder_24h (unique). */
async function jobReminders24h(): Promise<JobResult> {
  const actions: unknown[] = [];
  const now = Date.now();
  const { data, error } = await db
    .from('cases')
    .select(CASE_SELECT)
    .in('status', ['assigned', 'consented', 'otp_sent'])
    .gte('scheduled_at', new Date(now + 23 * HOUR).toISOString())
    .lte('scheduled_at', new Date(now + 25 * HOUR).toISOString())
    .limit(BATCH);
  if (error) return { job: 'reminders_24h', processed: 0, actions: [{ error: error.message }] };

  let processed = 0;
  for (const c of (data ?? []) as unknown as SchedCase[]) {
    try {
      if (await eventExists(c.id, 'reminder_24h')) continue;
      const r = await sendSessionReminders(c);
      await logEvent(c.id, 'reminder_24h', 'scheduler', r);
      processed++;
      actions.push({ case: c.case_code, ...r });
    } catch (e) {
      console.error(`reminders_24h ${c.case_code} failed:`, e);
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { job: 'reminders_24h', processed, actions };
}

/** Morning-of reminders for today's IST sessions + consent chaser. Dedupe: reminder_morning (unique). */
async function jobRemindersMorning(): Promise<JobResult> {
  const actions: unknown[] = [];
  // Today's IST day expressed as a UTC range.
  const nowIst = new Date(Date.now() + IST_OFFSET);
  const dayStartUtc = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET;
  const dayEndUtc = dayStartUtc + 24 * HOUR;

  const { data, error } = await db
    .from('cases')
    .select(CASE_SELECT)
    .in('status', ['assigned', 'consented', 'otp_sent'])
    .gte('scheduled_at', new Date(dayStartUtc).toISOString())
    .lt('scheduled_at', new Date(dayEndUtc).toISOString())
    .limit(BATCH);
  if (error) return { job: 'reminders_morning', processed: 0, actions: [{ error: error.message }] };

  let processed = 0;
  for (const c of (data ?? []) as unknown as SchedCase[]) {
    try {
      if (await eventExists(c.id, 'reminder_morning')) continue;
      const r = await sendSessionReminders(c);
      let consentChased = false;
      if (!c.consented_at && c.status === 'assigned') {
        await sendConsentChaser(c);
        consentChased = true;
      }
      await logEvent(c.id, 'reminder_morning', 'scheduler', { ...r, consent_chased: consentChased });
      processed++;
      actions.push({ case: c.case_code, ...r, consent_chased: consentChased });
    } catch (e) {
      console.error(`reminders_morning ${c.case_code} failed:`, e);
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { job: 'reminders_morning', processed, actions };
}

/** Auto-issue OTP for sessions starting within 60 min (assigned/consented, no active OTP). */
async function jobOtpIssue(): Promise<JobResult> {
  const actions: unknown[] = [];
  const now = Date.now();
  const { data, error } = await db
    .from('cases')
    .select(CASE_SELECT)
    .in('status', ['assigned', 'consented'])
    .gte('scheduled_at', new Date(now - 30 * 60_000).toISOString()) // tolerate a missed run
    .lte('scheduled_at', new Date(now + 60 * 60_000).toISOString())
    .not('assigned_nurse_id', 'is', null)
    .limit(BATCH);
  if (error) return { job: 'otp_issue', processed: 0, actions: [{ error: error.message }] };

  let processed = 0;
  for (const c of (data ?? []) as unknown as SchedCase[]) {
    try {
      if (!c.patients || !c.nurses) continue;
      const { data: active } = await db
        .from('otps')
        .select('id')
        .eq('case_id', c.id)
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .limit(1);
      if ((active ?? []).length > 0) continue;

      const otp = await issueOtp(c.id);
      if (!otp.ok || !otp.code) {
        actions.push({ case: c.case_code, error: otp.error });
        continue;
      }
      await sendOtpMessages(c.id, otp.code, c.patients, c.nurses);
      await db.from('cases').update({ status: 'otp_sent' }).eq('id', c.id).in('status', ['assigned', 'consented']);
      await logEvent(c.id, 'otp_issued', 'scheduler', { expires_at: otp.expiresAt });
      processed++;
      actions.push({ case: c.case_code, expires_at: otp.expiresAt });
    } catch (e) {
      console.error(`otp_issue ${c.case_code} failed:`, e);
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { job: 'otp_issue', processed, actions };
}

/** Expire stale OTPs + alert the team when a nurse is >30 min late with no arrival. */
async function jobOtpExpiry(): Promise<JobResult> {
  const actions: unknown[] = [];
  const nowIso = new Date().toISOString();

  const { data: expired, error } = await db
    .from('otps')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('expires_at', nowIso)
    .select('id, case_id');
  if (error) console.error('otp expiry update failed:', error.message);
  let processed = (expired ?? []).length;
  if (processed) actions.push({ expired_otps: processed });

  // Arrival overdue: session should have started >30 min ago, still no verified arrival.
  const { data: late, error: lateErr } = await db
    .from('cases')
    .select(CASE_SELECT)
    .in('status', ['otp_sent', 'consented', 'assigned'])
    .is('arrival_verified_at', null)
    .lt('scheduled_at', new Date(Date.now() - 30 * 60_000).toISOString())
    .gt('scheduled_at', new Date(Date.now() - 24 * HOUR).toISOString()) // don't nag about ancient cases
    .limit(BATCH);
  if (lateErr) {
    actions.push({ error: lateErr.message });
    return { job: 'otp_expiry', processed, actions };
  }

  const phones = await teamPhones();
  for (const c of (late ?? []) as unknown as SchedCase[]) {
    try {
      if (await eventExists(c.id, 'arrival_overdue_alert')) continue;
      const msg =
        `⚠️ ${c.case_code}: session was scheduled ${fmtIST(c.scheduled_at)} and the nurse` +
        ` (${c.nurses?.full_name ?? 'unassigned'}) has not verified arrival. Please follow up.`;
      for (const ph of phones) {
        await sendSmart(
          ph,
          msg,
          { name: 'care_update', lang: await langFor(ph), params: ['Carcinome System', paramSafe(msg, 160)] },
          { caseId: c.id, role: 'ops' },
        );
      }
      await logEvent(c.id, 'arrival_overdue_alert', 'scheduler', { scheduled_at: c.scheduled_at });
      processed++;
      actions.push({ case: c.case_code, arrival_overdue: true });
    } catch (e) {
      console.error(`otp_expiry alert ${c.case_code} failed:`, e);
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { job: 'otp_expiry', processed, actions };
}

/** Nudge supervisors about offering-cases past the SLA; re-nudge at most every 3h. */
async function jobSlaNudge(): Promise<JobResult> {
  const actions: unknown[] = [];
  const slaHours = Number((await getSetting<number>('sla_offer_hours')) ?? 6) || 6;
  const { data, error } = await db
    .from('cases')
    .select(CASE_SELECT)
    .eq('status', 'offering')
    .lt('created_at', new Date(Date.now() - slaHours * HOUR).toISOString())
    .limit(BATCH);
  if (error) return { job: 'sla_nudge', processed: 0, actions: [{ error: error.message }] };

  const supPhones = ((await getSetting<string[]>('supervisor_phones')) ?? []).map(normPhone).filter(Boolean);
  if (supPhones.length === 0) {
    return { job: 'sla_nudge', processed: 0, actions: [{ warning: 'no supervisor_phones configured' }] };
  }

  let processed = 0;
  for (const c of (data ?? []) as unknown as SchedCase[]) {
    try {
      const last = await lastEventAt(c.id, 'sla_nudge');
      if (last && Date.now() - new Date(last).getTime() < 3 * HOUR) continue;

      const hours = Math.floor((Date.now() - new Date(c.created_at).getTime()) / HOUR);
      const { count: yesCount } = await db
        .from('case_offers')
        .select('id', { count: 'exact', head: true })
        .eq('case_id', c.id)
        .eq('response', 'yes');
      const p = c.patients;
      let area = p?.locality
        ? (p.pincode ? `${p.locality}, ${p.pincode}` : p.locality)
        : String(c.address ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(-2).join(', ') || 'unknown area';
      if ((yesCount ?? 0) > 0) area = `${area} · ${yesCount} accepted`;

      for (const ph of supPhones) {
        await sendTemplate(ph, 'sla_nudge_supervisor', await langFor(ph), [c.case_code, String(hours), paramSafe(area, 120)], {
          caseId: c.id,
          role: 'ops',
          urlButtonParam: c.id, // dashboard deep link #cases/{id}
        });
      }
      await logEvent(c.id, 'sla_nudge', 'scheduler', { hours, yes_count: yesCount ?? 0 });
      processed++;
      actions.push({ case: c.case_code, hours, yes_count: yesCount ?? 0 });
    } catch (e) {
      console.error(`sla_nudge ${c.case_code} failed:`, e);
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { job: 'sla_nudge', processed, actions };
}

/** Feedback: first invite ≥2h after completion, chases at +24h and +72h (max 2). */
async function jobFeedbackChaser(): Promise<JobResult> {
  const actions: unknown[] = [];
  const toggles = (await getSetting<Record<string, boolean>>('toggles')) ?? {};
  if (toggles.feedback_chaser === false) {
    return { job: 'feedback_chaser', processed: 0, actions: [{ skipped: 'toggle off' }] };
  }

  const { data, error } = await db
    .from('cases')
    .select(CASE_SELECT)
    .in('status', ['care_done', 'awaiting_payment', 'paid'])
    .not('completed_at', 'is', null)
    .lt('completed_at', new Date(Date.now() - 2 * HOUR).toISOString())
    .limit(BATCH);
  if (error) return { job: 'feedback_chaser', processed: 0, actions: [{ error: error.message }] };

  let processed = 0;
  for (const c of (data ?? []) as unknown as SchedCase[]) {
    try {
      const p = c.patients;
      if (!p) continue;
      const { data: fb } = await db.from('feedback').select('id').eq('case_id', c.id).limit(1);
      if ((fb ?? []).length > 0) continue;

      const inviteAt = await lastEventAt(c.id, 'feedback_invite_1');
      const token = `feedback_v1:${c.id}:${nonce8()}`;
      const lang = langOf(p.language_pref);

      if (!inviteAt) {
        const r = await sendTemplate(p.wa_number, 'feedback_invite', lang, [p.full_name], {
          caseId: c.id,
          role: 'patient',
          flowToken: token,
        });
        if (r.ok) {
          await logEvent(c.id, 'feedback_invite_1', 'scheduler', {});
          processed++;
          actions.push({ case: c.case_code, sent: 'invite' });
        } else {
          actions.push({ case: c.case_code, error: r.error });
        }
        continue;
      }

      const chases = await eventCount(c.id, 'feedback_chase');
      if (chases >= 2) continue;
      const sinceInvite = Date.now() - new Date(inviteAt).getTime();
      const due = (chases === 0 && sinceInvite > 24 * HOUR) || (chases === 1 && sinceInvite > 72 * HOUR);
      if (!due) continue;

      const r = await sendTemplate(p.wa_number, 'feedback_invite', lang, [p.full_name], {
        caseId: c.id,
        role: 'patient',
        flowToken: token,
      });
      if (r.ok) {
        await logEvent(c.id, 'feedback_chase', 'scheduler', { n: chases + 1 });
        processed++;
        actions.push({ case: c.case_code, sent: `chase_${chases + 1}` });
      } else {
        actions.push({ case: c.case_code, error: r.error });
      }
    } catch (e) {
      console.error(`feedback_chaser ${c.case_code} failed:`, e);
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { job: 'feedback_chaser', processed, actions };
}

/** Archive paid cases 7 days after completion; deactivate participants. */
async function jobArchiver(): Promise<JobResult> {
  const actions: unknown[] = [];
  const { data, error } = await db
    .from('cases')
    .select('id, case_code')
    .eq('status', 'paid')
    .not('completed_at', 'is', null)
    .lt('completed_at', new Date(Date.now() - 7 * 24 * HOUR).toISOString())
    .limit(BATCH);
  if (error) return { job: 'archiver', processed: 0, actions: [{ error: error.message }] };

  let processed = 0;
  for (const c of data ?? []) {
    try {
      await db.from('cases').update({ status: 'archived' }).eq('id', c.id).eq('status', 'paid');
      await db.from('case_participants').update({ active: false }).eq('case_id', c.id);
      await logEvent(c.id, 'case_archived', 'scheduler', {});
      processed++;
      actions.push({ case: c.case_code, archived: true });
    } catch (e) {
      console.error(`archiver ${c.case_code} failed:`, e);
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { job: 'archiver', processed, actions };
}

/** Availability handshake: auto-check inside the pre-session window (toggle) + timeout reaper (always). */
async function jobAvailability(): Promise<JobResult> {
  const auto = await autoAvailabilityChecks();
  const reap = await reapAvailabilityTimeouts();
  return {
    job: 'availability',
    processed: auto.processed + reap.processed,
    actions: [{ auto: auto.actions }, { reaped: reap.actions }],
  };
}

// ════════════════════════════════════════════════════════════════════════════
const JOBS: Record<string, () => Promise<JobResult>> = {
  reminders_24h: jobReminders24h,
  reminders_morning: jobRemindersMorning,
  otp_issue: jobOtpIssue,
  otp_expiry: jobOtpExpiry,
  sla_nudge: jobSlaNudge,
  feedback_chaser: jobFeedbackChaser,
  archiver: jobArchiver,
  availability: jobAvailability,
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) {
    return json({ ok: false, error: 'forbidden' }, 401);
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const job = String(body?.job ?? '');
  const fn = JOBS[job];
  if (!fn) return json({ ok: false, error: `unknown_job: ${job}`, known: Object.keys(JOBS) }, 400);

  try {
    const result = await fn();
    console.log(`scheduler ${job}: processed=${result.processed}`);
    return json({ ok: true, ...result });
  } catch (e) {
    console.error(`scheduler ${job} exception:`, e);
    return json({ ok: false, job, error: String(e) }, 500);
  }
});
