# Carcinome Home Care — Live Rehearsal Runbook

One case, nine acts, about 50 minutes on stage. Everything in a grey quote box is the exact wording that should appear on a phone — check it word for word. Anywhere a phone must act, the actor is in **bold**. Angle brackets like ⟨name⟩ are filled in by the system.

---

## Cast & phones

| Phone | Role | Who they play | Number (fill in) |
|---|---|---|---|
| P1 | Patient | The patient / family phone | ______________ |
| P2 | Nurse-1 | The nurse who gets the case | ______________ |
| P3 | Doctor | The referring doctor | ______________ (suggested: 7007334125) |
| P4 | Nurse-2 + Supplier | Backup nurse AND equipment supplier | ______________ |
| P5 | Supervisor + Ops | Your team / manager phone | ______________ (suggested: 7338120082) |

**How many phones do you have?**

| Phones | Layout |
|---|---|
| 6+ (ideal) | Split P4 into two phones — Nurse-2 and Supplier separate. Keep the team phone silent all show so every alert lands as a message. |
| 5 (recommended) | Exactly the cast table above. Nurse-2 + Supplier on one phone is safe: a nurse who is not assigned never joins the case chat, so the two roles never collide. |
| 4 (minimum) | P1 Patient · P2 Nurse-1 + Supervisor + Ops · P3 Doctor · P4 Nurse-2 + Supplier. One quirk: P2 will see the team alert about its own acceptance. |

**Doubling roles on one phone is now fully supported** (participants are stored per role and the relay sends at most one copy per phone), so the old "never combine" landmines are gone. Two practical notes:

- A doubled phone reads its messages by the hat prefix (🧑 🩺 🥼 🛟 📦) — brief the actor.
- The Act-6 "doctor stays silent until JOIN" beat only works when the Doctor's phone carries **no other chat-active role**.

**Only two phones?** Use `docs/TWO_PHONE_RUNBOOK.md` — Phone 1 = Nurse-1 + Doctor + team, Phone 2 = Patient + standby Nurse-2, with the availability/standby act and the next-chemo finale scripted in. Wire it with `node scripts/setup_two_phone.mjs <phone1> <phone2> --exclusive`.

---

## Before you start (20 minutes)

1. Dashboard → Settings → **Supervisor numbers**: enter P5. Without this there are no escalation or lock alerts.
2. Settings → **Ops numbers**: enter P5. Without this there are no consent / arrival / payment alerts, and the dashboard voice can't join the chat.
3. Settings → **UPI ID (VPA) and business name**: put your REAL UPI ID. The pay button opens a real UPI app pointed at whatever is written here.
4. Settings → **Pricing**: leave standard prices; you will override the rehearsal case to ₹1 when you register it.
5. Settings → **Automation**: escalation at 6 hours, arrival-code validity 30 minutes (raise to 60 if you want slack), all switches ON.
6. **Register the two rehearsal nurses (P2, P4) and the supplier (P4) in the dashboard**, with the areas matching the address you will use.
7. **THE BIG ONE: make sure NO real nurse is marked eligible.** Case offers go to EVERY eligible nurse on the live number. Audit the nurse list before the show.
8. **Warm every phone**: each of the five phones sends one WhatsApp message (just "Hi") to **+91 93895 29263** — the day before, or at latest 5 minutes before the show. This opens the chat window so nothing gets stuck.
9. All five actors set to **English** for round one. Phones charged, WhatsApp notifications ON, volume up. (Ask your integrator to confirm the three in-chat forms are live — a one-line question.)

Optional Hindi encore: after the show, flip the patient to Hindi in the dashboard and run a compressed second ₹1 case.

---

## Ground rules (read aloud to the cast)

- **Act only on cue.** Anything typed off-script simply becomes a chat message relayed to the team — harmless, and actually a nice accidental demo.
- **The case price is ₹1.** If anyone really pays, it costs one rupee.
- **Schedule the visit 3–4 hours from now.** This keeps the automatic reminders and the automatic arrival code from firing in the middle of the show.
- **The PDFs take 30–90 seconds to build** after the nurse submits her report. Announce the wait, don't panic.
- **Before anyone taps "Review and Pay":** it opens a real UPI app aimed at the UPI ID in Settings. With ₹1 and your real ID, paying live is a great demo. Otherwise, back out without paying.

---

## The show

### Act 1 — Register the case (5 min)

1. **Founder (dashboard):** register a new case — patient = P1's number, doctor = P3's number (name him inline), care type of your choice, full address, schedule **today, 3–4 hours from now**, price override **₹1**.
2. Expected within seconds:
   - **P1** — registration confirmation:
     > Hello ⟨name⟩, your home-care request (⟨case code⟩) is registered with Carcinome Home Care for ⟨date & time⟩. Our team is identifying the most suitable oncology nurse for your session and will confirm within 6-12 hours. You can reply to this message anytime with questions about your registered request.
   - **P3** — doctor acknowledgement:
     > Dear Dr. ⟨name⟩, your referral for patient ⟨patient⟩ is registered with Carcinome Home Care as case ⟨code⟩. The home-care session is scheduled for ⟨time⟩. We will send you nurse assignment and clinical updates for this registered case on this number.
   - **P4 (supplier side)** — equipment request, nurse still "to be assigned":
     > Equipment request for a registered Carcinome home-care session. Patient: ⟨name⟩. Delivery address: ⟨address⟩. Requirements: ⟨items⟩. Needed by: ⟨time⟩. Nurse: ⟨to be assigned⟩. Reply here to confirm availability or to flag any issue with this request.
   - **P2 and P4 (nurse side)** — the case offer with [Accept] [Decline] buttons:
     > As per your registered nurse profile with Carcinome Home Care, a matching case request awaits your response: area ⟨area⟩, ⟨care type⟩, line: ⟨line⟩, ⟨case code⟩, scheduled ⟨time⟩. Please respond below.

     **Point out:** the offer shows only the locality — never the full address.
   - **P5** — nothing. Correct: the team is only alerted when something needs them.
3. Dashboard check: case status **Offering**; participants show patient, doctor, ops, supervisor, supplier.

### Act 2 — Nurses respond (4 min)

4. **P4 (as Nurse-2):** tap **Decline** → "Noted — thank you for letting us know. 🙏"
5. **P2 (Nurse-1):** tap **Accept** →
   > Thank you, ⟨name⟩! You are response #1 for case ⟨code⟩. Our team will confirm the assignment shortly.

   And **P5** gets the team alert (wrapped in the standard update message): "🩺 ⟨name⟩ ACCEPTED ⟨code⟩ (rank #1). Assign from the dashboard."
6. **P4 (Nurse-2):** now tap **Accept** anyway → registered as response #2, second team alert on P5. Changed minds are welcome.
7. Dashboard check: ranked response list, Nurse-1 green at #1.

### Act 3 — Assign Nurse-1 (4 min)

8. **Founder (dashboard):** assign **Nurse-1**.
9. Expected — five messages fan out at once:
   - **P2** — assignment, now with the FULL address:
     > You are confirmed for a registered Carcinome home-care session. Patient: ⟨name⟩. Address: ⟨full address⟩. Scheduled: ⟨time⟩. Care: ⟨care type⟩, line ⟨line⟩. Check-in instructions will follow in this chat before the visit. Reply here for any coordination on this case.
   - **P1** — nurse confirmed:
     > Update on your registered home-care request: nurse ⟨name⟩ is confirmed for your session on ⟨time⟩. The nurse will carry identification. Further visit instructions will arrive in this chat before the session. Reply here anytime with questions.
   - **P3** — doctor update (note the JOIN line — it matters in Act 6):
     > Update on your referred patient ⟨name⟩ (case ⟨code⟩): nurse ⟨name⟩ is confirmed for the home-care session on ⟨time⟩. You will receive the discharge summary after the session. Reply JOIN to receive all messages for this registered case, or reply here to send a note to the care team.
   - **P4 (nurse side)** — offer closed:
     > Case ⟨code⟩, which was offered to you, has been assigned to another nurse. No action is needed. Thank you for responding.
   - **P4 (supplier side)** — a FRESH equipment message, now naming the real nurse. **Point out the changed name** — the supplier always knows who is coming.
   - **P1** — the consent invite with an [Open consent form] button:
     > Hello ⟨name⟩, before your registered home-care session (case ⟨code⟩) can begin, we need your signed consent. Please open the consent form below, review the procedure details and submit it. Reply here if you need help completing the form.
10. Bonus beat: **P4 (Nurse-2)** taps its old Accept button again → polite reply: "Thank you for responding — case ⟨code⟩ has already been filled. We will reach out for the next one. 🙏" Dashboard check: status **Assigned**.

### Act 4 — Consent (5 min)

11. **P1:** tap **Open consent form**. First screen: the case summary plus four bullet points — procedure explained, possible complications discussed, consent can be withdrawn anytime, health data used to coordinate the care. All form labels appear in Hindi and English together — that is by design, not a glitch. Tap **Continue**.
12. **P1:** fill the form — **Full name** (required), **Relation** dropdown (Self / Spouse / Parent / Child / Guardian / Other), and TWO required tick-boxes: "I consent to the home-care procedure" and "I consent to use of my health data for this care". **Show that the form refuses to submit until both boxes are ticked.** Tap **Submit**.
13. Expected: **P1** thank-you — "Thank you 🙏 Your consent for case ⟨code⟩ has been recorded. Your home-care session will go ahead as scheduled." — and **P5**: "📝 ⟨code⟩: patient consent received (signed by ⟨name⟩)."
14. Dashboard check: status **Consented**; the signed name shows on the case.

### Act 5 — Arrival code (6 min)

15. **Founder (dashboard):** open the case and tap **Issue arrival OTP**. (The automatic sender only runs close to visit time — that is why the button exists.)
16. Expected:
    - **P1**: "Your nurse arrival number for this session is ⟨6 digits⟩. Please give it to nurse ⟨name⟩ in person when they arrive."
    - **P2**: "On arrival at ⟨patient⟩'s address, please ask for the arrival number and send it here to log your visit start time."
17. **P2:** type a **wrong** 6-digit number on purpose → "That arrival number is not correct. Please check with the patient's family and try again. Attempts left: 4."
18. **P2:** read the correct number off P1's screen and send it.
19. Expected:
    - **P2**: "✅ Arrival verified — session for ⟨code⟩ has started. When care is complete, tap below or reply DONE." with a **[Mark care complete]** button. **Keep this message — you need the button in Act 7.**
    - **P1**: "✅ Nurse ⟨name⟩'s arrival has been verified at ⟨time⟩. Your home-care session has started."
    - **P5**: "✅ ⟨code⟩: nurse ⟨name⟩ arrival verified at ⟨time⟩. Session started."
    - **P3**: "🩺 ⟨code⟩ (⟨patient⟩): nurse ⟨name⟩ has arrived — verified at ⟨time⟩. Session in progress."
20. Dashboard check: status **In care**. Do this whole act within 30 minutes of issuing the code — it expires.

### Act 6 — A group chat without a group (6 min)

21. **P1:** send any message, e.g. "The nurse is very kind." → it arrives on **P2**, **P4 (supplier)** and **P5**, each prefixed "🧑 ⟨patient name⟩: …". **P3 stays silent** — hold up the doctor's quiet phone; doctors only get milestones until they join.
22. **P2:** reply "Infusion started, patient is comfortable." → fans to P1, supplier, P5, prefixed "🩺 …".
23. **Founder (dashboard):** send a line from the case composer → everyone active receives it prefixed "🛟 …".
24. **P3 (Doctor):** reply **JOIN** → confirmation: "You have rejoined the case conversation and will now receive all updates. Reply MUTE to pause them again." (Typing any normal note also joins him — JOIN just confirms it explicitly.)
25. **P1:** send one more message → now **P3 receives it too**.
26. Optional: **P2** sends a photo with a caption → phones that have chatted recently get the photo itself; the rest get a note that a file was sent. Dashboard check: the Messages page shows every relayed line.

### Act 7 — Complete the care (6 min, including the wait)

27. **P2:** tap **[Mark care complete]** (or reply DONE). The report form opens: **Medicines** given (required), **Start** time (e.g. 10:30), **End** time, **Complications** — None / Minor / Major (required), a complication **Note**, and other **Notes**.
28. **Say out loud BEFORE the nurse submits:** "The invoice and summary PDFs take 30 to 90 seconds to build. Watch the patient phone."
29. **P2:** submit. Expected, in this order:
    - **P1** — invoice with the PDF attached and a **[Pay now]** button:
      > Invoice ⟨number⟩ for your completed registered home-care session (case ⟨code⟩) is attached. Amount due: INR 1. Tap Pay now to pay by UPI, or reply here after paying so our team can confirm your payment.
    - **P1** — discharge summary with the PDF:
      > Hello ⟨name⟩, the discharge summary for your completed registered home-care session (case ⟨code⟩) is attached. Please keep it in your medical records and share it with your treating doctor at your next visit. Reply here for any questions.
    - **P3** — the same PDF for the doctor:
      > Dear Dr. ⟨name⟩, the discharge summary for your referred patient ⟨name⟩ (case ⟨code⟩) is attached. The registered home-care session is complete. Reply here to send any instructions to the care team.
    - **P1** — the payment card with a **Review and Pay** button: "Invoice ⟨number⟩ for ⟨code⟩ — total ₹1. Tap Review and Pay to pay via UPI. After paying, tap \"I've paid\"." — **always followed by its own small message with the [I've paid] button**: "After completing the payment, tap below so our team can verify it."
    - **P2** — thank-you, deliberately last: "Thank you! 🙏 The completion report for ⟨code⟩ has been recorded. The invoice and discharge summary are being sent to the patient. Great work."
30. Dashboard check: status **Awaiting payment**; both PDFs open from the Documents card.

### Act 8 — Payment (6 min)

31. **Repeat the warning out loud:** Review and Pay opens a real UPI app aimed at the UPI ID in Settings. ₹1 to your own real ID = perfect live demo. Anything else — back out without paying.
32. **P1:** tap **[Pay now]** on the invoice → a fresh payment card arrives, again followed by the **[I've paid]** button. (You can re-issue the card any time this way. If the card ever fails to send, a plain message with the UPI ID arrives instead — the I've-paid button still follows.)
33. **P1:** optionally pay the ₹1 through the card.
34. **P1:** tap **[I've paid]** →
    - **P1**: "Thank you! 🙏 We have noted your payment for invoice ⟨number⟩. Our team will verify it and send you a confirmation shortly."
    - **P5**: "💰 ⟨code⟩: patient marked invoice ⟨number⟩ (₹1) as PAID. Verify against the bank/UPI app, then mark verified in the dashboard."
35. Dashboard check: amber **payment claimed** banner and a needs-action tile.
36. **Founder (dashboard):** tap **Mark paid (verified)** → **P1 and P3** both receive:
    > We have received your payment of INR 1 against invoice ⟨number⟩ for your registered home-care session. Thank you. No further amount is due for this session. Reply here for any questions.

    P5 gets a confirmation too. Status: **Paid**. (This also works if the patient never tapped I've-paid — verified is verified.)

### Act 9 — Feedback and close (6 min)

37. **Founder (dashboard):** case page → billing panel → tap **Send feedback form**.
38. **P1** receives, with a **[Share feedback]** button:
    > Hello ⟨name⟩, your registered home-care session is now complete. Please fill the short service-report form below about this session.
39. **P1:** open and fill — **Overall** 1–5 (required), **Nurse care** 1–5, an "I would recommend Carcinome Home Care" tick, **Comments**. Give 4 or 5 stars — a rating of 2 or less alerts the supervisor (save that for a re-run). Submit → "Thank you for your feedback 🙏 It helps us improve the care we bring to every home. Wishing you good health."
40. Dashboard check: star ratings on the case. **Founder:** tap **Archive case**.
41. Closing beat: **P1** sends "Thank you all" → because the case is closed, the polite standing reply arrives (at most once per day per phone):
    > Namaste 🙏 This is Carcinome Home Care (Jarurat Care Foundation). This number sends updates for active home-care cases. If you need our care services, please contact our team or ask your doctor for a referral.

    (followed by the same in Hindi). Curtain.

---

## Optional Act II — the overnight case

The reminders and the automatic arrival code only make sense a day ahead, so give them their own case.

- **Tonight:** register a second ₹1 case scheduled **tomorrow around 11:00 AM**. Run it through accept → assign → consent tonight (10 minutes).
- **Reminders arrive on their own** — roughly a day before the visit, with a morning sweep at 8:00 AM catching anything closer. Expected:
  - **P1**:
    > Schedule update for your registered home-care session on ⟨time⟩: nurse ⟨name⟩ will visit you at your address. Please keep your prescription and medicines ready. Reply here to reschedule or ask a question.
  - **P2**:
    > Schedule update for your confirmed Carcinome home-care session: patient ⟨name⟩, scheduled ⟨time⟩, address ⟨address⟩. Check-in instructions will follow in this chat. Reply here if you expect any delay.
- **About an hour before the visit** the arrival code sends itself — the same pair of messages as Act 5, with no button pressed. Verify or just let it lapse.
- **Optional escalation demo:** set the escalation hours to **0** in Settings, register a throwaway case, and have nobody accept. Within 15 minutes **P5** receives, with an [Open case] button:
  > Action needed on registered case ⟨code⟩: no nurse has accepted the case request for ⟨n⟩ hours (area: ⟨area⟩). Please open the case to assign a nurse manually or widen the offer pool.

  Then put the setting back to 6 and cancel the throwaway case.

---

## Mini-acts (5 minutes each, any order)

**A. Wrong code** — already built into Act 5, step 17.

**B. Locked code** — on a throwaway case: issue the arrival code, have the nurse send **five wrong codes**. After the fifth: "Too many incorrect attempts — the arrival number is now locked. Our team has been alerted and will contact you shortly." **P5** gets: "🔒 OTP LOCKED on case ⟨code⟩: nurse ⟨number⟩ exhausted all attempts. Verify the situation and re-issue the code from the dashboard." A sixth 6-digit text is treated as ordinary chat. Recover with the **Issue arrival OTP** button — a fresh code.

**C. STOP and reactivate** — only on the **patient phone**, only **after the case is archived** (STOP switches off every record matching that number, on every role). **P1** texts **STOP** → "You have been unsubscribed and will not receive further messages from Carcinome Home Care. If this was a mistake or you need care again, please contact our team. 🙏" Then reactivate from the dashboard. If a phone plays two roles, reactivate both records.

**D. Doctor MUTE and JOIN** — **P3** texts **MUTE** → "Case updates are now muted. You will still receive discharge summaries for your referred patients. Reply JOIN at any time to resume case updates." Even muted, discharge and payment messages still arrive — those are unconditional. **P3** texts **JOIN** → "You have rejoined the case conversation and will now receive all updates. Reply MUTE to pause them again." Self-serve, both directions.

**E. Sandbox demo** — open the dashboard **Sandbox** page and send a test to any warm phone in each of its three modes (automatic, plain text, pre-approved message). Watch the live delivery rail update as each one lands.

**F. "Are you going?" + standby cascade** — after assignment (any time before arrival), case page → **Ask "Are you going?"**. Nurse-1 gets **[Yes, on my way] [No, can't go]** (YES/NO typed replies work too). *Yes* → patient, doctor and team all get the confirmation. *No* (or silence past the reply window — Settings → Automation) → the next ranked accepting nurse is pinged 🚨 as standby; her *Yes* **auto-reassigns the whole case** (patient/doctor/supplier renotified, old nurse released); her *No* cascades onward; an empty pool fires the 🚨 assign-manually alarm. The case page shows an availability strip with every check. Full choreography: `docs/TWO_PHONE_RUNBOOK.md` Act 3½.

**G. Doctor sets the next chemo date** — after the discharge summary (and again after payment verified) the doctor gets **[📅 Set next chemo]**; tapping it (or typing `NEXT 24/07` anytime) sets the date: doctor gets the confirmation, the patient gets "Dr. ⟨name⟩ has scheduled your next chemotherapy for ⟨date⟩", the team gets the register-the-follow-up nudge, and the case header shows the 📅 chip. `NEXT ⟨new date⟩` changes it; CANCEL abandons a pending prompt.

**H. The doctor mirror (running theme, not a separate act)** — every patient moment now re-arrives on the doctor's phone in doctor phrasing: consent sent, consent signed, OTP issued (never the code), session reminders, invoice sent, payment claimed, payment verified, feedback stars, availability changes, opt-out. MUTE still silences the mirrors; discharge + payment documents stay unconditional.

**I. Typed arrival + typed ending** — the nurse announces arrival in her own words ("Reached", "pahunch gayi") — never a pre-tappable button — which auto-issues the 6-digit code to the patient; the typed-back code stays the proof of presence. Future tense ("will reach by 5") stays normal chat; a repeat never re-issues a live code; an expired code re-issues on the next "Reached". Endings work from either side: nurse "session over"/"all done" or patient "ho gaya" → one confirm button (**Yes** fires the completion → invoice → discharge cascade; **Just a message** relays the text as chat). Exact `DONE` still skips the confirm. Full choreography: `docs/TWO_PHONE_RUNBOOK.md` v3 section.

**J. POC observers + STATUS** — every patient can carry a **Carcinome POC** (the intern who owns that family), set on the patient form. The POC's phone gets 📔 log-style milestone lines — "nurse Asha assigned", "consent signed", "family says paid" — never the raw chat. Typing **STATUS** (POC or referring doctor) returns a grouped digest of ALL their patients: current state, what we're waiting on (a pending "are you going?" reply, consent, payment), and the last milestone with time. One POC running four families sees all four in one message.

**K. Flow Studio** — dashboard → **Flow Studio**: every journey above as a Miro-style canvas (drag cards, rewire arrows, rewrite copy with bold/italic/images, duplicate a system flow to customize per patient group, 📌 snapshots for versions). **Document templates** inside it edits the REAL invoice + discharge-summary formats with a live sample PDF preview — saved templates drive every future generated document.

---

## If something doesn't arrive

1. **Open the Messages page** in the dashboard and find the missing message. Its status and any error note tell you most of the story.
2. **Send a Sandbox test** to that same number. If the test lands, the number is fine.
3. **Has that phone messaged the system in the last 24 hours?** If not, its chat window is closed — have it send "Hi" to +91 93895 29263 and retry the step.
4. Still stuck: note the **case code** and the step number, and call your integrator (or Claude) with exactly those two things.

---

## Scorecard — every message type, seen live

| Message | Where you see it | ✔ |
|---|---|---|
| Patient registration confirmation | Act 1, P1 | ☐ |
| Doctor referral acknowledgement | Act 1, P3 | ☐ |
| Nurse case offer (Accept/Decline) | Act 1, P2 + P4 | ☐ |
| Supplier equipment request | Act 1 and again in Act 3 (nurse named), P4 | ☐ |
| Offer closed | Act 3, P4 | ☐ |
| Nurse assignment (full address) | Act 3, P2 | ☐ |
| Patient "nurse confirmed" | Act 3, P1 | ☐ |
| Doctor "nurse confirmed" (JOIN line) | Act 3, P3 | ☐ |
| Consent form invite | Act 3, P1 | ☐ |
| Team update carrier (wrapped alerts) | Every P5 alert all show | ☐ |
| Invoice with PDF (Pay now) | Act 7, P1 | ☐ |
| Discharge summary — patient | Act 7, P1 | ☐ |
| Discharge summary — doctor | Act 7, P3 | ☐ |
| Payment card + I've-paid button | Act 7 and Act 8, P1 | ☐ |
| Payment received confirmation | Act 8, P1 + P3 | ☐ |
| Feedback form invite | Act 9, P1 | ☐ |
| Session reminder — patient | Act II, P1 | ☐ |
| Session reminder — nurse | Act II, P2 | ☐ |
| Supervisor escalation (Open case) | Act II optional demo, P5 | ☐ |

All boxes ticked = the whole message catalog proven live, end to end.

**L. The Gemini concierge (fallback brain)** — anything typed that the keyword handlers can't read goes to Gemini WITH the full case picture. A doctor's garbled date ("3 hafte baad", "after diwali") comes back as a one-tap ✅ confirmation — never applied silently. A patient's factual question ("what time is the nurse coming?", "kitna bill hai?") gets an instant answer built ONLY from case facts, in the language they wrote in — and the team is told about every exchange the model touches. Emergency phrases (dard, bleeding, saans, 108…) trigger an immediate 🚨 team + POC alert and a call-108 reply, even if the model is down. Everything else gets a warm "passed to the care team" ack. Toggle + model + per-phone daily budget: Settings → llm.
