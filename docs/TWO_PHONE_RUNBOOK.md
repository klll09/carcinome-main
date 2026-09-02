# Two-Phone Rehearsal Runbook — one person, two numbers, four roles

The whole system rehearsed with just **your two numbers**. Phone 1 is the *staff* phone, Phone 2 is the *family* phone. Yes, it gets busy — that is the point: you see everything.

| Phone | Hats it wears | What lands on it |
|---|---|---|
| **Phone 1 — STAFF** | 🩺 Nurse Asha (primary) · 🥼 Dr. Arjun Mehta · 🛟 Supervisor + Ops | Nurse offer/assignment/OTP prompts, **every doctor mirror**, every team alert |
| **Phone 2 — FAMILY** | 🧑 Patient · 🔁 Nurse Priya (standby) | Everything the patient gets (consent, OTP code, invoice, PDFs, feedback) + the standby 🚨 ping |

Setup (once): `node scripts/setup_two_phone.mjs <phone1> <phone2> --exclusive`
Then warm both phones (send "Hi" from each to the business number) and register the case from the dashboard: **patient = phone 2**, **doctor = Dr. Arjun Mehta (phone 1)**, price **₹1**, scheduled **today +3–4 hours**.

**How to read the mess (say this out loud before you start):** the same physical phone will buzz for different hats. Every relayed line is prefixed with the speaking hat (🧑 patient, 🩺 nurse, 🥼 doctor, 🛟 ops) and every doctor mirror is phrased "Dear doctor…". When Phone 1 buzzes, read the prefix first.

Two-phone quirks (by design, not bugs):

- The old "never double these roles" list is **gone** — participants are now stored per role, and the relay sends **at most one copy per phone**.
- The Act-6 "doctor stays silent until JOIN" beat can't be shown here: Phone 1 already receives all chat *as the nurse*. The doctor's separateness shows instead through the **doctor-phrased mirrors** ("✍️ consent signed by…", "🧾 invoice sent…").
- A phone never gets an echo of its own message, whichever hat sent it.

---

## The acts

Acts 1–2 (register, both nurses Accept), 4 (consent), 5 (OTP), 6 (relay), 7 (complete + PDFs), 8 (payment), 9 (feedback + archive) run exactly as the main RUNBOOK — with Phone 1 playing P2+P3+P5 and Phone 2 playing P1+P4. Below are the beats that are **new or different**.

### Act 1–3 — register, respond, assign (what's new: the mirrors)

- Register → Phone 2 gets the patient confirmation, Phone 1 gets the doctor acknowledgement **and** the nurse offer (two hats, two messages).
- Both phones tap **Accept** on the nurse offer (Asha #1, Priya #2). Team alerts land on Phone 1.
- Assign **Asha** → Phone 1 gets the full-address nurse assignment AND the doctor "nurse confirmed" note; Phone 2 gets the patient confirmation, then the consent invite. **From here on, watch Phone 1: every patient moment arrives again in doctor phrasing** — that is the mirror.
  > 📋 ⟨code⟩: the consent form has been sent to ⟨patient⟩ on WhatsApp. You will be notified when it is signed.

### ⭐ NEW Act 3½ — "Are you going?" + the standby cascade (6 min)

The beat you asked for: *the nurse just types something — we confirm she's actually going; if not, the standby fires.*

1. **Founder (dashboard):** case page → **Ask "Are you going?"** button.
2. **Phone 1 (Asha):** receives, with two buttons **[Yes, on my way] [No, can't go]**:
   > Hello Asha — quick check for case ⟨code⟩ (⟨care⟩, ⟨time⟩): are you available and going for this session? Please confirm within ⟨n⟩ minutes, otherwise our standby nurse will be contacted.
3. **Phone 1:** tap **No, can't go** →
   - Phone 1 (as nurse): "Understood — thank you for telling us in time. We are arranging a replacement…"
   - Phone 1 (as team): "❌ ⟨code⟩: nurse Asha can NOT attend — standby cascade starting."
   - Phone 1 (as doctor): "⚠️ ⟨code⟩: the assigned nurse can no longer attend. A standby nurse is being confirmed…"
   - **Phone 2 buzzes 🚨 — the standby ping, second hat of the family phone:**
     > 🚨 Priya, case ⟨code⟩ (⟨care⟩, ⟨time⟩, ⟨area⟩) needs a nurse — the assigned nurse can no longer attend. Can you take this session? Please reply within ⟨n⟩ minutes. **[Yes, I can go] [No, I can't]**
4. **Choose your ending:**
   - **Ending A — cascade + recovery (recommended, keeps the show clean):** Phone 2 taps **No, I can't** → team gets "⏱/🚨 no standby nurse could be found — assign manually NOW" (the exhaustion alarm). Then re-tap **Ask "Are you going?"** and have Phone 1 answer **Yes, on my way** → nurse thank-you + patient "🩺 Nurse Asha has confirmed" + doctor mirror + team ✅. Case still belongs to Asha; continue to Act 4.
   - **Ending B — the full swap:** Phone 2 taps **Yes, I can go** → *auto-reassignment, no dashboard touch*: Priya gets the quick ack then the full-address assignment; the patient is told the new nurse's name; the doctor gets the new "nurse confirmed"; the old nurse is released ("no further action needed"); team gets "🔁 standby accepted and AUTO-REASSIGNED". Spectacular — but now patient and nurse share Phone 2 (the OTP handshake becomes one-phone theatre). Reassign back to Asha from the dashboard before Act 5 if you want the clean version.
5. **Silence variant (optional, on a throwaway case):** answer nothing. After the reply window (default 10 min via the setup script) the cron reaper fires the same cascade by itself — "⏱ no availability reply from the assigned nurse — triggering the standby cascade."
6. Dashboard check: the case page availability strip shows every check — who was asked, which hat, Confirmed going / Can't go / No reply / Waiting.

### Acts 4–8 — consent → OTP → relay → complete → payment (what's new: doctor hears everything)

Run them as in the main RUNBOOK (Phone 2 does everything the patient does; Phone 1 does everything the nurse does). New arrivals to point at, all on Phone 1 in doctor phrasing:

- Consent submitted → > ✍️ ⟨code⟩ (⟨patient⟩): the consent form has been signed by ⟨name⟩ (⟨relation⟩). Care can proceed as planned.
- OTP issued → > 🔐 ⟨code⟩ (⟨patient⟩): the arrival verification code has been issued to the patient. Nurse Asha will verify it in person on arrival… *(the code itself is never shown to the doctor)*
- Care complete → > 🧾 ⟨code⟩ (⟨patient⟩): the home-care session is complete. Invoice ⟨no⟩ (₹1) has been sent to the patient; your discharge summary copy follows. — then the discharge PDF itself.
- Patient taps **I've paid** → > 💰 ⟨code⟩: the patient has marked the invoice as paid. Our team is verifying it…
- Payment verified → the payment-received message, doctor copy (as before).
- Feedback submitted (Act 9) → > ⭐ ⟨code⟩: the patient shared feedback — overall 5/5, nurse 5/5, would recommend. Thank you for the referral.

### ⭐ NEW Act 10 — the doctor sets the next chemo date (4 min)

*"After everything is said and done, the doctor puts in the next date of chemo."*

1. Right after the discharge summary (and again after payment is verified) Phone 1 receives, as the doctor:
   > When everything is settled, please set ⟨patient⟩'s next chemo date — tap below, or reply NEXT ⟨date⟩ (e.g. NEXT 24/07) anytime. **[📅 Set next chemo]**
2. **Phone 1:** tap **📅 Set next chemo** → "Please send the next chemo date… For example: 24/07, 24 Jul, or 24 Jul 2026. Reply CANCEL to stop."
3. **Phone 1:** type just the date, e.g. `24/07` (also accepted anytime, without the button: `NEXT 24/07`, `NEXT 24 Jul`, `NEXT tomorrow`). A garbled date gets a polite re-prompt; a past date is refused.
4. Expected, instantly:
   - **Phone 1 (doctor):** "✅ Next chemo for ⟨patient⟩ (⟨code⟩) is set for **Fri, 24 Jul, 2026**. The patient and our team have been informed. Reply NEXT ⟨date⟩ anytime to change it."
   - **Phone 2 (patient):** "📅 Dr. Mehta has scheduled your next chemotherapy for **Fri, 24 Jul, 2026**. Our team will contact you before the date to arrange the home-care session."
   - **Phone 1 (team):** "📅 ⟨code⟩: Dr. Arjun Mehta set the next chemo date — … Register the follow-up case closer to the date."
5. Dashboard check: the case header now carries the blue **📅 Next chemo** chip. Changing it is just `NEXT ⟨new date⟩` again.
6. Curtain: archive the case (Act 9 of the main runbook).

---

## Two-phone scorecard (the NEW beats only)

| Beat | Where | ✔ |
|---|---|---|
| "Are you going?" buttons to the nurse | Act 3½, Phone 1 | ☐ |
| Decline → standby 🚨 ping on the OTHER phone | Act 3½, Phone 2 | ☐ |
| Standby decline → 🚨 exhaustion alarm | Act 3½ A, Phone 1 | ☐ |
| Standby accept → auto-reassign fan-out | Act 3½ B, both | ☐ |
| Timeout reaper fires the cascade by itself | Act 3½ silence variant | ☐ |
| Doctor mirror: consent sent + signed | Act 3/4, Phone 1 | ☐ |
| Doctor mirror: OTP issued (no code shown) | Act 5, Phone 1 | ☐ |
| Doctor mirror: invoice + paid-claim + feedback | Acts 7–9, Phone 1 | ☐ |
| 📅 Set next chemo button → date parsed → patient told | Act 10, both | ☐ |
| NEXT ⟨date⟩ keyword works without the button | Act 10, Phone 1 | ☐ |
| Next-chemo chip on the case page | Act 10, dashboard | ☐ |

If a message doesn't arrive, use the same triage as the main RUNBOOK (Messages page → Sandbox test → warm the window).

---

## v3 — Typed arrival + typed ending (no pre-tappable honesty buttons)

**Why:** an "I've reached" button could be tapped from home. So arrival is a TYPED
announcement in the nurse's own words, and the PROOF stays the 6-digit code that only
the patient's phone has. Endings are typed too — by nurse **or** patient — but every
fuzzy phrase goes through one confirm button, because a false positive would fire the
invoice pipeline. Exact `DONE` still skips the confirm.

### Act 5 (rewritten) — arrival, the natural way
1. No admin needed anymore. **Phone 2 (nurse Priya)** simply types `Reached` (or
   "I have arrived", "pahunch gayi", "आ गई") when she's at the door.
2. Expected, instantly:
   - **Phone 2 (patient):** the 6-digit arrival number ("give it to the nurse in person").
   - **Phone 2 (nurse):** "ask the family for the arrival number and send it here."
   - **Phone 1 (doctor):** 🔐 mirror — code issued, never the code itself.
   - **Phone 1 (team):** 🚪 "nurse says she has REACHED — awaiting code verification."
3. Repeating "reached" never re-issues a live code; future tense ("will reach by 5",
   "nikal gayi hu", "omw") stays normal chat. If the code expired, typing "Reached"
   again issues a fresh one — no dashboard.
4. **Phone 2** types the 6 digits → in_care, exactly as before. (Admin "Issue OTP"
   still exists as a fallback.)

### Act 6½ — ending, from either side
- **Nurse:** types anything like "session over", "all done", "ho gaya" → one confirm:
  **[✅ Yes, complete] [Just a message]**. Yes → completion report form → invoice +
  discharge cascade. "Just a message" → the original text is relayed as normal chat.
- **Patient:** types "ho gaya" / "nurse finished" → confirm **[✅ Yes, finished]**.
  Yes → patient thanked, NURSE nudged with the report form, doctor mirrored
  ("patient reports session complete"), team alerted to chase the report.
- Exact `DONE` from the nurse still fires the form immediately, no confirm.

### New-beat scorecard additions
| Beat | Where | ✔ |
|---|---|---|
| Typed "Reached" auto-issues the code (no admin) | Act 5, Phone 2 | ☐ |
| "will reach by 5" stays chat (no false trigger) | Act 5, Phone 2 | ☐ |
| Nurse "session over" → confirm → report form | Act 6½, Phone 2 | ☐ |
| "Just a message" path relays the original text | Act 6½, Phone 2 | ☐ |
| PATIENT "ho gaya" → nurse nudged + doctor mirror | Act 6½, both | ☐ |
| Assignment + reminder teach the arrival protocol | Acts 3/4½, Phone 2 | ☐ |
