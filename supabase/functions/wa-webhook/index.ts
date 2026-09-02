// wa-webhook/index.ts — WhatsApp Cloud API webhook entrypoint (verify_jwt OFF).
// GET  → Meta verification handshake (hub.challenge echo).
// POST → HMAC-SHA256 signature check (constant-time) → 200 'ok' fast →
//        processing continues in EdgeRuntime.waitUntil.
import { db } from '../_shared/db.ts';
import { normPhone } from '../_shared/phone.ts';
import { type InboundCtx, type WaMessage } from './handlers/_common.ts';
import { handleButton } from './handlers/buttons.ts';
import { handleFlowReply } from './handlers/flows.ts';
import { handleMedia } from './handlers/media.ts';
import { handleStatuses } from './handlers/statuses.ts';
import { handleText } from './handlers/text.ts';

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker']);

// ─── Signature verification ──────────────────────────────────────────────────

async function hmacSha256Hex(secret: string, raw: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string equality: XOR-accumulate over a fixed length. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length === 0 || bb.length === 0) return false;
  let diff = ab.length === bb.length ? 0 : 1;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

async function verifySignature(req: Request, raw: string): Promise<boolean> {
  const secret = Deno.env.get('WA_APP_SECRET') ?? '';
  if (!secret) {
    console.error('WA_APP_SECRET is not set — rejecting all POSTs');
    return false;
  }
  const header = req.headers.get('x-hub-signature-256') ?? '';
  if (!header) return false;
  const expected = 'sha256=' + (await hmacSha256Hex(secret, raw));
  return timingSafeEqual(header, expected);
}

// ─── Inbound message summary (ledger `body` column) ─────────────────────────

function summarize(msg: WaMessage): string | null {
  try {
    switch (msg?.type) {
      case 'text':
        return msg.text?.body ?? null;
      case 'button':
        return msg.button?.text ?? msg.button?.payload ?? null;
      case 'interactive': {
        const i = msg.interactive;
        if (i?.type === 'button_reply') return i.button_reply?.title ?? i.button_reply?.id ?? null;
        if (i?.type === 'list_reply') return i.list_reply?.title ?? i.list_reply?.id ?? null;
        if (i?.type === 'nfm_reply') return i.nfm_reply?.body ?? '[flow reply]';
        return `[interactive:${i?.type ?? 'unknown'}]`;
      }
      case 'image':
      case 'document':
      case 'audio':
      case 'video':
      case 'sticker': {
        const m = msg[msg.type];
        return m?.caption ?? m?.filename ?? `[${msg.type}]`;
      }
      default:
        return msg?.type ? `[${msg.type}]` : null;
    }
  } catch {
    return null;
  }
}

// ─── Payload processing (runs after the 200) ─────────────────────────────────

// deno-lint-ignore no-explicit-any
async function processMessage(msg: WaMessage, contacts: any[]): Promise<void> {
  const from = normPhone(msg?.from);
  const wamid: string = msg?.id ?? '';
  if (!from || !wamid) {
    console.warn('inbound message missing from/id — skipped');
    return;
  }

  // (a) Ledger insert = dedupe gate (unique wamid). 23505 → duplicate delivery, skip.
  let msgId: number | null = null;
  try {
    const { data, error } = await db
      .from('messages')
      .insert({
        wamid,
        direction: 'in',
        phone: from,
        msg_type: msg.type ?? 'unknown',
        body: summarize(msg),
        payload: msg,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') return; // already processed (webhook retry)
      console.error('inbound ledger insert failed:', error.message);
    }
    msgId = data?.id ?? null;
  } catch (e) {
    console.error('inbound ledger insert exception:', e);
  }

  // (b) 24h-window bookkeeping — merge, never clobber context (only these columns).
  try {
    const now = new Date().toISOString();
    await db
      .from('conversation_state')
      .upsert({ phone: from, last_inbound_at: now, updated_at: now }, { onConflict: 'phone' });
  } catch (e) {
    console.error('conversation_state upsert failed:', e);
  }

  const profileName: string =
    contacts?.find?.((c) => normPhone(c?.wa_id) === from)?.profile?.name ??
    contacts?.[0]?.profile?.name ??
    '';
  const ctx: InboundCtx = { from, wamid, msgId, profileName, message: msg };

  // (c) Dispatch.
  switch (msg.type) {
    case 'button':
      // TEMPLATE quick-reply tap: payload in message.button.payload.
      await handleButton(msg.button?.payload ?? '', ctx);
      return;
    case 'interactive': {
      const i = msg.interactive;
      if (i?.type === 'button_reply') return await handleButton(i.button_reply?.id ?? '', ctx);
      if (i?.type === 'list_reply') return await handleButton(i.list_reply?.id ?? '', ctx);
      if (i?.type === 'nfm_reply') return await handleFlowReply(ctx, i.nfm_reply);
      console.warn(`unhandled interactive type "${i?.type}" from ${from}`);
      return;
    }
    case 'text':
      return await handleText(ctx, msg.text?.body ?? '');
    default:
      if (MEDIA_TYPES.has(msg.type)) return await handleMedia(ctx, msg.type);
      console.warn(`unhandled message type "${msg.type}" from ${from} (${wamid})`);
  }
}

// deno-lint-ignore no-explicit-any
async function processPayload(payload: any): Promise<void> {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change?.value ?? {};
      try {
        if (value.statuses?.length) await handleStatuses(value.statuses);
      } catch (e) {
        console.error('handleStatuses batch exception:', e);
      }
      for (const msg of value.messages ?? []) {
        try {
          await processMessage(msg, value.contacts ?? []);
        } catch (e) {
          // One bad message must not kill the batch.
          console.error(`processMessage failed (${msg?.id ?? '?'}):`, e);
        }
      }
    }
  }
}

// ─── HTTP handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    const expected = Deno.env.get('WA_VERIFY_TOKEN') ?? '';
    if (mode === 'subscribe' && expected && token === expected) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('forbidden', { status: 403 });
  }

  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const raw = await req.text();
  if (!(await verifySignature(req, raw))) {
    return new Response('invalid signature', { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let payload: any = null;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('webhook body is not JSON:', e);
    return new Response('ok', { status: 200 });
  }

  const work = processPayload(payload).catch((e) => console.error('processPayload failed:', e));
  if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime?.waitUntil === 'function') {
    EdgeRuntime.waitUntil(work);
  }
  return new Response('ok', { status: 200 });
});
