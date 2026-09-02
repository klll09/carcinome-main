#!/usr/bin/env node
// Apply a SQL file to the Supabase project via the Management API.
// Usage: node scripts/apply_sql.mjs sql/01_schema.sql
// Reads SUPABASE_PAT + SUPABASE_PROJECT_REF from .env (or process env).

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
if (!PAT || !REF) { console.error('Missing SUPABASE_PAT / SUPABASE_PROJECT_REF'); process.exit(1); }

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/apply_sql.mjs <sql-file>'); process.exit(1); }
const sql = readFileSync(resolve(root, file), 'utf8');

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`FAILED (${res.status}) applying ${file}:\n${text}`);
  process.exit(1);
}
console.log(`OK ${file} → ${text.slice(0, 500)}`);
