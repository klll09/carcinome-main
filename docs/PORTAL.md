# Role portals — patient, nurse, doctor

The web side of the same cases the WhatsApp number already coordinates. WhatsApp stays the
system of record and the place where things *happen*; the portal is a **window** onto it.

---

## The one-paragraph version

A patient, nurse or doctor picks their role on `#welcome`, types their mobile number, and gets
a one-time link on WhatsApp. Tapping it exchanges the link for a 30-day bearer session. Every
portal read then goes through the `portal` edge function, which holds the service key and
scopes each query to that one person. **RLS is untouched — still admin-only on every table.**

---

## Why it is built this way

### Login is a WhatsApp magic link, not a password

We already own the channel and every person already has a verified number on file. There is
nothing to issue, reset or leak, and an elderly patient's family does not have to remember
anything. The link always goes **to the number stored on the person's row**, never to the
number typed into the form — so typing a stranger's number sends the link to *them*.

### The portal never queries Postgres from the browser

The admin SPA queries Supabase directly because RLS is admin-only, which is exactly why the
publishable key in `js/config.js` is safe to commit: it can read nothing. Opening the portal
must not weaken that.

Two options existed:

| | Real `auth.users` + per-role RLS | Edge function with the service key |
|---|---|---|
| Where authorization lives | ~15 policies across 10 tables | one file, `portal/index.ts` |
| Failure mode of a mistake | a cancer patient's record leaks | a query returns the wrong rows in review |
| Effect on the committed key | it becomes a real credential | unchanged — still reads nothing |
| Supabase Realtime | native | unavailable — which is why chat uses Socket.IO |

We took the second. Every query in `nurseHome()` starts from `s.person_id`; there is no code
path where a client-supplied id reaches a filter.

### Privacy invariants carried over from the relay

1. **No participant ever sees another participant's phone number.** The relay hub exists so
   the patient's number stays hidden from the nurse and vice versa. `NURSE_CASE_SELECT`
   deliberately omits `wa_number`/`phone`.
2. **An open offer shows the locality only, never the street address.** Same rule
   `admin-actions` applies when it sends `nurse_case_offer`. The full address appears only
   once she is the assigned nurse.

### Anti-enumeration

`request_link` **always** answers `{ ok: true }` — unknown number, opted-out, rate-limited and
delivered are indistinguishable from outside, because "is this number a cancer patient?" is
itself a sensitive question. The success screen in the UI says the same thing regardless.
Rate limiting is per *destination* number (5/hour default), so hammering the form cannot spam
somebody else's WhatsApp.

### The staff door is fail-closed

`#welcome` renders the admin entry only after the server confirms `portal.show_admin_login`.
If the config call fails, is slow, or the flag is off, it stays hidden. `#login` still works
when typed directly, so hiding it never locks the team out — and the admin login carries a
link back to the role doors so it is not a dead end.

---

## Deploying it

```bash
node scripts/apply_sql.mjs sql/10_portal.sql
```

```bash
node scripts/deploy_functions.mjs portal
```

Then set the two values that are environment-specific, in Settings or directly in
`settings.portal`:

- **`app_url`** — the deployed SPA root, trailing slash. The link is built as
  `<app_url>#portal/enter?t=<token>`. A wrong value means links that 404 on a patient's phone.
- **`wa_number`** — the business number, digits only with country code. ⚠️ The default is the
  **pilot/test** number. Change it in the same breath as the `WA_PHONE_ID` secret at cutover,
  or the portal sends people to a number that no longer runs their cases.

Set `show_admin_login: false` for production.

To preview the SPA locally: `.claude/launch.json` serves it on port 4173.

---

## What exists today

| Route | What it is |
|---|---|
| `#welcome` | the front door — three role doors + the (hideable) staff door |
| `#portal/login?role=…` | phone entry, then "check your WhatsApp" |
| `#portal/enter?t=…` | where the magic link lands; burns the token out of the URL immediately |
| `#portal/home` | dispatches by role — patient, nurse and doctor dashboards |
| `#portal/chat` | the case group chats (patient + allotted nurse + referring doctor) |
| `#chat` | admin view of every case chat, read and write |

Portal function actions: `config`, `request_link`, `sample_login`, `verify` (public); `me`,
`logout`, `nurse_home`, `patient_home`, `doctor_home` (bearer session). `sample_login` is dead unless
`settings.portal.sample_login` is explicitly true — leave it unset in production.

The nurse dashboard answers one question at a time, in the order the day happens: an arrival
code waiting **now** → an unanswered "are you going?" → sessions that never closed out →
today's visits → offers → the rest of the week → standing figures. Every card ends in a
WhatsApp link, because the portal shows and WhatsApp does.

---

## What is next, and one thing to decide

**Sample logins are client-side.** With `CONFIG.SAMPLE_LOGIN` on, `js/portal/sample.js`
answers `me` / `<role>_home` locally and the network is never touched — so all three
dashboards open with nothing running at all. Chat still needs the socket server, since a
socket cannot be faked from a static file. The sample payload shapes deliberately mirror the
edge function's; change one and change the other, or the demo stops predicting production.

**Group chat — built.** See the Group chat section of the [README](../README.md).

Rooms are cases; the patient, their allotted nurse and the referring doctor share one, and
admins can read and write all of them. Scoping lives in `server/store.mjs` and is re-checked
on every join and every send; `server/test-access.mjs` asserts it, negatives included.

Transport is **Socket.IO**, per the explicit request, which is why it ships as its own Node
process — GitHub Pages serves static files only and cannot host a WebSocket server. Two
consequences worth planning around:

- It is a second thing to deploy and keep running. The dashboard degrades gracefully when it
  is down (the nurse dashboard still renders, chat shows a clear error), but chat is simply
  unavailable until it is back.
- Messages persist into the existing `messages` ledger as `msg_type='web_chat'`, so the
  one-thread property holds: the admin Message log shows web chat alongside WhatsApp traffic.

Web chat does **not** currently fan out to WhatsApp. Wiring `append()` into `fanOut` would
close the loop in the other direction — a patient typing on the web reaching a nurse who only
has the phone — but it sends real WhatsApp messages, so it should be a deliberate switch with
its own setting rather than a silent default.
