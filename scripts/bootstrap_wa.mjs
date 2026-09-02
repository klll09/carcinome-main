#!/usr/bin/env node
// Bootstrap WhatsApp assets for Carcinome Home Care. Idempotent — safe to re-run.
//
//   node scripts/bootstrap_wa.mjs [--waba <id>] [--phone <id>] [--sync-only]
//
// Steps:
//   1. Flows: create the 3 flows (consent_v1 / completion_v1 / feedback_v1) if missing,
//      upload their Flow JSON asset, publish, and store the name→id map in
//      Supabase settings key 'flow_ids' (jsonb merge).
//   2. Templates: submit every catalog entry (en+hi) that is missing at (name, language)
//      on the WABA, then sync ALL statuses into the wa_templates registry table.
//   3. Subscribe this app to the WABA (POST /subscribed_apps) and verify with GET.
//
//   --sync-only : skip creation entirely; just re-sync template statuses → wa_templates.
//
// Env (.env at repo root, same loader as scripts/apply_sql.mjs):
//   WA_TOKEN (required), WA_WABA_ID / WA_PHONE_ID (defaults for --waba/--phone),
//   WA_APP_ID (optional, defaults to the Carcinome Meta app id — needed only to upload
//   the sample PDF handle Meta requires for DOCUMENT-header templates),
//   SUPABASE_PAT + SUPABASE_PROJECT_REF (Management API writes).
// NO secrets in this file — repo is public.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../wa/templates.catalog.mjs';

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

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let WABA = process.env.WA_WABA_ID;
let PHONE = process.env.WA_PHONE_ID;
let SYNC_ONLY = false;
let NO_SUBSCRIBE = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--waba') WABA = argv[++i];
  else if (argv[i] === '--phone') PHONE = argv[++i];
  else if (argv[i] === '--sync-only') SYNC_ONLY = true;
  else if (argv[i] === '--no-subscribe') NO_SUBSCRIBE = true;
  else { console.error(`Unknown arg: ${argv[i]}`); process.exit(1); }
}

const TOKEN = process.env.WA_TOKEN;
const APP_ID = process.env.WA_APP_ID || '2080735676134040'; // Meta app id (public identifier)
const PAT = process.env.SUPABASE_PAT;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!TOKEN) { console.error('Missing WA_TOKEN in env/.env'); process.exit(1); }
if (!WABA) { console.error('Missing --waba / WA_WABA_ID'); process.exit(1); }
if (!PAT || !REF) { console.error('Missing SUPABASE_PAT / SUPABASE_PROJECT_REF (needed to write flow_ids + wa_templates)'); process.exit(1); }

const GRAPH = 'https://graph.facebook.com/v23.0';
const FLOW_NAMES = ['consent_v1', 'completion_v1', 'feedback_v1'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hardFailures = 0;
const flowRows = [];      // { name, id, action, status }
const templateRows = [];  // { name, language, action, status, note }

// ── helpers ───────────────────────────────────────────────────────────────────
async function graph(pathOrUrl, { method = 'GET', body, form, headers = {} } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}/${pathOrUrl}`;
  const opts = { method, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { return { ok: false, status: 0, json: { error: { message: String(e) } } }; }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function graphGetAll(firstPath) {
  const out = [];
  let url = firstPath;
  while (url) {
    const r = await graph(url);
    if (!r.ok) {
      console.error(`Graph GET failed (${r.status}):`, JSON.stringify(r.json, null, 2));
      hardFailures++;
      break;
    }
    out.push(...(r.json.data || []));
    url = r.json.paging?.next || null;
  }
  return out;
}

async function mgmtQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`Supabase Management API query failed (${res.status}): ${text.slice(0, 800)}`);
    hardFailures++;
    return false;
  }
  return true;
}

const sqlStr = (s) => (s === null || s === undefined) ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
const sqlJson = (v) => (v === null || v === undefined) ? 'NULL' : `${sqlStr(JSON.stringify(v))}::jsonb`;

// ── sample PDF for DOCUMENT-header examples (resumable upload → handle) ───────
function buildSamplePdf() {
  const objs = [];
  objs[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objs[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  objs[3] = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n';
  const stream = 'BT /F1 18 Tf 72 780 Td (Carcinome Home Care - sample case document) Tj ET';
  objs[4] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  objs[5] = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i <= 5; i++) { offsets[i] = out.length; out += objs[i]; }
  const xrefPos = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(out); // all-ASCII, byte length == string length
}

let cachedHeaderHandle = null;
async function getHeaderHandle() {
  if (cachedHeaderHandle) return cachedHeaderHandle;
  const bytes = buildSamplePdf();
  const start = await graph(
    `${APP_ID}/uploads?file_name=carcinome_sample.pdf&file_length=${bytes.length}&file_type=application/pdf`,
    { method: 'POST', headers: { Authorization: `OAuth ${TOKEN}` } },
  );
  if (!start.ok || !start.json.id) {
    console.error('Resumable upload session failed:', JSON.stringify(start.json, null, 2));
    return null;
  }
  const up = await graph(start.json.id, {
    method: 'POST',
    headers: { Authorization: `OAuth ${TOKEN}`, file_offset: '0', 'Content-Type': 'application/octet-stream' },
    form: bytes, // raw body
  });
  if (!up.ok || !up.json.h) {
    console.error('Resumable upload (bytes) failed:', JSON.stringify(up.json, null, 2));
    return null;
  }
  cachedHeaderHandle = up.json.h;
  return cachedHeaderHandle;
}

// ── step 1: flows ─────────────────────────────────────────────────────────────
async function ensureFlows() {
  console.log(`\n── Flows on WABA ${WABA} ──`);
  const existing = await graphGetAll(`${GRAPH}/${WABA}/flows?fields=id,name,status&limit=100`);
  const map = {};

  for (const name of FLOW_NAMES) {
    const file = resolve(root, 'wa', 'flows', `${name}.json`);
    if (!existsSync(file)) {
      console.error(`Missing flow file: ${file}`);
      hardFailures++;
      flowRows.push({ name, id: '-', action: 'file_missing', status: '-' });
      continue;
    }
    let flow = existing.find((f) => f.name === name);
    let action = 'exists';

    if (!flow) {
      const r = await graph(`${WABA}/flows`, { method: 'POST', body: { name, categories: ['OTHER'] } });
      if (!r.ok || !r.json.id) {
        console.error(`Flow create failed for ${name}:`, JSON.stringify(r.json, null, 2));
        hardFailures++;
        flowRows.push({ name, id: '-', action: 'create_failed', status: '-' });
        continue;
      }
      flow = { id: r.json.id, name, status: 'DRAFT' };
      action = 'created';
    }
    map[name] = flow.id;

    if (flow.status === 'PUBLISHED') {
      flowRows.push({ name, id: flow.id, action, status: 'PUBLISHED' });
      continue; // published flows are immutable; nothing to update
    }

    // upload the Flow JSON asset
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(file)], { type: 'application/json' }), 'flow.json');
    fd.append('name', 'flow.json');
    fd.append('asset_type', 'FLOW_JSON');
    const up = await graph(`${flow.id}/assets`, { method: 'POST', form: fd });
    const vErrs = up.json?.validation_errors || [];
    if (!up.ok) {
      console.error(`Flow asset upload failed for ${name}:`, JSON.stringify(up.json, null, 2));
      hardFailures++;
      flowRows.push({ name, id: flow.id, action, status: 'asset_upload_failed' });
      continue;
    }
    if (vErrs.length) {
      console.error(`Flow JSON validation errors for ${name}:`, JSON.stringify(vErrs, null, 2));
      hardFailures++;
      flowRows.push({ name, id: flow.id, action, status: 'validation_errors' });
      continue;
    }

    // publish (tolerate "already published")
    const pub = await graph(`${flow.id}/publish`, { method: 'POST', body: {} });
    if (pub.ok) {
      flowRows.push({ name, id: flow.id, action, status: 'PUBLISHED' });
    } else {
      const check = await graph(`${flow.id}?fields=status`);
      if (check.ok && check.json.status === 'PUBLISHED') {
        flowRows.push({ name, id: flow.id, action, status: 'PUBLISHED' });
      } else {
        console.error(`Flow publish failed for ${name}:`, JSON.stringify(pub.json, null, 2));
        hardFailures++;
        flowRows.push({ name, id: flow.id, action, status: 'publish_failed' });
      }
    }
  }

  if (Object.keys(map).length) {
    const ok = await mgmtQuery(
      `INSERT INTO settings (key, value) VALUES ('flow_ids', ${sqlJson(map)})
       ON CONFLICT (key) DO UPDATE
         SET value = COALESCE(settings.value, '{}'::jsonb) || EXCLUDED.value,
             updated_at = now();`,
    );
    console.log(ok ? `settings.flow_ids updated: ${JSON.stringify(map)}` : 'settings.flow_ids update FAILED');
  }
  return map;
}

// ── step 2: templates ─────────────────────────────────────────────────────────
async function fetchWabaTemplates() {
  const list = await graphGetAll(
    `${GRAPH}/${WABA}/message_templates?fields=name,language,status,id,category,rejected_reason&limit=200`,
  );
  const byKey = new Map();
  for (const t of list) byKey.set(`${t.name}|${t.language}`, t);
  return byKey;
}

function buildCreatePayload(entry, flowIds, headerHandle) {
  const components = structuredClone(entry.components);
  for (const c of components) {
    if (c.type === 'HEADER' && c.format === 'DOCUMENT') {
      if (!headerHandle) throw new Error('no document header handle available');
      c.example = { header_handle: [headerHandle] };
    }
    if (c.type === 'BUTTONS') {
      for (const b of c.buttons) {
        if (b.type === 'FLOW') {
          const fid = flowIds[entry._flow];
          if (!fid) throw new Error(`flow id missing for '${entry._flow}'`);
          b.flow_id = String(fid);
        }
      }
    }
  }
  return {
    name: entry.name,
    language: entry.language,
    category: entry.category,
    components,
    // If Meta re-categorizes (e.g. UTILITY→MARKETING) approve anyway — an outage
    // costs more than the marketing rate (see plan §risks).
    allow_category_change: true,
  };
}

async function createMissingTemplates(flowIds) {
  console.log(`\n── Templates on WABA ${WABA} ──`);
  const existing = await fetchWabaTemplates();
  const needsDocHeader = TEMPLATES.some(
    (t) => !existing.has(`${t.name}|${t.language}`) &&
           t.components.some((c) => c.type === 'HEADER' && c.format === 'DOCUMENT'),
  );
  const headerHandle = needsDocHeader ? await getHeaderHandle() : null;

  for (const entry of TEMPLATES) {
    const key = `${entry.name}|${entry.language}`;
    if (existing.has(key)) {
      templateRows.push({ name: entry.name, language: entry.language, action: 'exists', status: existing.get(key).status });
      continue;
    }
    let payload;
    try {
      payload = buildCreatePayload(entry, flowIds, headerHandle);
    } catch (e) {
      console.error(`Skipping ${key}: ${e.message}`);
      hardFailures++;
      templateRows.push({ name: entry.name, language: entry.language, action: 'skipped', status: 'FAILED', note: e.message });
      continue;
    }
    const r = await graph(`${WABA}/message_templates`, { method: 'POST', body: payload });
    if (r.ok) {
      templateRows.push({ name: entry.name, language: entry.language, action: 'created', status: r.json.status || 'PENDING' });
    } else {
      const msg = JSON.stringify(r.json?.error || r.json);
      if (/already exists/i.test(msg)) {
        templateRows.push({ name: entry.name, language: entry.language, action: 'exists', status: 'UNKNOWN' });
      } else {
        console.error(`Template create failed for ${key}:`, JSON.stringify(r.json, null, 2));
        hardFailures++;
        templateRows.push({ name: entry.name, language: entry.language, action: 'create_failed', status: 'FAILED', note: msg.slice(0, 200) });
      }
    }
    await sleep(350); // gentle on the Graph rate limit
  }
}

async function syncTemplateRegistry() {
  const onWaba = await fetchWabaTemplates();
  const values = [];
  const seen = new Set();

  for (const entry of TEMPLATES) {
    const key = `${entry.name}|${entry.language}`;
    seen.add(key);
    const live = onWaba.get(key);
    const bodyText = entry.components.find((c) => c.type === 'BODY')?.text ?? null;
    const buttons = entry.components.find((c) => c.type === 'BUTTONS')?.buttons ?? null;
    const localRow = templateRows.find((t) => t.name === entry.name && t.language === entry.language);
    const status = live ? live.status : (localRow?.status || 'MISSING');
    const rejection = live?.rejected_reason && live.rejected_reason !== 'NONE'
      ? live.rejected_reason
      : (localRow?.note || null);
    values.push(
      `(${sqlStr(entry.name)}, ${sqlStr(entry.language)}, ${sqlStr(live?.category || entry.category)}, ` +
      `${sqlStr(bodyText)}, ${sqlJson(entry._params || [])}, ${sqlJson(buttons)}, ` +
      `${sqlStr(status)}, ${sqlStr(live?.id ?? null)}, ${sqlStr(rejection)}, now())`,
    );
    // reflect the live status in the printed summary too
    if (localRow && live) localRow.status = live.status;
  }

  // Templates on the WABA that aren't in our catalog — record them so the
  // dashboard template-health table shows the whole truth.
  for (const [key, live] of onWaba) {
    if (seen.has(key)) continue;
    values.push(
      `(${sqlStr(live.name)}, ${sqlStr(live.language)}, ${sqlStr(live.category || 'UTILITY')}, ` +
      `NULL, NULL, NULL, ${sqlStr(live.status)}, ${sqlStr(live.id)}, ` +
      `${sqlStr(live.rejected_reason && live.rejected_reason !== 'NONE' ? live.rejected_reason : null)}, now())`,
    );
  }

  if (!values.length) { console.log('No template rows to sync.'); return; }
  const ok = await mgmtQuery(
    `INSERT INTO wa_templates (name, language, category, body, variables, buttons, status, graph_id, rejection_reason, last_synced_at)
     VALUES ${values.join(',\n')}
     ON CONFLICT (name, language) DO UPDATE SET
       status = EXCLUDED.status,
       graph_id = EXCLUDED.graph_id,
       rejection_reason = EXCLUDED.rejection_reason,
       category = EXCLUDED.category,
       body = COALESCE(EXCLUDED.body, wa_templates.body),
       variables = COALESCE(EXCLUDED.variables, wa_templates.variables),
       buttons = COALESCE(EXCLUDED.buttons, wa_templates.buttons),
       last_synced_at = now();`,
  );
  console.log(ok ? `wa_templates registry synced (${values.length} rows).` : 'wa_templates sync FAILED');
  return onWaba;
}

// ── step 3: subscribed_apps ───────────────────────────────────────────────────
async function subscribeApp() {
  console.log(`\n── App subscription on WABA ${WABA} ──`);
  const post = await graph(`${WABA}/subscribed_apps`, { method: 'POST', body: {} });
  if (!post.ok) {
    console.error('subscribed_apps POST failed:', JSON.stringify(post.json, null, 2));
    hardFailures++;
  }
  const get = await graph(`${WABA}/subscribed_apps`);
  if (get.ok) {
    const apps = (get.json.data || []).map((d) => d.whatsapp_business_api_data || d);
    console.log('Subscribed apps:', JSON.stringify(apps));
    if (!apps.length) { console.error('WARNING: no app is subscribed to this WABA — webhooks will not arrive.'); hardFailures++; }
  } else {
    console.error('subscribed_apps GET failed:', JSON.stringify(get.json, null, 2));
    hardFailures++;
  }
}

// ── summary ───────────────────────────────────────────────────────────────────
function printSummary() {
  if (flowRows.length) {
    console.log('\n═══ FLOWS ═══');
    console.table(flowRows);
  }
  console.log('\n═══ TEMPLATES ═══');
  console.table(templateRows.map(({ note, ...r }) => r));
  const counts = templateRows.reduce((a, r) => { a[r.action] = (a[r.action] || 0) + 1; return a; }, {});
  console.log('Template actions:', JSON.stringify(counts));
  const pending = templateRows.filter((r) => r.status === 'PENDING').length;
  const rejected = templateRows.filter((r) => r.status === 'REJECTED').length;
  if (pending) console.log(`${pending} template(s) PENDING review — re-run with --sync-only later to refresh statuses.`);
  if (rejected) console.log(`${rejected} template(s) REJECTED — check rejection_reason in wa_templates and resubmit as _v2.`);
  console.log(hardFailures ? `\nDONE WITH ${hardFailures} HARD FAILURE(S).` : '\nDONE — all good.');
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`bootstrap_wa: WABA=${WABA} PHONE=${PHONE || '(unset)'} mode=${SYNC_ONLY ? 'sync-only' : 'full'}`);

if (SYNC_ONLY) {
  const onWaba = await fetchWabaTemplates();
  for (const entry of TEMPLATES) {
    const live = onWaba.get(`${entry.name}|${entry.language}`);
    templateRows.push({ name: entry.name, language: entry.language, action: 'sync', status: live ? live.status : 'MISSING' });
  }
  await syncTemplateRegistry();
  printSummary();
  process.exit(hardFailures ? 1 : 0);
}

const flowIds = await ensureFlows();
await createMissingTemplates(flowIds);
await syncTemplateRegistry();
if (NO_SUBSCRIBE) console.log('subscribed_apps: SKIPPED (--no-subscribe)');
else await subscribeApp();
printSummary();
process.exit(hardFailures ? 1 : 0);
