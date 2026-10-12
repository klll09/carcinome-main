# Carcinome Home Care

WhatsApp-first coordination system for at-home oncology nursing (chemo infusions, port/PICC care, 12h/24h nursing). One WhatsApp business number connects the **patient, nurse, referring doctor, equipment supplier and the care team** around a single case, and a web dashboard lets the team run every case end to end.

**Case flow:** register → offer to nurses → assign → consent → arrival OTP → in care (relayed chat) → completion report → invoice + discharge PDFs → UPI payment → feedback → archive.

> **Status:** pilot. Runs on the Meta **test** WhatsApp number; production cutover has not been done (see [Deployment](#deployment)).

---

## Architecture

There is **no build step**. Three separately deployed parts:

| Part | Tech | Hosted on |
| --- | --- | --- |
| Admin dashboard + role portals | Vanilla JS ES modules, hash router, plain CSS (`index.html`, `js/`, `css/`) | GitHub Pages |
| Backend | Supabase: Postgres + Deno Edge Functions + Storage + pg_cron (`sql/`, `supabase/functions/`) | Supabase |
| Web group chat | Node.js + Socket.IO (`server/`) | Render |

External services: **Meta WhatsApp Cloud API** (Graph v23.0), **Google Gemini** (`gemini-2.5-flash`, fallback text understanding), **UPI** intent payments.

```
People on WhatsApp ⇄ WhatsApp Cloud API ──webhook──▶ wa-webhook ─┐
Admin dashboard ─────────────────────────────────▶ admin-actions ─┤
pg_cron ──────────────────────────────────────────▶ scheduler ─────┼─▶ Postgres + Storage
                                          docgen / portal ─────────┤
Portals ──web chat──▶ Chat server (Socket.IO) ──────────────────────┘
```

Every WhatsApp send goes through `supabase/functions/_shared/wa.ts`, which logs a row in the `messages` ledger first. Never call the Graph API directly.

---

## Repository layout

| Path | Contents |
| --- | --- |
| `index.html`, `js/app.js`, `js/router.js` | App shell, auth guard, route table |
| `js/config.js` | Supabase URL, **publishable** key, functions URL, `CHAT_URL`, `SAMPLE_LOGIN` |
| `js/pages/` | One module per screen (`export default async function render(container, params)`) |
| `js/portal/` | Patient / nurse / doctor portal |
| `js/components/`, `js/utils/` | Shared UI and helpers (`api.js → adminAction()`) |
| `css/` | Design tokens and styles |
| `sql/01–12_*.sql` | Database migrations, applied in number order |
| `supabase/functions/wa-webhook/` | Inbound WhatsApp (buttons, flows, text, media, statuses) |
| `supabase/functions/admin-actions/` | Dashboard actions that change case state or send messages |
| `supabase/functions/docgen/` | Invoice + discharge-summary PDFs (pdf-lib, English/Hindi) |
| `supabase/functions/scheduler/` | Cron jobs: reminders, OTP, SLA nudges, availability, feedback, archiver |
| `supabase/functions/portal/` | Portal login (WhatsApp magic link / email) and portal data |
| `supabase/functions/doc-extract/` | Gemini document extraction for the separate Patient Navigator project |
| `supabase/functions/_shared/` | `wa.ts`, `relay.ts`, `assign.ts`, `availability.ts`, `otp.ts`, `llm.ts`, … |
| `wa/templates.catalog.mjs` | All WhatsApp templates (English + Hindi) |
| `wa/flows/*.json` | WhatsApp Flow forms: consent, completion, feedback |
| `server/` | Socket.IO chat server |
| `scripts/` | Deploy, migrate, cron, WhatsApp bootstrap and test tools |
| `docs/` | `CONTRACTS.md` (conventions — read first), `RUNBOOK.md`, `TWO_PHONE_RUNBOOK.md`, `PORTAL.md` |

---

## Quick start

### Demo mode (no credentials)

```bash
cd server
npm install
npm run demo                 # chat server with in-memory sample data on :3001

# locally only, do NOT commit: in js/config.js set
#   CHAT_URL: 'http://localhost:3001'
#   SAMPLE_LOGIN: true

cd ..
python3 -m http.server 4173  # open http://localhost:4173/#welcome
```

### Against the real backend

```bash
python3 -m http.server 4173  # open http://localhost:4173/#login
```

Log in with an admin account (Supabase Auth user with a `profiles` row where `role='admin'` and `is_active=true`).

### `.env` (repo root, gitignored — needed for scripts)

```dotenv
SUPABASE_PAT=
SUPABASE_PROJECT_REF=
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
ADMIN_PASSWORD=
WA_TOKEN=
WA_APP_ID=
WA_APP_SECRET=
WA_PHONE_ID=
WA_WABA_ID=
WA_VERIFY_TOKEN=
CRON_SECRET=
```

Edge-function secrets are set in Supabase (Edge Functions → Secrets): `WA_TOKEN`, `WA_APP_SECRET`, `WA_PHONE_ID`, `WA_WABA_ID`, `WA_PROD_PHONE_ID`, `WA_PROD_WABA_ID`, `WA_VERIFY_TOKEN`, `CRON_SECRET`, `GEMINI_API_KEY`.

The chat server reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CHAT_ORIGINS` and `PORT` from its own environment.

---

## Deployment

| Change | Command |
| --- | --- |
| Frontend | Push to the GitHub Pages repo; bump `VERSION` in `js/config.js` |
| Edge function(s) | `node scripts/deploy_functions.mjs [slug ...]` (no slug = all) |
| Database migration | `node scripts/apply_sql.mjs sql/<file>.sql` |
| Cron jobs | `node scripts/setup_cron.mjs` |
| WhatsApp templates / flows | `node scripts/bootstrap_wa.mjs` (`--sync-only` to refresh approval status) |
| Journeys canvas seed | `node scripts/seed_flows.mjs` |
| Chat server | Redeploy `server/` on Render (`npm start`) |

### Fresh Supabase project

1. Apply `sql/01`–`04`, `06`–`10`, `12` with `apply_sql.mjs` (**skip `11`** — demo data).
2. Create the private storage bucket `case-docs`, an admin Auth user and its `profiles` row.
3. Set function secrets, run `deploy_functions.mjs`, then `setup_cron.mjs`.
4. Run `bootstrap_wa.mjs`; in Meta set the webhook to `<SUPABASE_URL>/functions/v1/wa-webhook`.
5. Update `js/config.js` and the `portal.app_url` / `portal.wa_number` settings.

### Production cutover

- Swap `WA_PHONE_ID` / `WA_WABA_ID` to the production values and bootstrap the production WABA.
- Update `settings.portal.wa_number` at the same time.
- Set `settings.portal.show_admin_login = false`; keep `SAMPLE_LOGIN: false` and `portal.sample_login` off.
- Put the real `upi_vpa`, supervisor and ops numbers in Settings.

---

## Testing

```bash
node scripts/e2e_pilot.mjs [--keep]              # full synthetic case against the live backend
node scripts/fake_webhook.mjs text <from> <body>  # signed fake webhooks (also button, ibutton, list, flow, status, document)
node server/test-access.mjs                       # chat access rules (chat server in demo mode)
```

Live demos with real phones: `docs/RUNBOOK.md` and `docs/TWO_PHONE_RUNBOOK.md`.

---

## Watch out

- **This repo is public.** Commit only the publishable key; secrets belong in `.env` and Supabase secrets.
- **Never apply `sql/11_sample_accounts.sql` to production** — it enables unauthenticated sample logins.
- **Case offers go to every nurse with `is_eligible = true`.** Check before any test.
- WhatsApp allows free text only within 24h of the person's last message; otherwise an **approved** template is required.
- `js/config.js` and `docs/CONTRACTS.md` reference different Supabase project refs — confirm which is live before running scripts.
