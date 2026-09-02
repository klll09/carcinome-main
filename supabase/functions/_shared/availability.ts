// _shared/availability.ts — the "are you going right now?" handshake.
// Primary check → assigned nurse taps Yes/No (or replies YES/NO). A No — or
// silence past the deadline — triggers the STANDBY cascade: the next ranked
// yes-offer nurse is pinged; her Yes auto-reassigns the case (performAssignment);
// her No/silence cascades to the next candidate; an empty pool escalates 🚨.
import { db, getSetting } from './db.ts';
import { langFor, pick, type Lang } from './lang.ts';
import { logEvent } from './log.ts';
import { notifyDoctor } from './doctor.ts';
import { careLabel, fmtIST, isWindowOpen, performAssignment } from './assign.ts';
import { normPhone } from './phone.ts';
import { paramSafe, sendInteractiveButtons, sendSmart, sendTemplate } from './wa.ts';

export type AvailSettings = { timeout_min: number; auto_check: boolean; check_before_min: number };

export async function availSettings(): Promise<AvailSettings> {
  const v = (await getSetting<Partial<AvailSettings>>('availability')) ?? {};
  return {
    timeout_min: Number(v.timeout_min ?? 20) || 20,
    auto_check: v.auto_check === true,
    check_before_min: Number(v.check_before_min ?? 120) || 120,
  };
}

export type AvailCheck = {
  id: string;
  case_id: string;
  nurse_id: string;
  nurse_phone: string;
  kind: 'primary' | 'standby';
  response: 'pending' | 'yes' | 'no' | 'timeout' | 'cancelled';
  sent_at: string;
  deadline_at: string;
};

type AvailCase = {
  id: string;
  case_code: string;
  status: string;
  care_type: string;
  scheduled_at: string;
  address: string;
  assigned_nurse_id: string | null;
  arrival_verified_at: string | null;
  patients: { id: string; full_name: string; wa_number: string; locality: string | null; pincode: string | null; language_pref: string } | null;
  nurses: { id: string; full_name: string; phone: string; language_pref: string; opted_out: boolean } | null;
};

async function loadAvailCase(caseId: string): Promise<AvailCase | null> {
  const { data, error } = await db
    .from('cases')
    .select(
      'id, case_code, status, care_type, scheduled_at, address, assigned_nurse_id, arrival_verified_at, ' +
      'patients:patient_id(id, full_name, wa_number, locality, pincode, language_pref), ' +
      'nurses:assigned_nurse_id(id, full_name, phone, language_pref, opted_out)',
    )
    .eq('id', caseId)
    .maybeSingle();
  if (error) {
    console.error('loadAvailCase failed:', error.message);
    return null;
  }
  return data as unknown as AvailCase | null;
}

function langOf(pref: string | null | undefined): Lang {
  return pref === 'hi' ? 'hi' : 'en';
}

function areaOf(c: AvailCase): string {
  const p = c.patients;
  if (p?.locality) return p.pincode ? `${p.locality}, ${p.pincode}` : p.locality;
  const parts = String(c.address ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join(', ');
  return parts[0] ?? 'the patient area';
}

/** Settings-driven team alert (supervisors + ops) — same shape as webhook notifyTeam. */
export async function teamAlert(text: string, caseId?: string): Promise<void> {
  try {
    const sup = (await getSetting<string[]>('supervisor_phones')) ?? [];
    const ops = (await getSetting<string[]>('ops_phones')) ?? [];
    const phones = [...new Set([...sup, ...ops].map(normPhone).filter(Boolean))];
    for (const ph of phones) {
      const lang = await langFor(ph);
      await sendSmart(
        ph,
        text,
        { name: 'care_update', lang, params: ['Carcinome System', paramSafe(text, 250)] },
        { caseId, role: 'ops' },
      );
    }
  } catch (e) {
    console.error('teamAlert failed:', e);
  }
}

// ─── The ask (buttons when the window is open, YES/NO template otherwise) ───

async function sendAvailabilityAsk(
  c: AvailCase,
  nurse: { full_name: string; phone: string; language_pref: string },
  kind: 'primary' | 'standby',
  timeoutMin: number,
): Promise<void> {
  const lang = langOf(nurse.language_pref);
  const schedFmt = fmtIST(c.scheduled_at);
  const careL = await careLabel(c.care_type);
  const area = areaOf(c);

  const body = kind === 'primary'
    ? pick(lang, {
      en: `Hello ${nurse.full_name} — quick check for case ${c.case_code} (${careL}, ${schedFmt}): are you available and going for this session? Please confirm within ${timeoutMin} minutes, otherwise our standby nurse will be contacted.`,
      hi: `नमस्ते ${nurse.full_name} — केस ${c.case_code} (${careL}, ${schedFmt}) के लिए एक छोटी पुष्टि: क्या आप इस सेशन के लिए उपलब्ध हैं और जा रही हैं? कृपया ${timeoutMin} मिनट में पुष्टि करें, अन्यथा स्टैंडबाय नर्स से संपर्क किया जाएगा।`,
    })
    : pick(lang, {
      en: `🚨 ${nurse.full_name}, case ${c.case_code} (${careL}, ${schedFmt}, ${area}) needs a nurse — the assigned nurse can no longer attend. Can you take this session? Please reply within ${timeoutMin} minutes.`,
      hi: `🚨 ${nurse.full_name}, केस ${c.case_code} (${careL}, ${schedFmt}, ${area}) के लिए नर्स की ज़रूरत है — नियुक्त नर्स अब नहीं जा पाएंगी। क्या आप यह सेशन ले सकती हैं? कृपया ${timeoutMin} मिनट में उत्तर दें।`,
    });

  const yesId = kind === 'primary' ? `avail_yes:${c.id}` : `standby_yes:${c.id}`;
  const noId = kind === 'primary' ? `avail_no:${c.id}` : `standby_no:${c.id}`;
  const yesTitle = kind === 'primary'
    ? pick(lang, { en: 'Yes, on my way', hi: 'हाँ, जा रही हूँ' })
    : pick(lang, { en: 'Yes, I can go', hi: 'हाँ, ले सकती हूँ' });
  const noTitle = kind === 'primary'
    ? pick(lang, { en: "No, can't go", hi: 'नहीं जा पाऊँगी' })
    : pick(lang, { en: "No, I can't", hi: 'नहीं ले सकती' });

  let sent = false;
  if (await isWindowOpen(nurse.phone)) {
    const r = await sendInteractiveButtons(
      nurse.phone,
      body,
      [{ id: yesId, title: yesTitle }, { id: noId, title: noTitle }],
      { caseId: c.id, role: 'nurse' },
    );
    sent = r.ok;
  }
  if (!sent) {
    // Closed window → the YES/NO instruction IS the reply mechanism: truncate
    // the body first, then append the instruction so it can never be cut off.
    const instruction = pick(lang, { en: 'Reply YES or NO.', hi: 'YES या NO लिखकर उत्तर दें।' });
    const ask = `${paramSafe(body, 250 - instruction.length - 1)} ${instruction}`;
    await sendTemplate(nurse.phone, 'care_update', lang, ['Carcinome Team', ask], {
      caseId: c.id,
      role: 'nurse',
    });
  }
}

// ─── Primary check ──────────────────────────────────────────────────────────

export async function startAvailabilityCheck(
  caseId: string,
  actor: string,
): Promise<{ ok: boolean; error?: string; resent?: boolean }> {
  const c = await loadAvailCase(caseId);
  if (!c) return { ok: false, error: 'case_not_found' };
  if (!c.nurses || !c.assigned_nurse_id) return { ok: false, error: 'no_assigned_nurse' };
  if (c.nurses.opted_out) return { ok: false, error: 'nurse_opted_out — reassign instead of asking' };
  if (c.arrival_verified_at) return { ok: false, error: 'nurse_already_arrived' };
  if (!['assigned', 'consented', 'otp_sent'].includes(c.status)) {
    return { ok: false, error: `case is ${c.status} — availability check not applicable` };
  }

  const { timeout_min } = await availSettings();
  const deadline = new Date(Date.now() + timeout_min * 60_000).toISOString();

  // A pending check for this case → refresh its deadline and resend (idempotent re-tap).
  const { data: pending } = await db
    .from('availability_checks')
    .select('id, kind, nurse_id, nurse_phone')
    .eq('case_id', c.id)
    .eq('response', 'pending')
    .order('sent_at', { ascending: false })
    .limit(1);
  if ((pending ?? []).length > 0) {
    const row = pending![0];
    if (row.kind !== 'primary' || row.nurse_id !== c.assigned_nurse_id) {
      // A standby ping (or a stale primary for a different nurse) is already
      // out — do not stack a second question or touch its deadline.
      return { ok: false, error: 'standby_ping_pending' };
    }
    await db
      .from('availability_checks')
      .update({ deadline_at: deadline, sent_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('response', 'pending');
    await sendAvailabilityAsk(c, c.nurses, 'primary', timeout_min);
    await logEvent(c.id, 'availability_check_sent', actor, { resent: true, nurse: c.nurses.full_name });
    return { ok: true, resent: true };
  }

  const { error } = await db.from('availability_checks').insert({
    case_id: c.id,
    nurse_id: c.assigned_nurse_id,
    nurse_phone: normPhone(c.nurses.phone),
    kind: 'primary',
    deadline_at: deadline,
    created_by: actor,
  });
  if (error) {
    // 23505 = lost a race against a concurrent check (partial unique index:
    // one pending per case). The other invocation owns the send.
    if (error.code === '23505') return { ok: false, error: 'check_already_pending' };
    return { ok: false, error: error.message };
  }

  await sendAvailabilityAsk(c, c.nurses, 'primary', timeout_min);
  await logEvent(c.id, 'availability_check_sent', actor, {
    nurse: c.nurses.full_name,
    deadline_at: deadline,
  });
  return { ok: true };
}

// ─── Standby cascade ────────────────────────────────────────────────────────

export async function triggerStandby(caseId: string): Promise<{ ok: boolean; pinged?: string; exhausted?: boolean; error?: string }> {
  const c = await loadAvailCase(caseId);
  if (!c) return { ok: false, error: 'case_not_found' };
  if (c.arrival_verified_at || !['assigned', 'consented', 'otp_sent', 'registered', 'offering'].includes(c.status)) {
    return { ok: false, error: `case is ${c.status} — standby not applicable` };
  }

  // Never stack standby pings.
  const { data: pendingStandby } = await db
    .from('availability_checks')
    .select('id')
    .eq('case_id', c.id)
    .eq('kind', 'standby')
    .eq('response', 'pending')
    .limit(1);
  if ((pendingStandby ?? []).length > 0) return { ok: true, pinged: 'already_pending' };

  // Exclusions: current nurse, prior standby no/timeouts, day-one offer decliners.
  const excluded = new Set<string>();
  if (c.assigned_nurse_id) excluded.add(c.assigned_nurse_id);
  const { data: priorChecks } = await db
    .from('availability_checks')
    .select('nurse_id, kind, response')
    .eq('case_id', c.id);
  for (const r of priorChecks ?? []) {
    if (r.kind === 'standby' && ['no', 'timeout'].includes(r.response)) excluded.add(r.nurse_id);
    if (r.kind === 'primary' && ['no', 'timeout'].includes(r.response)) excluded.add(r.nurse_id);
  }

  const { data: offers } = await db
    .from('case_offers')
    .select('nurse_id, response, response_rank, nurses:nurse_id(id, full_name, phone, language_pref, is_active, is_eligible, opted_out)')
    .eq('case_id', c.id);
  const offerRows = (offers ?? []) as unknown as {
    nurse_id: string;
    response: string;
    response_rank: number | null;
    nurses: { id: string; full_name: string; phone: string; language_pref: string; is_active: boolean; is_eligible: boolean; opted_out: boolean } | null;
  }[];
  for (const o of offerRows) {
    if (o.response === 'no') excluded.add(o.nurse_id);
  }

  type Candidate = { id: string; full_name: string; phone: string; language_pref: string };
  const usable = (n: Candidate & { is_active: boolean; is_eligible: boolean; opted_out: boolean } | null | undefined) =>
    !!n && n.is_active && n.is_eligible && !n.opted_out && !excluded.has(n.id);

  // 1st preference: ranked yes-responders. Fallback: any eligible active nurse.
  let candidate: Candidate | null = null;
  let via = 'ranked_offer';
  const ranked = offerRows
    .filter((o) => o.response === 'yes' && usable(o.nurses as never))
    .sort((a, b) => (a.response_rank ?? 999) - (b.response_rank ?? 999));
  if (ranked.length > 0) candidate = ranked[0].nurses;
  if (!candidate) {
    via = 'eligible_pool';
    const { data: pool } = await db
      .from('nurses')
      .select('id, full_name, phone, language_pref, is_active, opted_out')
      .eq('is_eligible', true)
      .eq('is_active', true)
      .eq('opted_out', false)
      .order('created_at', { ascending: true });
    candidate = (pool ?? []).find((n) => usable(n as never)) ?? null;
  }

  if (!candidate) {
    await logEvent(c.id, 'standby_exhausted', 'system', {});
    await teamAlert(
      `🚨 ${c.case_code}: the assigned nurse is unavailable and NO standby nurse could be found. Assign a nurse manually from the dashboard NOW.`,
      c.id,
    );
    await notifyDoctor(c.id, {
      en: `⚠️ ${c.case_code} (${c.patients?.full_name ?? 'patient'}): the assigned nurse became unavailable. Our team is arranging a replacement and will confirm shortly.`,
      hi: `⚠️ ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): नियुक्त नर्स उपलब्ध नहीं हैं। हमारी टीम विकल्प की व्यवस्था कर रही है और जल्द पुष्टि करेगी।`,
    });
    return { ok: true, exhausted: true };
  }

  const { timeout_min } = await availSettings();
  const { error } = await db.from('availability_checks').insert({
    case_id: c.id,
    nurse_id: candidate.id,
    nurse_phone: normPhone(candidate.phone),
    kind: 'standby',
    deadline_at: new Date(Date.now() + timeout_min * 60_000).toISOString(),
    created_by: 'system',
  });
  if (error) {
    if (error.code === '23505') return { ok: true, pinged: 'already_pending' }; // concurrent cascade owns it
    return { ok: false, error: error.message };
  }

  await sendAvailabilityAsk(c, candidate, 'standby', timeout_min);
  await logEvent(c.id, 'standby_pinged', 'system', { nurse: candidate.full_name, via });
  await teamAlert(
    `⚠️ ${c.case_code}: nurse ${c.nurses?.full_name ?? '—'} is unavailable — standby ${candidate.full_name} has been pinged (${timeout_min} min to respond).`,
    c.id,
  );
  await notifyDoctor(c.id, {
    en: `⚠️ ${c.case_code} (${c.patients?.full_name ?? 'patient'}): the assigned nurse can no longer attend. A standby nurse is being confirmed — you will get the update shortly.`,
    hi: `⚠️ ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): नियुक्त नर्स अब नहीं आ पाएंगी। स्टैंडबाय नर्स की पुष्टि की जा रही है — आपको जल्द अपडेट मिलेगा।`,
  });
  return { ok: true, pinged: candidate.full_name };
}

// ─── Responses (buttons avail_/standby_ AND the YES/NO text path) ───────────

export async function findPendingCheckByPhone(phone: string): Promise<AvailCheck | null> {
  const { data } = await db
    .from('availability_checks')
    .select('*')
    .eq('nurse_phone', normPhone(phone))
    .eq('response', 'pending')
    .order('sent_at', { ascending: false })
    .limit(1);
  return (data?.[0] as AvailCheck | undefined) ?? null;
}

/** Race-safe resolve: only the first responder wins the pending row. */
async function resolveCheck(checkId: string, response: 'yes' | 'no' | 'timeout' | 'cancelled'): Promise<boolean> {
  const { data, error } = await db
    .from('availability_checks')
    .update({ response, responded_at: new Date().toISOString() })
    .eq('id', checkId)
    .eq('response', 'pending')
    .select('id');
  if (error) {
    console.error('resolveCheck failed:', error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

/**
 * Handle Yes/No from a nurse (button tap or YES/NO text).
 * caseId narrows the lookup (button payloads carry it); the text path passes null.
 * Returns handled=false when the phone has no pending check (caller falls through).
 */
export async function handleAvailabilityResponse(
  phone: string,
  yes: boolean,
  caseId?: string | null,
): Promise<{ handled: boolean; caseId?: string }> {
  const p = normPhone(phone);
  const lang = await langFor(p);
  let check: AvailCheck | null = null;
  if (caseId) {
    const { data } = await db
      .from('availability_checks')
      .select('*')
      .eq('case_id', caseId)
      .eq('nurse_phone', p)
      .eq('response', 'pending')
      .order('sent_at', { ascending: false })
      .limit(1);
    check = (data?.[0] as AvailCheck | undefined) ?? null;
  } else {
    // Bare YES/NO text — no case id attached. If this phone has pending checks
    // on SEVERAL cases, a bare word must NOT resolve an arbitrary one: ask
    // which case with explicit buttons (whose payloads carry the case id).
    const { data } = await db
      .from('availability_checks')
      .select('*')
      .eq('nurse_phone', p)
      .eq('response', 'pending')
      .order('sent_at', { ascending: false })
      .limit(3);
    const pendings = (data ?? []) as AvailCheck[];
    if (pendings.length > 1) {
      const codes = new Map<string, string>();
      for (const row of pendings) {
        const { data: cc } = await db.from('cases').select('case_code').eq('id', row.case_id).maybeSingle();
        codes.set(row.id, cc?.case_code ?? row.case_id.slice(0, 8));
      }
      await sendInteractiveButtons(
        p,
        pick(lang, {
          en: `You have more than one pending confirmation. Which case is this ${yes ? 'YES' : 'NO'} for? Tap below.`,
          hi: `आपकी एक से अधिक पुष्टियाँ लंबित हैं। यह ${yes ? 'YES' : 'NO'} किस केस के लिए है? नीचे दबाएँ।`,
        }),
        pendings.map((row) => ({
          id: `${row.kind === 'standby' ? 'standby' : 'avail'}_${yes ? 'yes' : 'no'}:${row.case_id}`,
          title: (codes.get(row.id) ?? 'Case').slice(0, 20),
        })),
      );
      return { handled: true };
    }
    check = pendings[0] ?? null;
  }
  if (!check) {
    // Courtesy: a YES/NO arriving just after the reaper timed the check out
    // should not silently become relay chatter.
    if (!caseId) {
      const { data: recent } = await db
        .from('availability_checks')
        .select('case_id, responded_at')
        .eq('nurse_phone', p)
        .eq('response', 'timeout')
        .gt('responded_at', new Date(Date.now() - 60 * 60_000).toISOString())
        .order('responded_at', { ascending: false })
        .limit(1);
      if ((recent ?? []).length > 0) {
        await sendSmart(
          p,
          pick(lang, {
            en: 'Thank you — the reply window for that check had already passed, so our team has been alerted and is arranging cover. Please contact the team if you can still attend.',
            hi: 'धन्यवाद — उस पुष्टि की समय-सीमा बीत चुकी थी, इसलिए हमारी टीम को सूचित कर दिया गया है और विकल्प की व्यवस्था हो रही है। यदि आप अब भी जा सकती हैं तो कृपया टीम से संपर्क करें।',
          }),
          { name: 'care_update', lang, params: ['Carcinome Team', 'Reply window had passed — team is arranging cover'] },
          { caseId: recent![0].case_id, role: 'nurse' },
        );
        return { handled: true, caseId: recent![0].case_id };
      }
    }
    return { handled: false };
  }

  const c = await loadAvailCase(check.case_id);
  if (!c) return { handled: true, caseId: check.case_id };

  // A primary check whose nurse is no longer the assigned nurse is STALE
  // (manual reassign raced the reply) — supersede it, never confirm/decline.
  if (check.kind === 'primary' && check.nurse_id !== c.assigned_nurse_id) {
    await resolveCheck(check.id, 'cancelled');
    await sendSmart(
      p,
      pick(lang, {
        en: `Thank you — case ${c.case_code} has since been rearranged, so no action is needed from you.`,
        hi: `धन्यवाद — केस ${c.case_code} की व्यवस्था बदल चुकी है, आपको कुछ करने की आवश्यकता नहीं है।`,
      }),
      { name: 'care_update', lang, params: ['Carcinome Team', `Case ${c.case_code} rearranged — no action needed`] },
      { caseId: c.id, role: 'nurse' },
    );
    return { handled: true, caseId: c.id };
  }

  const won = await resolveCheck(check.id, yes ? 'yes' : 'no');
  if (!won) {
    await sendSmart(
      p,
      pick(lang, {
        en: 'Thank you — your response was already recorded.',
        hi: 'धन्यवाद — आपका उत्तर पहले ही दर्ज हो चुका है।',
      }),
      { name: 'care_update', lang, params: ['Carcinome Team', 'Response already recorded'] },
      { caseId: check.case_id, role: 'nurse' },
    );
    return { handled: true, caseId: check.case_id };
  }
  const schedFmt = fmtIST(c.scheduled_at);

  if (check.kind === 'primary') {
    if (yes) {
      await logEvent(c.id, 'availability_confirmed', `nurse:${p}`, { nurse: c.nurses?.full_name });
      await sendSmart(
        p,
        pick(lang, {
          en: `🙏 Thank you! Confirmed — see you at the session (${schedFmt}).`,
          hi: `🙏 धन्यवाद! पुष्टि हो गई — सेशन (${schedFmt}) पर मिलते हैं।`,
        }),
        { name: 'care_update', lang, params: ['Carcinome Team', 'Availability confirmed — thank you'] },
        { caseId: c.id, role: 'nurse' },
      );
      if (c.patients?.wa_number) {
        const plang = langOf(c.patients.language_pref);
        await sendSmart(
          c.patients.wa_number,
          pick(plang, {
            en: `🩺 Nurse ${c.nurses?.full_name ?? ''} has confirmed for your home-care session (${schedFmt}).`,
            hi: `🩺 नर्स ${c.nurses?.full_name ?? ''} ने आपके होम-केयर सेशन (${schedFmt}) के लिए पुष्टि कर दी है।`,
          }),
          { name: 'care_update', lang: plang, params: ['Carcinome Team', `Nurse confirmed for ${schedFmt}`] },
          { caseId: c.id, role: 'patient' },
        );
      }
      await notifyDoctor(c.id, {
        en: `🩺 ${c.case_code} (${c.patients?.full_name ?? 'patient'}): nurse ${c.nurses?.full_name ?? ''} confirmed availability for the session at ${schedFmt}.`,
        hi: `🩺 ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): नर्स ${c.nurses?.full_name ?? ''} ने ${schedFmt} के सेशन के लिए उपलब्धता की पुष्टि की है।`,
      });
      await teamAlert(`✅ ${c.case_code}: nurse ${c.nurses?.full_name ?? p} confirmed availability.`, c.id);
    } else {
      await logEvent(c.id, 'availability_declined', `nurse:${p}`, { nurse: c.nurses?.full_name });
      await sendSmart(
        p,
        pick(lang, {
          en: 'Understood — thank you for telling us in time. We are arranging a replacement; no further action is needed from you. 🙏',
          hi: 'ठीक है — समय पर बताने के लिए धन्यवाद। हम विकल्प की व्यवस्था कर रहे हैं; आपको अब कुछ करने की आवश्यकता नहीं है। 🙏',
        }),
        { name: 'care_update', lang, params: ['Carcinome Team', 'Noted — arranging a replacement nurse'] },
        { caseId: c.id, role: 'nurse' },
      );
      await teamAlert(`❌ ${c.case_code}: nurse ${c.nurses?.full_name ?? p} can NOT attend — standby cascade starting.`, c.id);
      await triggerStandby(c.id);
    }
    return { handled: true, caseId: c.id };
  }

  // ── standby ──
  if (yes) {
    if (
      c.arrival_verified_at ||
      !['assigned', 'consented', 'otp_sent'].includes(c.status) ||
      c.assigned_nurse_id === check.nurse_id
    ) {
      await sendSmart(
        p,
        pick(lang, {
          en: `Thank you! Case ${c.case_code} is already covered — no action needed. We will reach out for the next one. 🙏`,
          hi: `धन्यवाद! केस ${c.case_code} की व्यवस्था हो चुकी है — कुछ करने की आवश्यकता नहीं। अगले केस के लिए हम संपर्क करेंगे। 🙏`,
        }),
        { name: 'care_update', lang, params: ['Carcinome Team', `Case ${c.case_code} already covered — thank you`] },
        { caseId: c.id, role: 'nurse' },
      );
      await logEvent(c.id, 'standby_accepted_late', `nurse:${p}`, {});
      return { handled: true, caseId: c.id };
    }

    // Quick ack FIRST so the detailed assignment template lands second.
    await sendSmart(
      p,
      pick(lang, {
        en: `✅ Thank you — you are being assigned to case ${c.case_code}. Full details and the address follow right away.`,
        hi: `✅ धन्यवाद — आपको केस ${c.case_code} सौंपा जा रहा है। पूरी जानकारी और पता तुरंत भेजा जा रहा है।`,
      }),
      { name: 'care_update', lang, params: ['Carcinome Team', `Assigning you to ${c.case_code} — details follow`] },
      { caseId: c.id, role: 'nurse' },
    );
    const r = await performAssignment(c.id, check.nurse_id, 'system:standby', { isReassign: true });
    if (r.ok) {
      await logEvent(c.id, 'standby_accepted', `nurse:${p}`, { nurse: r.nurseName });
      await teamAlert(
        `🔁 ${c.case_code}: standby ${r.nurseName} accepted and has been AUTO-REASSIGNED. Patient, doctor and supplier notified.`,
        c.id,
      );
    } else {
      console.error('standby auto-reassign failed:', r.error);
      await teamAlert(
        `⚠️ ${c.case_code}: standby accepted but auto-reassign FAILED (${r.error}). Reassign manually from the dashboard.`,
        c.id,
      );
    }
  } else {
    await logEvent(c.id, 'standby_declined', `nurse:${p}`, {});
    await sendSmart(
      p,
      pick(lang, {
        en: 'Noted — thank you for letting us know. 🙏',
        hi: 'ठीक है — बताने के लिए धन्यवाद। 🙏',
      }),
      { name: 'care_update', lang, params: ['Carcinome Team', 'Noted — thank you'] },
      { caseId: c.id, role: 'nurse' },
    );
    await triggerStandby(c.id);
  }
  return { handled: true, caseId: c.id };
}

// ─── Scheduler: timeout reaper + optional auto-check ────────────────────────

export async function reapAvailabilityTimeouts(): Promise<{ processed: number; actions: unknown[] }> {
  const actions: unknown[] = [];
  const { data: overdue, error } = await db
    .from('availability_checks')
    .select('*')
    .eq('response', 'pending')
    .lt('deadline_at', new Date().toISOString())
    .limit(50);
  if (error) return { processed: 0, actions: [{ error: error.message }] };

  let processed = 0;
  for (const row of (overdue ?? []) as AvailCheck[]) {
    try {
      // Validate BEFORE cascading: a check can go stale when the case was
      // cancelled/archived, care already started, or the nurse was manually
      // replaced mid-deadline — those must die silently as 'cancelled',
      // never fire a phantom standby cascade or a false team alarm.
      const c = await loadAvailCase(row.case_id);
      const applicable = !!c && !c.arrival_verified_at &&
        ['assigned', 'consented', 'otp_sent'].includes(c.status);
      const staleNurse = row.kind === 'primary' && c?.assigned_nurse_id !== row.nurse_id;
      if (!applicable || staleNurse) {
        const won = await resolveCheck(row.id, 'cancelled');
        if (won) {
          await logEvent(row.case_id, 'availability_check_cancelled', 'scheduler', {
            kind: row.kind,
            reason: !applicable ? `case_${c?.status ?? 'missing'}` : 'nurse_replaced',
          });
          actions.push({ case: c?.case_code ?? row.case_id, kind: row.kind, cancelled: true });
        }
        continue;
      }

      const won = await resolveCheck(row.id, 'timeout');
      if (!won) continue; // answered in the same instant
      processed++;
      const code = c!.case_code;
      await logEvent(row.case_id, 'availability_timeout', 'scheduler', { kind: row.kind, nurse_phone: row.nurse_phone });
      const t = await triggerStandby(row.case_id);
      const outcome = t.pinged && t.pinged !== 'already_pending'
        ? `standby ${t.pinged} pinged`
        : t.exhausted
        ? 'NO standby available — assign manually NOW'
        : 'cascade already in progress';
      await teamAlert(
        row.kind === 'primary'
          ? `⏱ ${code}: no availability reply from the assigned nurse — ${outcome}.`
          : `⏱ ${code}: standby nurse did not reply in time — ${outcome}.`,
        row.case_id,
      );
      actions.push({ case: code, kind: row.kind, standby: t.pinged ?? (t.exhausted ? 'EXHAUSTED' : t.error) });
    } catch (e) {
      console.error('reapAvailabilityTimeouts row failed:', e);
      actions.push({ check: row.id, error: String(e) });
    }
  }
  return { processed, actions };
}

export async function autoAvailabilityChecks(): Promise<{ processed: number; actions: unknown[] }> {
  const actions: unknown[] = [];
  const s = await availSettings();
  if (!s.auto_check) return { processed: 0, actions: [{ skipped: 'auto_check off' }] };

  const now = Date.now();
  const { data, error } = await db
    .from('cases')
    .select('id, case_code, scheduled_at')
    .in('status', ['assigned', 'consented', 'otp_sent'])
    .is('arrival_verified_at', null)
    .not('assigned_nurse_id', 'is', null)
    .gte('scheduled_at', new Date(now).toISOString())
    .lte('scheduled_at', new Date(now + s.check_before_min * 60_000).toISOString())
    .limit(50);
  if (error) return { processed: 0, actions: [{ error: error.message }] };

  let processed = 0;
  for (const c of data ?? []) {
    try {
      const { data: prior } = await db
        .from('availability_checks')
        .select('id')
        .eq('case_id', c.id)
        .limit(1);
      if ((prior ?? []).length > 0) continue; // asked already (manual or auto)
      const r = await startAvailabilityCheck(c.id, 'scheduler');
      if (r.ok) {
        processed++;
        actions.push({ case: c.case_code, sent: true });
      } else {
        actions.push({ case: c.case_code, error: r.error });
      }
    } catch (e) {
      actions.push({ case: c.case_code, error: String(e) });
    }
  }
  return { processed, actions };
}
