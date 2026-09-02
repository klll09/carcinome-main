// wa-webhook/handlers/text.ts — free-form inbound text:
// STOP/opt-out → MUTE (doctors) → 6-digit OTP verify → DONE (assigned nurse) →
// YES/NO (availability handshake) → arrival intent (nurse, free-text) →
// ending intent (nurse or patient, confirm-guarded) →
// NEXT (doctor sets next chemo date) → pending next-chemo date entry → relay.
import { db, getSetting } from '../../_shared/db.ts';
import { handleAvailabilityResponse, teamAlert } from '../../_shared/availability.ts';
import { chemoDateFromYmd, formatChemoDate, parseChemoDate } from '../../_shared/dates.ts';
import { buildCaseContext, interpretChemoDate, llmBudgetConsume, llmBudgetOk } from '../../_shared/llm.ts';
import { notifyDoctor, notifyPoc } from '../../_shared/doctor.ts';
import { buildStatusDigest } from '../../_shared/digest.ts';
import { langFor, pick, type Lang } from '../../_shared/lang.ts';
import { logEvent } from '../../_shared/log.ts';
import { verifyOtpDetailed } from '../../_shared/otp.ts';
import { paramSafe, sendInteractiveButtons, sendList, sendSmart, sendText } from '../../_shared/wa.ts';
import { matchesArrivalIntent, matchesEndingIntent, onArrivalText, onEndingIntent } from './intent.ts';
import {
  attachCase,
  istNow,
  mergeContext,
  notifyTeam,
  routeToRelay,
  sendCompletionFlow,
  type InboundCtx,
} from './_common.ts';

const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'OPT-OUT', 'OPT OUT']);
const STOP_WORDS_HI = new Set(['बंद', 'रोकें', 'रोके']);
const DONE_WORDS_HI = new Set(['पूर्ण']);
const YES_WORDS = new Set(['YES', 'Y', 'HAAN', 'HAN', 'HA']);
const YES_WORDS_HI = new Set(['हाँ', 'हां', 'हा']);
const NO_WORDS = new Set(['NO', 'N', 'NAHI', 'NAHIN']);
const NO_WORDS_HI = new Set(['नहीं', 'नही']);

/** A parked next-chemo prompt expires after 30 min so it can't eat relay chat forever. */
export const NEXT_CHEMO_TTL_MS = 30 * 60_000;

export async function handleText(ctx: InboundCtx, body: string): Promise<void> {
  const trimmed = String(body ?? '').trim();
  const upper = trimmed.toUpperCase();

  // ── 1. Opt-out ──────────────────────────────────────────────────────────
  if (STOP_WORDS.has(upper) || STOP_WORDS_HI.has(trimmed)) {
    return await onOptOut(ctx);
  }

  // ── 2. MUTE (doctors only) ──────────────────────────────────────────────
  if (upper === 'MUTE') {
    const handled = await onMute(ctx);
    if (handled) return;
    // Not a doctor → treat as a normal relay message.
  }

  // ── 2b. JOIN / UNMUTE — muted or milestones participant rejoins the thread
  if (upper === 'JOIN' || upper === 'UNMUTE') {
    const handled = await onJoin(ctx);
    if (handled) return;
    // No muted/milestones participation → treat as a normal relay message.
  }

  // ── 2c. STATUS — observers (POC interns, doctors) get a grouped digest of
  // all their patients: state, what we're waiting on, last milestone ────────
  if (upper === 'STATUS') {
    const digest = await buildStatusDigest(ctx.from);
    if (digest) {
      // They just messaged us, so the free-text path is essentially always
      // open; the template fallback still carries the digest's head.
      await sendSmart(
        ctx.from,
        digest,
        { name: 'care_update', lang: await langFor(ctx.from), params: ['Carcinome Team', paramSafe(digest, 240)] },
      );
      return;
    }
    // Observes nothing → treat as a normal message.
  }

  // ── 3. Six digits → OTP verify (falls through to relay on 'none') ───────
  if (/^\d{6}$/.test(trimmed)) {
    const handled = await onOtpAttempt(ctx, trimmed);
    if (handled) return;
    // 'none' → a 6-digit text could be a legitimate message; fall through.
  }

  // ── 4. DONE from the assigned nurse of an in_care case ──────────────────
  if (upper === 'DONE' || DONE_WORDS_HI.has(trimmed)) {
    const handled = await onDone(ctx);
    if (handled) return;
  }

  // ── 4b. YES/NO — availability handshake (only when this phone has a
  // pending check; anyone else's "yes" flows on into the relay) ────────────
  const isYes = YES_WORDS.has(upper) || YES_WORDS_HI.has(trimmed);
  const isNo = NO_WORDS.has(upper) || NO_WORDS_HI.has(trimmed);
  if (isYes || isNo) {
    const r = await handleAvailabilityResponse(ctx.from, isYes);
    if (r.handled) {
      if (r.caseId) await attachCase(ctx.msgId, r.caseId, 'nurse');
      return;
    }
  }

  // ── 4b2. Arrival announcement — the assigned nurse says she has reached,
  // in her own words. Triggers (or resumes) the code handshake; the typed-back
  // code remains the proof of presence.
  if (matchesArrivalIntent(trimmed)) {
    const handled = await onArrivalText(ctx);
    if (handled) return;
  }

  // ── 4b3. Session-ending announcement — nurse OR patient says it's over.
  // Fuzzy matches always go through one confirmation button (a false positive
  // would fire the invoice pipeline); exact DONE was already handled above.
  if (matchesEndingIntent(trimmed)) {
    const handled = await onEndingIntent(ctx, trimmed);
    if (handled) return;
  }

  // ── 4c. NEXT <date> — the referring doctor sets the next chemo date.
  // Guard against prose: "Next time please start earlier" must stay relay
  // chat. Only treat as a command when there is no argument, the argument
  // parses as a date, or it is short enough to be a garbled date attempt.
  const nextMatch = trimmed.match(/^next\b[:\-]?\s*(.*)$/i);
  if (nextMatch) {
    const rest = nextMatch[1].trim();
    const looksLikeCommand = !rest ||
      parseChemoDate(rest) !== null ||
      rest.split(/\s+/).filter(Boolean).length <= 3;
    if (looksLikeCommand) {
      const handled = await onNextChemoKeyword(ctx, rest);
      if (handled) return;
    }
  }

  // ── 4d. A next-chemo prompt is pending for this phone → parse as a date ─
  {
    const handled = await onNextChemoPending(ctx, trimmed, upper);
    if (handled) return;
  }

  // ── 5. Everything else → relay hub ──────────────────────────────────────
  await routeToRelay(ctx, { text: body });
}

// ─── Next chemo date (doctor) ────────────────────────────────────────────────

type DoctorRow = { id: string; full_name: string; phone: string; language_pref: string };

async function getNextChemoState(
  phone: string,
): Promise<{ caseId: string; at?: string } | null> {
  const { data } = await db
    .from('conversation_state')
    .select('context')
    .eq('phone', phone)
    .maybeSingle();
  const st = data?.context?.next_chemo as { case?: string; at?: string } | undefined;
  if (!st?.case) return null;
  if (st.at && Date.now() - new Date(st.at).getTime() > NEXT_CHEMO_TTL_MS) return null;
  return { caseId: st.case, at: st.at };
}

function dateExamples(lang: Lang): string {
  return pick(lang, {
    en: 'For example: 24/07, 24 Jul, or 24 Jul 2026. Reply CANCEL to stop.',
    hi: 'उदाहरण: 24/07, 24 Jul, या 24 Jul 2026। रोकने के लिए CANCEL लिखें।',
  });
}

/**
 * The strict parser failed — hand the doctor's raw text to Gemini with full
 * case context. High-confidence date → one confirm tap (never silently set);
 * anything else → the model's own clarifying question. Falls back to the
 * plain "could not read" reprompt when the LLM is unavailable.
 * Returns true when it sent something.
 */
async function llmChemoDateRescue(
  ctx: InboundCtx,
  caseId: string,
  doctor: DoctorRow,
  raw: string,
  lang: Lang,
  existingAt?: string,
): Promise<boolean> {
  try {
    if (!(await llmBudgetOk(ctx.from))) return false;
    const caseCtx = await buildCaseContext(caseId);
    const guess = await interpretChemoDate(raw, doctor.full_name, caseCtx);
    if (!guess) return false;
    await llmBudgetConsume(ctx.from);
    // The pending window is anchored to the ORIGINAL prompt time — a clarify
    // loop must not renew its own 30-min trap forever.
    const at = existingAt ?? new Date().toISOString();
    if (guess.confidence === 'high' && guess.date) {
      const parsed = chemoDateFromYmd(guess.date);
      if (parsed) {
        // Store the plain YYYY-MM-DD: the confirm tap re-validates it fresh
        // (not-past, <=370d) at TAP time, however stale the button is.
        await mergeContext(ctx.from, {
          next_chemo: { case: caseId, at, llm_ymd: guess.date },
        });
        await sendInteractiveButtons(
          ctx.from,
          pick(lang, {
            en: `Did you mean *${parsed.display}* for the next chemo? Tap to confirm, or send the date again (e.g. 24/07).`,
            hi: `क्या आपका मतलब अगली कीमो के लिए *${parsed.display}* है? पुष्टि के लिए दबाएँ, या तारीख दोबारा भेजें (जैसे 24/07)।`,
          }),
          [
            { id: `chemo_llm_yes:${caseId}`, title: pick(lang, { en: '✅ Yes, set it', hi: '✅ हाँ, यही तारीख' }) },
            { id: `chemo_llm_no:${caseId}`, title: pick(lang, { en: 'No, retype', hi: 'नहीं, दोबारा' }) },
          ],
          { caseId, role: 'doctor' },
        );
        await logEvent(caseId, 'llm_date_suggested', `doctor:${ctx.from}`, { raw, suggested: parsed.iso });
        return true;
      }
    }
    // Ambiguous → the model's own clarifying question (keeps the pending state).
    await mergeContext(ctx.from, { next_chemo: { case: caseId, at } });
    await sendText(
      ctx.from,
      `${pick(lang, { en: guess.clarify_en, hi: guess.clarify_hi })} ${pick(lang, { en: 'Reply CANCEL to stop.', hi: 'रोकने के लिए CANCEL लिखें।' })}`,
      { caseId, role: 'doctor' },
    );
    await logEvent(caseId, 'llm_date_clarify', `doctor:${ctx.from}`, { raw });
    return true;
  } catch (e) {
    console.error('llmChemoDateRescue failed:', e);
    return false;
  }
}

/** Apply a parsed date: store, confirm to doctor, announce to patient + team. */
export async function applyNextChemo(
  ctx: InboundCtx,
  caseId: string,
  doctor: DoctorRow,
  iso: string,
): Promise<void> {
  const display = formatChemoDate(iso);
  const { data: c } = await db
    .from('cases')
    .select('id, case_code, patients:patient_id(full_name, wa_number, language_pref)')
    .eq('id', caseId)
    .maybeSingle();
  if (!c) return;
  const patient = c.patients as unknown as { full_name: string; wa_number: string; language_pref: string } | null;
  const lang: Lang = doctor.language_pref === 'hi' ? 'hi' : 'en';

  await db
    .from('cases')
    .update({
      next_chemo_at: iso,
      next_chemo_set_by: `doctor:${ctx.from}`,
      next_chemo_set_at: new Date().toISOString(),
    })
    .eq('id', caseId);
  await logEvent(caseId, 'next_chemo_set', `doctor:${ctx.from}`, { date: iso, display });
  await attachCase(ctx.msgId, caseId, 'doctor');
  await mergeContext(ctx.from, { next_chemo: null });

  await sendSmart(
    ctx.from,
    pick(lang, {
      en: `✅ Next chemo for ${patient?.full_name ?? 'the patient'} (${c.case_code}) is set for ${display}. The patient and our team have been informed. Reply NEXT <date> anytime to change it.`,
      hi: `✅ ${patient?.full_name ?? 'रोगी'} (${c.case_code}) की अगली कीमो ${display} के लिए तय हो गई है। रोगी और हमारी टीम को सूचित कर दिया गया है। बदलने के लिए कभी भी NEXT <तारीख> लिखें।`,
    }),
    { name: 'care_update', lang, params: ['Carcinome Team', `Next chemo set for ${display}`] },
    { caseId, role: 'doctor' },
  );

  if (patient?.wa_number) {
    const plang: Lang = patient.language_pref === 'hi' ? 'hi' : 'en';
    await sendSmart(
      patient.wa_number,
      pick(plang, {
        en: `📅 Dr. ${doctor.full_name.replace(/^dr\.?\s+/i, '')} has scheduled your next chemotherapy for ${display}. Our team will contact you before the date to arrange the home-care session.`,
        hi: `📅 डॉ. ${doctor.full_name.replace(/^dr\.?\s+/i, '')} ने आपकी अगली कीमोथेरेपी ${display} के लिए निर्धारित की है। तारीख से पहले हमारी टीम होम-केयर सेशन की व्यवस्था के लिए आपसे संपर्क करेगी।`,
      }),
      { name: 'care_update', lang: plang, params: ['Carcinome Team', `Next chemo scheduled for ${display}`] },
      { caseId, role: 'patient' },
    );
  }

  await teamAlert(
    `📅 ${c.case_code}: Dr. ${doctor.full_name} set the next chemo date — ${display}. Register the follow-up case closer to the date.`,
    caseId,
  );
  await notifyPoc(caseId, `${c.case_code} (${patient?.full_name ?? 'patient'}): Dr. ${doctor.full_name} set the next chemo date — ${display}.`);
}

/** NEXT [date] typed by a doctor. Returns true when handled. */
async function onNextChemoKeyword(ctx: InboundCtx, rest: string): Promise<boolean> {
  const { data: doctor } = await db
    .from('doctors')
    .select('id, full_name, phone, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!doctor) return false; // not a doctor — flows on to the relay
  const lang: Lang = doctor.language_pref === 'hi' ? 'hi' : 'en';

  // Which case? A parked prompt wins; else this doctor's most recent case.
  let caseId = (await getNextChemoState(ctx.from))?.caseId ?? null;
  if (!caseId) {
    const { data: cases } = await db
      .from('cases')
      .select('id, case_code, status, updated_at, patients:patient_id(full_name)')
      .eq('doctor_id', doctor.id)
      .neq('status', 'cancelled')
      .order('updated_at', { ascending: false })
      .limit(10);
    const rows = cases ?? [];
    if (rows.length === 0) {
      await sendText(ctx.from, pick(lang, {
        en: 'We could not find an active case referred by you. Please contact the Carcinome team.',
        hi: 'आपके द्वारा रेफ़र किया गया कोई सक्रिय केस नहीं मिला। कृपया कार्सिनोम टीम से संपर्क करें।',
      }));
      return true;
    }
    const live = rows.filter((r) => r.status !== 'archived');
    const pool = live.length > 0 ? live : rows;
    if (pool.length > 1) {
      // Several patients — let the doctor pick; the button sets the pending
      // prompt, then the next message is parsed as the date.
      await sendList(
        ctx.from,
        pick(lang, {
          en: 'Which patient is this next chemo date for?',
          hi: 'यह अगली कीमो तारीख किस रोगी के लिए है?',
        }),
        pick(lang, { en: 'Choose patient', hi: 'रोगी चुनें' }),
        pool.slice(0, 10).map((r) => ({
          id: `chemo_date:${r.id}`,
          title: ((r.patients as unknown as { full_name: string } | null)?.full_name ?? r.case_code).slice(0, 24),
          description: r.case_code,
        })),
      );
      return true;
    }
    caseId = pool[0].id;
  }

  if (!rest) {
    await mergeContext(ctx.from, { next_chemo: { case: caseId, at: new Date().toISOString() } });
    await sendText(ctx.from, pick(lang, {
      en: `Please send the next chemo date. ${dateExamples(lang)}`,
      hi: `कृपया अगली कीमो की तारीख भेजें। ${dateExamples(lang)}`,
    }));
    return true;
  }

  const parsed = parseChemoDate(rest);
  if (!parsed) {
    if (await llmChemoDateRescue(ctx, caseId, doctor, rest, lang)) return true;
    await mergeContext(ctx.from, { next_chemo: { case: caseId, at: new Date().toISOString() } });
    await sendText(ctx.from, pick(lang, {
      en: `Sorry, we could not read that date. ${dateExamples(lang)}`,
      hi: `क्षमा करें, यह तारीख समझ नहीं आई। ${dateExamples(lang)}`,
    }));
    return true;
  }
  await applyNextChemo(ctx, caseId, doctor, parsed.iso);
  return true;
}

/** A pending next-chemo prompt exists → this message IS the date (or CANCEL). */
async function onNextChemoPending(ctx: InboundCtx, trimmed: string, upper: string): Promise<boolean> {
  const st = await getNextChemoState(ctx.from);
  if (!st) return false;
  const { data: doctor } = await db
    .from('doctors')
    .select('id, full_name, phone, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!doctor) {
    await mergeContext(ctx.from, { next_chemo: null });
    return false;
  }
  const lang: Lang = doctor.language_pref === 'hi' ? 'hi' : 'en';

  if (upper === 'CANCEL' || trimmed === 'रद्द') {
    await mergeContext(ctx.from, { next_chemo: null });
    await sendText(ctx.from, pick(lang, {
      en: 'Okay — no date was set. Reply NEXT <date> anytime.',
      hi: 'ठीक है — कोई तारीख तय नहीं हुई। कभी भी NEXT <तारीख> लिखें।',
    }));
    return true;
  }

  const parsed = parseChemoDate(trimmed);
  if (!parsed) {
    // Only treat SHORT texts as garbled date attempts. A pending prompt must
    // never swallow the doctor's normal messages ("patient tolerated well,
    // will confirm the date after reviewing counts") away from the relay.
    if (trimmed.split(/\s+/).filter(Boolean).length > 4) return false;
    if (await llmChemoDateRescue(ctx, st.caseId, doctor, trimmed, lang, st.at)) return true;
    await sendText(ctx.from, pick(lang, {
      en: `Sorry, we could not read that date. ${dateExamples(lang)}`,
      hi: `क्षमा करें, यह तारीख समझ नहीं आई। ${dateExamples(lang)}`,
    }));
    return true;
  }
  await applyNextChemo(ctx, st.caseId, doctor, parsed.iso);
  return true;
}

// ─── Opt-out ─────────────────────────────────────────────────────────────────

async function onOptOut(ctx: InboundCtx): Promise<void> {
  const lang = await langFor(ctx.from); // resolve language BEFORE flipping flags

  try {
    // Flip opted_out everywhere this phone appears.
    await db
      .from('patients')
      .update({ opted_out: true })
      .or(`wa_number.eq.${ctx.from},phone.eq.${ctx.from}`);
    for (const table of ['nurses', 'doctors', 'suppliers'] as const) {
      await db.from(table).update({ opted_out: true }).eq('phone', ctx.from);
    }

    // Deactivate their participant rows and log per affected case.
    const { data: parts, error } = await db
      .from('case_participants')
      .update({ active: false })
      .eq('phone', ctx.from)
      .eq('active', true)
      .select('case_id, role');
    if (error) console.error('opt-out participant deactivation failed:', error.message);
    for (const p of parts ?? []) {
      await logEvent(p.case_id, 'opted_out', `${p.role}:${ctx.from}`);
      await attachCase(ctx.msgId, p.case_id, p.role);
      // Doctor mirror: the referring doctor should know their patient left the loop.
      if (p.role === 'patient') {
        await notifyDoctor(p.case_id, {
          en: `⚠️ Your referred patient has opted out of WhatsApp updates for this case. Our team will follow up by phone.`,
          hi: `⚠️ आपके रेफ़र किए गए रोगी ने इस केस के WhatsApp अपडेट बंद कर दिए हैं। हमारी टीम फ़ोन से संपर्क करेगी।`,
        });
      }
    }
  } catch (e) {
    console.error('onOptOut exception:', e);
  }

  // They just messaged us → window open → plain text is deliverable.
  await sendText(
    ctx.from,
    pick(lang, {
      en: 'You have been unsubscribed and will not receive further messages from Carcinome Home Care. If this was a mistake or you need care again, please contact our team. 🙏',
      hi: 'आपका नंबर हमारी संदेश सूची से हटा दिया गया है — अब आपको कार्सिनोम होम केयर से संदेश नहीं आएंगे। यदि यह गलती से हुआ है या आपको फिर से देखभाल की ज़रूरत हो, तो कृपया हमारी टीम से संपर्क करें। 🙏',
    }),
  );
}

// ─── MUTE (doctors only) — returns true when handled ────────────────────────

async function onMute(ctx: InboundCtx): Promise<boolean> {
  const { data: doctor } = await db
    .from('doctors')
    .select('id, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!doctor) return false;

  const lang: Lang = doctor.language_pref === 'hi' ? 'hi' : 'en';
  // Role-scoped: on a doubled phone (nurse + doctor), MUTE silences only the
  // doctor participation — the nurse must keep receiving case traffic.
  const { data: parts, error } = await db
    .from('case_participants')
    .update({ relay: 'muted' })
    .eq('phone', ctx.from)
    .eq('role', 'doctor')
    .eq('active', true)
    .select('case_id');
  if (error) {
    console.error('MUTE update failed:', error.message);
    return false;
  }
  for (const p of parts ?? []) {
    await logEvent(p.case_id, 'relay_muted', `doctor:${ctx.from}`);
  }
  if (parts?.length) await attachCase(ctx.msgId, parts[0].case_id, 'doctor');

  await sendText(
    ctx.from,
    pick(lang, {
      en: 'Case updates are now muted. You will still receive discharge summaries for your referred patients. Reply JOIN at any time to resume case updates.',
      hi: 'केस अपडेट अब बंद कर दिए गए हैं। आपके रेफ़र किए गए रोगियों के डिस्चार्ज सारांश आपको मिलते रहेंगे। अपडेट दोबारा शुरू करने के लिए किसी भी समय JOIN लिखें।',
    }),
  );
  return true;
}

// ─── JOIN / UNMUTE — flips muted or milestones participations to full ───────

async function onJoin(ctx: InboundCtx): Promise<boolean> {
  const { data: parts, error } = await db
    .from('case_participants')
    .update({ relay: 'full' })
    .eq('phone', ctx.from)
    .eq('active', true)
    .in('relay', ['muted', 'milestones'])
    .select('case_id, role');
  if (error) {
    console.error('JOIN update failed:', error.message);
    return false;
  }
  if (!parts?.length) return false;

  for (const p of parts) {
    await logEvent(p.case_id, 'relay_joined', `${p.role}:${ctx.from}`, { via: 'join_keyword' });
  }
  await attachCase(ctx.msgId, parts[0].case_id, parts[0].role);

  const lang = await langFor(ctx.from);
  await sendText(
    ctx.from,
    pick(lang, {
      en: 'You have rejoined the case conversation and will now receive all updates. Reply MUTE to pause them again.',
      hi: 'आप केस वार्तालाप से दोबारा जुड़ गए हैं और अब सभी अपडेट प्राप्त करेंगे। दोबारा रोकने के लिए MUTE लिखें।',
    }),
  );
  return true;
}

// ─── OTP attempt — returns true when handled (false only for 'none') ────────

async function onOtpAttempt(ctx: InboundCtx, code: string): Promise<boolean> {
  const r = await verifyOtpDetailed(ctx.from, code);

  if (r.status === 'none') return false;

  const lang = await langFor(ctx.from);

  if (r.status === 'wrong') {
    await sendText(
      ctx.from,
      pick(lang, {
        en: `That arrival number is not correct. Please check with the patient's family and try again. Attempts left: ${r.attemptsLeft ?? '?'}.`,
        hi: `यह आगमन नंबर सही नहीं है। कृपया रोगी के परिवार से दोबारा पूछकर सही नंबर भेजें। शेष प्रयास: ${r.attemptsLeft ?? '?'}।`,
      }),
      { caseId: r.caseId, role: 'nurse' },
    );
    if (r.caseId) await attachCase(ctx.msgId, r.caseId, 'nurse');
    return true;
  }

  if (r.status === 'locked') {
    if (r.caseId) {
      await attachCase(ctx.msgId, r.caseId, 'nurse');
      const { data: c } = await db.from('cases').select('case_code').eq('id', r.caseId).maybeSingle();
      await notifyTeam(
        `🔒 OTP LOCKED on case ${c?.case_code ?? r.caseId}: nurse ${ctx.from} exhausted all attempts. Verify the situation and re-issue the code from the dashboard.`,
        r.caseId,
      );
      await logEvent(r.caseId, 'otp_locked', `nurse:${ctx.from}`);
    }
    await sendText(
      ctx.from,
      pick(lang, {
        en: 'Too many incorrect attempts — the arrival number is now locked. Our team has been alerted and will contact you shortly.',
        hi: 'बहुत अधिक गलत प्रयास — आगमन नंबर अब लॉक हो गया है। हमारी टीम को सूचित कर दिया गया है और वे जल्द ही आपसे संपर्क करेंगे।',
      }),
      { caseId: r.caseId, role: 'nurse' },
    );
    return true;
  }

  // verified
  if (!r.caseId) return true;
  await attachCase(ctx.msgId, r.caseId, 'nurse');

  const { data: c } = await db
    .from('cases')
    .select(
      'id, case_code, status, ' +
      'patients:patient_id(full_name, wa_number, language_pref), ' +
      'nurses:assigned_nurse_id(id, full_name, phone, language_pref), ' +
      'doctors:doctor_id(full_name, phone, language_pref)',
    )
    .eq('id', r.caseId)
    .maybeSingle<{ id: string; case_code: string; status: string; patients: unknown; nurses: unknown; doctors: unknown }>();

  await db
    .from('cases')
    .update({ status: 'in_care', arrival_verified_at: new Date().toISOString() })
    .eq('id', r.caseId);
  await logEvent(r.caseId, 'otp_verified', `nurse:${ctx.from}`);

  const patient = c?.patients as unknown as { full_name: string; wa_number: string; language_pref: string } | null;
  const nurse = c?.nurses as unknown as { id: string; full_name: string; phone: string; language_pref: string } | null;
  const doctor = c?.doctors as unknown as { full_name: string; phone: string; language_pref: string } | null;
  const nurseName = nurse?.full_name ?? 'your nurse';
  const when = istNow();
  const caseCode = c?.case_code ?? '';

  // Patient confirmation.
  if (patient?.wa_number) {
    const plang: Lang = patient.language_pref === 'hi' ? 'hi' : 'en';
    await sendSmart(
      patient.wa_number,
      pick(plang, {
        en: `✅ Nurse ${nurseName}'s arrival has been verified at ${when}. Your home-care session has started.`,
        hi: `✅ नर्स ${nurseName} का आगमन ${when} पर सत्यापित हो गया है। आपका होम-केयर सेशन शुरू हो गया है।`,
      }),
      { name: 'care_update', lang: plang, params: ['Carcinome Team', `Nurse ${nurseName} arrival verified at ${when}`] },
      { caseId: r.caseId, role: 'patient' },
    );
  }

  // Ops confirmation.
  const ops = ((await getSetting<string[]>('ops_phones')) ?? []).filter(Boolean);
  for (const ph of [...new Set(ops)]) {
    const olang = await langFor(ph);
    await sendSmart(
      ph,
      `✅ ${caseCode}: nurse ${nurseName} arrival verified at ${when}. Session started.`,
      { name: 'care_update', lang: olang, params: ['Carcinome System', `${caseCode}: arrival verified at ${when}`] },
      { caseId: r.caseId, role: 'ops' },
    );
  }

  // Doctor milestone (relay full/milestones, not muted). Role-scoped lookup —
  // the doctor's phone may hold several participant rows on a doubled phone.
  let doctorMirrored = false;
  if (doctor?.phone) {
    const { data: part } = await db
      .from('case_participants')
      .select('relay')
      .eq('case_id', r.caseId)
      .eq('phone', doctor.phone)
      .eq('role', 'doctor')
      .eq('active', true)
      .maybeSingle();
    if (part && part.relay !== 'muted') {
      const dlang: Lang = doctor.language_pref === 'hi' ? 'hi' : 'en';
      await sendSmart(
        doctor.phone,
        pick(dlang, {
          en: `🩺 ${caseCode} (${patient?.full_name ?? 'patient'}): nurse ${nurseName} has arrived — verified at ${when}. Session in progress.`,
          hi: `🩺 ${caseCode} (${patient?.full_name ?? 'रोगी'}): नर्स ${nurseName} का आगमन ${when} पर सत्यापित हो गया है। सेशन जारी है।`,
        }),
        { name: 'care_update', lang: dlang, params: ['Carcinome Team', `${caseCode}: nurse arrival verified at ${when}`] },
        { caseId: r.caseId, role: 'doctor' },
      );
      doctorMirrored = true;
    }
  }
  // POC log line — this milestone bypasses notifyDoctor, so hook it explicitly.
  await notifyPoc(
    r.caseId,
    `${caseCode} (${patient?.full_name ?? 'patient'}): nurse ${nurseName} arrival verified at ${when} — session started.`,
    { skipPhone: doctorMirrored ? doctor?.phone ?? null : null },
  );

  // Nurse: persistent completion action.
  const nlang: Lang = nurse?.language_pref === 'hi' ? 'hi' : 'en';
  await sendInteractiveButtons(
    ctx.from,
    pick(nlang, {
      en: `✅ Arrival verified — session for ${caseCode} has started. When care is complete, tap below or reply DONE.`,
      hi: `✅ आगमन सत्यापित — ${caseCode} का सेशन शुरू हो गया है। देखभाल पूरी होने पर नीचे दबाएं या DONE लिखें।`,
    }),
    [{
      id: `complete_open:${r.caseId}`,
      title: pick(nlang, { en: 'Mark care complete', hi: 'देखभाल पूरी हुई' }),
    }],
    { caseId: r.caseId, role: 'nurse' },
  );

  return true;
}

// ─── DONE — returns true when handled ────────────────────────────────────────

async function onDone(ctx: InboundCtx): Promise<boolean> {
  const { data: nurse } = await db
    .from('nurses')
    .select('id, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!nurse) return false;

  const { data: c } = await db
    .from('cases')
    .select('id, case_code')
    .eq('assigned_nurse_id', nurse.id)
    .eq('status', 'in_care')
    .order('scheduled_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!c) return false;

  await attachCase(ctx.msgId, c.id, 'nurse');
  const lang: Lang = nurse.language_pref === 'hi' ? 'hi' : 'en';
  await sendCompletionFlow(c, ctx.from, lang);
  return true;
}
