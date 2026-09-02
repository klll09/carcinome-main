// Access-control check for the chat server. Run against the DEMO store:
//   node index.mjs   (in one shell, CHAT_STORE=demo)
//   node test-access.mjs
//
// Asserts the rule the whole feature rests on: a patient sees only their own
// case rooms, a nurse only the cases allotted to her, a doctor only the ones
// they referred, an admin sees all — and that naming someone else's room id
// directly is refused rather than quietly honoured.
import { io } from 'socket.io-client';

const URL = process.env.CHAT_URL ?? 'http://localhost:3001';
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) { console.log(`    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`); failures++; }
}

function connect(token, kind = 'portal') {
  return new Promise((resolve, reject) => {
    const s = io(URL, { auth: { token, kind }, transports: ['websocket'], timeout: 5000 });
    s.once('ready', () => resolve(s));
    s.once('connect_error', (e) => reject(new Error(e.message)));
  });
}

const ask = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));

// ── room visibility, per role ───────────────────────────────────────────────
const patient = await connect('sample-patient');   // Meera
const nurse = await connect('sample-nurse');       // Asha
const doctor = await connect('sample-doctor');     // Dr Mehta
const admin = await connect('any-admin-jwt', 'admin');

const codes = async (s) => (await ask(s, 'rooms:list', {})).rooms.map((r) => r.case_code).sort();

// Meera is the patient on 0028 and 0034 — but NOT 0031 (that is Ramesh).
check('patient sees only their own cases', await codes(patient), ['CASE-2026-0028', 'CASE-2026-0034']);
// Asha is allotted 0031 and 0028; 0034 belongs to nurse Priya.
check('nurse sees only cases allotted to her', await codes(nurse), ['CASE-2026-0028', 'CASE-2026-0031']);
// Dr Mehta referred 0031 and 0028; 0034 has no doctor.
check('doctor sees only cases they referred', await codes(doctor), ['CASE-2026-0028', 'CASE-2026-0031']);
check('admin sees every case', await codes(admin), ['CASE-2026-0028', 'CASE-2026-0031', 'CASE-2026-0034']);

// ── the important negative: naming a room you were not given ───────────────
check('patient cannot join a room that is not theirs',
  (await ask(patient, 'room:join', { caseId: 'case-0031' })).error, 'forbidden');
check('patient cannot post into a room that is not theirs',
  (await ask(patient, 'message:send', { caseId: 'case-0031', text: 'hello' })).error, 'forbidden');
check('nurse cannot join another nurse\'s case',
  (await ask(nurse, 'room:join', { caseId: 'case-0034' })).error, 'forbidden');
check('unknown room id is refused',
  (await ask(patient, 'room:join', { caseId: 'no-such-case' })).error, 'forbidden');

// ── a bad credential never connects at all ─────────────────────────────────
let rejected = null;
try { await connect('not-a-real-token'); } catch (e) { rejected = e.message; }
check('an invalid token is rejected at the handshake', rejected, 'not_authorised');

// ── delivery: everyone in the room gets the message, nobody else ───────────
await ask(nurse, 'room:join', { caseId: 'case-0028' });
await ask(patient, 'room:join', { caseId: 'case-0028' });
await ask(doctor, 'room:join', { caseId: 'case-0031' });   // a DIFFERENT room

const heard = { patient: 0, doctor: 0 };
patient.on('message:new', () => { heard.patient++; });
doctor.on('message:new', () => { heard.doctor++; });

await ask(nurse, 'message:send', { caseId: 'case-0028', text: 'Coming at 4pm.' });
await new Promise((r) => setTimeout(r, 400));

check('the other member of the room received it', heard.patient, 1);
check('someone in a different room did NOT', heard.doctor, 0);

// ── admin can write into any room ──────────────────────────────────────────
const adminSend = await ask(admin, 'message:send', { caseId: 'case-0034', text: 'Team here — noted.' });
check('admin can post into a room they are not a member of', adminSend.ok, true);
check('admin message is attributed to the care team', adminSend.message?.role, 'ops');

for (const s of [patient, nurse, doctor, admin]) s.close();
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
