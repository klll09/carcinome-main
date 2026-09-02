# Rehearsal choreography (design pass output, 2026-07-16)

> Source material for the published runbook. NOTE THE DELTAS at the bottom — two gaps
> described below were FIXED after this was written.

## 1. Phone/role matrix

Collision rules (from code): `case_participants` unique on (case_id, phone); registration
inserts patient → doctor → ops_phones → supervisor_phones → suppliers with ignoreDuplicates
(first role wins); `assign_nurse` UPSERTS (overwrites the phone's role to nurse/full);
decliner nurses never become participants; team alerts read settings (always arrive
regardless of participant collisions); the supplier nurse-name re-ping requires the supplier
to OWN its participant row; keep any doubled phone at one language_pref.

### 6+ phones (ideal)
P1 Patient (never double) · P2 Nurse-1 assigned · P3 Nurse-2 decline→accept→loses ·
P4 Doctor (single-role, for the milestones→JOIN demo) · P5 Supplier (single-role → re-ping
guaranteed) · P6 Supervisor+Ops (keep silent → every team alert arrives as care_update
template; a 7th phone can split supervisor from ops).

### 5 phones (recommended minimum)
P1 Patient · P2 Nurse-1 · P3 Doctor · P4 **Nurse-2 + Supplier (SAFE double — decliner never
becomes participant)** · P5 Supervisor+Ops. Suggested: 7338120082 → P5, 7007334125 → P3.

### 4 phones
P1 Patient · P2 Nurse-1 + Supervisor/Ops (ops participant row overwritten at assignment —
expected; settings-driven alerts still arrive; quirk: P2 sees the ACCEPTED alert about
itself) · P3 Doctor · P4 Nurse-2 + Supplier.

### Never
Patient + anything · Doctor + supplier (re-ping dies AND relay to that phone stops) ·
Nurse-1 + supplier (assignment overwrite kills re-ping) · Supervisor + patient/doctor.

## 2. Case parameters
Schedule TODAY now+3–4h IST (otp cron only fires inside T-60min → manual button can't be
raced; T+30min overdue alert can't fire mid-show). Price override ₹1. Warm every actor
phone the day before (each sends one message to the number → windows open → everything
deliverable even if a template is missing).

## 3. Act-by-act (abridged — expected arrivals per step)

ACT 1 — Register (dashboard): P1 patient_registered · P3 doctor_referral_ack · supplier
supplier_equipment_prep (nurse = "to be assigned") · both nurses nurse_case_offer
[Accept][Decline] (locality only — verify no full address) · team NOTHING (correct).
Dashboard: status Offering; participants patient/doctor(milestones)/ops/supervisor/supplier.
DB: events registered + offers_sent; case_offers with sent_wamid.

ACT 2 — Offers: nurse-2 Decline → "Noted — thank you". P2 Accept → "response #1" + team
alert (care_update carrier since team silent). Nurse-2 Accept after decline → "#2" + team
alert. Dashboard: ranked list #1 green.

ACT 3 — Assign #1: P2 nurse_assigned_nurse_v2 (FULL address; v2 = no code language) ·
P1 nurse_assigned_patient_v2 · P3 nurse_assigned_doctor ("Reply JOIN…") · nurse-2
offer_closed · supplier re-ping with real nurse name (the delta IS the demo) ·
P1 consent_flow_invite [Open consent form] (template — window closed). Bonus: nurse-2
stale Accept → polite "already been filled". DB: nurse_assigned, consent_sent.

ACT 4 — Consent: P1 opens form → screen INFO (bilingual bullets) → FORM (name, relation,
2 REQUIRED opt-ins — WhatsApp blocks submit until both ticked) → submit → P1 thank-you
(free text, window open) · team "📝 consent received (signed by …)". DB: consents.agreed
true; status consented.

ACT 5 — OTP (manual button; cron can't fire at 3-4h out): Issue arrival OTP →
P1 free text "arrival number is XXXXXX — give it to nurse in person" · P2 "ask for the
arrival number and send it here". P2 sends WRONG code → "Attempts left: 4". P2 sends right
code → P2 "✅ Arrival verified… [Mark care complete]" (persistent button) · P1 "arrival
verified at HH:MM" · team ✅ alert · P3 doctor milestone (milestones DO get explicit
milestone sends). Status in_care. Keep within otp_ttl_min (30m — */5 reaper).

ACT 6 — Relay: P1 text → P2 (free) + supplier/team (care_update) — DOCTOR SILENT (point at
his phone). P2 reply → fans likewise. Ops composer message → 🛟 to all full. P3 doctor
replies "JOIN — please share vitals" → flips to full + his text fans to everyone; next P1
message reaches P3 too. Optional: nurse photo w/ caption (open-window recipients get the
image; closed-window get "sent a file" care_update).

ACT 7 — Complete: P2 taps [Mark care complete] → completion flow (meds required, times,
complications radio, notes) → ANNOUNCE 30–90s docgen wait BEFORE submit → then:
P1 invoice_delivery + Invoice PDF + [Pay now] · P1 discharge_summary_patient + PDF ·
P3 discharge_summary_doctor + same PDF · P1 order_details "Review and Pay" card (+ I've-paid
button — see deltas) · P2 thank-you LAST (pipeline-ordered). Status awaiting_payment;
Documents card shows both PDFs via signed URLs.

ACT 8 — Payment: ⚠️ SAY OUT LOUD: Review-and-Pay opens a REAL UPI app at the configured
VPA — fix the VPA in pre-flight or testers back out without paying; with ₹1 + real VPA an
actual payment is a fine demo. P1 [Pay now] → fresh order_details (re-issue on demand;
Graph-failure fallback = plain UPI text). P1 taps I've-paid → thank-you + team "💰 verify
against bank"; dashboard shows amber claimed banner + needs-action tile. Mark paid
(verified) modal → P1 payment_received · P3 payment_received · team ✅. Status paid.
(mark_paid_verified works from status sent too — no claimed precondition.)

ACT 9 — Feedback + archive: [Send feedback form] button → P1 feedback_invite [Share
feedback] → form (overall/nurse 1–5, recommend, comments) → thank-you; rating ≤2 would fire
supervisor 🚨 (save for a re-run). Stars in dashboard. Archive case button → archived;
closing beat: P1 texts → polite once-per-24h auto-reply.

### Template scorecard
Act1: patient_registered, doctor_referral_ack, nurse_case_offer, supplier_equipment_prep ·
Act2/3: offer_closed, nurse_assigned_{nurse,patient}_v2, nurse_assigned_doctor, supplier
re-ping, consent_flow_invite · always: care_update · Act7/8: invoice_delivery,
discharge_summary_{patient,doctor}, payment_received · Act9: feedback_invite ·
Act II only: infusion_reminder_{patient,nurse}_v2, sla_nudge_supervisor.

## 4. Timing traps
Offers/assign/consent instant · SLA nudge: cron */15, offering >6h (mini-act: set
sla_offer_hours=0, throwaway case, ≤15min, reset) · OTP auto-issue: only [T-30m,T+60m] →
button instead · OTP expiry 30m TTL · overdue alert T+30m unverified · 24h reminders: only
via ACT II case (schedule tomorrow ~11:00 IST; assign+consent tonight; reminders land
[T-25h,T-23h]; auto-OTP T-60m; morning reminders 08:00 IST) · docgen 30–90s · feedback:
button (cron ≥2h + 11:00/17:00 IST only) · archive: button (cron = paid+7d).

## 5. Mini-acts
Wrong OTP (embedded) · Locked OTP on throwaway case (5 wrong → locked + team 🔒; 6th
6-digit text relays as chat; recover via Issue-OTP button) · STOP post-archive on
single-role P1 ONLY (flips opted_out on EVERY table matching the phone; Reactivate in
dashboard; on doubled phones reactivate both rows) · Doctor MUTE (discharge/payment
templates still arrive — unconditional) · Sandbox triage demo (auto vs text vs template
modes, live rail).

## 6. Pre-flight (founder, Settings, ~20 min)
1. Supervisor numbers set (else NO SLA/OTP-lock alerts) 2. Ops numbers set (else no
consent/arrival/payment alerts, no 🛟 participant) 3. REAL UPI VPA + business name
4. Pricing standard; use per-case ₹1 override 5. Automation: sla 6h, otp_ttl 30 (raise to
60 for slow acts), toggles ON 6. Integrator: flow_ids ×3 present; only unused v1s
non-APPROVED 7. **AUDIT: no real nurse is_eligible — offers fan to ALL eligible nurses on
the production number** (most important line) 8. Supplier active; doctor inline at
registration 9. All actors language_pref=en round 1; phones charged, notifications on.
Language: round 1 English; optional Hindi mini-round (patient → हिंदी toggle, fresh ₹1
case, compressed run).

## 7. Live risks
Template unavailable → registry refuses → silent unless window open (mitigate: warm phones,
pre-flight registry check) · docgen latency/failure → announce wait; Regenerate docs +
Resend invoice · order_details Graph-rejection → try one to a team phone the day before;
pay_show fallback exists · out-of-order replies mostly harmless (unscripted = relay demo) ·
cron interference neutralized by the 3-4h schedule · real payment risk → ₹1 + VPA warning ·
250/day cap irrelevant at this scale · double-admin sessions fine (Assign double-click
guarded).

## DELTAS — fixed after this design (runbook must reflect the FIXED behavior)
1. **GAP A CLOSED**: an "I've paid" interactive button (bilingual) is now sent right after
   EVERY order_details (completion pipeline, Pay-now re-issue, resend_invoice) and also
   after the pay_show plain-UPI fallback. Act 8 variant (b) is obsolete — the button always
   arrives as its own small message following the payment card.
2. **GAP B CLOSED**: JOIN / UNMUTE keywords now flip muted AND milestones participations to
   full with a bilingual confirmation ("Reply MUTE to pause again"); the MUTE confirmation
   copy now says "Reply JOIN at any time to resume case updates". Doctor rejoin after MUTE
   is self-serve. (Any other first inbound from a milestones doctor still auto-joins as
   before; JOIN now confirms explicitly instead of relaying the word into the thread.)
3. The pay_show fallback text no longer mentions 'reply "PAID"' (no such keyword; the
   button covers the claim path).
4. A **Send feedback form** button exists in the case detail billing panel
   (action send_feedback_invite; guards: status care_done/awaiting_payment/paid, no
   feedback row yet; logs feedback_invite_1 so the chaser cron never double-invites).
