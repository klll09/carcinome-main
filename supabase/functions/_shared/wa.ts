// _shared/wa.ts — ALL WhatsApp Cloud API sends go through here (ledger discipline).
// Every send: insert `messages` row first (status 'pending') → call Graph →
// update the row (wamid + 'accepted' | 'failed' + error) → bump conversation_state.last_outbound_at.
import { db } from './db.ts';
import { normPhone } from './phone.ts';

const GRAPH = 'https://graph.facebook.com/v23.0';
const TOKEN = Deno.env.get('WA_TOKEN') ?? '';
const PHONE_ID = Deno.env.get('WA_PHONE_ID') ?? '';

export type SendOpts = { caseId?: string; role?: string; relayOf?: number };
export type SendResult = {
  ok: boolean;
  wamid?: string;
  messageId?: number;
  error?: unknown;
  via?: 'text' | 'template';
};

const VALID_ROLES = new Set(['patient', 'nurse', 'doctor', 'ops', 'supplier']);

/** Meta rejects template params containing newlines/tabs/4+ consecutive spaces. */
export function paramSafe(s: string, max = 300): string {
  const clean = String(s ?? '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/ {4,}/g, ' ')
    .trim();
  return clean.length > max ? clean.slice(0, Math.max(1, max - 1)) + '…' : clean;
}

async function touchOutbound(phone: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    await db
      .from('conversation_state')
      .upsert({ phone, last_outbound_at: now, updated_at: now }, { onConflict: 'phone' });
  } catch (e) {
    console.error('touchOutbound failed:', e);
  }
}

type SendMeta = {
  msgType: string;
  templateName?: string | null;
  bodyText?: string | null;
  opts?: SendOpts;
};

/** Core: ledger row → Graph POST → ledger update. Never throws. */
async function graphSend(
  to: string,
  payload: Record<string, unknown>,
  meta: SendMeta,
): Promise<SendResult> {
  const phone = normPhone(to);
  if (!phone) return { ok: false, error: 'invalid_recipient' };
  const request = { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, ...payload };

  let messageId: number | undefined;
  try {
    const role = meta.opts?.role && VALID_ROLES.has(meta.opts.role) ? meta.opts.role : null;
    const { data, error } = await db
      .from('messages')
      .insert({
        direction: 'out',
        phone,
        case_id: meta.opts?.caseId ?? null,
        participant_role: role,
        msg_type: meta.msgType,
        template_name: meta.templateName ?? null,
        body: meta.bodyText ?? null,
        payload: request,
        status: 'pending',
        relay_of: meta.opts?.relayOf ?? null,
      })
      .select('id')
      .single();
    if (error) console.error('ledger insert failed:', error.message);
    messageId = data?.id;
  } catch (e) {
    console.error('ledger insert exception:', e);
  }

  const now = () => new Date().toISOString();
  try {
    const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const json = await res.json().catch(() => ({}));
    const wamid: string | undefined = json?.messages?.[0]?.id;
    if (res.ok && wamid) {
      if (messageId) {
        await db.from('messages').update({ wamid, status: 'accepted', status_at: now() }).eq('id', messageId);
      }
      await touchOutbound(phone);
      return { ok: true, wamid, messageId };
    }
    const err = json?.error ?? json ?? { status: res.status };
    console.error(`WA send failed (${meta.msgType} → ${phone}):`, JSON.stringify(err));
    if (messageId) {
      await db.from('messages').update({ status: 'failed', status_at: now(), error: err }).eq('id', messageId);
    }
    return { ok: false, messageId, error: err };
  } catch (e) {
    console.error('WA send exception:', e);
    if (messageId) {
      await db.from('messages').update({ status: 'failed', status_at: now(), error: { message: String(e) } }).eq('id', messageId);
    }
    return { ok: false, messageId, error: String(e) };
  }
}

// ─── Basic sends ────────────────────────────────────────────────────────────

export async function sendText(to: string, body: string, opts?: SendOpts): Promise<SendResult> {
  return await graphSend(
    to,
    { type: 'text', text: { body: String(body ?? '').slice(0, 4096), preview_url: false } },
    { msgType: 'text', bodyText: body, opts },
  );
}

// ─── Templates (registry-checked, language fallback hi→en) ─────────────────

export async function sendTemplate(
  to: string,
  name: string,
  lang: 'en' | 'hi',
  bodyParams: string[],
  opts?: SendOpts & {
    buttonPayloads?: string[];
    urlButtonParam?: string;
    headerDocument?: { id?: string; link?: string; filename: string };
    flowToken?: string;
  },
): Promise<SendResult> {
  // Registry check with _v2 resolution (a rejected template resubmitted under
  // `<name>_v2` is used transparently). Preference order:
  //   (name, lang) → (name_v2, lang) → (name, en) → (name_v2, en).
  let useLang: 'en' | 'hi' | null = null;
  let useName = name;
  try {
    const v2 = `${name}_v2`;
    const { data: rows, error } = await db
      .from('wa_templates')
      .select('name, language, status')
      .in('name', [name, v2])
      .in('language', lang === 'en' ? ['en'] : [lang, 'en']);
    if (error) console.error('wa_templates lookup failed:', error.message);
    const approved = new Set(
      (rows ?? [])
        .filter((r) => String(r.status ?? '').toUpperCase() === 'APPROVED')
        .map((r) => `${r.name}|${r.language}`),
    );
    const order: Array<[string, 'en' | 'hi']> = lang === 'en'
      ? [[name, 'en'], [v2, 'en']]
      : [[name, lang], [v2, lang], [name, 'en'], [v2, 'en']];
    for (const [n, l] of order) {
      if (approved.has(`${n}|${l}`)) { useName = n; useLang = l; break; }
    }
  } catch (e) {
    console.error('wa_templates lookup exception:', e);
  }
  if (!useLang) {
    console.error(`template_unavailable: ${name} (${lang})`);
    return { ok: false, error: 'template_unavailable' };
  }
  name = useName;

  const components: Record<string, unknown>[] = [];
  if (opts?.headerDocument) {
    const d = opts.headerDocument;
    components.push({
      type: 'header',
      parameters: [{
        type: 'document',
        document: { ...(d.id ? { id: d.id } : { link: d.link }), filename: d.filename },
      }],
    });
  }
  if (bodyParams?.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((p) => ({ type: 'text', text: paramSafe(p) })),
    });
  }
  (opts?.buttonPayloads ?? []).forEach((payload, i) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(i),
      parameters: [{ type: 'payload', payload }],
    });
  });
  if (opts?.urlButtonParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: opts.urlButtonParam }],
    });
  }
  if (opts?.flowToken) {
    components.push({
      type: 'button',
      sub_type: 'flow',
      index: '0',
      parameters: [{ type: 'action', action: { flow_token: opts.flowToken } }],
    });
  }

  return await graphSend(
    to,
    {
      type: 'template',
      template: {
        name,
        language: { code: useLang },
        ...(components.length ? { components } : {}),
      },
    },
    {
      msgType: 'template',
      templateName: name,
      bodyText: `[${name}/${useLang}] ${bodyParams.map((p) => paramSafe(p, 80)).join(' | ')}`,
      opts,
    },
  );
}

// ─── Interactive ────────────────────────────────────────────────────────────

/**
 * The "I've paid" claim button — must follow EVERY order_details / UPI payment
 * prompt (the payment copy references it; the webhook handles paid_claim:<id>).
 * Session interactive message: all callers reach here with an open window
 * (order_details itself is window-gated).
 */
export async function sendPaidClaimButton(
  to: string,
  caseId: string,
  lang: 'en' | 'hi',
  opts?: SendOpts,
): Promise<SendResult> {
  const body = lang === 'hi'
    ? 'भुगतान पूरा करने के बाद नीचे दबाएँ, ताकि हमारी टीम उसकी पुष्टि कर सके।'
    : 'After completing the payment, tap below so our team can verify it.';
  const title = lang === 'hi' ? 'भुगतान हो गया' : "I've paid";
  return await sendInteractiveButtons(to, body, [{ id: `paid_claim:${caseId}`, title }], {
    caseId,
    role: 'patient',
    ...opts,
  });
}

export async function sendInteractiveButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
  opts?: SendOpts,
): Promise<SendResult> {
  return await graphSend(
    to,
    {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(body ?? '').slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
          })),
        },
      },
    },
    { msgType: 'interactive', bodyText: body, opts },
  );
}

export async function sendList(
  to: string,
  body: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[],
  opts?: SendOpts,
): Promise<SendResult> {
  return await graphSend(
    to,
    {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: String(body ?? '').slice(0, 4096) },
        action: {
          button: String(buttonText ?? 'Choose').slice(0, 20),
          sections: [{
            rows: rows.slice(0, 10).map((r) => ({
              id: r.id.slice(0, 200),
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          }],
        },
      },
    },
    { msgType: 'list', bodyText: body, opts },
  );
}

export async function sendFlow(
  to: string,
  p: { flowId: string; flowToken: string; cta: string; screen: string; data?: unknown; bodyText: string },
  opts?: SendOpts,
): Promise<SendResult> {
  return await graphSend(
    to,
    {
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: String(p.bodyText ?? '').slice(0, 1024) },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: p.flowToken,
            flow_id: p.flowId,
            flow_cta: String(p.cta ?? 'Open').slice(0, 20),
            flow_action: 'navigate',
            flow_action_payload: {
              screen: p.screen,
              ...(p.data !== undefined ? { data: p.data } : {}),
            },
          },
        },
      },
    },
    { msgType: 'flow', bodyText: p.bodyText, opts },
  );
}

// ─── Media ──────────────────────────────────────────────────────────────────

export async function sendDocument(
  to: string,
  doc: { mediaId?: string; link?: string },
  filename: string,
  caption: string,
  opts?: SendOpts,
): Promise<SendResult> {
  return await graphSend(
    to,
    {
      type: 'document',
      document: {
        ...(doc.mediaId ? { id: doc.mediaId } : { link: doc.link }),
        filename,
        ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
      },
    },
    { msgType: 'document', bodyText: caption || filename, opts },
  );
}

/** Relay helper: route an uploaded media id to the right Cloud API type by MIME. */
export async function sendMedia(
  to: string,
  m: { mediaId: string; mime: string; filename?: string; caption?: string },
  opts?: SendOpts,
): Promise<SendResult> {
  const mime = (m.mime ?? '').split(';')[0].trim().toLowerCase();
  const caption = m.caption ? String(m.caption).slice(0, 1024) : undefined;
  if (mime.startsWith('image/')) {
    return await graphSend(
      to,
      { type: 'image', image: { id: m.mediaId, ...(caption ? { caption } : {}) } },
      { msgType: 'image', bodyText: caption ?? m.filename ?? 'image', opts },
    );
  }
  if (mime.startsWith('video/')) {
    return await graphSend(
      to,
      { type: 'video', video: { id: m.mediaId, ...(caption ? { caption } : {}) } },
      { msgType: 'video', bodyText: caption ?? m.filename ?? 'video', opts },
    );
  }
  if (mime.startsWith('audio/')) {
    // Audio messages don't support captions.
    return await graphSend(
      to,
      { type: 'audio', audio: { id: m.mediaId } },
      { msgType: 'audio', bodyText: m.caption ?? 'audio', opts },
    );
  }
  return await sendDocument(to, { mediaId: m.mediaId }, m.filename ?? 'file', caption ?? '', opts);
}

export async function uploadMedia(bytes: Uint8Array, mime: string): Promise<string> {
  const cleanMime = (mime ?? 'application/octet-stream').split(';')[0].trim();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', cleanMime);
  form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: cleanMime }), `upload.${extFromMime(cleanMime)}`);
  const res = await fetch(`${GRAPH}/${PHONE_ID}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.id) {
    throw new Error(`uploadMedia failed: ${JSON.stringify(json?.error ?? json)}`);
  }
  return json.id as string;
}

export async function downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta?.url) {
    throw new Error(`downloadMedia meta failed: ${JSON.stringify(meta?.error ?? meta)}`);
  }
  const binRes = await fetch(meta.url, {
    headers: { authorization: `Bearer ${TOKEN}`, 'user-agent': 'curl/8.0' },
  });
  if (!binRes.ok) throw new Error(`downloadMedia fetch failed: HTTP ${binRes.status}`);
  const bytes = new Uint8Array(await binRes.arrayBuffer());
  return { bytes, mime: meta.mime_type ?? 'application/octet-stream' };
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp',
    'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/amr': 'amr', 'audio/ogg': 'ogg',
    'application/pdf': 'pdf', 'text/plain': 'txt',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };
  return map[(mime ?? '').split(';')[0].trim().toLowerCase()] ?? 'bin';
}

// ─── Payments (UPI intent, no gateway) ──────────────────────────────────────

export async function sendOrderDetails(
  to: string,
  p: {
    referenceId: string;
    totalPaise: number;
    itemName: string;
    upiVpa: string;
    businessName: string;
    bodyText: string;
  },
  opts?: SendOpts,
): Promise<SendResult> {
  const ref = String(p.referenceId ?? '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 35) || 'ORDER';
  const amount = { value: Math.max(1, Math.round(p.totalPaise)), offset: 100 };
  // v23 India Payments API: action.parameters takes a payment_settings ARRAY.
  // Gateway-less variant = type 'upi_intent_link' with a standard upi:// deep link to the
  // merchant VPA (payment_gateway entries need Razorpay/PayU etc., which we do not use).
  // No PG means no payment-status webhooks — our flow verifies via "I've paid" + admin check.
  const rupees = (amount.value / 100).toFixed(2);
  const upiLink =
    `upi://pay?pa=${encodeURIComponent(p.upiVpa)}&pn=${encodeURIComponent(p.businessName)}` +
    `&am=${rupees}&cu=INR&tr=${ref}`;
  const footer = paramSafe(`${p.businessName} · UPI: ${p.upiVpa}`, 60);
  return await graphSend(
    to,
    {
      type: 'interactive',
      interactive: {
        type: 'order_details',
        body: { text: String(p.bodyText ?? '').slice(0, 1024) },
        footer: { text: footer },
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: ref,
            type: 'digital-goods',
            payment_settings: [{
              type: 'upi_intent_link',
              upi_intent_link: { link: upiLink },
            }],
            currency: 'INR',
            total_amount: amount,
            order: {
              status: 'pending',
              items: [{
                retailer_id: ref,
                name: paramSafe(p.itemName, 60) || 'Home care service',
                amount,
                quantity: 1,
              }],
              subtotal: amount,
              tax: { value: 0, offset: 100 },
            },
          },
        },
      },
    },
    { msgType: 'order_details', bodyText: p.bodyText, opts },
  );
}

// ─── Window-aware send ──────────────────────────────────────────────────────

async function isWindowOpen(phone: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('open_window', { p_phone: normPhone(phone) });
    if (error) {
      console.error('open_window rpc failed:', error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.error('open_window exception:', e);
    return false;
  }
}

/** Free-form text when the 24h window is open, else the given template fallback. */
export async function sendSmart(
  to: string,
  freeformBody: string,
  fallback: { name: string; lang: 'en' | 'hi'; params: string[] },
  opts?: SendOpts,
): Promise<SendResult> {
  if (await isWindowOpen(to)) {
    const r = await sendText(to, freeformBody, opts);
    return { ...r, via: 'text' };
  }
  const r = await sendTemplate(to, fallback.name, fallback.lang, fallback.params, opts);
  return { ...r, via: 'template' };
}
