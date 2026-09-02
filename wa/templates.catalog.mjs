// Carcinome Home Care — WhatsApp template catalog (en + hi, all UTILITY).
// Source of truth for wa/ assets. Consumed by scripts/bootstrap_wa.mjs.
//
// Conventions (see docs/CONTRACTS.md):
// - Every entry is a FULL Meta Graph payload: { name, language, category, components }.
// - Extra keys prefixed with `_` are catalog metadata (stripped by bootstrap before POST):
//     _params : documented body-parameter order (what {{1}}..{{n}} mean at send time)
//     _flow   : flow name whose live id is substituted into FLOW buttons ('{{FLOW_ID}}')
// - '{{HEADER_HANDLE}}' in DOCUMENT headers is replaced by bootstrap with a real
//   resumable-upload media handle (Meta requires a sample document at submission).
// - Quick-reply button PAYLOADS are runtime-only (`<action>:<case_uuid>`); templates
//   declare button text only.
// - Copy rules: transactional utility tone anchored to "your registered request/session",
//   no marketing language, no emojis, body <= 550 chars, button labels <= 20 chars,
//   variables strictly sequential in order of appearance (both languages).

const DASHBOARD_CASE_URL = 'https://ubhayaab.github.io/JCF/carcinome_wpp/#cases/{{1}}';

function body(text, examples) {
  return { type: 'BODY', text, example: { body_text: [examples] } };
}
function docHeader() {
  return { type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['{{HEADER_HANDLE}}'] } };
}
function quickReplies(...texts) {
  return { type: 'BUTTONS', buttons: texts.map((t) => ({ type: 'QUICK_REPLY', text: t })) };
}
function flowButton(text, navigateScreen) {
  return {
    type: 'BUTTONS',
    buttons: [{ type: 'FLOW', text, flow_id: '{{FLOW_ID}}', flow_action: 'navigate', navigate_screen: navigateScreen }],
  };
}
function urlButton(text, url, exampleUrl) {
  return { type: 'BUTTONS', buttons: [{ type: 'URL', text, url, example: [exampleUrl] }] };
}

export const TEMPLATES = [
  // ── 1. patient_registered (patient_name, case_code, scheduled_at) ────────────
  {
    name: 'patient_registered', language: 'en', category: 'UTILITY',
    _params: ['patient_name', 'case_code', 'scheduled_at'],
    components: [
      body(
        'Hello {{1}}, your home-care request ({{2}}) is registered with Carcinome Home Care for {{3}}. Our team is identifying the most suitable oncology nurse for your session and will confirm within 6-12 hours. You can reply to this message anytime with questions about your registered request.',
        ['Meera Sharma', 'CASE-2026-0012', 'Sat 18 Jul, 10:00 AM'],
      ),
    ],
  },
  {
    name: 'patient_registered', language: 'hi', category: 'UTILITY',
    _params: ['patient_name', 'case_code', 'scheduled_at'],
    components: [
      body(
        'नमस्ते {{1}}, आपका होम-केयर अनुरोध ({{2}}) कार्सिनोम होम केयर में {{3}} के लिए पंजीकृत हो गया है। हमारी टीम आपके सेशन के लिए सबसे उपयुक्त ऑन्कोलॉजी नर्स चुन रही है और 6-12 घंटे में पुष्टि करेगी। अपने पंजीकृत अनुरोध से जुड़े किसी भी प्रश्न के लिए आप यहां कभी भी उत्तर भेज सकते हैं।',
        ['मीरा शर्मा', 'CASE-2026-0012', 'शनिवार 18 जुलाई, सुबह 10:00'],
      ),
    ],
  },

  // ── 2. doctor_referral_ack (doctor_name, patient_name, case_code, scheduled_at) ──
  {
    name: 'doctor_referral_ack', language: 'en', category: 'UTILITY',
    _params: ['doctor_name', 'patient_name', 'case_code', 'scheduled_at'],
    components: [
      body(
        'Dear Dr. {{1}}, your referral for patient {{2}} is registered with Carcinome Home Care as case {{3}}. The home-care session is scheduled for {{4}}. We will send you nurse assignment and clinical updates for this registered case on this number.',
        ['Anil Mehta', 'Meera Sharma', 'CASE-2026-0012', 'Sat 18 Jul, 10:00 AM'],
      ),
    ],
  },
  {
    name: 'doctor_referral_ack', language: 'hi', category: 'UTILITY',
    _params: ['doctor_name', 'patient_name', 'case_code', 'scheduled_at'],
    components: [
      body(
        'आदरणीय डॉ. {{1}}, रोगी {{2}} के लिए आपका रेफ़रल कार्सिनोम होम केयर में केस {{3}} के रूप में पंजीकृत हो गया है। होम-केयर सेशन {{4}} के लिए निर्धारित है। इस पंजीकृत केस के नर्स असाइनमेंट और चिकित्सा अपडेट आपको इसी नंबर पर भेजे जाएंगे।',
        ['अनिल मेहता', 'मीरा शर्मा', 'CASE-2026-0012', 'शनिवार 18 जुलाई, सुबह 10:00'],
      ),
    ],
  },

  // ── 3. nurse_case_offer (area, care_type, line_type, case_code, scheduled_at) + Accept/Decline ──
  {
    name: 'nurse_case_offer', language: 'en', category: 'UTILITY',
    _params: ['area', 'care_type', 'line_type', 'case_code', 'scheduled_at'],
    components: [
      body(
        'As per your registered nurse profile with Carcinome Home Care, a matching case request awaits your response: area {{1}}, {{2}}, line: {{3}}, {{4}}, scheduled {{5}}. Please respond below.',
        ['Andheri West, Mumbai', 'chemo infusion', 'PICC', 'CASE-2026-0012', 'Sat 18 Jul, 10:00 AM'],
      ),
      quickReplies('Accept', 'Decline'),
    ],
  },
  {
    name: 'nurse_case_offer', language: 'hi', category: 'UTILITY',
    _params: ['area', 'care_type', 'line_type', 'case_code', 'scheduled_at'],
    components: [
      body(
        'कार्सिनोम होम केयर में आपके पंजीकृत नर्स प्रोफ़ाइल के अनुसार एक उपयुक्त केस अनुरोध आपके उत्तर की प्रतीक्षा में है: क्षेत्र {{1}}, {{2}}, लाइन: {{3}}, {{4}}, समय {{5}}। क्या आप यह केस लेने के लिए उपलब्ध हैं? कृपया नीचे उत्तर दें।',
        ['अंधेरी वेस्ट, मुंबई', 'कीमो इन्फ्यूज़न', 'PICC', 'CASE-2026-0012', 'शनिवार 18 जुलाई, सुबह 10:00'],
      ),
      quickReplies('स्वीकार करें', 'अस्वीकार'),
    ],
  },

  // ── 4. offer_closed (case_code) ───────────────────────────────────────────────
  {
    name: 'offer_closed', language: 'en', category: 'UTILITY',
    _params: ['case_code'],
    components: [
      body(
        'Case {{1}}, which was offered to you, has been assigned to another nurse. No action is needed. Thank you for responding.',
        ['CASE-2026-0012'],
      ),
    ],
  },
  {
    name: 'offer_closed', language: 'hi', category: 'UTILITY',
    _params: ['case_code'],
    components: [
      body(
        'आपको भेजा गया केस {{1}} किसी अन्य नर्स को सौंपा जा चुका है। अब किसी कार्रवाई की आवश्यकता नहीं है। उत्तर देने के लिए धन्यवाद।',
        ['CASE-2026-0012'],
      ),
    ],
  },

  // ── 5. nurse_assigned_nurse (patient_name, address, scheduled_at, care_type, line_type) ──
  {
    name: 'nurse_assigned_nurse', language: 'en', category: 'UTILITY',
    _params: ['patient_name', 'address', 'scheduled_at', 'care_type', 'line_type'],
    components: [
      body(
        'You are confirmed for a registered Carcinome home-care session. Patient: {{1}}. Address: {{2}}. Scheduled: {{3}}. Care: {{4}}, line {{5}}. On arrival, collect the arrival code from the patient\'s family and reply with it here. Reply here for any coordination on this case.',
        ['Meera Sharma', '12 Rose Villa, Andheri West, Mumbai 400058', 'Sat 18 Jul, 10:00 AM', 'chemo infusion', 'PICC'],
      ),
    ],
  },
  {
    name: 'nurse_assigned_nurse', language: 'hi', category: 'UTILITY',
    _params: ['patient_name', 'address', 'scheduled_at', 'care_type', 'line_type'],
    components: [
      body(
        'पंजीकृत कार्सिनोम होम-केयर सेशन के लिए आपकी पुष्टि हो गई है। रोगी: {{1}}। पता: {{2}}। समय: {{3}}। देखभाल: {{4}}, लाइन {{5}}। पहुंचने पर रोगी के परिवार से आगमन कोड लेकर यहां भेजें। इस केस से जुड़े किसी भी समन्वय के लिए यहां उत्तर दें।',
        ['मीरा शर्मा', '12 रोज़ विला, अंधेरी वेस्ट, मुंबई 400058', 'शनिवार 18 जुलाई, सुबह 10:00', 'कीमो इन्फ्यूज़न', 'PICC'],
      ),
    ],
  },

  // ── 6. nurse_assigned_patient (nurse_name, scheduled_at) ─────────────────────
  {
    name: 'nurse_assigned_patient', language: 'en', category: 'UTILITY',
    _params: ['nurse_name', 'scheduled_at'],
    components: [
      body(
        'Update on your registered home-care request: nurse {{1}} is confirmed for your session on {{2}}. The nurse will carry identification. You will receive an arrival confirmation number before the visit - share it with the nurse in person when they arrive. Reply here anytime with questions.',
        ['Anita Verma', 'Sat 18 Jul, 10:00 AM'],
      ),
    ],
  },
  {
    name: 'nurse_assigned_patient', language: 'hi', category: 'UTILITY',
    _params: ['nurse_name', 'scheduled_at'],
    components: [
      body(
        'आपके पंजीकृत होम-केयर अनुरोध पर अपडेट: आपके {{2}} के सेशन के लिए नर्स {{1}} की पुष्टि हो गई है। नर्स के पास पहचान-पत्र होगा। विज़िट से पहले आपको एक आगमन पुष्टि नंबर मिलेगा - नर्स के पहुंचने पर वह नंबर उन्हें आमने-सामने बताएं। किसी भी प्रश्न के लिए यहां उत्तर दें।',
        ['अनीता वर्मा', 'शनिवार 18 जुलाई, सुबह 10:00'],
      ),
    ],
  },

  // ── 7. nurse_assigned_doctor (patient_name, case_code, nurse_name, scheduled_at) ──
  {
    name: 'nurse_assigned_doctor', language: 'en', category: 'UTILITY',
    _params: ['patient_name', 'case_code', 'nurse_name', 'scheduled_at'],
    components: [
      body(
        'Update on your referred patient {{1}} (case {{2}}): nurse {{3}} is confirmed for the home-care session on {{4}}. You will receive the discharge summary after the session. Reply JOIN to receive all messages for this registered case, or reply here to send a note to the care team.',
        ['Meera Sharma', 'CASE-2026-0012', 'Anita Verma', 'Sat 18 Jul, 10:00 AM'],
      ),
    ],
  },
  {
    name: 'nurse_assigned_doctor', language: 'hi', category: 'UTILITY',
    _params: ['patient_name', 'case_code', 'nurse_name', 'scheduled_at'],
    components: [
      body(
        'आपके रेफ़र किए गए रोगी {{1}} (केस {{2}}) पर अपडेट: {{4}} के होम-केयर सेशन के लिए नर्स {{3}} की पुष्टि हो गई है। सेशन के बाद आपको डिस्चार्ज सारांश भेजा जाएगा। इस पंजीकृत केस के सभी संदेश पाने के लिए JOIN लिखें, या केयर टीम को संदेश भेजने के लिए यहां उत्तर दें।',
        ['मीरा शर्मा', 'CASE-2026-0012', 'अनीता वर्मा', 'शनिवार 18 जुलाई, सुबह 10:00'],
      ),
    ],
  },

  // ── 8. supplier_equipment_prep (patient_name, address, requirements, needed_by, nurse_name) ──
  {
    name: 'supplier_equipment_prep', language: 'en', category: 'UTILITY',
    _params: ['patient_name', 'address', 'requirements', 'needed_by', 'nurse_name'],
    components: [
      body(
        'Equipment request for a registered Carcinome home-care session. Patient: {{1}}. Delivery address: {{2}}. Requirements: {{3}}. Needed by: {{4}}. Nurse: {{5}}. Reply here to confirm availability or to flag any issue with this request.',
        ['Meera Sharma', '12 Rose Villa, Andheri West, Mumbai 400058', 'Infusion pump, IV set, saline 500ml', 'Sat 18 Jul, 9:00 AM', 'Anita Verma'],
      ),
    ],
  },
  {
    name: 'supplier_equipment_prep', language: 'hi', category: 'UTILITY',
    _params: ['patient_name', 'address', 'requirements', 'needed_by', 'nurse_name'],
    components: [
      body(
        'पंजीकृत कार्सिनोम होम-केयर सेशन के लिए उपकरण अनुरोध। रोगी: {{1}}। डिलीवरी पता: {{2}}। आवश्यक सामग्री: {{3}}। कब तक चाहिए: {{4}}। नर्स: {{5}}। उपलब्धता की पुष्टि या किसी समस्या की सूचना के लिए यहां उत्तर दें।',
        ['मीरा शर्मा', '12 रोज़ विला, अंधेरी वेस्ट, मुंबई 400058', 'इन्फ्यूज़न पंप, IV सेट, सलाइन 500ml', 'शनिवार 18 जुलाई, सुबह 9:00', 'अनीता वर्मा'],
      ),
    ],
  },

  // ── 9. session_otp (code, nurse_name) ────────────────────────────────────────
  {
    name: 'session_otp', language: 'en', category: 'UTILITY',
    _params: ['code', 'nurse_name'],
    components: [
      body(
        'For your registered home-care session, the nurse arrival confirmation number is {{1}}. Please share it with nurse {{2}} in person when they arrive at your address.',
        ['482913', 'Anita Verma'],
      ),
    ],
  },
  {
    name: 'session_otp', language: 'hi', category: 'UTILITY',
    _params: ['code', 'nurse_name'],
    components: [
      body(
        'आपके पंजीकृत होम-केयर सेशन के लिए नर्स आगमन पुष्टि नंबर {{1}} है। कृपया नर्स {{2}} के आपके पते पर पहुंचने पर यह नंबर उन्हें आमने-सामने दें।',
        ['482913', 'अनीता वर्मा'],
      ),
    ],
  },

  // ── 10. otp_nurse_prompt (patient_name) ──────────────────────────────────────
  {
    name: 'otp_nurse_prompt', language: 'en', category: 'UTILITY',
    _params: ['patient_name'],
    components: [
      body(
        'You are due to arrive for your registered home-care session with patient {{1}}. On reaching the address, ask the family for the arrival code and reply here with the 6-digit code to confirm your arrival.',
        ['Meera Sharma'],
      ),
    ],
  },
  {
    name: 'otp_nurse_prompt', language: 'hi', category: 'UTILITY',
    _params: ['patient_name'],
    components: [
      body(
        'रोगी {{1}} के साथ आपके पंजीकृत होम-केयर सेशन का समय हो गया है। पते पर पहुंचकर परिवार से आगमन कोड पूछें और अपनी उपस्थिति की पुष्टि के लिए 6 अंकों का कोड यहां भेजें।',
        ['मीरा शर्मा'],
      ),
    ],
  },

  // ── 11. consent_flow_invite (patient_name, case_code) + FLOW button ──────────
  {
    name: 'consent_flow_invite', language: 'en', category: 'UTILITY',
    _params: ['patient_name', 'case_code'],
    _flow: 'consent_v1',
    components: [
      body(
        'Hello {{1}}, before your registered home-care session (case {{2}}) can begin, we need your signed consent. Please open the consent form below, review the procedure details and submit it. Reply here if you need help completing the form.',
        ['Meera Sharma', 'CASE-2026-0012'],
      ),
      flowButton('Open consent form', 'INFO'),
    ],
  },
  {
    name: 'consent_flow_invite', language: 'hi', category: 'UTILITY',
    _params: ['patient_name', 'case_code'],
    _flow: 'consent_v1',
    components: [
      body(
        'नमस्ते {{1}}, आपके पंजीकृत होम-केयर सेशन (केस {{2}}) से पहले हमें आपकी हस्ताक्षरित सहमति चाहिए। कृपया नीचे दिया गया सहमति फ़ॉर्म खोलें, प्रक्रिया की जानकारी पढ़ें और जमा करें। फ़ॉर्म भरने में सहायता चाहिए तो यहां उत्तर दें।',
        ['मीरा शर्मा', 'CASE-2026-0012'],
      ),
      flowButton('सहमति फ़ॉर्म खोलें', 'INFO'),
    ],
  },

  // ── 12. care_update (sender_label, snippet) — relay window fallback ──────────
  {
    name: 'care_update', language: 'en', category: 'UTILITY',
    _params: ['sender_label', 'snippet'],
    components: [
      body(
        'Update on your registered Carcinome home-care case - {{1}}: {{2}}. Reply here to respond to the care team.',
        ['Nurse Anita', 'I have started the infusion, the patient is comfortable'],
      ),
    ],
  },
  {
    name: 'care_update', language: 'hi', category: 'UTILITY',
    _params: ['sender_label', 'snippet'],
    components: [
      body(
        'आपके पंजीकृत कार्सिनोम होम-केयर केस पर अपडेट - {{1}}: {{2}}। केयर टीम को उत्तर देने के लिए यहां संदेश भेजें।',
        ['नर्स अनीता', 'इन्फ्यूज़न शुरू हो गया है, रोगी की स्थिति ठीक है'],
      ),
    ],
  },

  // ── 13. infusion_reminder_patient (scheduled_at, nurse_name) ─────────────────
  {
    name: 'infusion_reminder_patient', language: 'en', category: 'UTILITY',
    _params: ['scheduled_at', 'nurse_name'],
    components: [
      body(
        'Reminder for your registered home-care session on {{1}}: nurse {{2}} will visit you at your address. Please keep your prescription and medicines ready. You will receive an arrival code shortly before the visit. Reply here to reschedule or ask a question.',
        ['Sat 18 Jul, 10:00 AM', 'Anita Verma'],
      ),
    ],
  },
  {
    name: 'infusion_reminder_patient', language: 'hi', category: 'UTILITY',
    _params: ['scheduled_at', 'nurse_name'],
    components: [
      body(
        'आपके {{1}} के पंजीकृत होम-केयर सेशन की याद: आपके पते पर नर्स {{2}} की विज़िट होगी। कृपया प्रिस्क्रिप्शन और दवाइयां तैयार रखें। विज़िट से कुछ समय पहले आपको आगमन कोड मिलेगा। समय बदलने या किसी प्रश्न के लिए यहां उत्तर दें।',
        ['शनिवार 18 जुलाई, सुबह 10:00', 'अनीता वर्मा'],
      ),
    ],
  },

  // ── 14. infusion_reminder_nurse (patient_name, scheduled_at, address) ────────
  {
    name: 'infusion_reminder_nurse', language: 'en', category: 'UTILITY',
    _params: ['patient_name', 'scheduled_at', 'address'],
    components: [
      body(
        'Reminder for your confirmed Carcinome home-care session: patient {{1}}, scheduled {{2}}, address {{3}}. On arrival, collect the arrival code from the family and reply with it here. Reply here if you expect any delay.',
        ['Meera Sharma', 'Sat 18 Jul, 10:00 AM', '12 Rose Villa, Andheri West, Mumbai 400058'],
      ),
    ],
  },
  {
    name: 'infusion_reminder_nurse', language: 'hi', category: 'UTILITY',
    _params: ['patient_name', 'scheduled_at', 'address'],
    components: [
      body(
        'आपके निर्धारित कार्सिनोम होम-केयर सेशन की याद: रोगी {{1}}, समय {{2}}, पता {{3}}। पहुंचने पर परिवार से आगमन कोड लेकर यहां भेजें। देरी की संभावना हो तो यहां सूचित करें।',
        ['मीरा शर्मा', 'शनिवार 18 जुलाई, सुबह 10:00', '12 रोज़ विला, अंधेरी वेस्ट, मुंबई 400058'],
      ),
    ],
  },

  // ── 15. invoice_delivery (invoice_no, case_code, amount_inr) + DOC header + Pay now ──
  {
    name: 'invoice_delivery', language: 'en', category: 'UTILITY',
    _params: ['invoice_no', 'case_code', 'amount_inr'],
    components: [
      docHeader(),
      body(
        'Invoice {{1}} for your completed registered home-care session (case {{2}}) is attached. Amount due: INR {{3}}. Tap Pay now to pay by UPI, or reply here after paying so our team can confirm your payment.',
        ['INV-2026-0007', 'CASE-2026-0012', '4,500'],
      ),
      quickReplies('Pay now'),
    ],
  },
  {
    name: 'invoice_delivery', language: 'hi', category: 'UTILITY',
    _params: ['invoice_no', 'case_code', 'amount_inr'],
    components: [
      docHeader(),
      body(
        'इनवॉइस {{1}} आपके पूर्ण हो चुके पंजीकृत होम-केयर सेशन (केस {{2}}) के लिए संलग्न है। देय राशि: INR {{3}}। UPI से भुगतान के लिए अभी भुगतान करें दबाएं, या भुगतान के बाद यहां उत्तर दें ताकि हमारी टीम पुष्टि कर सके।',
        ['INV-2026-0007', 'CASE-2026-0012', '4,500'],
      ),
      quickReplies('अभी भुगतान करें'),
    ],
  },

  // ── 16. discharge_summary_patient (patient_name, case_code) + DOC header ─────
  {
    name: 'discharge_summary_patient', language: 'en', category: 'UTILITY',
    _params: ['patient_name', 'case_code'],
    components: [
      docHeader(),
      body(
        'Hello {{1}}, the discharge summary for your completed registered home-care session (case {{2}}) is attached. Please keep it in your medical records and share it with your treating doctor at your next visit. Reply here for any questions.',
        ['Meera Sharma', 'CASE-2026-0012'],
      ),
    ],
  },
  {
    name: 'discharge_summary_patient', language: 'hi', category: 'UTILITY',
    _params: ['patient_name', 'case_code'],
    components: [
      docHeader(),
      body(
        'नमस्ते {{1}}, आपके पूर्ण हो चुके पंजीकृत होम-केयर सेशन (केस {{2}}) का डिस्चार्ज सारांश संलग्न है। कृपया इसे अपने मेडिकल रिकॉर्ड में रखें और अगली विज़िट पर अपने डॉक्टर को दिखाएं। किसी भी प्रश्न के लिए यहां उत्तर दें।',
        ['मीरा शर्मा', 'CASE-2026-0012'],
      ),
    ],
  },

  // ── 17. discharge_summary_doctor (doctor_name, patient_name, case_code) + DOC header ──
  {
    name: 'discharge_summary_doctor', language: 'en', category: 'UTILITY',
    _params: ['doctor_name', 'patient_name', 'case_code'],
    components: [
      docHeader(),
      body(
        'Dear Dr. {{1}}, the discharge summary for your referred patient {{2}} (case {{3}}) is attached. The registered home-care session is complete. Reply here to send any instructions to the care team.',
        ['Anil Mehta', 'Meera Sharma', 'CASE-2026-0012'],
      ),
    ],
  },
  {
    name: 'discharge_summary_doctor', language: 'hi', category: 'UTILITY',
    _params: ['doctor_name', 'patient_name', 'case_code'],
    components: [
      docHeader(),
      body(
        'आदरणीय डॉ. {{1}}, आपके रेफ़र किए गए रोगी {{2}} (केस {{3}}) का डिस्चार्ज सारांश संलग्न है। पंजीकृत होम-केयर सेशन पूर्ण हो गया है। केयर टीम को कोई निर्देश भेजने के लिए यहां उत्तर दें।',
        ['अनिल मेहता', 'मीरा शर्मा', 'CASE-2026-0012'],
      ),
    ],
  },

  // ── 18. feedback_invite (patient_name) + FLOW button ─────────────────────────
  {
    name: 'feedback_invite', language: 'en', category: 'UTILITY',
    _params: ['patient_name'],
    _flow: 'feedback_v1',
    components: [
      body(
        'Hello {{1}}, your registered home-care session is now complete. Please fill the short service-report form below about this session.',
        ['Meera Sharma'],
      ),
      flowButton('Share feedback', 'FEEDBACK'),
    ],
  },
  {
    name: 'feedback_invite', language: 'hi', category: 'UTILITY',
    _params: ['patient_name'],
    _flow: 'feedback_v1',
    components: [
      body(
        'नमस्ते {{1}}, आपका पंजीकृत होम-केयर सेशन पूर्ण हो गया है। कृपया इसी सेशन से जुड़ा नीचे दिया गया संक्षिप्त सेवा-रिपोर्ट फ़ॉर्म भरें।',
        ['मीरा शर्मा'],
      ),
      flowButton('प्रतिक्रिया दें', 'FEEDBACK'),
    ],
  },

  // ── 19. payment_received (amount_inr, invoice_no) ────────────────────────────
  {
    name: 'payment_received', language: 'en', category: 'UTILITY',
    _params: ['amount_inr', 'invoice_no'],
    components: [
      body(
        'We have received your payment of INR {{1}} against invoice {{2}} for your registered home-care session. Thank you. No further amount is due for this session. Reply here for any questions.',
        ['4,500', 'INV-2026-0007'],
      ),
    ],
  },
  {
    name: 'payment_received', language: 'hi', category: 'UTILITY',
    _params: ['amount_inr', 'invoice_no'],
    components: [
      body(
        'आपके पंजीकृत होम-केयर सेशन के लिए INR {{1}} का भुगतान इनवॉइस {{2}} पर प्राप्त हो गया है। धन्यवाद। इस सेशन के लिए अब कोई राशि देय नहीं है। किसी भी प्रश्न के लिए यहां उत्तर दें।',
        ['4,500', 'INV-2026-0007'],
      ),
    ],
  },

  // ── 20. sla_nudge_supervisor (case_code, hours_pending, area) + URL button ───
  // URL button param at send time = case UUID (dashboard route #cases/{id}).
  {
    name: 'sla_nudge_supervisor', language: 'en', category: 'UTILITY',
    _params: ['case_code', 'hours_pending', 'area'],
    components: [
      body(
        'Action needed on registered case {{1}}: no nurse has accepted the case request for {{2}} hours (area: {{3}}). Please open the case to assign a nurse manually or widen the offer pool.',
        ['CASE-2026-0012', '6', 'Andheri West, Mumbai'],
      ),
      urlButton('Open case', DASHBOARD_CASE_URL,
        'https://ubhayaab.github.io/JCF/carcinome_wpp/#cases/6f0e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b'),
    ],
  },
  {
    name: 'sla_nudge_supervisor', language: 'hi', category: 'UTILITY',
    _params: ['case_code', 'hours_pending', 'area'],
    components: [
      body(
        'पंजीकृत केस {{1}} पर कार्रवाई आवश्यक: {{2}} घंटे से किसी नर्स ने केस अनुरोध स्वीकार नहीं किया है (क्षेत्र: {{3}})। कृपया केस खोलकर मैन्युअल रूप से नर्स नियुक्त करें या ऑफ़र सूची बढ़ाएं।',
        ['CASE-2026-0012', '6', 'अंधेरी वेस्ट, मुंबई'],
      ),
      urlButton('केस खोलें', DASHBOARD_CASE_URL,
        'https://ubhayaab.github.io/JCF/carcinome_wpp/#cases/6f0e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b'),
    ],
  },

  // ── _v2 resubmissions ─────────────────────────────────────────────────────
  // The v1 versions were REJECTED (INCORRECT_CATEGORY): every one of them
  // mentioned the "arrival code / confirmation number", which Meta's
  // classifier reads as an AUTHENTICATION template (custom bodies forbidden
  // there → hard reject). v2 = identical intent, ALL code language removed.
  // The arrival number itself now travels via the generic `care_update`
  // carrier at OTP-issue time (see _shared/otp.ts sendOtpMessages).
  // wa.ts sendTemplate resolves `name` → `name_v2` automatically.
  {
    name: 'nurse_assigned_nurse_v2',
    language: 'en',
    category: 'UTILITY',
    _params: ['patient_name', 'address', 'scheduled_at', 'care_type', 'line_type'],
    components: [
      {
        type: 'BODY',
        text: 'You are confirmed for a registered Carcinome home-care session. Patient: {{1}}. Address: {{2}}. Scheduled: {{3}}. Care: {{4}}, line {{5}}. Check-in instructions will follow in this chat before the visit. Reply here for any coordination on this case.',
        example: { body_text: [[ 'Meera Sharma', '12 Rose Villa, Andheri West, Mumbai 400058', 'Sat 18 Jul, 10:00 AM', 'chemo infusion', 'PICC' ]] },
      },
    ],
  },
  {
    name: 'nurse_assigned_nurse_v2',
    language: 'hi',
    category: 'UTILITY',
    _params: ['patient_name', 'address', 'scheduled_at', 'care_type', 'line_type'],
    components: [
      {
        type: 'BODY',
        text: 'पंजीकृत कार्सिनोम होम-केयर सेशन के लिए आपकी पुष्टि हो गई है। रोगी: {{1}}। पता: {{2}}। समय: {{3}}। देखभाल: {{4}}, लाइन {{5}}। विज़िट से पहले चेक-इन की जानकारी इसी चैट में भेजी जाएगी। इस केस से जुड़े किसी भी समन्वय के लिए यहां उत्तर दें।',
        example: { body_text: [[ 'मीरा शर्मा', '12 रोज़ विला, अंधेरी वेस्ट, मुंबई 400058', 'शनिवार 18 जुलाई, सुबह 10:00', 'कीमो इन्फ्यूज़न', 'PICC' ]] },
      },
    ],
  },
  {
    name: 'nurse_assigned_patient_v2',
    language: 'en',
    category: 'UTILITY',
    _params: ['nurse_name', 'scheduled_at'],
    components: [
      {
        type: 'BODY',
        text: 'Update on your registered home-care request: nurse {{1}} is confirmed for your session on {{2}}. The nurse will carry identification. Further visit instructions will arrive in this chat before the session. Reply here anytime with questions.',
        example: { body_text: [[ 'Anita Verma', 'Sat 18 Jul, 10:00 AM' ]] },
      },
    ],
  },
  {
    name: 'nurse_assigned_patient_v2',
    language: 'hi',
    category: 'UTILITY',
    _params: ['nurse_name', 'scheduled_at'],
    components: [
      {
        type: 'BODY',
        text: 'आपके पंजीकृत होम-केयर अनुरोध पर अपडेट: आपके {{2}} के सेशन के लिए नर्स {{1}} की पुष्टि हो गई है। नर्स के पास पहचान-पत्र होगा। सेशन से पहले विज़िट की आगे की जानकारी इसी चैट में भेजी जाएगी। किसी भी प्रश्न के लिए यहां उत्तर दें।',
        example: { body_text: [[ 'अनीता वर्मा', 'शनिवार 18 जुलाई, सुबह 10:00' ]] },
      },
    ],
  },
  {
    name: 'infusion_reminder_patient_v2',
    language: 'en',
    category: 'UTILITY',
    _params: ['scheduled_at', 'nurse_name'],
    components: [
      {
        type: 'BODY',
        text: 'Schedule update for your registered home-care session on {{1}}: nurse {{2}} will visit you at your address. Please keep your prescription and medicines ready. Reply here to reschedule or ask a question.',
        example: { body_text: [[ 'Sat 18 Jul, 10:00 AM', 'Anita Verma' ]] },
      },
    ],
  },
  {
    name: 'infusion_reminder_patient_v2',
    language: 'hi',
    category: 'UTILITY',
    _params: ['scheduled_at', 'nurse_name'],
    components: [
      {
        type: 'BODY',
        text: 'आपके {{1}} के पंजीकृत होम-केयर सेशन का शेड्यूल अपडेट: आपके पते पर नर्स {{2}} की विज़िट होगी। कृपया प्रिस्क्रिप्शन और दवाइयां तैयार रखें। समय बदलने या किसी प्रश्न के लिए यहां उत्तर दें।',
        example: { body_text: [[ 'शनिवार 18 जुलाई, सुबह 10:00', 'अनीता वर्मा' ]] },
      },
    ],
  },
  {
    name: 'infusion_reminder_nurse_v2',
    language: 'en',
    category: 'UTILITY',
    _params: ['patient_name', 'scheduled_at', 'address'],
    components: [
      {
        type: 'BODY',
        text: 'Schedule update for your confirmed Carcinome home-care session: patient {{1}}, scheduled {{2}}, address {{3}}. Check-in instructions will follow in this chat. Reply here if you expect any delay.',
        example: { body_text: [[ 'Meera Sharma', 'Sat 18 Jul, 10:00 AM', '12 Rose Villa, Andheri West, Mumbai 400058' ]] },
      },
    ],
  },
  {
    name: 'infusion_reminder_nurse_v2',
    language: 'hi',
    category: 'UTILITY',
    _params: ['patient_name', 'scheduled_at', 'address'],
    components: [
      {
        type: 'BODY',
        text: 'आपके निर्धारित कार्सिनोम होम-केयर सेशन का शेड्यूल अपडेट: रोगी {{1}}, समय {{2}}, पता {{3}}। चेक-इन की जानकारी इसी चैट में भेजी जाएगी। देरी की संभावना हो तो यहां सूचित करें।',
        example: { body_text: [[ 'मीरा शर्मा', 'शनिवार 18 जुलाई, सुबह 10:00', '12 रोज़ विला, अंधेरी वेस्ट, मुंबई 400058' ]] },
      },
    ],
  },
];

export default TEMPLATES;
