#!/usr/bin/env node
// Fire realistic, signed WhatsApp Cloud API webhook payloads at wa-webhook.
// Usage:
//   node scripts/fake_webhook.mjs text     <from> <body...>
//   node scripts/fake_webhook.mjs button   <from> <payload>          (template quick-reply tap)
//   node scripts/fake_webhook.mjs ibutton  <from> <id>               (session interactive button)
//   node scripts/fake_webhook.mjs list     <from> <id>               (list row pick)
//   node scripts/fake_webhook.mjs flow     <from> <flow_token> <json> (nfm_reply; json merged, flow_token injected)
//   node scripts/fake_webhook.mjs status   <wamid> <status>          (sent|delivered|read|failed)
//   node scripts/fake_webhook.mjs document <from> <mediaId>
// Optional anywhere: --url <endpoint>   (default ${SUPABASE_URL}/functions/v1/wa-webhook)
// Signs raw body with HMAC-SHA256(WA_APP_SECRET) → X-Hub-Signature-256.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';

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

const APP_SECRET = process.env.WA_APP_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const WABA_ID = process.env.WA_WABA_ID || '742857131840708';
const PHONE_ID = process.env.WA_PHONE_ID || '759369010592155';
if (!APP_SECRET) { console.error('Missing WA_APP_SECRET in .env'); process.exit(1); }

// ── args ──
const argv = process.argv.slice(2);
let url = null;
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') { url = argv[++i]; }
  else args.push(argv[i]);
}
const kind = args.shift();
if (!url) {
  if (!SUPABASE_URL) { console.error('Missing SUPABASE_URL in .env (or pass --url)'); process.exit(1); }
  url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/wa-webhook`;
}

const USAGE = `Usage: node scripts/fake_webhook.mjs <kind> [args] [--url <endpoint>]
Kinds:
  text     <from> <body...>
  button   <from> <payload>
  ibutton  <from> <id>
  list     <from> <id>
  flow     <from> <flow_token> <json>
  status   <wamid> <status>
  document <from> <mediaId>`;

const now = () => Math.floor(Date.now() / 1000).toString();
const wamid = () => 'wamid.TEST.' + randomBytes(12).toString('hex');

/** Wrap a value object into the full Cloud API envelope. */
function envelope(value) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA_ID, changes: [{ field: 'messages', value }] }],
  };
}

/** value for an inbound message from <from> */
function messageValue(from, message) {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15551322398', phone_number_id: PHONE_ID },
    contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
    messages: [message],
  };
}

function need(n, names) {
  if (args.length < n) { console.error(`${kind}: expected args: ${names}\n\n${USAGE}`); process.exit(1); }
}

let payload;
switch (kind) {
  case 'text': {
    need(2, '<from> <body...>');
    const [from, ...body] = args;
    payload = envelope(messageValue(from, {
      from, id: wamid(), timestamp: now(), type: 'text', text: { body: body.join(' ') },
    }));
    break;
  }
  case 'button': { // TEMPLATE quick-reply tap
    need(2, '<from> <payload>');
    const [from, btnPayload] = args;
    payload = envelope(messageValue(from, {
      from, id: wamid(), timestamp: now(), type: 'button',
      button: { payload: btnPayload, text: 'Accept' },
      context: { from: '15551322398', id: wamid() },
    }));
    break;
  }
  case 'ibutton': { // SESSION interactive button reply
    need(2, '<from> <id>');
    const [from, id] = args;
    payload = envelope(messageValue(from, {
      from, id: wamid(), timestamp: now(), type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id, title: 'x' } },
      context: { from: '15551322398', id: wamid() },
    }));
    break;
  }
  case 'list': {
    need(2, '<from> <id>');
    const [from, id] = args;
    payload = envelope(messageValue(from, {
      from, id: wamid(), timestamp: now(), type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id, title: 'x', description: '' } },
      context: { from: '15551322398', id: wamid() },
    }));
    break;
  }
  case 'flow': { // nfm_reply — response_json is STRINGIFIED JSON including flow_token
    need(3, '<from> <flow_token> <json>');
    const [from, flowToken, jsonArg] = args;
    let parsed;
    try { parsed = JSON.parse(jsonArg); }
    catch (e) { console.error(`flow: <json> is not valid JSON: ${e.message}`); process.exit(1); }
    payload = envelope(messageValue(from, {
      from, id: wamid(), timestamp: now(), type: 'interactive',
      interactive: {
        type: 'nfm_reply',
        nfm_reply: {
          response_json: JSON.stringify({ ...parsed, flow_token: flowToken }),
          body: 'Sent',
          name: 'flow',
        },
      },
      context: { from: '15551322398', id: wamid() },
    }));
    break;
  }
  case 'status': {
    need(2, '<wamid> <status>');
    const [id, status] = args;
    payload = envelope({
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15551322398', phone_number_id: PHONE_ID },
      statuses: [{
        id, status, timestamp: now(), recipient_id: '919999999999',
        conversation: { id: 'CONV.TEST', origin: { type: 'utility' } },
        pricing: { category: 'utility', billable: true, pricing_model: 'PMP' },
      }],
    });
    break;
  }
  case 'document': {
    need(2, '<from> <mediaId>');
    const [from, mediaId] = args;
    payload = envelope(messageValue(from, {
      from, id: wamid(), timestamp: now(), type: 'document',
      document: { id: mediaId, mime_type: 'application/pdf', filename: 'test.pdf', sha256: 'x' },
    }));
    break;
  }
  default:
    console.error(kind ? `Unknown kind '${kind}'.\n\n${USAGE}` : USAGE);
    process.exit(1);
}

const raw = JSON.stringify(payload);
const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex');

console.log(`POST ${url}`);
console.log(`kind=${kind}  bytes=${raw.length}  sig=${sig.slice(0, 22)}…`);

let res, text;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: raw,
  });
  text = await res.text();
} catch (e) {
  console.error(`Request failed: ${e.message}`);
  process.exit(1);
}
console.log(`← ${res.status} ${res.statusText}`);
console.log(text || '(empty body)');
// process.exitCode (not process.exit) — immediate exit after fetch trips a
// libuv assertion on Windows node 24.
process.exitCode = res.ok ? 0 : 1;
