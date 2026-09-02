// wa-webhook/handlers/intent.ts — free-text ARRIVAL and SESSION-END intent.
//
// Arrival: the nurse announces in her own words ("Reached", "I have arrived",
// "pahunch gayi") — deliberately NOT a button, so it can't be pre-tapped from
// home. The announcement only TRIGGERS the handshake; proof of presence stays
// the 6-digit code that lives on the patient's phone.
//
// Ending: either the nurse or the patient can say the session is over in their
// own words ("done", "session over", "ho gaya"). Because a false positive here
// would fire the invoice pipeline, fuzzy matches always go through one
// confirmation button — only the exact DONE keyword (handled earlier in
// text.ts) skips it.
import { db } from '../../_shared/db.ts';
import { langFor, pick, type Lang } from '../../_shared/lang.ts';
import { logEvent } from '../../_shared/log.ts';
import { notifyDoctor } from '../../_shared/doctor.ts';
import { ensureArrivalOtp } from '../../_shared/otp.ts';
import { fanOut } from '../../_shared/relay.ts';
import { sendInteractiveButtons, sendList, sendText } from '../../_shared/wa.ts';
import {
  attachCase,
  mergeContext,
  notifyTeam,
  sendCompletionFlow,
  type InboundCtx,
} from './_common.ts';

// ─── Intent matchers ─────────────────────────────────────────────────────────
// Positive = words that state the thing HAS happened. Negative = future tense,
// negation, or en-route phrasing — any hit downgrades the message to plain
// relay chat. Long messages are narratives, not announcements.

const ARRIVAL_POSITIVE =
  /\b(reached|arrived|i'?m here|i am here|pahu?nch|poh[ao]?nch|aa\s?ga?y[ai]|aa\s?chuk[ai]|aagay[ai])\b/i;
const ARRIVAL_POSITIVE_DEV = /(पहुंच|पहुँच|आ गय|आ गई|आ चुक)/;
const ARRIVAL_NEGATIVE =
  /\b(will|'ll|gonna|about to|on (?:the |my )?way|omw|by \d|in \d+ ?(?:min|mins|minutes|hour|hours|hr|hrs)|not|nahi|nahin|kal|tomorrow|soon|late|der|nikal\w*|jaa?ung\w*|pahu?nch\w*ng\w*)\b/i;
const ARRIVAL_NEGATIVE_DEV = /(नहीं|कल|निकल|जाऊ|पहुंचूं|पहुँचूं)/;

export function matchesArrivalIntent(text: string): boolean {
  const s = String(text ?? '').trim();
  if (!s || s.split(/\s+/).length > 12) return false;
  if (ARRIVAL_NEGATIVE.test(s) || ARRIVAL_NEGATIVE_DEV.test(s)) return false;
  return ARRIVAL_POSITIVE.test(s) || ARRIVAL_POSITIVE_DEV.test(s);
}

const ENDING_POSITIVE =
  /\b(done|complete|completed|finished|finish|over|khat?am|khatm|ho\s?ga?ya|hogaya|hogya|ho\s?gai|poora|pura)\b/i;
const ENDING_POSITIVE_DEV = /(हो गया|हो गई|खत्म|ख़त्म|पूरा|समाप्त)/;
const ENDING_NEGATIVE =
  /\b(not|no|nahi|nahin|almost|about to|will|'ll|when|kab|kitn[ae]|baaki|remaining|left|start\w*|shuru)\b/i;
const ENDING_NEGATIVE_DEV = /(नहीं|कब|बाकी|शुरू)/;

export function matchesEndingIntent(text: string): boolean {
  const s = String(text ?? '').trim();
  if (!s || s.split(/\s+/).length > 15) return false;
  if (ENDING_NEGATIVE.test(s) || ENDING_NEGATIVE_DEV.test(s)) return false;
  return ENDING_POSITIVE.test(s) || ENDING_POSITIVE_DEV.test(s);
}

// ─── Arrival ─────────────────────────────────────────────────────────────────

type NurseRow = { id: string; full_name: string; language_pref: string };

/** Run the handshake for one case and talk the nurse through the next step. */
export async function runArrivalHandshake(
  ctx: InboundCtx,
  caseId: string,
  nurse: NurseRow,
): Promise<void> {
  const lang: Lang = nurse.language_pref === 'hi' ? 'hi' : 'en';
  const r = await ensureArrivalOtp(caseId, `nurse:${ctx.from}`);
  await attachCase(ctx.msgId, caseId, 'nurse');

  if (r.state === 'in_care') {
    await sendText(ctx.from, pick(lang, {
      en: `Your arrival for ${r.caseCode} is already verified and the session is running. Reply DONE when care is complete.`,
      hi: `${r.caseCode} के लिए आपका आगमन पहले ही सत्यापित है और सेशन जारी है। देखभाल पूरी होने पर DONE लिखें।`,
    }), { caseId, role: 'nurse' });
    return;
  }
  if (r.state === 'not_applicable') {
    await sendText(ctx.from, pick(lang, {
      en: `Thanks for the update — this case is not at the arrival step right now. Our team has been notified.`,
      hi: `अपडेट के लिए धन्यवाद — यह केस अभी आगमन चरण में नहीं है। हमारी टीम को सूचित कर दिया गया है।`,
    }), { caseId, role: 'nurse' });
    await notifyTeam(`⚠️ ${r.caseCode ?? caseId}: nurse ${nurse.full_name} announced arrival but the case is not at the arrival step. Please check.`, caseId);
    return;
  }

  await logEvent(caseId, 'nurse_arrival_claimed', `nurse:${ctx.from}`, { otp_state: r.state });

  if (r.state === 'active') {
    // Code already with the patient — sendOtpMessages was NOT re-run, so give
    // the nurse her prompt and mirror the moment to the doctor ourselves.
    await sendText(ctx.from, pick(lang, {
      en: `🙏 Welcome! Please ask ${r.patientName ?? 'the patient'}'s family for the 6-digit arrival number and type it here — that verifies your arrival and starts the session.`,
      hi: `🙏 स्वागत है! कृपया ${r.patientName ?? 'रोगी'} के परिवार से 6-अंकों का आगमन नंबर लेकर यहां भेजें — इससे आपका आगमन सत्यापित होगा और सेशन शुरू होगा।`,
    }), { caseId, role: 'nurse' });
    await notifyDoctor(caseId, {
      en: `🚪 ${r.caseCode} (${r.patientName ?? 'patient'}): nurse ${nurse.full_name} has reached the patient's home — arrival is being verified with the family's code.`,
      hi: `🚪 ${r.caseCode} (${r.patientName ?? 'रोगी'}): नर्स ${nurse.full_name} रोगी के घर पहुंच गई हैं — परिवार के कोड से आगमन सत्यापित किया जा रहा है।`,
    });
  }
  // state 'issued' → sendOtpMessages already delivered the patient code, the
  // nurse ask-the-family prompt, and the doctor mirror.

  await notifyTeam(
    `🚪 ${r.caseCode}: nurse ${nurse.full_name} says she has REACHED ${r.patientName ?? 'the patient'}'s home — awaiting code verification.`,
    caseId,
  );
}

/** Free-text arrival announcement. Returns true when handled. */
export async function onArrivalText(ctx: InboundCtx): Promise<boolean> {
  const { data: nurse } = await db
    .from('nurses')
    .select('id, full_name, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!nurse) return false; // not a nurse — relay as normal chat

  const { data: cases } = await db
    .from('cases')
    .select('id, case_code, status, patients:patient_id(full_name)')
    .eq('assigned_nurse_id', nurse.id)
    .in('status', ['assigned', 'consented', 'otp_sent', 'in_care'])
    .order('scheduled_at', { ascending: true })
    .limit(10);
  const rows = cases ?? [];
  const pre = rows.filter((r) => r.status !== 'in_care');

  if (pre.length === 0) {
    if (rows.length > 0) {
      // Only running sessions — she is already verified.
      const lang: Lang = nurse.language_pref === 'hi' ? 'hi' : 'en';
      await attachCase(ctx.msgId, rows[0].id, 'nurse');
      await sendText(ctx.from, pick(lang, {
        en: `Your arrival for ${rows[0].case_code} is already verified and the session is running. Reply DONE when care is complete.`,
        hi: `${rows[0].case_code} के लिए आपका आगमन पहले ही सत्यापित है और सेशन जारी है। देखभाल पूरी होने पर DONE लिखें।`,
      }), { caseId: rows[0].id, role: 'nurse' });
      return true;
    }
    return false; // no live case at all — relay / auto-reply path decides
  }

  if (pre.length > 1) {
    const lang: Lang = nurse.language_pref === 'hi' ? 'hi' : 'en';
    await sendList(
      ctx.from,
      pick(lang, {
        en: 'Welcome! Which patient have you reached?',
        hi: 'स्वागत है! आप किस रोगी के यहाँ पहुंची हैं?',
      }),
      pick(lang, { en: 'Choose patient', hi: 'रोगी चुनें' }),
      pre.slice(0, 10).map((r) => ({
        id: `arrived:${r.id}`,
        title: ((r.patients as unknown as { full_name: string } | null)?.full_name ?? r.case_code).slice(0, 24),
        description: r.case_code,
      })),
    );
    return true;
  }

  await runArrivalHandshake(ctx, pre[0].id, nurse);
  return true;
}

/** arrived:<case> tap from the case-picker list. */
export async function onArrivedButton(
  c: { id: string; case_code: string; assigned_nurse_id: string | null },
  ctx: InboundCtx,
): Promise<void> {
  const { data: nurse } = await db
    .from('nurses')
    .select('id, full_name, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!nurse || c.assigned_nurse_id !== nurse.id) {
    await sendText(ctx.from, 'This case has since been rearranged — please contact the care team. 🙏', {
      caseId: c.id,
    });
    return;
  }
  await runArrivalHandshake(ctx, c.id, nurse);
}

// ─── Session ending (nurse or patient, confirm-guarded) ──────────────────────

/** A parked ending-confirmation expires after 30 min. */
const DONE_CONFIRM_TTL_MS = 30 * 60_000;

type DoneConfirmStash = { case: string; role: 'nurse' | 'patient'; text: string; msgId?: number | null; at: string };

async function getDoneConfirmStash(phone: string): Promise<DoneConfirmStash | null> {
  const { data } = await db.from('conversation_state').select('context').eq('phone', phone).maybeSingle();
  const st = data?.context?.done_confirm as DoneConfirmStash | undefined;
  if (!st?.case) return null;
  if (st.at && Date.now() - new Date(st.at).getTime() > DONE_CONFIRM_TTL_MS) return null;
  return st;
}

/** Fuzzy ending phrase. Nurse branch wins on a doubled phone. Returns true when handled. */
export async function onEndingIntent(ctx: InboundCtx, text: string): Promise<boolean> {
  // Nurse of an in_care case?
  const { data: nurse } = await db
    .from('nurses')
    .select('id, full_name, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (nurse) {
    const { data: c } = await db
      .from('cases')
      .select('id, case_code, patients:patient_id(full_name)')
      .eq('assigned_nurse_id', nurse.id)
      .eq('status', 'in_care')
      .order('scheduled_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (c) {
      const lang: Lang = nurse.language_pref === 'hi' ? 'hi' : 'en';
      const patientName = (c.patients as unknown as { full_name: string } | null)?.full_name ?? 'the patient';
      await attachCase(ctx.msgId, c.id, 'nurse');
      await mergeContext(ctx.from, {
        done_confirm: { case: c.id, role: 'nurse', text, msgId: ctx.msgId, at: new Date().toISOString() },
      });
      await sendInteractiveButtons(
        ctx.from,
        pick(lang, {
          en: `Just to confirm — is today's care session for ${patientName} (${c.case_code}) fully complete? Tapping Yes opens the completion report; the bill and discharge summary follow from it.`,
          hi: `पुष्टि के लिए — क्या ${patientName} (${c.case_code}) का आज का देखभाल सेशन पूरी तरह समाप्त हो गया है? हाँ दबाने पर रिपोर्ट फ़ॉर्म खुलेगा; उसके बाद बिल और डिस्चार्ज सारांश भेजे जाएंगे।`,
        }),
        [
          { id: `care_done_yes:${c.id}`, title: pick(lang, { en: '✅ Yes, complete', hi: '✅ हाँ, पूरा हुआ' }) },
          { id: `care_done_no:${c.id}`, title: pick(lang, { en: 'Just a message', hi: 'सिर्फ़ संदेश' }) },
        ],
        { caseId: c.id, role: 'nurse' },
      );
      return true;
    }
  }

  // Patient (or family phone holding the patient role) of an in_care case?
  const { data: parts } = await db
    .from('case_participants')
    .select('case_id, display_name, cases!inner(id, case_code, status, nurses:assigned_nurse_id(full_name))')
    .eq('phone', ctx.from)
    .eq('role', 'patient')
    .eq('active', true)
    .eq('cases.status', 'in_care')
    .limit(1);
  const part = (parts ?? [])[0];
  if (part) {
    const c = part.cases as unknown as { id: string; case_code: string; nurses: { full_name: string } | null };
    const lang = await langFor(ctx.from);
    const nurseName = c.nurses?.full_name ?? 'the nurse';
    await attachCase(ctx.msgId, c.id, 'patient');
    await mergeContext(ctx.from, {
      done_confirm: { case: c.id, role: 'patient', text, msgId: ctx.msgId, at: new Date().toISOString() },
    });
    await sendInteractiveButtons(
      ctx.from,
      pick(lang, {
        en: `Has nurse ${nurseName} finished today's care session? If yes, we will ask her to submit the session report — your bill and discharge summary will follow here.`,
        hi: `क्या नर्स ${nurseName} ने आज का देखभाल सेशन पूरा कर लिया है? हाँ होने पर हम उनसे सेशन रिपोर्ट जमा करने को कहेंगे — आपका बिल और डिस्चार्ज सारांश यहीं आएगा।`,
      }),
      [
        { id: `patient_done_yes:${c.id}`, title: pick(lang, { en: '✅ Yes, finished', hi: '✅ हाँ, हो गया' }) },
        { id: `patient_done_no:${c.id}`, title: pick(lang, { en: 'Just a message', hi: 'सिर्फ़ संदेश' }) },
      ],
      { caseId: c.id, role: 'patient' },
    );
    return true;
  }

  return false;
}

/** Relay a stashed almost-ending message as the normal chat it turned out to be. */
async function relayStashed(ctx: InboundCtx, caseId: string, role: 'nurse' | 'patient', lang: Lang): Promise<void> {
  const stash = await getDoneConfirmStash(ctx.from);
  await mergeContext(ctx.from, { done_confirm: null });
  if (stash?.text && stash.case === caseId) {
    const { data: part } = await db
      .from('case_participants')
      .select('display_name')
      .eq('case_id', caseId)
      .eq('phone', ctx.from)
      .eq('role', role)
      .eq('active', true)
      .maybeSingle();
    await fanOut(caseId, ctx.from, part?.display_name || ctx.profileName || 'Participant', { text: stash.text }, stash.msgId ?? null);
    await sendText(ctx.from, pick(lang, {
      en: 'Okay — passed to the care team as a normal message. 🙏',
      hi: 'ठीक है — आपका संदेश केयर टीम तक पहुंचा दिया गया है। 🙏',
    }), { caseId, role });
  } else {
    await sendText(ctx.from, pick(lang, {
      en: 'Okay, nothing was marked complete. Please resend your message and it will reach the care team.',
      hi: 'ठीक है, कुछ भी पूर्ण चिह्नित नहीं हुआ। कृपया अपना संदेश दोबारा भेजें — वह केयर टीम तक पहुंच जाएगा।',
    }), { caseId, role });
  }
}

/** care_done_yes / care_done_no — the NURSE answered the confirmation. */
export async function onCareDoneConfirm(
  yes: boolean,
  c: { id: string; case_code: string; status: string; assigned_nurse_id: string | null },
  ctx: InboundCtx,
): Promise<void> {
  const { data: nurse } = await db
    .from('nurses')
    .select('id, full_name, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  const lang: Lang = nurse?.language_pref === 'hi' ? 'hi' : 'en';
  if (!nurse || c.assigned_nurse_id !== nurse.id) {
    await mergeContext(ctx.from, { done_confirm: null });
    await sendText(ctx.from, 'This case has since been rearranged — please contact the care team. 🙏', { caseId: c.id });
    return;
  }
  await attachCase(ctx.msgId, c.id, 'nurse');

  if (!yes) return await relayStashed(ctx, c.id, 'nurse', lang);

  await mergeContext(ctx.from, { done_confirm: null });
  if (c.status !== 'in_care') {
    await sendText(ctx.from, pick(lang, {
      en: `Case ${c.case_code} is not in an active session right now — nothing to complete. Our team can help if something looks off.`,
      hi: `केस ${c.case_code} में अभी कोई सक्रिय सेशन नहीं है। कुछ गड़बड़ लगे तो हमारी टीम मदद करेगी।`,
    }), { caseId: c.id, role: 'nurse' });
    return;
  }
  await logEvent(c.id, 'care_done_confirmed', `nurse:${ctx.from}`, { via: 'ending_intent' });
  await sendCompletionFlow(c, ctx.from, lang);
}

/** patient_done_yes / patient_done_no — the PATIENT answered the confirmation. */
export async function onPatientDoneConfirm(
  yes: boolean,
  c: {
    id: string;
    case_code: string;
    status: string;
    patients: { full_name: string } | null;
    nurses: { id: string; full_name: string; phone: string; language_pref: string } | null;
  },
  ctx: InboundCtx,
): Promise<void> {
  const lang = await langFor(ctx.from);
  await attachCase(ctx.msgId, c.id, 'patient');

  if (!yes) return await relayStashed(ctx, c.id, 'patient', lang);

  await mergeContext(ctx.from, { done_confirm: null });
  if (c.status !== 'in_care') {
    await sendText(ctx.from, pick(lang, {
      en: `Thank you! This session is already closed on our side — the remaining documents will arrive here shortly.`,
      hi: `धन्यवाद! यह सेशन हमारी ओर से पहले ही बंद हो चुका है — बाकी दस्तावेज़ जल्द ही यहां आ जाएंगे।`,
    }), { caseId: c.id, role: 'patient' });
    return;
  }

  const nurseName = c.nurses?.full_name ?? 'the nurse';
  await logEvent(c.id, 'patient_reported_done', `patient:${ctx.from}`);

  await sendText(ctx.from, pick(lang, {
    en: `Thank you! 🙏 We have asked nurse ${nurseName} to submit the session report. Your bill and discharge summary will arrive here once it is in.`,
    hi: `धन्यवाद! 🙏 हमने नर्स ${nurseName} से सेशन रिपोर्ट जमा करने को कहा है। रिपोर्ट आते ही आपका बिल और डिस्चार्ज सारांश यहीं आ जाएगा।`,
  }), { caseId: c.id, role: 'patient' });

  // Nudge the nurse: the family says it's done — the report is on her.
  if (c.nurses?.phone) {
    const nlang: Lang = c.nurses.language_pref === 'hi' ? 'hi' : 'en';
    await sendText(c.nurses.phone, pick(nlang, {
      en: `The family says today's session for ${c.patients?.full_name ?? 'the patient'} (${c.case_code}) is complete. Please fill the completion report so the bill and discharge summary can go out.`,
      hi: `परिवार के अनुसार ${c.patients?.full_name ?? 'रोगी'} (${c.case_code}) का आज का सेशन पूरा हो गया है। कृपया रिपोर्ट भर दें ताकि बिल और डिस्चार्ज सारांश भेजे जा सकें।`,
    }), { caseId: c.id, role: 'nurse' });
    await sendCompletionFlow(c, c.nurses.phone, nlang);
  }

  await notifyDoctor(c.id, {
    en: `🧑 ${c.case_code} (${c.patients?.full_name ?? 'patient'}): the patient reports today's session is complete. The completion report has been requested from nurse ${nurseName}; the discharge summary will follow.`,
    hi: `🧑 ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): रोगी के अनुसार आज का सेशन पूरा हो गया है। नर्स ${nurseName} से रिपोर्ट मांगी गई है; डिस्चार्ज सारांश इसके बाद आएगा।`,
  });
  await notifyTeam(
    `🧑 ${c.case_code}: PATIENT reports the session is complete — completion report requested from nurse ${nurseName}. Chase if it doesn't arrive.`,
    c.id,
  );
}
