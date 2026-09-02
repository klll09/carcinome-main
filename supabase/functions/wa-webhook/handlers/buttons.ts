// wa-webhook/handlers/buttons.ts — ONE dispatcher for all three button delivery shapes
// (template quick-reply payload / interactive button_reply.id / list_reply.id).
// Payload convention: "<action>:<case_uuid>".
import { db, getSetting } from '../../_shared/db.ts';
import { handleAvailabilityResponse } from '../../_shared/availability.ts';
import { notifyDoctor } from '../../_shared/doctor.ts';
import { langFor, pick, type Lang } from '../../_shared/lang.ts';
import { logEvent } from '../../_shared/log.ts';
import { fanOut, pickPreferredRole } from '../../_shared/relay.ts';
import { sendOrderDetails, sendPaidClaimButton, sendText } from '../../_shared/wa.ts';
import { onArrivedButton, onCareDoneConfirm, onPatientDoneConfirm } from './intent.ts';
import { applyNextChemo, NEXT_CHEMO_TTL_MS } from './text.ts';
import { chemoDateFromYmd } from '../../_shared/dates.ts';
import {
  attachCase,
  inr,
  mergeContext,
  notifyTeam,
  PENDING_TTL_MS,
  type PendingEntry,
  sendCompletionFlow,
  type InboundCtx,
} from './_common.ts';

const PAYLOAD_RE =
  /^([a-z_]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

type CaseRow = {
  id: string;
  case_code: string;
  status: string;
  care_type: string;
  scheduled_at: string;
  price_inr: number | null;
  assigned_nurse_id: string | null;
  patients: { id: string; full_name: string; wa_number: string; language_pref: string } | null;
  nurses: { id: string; full_name: string; phone: string; language_pref: string } | null;
  doctors: { id: string; full_name: string; phone: string; language_pref: string } | null;
};

async function loadCase(caseId: string): Promise<CaseRow | null> {
  const { data, error } = await db
    .from('cases')
    .select(
      'id, case_code, status, care_type, scheduled_at, price_inr, assigned_nurse_id, ' +
      'patients:patient_id(id, full_name, wa_number, language_pref), ' +
      'nurses:assigned_nurse_id(id, full_name, phone, language_pref), ' +
      'doctors:doctor_id(id, full_name, phone, language_pref)',
    )
    .eq('id', caseId)
    .maybeSingle();
  if (error) {
    console.error('loadCase failed:', error.message);
    return null;
  }
  return data as unknown as CaseRow | null;
}

export async function handleButton(payload: string, ctx: InboundCtx): Promise<void> {
  const m = String(payload ?? '').trim().match(PAYLOAD_RE);
  if (!m) {
    console.warn(`unrecognized button payload from ${ctx.from}: "${payload}"`);
    return;
  }
  const action = m[1].toLowerCase();
  const caseId = m[2].toLowerCase();

  const c = await loadCase(caseId);
  if (!c) {
    console.warn(`button ${action} for unknown case ${caseId}`);
    return;
  }
  await attachCase(ctx.msgId, caseId);

  try {
    switch (action) {
      case 'offer_yes':
      case 'offer_no':
        return await onOffer(action === 'offer_yes', c, ctx);
      case 'pay_show':
        return await onPayShow(c, ctx);
      case 'paid_claim':
        return await onPaidClaim(c, ctx);
      case 'complete_open':
        return await onCompleteOpen(c, ctx);
      case 'join_thread':
        return await onJoinThread(c, ctx);
      case 'relay_ctx':
        return await onRelayCtx(c, ctx);
      case 'avail_yes':
      case 'avail_no':
      case 'standby_yes':
      case 'standby_no':
        return await onAvailability(action.endsWith('_yes'), c, ctx);
      case 'chemo_date':
        return await onChemoDate(c, ctx);
      case 'arrived':
        return await onArrivedButton(c, ctx);
      case 'chemo_llm_yes':
      case 'chemo_llm_no':
        return await onChemoLlmConfirm(action === 'chemo_llm_yes', c, ctx);
      case 'care_done_yes':
      case 'care_done_no':
        return await onCareDoneConfirm(action === 'care_done_yes', c, ctx);
      case 'patient_done_yes':
      case 'patient_done_no':
        return await onPatientDoneConfirm(action === 'patient_done_yes', c, ctx);
      default:
        console.warn(`unknown button action "${action}" from ${ctx.from}`);
    }
  } catch (e) {
    console.error(`handleButton(${action}) exception:`, e);
  }
}

// ─── chemo_llm_yes / chemo_llm_no — confirm a Gemini-interpreted date ───────
// The LLM's guess is NEVER applied silently; this tap is the human sign-off.
async function onChemoLlmConfirm(yes: boolean, c: CaseRow, ctx: InboundCtx): Promise<void> {
  const { data: doctor } = await db
    .from('doctors')
    .select('id, full_name, phone, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!doctor) {
    await sendText(ctx.from, 'Only the referring doctor can set the chemo date for this case. 🙏', { caseId: c.id });
    return;
  }
  const lang = (doctor.language_pref === 'hi' ? 'hi' : 'en') as Lang;
  await attachCase(ctx.msgId, c.id, 'doctor');

  if (!yes) {
    await mergeContext(ctx.from, { next_chemo: { case: c.id, at: new Date().toISOString() } });
    await sendText(ctx.from, pick(lang, {
      en: 'Okay — please type the full date, for example: 24/07 or 24 July. Reply CANCEL to stop.',
      hi: 'ठीक है — कृपया पूरी तारीख लिखें, जैसे: 24/07 या 24 July। रोकने के लिए CANCEL लिखें।',
    }), { caseId: c.id, role: 'doctor' });
    return;
  }

  // The doctor tapping must be THIS case's doctor, the suggestion must be
  // inside its 30-min window, and the date is re-validated at TAP time (a
  // stale button can never set a past date).
  const caseDoctor = c.doctors as { id?: string } | null;
  if (caseDoctor?.id && caseDoctor.id !== doctor.id) {
    await sendText(ctx.from, 'Only the referring doctor of this case can set its chemo date. 🙏', { caseId: c.id });
    return;
  }
  const { data: cs } = await db.from('conversation_state').select('context').eq('phone', ctx.from).maybeSingle();
  const st = cs?.context?.next_chemo as { case?: string; at?: string; llm_ymd?: string } | undefined;
  const fresh = st?.case === c.id && (!st?.at || Date.now() - new Date(st.at).getTime() <= NEXT_CHEMO_TTL_MS);
  const parsed = fresh && st?.llm_ymd ? chemoDateFromYmd(st.llm_ymd) : null;
  if (!parsed) {
    await mergeContext(ctx.from, { next_chemo: null });
    await sendText(ctx.from, pick(lang, {
      en: 'That suggestion has expired — please reply NEXT <date> (e.g. NEXT 24/07) to set it.',
      hi: 'यह सुझाव समाप्त हो गया है — कृपया NEXT <तारीख> लिखें (जैसे NEXT 24/07)।',
    }), { caseId: c.id, role: 'doctor' });
    return;
  }
  await logEvent(c.id, 'llm_date_confirmed', `doctor:${ctx.from}`, { iso: parsed.iso });
  await applyNextChemo(ctx, c.id, doctor, parsed.iso);
}

// ─── offer_yes / offer_no ───────────────────────────────────────────────────

async function onOffer(yes: boolean, c: CaseRow, ctx: InboundCtx): Promise<void> {
  const { data: nurse } = await db
    .from('nurses')
    .select('id, full_name, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!nurse) {
    console.warn(`offer tap from non-nurse ${ctx.from} for ${c.case_code}`);
    return;
  }
  const lang = (nurse.language_pref === 'hi' ? 'hi' : 'en') as Lang;
  await attachCase(ctx.msgId, c.id, 'nurse');

  // Stale tap: case already left the offering stage.
  if (c.status !== 'offering') {
    if (yes && c.assigned_nurse_id === nurse.id) {
      await sendText(ctx.from, pick(lang, {
        en: `You are already assigned to case ${c.case_code}. Thank you! 🙏`,
        hi: `आप पहले से ही केस ${c.case_code} के लिए नियुक्त हैं। धन्यवाद! 🙏`,
      }), { caseId: c.id, role: 'nurse' });
    } else {
      await sendText(ctx.from, pick(lang, {
        en: `Thank you for responding — case ${c.case_code} has already been filled. We will reach out for the next one. 🙏`,
        hi: `जवाब देने के लिए धन्यवाद — केस ${c.case_code} पहले ही किसी अन्य नर्स को मिल चुका है। अगले केस के लिए हम आपसे ज़रूर संपर्क करेंगे। 🙏`,
      }), { caseId: c.id, role: 'nurse' });
    }
    await logEvent(c.id, 'offer_stale_tap', `nurse:${nurse.id}`, { yes });
    return;
  }

  const { data: rank, error } = await db.rpc('record_offer_response', {
    p_case: c.id,
    p_nurse: nurse.id,
    p_yes: yes,
  });
  if (error) {
    console.error('record_offer_response failed:', error.message);
    return;
  }

  if (yes) {
    await sendText(ctx.from, pick(lang, {
      en: `Thank you, ${nurse.full_name}! You are response #${rank ?? '?'} for case ${c.case_code}. Our team will confirm the assignment shortly.`,
      hi: `धन्यवाद, ${nurse.full_name}! केस ${c.case_code} के लिए आपकी प्रतिक्रिया #${rank ?? '?'} दर्ज हो गई है। हमारी टीम जल्द ही नियुक्ति की पुष्टि करेगी।`,
    }), { caseId: c.id, role: 'nurse' });
    await notifyTeam(
      `🩺 ${nurse.full_name} ACCEPTED ${c.case_code} (rank #${rank ?? '?'}). Assign from the dashboard.`,
      c.id,
    );
    await logEvent(c.id, 'offer_yes', `nurse:${nurse.id}`, { rank, nurse_name: nurse.full_name });
  } else {
    await sendText(ctx.from, pick(lang, {
      en: `Noted — thank you for letting us know. 🙏`,
      hi: `ठीक है — बताने के लिए धन्यवाद। 🙏`,
    }), { caseId: c.id, role: 'nurse' });
    await logEvent(c.id, 'offer_no', `nurse:${nurse.id}`, { nurse_name: nurse.full_name });
  }
}

// ─── pay_show ───────────────────────────────────────────────────────────────

async function onPayShow(c: CaseRow, ctx: InboundCtx): Promise<void> {
  const lang = await langFor(ctx.from);
  const { data: inv } = await db.from('invoices').select('*').eq('case_id', c.id).maybeSingle();
  await attachCase(ctx.msgId, c.id, 'patient');

  if (!inv) {
    await sendText(ctx.from, pick(lang, {
      en: `There is no invoice pending for case ${c.case_code}.`,
      hi: `केस ${c.case_code} के लिए कोई बकाया इनवॉइस नहीं है।`,
    }), { caseId: c.id, role: 'patient' });
    return;
  }
  if (inv.status === 'paid_verified') {
    await sendText(ctx.from, pick(lang, {
      en: `This invoice is already paid and confirmed. Thank you! 🙏`,
      hi: `इस इनवॉइस का भुगतान पहले ही मिल चुका है और पुष्टि हो चुकी है। धन्यवाद! 🙏`,
    }), { caseId: c.id, role: 'patient' });
    return;
  }
  if (inv.status === 'void') {
    await sendText(ctx.from, pick(lang, {
      en: `This invoice has been cancelled. Please contact our team if you have questions.`,
      hi: `यह इनवॉइस रद्द कर दिया गया है। किसी प्रश्न के लिए कृपया हमारी टीम से संपर्क करें।`,
    }), { caseId: c.id, role: 'patient' });
    return;
  }

  const upi = inv.upi_vpa ?? ((await getSetting<string>('upi_vpa')) ?? '');
  const business = (await getSetting<string>('business_name')) ?? 'Carcinome Home Care';
  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  const itemName = items[0]?.name ?? items[0]?.label ?? 'Home care service';
  const total = Number(inv.total_inr ?? 0);

  const r = await sendOrderDetails(ctx.from, {
    referenceId: inv.invoice_no,
    totalPaise: Math.round(total * 100),
    itemName,
    upiVpa: upi,
    businessName: business,
    bodyText: pick(lang, {
      en: `Invoice ${inv.invoice_no} for ${c.case_code} — total ${inr(total)}. Tap Review and Pay to pay via UPI. After paying, tap "I've paid".`,
      hi: `केस ${c.case_code} का इनवॉइस ${inv.invoice_no} — कुल ${inr(total)}। UPI से भुगतान के लिए Review and Pay दबाएँ। भुगतान के बाद "भुगतान हो गया" दबाएँ।`,
    }),
  }, { caseId: c.id, role: 'patient' });

  if (!r.ok) {
    // order_details can fail (payment config); fall back to plain UPI instructions.
    await sendText(ctx.from, pick(lang, {
      en: `Invoice ${inv.invoice_no} for ${c.case_code}: total ${inr(total)}.\nPlease pay via UPI to: ${upi}`,
      hi: `केस ${c.case_code} का इनवॉइस ${inv.invoice_no}: कुल ${inr(total)}।\nकृपया UPI से भुगतान करें: ${upi}`,
    }), { caseId: c.id, role: 'patient' });
  }
  // Either way the patient needs the claim button — it is what moves the
  // invoice to paid_claimed and pings the team to verify.
  await sendPaidClaimButton(ctx.from, c.id, lang);
  await logEvent(c.id, 'pay_show', 'patient', { invoice_no: inv.invoice_no, order_details_ok: r.ok });
}

// ─── paid_claim ─────────────────────────────────────────────────────────────

async function onPaidClaim(c: CaseRow, ctx: InboundCtx): Promise<void> {
  const lang = await langFor(ctx.from);
  await attachCase(ctx.msgId, c.id, 'patient');
  const { data: inv } = await db.from('invoices').select('*').eq('case_id', c.id).maybeSingle();
  if (!inv) {
    await sendText(ctx.from, pick(lang, {
      en: `We could not find an invoice for case ${c.case_code}. Our team will check and get back to you.`,
      hi: `केस ${c.case_code} के लिए इनवॉइस नहीं मिला। हमारी टीम जाँच कर आपसे संपर्क करेगी।`,
    }), { caseId: c.id, role: 'patient' });
    await notifyTeam(`⚠️ ${c.case_code}: patient tapped "I've paid" but no invoice row exists.`, c.id);
    return;
  }
  if (inv.status === 'paid_verified') {
    await sendText(ctx.from, pick(lang, {
      en: `Your payment is already confirmed. Thank you! 🙏`,
      hi: `आपके भुगतान की पुष्टि पहले ही हो चुकी है। धन्यवाद! 🙏`,
    }), { caseId: c.id, role: 'patient' });
    return;
  }

  const firstClaim = inv.status !== 'paid_claimed';
  await db
    .from('invoices')
    .update({ status: 'paid_claimed', paid_claimed_at: inv.paid_claimed_at ?? new Date().toISOString() })
    .eq('id', inv.id)
    .in('status', ['draft', 'sent', 'paid_claimed']);

  await sendText(ctx.from, pick(lang, {
    en: `Thank you! 🙏 We have noted your payment for invoice ${inv.invoice_no}. Our team will verify it and send you a confirmation shortly.`,
    hi: `धन्यवाद! 🙏 इनवॉइस ${inv.invoice_no} के लिए आपका भुगतान दर्ज कर लिया गया है। हमारी टीम जाँच करके जल्द ही आपको पुष्टि भेजेगी।`,
  }), { caseId: c.id, role: 'patient' });

  if (firstClaim) {
    await notifyTeam(
      `💰 ${c.case_code}: patient marked invoice ${inv.invoice_no} (${inr(Number(inv.total_inr ?? 0))}) as PAID. Verify against the bank/UPI app, then mark verified in the dashboard.`,
      c.id,
    );
    await notifyDoctor(c.id, {
      en: `💰 ${c.case_code} (${c.patients?.full_name ?? 'patient'}): the patient has marked the invoice (${inr(Number(inv.total_inr ?? 0))}) as paid. Our team is verifying it — you will get the confirmation.`,
      hi: `💰 ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): रोगी ने इनवॉइस (${inr(Number(inv.total_inr ?? 0))}) का भुगतान दर्ज किया है। हमारी टीम पुष्टि कर रही है — आपको सूचना मिलेगी।`,
    });
  }
  await logEvent(c.id, 'payment_claimed', 'patient', { invoice_no: inv.invoice_no });
}

// ─── complete_open ──────────────────────────────────────────────────────────

async function onCompleteOpen(c: CaseRow, ctx: InboundCtx): Promise<void> {
  const { data: nurse } = await db
    .from('nurses')
    .select('id, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  const lang = ((nurse?.language_pref ?? 'en') === 'hi' ? 'hi' : 'en') as Lang;
  await attachCase(ctx.msgId, c.id, 'nurse');

  if (!nurse || c.assigned_nurse_id !== nurse.id) {
    console.warn(`complete_open from non-assigned phone ${ctx.from} for ${c.case_code}`);
    return;
  }
  if (c.status === 'cancelled') {
    await sendText(ctx.from, pick(lang, {
      en: `This case was cancelled — no report is needed.`,
      hi: `यह केस रद्द कर दिया गया था — रिपोर्ट की आवश्यकता नहीं है।`,
    }), { caseId: c.id, role: 'nurse' });
    return;
  }
  if (['care_done', 'awaiting_payment', 'paid', 'archived'].includes(c.status)) {
    await sendText(ctx.from, pick(lang, {
      en: `The completion report for ${c.case_code} has already been received. Thank you!`,
      hi: `${c.case_code} की देखभाल रिपोर्ट पहले ही मिल चुकी है। धन्यवाद!`,
    }), { caseId: c.id, role: 'nurse' });
    return;
  }
  await sendCompletionFlow(c, ctx.from, lang);
}

// ─── availability handshake (avail_yes/no from the assigned nurse,
//     standby_yes/no from the pinged standby) ─────────────────────────────────

async function onAvailability(yes: boolean, c: CaseRow, ctx: InboundCtx): Promise<void> {
  const r = await handleAvailabilityResponse(ctx.from, yes, c.id);
  if (r.handled) {
    await attachCase(ctx.msgId, c.id, 'nurse');
    return;
  }
  // No pending check → stale tap (answered, timed out, or superseded).
  const lang = await langFor(ctx.from);
  await sendText(ctx.from, pick(lang, {
    en: `Thank you — this check for case ${c.case_code} was already answered or has expired.`,
    hi: `धन्यवाद — केस ${c.case_code} की यह पुष्टि पहले ही दर्ज हो चुकी है या समय समाप्त हो गया है।`,
  }), { caseId: c.id, role: 'nurse' });
  await logEvent(c.id, 'availability_stale_tap', `nurse:${ctx.from}`, { yes });
}

// ─── chemo_date — doctor taps "Set next chemo" → next message is the date ───

async function onChemoDate(c: CaseRow, ctx: InboundCtx): Promise<void> {
  const { data: doctor } = await db
    .from('doctors')
    .select('id, full_name, language_pref')
    .eq('phone', ctx.from)
    .maybeSingle();
  if (!doctor || c.doctors?.id !== doctor.id) {
    console.warn(`chemo_date tap from non-case-doctor ${ctx.from} for ${c.case_code}`);
    return;
  }
  await attachCase(ctx.msgId, c.id, 'doctor');
  const lang = (doctor.language_pref === 'hi' ? 'hi' : 'en') as Lang;
  await mergeContext(ctx.from, { next_chemo: { case: c.id, at: new Date().toISOString() } });
  await sendText(ctx.from, pick(lang, {
    en: `Please send the next chemo date for ${c.patients?.full_name ?? 'the patient'} (${c.case_code}). For example: 24/07, 24 Jul, or 24 Jul 2026. Reply CANCEL to stop.`,
    hi: `कृपया ${c.patients?.full_name ?? 'रोगी'} (${c.case_code}) की अगली कीमो की तारीख भेजें। उदाहरण: 24/07, 24 Jul, या 24 Jul 2026। रोकने के लिए CANCEL लिखें।`,
  }), { caseId: c.id, role: 'doctor' });
  await logEvent(c.id, 'next_chemo_prompted', `doctor:${ctx.from}`, {});
}

// ─── join_thread ────────────────────────────────────────────────────────────

async function onJoinThread(c: CaseRow, ctx: InboundCtx): Promise<void> {
  // A doubled phone can hold several participant rows — flip them ALL to full.
  const { data: parts } = await db
    .from('case_participants')
    .select('id, role, relay')
    .eq('case_id', c.id)
    .eq('phone', ctx.from)
    .eq('active', true);
  const part = pickPreferredRole(parts ?? []);
  if (!part) {
    console.warn(`join_thread from non-participant ${ctx.from} for ${c.case_code}`);
    return;
  }
  await attachCase(ctx.msgId, c.id, part.role);
  for (const row of parts ?? []) {
    if (row.relay !== 'full') {
      await db.from('case_participants').update({ relay: 'full' }).eq('id', row.id);
    }
  }
  const lang = await langFor(ctx.from);
  await sendText(ctx.from, pick(lang, {
    en: `You have joined the case conversation for ${c.case_code}. You will now receive all updates. Reply MUTE anytime to stop.`,
    hi: `आप केस ${c.case_code} के वार्तालाप से जुड़ गए हैं। अब आपको सभी अपडेट मिलेंगे। बंद करने के लिए कभी भी MUTE लिखें।`,
  }), { caseId: c.id, role: part.role });
  await logEvent(c.id, 'relay_joined', `${part.role}:${ctx.from}`, { via: 'join_thread' });
}

// ─── relay_ctx (release pending message to the chosen case) ────────────────

async function onRelayCtx(c: CaseRow, ctx: InboundCtx): Promise<void> {
  const { data: cs } = await db
    .from('conversation_state')
    .select('context')
    .eq('phone', ctx.from)
    .maybeSingle();

  // Collect ALL stashed messages: per-wamid context.pending map + legacy single-slot keys.
  const cutoff = Date.now() - PENDING_TTL_MS;
  const fresh = (e: { at?: string } | undefined) =>
    !!e && (!e.at || new Date(e.at).getTime() >= cutoff);

  const pendingMap = (cs?.context?.pending ?? {}) as Record<string, PendingEntry>;
  const entries: PendingEntry[] = Object.values(pendingMap).filter(fresh);
  entries.sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());

  // Backward compat: old pending_text / pending_media single slots.
  const pendText = cs?.context?.pending_text as
    | { text?: string; msgId?: number; at?: string }
    | undefined;
  const pendMedia = cs?.context?.pending_media as
    | { mediaId?: string; mediaType?: string; filename?: string; caption?: string; msgId?: number; at?: string }
    | undefined;
  if (pendText?.text && fresh(pendText)) {
    entries.push({ kind: 'text', text: pendText.text, msgId: pendText.msgId, at: pendText.at });
  }
  if (pendMedia?.mediaId) {
    if (fresh(pendMedia)) {
      entries.push({
        kind: 'media',
        media: {
          mediaId: pendMedia.mediaId,
          mediaType: pendMedia.mediaType,
          filename: pendMedia.filename,
          caption: pendMedia.caption,
        },
        msgId: pendMedia.msgId,
        at: pendMedia.at,
      });
    }
  }

  const { data: partRows } = await db
    .from('case_participants')
    .select('role, display_name')
    .eq('case_id', c.id)
    .eq('phone', ctx.from)
    .eq('active', true);
  const part = pickPreferredRole(partRows ?? []);
  const label = part?.display_name || ctx.profileName || 'Participant';

  if (entries.length === 0) {
    const lang = await langFor(ctx.from);
    await sendText(ctx.from, pick(lang, {
      en: `Nothing was pending — please send your message again and we will pass it on to the ${c.case_code} care team.`,
      hi: `कोई संदेश लंबित नहीं था — कृपया अपना संदेश दोबारा भेजें, हम उसे केस ${c.case_code} की केयर टीम तक पहुंचा देंगे।`,
    }), { caseId: c.id, role: part?.role });
    await mergeContext(ctx.from, { pending: null, pending_text: null, pending_media: null });
    return;
  }

  for (const e of entries) {
    await attachCase(e.msgId ?? null, c.id, part?.role);
    if (e.kind === 'text' && e.text) {
      await fanOut(c.id, ctx.from, label, { text: e.text }, e.msgId ?? null);
    } else if (e.kind === 'media' && e.media?.mediaId) {
      await fanOut(
        c.id,
        ctx.from,
        label,
        {
          mediaId: e.media.mediaId,
          mediaType: e.media.mediaType,
          filename: e.media.filename,
          caption: e.media.caption,
        },
        e.msgId ?? null,
      );
    }
  }

  await mergeContext(ctx.from, { pending: null, pending_text: null, pending_media: null });
  await db
    .from('conversation_state')
    .upsert(
      { phone: ctx.from, active_case_id: c.id, updated_at: new Date().toISOString() },
      { onConflict: 'phone' },
    );
}
