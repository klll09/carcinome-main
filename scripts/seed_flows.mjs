#!/usr/bin/env node
// Seed the Flow Studio with the REAL deployed user flows (wa-webhook v9 era).
// Each flow is a canvas of nodes+edges laid out on a col/row grid. These are
// seeded as TEMPLATES (is_template=true): the team duplicates one to customize
// for a patient segment, or edits in place to plan copy changes.
//
// Re-runnable: replaces existing template flows by name (custom flows and
// snapshots are never touched).
// Usage: node scripts/seed_flows.mjs

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of existsSync(resolve(root, '.env')) ? readFileSync(resolve(root, '.env'), 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { SUPABASE_PAT, SUPABASE_PROJECT_REF } = process.env;
if (!SUPABASE_PAT || !SUPABASE_PROJECT_REF) {
  console.error('Missing SUPABASE_PAT / SUPABASE_PROJECT_REF in .env');
  process.exit(1);
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`SQL failed: ${t.slice(0, 400)}`);
  try { return JSON.parse(t); } catch { return []; }
}

// ─── Canvas builder helpers ─────────────────────────────────────────────────
// Grid: col → x, row → y. Cards are ~264 wide; rows leave room for 2-4 lines.
const COL_W = 344;
const ROW_H = 206;

function makeFlow() {
  const nodes = [];
  const edges = [];
  let eid = 0;
  /** n(id, col, row, spec) — spec: {type, role, title, body, channel, w} */
  const n = (id, col, row, spec) => {
    nodes.push({
      id,
      type: spec.type ?? 'message',
      x: 60 + Math.round(col * COL_W),
      y: 60 + Math.round(row * ROW_H),
      w: spec.w ?? 264,
      role: spec.role ?? 'system',
      title: spec.title ?? '',
      body: spec.body ?? '',
      channel: spec.channel ?? null,
    });
    return id;
  };
  /** e(from, to, label) */
  const e = (from, to, label = '') => {
    edges.push({ id: `e${++eid}`, from, to, label });
  };
  return { nodes, edges, n, e };
}

const B = (s) => `<b>${s}</b>`;
const I = (s) => `<i>${s}</i>`;
const Q = (s) => `<i>“${s}”</i>`;

// ═══ Flow 1 — New case: registration → assignment → consent ═════════════════
function flowRegistration() {
  const f = makeFlow();
  const { n, e } = f;

  n('reg', 0, 1.2, { type: 'trigger', role: 'team', title: 'Case registered', channel: 'admin', body: `Team registers the case on the dashboard: patient, referring doctor, care type, schedule, address, price.` });

  n('p_welcome', 1, 0, { role: 'patient', title: 'Welcome + what happens next', channel: 'template', body: `${Q('Namaste! Your home-care session is being arranged…')} Patient learns the schedule and that a nurse will be confirmed.` });
  n('d_ack', 1, 1, { role: 'doctor', title: 'Referral acknowledged', channel: 'template', body: `${Q('Thank you for referring ⟨patient⟩ — we will keep you updated at every step.')} Reply ${B('JOIN')} for full chat, ${B('MUTE')} for milestones only.` });
  n('n_offer', 1, 2, { role: 'nurse', title: 'Case offer → every eligible nurse', channel: 'buttons', body: `Area (never full address), date/time, care type. Buttons: ${B('[Accept] [Decline]')}. First-come ranking is recorded.` });
  n('s_prep', 1, 3, { role: 'supplier', title: 'Equipment prep request', channel: 'template', body: `Equipment notes + date. Re-pinged with the nurse's name once assigned.` });

  e('reg', 'p_welcome', 'instant');
  e('reg', 'd_ack', 'instant');
  e('reg', 'n_offer', 'instant fan-out');
  e('reg', 's_prep', 'if supplier chosen');

  n('accept', 2, 2, { type: 'decision', role: 'nurse', title: 'Nurse taps Accept?', body: `Accepts are ranked (#1, #2, …). The ranking powers the standby cascade later.` });
  e('n_offer', 'accept', '');

  n('assign', 3, 1.2, { type: 'trigger', role: 'team', title: 'Team assigns a nurse', channel: 'admin', body: `Dashboard → Assign. Everything downstream fires automatically from this one click.` });
  e('accept', 'assign', 'accepted list shown');

  n('n_conf', 4, 0, { role: 'nurse', title: 'Assignment + FULL address', channel: 'template', body: `Full address revealed only now. Followed by the arrival protocol: ${Q('When you REACH the home, simply send a message here — e.g. “Reached”.')}` });
  n('p_conf', 4, 1, { role: 'patient', title: 'Your nurse is confirmed', channel: 'template', body: `Nurse name + schedule.` });
  n('d_conf', 4, 2, { role: 'doctor', title: 'Mirror: nurse confirmed', channel: 'template', body: `${Q('Nurse ⟨name⟩ is confirmed for ⟨patient⟩ — you will receive the discharge summary after the session.')}` });
  n('losers', 4, 3, { role: 'nurse', title: 'Offer closed → other nurses', channel: 'template', body: `${Q('This case has been filled — we will reach out for the next one.')} Polite release, keeps the pool warm.` });
  e('assign', 'n_conf', 'instant');
  e('assign', 'p_conf', 'instant');
  e('assign', 'd_conf', 'mirror');
  e('assign', 'losers', 'instant');

  n('consent', 5, 1, { role: 'patient', title: 'Consent form (WhatsApp form)', channel: 'flow', body: `In-chat form: info → agree/decline → signature name + relation. No app, no link-outs.` });
  e('assign', 'consent', 'instant');
  n('signed', 6, 1, { type: 'decision', role: 'patient', title: 'Signed?', body: `Declines alert the team for a phone follow-up.` });
  e('consent', 'signed', '');
  n('d_signed', 7, 0.5, { role: 'doctor', title: 'Mirror: consent signed', channel: 'text', body: `${Q('✍️ the consent form has been signed by ⟨name⟩ (⟨relation⟩). Care can proceed as planned.')}` });
  n('t_signed', 7, 1.6, { role: 'team', title: 'Consent logged on the case page', channel: 'admin', body: `Timeline + signer stored; case status → ${B('consented')}.` });
  e('signed', 'd_signed', 'yes → mirror');
  e('signed', 't_signed', 'yes');

  return { name: 'New case — registration to consent', description: 'What every phone receives the moment a case is registered, assigned, and consented.', tags: ['all patients', 'core journey'], canvas: { nodes: f.nodes, edges: f.edges } };
}

// ═══ Flow 2 — “Are you going?” availability check + standby cascade ═════════
function flowAvailability() {
  const f = makeFlow();
  const { n, e } = f;

  n('ask_btn', 0, 1, { type: 'trigger', role: 'team', title: 'Ask “Are you going?”', channel: 'admin', body: `Case page button (or auto pre-session check in Settings → Automation). Never a silent assumption.` });
  n('n_ask', 1, 1, { role: 'nurse', title: 'Are you going?', channel: 'buttons', body: `${B('[Yes, on my way] [No, can’t go]')} — typed YES/NO (or हाँ/नहीं) works too. Reply window: Settings → Automation (default 20 min).` });
  e('ask_btn', 'n_ask', 'instant');

  n('dec', 2, 1, { type: 'decision', role: 'nurse', title: 'Reply?', body: `Three outcomes: Yes / No / silence past the window (a cron reaper sweeps every 5 min).` });
  e('n_ask', 'dec', '');

  n('yes_p', 3, 0, { role: 'patient', title: 'Nurse is on the way', channel: 'text', body: `${Q('Nurse ⟨name⟩ has confirmed she is coming to your session.')}` });
  n('yes_d', 3, 0.8, { role: 'doctor', title: 'Mirror: confirmed', channel: 'text', body: `Doctor-phrased confirmation.` });
  n('yes_t', 3, 1.6, { role: 'team', title: '✅ availability confirmed', channel: 'text', body: `Team sees the green tick on the case availability strip.` });
  e('dec', 'yes_p', 'YES');
  e('dec', 'yes_d', 'YES → mirror');
  e('dec', 'yes_t', 'YES');

  n('cascade', 3, 3, { type: 'trigger', role: 'system', title: 'Standby cascade starts', body: `Order: ranked yes-offers first (#2, #3…), then the eligible pool. Excludes the declining nurse and anyone who already said no / timed out.` });
  e('dec', 'cascade', 'NO or timeout');

  n('n2_ping', 4, 3, { role: 'nurse', title: '🚨 Standby ping → next nurse', channel: 'buttons', body: `${Q('Nurse ⟨A⟩ is unavailable for ⟨case⟩ — can you take this session?')} ${B('[Yes] [No]')} + its own reply window.` });
  e('cascade', 'n2_ping', 'one at a time, never stacked');

  n('dec2', 5, 3, { type: 'decision', role: 'nurse', title: 'Standby reply?', body: `` });
  e('n2_ping', 'dec2', '');

  n('reassign', 6, 2, { type: 'trigger', role: 'system', title: 'AUTO-REASSIGN', body: `No dashboard touch: participant swap, full address to the new nurse, patient + doctor + supplier renotified, old nurse politely released, consent re-checked.` });
  e('dec2', 'reassign', 'YES');
  n('exhaust', 6, 4, { role: 'team', title: '🚨 Pool exhausted — assign manually', channel: 'text', body: `Every candidate declined or timed out. Loud alarm; the case never silently stalls.` });
  e('dec2', 'exhaust', 'NO/timeout → next candidate; none left → alarm');

  n('ra_p', 7, 1.4, { role: 'patient', title: 'Your session is safe', channel: 'text', body: `${Q('Nurse ⟨B⟩ is confirmed for your session — same time, same plan.')}` });
  n('ra_d', 7, 2.2, { role: 'doctor', title: 'Mirror: reassigned', channel: 'text', body: `${Q('The assigned nurse could no longer attend; standby ⟨B⟩ has been confirmed.')}` });
  n('ra_t', 7, 3, { role: 'team', title: '🔁 auto-reassigned', channel: 'text', body: `Full audit trail on the case timeline: check → decline → ping → accept → swap.` });
  e('reassign', 'ra_p', '');
  e('reassign', 'ra_d', 'mirror');
  e('reassign', 'ra_t', '');

  return { name: '“Are you going?” — availability & standby', description: 'The nurse-silence safety net: explicit confirmation, automatic standby cascade, auto-reassignment.', tags: ['all patients', 'safety net'], canvas: { nodes: f.nodes, edges: f.edges } };
}

// ═══ Flow 3 — Arrival: typed “Reached” + code verification ══════════════════
function flowArrival() {
  const f = makeFlow();
  const { n, e } = f;

  n('reach', 0, 1, { type: 'trigger', role: 'nurse', title: 'Nurse types “Reached”', channel: 'keyword', body: `Free text in her own words — ${I('Reached / I have arrived / pahunch gayi / आ गई')}. ${B('Deliberately NOT a button')}: a button could be tapped from home. Future tense (${I('will reach by 5')}) stays normal chat.` });

  n('code_p', 1, 0.2, { role: 'patient', title: '6-digit arrival number', channel: 'text', body: `${Q('Your nurse arrival number is ⟨code⟩ — give it to nurse ⟨name⟩ in person when they arrive.')} The code lives ONLY on the patient's phone — that is the honesty lock.` });
  n('ask_n', 1, 1.2, { role: 'nurse', title: 'Ask the family for the number', channel: 'text', body: `${Q('Please ask for the arrival number and send it here — it logs your visit start time.')} Repeat “reached” never re-issues a live code; an expired one re-issues automatically.` });
  n('mir_d', 1, 2.2, { role: 'doctor', title: 'Mirror: code issued', channel: 'text', body: `🔐 doctor is told a code went out — ${B('never the code itself')}.` });
  n('t_alert', 1, 3.1, { role: 'team', title: '🚪 “nurse says she has REACHED”', channel: 'text', body: `Team sees arrival claims in real time — awaiting verification.` });
  e('reach', 'code_p', 'auto-issue (no admin)');
  e('reach', 'ask_n', 'instant');
  e('reach', 'mir_d', 'mirror');
  e('reach', 't_alert', '');

  n('type_code', 2, 1.2, { type: 'decision', role: 'nurse', title: 'Nurse types the 6 digits', body: `5 wrong attempts → code locks + team alarm. Re-issue from the dashboard.` });
  e('ask_n', 'type_code', '');

  n('ver_p', 3, 0.2, { role: 'patient', title: '✅ Arrival verified — session started', channel: 'text', body: `Timestamped confirmation.` });
  n('ver_n', 3, 1.2, { role: 'nurse', title: '✅ Session started + DONE button', channel: 'buttons', body: `${Q('When care is complete, tap below or reply DONE.')} ${B('[Mark care complete]')}` });
  n('ver_d', 3, 2.2, { role: 'doctor', title: 'Mirror: nurse arrived, verified', channel: 'text', body: `🩺 session in progress.` });
  n('ver_t', 3, 3.1, { role: 'team', title: '✅ arrival verified at ⟨time⟩', channel: 'text', body: `Case status → ${B('in care')}; arrival time on the case header.` });
  e('type_code', 'ver_p', 'correct code');
  e('type_code', 'ver_n', 'correct code');
  e('type_code', 'ver_d', 'mirror');
  e('type_code', 'ver_t', '');

  return { name: 'Arrival — typed “Reached” + code handshake', description: 'Honesty by design: the announcement is typed, the proof is the code only the patient holds.', tags: ['all patients', 'core journey'], canvas: { nodes: f.nodes, edges: f.edges } };
}

// ═══ Flow 4 — Session ending → report → invoice + discharge ═════════════════
function flowEnding() {
  const f = makeFlow();
  const { n, e } = f;

  n('n_end', 0, 0.4, { type: 'trigger', role: 'nurse', title: 'Nurse says it’s over', channel: 'keyword', body: `Exact ${B('DONE')} → straight to the report form. Fuzzy — ${I('session over / all done / ho gaya')} — gets one confirm first.` });
  n('p_end', 0, 2.6, { type: 'trigger', role: 'patient', title: 'Patient says it’s over', channel: 'keyword', body: `${I('ho gaya / nurse finished / session over')} — the family can close the loop too.` });

  n('n_conf', 1, 0.4, { role: 'nurse', title: 'Confirm: fully complete?', channel: 'buttons', body: `${B('[✅ Yes, complete] [Just a message]')} — “Just a message” relays the text as normal chat instead. A false ending must never fire the bill.` });
  n('p_conf', 1, 2.6, { role: 'patient', title: 'Confirm: nurse finished?', channel: 'buttons', body: `${B('[✅ Yes, finished] [Just a message]')}` });
  e('n_end', 'n_conf', 'fuzzy phrase');
  e('p_end', 'p_conf', '');

  n('report', 2, 1.2, { role: 'nurse', title: 'Completion report (WhatsApp form)', channel: 'flow', body: `Vitals, medicines given, complications — about a minute. This form is the trigger for everything below.` });
  e('n_end', 'report', 'exact DONE — no confirm');
  e('n_conf', 'report', 'Yes');
  n('nudge', 2, 2.6, { role: 'nurse', title: 'Family says it’s done — please file', channel: 'flow', body: `Patient-confirmed ending nudges the NURSE with the same form; doctor mirrored; team alerted to chase.` });
  e('p_conf', 'nudge', 'Yes');
  e('nudge', 'report', 'nurse submits');

  n('docgen', 3, 1.2, { type: 'trigger', role: 'system', title: 'Auto: PDFs generated', body: `Invoice PDF + discharge summary PDF, built and stored the moment the report lands.` });
  e('report', 'docgen', 'on submit');

  n('inv_p', 4, 0, { role: 'patient', title: 'Invoice PDF + Pay now', channel: 'document', body: `Invoice number, amount, case code — with the payment card right behind it (see the Payment flow).` });
  n('dis_p', 4, 1, { role: 'patient', title: 'Discharge summary PDF', channel: 'document', body: `The session, in writing, forever on their phone.` });
  n('dis_d', 4, 2, { role: 'doctor', title: 'Discharge summary PDF (doctor copy)', channel: 'document', body: `Unconditional — arrives even when the doctor has muted chat updates.` });
  n('mir_d', 4, 3, { role: 'doctor', title: 'Mirror: session complete + invoice', channel: 'text', body: `🧾 ${Q('session complete, Invoice ⟨no⟩ (₹⟨amt⟩) sent to the patient…')}` });
  e('docgen', 'inv_p', '');
  e('docgen', 'dis_p', '');
  e('docgen', 'dis_d', 'unconditional');
  e('docgen', 'mir_d', 'mirror');

  return { name: 'Session ending — report, invoice, discharge', description: 'Either side can end the session in their own words; the report form fires the bill + discharge cascade.', tags: ['all patients', 'core journey'], canvas: { nodes: f.nodes, edges: f.edges } };
}

// ═══ Flow 5 — Payment (UPI in WhatsApp) → verify → feedback ═════════════════
function flowPayment() {
  const f = makeFlow();
  const { n, e } = f;

  n('order', 0, 1, { role: 'patient', title: 'UPI payment card in WhatsApp', channel: 'payment', body: `Native order card: ${B('Review and Pay')} opens the UPI app pre-filled (upi_intent_link to our VPA — no gateway, no fees). Followed by the ${B('[I’ve paid]')} button.` });
  n('claim', 1, 1, { type: 'decision', role: 'patient', title: 'Patient taps “I’ve paid”', body: `Self-declared — verification stays with the team (no gateway = no automatic webhook).` });
  e('order', 'claim', '');

  n('mir1', 2, 0.2, { role: 'doctor', title: 'Mirror: payment claimed', channel: 'text', body: `💰 ${Q('patient marked invoice as paid — team is verifying.')}` });
  n('t_ver', 2, 1.8, { role: 'team', title: 'Verify against the bank, then confirm', channel: 'admin', body: `Dashboard → ${B('Mark paid verified')}. The human check is the point.` });
  e('claim', 'mir1', 'mirror');
  e('claim', 't_ver', '');

  n('rcpt_p', 3, 0.2, { role: 'patient', title: 'Payment received ✅', channel: 'template', body: `Amount + invoice number.` });
  n('rcpt_d', 3, 1, { role: 'doctor', title: 'Payment received (doctor copy)', channel: 'template', body: `Everything settled — followed by the ${B('📅 Set next chemo')} invitation.` });
  n('fb', 3, 1.9, { role: 'patient', title: 'Feedback form', channel: 'flow', body: `Stars for overall + nurse, recommend yes/no, free text.` });
  e('t_ver', 'rcpt_p', 'verified');
  e('t_ver', 'rcpt_d', 'verified');
  e('t_ver', 'fb', 'after receipt');

  n('fb_d', 4, 1.9, { role: 'doctor', title: 'Mirror: feedback stars', channel: 'text', body: `${Q('overall ⟨x⟩/5, nurse ⟨y⟩/5 — would recommend.')}` });
  e('fb', 'fb_d', 'on submit → mirror');

  return { name: 'Payment — UPI in chat, human-verified', description: 'WhatsApp-native UPI payment, the I’ve-paid claim, team verification, receipts, feedback.', tags: ['all patients', 'money'], canvas: { nodes: f.nodes, edges: f.edges } };
}

// ═══ Flow 6 — Next chemo date (doctor) ══════════════════════════════════════
function flowNextChemo() {
  const f = makeFlow();
  const { n, e } = f;

  n('invite', 0, 1, { role: 'doctor', title: '📅 Set next chemo (invitation)', channel: 'buttons', body: `Sent after the discharge summary and again after payment verified. The ${B('NEXT ⟨date⟩')} keyword works anytime without the button.` });
  n('entry', 1, 1, { type: 'decision', role: 'doctor', title: 'Doctor sends a date', channel: 'keyword', body: `${I('24/07 · 24 Jul · NEXT tomorrow')} — day-first, Hindi words ok, garbled dates get a gentle re-prompt, past dates refused, CANCEL abandons.` });
  e('invite', 'entry', 'tap or type');

  n('c_doc', 2, 0.2, { role: 'doctor', title: '✅ Date set — confirmation', channel: 'text', body: `${Q('Next chemo for ⟨patient⟩ is set for ⟨date⟩. Reply NEXT ⟨date⟩ anytime to change it.')}` });
  n('c_pat', 2, 1.1, { role: 'patient', title: 'Dr. ⟨name⟩ scheduled your next chemo', channel: 'text', body: `${Q('…for ⟨date⟩. Our team will contact you before the date to arrange the session.')}` });
  n('c_team', 2, 2, { role: 'team', title: '📅 register the follow-up nudge', channel: 'text', body: `Case header gets the 📅 chip; team registers the next case closer to the date.` });
  e('entry', 'c_doc', 'parsed');
  e('entry', 'c_pat', 'parsed');
  e('entry', 'c_team', 'parsed');

  return { name: 'Next chemo date — set by the doctor', description: 'How the referring doctor schedules the next cycle from inside WhatsApp.', tags: ['chemo patients'], canvas: { nodes: f.nodes, edges: f.edges } };
}

// ═══ Flow 7 — Keywords the phones understand (reference card) ═══════════════
function flowKeywords() {
  const f = makeFlow();
  const { n } = f;
  const K = (id, col, row, role, title, body) => n(id, col, row, { role, title, body, channel: 'keyword' });

  n('hdr', 0, 0, { type: 'note', role: 'system', w: 580, title: 'Self-service keywords — no app, no menus', body: `Everything below is typed straight into the WhatsApp chat. Words in ${B('bold')} are exact; everything else is understood in natural EN / Hinglish / हिन्दी.` });
  K('k1', 0, 1.1, 'nurse', 'Reached / pahunch gayi / आ गई', `Arrival announcement → auto-issues the patient’s 6-digit code. Future tense stays chat.`);
  K('k2', 0, 2.1, 'nurse', 'DONE · session over · ho gaya', `${B('DONE')} opens the report instantly; fuzzy endings get one confirm button.`);
  K('k3', 0, 3.1, 'nurse', 'YES / NO · हाँ / नहीं', `Answers a pending “Are you going?” or standby ping. With several cases pending, a picker asks which one.`);
  K('k4', 1.9, 1.1, 'patient', 'ho gaya · nurse finished', `Patient-side ending → confirm → nurse nudged for the report.`);
  K('k5', 1.9, 2.1, 'patient', 'STOP · बंद', `Full opt-out on every role of that number. Team alerted; doctor mirrored for patient opt-outs. Reactivate from the dashboard.`);
  K('k6', 1.9, 3.1, 'doctor', 'NEXT ⟨date⟩ · NEXT 24/07', `Sets the next chemo date anytime. Prose starting with “Next” is left alone.`);
  K('k7', 3.8, 1.1, 'doctor', 'MUTE / JOIN', `MUTE = milestones only (discharge + payment still arrive). JOIN = full chat. Role-scoped — a nurse+doctor phone only mutes the doctor hat.`);
  K('k8', 3.8, 2.1, 'nurse', '6 digits, e.g. 482913', `An arrival code typed back = verification. Anything else 6-digit-ish falls through to normal chat.`);
  K('k9', 3.8, 3.1, 'system', 'Anything else', `Free text/photos relay to the case chat hub, attributed by role; with several cases, a picker asks which patient it is about.`);

  return { name: 'Keywords — what the phones understand', description: 'The complete typed-command surface across all roles.', tags: ['reference'], canvas: { nodes: f.nodes, edges: f.edges } };
}

// ─── Write to DB ────────────────────────────────────────────────────────────
const FLOWS = [flowRegistration(), flowAvailability(), flowArrival(), flowEnding(), flowPayment(), flowNextChemo(), flowKeywords()];

console.log('Seeding Flow Studio templates…');
let order = 10;
for (const fl of FLOWS) {
  const name = fl.name.replace(/'/g, "''");
  const desc = (fl.description ?? '').replace(/'/g, "''");
  const canvas = JSON.stringify(fl.canvas).replace(/'/g, "''");
  const tags = `{${fl.tags.map((t) => `"${t}"`).join(',')}}`;
  await sql(`
    DELETE FROM flows WHERE name = '${name}' AND is_template;
    INSERT INTO flows (name, description, tags, status, canvas, is_template, sort_order, updated_by)
    VALUES ('${name}', '${desc}', '${tags}', 'live', '${canvas}'::jsonb, true, ${order}, 'seed');
  `);
  console.log(`  ✓ ${fl.name} (${fl.canvas.nodes.length} nodes, ${fl.canvas.edges.length} edges)`);
  order += 10;
}
console.log('Done. Open the dashboard → Flows.');
