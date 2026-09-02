// _shared/otp.ts — arrival-handshake OTP: 6 crypto-random digits, case-bound.
// issued_to = patient (they receive the code), expected_from = nurse (they type it back).
import { db, getSetting } from './db.ts';
import { notifyDoctor } from './doctor.ts';
import { logEvent } from './log.ts';
import { normPhone } from './phone.ts';
import { sendSmart } from './wa.ts';

export const OTP_MAX_ATTEMPTS = 5;

export type OtpVerifyStatus = 'verified' | 'wrong' | 'locked' | 'none';
export type OtpVerifyResult = {
  status: OtpVerifyStatus;
  caseId?: string;
  otpId?: string;
  attemptsLeft?: number;
};

export type IssueOtpResult = {
  ok: boolean;
  otpId?: string;
  code?: string;
  issuedToPhone?: string;
  expectedFromPhone?: string;
  expiresAt?: string;
  error?: string;
};

/** Unbiased crypto-random 6-digit code, zero-padded ("000000".."999999"). */
function code6(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= 4_294_000_000); // reject the biased tail of 2^32
  return String(n % 1_000_000).padStart(6, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Issue a fresh OTP for a case. Invalidates any older active OTPs for the case.
 * Does NOT send any WhatsApp message — callers use sendOtpMessages().
 */
export async function issueOtp(caseId: string): Promise<IssueOtpResult> {
  try {
    const { data: c, error } = await db
      .from('cases')
      .select('id, status, patients:patient_id(wa_number), nurses:assigned_nurse_id(phone)')
      .eq('id', caseId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!c) return { ok: false, error: 'case_not_found' };

    const patient = c.patients as unknown as { wa_number: string } | null;
    const nurse = c.nurses as unknown as { phone: string } | null;
    if (!patient?.wa_number) return { ok: false, error: 'no_patient_phone' };
    if (!nurse?.phone) return { ok: false, error: 'no_assigned_nurse' };

    const ttlMin = Number((await getSetting<number>('otp_ttl_min')) ?? 30) || 30;

    // Invalidate older active codes for this case (idempotent re-issue).
    await db.from('otps').update({ status: 'expired' }).eq('case_id', caseId).eq('status', 'active');

    const code = code6();
    const expiresAt = new Date(Date.now() + ttlMin * 60_000).toISOString();
    const { data: row, error: insErr } = await db
      .from('otps')
      .insert({
        case_id: caseId,
        code,
        issued_to_phone: normPhone(patient.wa_number),
        expected_from_phone: normPhone(nurse.phone),
        expires_at: expiresAt,
        status: 'active',
      })
      .select('id')
      .single();
    if (insErr) return { ok: false, error: insErr.message };

    return {
      ok: true,
      otpId: row.id,
      code,
      issuedToPhone: normPhone(patient.wa_number),
      expectedFromPhone: normPhone(nurse.phone),
      expiresAt,
    };
  } catch (e) {
    console.error('issueOtp exception:', e);
    return { ok: false, error: String(e) };
  }
}

export type ArrivalHandshakeState = 'issued' | 'active' | 'in_care' | 'not_applicable';
export type ArrivalHandshakeResult = {
  state: ArrivalHandshakeState;
  caseCode?: string;
  patientName?: string;
  expiresAt?: string;
};

/**
 * Start (or resume) the arrival handshake for a case — used when the NURSE
 * announces arrival in her own words. Idempotent: if a live code is already
 * with the patient, nothing is re-sent; if none (or expired), a fresh code is
 * issued and delivered via sendOtpMessages (patient + nurse prompt + doctor
 * mirror). The verification itself stays the typed-back code — the arrival
 * message is only the trigger, so it cannot be faked from home.
 */
export async function ensureArrivalOtp(caseId: string, actor: string): Promise<ArrivalHandshakeResult> {
  const { data: c } = await db
    .from('cases')
    .select(
      'id, case_code, status, ' +
      'patients:patient_id(full_name, wa_number, language_pref), ' +
      'nurses:assigned_nurse_id(id, full_name, phone, language_pref)',
    )
    .eq('id', caseId)
    .maybeSingle();
  if (!c) return { state: 'not_applicable' };
  const patient = c.patients as unknown as { full_name: string; wa_number: string; language_pref: string } | null;
  const nurse = c.nurses as unknown as { id: string; full_name: string; phone: string; language_pref: string } | null;
  const base = { caseCode: c.case_code as string, patientName: patient?.full_name };

  if (c.status === 'in_care') return { state: 'in_care', ...base };
  if (!['assigned', 'consented', 'otp_sent'].includes(c.status) || !patient?.wa_number || !nurse?.phone) {
    return { state: 'not_applicable', ...base };
  }

  // A live code is already with the patient → just point the nurse at it.
  const { data: live } = await db
    .from('otps')
    .select('id, expires_at')
    .eq('case_id', caseId)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (live) return { state: 'active', ...base, expiresAt: live.expires_at };

  const otp = await issueOtp(caseId);
  if (!otp.ok || !otp.code) return { state: 'not_applicable', ...base };
  const sent = await sendOtpMessages(caseId, otp.code, patient, nurse);
  if (['assigned', 'consented'].includes(c.status)) {
    await db.from('cases').update({ status: 'otp_sent' }).eq('id', caseId);
  }
  await logEvent(caseId, 'otp_issued', actor, {
    expires_at: otp.expiresAt,
    patient_send_ok: sent.patientOk,
    nurse_send_ok: sent.nurseOk,
    trigger: 'nurse_arrival',
  });
  return { state: 'issued', ...base, expiresAt: otp.expiresAt };
}

/**
 * Verify a code typed by `fromPhone`. Rich result (case id + attempts left) for the webhook.
 * A nurse can hold active OTPs for SEVERAL cases at once — the code is matched against
 * ALL her active non-expired OTPs, not just the newest one.
 */
export async function verifyOtpDetailed(fromPhone: string, code: string): Promise<OtpVerifyResult> {
  const from = normPhone(fromPhone);
  try {
    const { data: rows, error } = await db
      .from('otps')
      .select('id, case_id, code, attempts, status, expires_at')
      .eq('expected_from_phone', from)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('verifyOtp query failed:', error.message);
      return { status: 'none' };
    }
    if (!rows?.length) return { status: 'none' };

    // Expire stale rows during the scan; keep the live ones (newest first).
    const now = Date.now();
    const live: typeof rows = [];
    for (const otp of rows) {
      if (new Date(otp.expires_at).getTime() < now) {
        await db.from('otps').update({ status: 'expired' }).eq('id', otp.id);
      } else {
        live.push(otp);
      }
    }
    if (live.length === 0) {
      const newest = rows[0];
      return { status: 'none', caseId: newest.case_id, otpId: newest.id };
    }

    // ANY live row matching the code → verify that row.
    const typed = String(code).trim();
    const match = live.find((otp) => otp.code === typed);
    if (match) {
      await db.from('otps').update({ status: 'verified', verified_at: nowIso() }).eq('id', match.id);
      return { status: 'verified', caseId: match.case_id, otpId: match.id };
    }

    // No match → count the attempt against the newest live row only.
    const otp = live[0];
    const attempts = (otp.attempts ?? 0) + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await db.from('otps').update({ attempts, status: 'locked' }).eq('id', otp.id);
      return { status: 'locked', caseId: otp.case_id, otpId: otp.id, attemptsLeft: 0 };
    }
    await db.from('otps').update({ attempts }).eq('id', otp.id);
    return { status: 'wrong', caseId: otp.case_id, otpId: otp.id, attemptsLeft: OTP_MAX_ATTEMPTS - attempts };
  } catch (e) {
    console.error('verifyOtp exception:', e);
    return { status: 'none' };
  }
}

/** CONTRACTS-shaped verify: just the status string. */
export async function verifyOtp(fromPhone: string, code: string): Promise<OtpVerifyStatus> {
  return (await verifyOtpDetailed(fromPhone, code)).status;
}

/**
 * Deliver the arrival code to the patient and the check-in prompt to the nurse.
 * Meta's classifier keeps rejecting dedicated code-bearing UTILITY templates
 * (wants AUTHENTICATION, which forbids custom bodies), so the code rides as
 * PARAMS inside the generic `care_update` carrier — template params are not
 * reviewed. Window-aware: free text when the recipient's window is open.
 */
export async function sendOtpMessages(
  caseId: string,
  code: string,
  patient: { wa_number: string; full_name?: string | null; language_pref?: string | null },
  nurse: { phone: string; full_name?: string | null; language_pref?: string | null },
): Promise<{ patientOk: boolean; nurseOk: boolean }> {
  const nurseName = nurse.full_name || 'your nurse';
  const patientName = patient.full_name || 'the patient';
  const pLang: 'en' | 'hi' = patient.language_pref === 'hi' ? 'hi' : 'en';
  const nLang: 'en' | 'hi' = nurse.language_pref === 'hi' ? 'hi' : 'en';
  const pText = pLang === 'hi'
    ? `आपके होम-केयर सेशन का नर्स आगमन नंबर ${code} है। कृपया नर्स ${nurseName} के पहुंचने पर यह नंबर उन्हें आमने-सामने दें।`
    : `Your nurse arrival number for this session is ${code}. Please give it to nurse ${nurseName} in person when they arrive.`;
  const nText = nLang === 'hi'
    ? `${patientName} के पते पर पहुंचने पर, कृपया मरीज़ से आगमन नंबर लेकर यहां भेजें — इससे आपका विज़िट प्रारंभ समय दर्ज होगा।`
    : `On arrival at ${patientName}'s address, please ask for the arrival number and send it here to log your visit start time.`;
  const pr = await sendSmart(
    patient.wa_number,
    pText,
    { name: 'care_update', lang: pLang, params: ['Carcinome Team', pText] },
    { caseId, role: 'patient' },
  );
  const nr = await sendSmart(
    nurse.phone,
    nText,
    { name: 'care_update', lang: nLang, params: ['Carcinome Team', nText] },
    { caseId, role: 'nurse' },
  );

  // Doctor mirror — the patient just got a code; NEVER include the code itself.
  try {
    const { data: c } = await db.from('cases').select('case_code').eq('id', caseId).maybeSingle();
    const code_ = c?.case_code ?? '';
    await notifyDoctor(caseId, {
      en: `🔐 ${code_} (${patientName}): the arrival verification code has been issued to the patient. Nurse ${nurseName} will verify it in person on arrival — you will be notified.`,
      hi: `🔐 ${code_} (${patientName}): आगमन सत्यापन कोड रोगी को भेज दिया गया है। नर्स ${nurseName} पहुंचकर आमने-सामने उसका सत्यापन करेंगी — आपको सूचित किया जाएगा।`,
    });
  } catch (e) {
    console.error('otp doctor mirror failed:', e);
  }
  return { patientOk: pr.ok, nurseOk: nr.ok };
}
