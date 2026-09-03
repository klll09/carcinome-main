// admin-actions/index.ts — dashboard → backend actions (CONTRACTS §admin-actions).
// verify_jwt ON at the platform level + explicit profiles check here (role=admin AND is_active).
//
// POST JSON { action, ...params } with Authorization: Bearer <admin session JWT>.
// Actions:
//   register_case        { patient_id? | patient{...}, doctor_id? | doctor{...}, supplier_ids?,
//                          line_type, care_type, scheduled_at, address?, equipment_notes?,
//                          notes?, price_inr?, discharge_upload_path? }
//                        → { ok, case_id, case_code }
//   assign_nurse         { case_id, nurse_id }
//   reassign_nurse       { case_id, nurse_id }
//   send_consent         { case_id }
//   issue_otp            { case_id }
//   mark_paid_verified   { case_id }
//   regenerate_docs      { case_id }
//   resend_invoice       { case_id }
//   send_manual_message  { case_id, text }
//   cancel_case          { case_id, reason }
//   archive_case         { case_id }
import { db, getServiceKey, getSetting } from '../_shared/db.ts';
import {
  cancelPendingAvailabilityChecks,
  fmtIST,
  careLabel,
  lineLabel,
  nonce8,
  performAssignment,
  sendConsentInvite,
  stripDr,
  isWindowOpen,
} from '../_shared/assign.ts';
import { startAvailabilityCheck } from '../_shared/availability.ts';
import { langFor, pick, type Lang } from '../_shared/lang.ts';
import { logEvent } from '../_shared/log.ts';
import { issueOtp, sendOtpMessages } from '../_shared/otp.ts';
import { normPhone } from '../_shared/phone.ts';
import { fanOut } from '../_shared/relay.ts';
import {
  paramSafe,
  sendInteractiveButtons,
  sendOrderDetails,
  sendPaidClaimButton,
  sendSmart,
  sendTemplate,
  sendText,
  type SendResult,
} from '../_shared/wa.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

/** Run long work after the response (EdgeRuntime.waitUntil when available). */
function background(p: Promise<unknown>): void {
  const guarded = p.catch((e) => console.error('background task failed:', e));
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === 'function') er.waitUntil(guarded);
}

function inrFmt(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString('en-IN');
}

/** Locality-level area for nurse offers / SLA nudges — never the full address. */
function areaOf(p: { locality?: string | null; pincode?: string | null } | null, address?: string | null): string {
  if (p?.locality) return p.pincode ? `${p.locality}, ${p.pincode}` : p.locality;
  const parts = String(address ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join(', ');
  if (parts.length === 1) return parts[0];
  return 'your area';
}

// ─── docgen internal call ────────────────────────────────────────────────────
async function docgenCall(
  caseId: string,
  doc: 'invoice' | 'discharge',
): Promise<{ ok: boolean; path?: string; media_id?: string | null; error?: unknown }> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/docgen`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getServiceKey()}`,
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

/** Render a document with SAMPLE data (optionally an unsaved template) — powers
 * the Flow Studio template editor's live PDF preview. */
async function actionPreviewDoc(doc: unknown, template: unknown): Promise<Response> {
  const kind = String(doc ?? '');
  if (!['invoice', 'discharge'].includes(kind)) {
    return json({ ok: false, error: "doc ('invoice'|'discharge') required" }, 400);
  }
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/docgen`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getServiceKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ preview: true, doc: kind, template: template ?? undefined }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) return json({ ok: false, error: j?.error ?? `HTTP ${res.status}` }, 500);
    return json({ ok: true, pdf_base64: j.pdf_base64 });
  } catch (e) {
    console.error('preview_doc exception:', e);
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ─── Case loading ────────────────────────────────────────────────────────────
type FullCase = {
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

async function loadCase(caseId: string): Promise<FullCase | null> {
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
    console.error('loadCase failed:', error.message);
    return null;
  }
  return data as unknown as FullCase | null;
}

function langOf(pref: string | null | undefined): Lang {
  return pref === 'hi' ? 'hi' : 'en';
}

// ════════════════════════════════════════════════════════════════════════════
// register_case
// ════════════════════════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function registerCase(body: any, adminId: string): Promise<Response> {
  // ── 1. Patient ──
  let patient: FullCase['patients'] | null = null;
  let pocName: string | null = null;
  let pocPhone: string | null = null;
  if (body.patient_id) {
    const { data, error } = await db
      .from('patients')
      .select('id, full_name, wa_number, phone, address, locality, pincode, language_pref, cancer_type, poc_name, poc_phone')
      .eq('id', body.patient_id)
      .maybeSingle();
    if (error || !data) return json({ ok: false, error: 'patient_not_found' }, 400);
    patient = data as unknown as FullCase['patients'];
    pocName = (data as { poc_name?: string }).poc_name ?? null;
    pocPhone = (data as { poc_phone?: string }).poc_phone ? normPhone((data as { poc_phone: string }).poc_phone) : null;
  } else if (body.patient?.full_name && body.patient?.phone) {
    const p = body.patient;
    const phone = normPhone(p.phone);
    const wa = normPhone(p.wa_number || p.phone);
    if (!phone || phone.length < 11) return json({ ok: false, error: 'invalid_patient_phone' }, 400);
    pocName = p.poc_name ? String(p.poc_name).trim() : null;
    pocPhone = p.poc_phone ? normPhone(p.poc_phone) : null;
    if (pocPhone && pocPhone.length < 11) pocPhone = null;
    const { data, error } = await db
      .from('patients')
      .insert({
        full_name: String(p.full_name).trim(),
        phone,
        wa_number: wa,
        cancer_type: String(p.cancer_type ?? 'Not specified').trim(),
        address: String(p.address ?? '').trim(),
        locality: p.locality ? String(p.locality).trim() : null,
        pincode: p.pincode ? String(p.pincode).trim() : null,
        language_pref: p.language_pref === 'hi' ? 'hi' : 'en',
        notes: p.notes ?? null,
        poc_name: pocName,
        poc_phone: pocPhone,
        created_by: adminId,
      })
      .select('id, full_name, wa_number, phone, address, locality, pincode, language_pref')
      .single();
    if (error) return json({ ok: false, error: `patient_insert_failed: ${error.message}` }, 500);
    patient = data as unknown as FullCase['patients'];
  } else {
    return json({ ok: false, error: 'patient_id or patient{full_name, phone, ...} required' }, 400);
  }

  // ── 2. Doctor (optional; inline doctor upserted by phone) ──
  let doctor: { id: string; full_name: string; phone: string; language_pref: string; default_relay: string } | null = null;
  if (body.doctor_id) {
    const { data } = await db
      .from('doctors')
      .select('id, full_name, phone, language_pref, default_relay')
      .eq('id', body.doctor_id)
      .maybeSingle();
    if (!data) return json({ ok: false, error: 'doctor_not_found' }, 400);
    doctor = data;
  } else if (body.doctor?.full_name && body.doctor?.phone) {
    const dphone = normPhone(body.doctor.phone);
    if (!dphone || dphone.length < 11) return json({ ok: false, error: 'invalid_doctor_phone' }, 400);
    const { data: existing } = await db
      .from('doctors')
      .select('id, full_name, phone, language_pref, default_relay')
      .eq('phone', dphone)
      .maybeSingle();
    if (existing) {
      doctor = existing;
    } else {
      const { data, error } = await db
        .from('doctors')
        .insert({
          full_name: String(body.doctor.full_name).trim(),
          phone: dphone,
          specialty: body.doctor.specialty ?? null,
          language_pref: body.doctor.language_pref === 'hi' ? 'hi' : 'en',
        })
        .select('id, full_name, phone, language_pref, default_relay')
        .single();
      if (error) return json({ ok: false, error: `doctor_insert_failed: ${error.message}` }, 500);
      doctor = data;
    }
  }

  // ── 3. Case ──
  if (!body.line_type || !body.care_type || !body.scheduled_at) {
    return json({ ok: false, error: 'line_type, care_type, scheduled_at required' }, 400);
  }
  const scheduled = new Date(body.scheduled_at);
  if (isNaN(scheduled.getTime())) return json({ ok: false, error: 'invalid scheduled_at' }, 400);

  let price = body.price_inr != null && body.price_inr !== '' ? Number(body.price_inr) : null;
  if (price == null || isNaN(price)) {
    const pricing = (await getSetting<Record<string, number>>('pricing')) ?? {};
    price = Number(pricing[body.care_type] ?? 0) || null;
  }

  const supplierIds: string[] = Array.isArray(body.supplier_ids) ? body.supplier_ids.filter(Boolean) : [];
  const caseAddress = String(body.address ?? '').trim() ||
    String((patient as unknown as { address?: string })?.address ?? '').trim();

  const { data: caseRow, error: caseErr } = await db
    .from('cases')
    .insert({
      patient_id: patient!.id,
      doctor_id: doctor?.id ?? null,
      supplier_id: supplierIds[0] ?? null,
      line_type: body.line_type,
      care_type: body.care_type,
      scheduled_at: scheduled.toISOString(),
      address: caseAddress || 'Address to be confirmed',
      equipment_notes: body.equipment_notes ?? null,
      discharge_upload_path: body.discharge_upload_path ?? null,
      notes: body.notes ?? null,
      price_inr: price,
      status: 'registered',
      created_by: adminId,
    })
    .select('id, case_code, scheduled_at, care_type, line_type, address, equipment_notes')
    .single();
  if (caseErr) return json({ ok: false, error: `case_insert_failed: ${caseErr.message}` }, 500);
  const caseId: string = caseRow.id;
  const caseCode: string = caseRow.case_code;

  // ── 4. Suppliers ──
  let suppliers: { id: string; name: string; phone: string; language_pref: string }[] = [];
  if (supplierIds.length) {
    const { data } = await db
      .from('suppliers')
      .select('id, name, phone, language_pref')
      .in('id', supplierIds)
      .eq('is_active', true)
      .eq('opted_out', false);
    suppliers = data ?? [];
  }

  // ── 5. Participants (patient, doctor, ops+supervisors, suppliers) ──
  const opsPhones = ((await getSetting<string[]>('ops_phones')) ?? []).map(normPhone).filter(Boolean);
  const supPhones = ((await getSetting<string[]>('supervisor_phones')) ?? []).map(normPhone).filter(Boolean);

  // Keyed by phone|role: one phone may legitimately hold SEVERAL roles on the
  // same case (two-phone rehearsals: nurse+doctor on one number, patient+nurse
  // on the other). The relay dedupes per phone at send time.
  const byPhoneRole = new Map<string, Record<string, unknown>>();
  const addPart = (row: Record<string, unknown>) => {
    const key = `${row.phone}|${row.role}`;
    if (row.phone && !byPhoneRole.has(key)) byPhoneRole.set(key, row);
  };
  const patientPhone = normPhone(patient!.wa_number);
  addPart({
    case_id: caseId,
    role: 'patient',
    phone: patientPhone,
    display_name: patient!.full_name,
    person_id: patient!.id,
    relay: 'full',
  });
  if (doctor) {
    addPart({
      case_id: caseId,
      role: 'doctor',
      phone: normPhone(doctor.phone),
      display_name: `Dr. ${stripDr(doctor.full_name)}`,
      person_id: doctor.id,
      relay: doctor.default_relay ?? 'milestones',
    });
  }
  for (const ph of opsPhones) {
    addPart({ case_id: caseId, role: 'ops', phone: ph, display_name: 'Carcinome Ops', relay: 'full' });
  }
  for (const ph of supPhones) {
    addPart({ case_id: caseId, role: 'ops', phone: ph, display_name: 'Supervisor', relay: 'full' });
  }
  for (const s of suppliers) {
    addPart({ case_id: caseId, role: 'supplier', phone: normPhone(s.phone), display_name: s.name, person_id: s.id, relay: 'full' });
  }
  // POC observer — log-style milestones, never the raw relay dump.
  if (pocPhone) {
    addPart({
      case_id: caseId,
      role: 'poc',
      phone: pocPhone,
      display_name: pocName ? `POC ${pocName}` : 'Carcinome POC',
      person_id: patient!.id,
      relay: 'milestones',
    });
  }
  const { error: partErr } = await db
    .from('case_participants')
    .upsert([...byPhoneRole.values()], { onConflict: 'case_id,phone,role', ignoreDuplicates: true });
  if (partErr) console.error('participants insert failed:', partErr.message);

  // ── 6. Offers to ALL eligible + active nurses ──
  const { data: nurses } = await db
    .from('nurses')
    .select('id, full_name, phone, language_pref')
    .eq('is_eligible', true)
    .eq('is_active', true)
    .eq('opted_out', false);
  const nursePool = nurses ?? [];
  if (nursePool.length) {
    const { error: offerErr } = await db
      .from('case_offers')
      .upsert(
        nursePool.map((n) => ({ case_id: caseId, nurse_id: n.id })),
        { onConflict: 'case_id,nurse_id', ignoreDuplicates: true },
      );
    if (offerErr) console.error('case_offers insert failed:', offerErr.message);
  }

  // ── 7. Status → offering + registered event ──
  await db.from('cases').update({ status: 'offering' }).eq('id', caseId);
  await logEvent(caseId, 'registered', `admin:${adminId}`, {
    patient: patient!.full_name,
    doctor: doctor?.full_name ?? null,
    suppliers: suppliers.map((s) => s.name),
    care_type: body.care_type,
    nurse_pool: nursePool.length,
  });

  // ── 8. Fan-out sends (background — respond fast to the dashboard) ──
  const schedFmt = fmtIST(caseRow.scheduled_at);
  const careL = await careLabel(caseRow.care_type);
  const lineL = await lineLabel(caseRow.line_type);
  const area = areaOf(patient, caseRow.address);
  const requirements = paramSafe(caseRow.equipment_notes || `Standard kit for ${careL}`, 200);
  const p = patient!;
  const doc = doctor;

  background((async () => {
    // patient_registered
    await sendTemplate(p.wa_number, 'patient_registered', langOf(p.language_pref), [p.full_name, caseCode, schedFmt], {
      caseId,
      role: 'patient',
    });
    // doctor_referral_ack
    if (doc) {
      await sendTemplate(
        doc.phone,
        'doctor_referral_ack',
        langOf(doc.language_pref),
        [stripDr(doc.full_name), p.full_name, caseCode, schedFmt],
        { caseId, role: 'doctor' },
      );
    }
    // POC welcome + first log line.
    if (pocPhone) {
      await sendSmart(
        pocPhone,
        `📔 You are the Carcinome POC for ${p.full_name} (${caseCode}). Case registered — care offers sent to ${nursePool.length} nurse(s), session planned for ${schedFmt}. You will get a log update at every milestone. Reply STATUS anytime for a full picture of all your patients.`,
        { name: 'care_update', lang: 'en', params: ['Carcinome Team', paramSafe(`You are the POC for ${p.full_name} (${caseCode}) — case registered, offers sent. Reply STATUS anytime.`, 250)] },
        { caseId, role: 'poc' },
      );
    }
    // supplier_equipment_prep — nurse not assigned yet
    for (const s of suppliers) {
      await sendTemplate(
        s.phone,
        'supplier_equipment_prep',
        langOf(s.language_pref),
        [p.full_name, paramSafe(caseRow.address, 200), requirements, schedFmt, 'to be assigned / नर्स नियुक्ति शीघ्र'],
        { caseId, role: 'supplier' },
      );
    }
    // nurse_case_offer to every eligible nurse (LOCALITY only — never the full address)
    let offersSent = 0;
    for (const n of nursePool) {
      try {
        const r = await sendTemplate(
          n.phone,
          'nurse_case_offer',
          langOf(n.language_pref),
          [area, careL, lineL, caseCode, schedFmt],
          {
            caseId,
            role: 'nurse',
            buttonPayloads: [`offer_yes:${caseId}`, `offer_no:${caseId}`],
          },
        );
        if (r.ok && r.wamid) {
          offersSent++;
          await db.from('case_offers').update({ sent_wamid: r.wamid }).eq('case_id', caseId).eq('nurse_id', n.id);
        }
      } catch (e) {
        console.error(`nurse offer send failed (${n.phone}):`, e);
      }
    }
    await logEvent(caseId, 'offers_sent', 'system', { pool: nursePool.length, sent: offersSent, area });
  })());

  return json({ ok: true, case_id: caseId, case_code: caseCode });
}

// ════════════════════════════════════════════════════════════════════════════
// assign_nurse / reassign_nurse — thin wrapper over the shared primitive
// (_shared/assign.ts performAssignment, also used by the standby auto-reassign)
// ════════════════════════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function assignNurse(body: any, adminId: string, isReassign: boolean): Promise<Response> {
  if (!body.case_id || !body.nurse_id) return json({ ok: false, error: 'case_id and nurse_id required' }, 400);
  const r = await performAssignment(body.case_id, body.nurse_id, `admin:${adminId}`, {
    isReassign,
    background,
  });
  if (!r.ok) return json({ ok: false, error: r.error }, r.status ?? 500);
  return json({ ok: true, case_id: body.case_id, nurse_id: body.nurse_id, first_assign: r.firstAssign });
}

// ════════════════════════════════════════════════════════════════════════════
// Other actions
// ════════════════════════════════════════════════════════════════════════════
async function actionSendConsent(caseId: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  if (!c.patients) return json({ ok: false, error: 'case_has_no_patient' }, 500);
  const r = await sendConsentInvite(
    { id: c.id, case_code: c.case_code, care_type: c.care_type, scheduled_at: c.scheduled_at },
    c.patients,
    `admin:${adminId}`,
  );
  return json({ ok: r.ok, via: r.via ?? 'flow', error: r.ok ? undefined : r.error });
}

async function actionIssueOtp(caseId: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  if (['cancelled', 'archived', 'paid', 'care_done', 'awaiting_payment'].includes(c.status)) {
    return json({ ok: false, error: `case is ${c.status} — OTP not applicable` }, 400);
  }
  if (!c.nurses) return json({ ok: false, error: 'no_assigned_nurse' }, 400);
  if (!c.patients) return json({ ok: false, error: 'case_has_no_patient' }, 500);

  const otp = await issueOtp(c.id);
  if (!otp.ok || !otp.code) return json({ ok: false, error: otp.error ?? 'otp_issue_failed' }, 500);

  const sent = await sendOtpMessages(c.id, otp.code, c.patients, c.nurses);
  if (['assigned', 'consented'].includes(c.status)) {
    await db.from('cases').update({ status: 'otp_sent' }).eq('id', c.id);
  }
  await logEvent(c.id, 'otp_issued', `admin:${adminId}`, {
    expires_at: otp.expiresAt,
    patient_send_ok: sent.patientOk,
    nurse_send_ok: sent.nurseOk,
  });
  return json({ ok: true, expires_at: otp.expiresAt });
}

async function actionMarkPaidVerified(caseId: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  const { data: inv } = await db.from('invoices').select('*').eq('case_id', c.id).maybeSingle();
  if (!inv) return json({ ok: false, error: 'invoice_not_found' }, 404);
  if (inv.status === 'paid_verified') return json({ ok: true, already_verified: true });
  if (inv.status === 'void') return json({ ok: false, error: 'invoice_void' }, 400);

  const now = new Date().toISOString();
  const { error: invErr } = await db
    .from('invoices')
    .update({ status: 'paid_verified', paid_verified_at: now, verified_by: adminId })
    .eq('id', inv.id);
  if (invErr) return json({ ok: false, error: `invoice_update_failed: ${invErr.message}` }, 500);
  await db.from('cases').update({ status: 'paid' }).eq('id', c.id);
  await logEvent(c.id, 'payment_verified', `admin:${adminId}`, {
    invoice_no: inv.invoice_no,
    total_inr: inv.total_inr,
  });

  const amount = inrFmt(Number(inv.total_inr ?? 0));
  const p = c.patients;
  const doc = c.doctors;
  background((async () => {
    if (p) {
      await sendTemplate(p.wa_number, 'payment_received', langOf(p.language_pref), [amount, inv.invoice_no], {
        caseId: c.id,
        role: 'patient',
      });
    }
    if (doc) {
      await sendTemplate(doc.phone, 'payment_received', langOf(doc.language_pref), [amount, inv.invoice_no], {
        caseId: c.id,
        role: 'doctor',
      });
      // Everything is settled → invite the doctor to set the next chemo date
      // (button when the window is open; the NEXT keyword always works).
      const { data: fresh } = await db.from('cases').select('next_chemo_at').eq('id', c.id).maybeSingle();
      if (!fresh?.next_chemo_at && (await isWindowOpen(doc.phone))) {
        const dlang = langOf(doc.language_pref);
        await sendInteractiveButtons(
          doc.phone,
          pick(dlang, {
            en: `${c.case_code} (${c.patients?.full_name ?? 'patient'}) is fully settled. When is the next chemo planned? Tap below, or reply NEXT <date> (e.g. NEXT 24/07) anytime.`,
            hi: `${c.case_code} (${c.patients?.full_name ?? 'रोगी'}) पूरी तरह निपट गया है। अगली कीमो कब है? नीचे दबाएँ, या कभी भी NEXT <तारीख> (जैसे NEXT 24/07) लिखें।`,
          }),
          [{ id: `chemo_date:${c.id}`, title: pick(dlang, { en: '📅 Set next chemo', hi: '📅 अगली कीमो तारीख' }) }],
          { caseId: c.id, role: 'doctor' },
        );
      }
    }
    const opsPhones = ((await getSetting<string[]>('ops_phones')) ?? []).map(normPhone).filter(Boolean);
    for (const ph of [...new Set(opsPhones)]) {
      await sendSmart(
        ph,
        `✅ ${c.case_code}: payment of ₹${amount} verified against ${inv.invoice_no}.`,
        { name: 'payment_received', lang: await langFor(ph), params: [amount, inv.invoice_no] },
        { caseId: c.id, role: 'ops' },
      );
    }
  })());

  return json({ ok: true, invoice_no: inv.invoice_no });
}

async function actionRegenerateDocs(caseId: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  const invoice = await docgenCall(c.id, 'invoice');
  const discharge = await docgenCall(c.id, 'discharge');
  await logEvent(c.id, 'docs_regenerated', `admin:${adminId}`, {
    invoice_ok: invoice.ok,
    discharge_ok: discharge.ok,
  });
  return json({ ok: invoice.ok || discharge.ok, invoice, discharge });
}

async function actionResendInvoice(caseId: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  if (!c.patients) return json({ ok: false, error: 'case_has_no_patient' }, 500);
  const { data: inv } = await db.from('invoices').select('*').eq('case_id', c.id).maybeSingle();
  if (!inv) return json({ ok: false, error: 'invoice_not_found' }, 404);
  if (inv.status === 'void') return json({ ok: false, error: 'invoice_void' }, 400);

  // Regenerate for a fresh WhatsApp media id (media ids expire).
  const gen = await docgenCall(c.id, 'invoice');
  if (!gen.ok || !gen.media_id) {
    return json({ ok: false, error: gen.error ?? 'docgen_failed_no_media' }, 500);
  }

  const p = c.patients;
  const amount = inrFmt(Number(inv.total_inr ?? 0));
  const r = await sendTemplate(
    p.wa_number,
    'invoice_delivery',
    langOf(p.language_pref),
    [inv.invoice_no, c.case_code, amount],
    {
      caseId: c.id,
      role: 'patient',
      headerDocument: { id: gen.media_id, filename: `${inv.invoice_no}.pdf` },
      buttonPayloads: [`pay_show:${c.id}`],
    },
  );

  let orderDetailsSent = false;
  if (r.ok && (await isWindowOpen(p.wa_number))) {
    const upi = inv.upi_vpa ?? ((await getSetting<string>('upi_vpa')) ?? '');
    const business = (await getSetting<string>('business_name')) ?? 'Carcinome Home Care';
    const items = Array.isArray(inv.line_items) ? inv.line_items : [];
    const lang = langOf(p.language_pref);
    const od = await sendOrderDetails(
      p.wa_number,
      {
        referenceId: inv.invoice_no,
        totalPaise: Math.round(Number(inv.total_inr ?? 0) * 100),
        itemName: items[0]?.name ?? items[0]?.label ?? 'Home care service',
        upiVpa: upi,
        businessName: business,
        bodyText: pick(lang, {
          en: `Invoice ${inv.invoice_no} for ${c.case_code} — total ₹${amount}. Tap Review and Pay to pay via UPI.`,
          hi: `केस ${c.case_code} का इनवॉइस ${inv.invoice_no} — कुल ₹${amount}। UPI से भुगतान के लिए Review and Pay दबाएँ।`,
        }),
      },
      { caseId: c.id, role: 'patient' },
    );
    orderDetailsSent = od.ok;
    await sendPaidClaimButton(p.wa_number, c.id, lang);
  }

  if (r.ok) {
    const patch: Record<string, unknown> = { sent_at: inv.sent_at ?? new Date().toISOString() };
    if (inv.status === 'draft') patch.status = 'sent';
    await db.from('invoices').update(patch).eq('id', inv.id);
  }
  await logEvent(c.id, 'invoice_resent', `admin:${adminId}`, {
    invoice_no: inv.invoice_no,
    ok: r.ok,
    order_details: orderDetailsSent,
  });
  return json({ ok: r.ok, invoice_no: inv.invoice_no, order_details: orderDetailsSent, error: r.ok ? undefined : r.error });
}

async function actionSendManualMessage(caseId: string, text: string, adminId: string): Promise<Response> {
  const body = String(text ?? '').trim();
  if (!body) return json({ ok: false, error: 'text required' }, 400);
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);

  // senderPhone '' → no participant matches the sender, so EVERY active participant receives it.
  await fanOut(c.id, '', 'Carcinome Team', { text: body }, null);
  await logEvent(c.id, 'manual_message', `admin:${adminId}`, { text: paramSafe(body, 300) });
  return json({ ok: true });
}

async function actionCancelCase(caseId: string, reason: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  if (['cancelled', 'archived'].includes(c.status)) {
    return json({ ok: false, error: `case is already ${c.status}` }, 400);
  }
  const why = String(reason ?? '').trim() || 'Not specified';
  const { error } = await db
    .from('cases')
    .update({ status: 'cancelled', cancelled_reason: why })
    .eq('id', c.id);
  if (error) return json({ ok: false, error: `case_update_failed: ${error.message}` }, 500);
  await cancelPendingAvailabilityChecks(c.id, 'case_cancelled');
  await logEvent(c.id, 'case_cancelled', `admin:${adminId}`, { reason: why });

  const p = c.patients;
  const n = c.nurses;
  const doc = c.doctors;
  background((async () => {
    if (p) {
      const lang = langOf(p.language_pref);
      const msg = pick(lang, {
        en: `Update on your home-care request (case ${c.case_code}): this session has been cancelled. Our team will contact you if a new session is planned. Reply here for any questions.`,
        hi: `आपके होम-केयर अनुरोध (केस ${c.case_code}) पर अपडेट: यह सेशन रद्द कर दिया गया है। नया सेशन तय होने पर हमारी टीम आपसे संपर्क करेगी। किसी भी प्रश्न के लिए यहां उत्तर दें।`,
      });
      await sendSmart(p.wa_number, msg, { name: 'care_update', lang, params: ['Carcinome Team', paramSafe(msg, 160)] }, { caseId: c.id, role: 'patient' });
    }
    if (n) {
      const lang = langOf(n.language_pref);
      const msg = pick(lang, {
        en: `Case ${c.case_code} has been cancelled — the session will not take place. No action needed from you. Thank you.`,
        hi: `केस ${c.case_code} रद्द कर दिया गया है — यह सेशन अब नहीं होगा। आपको कुछ करने की आवश्यकता नहीं है। धन्यवाद।`,
      });
      await sendSmart(n.phone, msg, { name: 'care_update', lang, params: ['Carcinome Team', paramSafe(msg, 160)] }, { caseId: c.id, role: 'nurse' });
    }
    if (doc) {
      const lang = langOf(doc.language_pref);
      const msg = pick(lang, {
        en: `Update on your referred patient ${p?.full_name ?? ''} (case ${c.case_code}): the home-care session has been cancelled. Reason: ${why}.`,
        hi: `आपके रेफ़र किए गए रोगी ${p?.full_name ?? ''} (केस ${c.case_code}) पर अपडेट: होम-केयर सेशन रद्द कर दिया गया है। कारण: ${why}।`,
      });
      await sendSmart(doc.phone, msg, { name: 'care_update', lang, params: ['Carcinome Team', paramSafe(msg, 160)] }, { caseId: c.id, role: 'doctor' });
    }
  })());

  return json({ ok: true });
}

async function actionArchiveCase(caseId: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  if (c.status === 'archived') return json({ ok: true, already_archived: true });
  const { error } = await db.from('cases').update({ status: 'archived' }).eq('id', c.id);
  if (error) return json({ ok: false, error: `case_update_failed: ${error.message}` }, 500);
  await db.from('case_participants').update({ active: false }).eq('case_id', c.id);
  await cancelPendingAvailabilityChecks(c.id, 'case_archived');
  await logEvent(c.id, 'case_archived', `admin:${adminId}`, {});
  return json({ ok: true });
}

// ─── send_feedback_invite — instant/manual feedback form (rehearsals, resends) ─
// The cron path waits ≥2h post-completion and only fires at its daily slots;
// ops needs an on-demand send. Logs feedback_invite_1 so the chaser cron
// treats this as the first invite and never double-invites.
async function actionSendFeedbackInvite(caseId: string, adminId: string): Promise<Response> {
  const c = await loadCase(caseId);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);
  if (!['care_done', 'awaiting_payment', 'paid'].includes(c.status)) {
    return json({ ok: false, error: `case is ${c.status} — feedback applies after care is complete` }, 400);
  }
  if (!c.patients) return json({ ok: false, error: 'case_has_no_patient' }, 500);
  const { data: fb } = await db.from('feedback').select('id').eq('case_id', c.id).limit(1);
  if ((fb ?? []).length > 0) return json({ ok: false, error: 'feedback already received for this case' }, 400);

  const token = `feedback_v1:${c.id}:${nonce8()}`;
  const r = await sendTemplate(
    c.patients.wa_number,
    'feedback_invite',
    langOf(c.patients.language_pref),
    [c.patients.full_name],
    { caseId: c.id, role: 'patient', flowToken: token },
  );
  if (!r.ok) return json({ ok: false, error: `send failed: ${JSON.stringify(r.error)}` }, 500);
  await logEvent(c.id, 'feedback_invite_1', `admin:${adminId}`, { manual: true });
  return json({ ok: true });
}

// ─── check_availability — "are you going right now?" ping to the assigned nurse
// No response inside settings.availability.timeout_min → the scheduler reaper
// marks it timeout and triggers the standby cascade automatically.
async function actionCheckAvailability(caseId: string, adminId: string): Promise<Response> {
  const r = await startAvailabilityCheck(caseId, `admin:${adminId}`);
  if (!r.ok) return json({ ok: false, error: r.error }, 400);
  return json({ ok: true, resent: r.resent ?? false });
}

// ─── send_test_message — the Sandbox page's delivery-debug send ──────────────
// { to, text, mode: 'auto' | 'text' | 'template' }
//   auto     → free text if the recipient's 24h window is open, else care_update template
//   text     → force free text (honest window test: fails/undelivers when window closed)
//   template → force the care_update carrier (works regardless of window)
// Not tied to any case; ledger row has case_id null. Returns the ledger id so
// the page can live-poll delivery status (sent → delivered → read / failed).
async function actionSendTestMessage(
  // deno-lint-ignore no-explicit-any
  body: any,
  adminId: string,
): Promise<Response> {
  const to = normPhone(String(body?.to ?? ''));
  const text = String(body?.text ?? '').trim();
  const mode = ['auto', 'text', 'template'].includes(body?.mode) ? body.mode : 'auto';
  if (!to || to.length < 11) return json({ ok: false, error: 'valid recipient phone required' }, 400);
  if (!text) return json({ ok: false, error: 'text required' }, 400);

  const { data: cs } = await db
    .from('conversation_state')
    .select('last_inbound_at')
    .eq('phone', to)
    .maybeSingle();
  const windowOpen = !!cs?.last_inbound_at &&
    Date.now() - new Date(cs.last_inbound_at).getTime() < 23 * 3600 * 1000;

  const lang = await langFor(to);
  let via: 'text' | 'template';
  let r: SendResult;
  if (mode === 'text' || (mode === 'auto' && windowOpen)) {
    via = 'text';
    r = await sendText(to, text, { role: 'ops' });
  } else {
    via = 'template';
    r = await sendTemplate(to, 'care_update', lang, ['Carcinome Team', paramSafe(text)], { role: 'ops' });
  }

  console.log(`sandbox send by admin:${adminId} → ${to} via ${via}: ${r.ok ? r.wamid : JSON.stringify(r.error)}`);
  return json({
    ok: r.ok,
    via,
    window_open: windowOpen,
    last_inbound_at: cs?.last_inbound_at ?? null,
    message_id: r.messageId ?? null,
    wamid: r.wamid ?? null,
    error: r.ok ? undefined : (typeof r.error === 'string' ? r.error : JSON.stringify(r.error ?? 'send_failed')),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// HTTP entry
// ════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  // ── Auth: Bearer JWT → auth.getUser → profiles role admin + active ──
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'missing_authorization' }, 401);

  let adminId = '';
  try {
    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ ok: false, error: 'invalid_token' }, 401);
    const { data: profile, error: profErr } = await db
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (profErr) return json({ ok: false, error: 'profile_lookup_failed' }, 500);
    if (!profile || profile.role !== 'admin' || !profile.is_active) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }
    adminId = profile.id;
  } catch (e) {
    console.error('auth exception:', e);
    return json({ ok: false, error: 'auth_failed' }, 401);
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const action = String(body?.action ?? '');
  if (!['register_case', 'send_test_message', 'preview_doc'].includes(action) && !body?.case_id) {
    return json({ ok: false, error: 'case_id required' }, 400);
  }

  try {
    switch (action) {
      case 'register_case':
        return await registerCase(body, adminId);
      case 'assign_nurse':
        return await assignNurse(body, adminId, false);
      case 'reassign_nurse':
        return await assignNurse(body, adminId, true);
      case 'send_consent':
        return await actionSendConsent(body.case_id, adminId);
      case 'issue_otp':
        return await actionIssueOtp(body.case_id, adminId);
      case 'mark_paid_verified':
        return await actionMarkPaidVerified(body.case_id, adminId);
      case 'regenerate_docs':
        return await actionRegenerateDocs(body.case_id, adminId);
      case 'resend_invoice':
        return await actionResendInvoice(body.case_id, adminId);
      case 'send_manual_message':
        return await actionSendManualMessage(body.case_id, body.text, adminId);
      case 'cancel_case':
        return await actionCancelCase(body.case_id, body.reason, adminId);
      case 'archive_case':
        return await actionArchiveCase(body.case_id, adminId);
      case 'send_test_message':
        return await actionSendTestMessage(body, adminId);
      case 'send_feedback_invite':
        return await actionSendFeedbackInvite(body.case_id, adminId);
      case 'check_availability':
        return await actionCheckAvailability(body.case_id, adminId);
      case 'preview_doc':
        return await actionPreviewDoc(body.doc, body.template);
      default:
        return json({ ok: false, error: `unknown_action: ${action}` }, 400);
    }
  } catch (e) {
    console.error(`admin-actions ${action} exception:`, e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
