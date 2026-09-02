#!/usr/bin/env node
// Install pg_cron jobs that drive the scheduler edge function.
// Usage: node scripts/setup_cron.mjs
//
// Reads sql/05_cron.sql (which must keep secrets OUT of the repo via
// {{CRON_SECRET}} / {{SUPABASE_URL}} placeholders), substitutes them from
// .env, applies via the Management API, then prints the live cron.job table.
// If sql/05_cron.sql is missing, falls back to the canonical embedded job set
// (CONTRACTS §scheduler) and says so.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const p = resolve(root, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const PAT = process.env.SUPABASE_PAT;
const REF = process.env.SUPABASE_PROJECT_REF;
const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = (process.env.SUPABASE_URL || (REF ? `https://${REF}.supabase.co` : '')).replace(/\/$/, '');
if (!PAT || !REF) { console.error('Missing SUPABASE_PAT / SUPABASE_PROJECT_REF'); process.exit(1); }
if (!CRON_SECRET) { console.error('Missing CRON_SECRET in .env'); process.exit(1); }
if (!SUPABASE_URL) { console.error('Missing SUPABASE_URL in .env'); process.exit(1); }

async function runSql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

/** Never leak the secret into terminal output / logs. */
function redact(s) {
  return CRON_SECRET ? s.split(CRON_SECRET).join('***CRON_SECRET***') : s;
}

// ── Canonical fallback (only used when sql/05_cron.sql is absent) ──
// Job set + schedules per CONTRACTS §scheduler / plan: pg_cron runs in UTC.
//   reminders_24h    hourly           otp_issue   every 15 min
//   reminders_morning 08:00 IST=02:30 otp_expiry  every 5 min
//   sla_nudge        every 30 min     feedback_chaser 11:00 IST=05:30 UTC
//   archiver         daily 03:00 IST = 21:30 UTC
const FALLBACK_JOBS = [
  ['carcinome_reminders_24h', '0 * * * *', 'reminders_24h'],
  ['carcinome_reminders_morning', '30 2 * * *', 'reminders_morning'],
  ['carcinome_otp_issue', '*/15 * * * *', 'otp_issue'],
  ['carcinome_otp_expiry', '*/5 * * * *', 'otp_expiry'],
  ['carcinome_sla_nudge', '*/30 * * * *', 'sla_nudge'],
  ['carcinome_feedback_chaser', '30 5 * * *', 'feedback_chaser'],
  ['carcinome_archiver', '30 21 * * *', 'archiver'],
];

function fallbackSql() {
  const jobs = FALLBACK_JOBS.map(([name, schedule, job]) => `
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = '${name}';
SELECT cron.schedule(
  '${name}',
  '${schedule}',
  $job$
  SELECT net.http_post(
    url := '{{SUPABASE_URL}}/functions/v1/scheduler',
    body := '{"job":"${job}"}'::jsonb,
    headers := '{"Content-Type":"application/json","x-cron-secret":"{{CRON_SECRET}}"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);`).join('\n');
  return `CREATE EXTENSION IF NOT EXISTS pg_cron;\nCREATE EXTENSION IF NOT EXISTS pg_net;\n${jobs}\n`;
}

// ── Load SQL ──
const cronFile = resolve(root, 'sql', '05_cron.sql');
let sql;
if (existsSync(cronFile)) {
  sql = readFileSync(cronFile, 'utf8');
  console.log(`Using sql/05_cron.sql (${sql.length} bytes)`);
} else {
  sql = fallbackSql();
  console.warn('NOTE: sql/05_cron.sql not found — using the embedded canonical job set (CONTRACTS §scheduler).');
}

if (!sql.includes('{{CRON_SECRET}}')) {
  console.warn('WARNING: SQL contains no {{CRON_SECRET}} placeholder — check that the secret is not hardcoded in the repo!');
}
sql = sql.split('{{CRON_SECRET}}').join(CRON_SECRET).split('{{SUPABASE_URL}}').join(SUPABASE_URL);

// ── Apply ──
console.log(`Applying cron jobs to project ${REF}…`);
const apply = await runSql(sql);
if (!apply.ok) {
  console.error(`FAILED (${apply.status}) applying cron SQL:\n${redact(apply.text)}`);
  process.exit(1);
}
console.log(`Applied OK → ${redact(apply.text).slice(0, 300)}`);

// ── Verify ──
const verify = await runSql(
  'SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;'
);
if (!verify.ok) {
  console.error(`Applied, but verification query failed (${verify.status}):\n${redact(verify.text)}`);
  process.exit(1);
}

let rows;
try { rows = JSON.parse(verify.text); } catch { rows = null; }
if (!Array.isArray(rows)) {
  console.log(`cron.job raw response: ${redact(verify.text).slice(0, 1000)}`);
  process.exit(0);
}
if (!rows.length) {
  console.error('cron.job is EMPTY — jobs did not install.');
  process.exit(1);
}

console.log(`\ncron.job — ${rows.length} job(s) installed:`);
const w = Math.max(...rows.map((r) => String(r.jobname).length), 7);
console.log(`  ${'jobname'.padEnd(w)}  ${'schedule'.padEnd(14)}  active  jobid`);
for (const r of rows) {
  console.log(`  ${String(r.jobname).padEnd(w)}  ${String(r.schedule).padEnd(14)}  ${String(r.active).padEnd(6)}  ${r.jobid}`);
}
