# CONTRACTS — Carcinome WPP build (all agents read this FIRST)

Binding conventions for the multi-agent build. If your file disagrees with this doc, this doc wins.
Also read: `sql/01_schema.sql` (exact schema — LIVE in the DB already), `sql/03_functions.sql` (DB functions), and the approved plan at `C:\Users\abhay\.claude\plans\c-users-abhay-desktop-carcinome-user-fl-luminous-crayon.md`.

Repo root for this project: `C:\Users\abhay\Desktop\Carcinome Brochure\carcinome_wpp\`
This folder is INSIDE a public GitHub Pages repo → **NEVER put secrets in any file except `.env` (gitignored)**. The SPA may only ship the publishable key.

## Live infrastructure (already provisioned — do not re-create)

- Supabase `uhesnagqbmuyqiuzfhcv` (ap-south-1). Schema from `sql/01–04` is APPLIED. Storage bucket `case-docs` (private, 50MB) exists. Admin auth user `admin@carcinome.in` exists with profile row.
- Supabase secrets set for edge functions: `WA_TOKEN, WA_APP_SECRET, WA_PHONE_ID, WA_WABA_ID, WA_PROD_PHONE_ID, WA_PROD_WABA_ID, WA_VERIFY_TOKEN, CRON_SECRET`. Edge runtime auto-injects `SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY`.
- Pilot = TEST number (phone_id `759369010592155`, WABA `742857131840708`). Production WABA `1283671993499780` / phone `688966954309422` (cutover later = swap secrets).
- Graph API version: **v23.0** — `https://graph.facebook.com/v23.0/...`

## File ownership (write ONLY your files)

| Agent | Files |
|---|---|
| be-core | `supabase/functions/_shared/*.ts`, `supabase/functions/wa-webhook/**` |
| wa-assets | `scripts/bootstrap_wa.mjs`, `wa/templates.catalog.mjs`, `wa/flows/*.json` |
| spa-scaffold | `index.html`, `css/*`, `js/config.js`, `js/supabase.js`, `js/auth.js`, `js/router.js`, `js/app.js`, `js/components/*`, `js/utils/*` |
| harness | `scripts/fake_webhook.mjs`, `scripts/deploy_functions.mjs`, `scripts/setup_cron.mjs` |
| be-ops | `supabase/functions/admin-actions/index.ts`, `supabase/functions/docgen/index.ts`, `supabase/functions/scheduler/index.ts`, `sql/05_cron.sql` |
| spa-page-* | exactly one file each in `js/pages/*.js` |

## Runtime & imports (edge functions)

Deno on Supabase Edge Runtime. Use `npm:` specifiers: `import { createClient } from 'npm:@supabase/supabase-js@2'`; pdf-lib: `npm:pdf-lib@1.17.1`, fontkit: `npm:@pdf-lib/fontkit@1.1.1`. Serve with `Deno.serve(handler)`. Long work after responding 200: `EdgeRuntime.waitUntil(promise)`.

## Phone canonicalization (`_shared/phone.ts`)

`normPhone(s)`: strip all non-digits; if 10 digits → prefix `91`; if starts with `0` and 11 digits → drop 0, prefix 91. Canonical = digits-only with country code (`919876543210`) — equals WhatsApp `wa_id`. Applied at EVERY boundary (webhook wa_id, dashboard input, template sends).

## Button payload convention

Quick-reply payload / interactive button id / list row id — ALWAYS: `<action>:<case_uuid>` (256-char limit). Actions: `offer_yes, offer_no, pay_show, paid_claim, complete_open, join_thread, relay_ctx`.
⚠️ Webhook reality: TEMPLATE quick-reply taps arrive as `messages[].type === "button"` with `message.button.payload` + `.text`. SESSION interactive buttons arrive as `type === "interactive"` with `interactive.button_reply.id`. List picks: `interactive.list_reply.id`. Handle ALL THREE paths to the same dispatcher.

## Flow token

`flow_token = "<flow_name>:<case_uuid>:<nonce8>"`. Flow names: `consent_v1`, `completion_v1`, `feedback_v1`. Flow replies arrive as `type === "interactive"`, `interactive.type === "nfm_reply"`, with `interactive.nfm_reply.response_json` = STRINGIFIED JSON that includes `flow_token`.

## `_shared/wa.ts` — exact exports (be-core writes; be-ops consumes)

```ts
export type SendOpts = { caseId?: string; role?: string; relayOf?: number };
export type SendResult = { ok: boolean; wamid?: string; messageId?: number; error?: unknown };
export function paramSafe(s: string, max?: number): string; // strip \n\t, collapse 4+ spaces, truncate (default 300)
export async function sendText(to: string, body: string, opts?: SendOpts): Promise<SendResult>;
export async function sendTemplate(to: string, name: string, lang: 'en'|'hi', bodyParams: string[], opts?: SendOpts & {
  buttonPayloads?: string[];                 // sub_type quick_reply, index order
  urlButtonParam?: string;                   // sub_type url, index 0
  headerDocument?: { id?: string; link?: string; filename: string };
  flowToken?: string;                        // sub_type flow button, index 0
}): Promise<SendResult>;
// sendTemplate: look up wa_templates (name, lang, status='APPROVED'); hi missing → fall back to 'en';
// neither approved → return {ok:false, error:'template_unavailable'} (caller decides).
export async function sendInteractiveButtons(to: string, body: string, buttons: {id:string; title:string}[], opts?: SendOpts): Promise<SendResult>; // title ≤20 chars
export async function sendList(to: string, body: string, buttonText: string, rows: {id:string; title:string; description?:string}[], opts?: SendOpts): Promise<SendResult>;
export async function sendFlow(to: string, p: { flowId: string; flowToken: string; cta: string; screen: string; data?: unknown; bodyText: string }, opts?: SendOpts): Promise<SendResult>;
export async function sendDocument(to: string, doc: { mediaId?: string; link?: string }, filename: string, caption: string, opts?: SendOpts): Promise<SendResult>;
export async function uploadMedia(bytes: Uint8Array, mime: string): Promise<string>; // returns media id
export async function downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }>; // GET /{id} → lookaside URL → fetch with bearer
export async function sendOrderDetails(to: string, p: { referenceId: string; totalPaise: number; itemName: string; upiVpa: string; businessName: string; bodyText: string }, opts?: SendOpts): Promise<SendResult>; // interactive order_details, payment_settings UPI intent, currency INR
export async function sendSmart(to: string, freeformBody: string, fallback: { name: string; lang: 'en'|'hi'; params: string[] }, opts?: SendOpts): Promise<SendResult>; // open_window(phone) → sendText else sendTemplate
```
**Ledger discipline:** every send inserts a `messages` row FIRST (`direction='out'`, status 'pending', body, template_name, payload = the request JSON, case_id/role/relay_of from opts), then calls Graph, then updates the row (wamid + status 'accepted' | 'failed' + error). Also update `conversation_state.last_outbound_at` (upsert).

`_shared/db.ts`: `export const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })`.
`_shared/log.ts`: `logEvent(caseId, eventType, actor, data?)` → insert `case_events`, swallow duplicate-key errors (dedupe index is a feature).
`_shared/otp.ts`: `issueOtp(caseId)` (crypto 6 digits, TTL settings `otp_ttl_min`, invalidate older active otps for case), `verifyOtp(fromPhone, code)` → `'verified' | 'wrong' | 'locked' | 'none'`.
`_shared/relay.ts`: `fanOut(caseId, senderPhone, senderLabel, content: {text?: string; mediaId?: string; mediaType?: string; filename?: string; caption?: string}, relayOfMsgId)` per plan §relay; role prefix emoji: patient 🧑, nurse 🩺, doctor 🥼, ops 🛟, supplier 📦.
`_shared/lang.ts`: `langFor(phone): Promise<'en'|'hi'>` — check patients/nurses/doctors/suppliers by phone (first hit), default 'en'.

## Webhook (wa-webhook, verify_jwt OFF)

GET: echo `hub.challenge` when `hub.verify_token === WA_VERIFY_TOKEN` else 403.
POST: read RAW body text; verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(raw, WA_APP_SECRET) using constant-time compare → 401 mismatch. Then `Response('ok')` fast, process in `EdgeRuntime.waitUntil`. Dedupe inbound by `INSERT ... ON CONFLICT (wamid) DO NOTHING` FIRST. Status callbacks: update messages by wamid — never downgrade (read > delivered > sent > accepted), set pricing_category/billable from `statuses[].pricing`. Routing per plan (buttons → flows → text OTP/STOP/DONE → relay; media → download to Storage `cases/{case_id}/media/{wamid}.{ext}` immediately then relay).

## admin-actions (verify_jwt ON + explicit check)

POST JSON `{ action, ...params }`, `Authorization: Bearer <admin session JWT>`. On every call: `db.auth.getUser(jwt)` → profiles row must be role='admin' AND is_active, else 403. CORS: allow origin `*`, headers `authorization, content-type`, methods `POST, OPTIONS` (handle OPTIONS preflight → 200).
Actions: `register_case` (creates patient?+doctor?+case+offers+participants incl. ops/supervisor phones from settings; fires patient_registered, doctor_referral_ack, supplier_equipment_prep, nurse_case_offer to all eligible nurses; status→'offering'; returns `{case_id, case_code}`), `assign_nurse {case_id, nurse_id}`, `reassign_nurse {case_id, nurse_id}`, `send_consent {case_id}`, `issue_otp {case_id}`, `mark_paid_verified {case_id}`, `regenerate_docs {case_id}`, `resend_invoice {case_id}`, `send_manual_message {case_id, text}` (as Ops into relay), `cancel_case {case_id, reason}`, `archive_case {case_id}`.
Entity CRUD (nurses/suppliers/doctors/patients edits) does NOT go here — SPA does direct table ops under RLS.

## docgen

POST `{case_id, doc: 'invoice'|'discharge'}` (internal: called by webhook/admin-actions with service key in Authorization → verify_jwt ON works with service key too; ALSO accept `x-internal-secret: CRON_SECRET` fallback). pdf-lib + fontkit; fetch Noto Sans Regular + Bold TTFs and Noto Sans Devanagari at cold start from jsdelivr (`https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-normal.ttf` style URLs are unreliable — use `https://cdn.jsdelivr.net/npm/@fontsource/noto-sans@5/files/noto-sans-latin-400-normal.woff2`? NO — pdf-lib needs TTF/OTF: use `https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf` variable font may fail in pdf-lib — SAFEST: `https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf` and `NotoSans-Bold.ttf`, and `fonts/NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Regular.ttf`), cache in module scope, and FALL BACK to StandardFonts.Helvetica replacing `₹`→`Rs.` and stripping Devanagari if fetch fails. Choose Devanagari font for any text run matching `/[ऀ-ॿ]/`. Upload PDF → Storage `cases/{case_id}/invoice.pdf` | `discharge_summary.pdf` (upsert:true) → `uploadMedia` → return `{path, media_id}`. Layouts per plan.

## scheduler (verify_jwt OFF, requires header `x-cron-secret == CRON_SECRET`)

POST `{job}` ∈ `reminders_24h, reminders_morning, otp_issue, otp_expiry, sla_nudge, feedback_chaser, archiver`. Each idempotent (guard via case_events dedupe/index). `sql/05_cron.sql`: `CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net;` + `cron.schedule(...)` jobs calling `net.http_post('https://uhesnagqbmuyqiuzfhcv.supabase.co/functions/v1/scheduler', body, headers with x-cron-secret)`. ⚠️ Do NOT hardcode CRON_SECRET in 05_cron.sql (public repo!) — write `{{CRON_SECRET}}` placeholder; `scripts/setup_cron.mjs` substitutes from .env and applies via Management API.

## Case lifecycle ownership

- webhook: offer responses, consent, OTP verify, completion (→ triggers docgen pipeline), paid_claim, relay, opt-outs.
- admin-actions: registration fan-out, assignment, manual sends, paid verification, cancel/archive.
- scheduler: reminders, otp_issue (60 min before scheduled_at for assigned/consented cases), sla nudges, feedback chase, archive.
On `care_done` (webhook, completion flow): create invoice row (line item from care_type label + `cases.price_inr` or settings.pricing default; upi_vpa from settings) → docgen invoice + discharge → sendTemplate invoice_delivery (header PDF + Pay-now button) to patient, discharge_summary_patient, discharge_summary_doctor → if `open_window(patient)` also sendOrderDetails immediately → status 'awaiting_payment', invoice 'sent'. feedback_invite NOT here (scheduler sends ≥2h later).

## Template names (see wa/templates.catalog.mjs for bodies; ALL utility, en + hi)

`patient_registered(3), doctor_referral_ack(4), nurse_case_offer(5; QR Accept/Decline), offer_closed(1), nurse_assigned_nurse(5), nurse_assigned_patient(2), nurse_assigned_doctor(4), supplier_equipment_prep(5), session_otp(2), otp_nurse_prompt(1), consent_flow_invite(2; flow btn), care_update(2), infusion_reminder_patient(2), infusion_reminder_nurse(3), invoice_delivery(3; doc header + QR Pay now), discharge_summary_patient(2; doc header), discharge_summary_doctor(3; doc header), feedback_invite(1; flow btn), payment_received(2), sla_nudge_supervisor(3; URL btn)`
(n) = body param count. Language codes at Meta: `en` and `hi`.

## SPA conventions

Vanilla ES modules, hash router, NO build step. `js/config.js`: `export const CONFIG = { SUPABASE_URL: 'https://uhesnagqbmuyqiuzfhcv.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_B7Blefe4lWWfKEiG8L7WqQ_oswVc7YL', FUNCTIONS_URL: 'https://uhesnagqbmuyqiuzfhcv.supabase.co/functions/v1', APP_NAME: 'Carcinome Home Care', VERSION: '20260716a', DEFAULT_PAGE_SIZE: 25 }`. Publishable key is safe to commit (RLS admin-only).
Copy PN files from `C:\Users\abhay\Desktop\Carcinome Brochure\Patient Navigator\` per plan reuse map. `js/utils/api.js` (scaffold writes): `export async function adminAction(action, params)` → POST `${CONFIG.FUNCTIONS_URL}/admin-actions` with session access_token; throws Error(message) on !ok; also `export async function uploadCaseDoc(file, caseIdOrTmp)` → Storage upload to `case-docs` bucket path `uploads/{ts}_{filename}` returning path.
Page modules: `export default async function render(container, params)`. Register in `js/app.js` route table: `#dashboard #cases #cases/:id #patients #patients/:id #nurses #suppliers #settings #messages`. Sidebar labels: Dashboard, Cases, Patients, Nurses, Marketplace, Messages, Settings.
Status colors + labels via `utils/formatters.js` `caseStatusBadge(status)`. INR via `formatINR(n)`. IST display via `formatDateTime(ts)` (Asia/Kolkata).
Live timeline: supabase channel `postgres_changes` INSERT on `messages` filtered `case_id=eq.{id}`, and on `case_events`.

## Testing

`scripts/fake_webhook.mjs <kind> [args]` — builds real Cloud API payload shapes, signs with WA_APP_SECRET from .env, POSTs to `${SUPABASE_URL}/functions/v1/wa-webhook`. Kinds: `text <from> <body>`, `button <from> <payload>` (template button shape), `ibutton <from> <id>` (interactive shape), `list <from> <id>`, `flow <from> <flow_token> <json>`, `status <wamid> <status>`, `document <from> <mediaId>`.
`scripts/deploy_functions.mjs [slug...]` — Management API multipart deploy: POST `https://api.supabase.com/v1/projects/{ref}/functions/deploy?slug={slug}` with form-data: `metadata` = JSON `{name, entrypoint_path: 'index.ts', verify_jwt: <bool>}` and one `file` part per source file (relative paths). verify_jwt: wa-webhook=false, scheduler=false, admin-actions=true, docgen=false (it self-guards via service-key/x-internal-secret check).

## Non-negotiables

- No secrets in committed files. `.env` is gitignored; never write new secrets elsewhere.
- Every WhatsApp send goes through `_shared/wa.ts` (ledger discipline).
- All user-visible copy bilingual-ready: templates en+hi; flows single JSON with "हिंदी / English" combined labels.
- Hindi: formal/respectful (आप), simple vocabulary, medically clear. No transliteration in hi templates (real Devanagari).
- Timestamps display IST.
- Idempotency everywhere a retry can happen (webhook dedupe, event dedupe, bootstrap upserts).
