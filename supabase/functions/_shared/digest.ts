// _shared/digest.ts — the STATUS keyword: a grouped, per-patient digest for
// observers (POC interns and referring doctors). One POC runs several
// families at once — this answers "who got what, and what are we waiting on"
// in one message, without ever dumping the raw chat.
import { db } from './db.ts';
import { normPhone } from './phone.ts';

const IST = 'Asia/Kolkata';

function fmtT(ts: string | null | undefined, withDay = true): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: IST,
      ...(withDay ? { day: 'numeric', month: 'short' } : {}),
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return String(ts);
  }
}

const STATUS_LABEL: Record<string, string> = {
  registered: 'REGISTERED',
  offering: 'FINDING A NURSE',
  assigned: 'NURSE ASSIGNED',
  consented: 'CONSENTED — SESSION AHEAD',
  otp_sent: 'NURSE ARRIVING',
  in_care: 'SESSION RUNNING',
  care_done: 'SESSION DONE',
  awaiting_payment: 'AWAITING PAYMENT',
  paid: 'SETTLED ✔',
  cancelled: 'CANCELLED',
  archived: 'CLOSED',
};

const EVENT_PHRASE: Record<string, string> = {
  registered: 'case registered',
  offers_sent: 'nurse offers sent',
  offer_yes: 'a nurse accepted the offer',
  nurse_assigned: 'nurse assigned',
  nurse_reassigned: 'nurse reassigned',
  consent_sent: 'consent form sent to the family',
  consented: 'consent signed',
  availability_check_sent: 'asked the nurse "are you going?"',
  availability_confirmed: 'nurse confirmed she is going',
  availability_declined: 'nurse said she cannot go',
  standby_pinged: 'standby nurse pinged',
  standby_accepted: 'standby nurse accepted',
  otp_issued: 'arrival code sent to the family',
  nurse_arrival_claimed: 'nurse says she has reached',
  otp_verified: 'nurse arrival verified — session started',
  care_completed: 'completion report received',
  patient_reported_done: 'family says the session is complete',
  care_done_confirmed: 'nurse confirmed the session is complete',
  invoice_sent: 'invoice sent',
  discharge_sent: 'discharge summary sent',
  payment_claimed: 'family says they have paid',
  payment_verified: 'payment verified',
  feedback_received: 'feedback received',
  next_chemo_set: 'next chemo date set',
  opted_out: 'a participant opted out of WhatsApp',
  case_cancelled: 'case cancelled',
  case_archived: 'case closed',
};

// deno-lint-ignore no-explicit-any
async function caseLine(c: any, idx: number): Promise<string> {
  const patient = c.patients as { full_name?: string } | null;
  const nurse = c.nurses as { full_name?: string } | null;
  const name = patient?.full_name ?? 'Patient';
  const head = `${idx}) *${name}* (${c.case_code}) — ${STATUS_LABEL[c.status] ?? String(c.status).toUpperCase()}`;

  const details: string[] = [];
  if (c.status === 'offering') {
    const { data: offers } = await db.from('case_offers').select('response').eq('case_id', c.id);
    const yes = (offers ?? []).filter((o) => o.response === 'yes').length;
    details.push(`offers with ${(offers ?? []).length} nurse(s) — ${yes ? `${yes} accepted, team to confirm` : 'awaiting replies'}`);
  }
  if (['assigned', 'consented', 'otp_sent', 'in_care'].includes(c.status) && nurse?.full_name) {
    details.push(`nurse ${nurse.full_name} · session ${fmtT(c.scheduled_at)}`);
  }
  if (['assigned', 'otp_sent'].includes(c.status)) {
    const { data: consent } = await db.from('consents').select('agreed').eq('case_id', c.id).maybeSingle();
    if (!consent) details.push('consent: awaiting the family');
    else details.push(consent.agreed ? 'consent: signed ✔' : 'consent: DECLINED — team following up');
  }
  {
    const { data: check } = await db
      .from('availability_checks')
      .select('kind, deadline_at, nurse_phone')
      .eq('case_id', c.id)
      .eq('response', 'pending')
      .maybeSingle();
    if (check) {
      details.push(`⏳ waiting on the ${check.kind === 'standby' ? 'STANDBY' : ''} nurse's "are you going?" reply (until ${fmtT(check.deadline_at, false)})`);
    }
  }
  if (c.status === 'otp_sent') details.push('arrival code with the family — waiting for the nurse to verify at the door');
  if (c.status === 'in_care' && c.arrival_verified_at) details.push(`running since ${fmtT(c.arrival_verified_at, false)}`);
  if (['awaiting_payment', 'paid', 'care_done'].includes(c.status)) {
    const { data: inv } = await db.from('invoices').select('invoice_no, total_inr, status').eq('case_id', c.id).maybeSingle();
    if (inv) {
      const st = inv.status === 'paid_verified' ? 'paid & verified ✔' : inv.status === 'paid_claimed' ? 'family says paid — verifying' : 'awaiting payment';
      details.push(`invoice ${inv.invoice_no} ₹${Number(inv.total_inr ?? 0).toLocaleString('en-IN')} — ${st}`);
    }
  }
  if (c.next_chemo_at) details.push(`📅 next chemo ${fmtT(c.next_chemo_at)}`);

  const { data: ev } = await db
    .from('case_events')
    .select('event_type, created_at')
    .eq('case_id', c.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ev) details.push(`last: ${EVENT_PHRASE[ev.event_type] ?? ev.event_type.replaceAll('_', ' ')} (${fmtT(ev.created_at, false)})`);

  return [head, ...details.map((d) => `   ${d}`)].join('\n');
}

const CASE_SELECT =
  'id, case_code, status, scheduled_at, arrival_verified_at, next_chemo_at, ' +
  'patients:patient_id(full_name), nurses:assigned_nurse_id(full_name)';

/**
 * Build the digest for a phone, or null when this phone observes no cases
 * (caller lets the message flow on to the relay).
 */
export async function buildStatusDigest(phone: string): Promise<string | null> {
  const p = normPhone(phone);

  // POC participations (live cases).
  const { data: pocParts } = await db
    .from('case_participants')
    .select(`case_id, cases!inner(${CASE_SELECT})`)
    .eq('phone', p)
    .eq('role', 'poc')
    .eq('active', true)
    .not('cases.status', 'in', '("cancelled","archived")')
    .limit(12);

  // Referring-doctor cases.
  const { data: doctor } = await db.from('doctors').select('id').eq('phone', p).maybeSingle();
  let docCases: unknown[] = [];
  if (doctor) {
    const { data } = await db
      .from('cases')
      .select(CASE_SELECT)
      .eq('doctor_id', doctor.id)
      .not('status', 'in', '("cancelled","archived")')
      .order('updated_at', { ascending: false })
      .limit(12);
    docCases = data ?? [];
  }

  // deno-lint-ignore no-explicit-any
  const byId = new Map<string, any>();
  for (const row of pocParts ?? []) byId.set((row as { case_id: string }).case_id, (row as { cases: unknown }).cases);
  for (const c of docCases) byId.set((c as { id: string }).id, c);
  if (byId.size === 0) return null;

  const cases = [...byId.values()].slice(0, 8);
  const lines: string[] = [];
  let i = 1;
  for (const c of cases) {
    try {
      lines.push(await caseLine(c, i++));
    } catch (e) {
      console.error('digest caseLine failed:', e);
    }
  }
  const now = new Date().toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  let out = `📔 Your patients — status at ${now}\n\n${lines.join('\n\n')}`;
  if (byId.size > cases.length) out += `\n\n(+${byId.size - cases.length} more patient(s) — ask the team for the full list)`;
  // WhatsApp free text hard-caps at 4096 — trim explicitly instead of a silent mid-word cut.
  if (out.length > 3700) out = `${out.slice(0, 3700)}\n… (trimmed — too many active cases for one message)`;
  return `${out}\n\nReply STATUS anytime for a fresh update.`;
}
