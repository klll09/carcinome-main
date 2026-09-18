#!/usr/bin/env node
// End-to-end pipeline rehearsal with SYNTHETIC actors.
// Drives: register → offer/accept → assign → consent → OTP → relay →
//         completion → docgen PDFs → invoice → paid claim → verify → archive.
// WhatsApp sends will show status 'failed' (test-number whitelist) — that is
// EXPECTED; what this proves is routing, state transitions, ledger discipline,
// ranking, OTP handshake, docgen, and the payment loop.
// Usage: node scripts/e2e_pilot.mjs [--keep]   (--keep = don't archive at the end)

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of existsSync(resolve(root, '.env')) ? readFileSync(resolve(root, '.env'), 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { SUPABASE_URL, SUPABASE_PAT, SUPABASE_PROJECT_REF, SUPABASE_PUBLISHABLE_KEY, ADMIN_PASSWORD } = process.env;
const KEEP = process.argv.includes('--keep');

// Synthetic actor phones (impossible-but-valid-shaped numbers; sends will fail, which is fine)
// doctor === nurse1 ON PURPOSE: mirrors the two-phone rehearsal (staff phone =
// nurse + doctor) and exercises the multi-role participant machinery for real.
const P = { patient: '919000000010', doctor: '919000000001', nurse1: '919000000001', nurse2: '919000000002', supplier: '919000000003' };

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
};

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`SQL failed: ${t.slice(0, 300)}`);
  try { return JSON.parse(t); } catch { return []; }
}

async function until(name, query, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rows = await sql(query);
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}

function fakeHook(...args) {
  execFileSync('node', [resolve(root, 'scripts/fake_webhook.mjs'), ...args], { stdio: 'pipe' });
}

async function adminLogin() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@carcinome.com', password: ADMIN_PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('admin login failed: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function adminAction(jwt, action, params) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/admin-actions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ action, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

// ─── Run ─────────────────────────────────────────────────────────────────────
console.log('E2E pilot rehearsal — synthetic actors\n');

console.log('0. Cleanup previous synthetic run');
await sql(`
  DELETE FROM case_events WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM messages WHERE phone IN ('${Object.values(P).join("','")}') OR case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM otps WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM consents WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM completion_reports WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM feedback WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM invoices WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM case_offers WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM case_participants WHERE case_id IN (SELECT id FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}'));
  DELETE FROM cases WHERE patient_id IN (SELECT id FROM patients WHERE wa_number = '${P.patient}');
  DELETE FROM patients WHERE wa_number = '${P.patient}';
  DELETE FROM doctors WHERE phone = '${P.doctor}';
  DELETE FROM nurses WHERE phone IN ('${P.nurse1}','${P.nurse2}');
  DELETE FROM suppliers WHERE phone = '${P.supplier}';
  DELETE FROM conversation_state WHERE phone IN ('${Object.values(P).join("','")}');
  SELECT 1 AS done;
`);
console.log('  ✓ cleaned');

console.log('1. Admin login');
const jwt = await adminLogin();
ok('admin JWT obtained', !!jwt);

console.log('2. Seed nurses + supplier (direct insert, service path)');
const seeded = await sql(`
  INSERT INTO nurses (full_name, phone, language_pref) VALUES
    ('Anita Test-Nurse', '${P.nurse1}', 'en'),
    ('Priya Test-Nurse', '${P.nurse2}', 'hi');
  INSERT INTO suppliers (name, phone, language_pref) VALUES ('MedEquip Test', '${P.supplier}', 'en');
  SELECT id, full_name FROM nurses WHERE phone IN ('${P.nurse1}','${P.nurse2}') ORDER BY phone;
`);
ok('2 nurses + supplier seeded', seeded.length === 2);
const nurse1Id = seeded.find((n) => n.full_name.startsWith('Anita'))?.id;
const nurse2Id = seeded.find((n) => n.full_name.startsWith('Priya'))?.id;
const [supplierRow] = await sql(`SELECT id FROM suppliers WHERE phone = '${P.supplier}'`);

console.log('3. register_case (admin-actions)');
const tomorrow10IST = new Date(Date.now() + 24 * 3600 * 1000);
tomorrow10IST.setUTCHours(4, 30, 0, 0); // 10:00 IST
const reg = await adminAction(jwt, 'register_case', {
  patient: {
    full_name: 'Meera Test-Patient', phone: P.patient, wa_number: P.patient,
    cancer_type: 'Breast cancer', address: '12 Rose Villa, Andheri West, Mumbai 400058',
    locality: 'Andheri West', pincode: '400058', language_pref: 'en',
  },
  doctor: { full_name: 'Dr Rajesh Test', phone: P.doctor, language_pref: 'en' },
  line_type: 'picc', care_type: 'chemo_infusion',
  scheduled_at: tomorrow10IST.toISOString(),
  address: '12 Rose Villa, Andheri West, Mumbai 400058',
  equipment_notes: 'IV stand, infusion pump, PICC dressing kit',
  supplier_ids: supplierRow ? [supplierRow.id] : [],
  notes: 'E2E synthetic case',
});
ok('register_case returned case_id', !!reg.case_id, reg.case_code || JSON.stringify(reg).slice(0, 120));
const caseId = reg.case_id;

const offers = await until('offers', `SELECT id FROM case_offers WHERE case_id = '${caseId}'`, 30000);
ok('offers created for both nurses', offers.length === 2);
const regMsgs = await until('registration fan-out', `SELECT count(*) n FROM messages WHERE case_id = '${caseId}' AND direction = 'out' AND msg_type = 'template' HAVING count(*) >= 5`, 30000);
ok('registration fan-out messages ledgered (≥5: patient, doctor, supplier, 2 offers)', regMsgs.length === 1, `${regMsgs[0]?.n ?? '<5'} outbound templates`);
const [caseRow0] = await sql(`SELECT status FROM cases WHERE id = '${caseId}'`);
ok("case status = 'offering'", caseRow0?.status === 'offering', caseRow0?.status);

console.log('4. Nurse 1 taps Accept (template button webhook)');
fakeHook('button', P.nurse1, `offer_yes:${caseId}`);
const yes = await until('offer yes', `SELECT response_rank FROM case_offers WHERE case_id = '${caseId}' AND nurse_id = '${nurse1Id}' AND response = 'yes'`);
ok('nurse1 response=yes rank=1', yes[0]?.response_rank === 1, `rank=${yes[0]?.response_rank}`);

console.log('4b. Nurse 2 also Accepts (rank #2 → the ranked standby later)');
fakeHook('button', P.nurse2, `offer_yes:${caseId}`);
const yes2 = await until('offer yes 2', `SELECT response_rank FROM case_offers WHERE case_id = '${caseId}' AND nurse_id = '${nurse2Id}' AND response = 'yes'`);
ok('nurse2 response=yes rank=2', yes2[0]?.response_rank === 2, `rank=${yes2[0]?.response_rank}`);

console.log('5. Assign nurse 1 (admin-actions)');
const asg = await adminAction(jwt, 'assign_nurse', { case_id: caseId, nurse_id: nurse1Id });
ok('assign_nurse ok', asg.ok === true, JSON.stringify(asg).slice(0, 100));
const [caseRow1] = await until('assigned', `SELECT status, assigned_nurse_id FROM cases WHERE id = '${caseId}' AND status = 'assigned'`);
ok("case status = 'assigned' to nurse1", caseRow1?.assigned_nurse_id === nurse1Id);
const closedMsg = await until('offer_closed to nurse2', `SELECT id FROM messages WHERE case_id = '${caseId}' AND phone = '${P.nurse2}' AND template_name LIKE 'offer_closed%'`, 25000);
ok('offer_closed sent to nurse2', closedMsg.length >= 1);
const dualRows = await sql(`SELECT role FROM case_participants WHERE case_id = '${caseId}' AND phone = '${P.nurse1}' AND active ORDER BY role`);
const dualRoles = new Set(dualRows.map((r) => r.role));
ok('multi-role: phone1 holds BOTH doctor and nurse participant rows',
  dualRows.length === 2 && dualRoles.has('doctor') && dualRoles.has('nurse'),
  dualRows.map((r) => r.role).join('+'));
const consentMirror = await until('doctor mirror: consent sent',
  `SELECT id FROM messages WHERE case_id = '${caseId}' AND direction = 'out' AND participant_role = 'doctor' AND body ILIKE '%consent form has been sent%'`, 25000);
ok('doctor mirror: "consent form sent" arrived', consentMirror.length >= 1);

console.log("5b. Availability check — 'are you going?' to nurse1");
const avail = await adminAction(jwt, 'check_availability', { case_id: caseId });
ok('check_availability ok', avail.ok === true, JSON.stringify(avail).slice(0, 100));
const primCheck = await until('primary check pending', `SELECT id FROM availability_checks WHERE case_id = '${caseId}' AND kind = 'primary' AND response = 'pending'`);
ok('primary availability check row (pending)', primCheck.length === 1);

console.log("5c. Nurse1 taps \"No, can't go\" → standby cascade");
fakeHook('ibutton', P.nurse1, `avail_no:${caseId}`);
const primNo = await until('primary=no', `SELECT id FROM availability_checks WHERE case_id = '${caseId}' AND kind = 'primary' AND response = 'no'`);
ok('primary check resolved: no', primNo.length === 1);
const standbyRow = await until('standby pinged', `SELECT nurse_id FROM availability_checks WHERE case_id = '${caseId}' AND kind = 'standby' AND response = 'pending'`, 25000);
ok('standby check pinged at nurse2 (ranked yes-offer #2)', standbyRow[0]?.nurse_id === nurse2Id);
const standbyMirror = await until('doctor mirror: standby', `SELECT id FROM messages WHERE case_id = '${caseId}' AND participant_role = 'doctor' AND body ILIKE '%can no longer attend%'`, 25000);
ok('doctor mirror: "nurse can no longer attend" arrived', standbyMirror.length >= 1);

console.log('5d. Nurse2 replies YES → auto-reassign');
fakeHook('text', P.nurse2, 'YES');
const [reassigned] = await until('auto-reassigned', `SELECT assigned_nurse_id FROM cases WHERE id = '${caseId}' AND assigned_nurse_id = '${nurse2Id}'`, 30000);
ok('case AUTO-REASSIGNED to nurse2 (no dashboard touch)', reassigned?.assigned_nurse_id === nurse2Id);
const standbyYes = await sql(`SELECT id FROM availability_checks WHERE case_id = '${caseId}' AND kind = 'standby' AND response = 'yes'`);
ok('standby check resolved: yes', standbyYes.length === 1);
const partsAfter = await sql(`SELECT phone, role, active FROM case_participants WHERE case_id = '${caseId}' AND role = 'nurse' ORDER BY phone`);
const n1Row = partsAfter.find((r) => r.phone === P.nurse1);
const n2Row = partsAfter.find((r) => r.phone === P.nurse2);
ok('participant swap: nurse1 row retired, nurse2 row active (doctor row untouched)',
  n1Row?.active === false && n2Row?.active === true);
const doctorStillActive = await sql(`SELECT active FROM case_participants WHERE case_id = '${caseId}' AND phone = '${P.nurse1}' AND role = 'doctor'`);
ok('doctor row on phone1 still active after nurse-row retirement', doctorStillActive[0]?.active === true);
// standby_accepted logs AFTER the reassignment fan-out finishes — poll for it.
const evAccepted = await until('standby_accepted event',
  `SELECT id FROM case_events WHERE case_id = '${caseId}' AND event_type = 'standby_accepted'`, 30000);
const evAvail = await sql(`SELECT event_type FROM case_events WHERE case_id = '${caseId}' AND event_type IN ('availability_check_sent','availability_declined','standby_pinged','standby_accepted','nurse_reassigned') ORDER BY id`);
ok('availability event trail complete', evAccepted.length >= 1 && evAvail.length >= 5, evAvail.map((e) => e.event_type).join(' → '));

console.log('6. Patient submits consent flow (nfm_reply webhook)');
fakeHook('flow', P.patient, `consent_v1:${caseId}:e2etest1`, JSON.stringify({ signed_name: 'Meera Test-Patient', relationship: 'Self', consent_care: true, consent_data: true }));
const consent = await until('consent row', `SELECT agreed FROM consents WHERE case_id = '${caseId}'`);
ok('consent recorded agreed=true', consent[0]?.agreed === true);
const [caseRow2] = await sql(`SELECT status, consented_at FROM cases WHERE id = '${caseId}'`);
ok("case status = 'consented'", caseRow2?.status === 'consented' && !!caseRow2?.consented_at, caseRow2?.status);
const signedMirror = await until('doctor mirror: consent signed',
  `SELECT id FROM messages WHERE case_id = '${caseId}' AND participant_role = 'doctor' AND body ILIKE '%signed by%'`, 25000);
ok('doctor mirror: "consent signed by …" arrived', signedMirror.length >= 1);

console.log('7. Issue OTP (admin-actions) + nurse2 (now assigned) verifies');
const otpRes = await adminAction(jwt, 'issue_otp', { case_id: caseId });
ok('issue_otp ok', otpRes.ok === true, JSON.stringify(otpRes).slice(0, 100));
const otpRows = await until('otp row', `SELECT code FROM otps WHERE case_id = '${caseId}' AND status = 'active'`);
ok('active OTP row exists', otpRows.length === 1);
const otpCode = otpRows[0]?.code;
const otpMirror = await until('doctor mirror: otp issued',
  `SELECT body FROM messages WHERE case_id = '${caseId}' AND participant_role = 'doctor' AND body ILIKE '%arrival verification code%'`, 25000);
ok('doctor mirror: "arrival code issued" arrived (and never contains the code)',
  otpMirror.length >= 1 && !otpMirror.some((m) => m.body.includes(otpCode)));
const wrongCode = otpCode === '000000' ? '111111' : '000000';
fakeHook('text', P.nurse2, wrongCode);
const wrongAttempt = await until('wrong attempt counted', `SELECT attempts FROM otps WHERE case_id = '${caseId}' AND status = 'active' AND attempts = 1`);
ok('wrong code increments attempts', wrongAttempt.length === 1);
fakeHook('text', P.nurse2, otpCode);
const verified = await until('otp verified', `SELECT status FROM otps WHERE case_id = '${caseId}' AND status = 'verified'`);
ok('OTP verified', verified.length === 1);
const [caseRow3] = await sql(`SELECT status, arrival_verified_at FROM cases WHERE id = '${caseId}'`);
ok("case status = 'in_care' + arrival timestamp", caseRow3?.status === 'in_care' && !!caseRow3?.arrival_verified_at, caseRow3?.status);

console.log('8. Relay: patient sends a free-form message');
fakeHook('text', P.patient, 'The nurse has arrived, everything is fine. Thank you!');
const relayed = await until('relay copies', `SELECT id FROM messages WHERE case_id = '${caseId}' AND relay_of IS NOT NULL`, 25000);
ok('relay fan-out copies created (nurse gets it; doctor=milestones skipped)', relayed.length >= 1, `${relayed.length} copies`);

console.log('9. Nurse2 submits completion flow → docgen → invoice → delivery');
fakeHook('flow', P.nurse2, `completion_v1:${caseId}:e2etest2`, JSON.stringify({ meds_administered: 'Paclitaxel 175mg/m2 IV over 3h', started_hhmm: '10:15', ended_hhmm: '13:30', complications: 'none', complication_notes: '', notes: 'Session uneventful. Patient stable.' }));
const report = await until('completion report', `SELECT id FROM completion_reports WHERE case_id = '${caseId}'`);
ok('completion report recorded', report.length === 1);
const inv = await until('invoice sent', `SELECT invoice_no, status, total_inr, pdf_path FROM invoices WHERE case_id = '${caseId}' AND status = 'sent'`, 150000);
ok('invoice created + sent', inv.length === 1, `${inv[0]?.invoice_no} ₹${inv[0]?.total_inr}`);
ok('invoice PDF generated (docgen ran)', !!inv[0]?.pdf_path, inv[0]?.pdf_path);
const [caseRow4] = await sql(`SELECT status FROM cases WHERE id = '${caseId}'`);
ok("case status = 'awaiting_payment'", caseRow4?.status === 'awaiting_payment', caseRow4?.status);
const docs = await sql(`SELECT name FROM storage.objects WHERE bucket_id = 'case-docs' AND name LIKE 'cases/${caseId}/%' ORDER BY name`);
ok('both PDFs in storage (invoice + discharge summary)', docs.length >= 2, docs.map((d) => d.name.split('/').pop()).join(', '));
const invoiceMirror = await sql(`SELECT id FROM messages WHERE case_id = '${caseId}' AND participant_role = 'doctor' AND body ILIKE '%discharge summary copy%'`);
ok('doctor mirror: "session complete + invoice" arrived', invoiceMirror.length >= 1);

console.log('10. Patient claims payment → admin verifies');
fakeHook('button', P.patient, `paid_claim:${caseId}`);
const claimed = await until('paid_claimed', `SELECT id FROM invoices WHERE case_id = '${caseId}' AND status = 'paid_claimed'`);
ok("invoice status = 'paid_claimed'", claimed.length === 1);
const claimMirror = await until('doctor mirror: paid claim',
  `SELECT id FROM messages WHERE case_id = '${caseId}' AND participant_role = 'doctor' AND body ILIKE '%marked the invoice%'`, 25000);
ok('doctor mirror: "patient marked invoice paid" arrived', claimMirror.length >= 1);
const mpv = await adminAction(jwt, 'mark_paid_verified', { case_id: caseId });
ok('mark_paid_verified ok', mpv.ok === true, JSON.stringify(mpv).slice(0, 100));
const [caseRow5] = await sql(`SELECT status FROM cases WHERE id = '${caseId}'`);
const [invRow5] = await sql(`SELECT status FROM invoices WHERE case_id = '${caseId}'`);
ok("case 'paid' + invoice 'paid_verified'", caseRow5?.status === 'paid' && invRow5?.status === 'paid_verified', `${caseRow5?.status}/${invRow5?.status}`);

console.log('11. Feedback flow (patient)');
fakeHook('flow', P.patient, `feedback_v1:${caseId}:e2etest3`, JSON.stringify({ overall: '5', nurse_care: '5', recommend: true, comments: 'Wonderful care at home. Thank you!' }));
const fb = await until('feedback row', `SELECT overall_rating FROM feedback WHERE case_id = '${caseId}'`);
ok('feedback recorded (5/5)', fb[0]?.overall_rating === 5);
const fbMirror = await until('doctor mirror: feedback',
  `SELECT id FROM messages WHERE case_id = '${caseId}' AND participant_role = 'doctor' AND body ILIKE '%shared feedback%'`, 25000);
ok('doctor mirror: "patient shared feedback" arrived', fbMirror.length >= 1);

console.log('11b. Doctor sets the next chemo date (NEXT keyword)');
fakeHook('text', P.doctor, 'NEXT 25/12');
const chemo = await until('next_chemo set', `SELECT next_chemo_at, next_chemo_set_by FROM cases WHERE id = '${caseId}' AND next_chemo_at IS NOT NULL`, 25000);
ok('cases.next_chemo_at set by the doctor', !!chemo[0]?.next_chemo_at && chemo[0]?.next_chemo_set_by === `doctor:${P.doctor}`,
  `${chemo[0]?.next_chemo_at ?? 'null'}`);
const chemoDec = String(chemo[0]?.next_chemo_at ?? '').replace('T', ' ');
ok('date parsed to 25 Dec, 09:00 IST', chemoDec.startsWith('2026-12-25 03:30'), chemoDec);
const chemoPatientMsg = await until('patient next-chemo notice',
  `SELECT id FROM messages WHERE case_id = '${caseId}' AND participant_role = 'patient' AND body ILIKE '%next chemotherapy%'`, 25000);
ok('patient told: "Dr. … has scheduled your next chemotherapy"', chemoPatientMsg.length >= 1);
const evChemo = await sql(`SELECT id FROM case_events WHERE case_id = '${caseId}' AND event_type = 'next_chemo_set'`);
ok('next_chemo_set event logged', evChemo.length >= 1);

if (!KEEP) {
  console.log('12. Archive');
  const arch = await adminAction(jwt, 'archive_case', { case_id: caseId });
  const [caseRow6] = await sql(`SELECT status FROM cases WHERE id = '${caseId}'`);
  ok("case status = 'archived'", arch.ok === true && caseRow6?.status === 'archived', caseRow6?.status);
} else {
  console.log('12. (kept — --keep flag)');
}

console.log('\n─── Ledger summary ───');
const summary = await sql(`SELECT direction, msg_type, coalesce(template_name,'(freeform)') t, status, count(*) FROM messages WHERE case_id = '${caseId}' GROUP BY 1,2,3,4 ORDER BY 1,3`);
for (const r of summary) console.log(`  ${r.direction} ${r.msg_type} ${r.t} [${r.status}] ×${r.count}`);
const events = await sql(`SELECT event_type FROM case_events WHERE case_id = '${caseId}' ORDER BY id`);
console.log('  events: ' + events.map((e) => e.event_type).join(' → '));

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exitCode = fail ? 1 : 0;
