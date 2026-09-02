# Carcinome Home Care

WhatsApp-first oncology home-care coordination for Jarurat Care Foundation.

One WhatsApp Business number is the entire product surface for patients, nurses, referring
doctors, equipment suppliers and ops. This repo holds the admin dashboard, the patient /
nurse / doctor web portals, the Supabase schema, and the five edge functions that run the
whole care loop — registration, nurse offers, consent, arrival verification, invoicing,
discharge summaries and feedback.

---

## ⚠️ Read this before running anything

**There is no dry-run mode anywhere in this system.** Every action that says it sends a
message sends a *real* WhatsApp message to a *real* phone. `js/config.js` points at the live
Supabase project, so a dashboard you started on `localhost` is talking to production data and
production phone numbers.

Before you click anything that sends:

- Check **Settings → Nurses** — case offers go to *every* eligible nurse. Mark the real ones
  ineligible before rehearsing.
- Use `scripts/fake_webhook.mjs` and `scripts/e2e_pilot.mjs` for testing. They drive the real
  pipeline with synthetic actors instead of messaging people.
- The pilot runs on the **test** WhatsApp number. Confirm which number is live before a demo.

---

## Prerequisites

| | |
|---|---|
| **Node.js 18+** | for the `scripts/` tooling (uses global `fetch`) |
| **Python 3** | only to serve the SPA locally — any static server works |
| A browser | that's it |

**The dashboard and portals have no dependencies to install.** No build step, no bundler;
every script in `scripts/` imports only `node:` builtins and the SPA is vanilla ES modules
loaded straight from disk.

The one exception is the group-chat server in `server/`, which needs `npm install` — Socket.IO
cannot be a static file. See [Group chat](#group-chat).

---

## Run the dashboard locally

The SPA is static files. Serve the repo root over HTTP — ES modules won't load over `file://`.

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>. Sign in at the staff door with your admin account.

A launch config is committed at `.claude/launch.json` if your editor uses one.

You do **not** need Supabase credentials, `.env`, or any deploy step to do this — the app
points at the live project already. See the warning above about what that means.

---

## Full setup (new Supabase project)

Only needed when standing the system up somewhere fresh. Skip to
[Everyday commands](#everyday-commands) for an existing deployment.

### 1. Create `.env` in the repo root

**`.env` is gitignored and must stay that way — this repo is public.** Never put a secret in
any other file.

```
SUPABASE_PAT=sbp_...                  # Supabase Management API personal access token
SUPABASE_PROJECT_REF=abcdefghij       # project ref from the dashboard URL
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
ADMIN_PASSWORD=...                    # the admin account, for e2e_pilot

WA_TOKEN=...                          # Meta system-user token
WA_APP_ID=...
WA_APP_SECRET=...                     # signs webhook payloads
WA_PHONE_ID=...                       # phone number id
WA_WABA_ID=...                        # WhatsApp Business Account id
WA_VERIFY_TOKEN=...                   # any string; must match Meta's webhook config
CRON_SECRET=...                       # any long random string
```

### 2. Apply the schema, in order

```bash
node scripts/apply_sql.mjs sql/01_schema.sql
```

Then repeat for `02_rls`, `03_functions`, `04_seed`, `06_two_phone_rehearsal`,
`07_availability_hardening`, `08_flows`, `09_poc_observers`, `10_portal`.

> **Skip `05_cron.sql` here.** It contains `{{CRON_SECRET}}` / `{{SUPABASE_URL}}` placeholders
> on purpose — applying it directly installs broken cron jobs. Use step 5.

Every file is idempotent, so re-running one is safe.

### 3. Set the edge-function secrets

In the Supabase dashboard under **Edge Functions → Secrets**:

```
WA_TOKEN  WA_APP_SECRET  WA_PHONE_ID  WA_WABA_ID  WA_VERIFY_TOKEN  CRON_SECRET
GEMINI_API_KEY        # optional — the LLM concierge degrades cleanly without it
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the
runtime; don't set them.

### 4. Deploy the edge functions

```bash
node scripts/deploy_functions.mjs
```

Deploys all six (`wa-webhook`, `admin-actions`, `docgen`, `scheduler`, `doc-extract`,
`portal`) with the right `verify_jwt` flag each. Pass slugs to deploy a subset.

### 5. Install the cron jobs

```bash
node scripts/setup_cron.mjs
```

Reads `sql/05_cron.sql`, substitutes the secrets from `.env`, applies it, and prints the live
`cron.job` table.

### 6. Bootstrap the WhatsApp assets

```bash
node scripts/bootstrap_wa.mjs
```

Creates and publishes the three in-chat forms (consent / completion / feedback), stores their
Meta ids in `settings.flow_ids`, submits every message template in both languages, syncs
their approval status into `wa_templates`, and subscribes the app to the WABA.

Templates need Meta's review — expect a wait. Re-run with `--sync-only` to refresh statuses.

Point Meta's webhook at `https://<ref>.supabase.co/functions/v1/wa-webhook` using your
`WA_VERIFY_TOKEN`.

### 7. Seed the Journeys canvases (optional)

```bash
node scripts/seed_flows.mjs
```

### 8. Configure from the dashboard

**Settings** — supervisor numbers, ops numbers, UPI ID and business name, pricing, automation
windows. Without supervisor/ops numbers there are no escalation or consent alerts.

**`settings.portal`** — set `app_url` to the deployed SPA root (with trailing slash) and
`wa_number` to the business number. The magic-link login builds URLs from `app_url`, so a
wrong value means sign-in links that 404 on a patient's phone. Set `show_admin_login: false`
for production to hide the staff door. See [docs/PORTAL.md](docs/PORTAL.md).

---

## Deploying the SPA

Static hosting — the repo is served from GitHub Pages. Push, and it's live.

**One rule:** when you change any JS or CSS, bump `CONFIG.VERSION` in
[js/config.js](js/config.js) **and** the matching `?v=` query strings in
[index.html](index.html). They must stay in step. `app.js` is the only module the browser
fetches by URL; every page module is then requested at `?v=CONFIG.VERSION`. If the two drift,
a returning visitor gets a cached `app.js` that requests fresh page modules, the deploy
half-lands, and the symptom is "the new page isn't there" on machines that have visited
before.

---

## Everyday commands

```bash
node scripts/deploy_functions.mjs wa-webhook admin-actions
```

```bash
node scripts/bootstrap_wa.mjs --sync-only
```

```bash
node scripts/apply_sql.mjs sql/10_portal.sql
```

---

## Testing

Drive the real pipeline without messaging anybody:

```bash
node scripts/e2e_pilot.mjs
```

Runs register → offer → accept → assign → consent → OTP → relay → completion → PDFs →
invoice → payment claim → verify → archive with synthetic actors. WhatsApp sends report
`failed` (test-number allowlist) — that is expected; what it proves is routing, state
transitions, ledger discipline, ranking, the OTP handshake, docgen and the payment loop.
Pass `--keep` to leave the case unarchived.

Fire individual signed webhook payloads:

```bash
node scripts/fake_webhook.mjs text 919876543210 "Reached"
```

Kinds: `text`, `button`, `ibutton`, `list`, `flow`, `status`, `document`. Payloads are signed
with `WA_APP_SECRET` exactly as Meta signs them.

Wire a two-phone rehearsal (one person, two numbers, four roles):

```bash
node scripts/setup_two_phone.mjs 91XXXXXXXXXX 91YYYYYYYYYY --exclusive
```

`--exclusive` marks every other nurse ineligible so real nurses can't receive the rehearsal
offers. It prints who it changed so you can restore them afterwards.

Rehearsal scripts: [docs/RUNBOOK.md](docs/RUNBOOK.md) and
[docs/TWO_PHONE_RUNBOOK.md](docs/TWO_PHONE_RUNBOOK.md).

---

## Group chat

Case group rooms — the patient, their allotted nurse and the referring doctor — over
Socket.IO. GitHub Pages cannot host a WebSocket process, so this is a **separate deployable**.

```bash
cd server && npm install
```

Run it with sample data, no Supabase and no credentials needed:

```bash
cd server && npm run demo
```

Run it against the real project:

```bash
cd server && SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... CHAT_ORIGINS=https://your.site npm start
```

Point the SPA at it with `CONFIG.CHAT_URL` in [js/config.js](js/config.js).

**Who sees what** is decided server-side in `server/store.mjs` from the authenticated
identity, and re-checked on every join and every send:

| Role | Rooms |
|---|---|
| Patient | cases where they are the patient |
| Nurse | cases **allotted** to them (not merely offered) |
| Doctor | cases they referred |
| Admin | every case — read and write, posting as the care team 🛟 |

Verify it after any change to the scoping rules:

```bash
cd server && node test-access.mjs
```

Messages persist into the existing `messages` ledger as `msg_type='web_chat'`, so web chat
and WhatsApp are one thread and the admin Message log shows both.

### Sample logins

`CONFIG.SAMPLE_LOGIN: true` puts the app in demo mode.

**There is no sign-in step.** Click a role on the landing page and you are in — no phone
number, no magic link, no password. The staff door is always visible too. Sample logins need
**nothing running**: `js/portal/sample.js` answers locally and the network is never touched,
so the patient, nurse and doctor dashboards all open off the static files alone.

Only the **chat** needs `server/` up, because a socket cannot be faked from a static file. If
it is down, the dashboards still work and only the chat panel reports it — with the command
to start it.

⚠️ **Set it to `false` for production.** Sample logins are unauthenticated by design. The
server side is independently gated on `settings.portal.sample_login`, so flipping the client
flag alone cannot open a real deployment — but do not rely on one gate.

To seed sample people and cases in a **non-production** Supabase project:

```bash
node scripts/apply_sql.mjs sql/11_sample_accounts.sql
```

That file switches `sample_login` on and carries a teardown block at the bottom. Do not apply
it to production.

---

## Repo layout

```
index.html            SPA entry — boot screen, watchdog, stylesheet + module versions
css/                  design tokens, base, components, layout, journeys, portal
js/
  app.js              boot: magic link → portal session → admin session → landing
  router.js           hash router; `fullPage` routes own #app, others fill the shell
  pages/              one module per route, `export default (container, params)`
  portal/             portal client + shell (patient / nurse / doctor)
  components/  utils/  shared UI and formatting
sql/                  01–10, applied in order (05 goes through setup_cron.mjs)
supabase/functions/
  wa-webhook/         inbound messages + delivery statuses
  admin-actions/      dashboard-triggered actions
  portal/             magic-link auth + portal reads
  docgen/             invoice + discharge PDFs
  scheduler/          cron-driven jobs
  doc-extract/        serves a sibling project, not this one
  _shared/            wa.ts (every send), relay, assign, otp, availability, llm, …
server/               Socket.IO group-chat server (its own npm project)
wa/                   template catalog + the three Flow JSON definitions
scripts/              setup, deploy and test tooling
docs/                 CONTRACTS, RUNBOOK, TWO_PHONE_RUNBOOK, PORTAL
```

---

## Known gaps
Two things in the tree that don't work yet, so you don't lose time to them:

- **The Message copy page (`#copy`) has no backend.** `js/pages/copy.js` and
  `js/copy_registry.js` are complete, but the eight admin-actions they call (`list_copy`,
  `preview_copy`, `save_copy_draft`, `publish_copy`, `revert_copy`, `refresh_copy_media`,
  `send_copy_test`, `draft_copy_gemini`) don't exist in the dispatcher, and the
  `message_copy_versions` table isn't in any migration. The page fails on load. Live message
  wording currently lives in the edge functions as inline literals.
- **`scripts/visual_tour.mjs` won't run** outside the machine it was written on — it imports
  Playwright from a hardcoded absolute Windows path in a sibling project.

---

## Documentation

| | |
|---|---|
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | binding conventions — phone canonicalisation, button payloads, flow tokens, ledger discipline. Historical on scope, current on conventions. |
| [docs/PORTAL.md](docs/PORTAL.md) | the role portals: magic-link auth, why RLS is untouched, deploy steps, what's next |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | the live rehearsal — nine acts, every message type, word for word |
| [docs/TWO_PHONE_RUNBOOK.md](docs/TWO_PHONE_RUNBOOK.md) | the same show on two phones |
