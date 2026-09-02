// wa-webhook/handlers/flows.ts — nfm_reply (WhatsApp Flows) submissions:
// consent_v1 (patient), completion_v1 (nurse → care_done pipeline), feedback_v1 (patient).
// flow_token = "<flow_name>:<case_uuid>:<nonce8>" (CONTRACTS §Flow token).
import { db, getSetting } from '../../_shared/db.ts';
import { notifyDoctor } from '../../_shared/doctor.ts';
import { langFor, pick, type Lang } from '../../_shared/lang.ts';
import { logEvent } from '../../_shared/log.ts';
import { normPhone } from '../../_shared/phone.ts';
import {
  sendInteractiveButtons,
  sendOrderDetails,
  sendPaidClaimButton,
  sendSmart,
  sendTemplate,
  sendText,
} from '../../_shared/wa.ts';
import { attachCase, inr, type InboundCtx } from './_common.ts';

const TOKEN_RE =
  /^([a-z0-9_]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-z0-9]+)$/i;

const CARE_LABELS_FALLBACK: Record<string, string> = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemo infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};

type FlowCase = {
  id: string;
  case_code: string;
  status: string;
  care_type: string;
  price_inr: number | null;
  assigned_nurse_id: string | null;
  patients: { id: string; full_name: string; wa_number: string; language_pref: string } | null;
  nurses: { id: string; full_name: string; phone: string; language_pref: string } | null;
  doctors: { id: string; full_name: string; phone: string; language_pref: string } | null;
};

async function loadCase(caseId: string): Promise<FlowCase | null> {
  const { data, error } = await db
    .from('cases')
    .select(
      'id, case_code, status, care_type, price_inr, assigned_nurse_id, ' +
      'patients:patient_id(id, full_name, wa_number, language_pref), ' +
      'nurses:assigned_nurse_id(id, full_name, phone, language_pref), ' +
      'doctors:doctor_id(id, full_name, phone, language_pref)',
    )
    .eq('id', caseId)
    .maybeSingle();
  if (error) {
    console.error('flows loadCase failed:', error.message);
    return null;
  }
  return data as unknown as FlowCase | null;
}

function langOf(pref: string | null | undefined): Lang {
  return pref === 'hi' ? 'hi' : 'en';
}

/** Flow form values may arrive as booleans or "true"/"false" strings — coerce. */
function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'True' || v === 1 || v === '1' || v === 'on';
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

async function opsPhones(): Promise<string[]> {
  const ops = (await getSetting<string[]>('ops_phones')) ?? [];
  return [...new Set(ops.map(normPhone).filter(Boolean))];
}

async function supervisorAndOpsPhones(): Promise<string[]> {
  const sup = (await getSetting<string[]>('supervisor_phones')) ?? [];
  const ops = (await getSetting<string[]>('ops_phones')) ?? [];
  return [...new Set([...sup, ...ops].map(normPhone).filter(Boolean))];
}

async function alertPhones(phones: string[], text: string, caseId: string): Promise<void> {
  for (const ph of phones) {
    try {
      const lang = await langFor(ph);
      await sendSmart(
        ph,
        text,
        { name: 'care_update', lang, params: ['Carcinome System', text] },
        { caseId, role: 'ops' },
      );
    } catch (e) {
      console.error(`alertPhones → ${ph} failed:`, e);
    }
  }
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

export async function handleFlowReply(
  ctx: InboundCtx,
  // deno-lint-ignore no-explicit-any
  nfmReply: any,
): Promise<void> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(nfmReply?.response_json ?? ''));
  } catch (e) {
    console.warn(`nfm_reply from ${ctx.from} has unparseable response_json:`, e);
    return;
  }

  const token = String(data?.flow_token ?? '');
  const m = token.match(TOKEN_RE);
  if (!m) {
    console.warn(`nfm_reply from ${ctx.from} has malformed flow_token: "${token}"`);
    return;
  }
  const flow = m[1].toLowerCase();
  const caseId = m[2].toLowerCase();

  const c = await loadCase(caseId);
  if (!c) {
    console.warn(`flow ${flow} reply for unknown case ${caseId} (from ${ctx.from})`);
    return;
  }
  await attachCase(ctx.msgId, c.id);

  try {
    switch (flow) {
      case 'consent_v1':
        return await onConsent(c, data, token, ctx);
      case 'completion_v1':
        return await onCompletion(c, data, ctx);
      case 'feedback_v1':
        return await onFeedback(c, data, ctx);
      default:
        console.warn(`unknown flow prefix "${flow}" in token from ${ctx.from}`);
    }
  } catch (e) {
    console.error(`handleFlowReply(${flow}) exception:`, e);
  }
}

// ─── consent_v1 ──────────────────────────────────────────────────────────────

async function onConsent(
  c: FlowCase,
  data: Record<string, unknown>,
  token: string,
  ctx: InboundCtx,
): Promise<void> {
  await attachCase(ctx.msgId, c.id, 'patient');
  const agreed = truthy(data.consent_care) && truthy(data.consent_data);
  const signedName = str(data.signed_name);

  const { error } = await db.from('consents').upsert(
    {
      case_id: c.id,
      patient_id: c.patients?.id ?? null,
      flow_token: token,
      agreed,
      signed_name: signedName,
      relationship: str(data.relationship),
      response: data,
    },
    { onConflict: 'case_id' },
  );
  if (error) console.error('consents upsert failed:', error.message);

  // Advance status only from assigned/otp_sent to avoid regressions; if the OTP
  // was already issued, keep otp_sent and just record the consent timestamp.
  const now = new Date().toISOString();
  if (agreed) {
    if (c.status === 'assigned') {
      await db.from('cases').update({ status: 'consented', consented_at: now }).eq('id', c.id);
    } else if (c.status === 'otp_sent') {
      await db.from('cases').update({ consented_at: now }).eq('id', c.id);
    }
  }

  const lang = await langFor(ctx.from);
  if (agreed) {
    await sendSmart(
      ctx.from,
      pick(lang, {
        en: `Thank you 🙏 Your consent for case ${c.case_code} has been recorded. Your home-care session will go ahead as scheduled.`,
        hi: `धन्यवाद 🙏 केस ${c.case_code} के लिए आपकी सहमति दर्ज हो गई है। आपका होम-केयर सेशन तय समय पर होगा।`,
      }),
      { name: 'care_update', lang, params: ['Carcinome Team', `Consent recorded for ${c.case_code}`] },
      { caseId: c.id, role: 'patient' },
    );
  } else {
    await sendSmart(
      ctx.from,
      pick(lang, {
        en: `We have received your form for case ${c.case_code}, but both consent boxes were not ticked, so consent is not yet complete. Our team will contact you to help.`,
        hi: `केस ${c.case_code} के लिए आपका फ़ॉर्म मिल गया है, लेकिन दोनों सहमति वाले बॉक्स टिक नहीं किए गए थे, इसलिए सहमति अभी पूरी नहीं हुई है। हमारी टीम मदद के लिए आपसे संपर्क करेगी।`,
      }),
      { name: 'care_update', lang, params: ['Carcinome Team', `Consent form incomplete for ${c.case_code}`] },
      { caseId: c.id, role: 'patient' },
    );
  }

  await logEvent(c.id, 'consented', 'patient', {
    agreed,
    signed_name: signedName,
    relationship: str(data.relationship),
  });

  await alertPhones(
    await opsPhones(),
    agreed
      ? `📝 ${c.case_code}: patient consent received (signed by ${signedName ?? 'patient'}).`
      : `⚠️ ${c.case_code}: consent form submitted WITHOUT full agreement — follow up with the patient.`,
    c.id,
  );

  // Doctor mirror — the consent moment, doctor-phrased.
  const rel = str(data.relationship);
  await notifyDoctor(
    c.id,
    agreed
      ? {
        en: `✍️ ${c.case_code} (${c.patients?.full_name ?? 'patient'}): the consent form has been signed by ${signedName ?? 'the patient'}${rel ? ` (${rel})` : ''}. Care can proceed as planned.`,
        hi: `✍️ ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): सहमति फ़ॉर्म पर ${signedName ?? 'रोगी'}${rel ? ` (${rel})` : ''} ने हस्ताक्षर कर दिए हैं। देखभाल योजना अनुसार आगे बढ़ेगी।`,
      }
      : {
        en: `⚠️ ${c.case_code} (${c.patients?.full_name ?? 'patient'}): the consent form came back WITHOUT full agreement. Our team is following up with the family.`,
        hi: `⚠️ ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): सहमति फ़ॉर्म पूर्ण सहमति के बिना आया है। हमारी टीम परिवार से संपर्क कर रही है।`,
      },
  );
}

// ─── completion_v1 (→ care_done pipeline) ───────────────────────────────────

async function onCompletion(
  c: FlowCase,
  data: Record<string, unknown>,
  ctx: InboundCtx,
): Promise<void> {
  await attachCase(ctx.msgId, c.id, 'nurse');
  const lang = await langFor(ctx.from);

  if (!['in_care', 'otp_sent', 'assigned', 'consented'].includes(c.status)) {
    await sendText(
      ctx.from,
      pick(lang, {
        en: `The completion report for ${c.case_code} has already been received or the case is closed. Thank you!`,
        hi: `${c.case_code} की देखभाल रिपोर्ट पहले ही मिल चुकी है या केस बंद हो चुका है। धन्यवाद!`,
      }),
      { caseId: c.id, role: 'nurse' },
    );
    return;
  }

  const { error } = await db.from('completion_reports').upsert(
    {
      case_id: c.id,
      nurse_id: c.assigned_nurse_id,
      meds_administered: str(data.meds_administered),
      started_hhmm: str(data.started_hhmm),
      ended_hhmm: str(data.ended_hhmm),
      complications: str(data.complications),
      complication_notes: str(data.complication_notes),
      notes: str(data.notes),
      response: data,
    },
    { onConflict: 'case_id' },
  );
  if (error) console.error('completion_reports upsert failed:', error.message);

  await db
    .from('cases')
    .update({ status: 'care_done', completed_at: new Date().toISOString() })
    .eq('id', c.id);
  await logEvent(c.id, 'care_completed', `nurse:${ctx.from}`, {
    complications: str(data.complications),
  });

  try {
    await careDonePipeline(c);
  } catch (e) {
    console.error(`careDonePipeline(${c.case_code}) exception:`, e);
  }

  await sendSmart(
    ctx.from,
    pick(lang, {
      en: `Thank you! 🙏 The completion report for ${c.case_code} has been recorded. The invoice and discharge summary are being sent to the patient. Great work.`,
      hi: `धन्यवाद! 🙏 ${c.case_code} की देखभाल रिपोर्ट दर्ज हो गई है। इनवॉइस और डिस्चार्ज सारांश रोगी को भेजे जा रहे हैं। बहुत अच्छा काम।`,
    }),
    { name: 'care_update', lang, params: ['Carcinome Team', `Completion report recorded for ${c.case_code}`] },
    { caseId: c.id, role: 'nurse' },
  );
}

// ─── docgen internal call (same convention as admin-actions) ────────────────

async function docgenCall(
  caseId: string,
  doc: 'invoice' | 'discharge',
): Promise<{ ok: boolean; path?: string; media_id?: string | null; error?: unknown }> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/docgen`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ case_id: caseId, doc }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    return { ok: true, path: body.path, media_id: body.media_id ?? null };
  } catch (e) {
    console.error(`docgenCall(${doc}) exception:`, e);
    return { ok: false, error: String(e) };
  }
}

// deno-lint-ignore no-explicit-any
type InvoiceRow = any;

async function careDonePipeline(c: FlowCase): Promise<void> {
  // 1. Invoice row (create if none).
  let inv: InvoiceRow = null;
  {
    const { data } = await db.from('invoices').select('*').eq('case_id', c.id).maybeSingle();
    inv = data ?? null;
  }
  if (!inv) {
    const labels = (await getSetting<Record<string, string>>('care_type_labels')) ?? CARE_LABELS_FALLBACK;
    const pricing = (await getSetting<Record<string, number>>('pricing')) ?? {};
    const amount = Number(c.price_inr ?? pricing[c.care_type] ?? 0);
    const itemName = labels[c.care_type] ?? CARE_LABELS_FALLBACK[c.care_type] ?? c.care_type;
    const upi = (await getSetting<string>('upi_vpa')) ?? null;
    const { data, error } = await db
      .from('invoices')
      .insert({
        case_id: c.id,
        line_items: [{ name: itemName, amount_inr: amount }],
        subtotal_inr: amount,
        total_inr: amount,
        upi_vpa: upi,
        status: 'draft',
      })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') {
        // Raced with another writer — re-read.
        const { data: again } = await db.from('invoices').select('*').eq('case_id', c.id).maybeSingle();
        inv = again ?? null;
      } else {
        console.error('invoice insert failed:', error.message);
      }
    } else {
      inv = data;
    }
  }
  if (!inv) {
    console.error(`careDonePipeline: no invoice row for ${c.case_code} — aborting sends`);
    return;
  }

  // 2. Generate both PDFs. The delivery templates carry REQUIRED document
  // headers — a send without the media id would be rejected by Graph, so a
  // docgen failure degrades to a text notice + ops alert instead.
  const invoiceGen = await docgenCall(c.id, 'invoice');
  const dischargeGen = await docgenCall(c.id, 'discharge');
  if (!invoiceGen.ok) console.error(`docgen invoice failed for ${c.case_code}:`, invoiceGen.error);
  if (!dischargeGen.ok) console.error(`docgen discharge failed for ${c.case_code}:`, dischargeGen.error);

  const p = c.patients;
  const total = Number(inv.total_inr ?? 0);
  const amountStr = total.toLocaleString('en-IN');

  // 3. invoice_delivery to patient (doc header + Pay now quick reply).
  if (p?.wa_number && invoiceGen.ok && invoiceGen.media_id) {
    await sendTemplate(
      p.wa_number,
      'invoice_delivery',
      langOf(p.language_pref),
      [inv.invoice_no, c.case_code, amountStr],
      {
        caseId: c.id,
        role: 'patient',
        // These templates are registered with a REQUIRED document header —
        // sending without it would be rejected by Graph. Callers below only
        // reach sendTemplate when the PDF media id exists.
        headerDocument: { id: invoiceGen.media_id!, filename: `Invoice-${inv.invoice_no}.pdf` },
        buttonPayloads: [`pay_show:${c.id}`],
      },
    );
  } else if (p?.wa_number) {
    // Docgen failed → the doc-header template cannot be sent at all. Tell the
    // patient the amount now (window is typically open right after the flow),
    // and alert ops to regenerate + resend from the dashboard.
    const lang = langOf(p.language_pref);
    await sendSmart(
      p.wa_number,
      pick(lang, {
        en: `Your home-care session for case ${c.case_code} is complete. Invoice ${inv.invoice_no} — total ${amountStr}. The invoice PDF will follow shortly.`,
        hi: `केस ${c.case_code} का आपका होम-केयर सेशन पूरा हो गया है। इनवॉइस ${inv.invoice_no} — कुल ${amountStr}। इनवॉइस PDF जल्द ही भेजा जाएगा।`,
      }),
      { name: 'care_update', lang, params: ['Carcinome Team', `Invoice ${inv.invoice_no} total ${amountStr} — PDF follows shortly`] },
      { caseId: c.id, role: 'patient' },
    );
    await alertPhones(
      await opsPhones(),
      `⚠️ ${c.case_code}: invoice PDF generation failed — use "Regenerate docs" then "Resend invoice" in the dashboard.`,
      c.id,
    );
  }

  // 4. discharge_summary_patient (doc-header template — only with a media id).
  if (p?.wa_number && dischargeGen.ok && dischargeGen.media_id) {
    await sendTemplate(
      p.wa_number,
      'discharge_summary_patient',
      langOf(p.language_pref),
      [p.full_name, c.case_code],
      {
        caseId: c.id,
        role: 'patient',
        headerDocument: { id: dischargeGen.media_id, filename: `Discharge-${c.case_code}.pdf` },
      },
    );
  }

  // 4b. Doctor mirror — care completed + invoice raised (the PDF follows below).
  await notifyDoctor(c.id, {
    en: `🧾 ${c.case_code} (${p?.full_name ?? 'patient'}): the home-care session is complete. Invoice ${inv.invoice_no} (${inr(total)}) has been sent to the patient; your discharge summary copy follows.`,
    hi: `🧾 ${c.case_code} (${p?.full_name ?? 'रोगी'}): होम-केयर सेशन पूरा हो गया है। इनवॉइस ${inv.invoice_no} (${inr(total)}) रोगी को भेज दिया गया है; आपकी डिस्चार्ज सारांश प्रति नीचे आ रही है।`,
  });

  // 5. discharge_summary_doctor (doc-header template — only with a media id).
  if (c.doctors?.phone && dischargeGen.ok && dischargeGen.media_id) {
    await sendTemplate(
      c.doctors.phone,
      'discharge_summary_doctor',
      langOf(c.doctors.language_pref),
      [c.doctors.full_name, p?.full_name ?? 'the patient', c.case_code],
      {
        caseId: c.id,
        role: 'doctor',
        headerDocument: { id: dischargeGen.media_id, filename: `Discharge-${c.case_code}.pdf` },
      },
    );
    // 5b. The doctor's next move: set the next chemo date (button when the
    // window is open; the NEXT keyword is always available).
    try {
      const { data: open } = await db.rpc('open_window', { p_phone: normPhone(c.doctors.phone) });
      if (open === true) {
        const dlang = langOf(c.doctors.language_pref);
        await sendInteractiveButtons(
          c.doctors.phone,
          pick(dlang, {
            en: `When everything is settled, please set ${p?.full_name ?? 'the patient'}'s next chemo date — tap below, or reply NEXT <date> (e.g. NEXT 24/07) anytime.`,
            hi: `सब कुछ निपट जाने पर कृपया ${p?.full_name ?? 'रोगी'} की अगली कीमो तारीख तय करें — नीचे दबाएँ, या कभी भी NEXT <तारीख> (जैसे NEXT 24/07) लिखें।`,
          }),
          [{ id: `chemo_date:${c.id}`, title: pick(dlang, { en: '📅 Set next chemo', hi: '📅 अगली कीमो तारीख' }) }],
          { caseId: c.id, role: 'doctor' },
        );
      }
    } catch (e) {
      console.error('next-chemo prompt send failed:', e);
    }
  } else if (c.doctors?.phone && !(dischargeGen.ok && dischargeGen.media_id)) {
    await alertPhones(
      await opsPhones(),
      `⚠️ ${c.case_code}: discharge summary PDF generation failed — doctor copy NOT sent. Use "Regenerate docs" in the dashboard.`,
      c.id,
    );
  }

  // 6. Immediate UPI order_details when the patient's window is open.
  if (p?.wa_number) {
    try {
      const { data: open } = await db.rpc('open_window', { p_phone: normPhone(p.wa_number) });
      if (open === true) {
        const items = Array.isArray(inv.line_items) ? inv.line_items : [];
        const itemName = items[0]?.name ?? items[0]?.label ?? 'Home care service';
        const upi = inv.upi_vpa ?? ((await getSetting<string>('upi_vpa')) ?? '');
        const business = (await getSetting<string>('business_name')) ?? 'Carcinome Home Care';
        const lang = langOf(p.language_pref);
        await sendOrderDetails(
          p.wa_number,
          {
            referenceId: inv.invoice_no,
            totalPaise: Math.round(total * 100),
            itemName,
            upiVpa: upi,
            businessName: business,
            bodyText: pick(lang, {
              en: `Invoice ${inv.invoice_no} for ${c.case_code} — total ${inr(total)}. Tap Review and Pay to pay via UPI. After paying, tap "I've paid".`,
              hi: `केस ${c.case_code} का इनवॉइस ${inv.invoice_no} — कुल ${inr(total)}। UPI से भुगतान के लिए Review and Pay दबाएँ। भुगतान के बाद "भुगतान हो गया" दबाएँ।`,
            }),
          },
          { caseId: c.id, role: 'patient' },
        );
        await sendPaidClaimButton(p.wa_number, c.id, lang);
      }
    } catch (e) {
      console.error('order_details send exception:', e);
    }
  }

  // 7. Invoice → sent, case → awaiting_payment, timeline events.
  // Both updates are GUARDED on the current DB status (not the row loaded at
  // pipeline start): docgen cold starts can delay this pipeline by minutes, and
  // an unguarded write would clobber a payment claim/verification/archive that
  // legitimately happened in the meantime.
  await db
    .from('invoices')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', inv.id)
    .eq('status', 'draft');
  await db
    .from('cases')
    .update({ status: 'awaiting_payment' })
    .eq('id', c.id)
    .eq('status', 'care_done');
  await logEvent(c.id, 'invoice_sent', 'system', {
    invoice_no: inv.invoice_no,
    total_inr: total,
    media: !!(invoiceGen.ok && invoiceGen.media_id),
  });
  await logEvent(c.id, 'discharge_sent', 'system', {
    media: !!(dischargeGen.ok && dischargeGen.media_id),
    doctor_sent: !!c.doctors?.phone,
  });
}

// ─── feedback_v1 ─────────────────────────────────────────────────────────────

async function onFeedback(
  c: FlowCase,
  data: Record<string, unknown>,
  ctx: InboundCtx,
): Promise<void> {
  await attachCase(ctx.msgId, c.id, 'patient');

  const overall = parseInt(String(data.overall ?? ''), 10);
  const nurseRating = parseInt(String(data.nurse_care ?? ''), 10);

  const { error } = await db.from('feedback').upsert(
    {
      case_id: c.id,
      patient_id: c.patients?.id ?? null,
      overall_rating: Number.isFinite(overall) ? overall : null,
      nurse_rating: Number.isFinite(nurseRating) ? nurseRating : null,
      recommend: truthy(data.recommend),
      comments: str(data.comments),
      response: data,
    },
    { onConflict: 'case_id' },
  );
  if (error) console.error('feedback upsert failed:', error.message);

  const lang = await langFor(ctx.from);
  await sendSmart(
    ctx.from,
    pick(lang, {
      en: `Thank you for your feedback 🙏 It helps us improve the care we bring to every home. Wishing you good health.`,
      hi: `आपकी प्रतिक्रिया के लिए धन्यवाद 🙏 यह हर घर तक बेहतर देखभाल पहुंचाने में हमारी मदद करती है। आपके अच्छे स्वास्थ्य की कामना करते हैं।`,
    }),
    { name: 'care_update', lang, params: ['Carcinome Team', `Feedback received for ${c.case_code} — thank you`] },
    { caseId: c.id, role: 'patient' },
  );

  if (Number.isFinite(overall) && overall <= 2) {
    await alertPhones(
      await supervisorAndOpsPhones(),
      `🚨 LOW FEEDBACK on ${c.case_code}: overall ${overall}/5` +
        (Number.isFinite(nurseRating) ? `, nurse ${nurseRating}/5` : '') +
        (str(data.comments) ? ` — "${String(data.comments).slice(0, 150)}"` : '') +
        `. Please follow up with the patient.`,
      c.id,
    );
  }

  await logEvent(c.id, 'feedback_received', 'patient', {
    overall: Number.isFinite(overall) ? overall : null,
    nurse: Number.isFinite(nurseRating) ? nurseRating : null,
    recommend: truthy(data.recommend),
  });

  // Doctor mirror — how their referred patient rated the care (per-language bits).
  const bitsEn = [
    Number.isFinite(overall) ? `overall ${overall}/5` : null,
    Number.isFinite(nurseRating) ? `nurse ${nurseRating}/5` : null,
  ].filter(Boolean).join(', ');
  const bitsHi = [
    Number.isFinite(overall) ? `समग्र ${overall}/5` : null,
    Number.isFinite(nurseRating) ? `नर्स ${nurseRating}/5` : null,
  ].filter(Boolean).join(', ');
  await notifyDoctor(c.id, {
    en: `⭐ ${c.case_code} (${c.patients?.full_name ?? 'patient'}): the patient shared feedback${bitsEn ? ` — ${bitsEn}` : ''}${truthy(data.recommend) ? ', would recommend' : ''}. Thank you for the referral.`,
    hi: `⭐ ${c.case_code} (${c.patients?.full_name ?? 'रोगी'}): रोगी ने प्रतिक्रिया दी है${bitsHi ? ` — ${bitsHi}` : ''}${truthy(data.recommend) ? ', वे सिफ़ारिश भी करेंगे' : ''}। रेफ़रल के लिए धन्यवाद।`,
  });
}
