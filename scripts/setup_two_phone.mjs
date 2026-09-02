#!/usr/bin/env node
// Two-phone rehearsal wiring: ONE person, TWO numbers, FOUR roles.
//   Phone 1 → Nurse-1 (primary)  + Doctor            (+ Supervisor + Ops alerts)
//   Phone 2 → Nurse-2 (standby)  + Patient
// Multi-role participants (sql/06) make this safe: each role gets its own row;
// the relay dedupes per phone; MUTE/JOIN and milestones are role-scoped.
//
// Usage:
//   node scripts/setup_two_phone.mjs <phone1> <phone2> [--exclusive] [--timeout <min>]
//     --exclusive     mark every OTHER nurse is_eligible=false (prints who, so
//                     you can re-enable after the show). Without it you get a
//                     loud warning listing other eligible nurses.
//     --timeout <min> availability reply window (default 10 for rehearsals).
//
// Prints the role matrix + a step list at the end. Patient is NOT created here —
// you register them from the dashboard during Act 1 (use phone 2).

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

function normPhone(s) {
  let d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const exclusive = process.argv.includes('--exclusive');
const tIdx = process.argv.indexOf('--timeout');
const timeoutMin = tIdx > -1 ? Math.max(2, Number(process.argv[tIdx + 1]) || 10) : 10;

const phone1 = normPhone(args[0]);
const phone2 = normPhone(args[1]);
if (phone1.length < 12 || phone2.length < 12 || phone1 === phone2) {
  console.error('Usage: node scripts/setup_two_phone.mjs <phone1> <phone2> [--exclusive] [--timeout <min>]');
  console.error('Two DIFFERENT valid numbers required (10 digits or 91XXXXXXXXXX).');
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

console.log(`Two-phone rehearsal setup\n  Phone 1 (staff):  ${phone1}  → Nurse Asha (primary) + Dr. Arjun Mehta + team alerts`);
console.log(`  Phone 2 (family): ${phone2}  → Nurse Priya (standby) + Patient (register in Act 1)\n`);

// 1. Nurses (upsert by phone).
await sql(`
  INSERT INTO nurses (full_name, phone, language_pref, is_eligible, is_active, opted_out)
  VALUES ('Asha', '${phone1}', 'en', true, true, false),
         ('Priya', '${phone2}', 'en', true, true, false)
  ON CONFLICT (phone) DO UPDATE SET
    full_name = EXCLUDED.full_name, is_eligible = true, is_active = true, opted_out = false;
`);
console.log('✓ Nurses: Asha (phone 1, primary) + Priya (phone 2, standby) — eligible & active');

// 2. Doctor on phone 1.
await sql(`
  INSERT INTO doctors (full_name, phone, specialty, language_pref, opted_out)
  VALUES ('Dr. Arjun Mehta', '${phone1}', 'Medical Oncology', 'en', false)
  ON CONFLICT (phone) DO UPDATE SET full_name = EXCLUDED.full_name, opted_out = false;
`);
console.log('✓ Doctor: Dr. Arjun Mehta on phone 1');

// 3. Team alerts → phone 1; availability timer for the show.
await sql(`
  INSERT INTO settings (key, value) VALUES
    ('supervisor_phones', '["${phone1}"]'),
    ('ops_phones', '["${phone1}"]'),
    ('availability', '{"timeout_min": ${timeoutMin}, "auto_check": false, "check_before_min": 120}')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
`);
console.log(`✓ Supervisor + Ops alerts → phone 1 · availability reply window ${timeoutMin} min (auto-check OFF — use the case-page button)`);

// 4. Eligibility audit — offers fan out to EVERY eligible nurse.
const others = await sql(`
  SELECT full_name, phone FROM nurses
  WHERE is_eligible AND is_active AND phone NOT IN ('${phone1}', '${phone2}') ORDER BY full_name;
`);
if (others.length && exclusive) {
  await sql(`UPDATE nurses SET is_eligible = false WHERE phone NOT IN ('${phone1}', '${phone2}') AND is_eligible;`);
  console.log(`✓ --exclusive: disabled ${others.length} other nurse(s) (re-enable after the show):`);
  for (const n of others) console.log(`    · ${n.full_name} (${n.phone})`);
} else if (others.length) {
  console.log(`\n⚠️  ${others.length} OTHER eligible nurse(s) will ALSO receive the case offer:`);
  for (const n of others) console.log(`    · ${n.full_name} (${n.phone})`);
  console.log('   Re-run with --exclusive to disable them for the rehearsal.');
} else {
  console.log('✓ No other eligible nurses — offers go only to your two phones');
}

console.log(`
─── Rehearsal wiring complete ───

Role matrix (multi-role is now native — one number, several hats):
  PHONE 1 = the STAFF phone : 🩺 Nurse Asha  ·  🥼 Dr. Mehta  ·  🛟 every team alert
  PHONE 2 = the FAMILY phone: 🧑 Patient      ·  🔁 Nurse Priya (standby)

Next steps:
  1. Warm both phones: send "Hi" from each to the WhatsApp business number.
  2. Dashboard → register the case: patient = phone 2, doctor = Dr. Arjun Mehta
     (phone 1), price ₹1, scheduled today +3–4 h.
  3. Follow docs/TWO_PHONE_RUNBOOK.md act by act — including the new beats:
     · "Are you going?" check → nurse declines → STANDBY auto-ping on phone 2
     · every patient moment mirrored to the doctor in doctor phrasing
     · after discharge/payment: doctor taps 📅 Set next chemo (or types NEXT 24/07)
`);
