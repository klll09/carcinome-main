#!/usr/bin/env node
// Deploy edge functions via the Supabase Management API (multipart bundle upload).
// Usage: node scripts/deploy_functions.mjs [slug ...]
//   default slugs: wa-webhook admin-actions docgen scheduler
// Reads SUPABASE_PAT + SUPABASE_PROJECT_REF from .env (or process env).
//
// For each slug we collect supabase/functions/<slug>/**/*.ts plus
// supabase/functions/_shared/*.ts and POST them as one multipart form to
//   https://api.supabase.com/v1/projects/{ref}/functions/deploy?slug={slug}
// Each 'file' part's multipart FILENAME preserves the relative path prefixed
// with 'source/' (e.g. "source/supabase/functions/wa-webhook/index.ts") so
// cross-folder imports like `../_shared/wa.ts` resolve inside the bundle.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

const ALL_SLUGS = ['wa-webhook', 'admin-actions', 'docgen', 'scheduler', 'doc-extract', 'portal'];
// verify_jwt: only admin-actions requires a JWT at the platform gate.
// (docgen self-guards via service-key / x-internal-secret; webhook is HMAC; scheduler is x-cron-secret;
//  doc-extract self-guards by validating the bearer against the Patient Navigator project's GoTrue;
//  portal is PUBLIC by design — request_link/verify must work for a signed-out
//  visitor — and self-guards every other action on a portal_sessions bearer.)
const VERIFY_JWT = { 'wa-webhook': false, 'admin-actions': true, docgen: false, scheduler: false, 'doc-extract': false, portal: false };

const slugs = process.argv.slice(2).length ? process.argv.slice(2) : ALL_SLUGS;
for (const s of slugs) {
  if (!ALL_SLUGS.includes(s)) { console.error(`Unknown slug '${s}'. Known: ${ALL_SLUGS.join(' ')}`); process.exit(1); }
}

/** Recursively list .ts files under an absolute dir. Returns absolute paths. */
function tsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Repo-relative path with forward slashes (e.g. supabase/functions/_shared/wa.ts). */
function relPath(abs) {
  return abs.slice(root.length + 1).replace(/\\/g, '/');
}

// ── Metadata / entrypoint shape ─────────────────────────────────────────────
// NOTE FOR INTEGRATOR: the Management API resolves entrypoint_path against the
// uploaded file names. We upload every file under a 'source/' prefix and point
// the entrypoint at 'source/supabase/functions/<slug>/index.ts'. If the API
// rejects this (404 on entrypoint / "entrypoint not found"), the alternative
// shape is: drop the 'source/' prefix from BOTH the filenames and this path
// (i.e. filename 'supabase/functions/<slug>/index.ts', entrypoint the same),
// or flatten to 'index.ts' with _shared files uploaded beside it. Adjust here
// and in filePartName() only — nothing else depends on the shape.
function buildMetadata(slug) {
  return {
    name: slug,
    entrypoint_path: `source/supabase/functions/${slug}/index.ts`,
    import_map_path: undefined, // omitted from JSON when undefined
    verify_jwt: VERIFY_JWT[slug],
  };
}
function filePartName(rel) {
  return `source/${rel}`;
}
// ────────────────────────────────────────────────────────────────────────────

async function deploy(slug) {
  const fnDir = resolve(root, 'supabase', 'functions', slug);
  const sharedDir = resolve(root, 'supabase', 'functions', '_shared');
  const files = [...tsFiles(fnDir), ...tsFiles(sharedDir)];

  const entry = resolve(fnDir, 'index.ts');
  if (!existsSync(entry)) {
    console.error(`✗ ${slug}: missing ${relPath(entry)} — nothing to deploy`);
    return false;
  }
  if (!files.length) {
    console.error(`✗ ${slug}: no .ts files found`);
    return false;
  }

  const form = new FormData();
  form.append('metadata', JSON.stringify(buildMetadata(slug)));
  for (const abs of files) {
    const rel = relPath(abs);
    const blob = new Blob([readFileSync(abs)], { type: 'application/typescript' });
    form.append('file', blob, filePartName(rel));
  }

  console.log(`→ ${slug}: uploading ${files.length} file(s) (verify_jwt=${VERIFY_JWT[slug]})`);
  for (const abs of files) console.log(`    ${filePartName(relPath(abs))}`);

  let res, text;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions/deploy?slug=${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAT}` }, // Content-Type set by FormData (boundary)
      body: form,
    });
    text = await res.text();
  } catch (e) {
    console.error(`✗ ${slug}: network error — ${e.message}`);
    return false;
  }

  if (!res.ok) {
    console.error(`✗ ${slug}: HTTP ${res.status}\n${text}`);
    return false;
  }

  let info = {};
  try { info = JSON.parse(text); } catch { /* non-JSON success body — print raw below */ }
  const version = info.version ?? info.metadata?.version ?? '?';
  const id = info.id ?? '?';
  console.log(`✓ ${slug}: deployed — id=${id} version=${version} status=${info.status ?? res.status}`);
  if (id === '?' && version === '?') console.log(`  raw: ${text.slice(0, 400)}`);
  return true;
}

let failed = 0;
for (const slug of slugs) {
  // sequential on purpose: keeps output readable and avoids API rate surprises
  if (!(await deploy(slug))) failed++;
}
if (failed) { console.error(`\n${failed} deploy(s) failed.`); process.exit(1); }
console.log(`\nAll ${slugs.length} function(s) deployed.`);
