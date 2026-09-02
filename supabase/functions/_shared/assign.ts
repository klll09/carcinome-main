// _shared/assign.ts — nurse assignment/reassignment as a shared primitive.
// Extracted from admin-actions so the webhook can auto-reassign when a STANDBY
// nurse accepts (availability cascade) with byte-identical behavior to the
// dashboard path: participant swap, patient/doctor/nurse confirmations, old-
// nurse release, OTP re-issue, offer_closed fan-out, supplier re-ping, consent.
import { db, getSetting } from './db.ts';
import { langFor, pick, type Lang } from './lang.ts';
import { logEvent } from './log.ts';
import { notifyDoctor, notifyPoc } from './doctor.ts';
import { issueOtp, sendOtpMessages } from './otp.ts';
import { normPhone } from './phone.ts';
import { paramSafe, sendFlow, sendSmart, sendTemplate, type SendResult } from './wa.ts';

// ─── Small helpers shared with admin-actions ────────────────────────────────

export function nonce8(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function fmtIST(ts: string | Date | null | undefined): string {
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

const CARE_LABELS_FALLBACK: Record<string, string> = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemotherapy infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};
const LINE_LABELS_FALLBACK: Record<string, string> = {
  chemo_port: 'Chemo Port',
  picc: 'PICC Line',
  peripheral: 'Peripheral Line',
  other: 'Other',
};

export async function careLabel(careType: string): Promise<string> {
  const labels = (await getSetting<Record<string, string>>('care_type_labels')) ?? {};
  return labels[careType] ?? CARE_LABELS_FALLBACK[careType] ?? careType;
}
export async function lineLabel(lineType: string): Promise<string> {
  const labels = (await getSetting<Record<string, string>>('line_type_labels')) ?? {};
  return labels[lineType] ?? LINE_LABELS_FALLBACK[lineType] ?? lineType;
}

export function stripDr(name: string): string {
  return String(name ?? '').replace(/^dr\.?\s+/i, '').trim();
}

export async function isWindowOpen(phone: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('open_window', { p_phone: normPhone(phone) });
    if (error) {
      console.error('open_window rpc failed:', error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.error('open_window exception:', e);
    return false;
  }
}

const DEFAULT_SCREENS: Record<string, string> = {
  consent_v1: 'INFO',
  completion_v1: 'REPORT',
  feedback_v1: 'FEEDBACK',
};

export async function getFlowRef(name: string): Promise<{ id: string; screen: string } | null> {
  const ids = await getSetting<Record<string, unknown>>('flow_ids');
  const v = ids?.[name];
  if (!v) return null;
  if (typeof v === 'string') return { id: v, screen: DEFAULT_SCREENS[name] ?? 'START' };
  const obj = v as { id?: string; screen?: string };
  if (!obj.id) return null;
  return { id: obj.id, screen: obj.screen ?? DEFAULT_SCREENS[name] ?? 'START' };
}

// ─── Consent invite (assignment, dashboard resend, scheduler chaser) ────────

export type ConsentCase = {
  id: string;
  case_code: string;
  care_type: string;
  scheduled_at: string;
};

export async function sendConsentInvite(
  c: ConsentCase,
  patient: { full_name: string; wa_number: string; language_pref?: string | null },
  actor: string,
): Promise<SendResult> {
  const lang: Lang = patient.language_pref === 'hi' ? 'hi' : 'en';
  const token = `consent_v1:${c.id}:${nonce8()}`;
  const flow = await getFlowRef('consent_v1');
  const summary = `${c.case_code} • ${await careLabel(c.care_type)} • ${fmtIST(c.scheduled_at)}`;

  let r: SendResult;
  if (flow && (await isWindowOpen(patient.wa_number))) {
    r = await sendFlow(
      patient.wa_number,
      {
        flowId: flow.id,
        flowToken: token,
        cta: pick(lang, { en: 'Open consent form', hi: 'सहमति फ़ॉर्म खोलें' }),
        screen: flow.screen,
        data: { summary },
        bodyText: pick(lang, {
          en: `Hello ${patient.full_name}, before your home-care session (case ${c.case_code}) can begin we need your signed consent. Please review and submit the form below.`,
          hi: `नमस्ते ${patient.full_name}, आपके होम-केयर सेशन (केस ${c.case_code}) से पहले हमें आपकी हस्ताक्षरित सहमति चाहिए। कृपया नीचे दिया गया फ़ॉर्म पढ़कर जमा करें।`,
        }),
      },
      { caseId: c.id, role: 'patient' },
    );
  } else {
    r = await sendTemplate(
      patient.wa_number,
      'consent_flow_invite',
      lang,
      [patient.full_name, c.case_code],
      { caseId: c.id, role: 'patient', flowToken: token },
    );
  }
  await logEvent(c.id, 'consent_sent', actor, { via: r.via ?? 'flow', ok: r.ok });

  // Doctor mirror: the patient just received a form — tell the doctor too.
  await notifyDoctor(c.id, {
    en: `📋 ${c.case_code}: the consent form has been sent to ${patient.full_name} on WhatsApp. You will be notified when it is signed.`,
    hi: `📋 ${c.case_code}: सहमति फ़ॉर्म ${patient.full_name} को WhatsApp पर भेज दिया गया है। हस्ताक्षर होते ही आपको सूचित किया जाएगा।`,
  });
  return r;
}

// ─── The assignment primitive ───────────────────────────────────────────────

export type AssignCase = {
  id: string;
  case_code: string;
  status: string;
  care_type: string;
  line_type: string;
  scheduled_at: string;
  address: string;
  equipment_notes: string | null;
  price_inr: number | null;
  assigned_nurse_id: string | null;
  consented_at: string | null;
  patients: {
    id: string;
    full_name: string;
    wa_number: string;
    phone: string;
    locality: string | null;
    pincode: string | null;
    language_pref: string;
  } | null;
  doctors: { id: string; full_name: string; phone: string; language_pref: string } | null;
  nurses: { id: string; full_name: string; phone: string; language_pref: string } | null;
};

export async function loadAssignCase(caseId: string): Promise<AssignCase | null> {
  const { data, error } = await db
    .from('cases')
    .select(
      'id, case_code, status, care_type, line_type, scheduled_at, address, equipment_notes, price_inr, ' +
      'assigned_nurse_id, consented_at, ' +
      'patients:patient_id(id, full_name, wa_number, phone, locality, pincode, language_pref), ' +
      'doctors:doctor_id(id, full_name, phone, language_pref), ' +
      'nurses:assigned_nurse_id(id, full_name, phone, language_pref)',
    )
    .eq('id', caseId)
    .maybeSingle();
  if (error) {
    console.error('loadAssignCase failed:', error.message);
    return null;
  }
  return data as unknown as AssignCase | null;
}

function langOf(pref: string | null | undefined): Lang {
  return pref === 'hi' ? 'hi' : 'en';
}

/**
 * Supersede any pending availability checks on a case. Called on every
 * (re)assignment and on cancel/archive — a stale pending row would otherwise
 * be reaped as 'timeout' later and fire a PHANTOM standby cascade that can
 * steal the case from the correctly assigned nurse.
 */
export async function cancelPendingAvailabilityChecks(caseId: string, reason: string): Promise<void> {
  try {
    const { data, error } = await db
      .from('availability_checks')
      .update({ response: 'cancelled', responded_at: new Date().toISOString() })
      .eq('case_id', caseId)
      .eq('response', 'pending')
      .select('id, kind');
    if (error) {
      console.error('cancelPendingAvailabilityChecks failed:', error.message);
      return;
    }
    if ((data ?? []).length > 0) {
      await logEvent(caseId, 'availability_check_cancelled', 'system', {
        reason,
        cancelled: (data ?? []).map((r) => r.kind),
      });
    }
  } catch (e) {
    console.error('cancelPendingAvailabilityChecks exception:', e);
  }
}

export type AssignResult = {
  ok: boolean;
  error?: string;
  status?: number; // HTTP-ish status for admin-actions to pass through
  firstAssign?: boolean;
  nurseName?: string;
};

/**
 * Assign / reassign a nurse to a case, with the full notification fan-out.
 * `opts.background`: when provided (admin-actions), the sends run after the
 * response; the webhook path awaits them inline (it already runs in waitUntil).
 */
export async function performAssignment(
  caseId: string,
  nurseId: string,
  actor: string,
  opts: { isReassign: boolean; background?: (p: Promise<unknown>) => void },
): Promise<AssignResult> {
  const c = await loadAssignCase(caseId);
  if (!c) return { ok: false, error: 'case_not_found', status: 404 };
  if (!c.patients) return { ok: false, error: 'case_has_no_patient', status: 500 };
  if (['cancelled', 'archived'].includes(c.status)) {
    return { ok: false, error: `case is ${c.status}`, status: 400 };
  }

  const { data: nurse } = await db
    .from('nurses')
    .select('id, full_name, phone, language_pref, is_active')
    .eq('id', nurseId)
    .maybeSingle();
  if (!nurse) return { ok: false, error: 'nurse_not_found', status: 404 };
  if (!nurse.is_active) return { ok: false, error: 'nurse_inactive', status: 400 };

  const firstAssign = !c.assigned_nurse_id;
  if (!firstAssign && !opts.isReassign) {
    return { ok: false, error: 'already_assigned — use reassign_nurse', status: 400 };
  }
  if (c.assigned_nurse_id === nurse.id) {
    return { ok: false, error: 'nurse_already_assigned_to_case', status: 400 };
  }
  const oldNurse = c.nurses; // populated when reassigning

  // Status path: registration stages → 'assigned'; later stages keep their status on reassign.
  // Optimistic guard on the previously read assigned_nurse_id: two concurrent
  // assignments (dashboard + standby webhook) serialize — the loser gets a
  // conflict instead of silently clobbering the winner's fan-out.
  const patch: Record<string, unknown> = {
    assigned_nurse_id: nurse.id,
    assigned_at: new Date().toISOString(),
  };
  if (['registered', 'offering'].includes(c.status)) patch.status = 'assigned';
  let updQ = db.from('cases').update(patch).eq('id', c.id);
  updQ = c.assigned_nurse_id
    ? updQ.eq('assigned_nurse_id', c.assigned_nurse_id)
    : updQ.is('assigned_nurse_id', null);
  const { data: updRows, error: updErr } = await updQ.select('id');
  if (updErr) return { ok: false, error: `case_update_failed: ${updErr.message}`, status: 500 };
  if ((updRows ?? []).length === 0) {
    return { ok: false, error: 'assignment_conflict — the case was just assigned by someone else, refresh and retry', status: 409 };
  }

  // Any in-flight "are you going?" question is now moot.
  await cancelPendingAvailabilityChecks(c.id, opts.isReassign ? 'reassigned' : 'assigned');

  // Participant swap: retire the old nurse ROW (role-scoped — the same phone may
  // hold other roles on this case), upsert the new one.
  if (oldNurse && oldNurse.id !== nurse.id) {
    await db
      .from('case_participants')
      .update({ active: false })
      .eq('case_id', c.id)
      .eq('phone', normPhone(oldNurse.phone))
      .eq('role', 'nurse');
  }
  const { error: partErr } = await db.from('case_participants').upsert(
    {
      case_id: c.id,
      role: 'nurse',
      phone: normPhone(nurse.phone),
      display_name: `Nurse ${nurse.full_name}`,
      person_id: nurse.id,
      relay: 'full',
      active: true,
    },
    { onConflict: 'case_id,phone,role' },
  );
  if (partErr) console.error('nurse participant upsert failed:', partErr.message);

  await logEvent(c.id, opts.isReassign && !firstAssign ? 'nurse_reassigned' : 'nurse_assigned', actor, {
    nurse_id: nurse.id,
    nurse_name: nurse.full_name,
    previous_nurse: oldNurse?.full_name ?? null,
  });

  const schedFmt = fmtIST(c.scheduled_at);
  const careL = await careLabel(c.care_type);
  const lineL = await lineLabel(c.line_type);
  const p = c.patients;
  const doc = c.doctors;

  const sends = (async () => {
    // Nurse confirmation — FULL address (she is confirmed now).
    await sendTemplate(
      nurse.phone,
      'nurse_assigned_nurse',
      langOf(nurse.language_pref),
      [p.full_name, paramSafe(c.address, 250), schedFmt, careL, lineL],
      { caseId: c.id, role: 'nurse' },
    );
    // Arrival protocol: a typed announcement (never a pre-tappable button) —
    // presence is proven by the code on the patient's phone, not the message.
    {
      const nlang = langOf(nurse.language_pref);
      const arrivalTip = pick(nlang, {
        en: `📍 On the session day, when you REACH ${p.full_name}'s home, simply send a message here (for example: "Reached"). We will then verify your arrival with the 6-digit number the family has, and your session starts.`,
        hi: `📍 सेशन के दिन, जब आप ${p.full_name} के घर पहुंच जाएं, तो बस यहां एक संदेश भेज दें (जैसे: "Pahunch gayi")। फिर परिवार के पास मौजूद 6-अंकों के नंबर से आपका आगमन सत्यापित होगा और सेशन शुरू होगा।`,
      });
      await sendSmart(
        nurse.phone,
        arrivalTip,
        { name: 'care_update', lang: nlang, params: ['Carcinome Team', paramSafe(arrivalTip, 500)] },
        { caseId: c.id, role: 'nurse' },
      );
    }
    // Patient confirmation.
    await sendTemplate(p.wa_number, 'nurse_assigned_patient', langOf(p.language_pref), [nurse.full_name, schedFmt], {
      caseId: c.id,
      role: 'patient',
    });
    // Doctor confirmation.
    if (doc) {
      await sendTemplate(
        doc.phone,
        'nurse_assigned_doctor',
        langOf(doc.language_pref),
        [p.full_name, c.case_code, nurse.full_name, schedFmt],
        { caseId: c.id, role: 'doctor' },
      );
    }
    // POC log line (assignment is a template send to the doctor, not a
    // notifyDoctor mirror — so the POC needs its own hook here).
    await notifyPoc(
      c.id,
      `${c.case_code} (${p.full_name}): nurse ${nurse.full_name} ${opts.isReassign && oldNurse ? 'REASSIGNED' : 'assigned'} — session ${schedFmt}.`,
    );

    // Politely release the previous nurse (reassignment only).
    if (oldNurse && oldNurse.id !== nurse.id) {
      const ol = langOf(oldNurse.language_pref);
      await sendSmart(
        oldNurse.phone,
        pick(ol, {
          en: `Update on case ${c.case_code}: this session has been reassigned to another nurse. No further action is needed from you — thank you for your support. 🙏`,
          hi: `केस ${c.case_code} पर अपडेट: यह सेशन अब किसी अन्य नर्स को सौंपा गया है। आपको अब कुछ करने की आवश्यकता नहीं है — आपके सहयोग के लिए धन्यवाद। 🙏`,
        }),
        { name: 'offer_closed', lang: ol, params: [c.case_code] },
        { caseId: c.id, role: 'nurse' },
      );
    }

    // Any active OTP still points at the previous nurse — expire it; if the case
    // was already in otp_sent, re-issue and re-send to the patient + the NEW nurse.
    const { data: activeOtps } = await db
      .from('otps')
      .select('id')
      .eq('case_id', c.id)
      .eq('status', 'active');
    if ((activeOtps ?? []).length > 0) {
      await db.from('otps').update({ status: 'expired' }).eq('case_id', c.id).eq('status', 'active');
      if (c.status === 'otp_sent') {
        const otp = await issueOtp(c.id);
        if (otp.ok && otp.code) {
          const sent = await sendOtpMessages(c.id, otp.code, p, nurse);
          await logEvent(c.id, 'otp_issued', actor, {
            expires_at: otp.expiresAt,
            reissued_on_reassign: true,
            patient_send_ok: sent.patientOk,
            nurse_send_ok: sent.nurseOk,
          });
        } else {
          console.error('otp re-issue on reassign failed:', otp.error);
        }
      }
    }

    // offer_closed to the other yes/pending nurses — first assignment only.
    if (firstAssign) {
      const { data: offers } = await db
        .from('case_offers')
        .select('nurse_id, response, nurses:nurse_id(id, full_name, phone, language_pref)')
        .eq('case_id', c.id)
        .in('response', ['yes', 'pending']);
      for (const o of offers ?? []) {
        const on = o.nurses as unknown as { id: string; phone: string; language_pref: string } | null;
        if (!on || on.id === nurse.id) continue;
        await sendTemplate(on.phone, 'offer_closed', langOf(on.language_pref), [c.case_code], {
          caseId: c.id,
          role: 'nurse',
        });
      }
    }

    // Supplier prep re-send with the confirmed nurse's name.
    const { data: supParts } = await db
      .from('case_participants')
      .select('phone, display_name')
      .eq('case_id', c.id)
      .eq('role', 'supplier')
      .eq('active', true);
    const requirements = paramSafe(c.equipment_notes || `Standard kit for ${careL}`, 200);
    for (const sp of supParts ?? []) {
      await sendTemplate(
        sp.phone,
        'supplier_equipment_prep',
        await langFor(sp.phone),
        [p.full_name, paramSafe(c.address, 200), requirements, schedFmt, nurse.full_name],
        { caseId: c.id, role: 'supplier' },
      );
    }

    // Consent — unless the patient already consented.
    if (!c.consented_at && !['consented', 'otp_sent', 'in_care', 'care_done', 'awaiting_payment', 'paid'].includes(c.status)) {
      await sendConsentInvite(
        { id: c.id, case_code: c.case_code, care_type: c.care_type, scheduled_at: c.scheduled_at },
        p,
        actor,
      );
    }
  })();

  if (opts.background) opts.background(sends);
  else await sends.catch((e) => console.error('performAssignment sends failed:', e));

  return { ok: true, firstAssign, nurseName: nurse.full_name };
}
