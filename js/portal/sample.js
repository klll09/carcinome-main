// ============================================================
// Carcinome Home Care — sample accounts, entirely client-side
//
// WHY THIS IS LOCAL AND NOT A SERVER CALL:
// the whole point of a sample login is that you can open the three dashboards
// with NOTHING running — no Supabase, no edge function, no chat server, no
// WhatsApp. The first version routed it at the chat server, which meant a
// second process had to be up before you could click a door. That is a bad
// trade for a demo, so this module answers locally and the network is never
// touched.
//
// Only reachable when CONFIG.SAMPLE_LOGIN is true, and every session it mints
// is tagged `sample-*` so js/portal/api.js can tell demo traffic apart from a
// real one and serve it from here instead of the wire.
//
// The shapes below are the SAME shapes the portal edge function returns for
// nurse_home / patient_home / doctor_home. If you change one, change both, or
// the demo stops predicting what production does.
// ============================================================

const HOUR = 3600_000;
const at = (h) => new Date(Date.now() + h * HOUR).toISOString();

export const SAMPLE_PEOPLE = {
  patient: { id: 'sample-patient-1', full_name: 'Meera Sharma', language_pref: 'en' },
  nurse: { id: 'sample-nurse-1', full_name: 'Asha Verma', language_pref: 'en' },
  doctor: { id: 'sample-doctor-1', full_name: 'Dr. Arjun Mehta', language_pref: 'en' },
};

/** Token prefix that marks a session as demo-only. */
export const SAMPLE_PREFIX = 'sample-session-';

export function isSampleSession(session) {
  return typeof session?.token === 'string' && session.token.startsWith(SAMPLE_PREFIX);
}

/** Mint a local session. No network, no server, no expiry worth enforcing. */
export function makeSampleSession(role) {
  const person = SAMPLE_PEOPLE[role];
  if (!person) throw new Error('No sample account for that role.');
  return {
    token: `${SAMPLE_PREFIX}${role}`,
    expires_at: new Date(Date.now() + 24 * HOUR).toISOString(),
    profile: { role, id: person.id, full_name: person.full_name, language_pref: person.language_pref },
  };
}

// ─── Dashboard payloads ─────────────────────────────────────────────────────

const NURSE_HOME = {
  ok: true,
  wa_number: '',
  nurse: { ...SAMPLE_PEOPLE.nurse, is_eligible: true },
  arrival: { case_id: 'sample-case-31', case_code: 'CASE-2026-0031', expires_at: at(0.4), attempts: 1 },
  availability: [{
    id: 'sample-check-1', case_id: 'sample-case-34', case_code: 'CASE-2026-0034',
    kind: 'standby', deadline_at: at(0.25), scheduled_at: at(20),
  }],
  overdue: [{
    id: 'sample-case-28', case_code: 'CASE-2026-0028', status: 'in_care',
    care_label: 'Chemotherapy infusion', line_label: 'PICC Line',
    scheduled_at: at(-26), address: '14 Rajpur Road, Civil Lines, Dehradun 248001',
    equipment_notes: null, patient_name: 'Meera Sharma', consented: true,
    arrival_verified_at: at(-25),
    next_step: { action: 'Session is running. Submit the completion report when care is done.', tone: 'do' },
  }],
  today: [{
    id: 'sample-case-31', case_code: 'CASE-2026-0031', status: 'otp_sent',
    care_label: 'One-time infusion', line_label: 'Chemo Port',
    scheduled_at: at(0.8), address: '7B Vasant Vihar, Phase 2, Dehradun 248006',
    equipment_notes: 'Infusion stand + 2 saline bags', patient_name: 'Ramesh Chandra',
    consented: true, arrival_verified_at: null,
    next_step: { action: 'Ask the family for the 6-digit arrival number and send it on WhatsApp.', tone: 'do' },
  }],
  offers: [{
    offer_id: 'sample-offer-1', case_id: 'sample-case-35', case_code: 'CASE-2026-0035',
    care_label: '12-hour nursing', line_label: 'Peripheral Line',
    scheduled_at: at(44), area: 'Clement Town, 248002', sent_at: at(-1.6),
  }],
  upcoming: [{
    id: 'sample-case-34', case_code: 'CASE-2026-0034', status: 'assigned',
    care_label: 'Chemotherapy infusion', line_label: 'Chemo Port',
    scheduled_at: at(28), address: '22 Ballupur Chowk, Dehradun 248001',
    equipment_notes: null, patient_name: 'Sunita Devi', consented: false,
    arrival_verified_at: null,
    next_step: { action: 'Waiting on the family to sign the consent form. Nothing for you yet.', tone: 'wait' },
  }],
  stats: { completed_30d: 11, offers_total: 18, offers_accepted: 13 },
};

const PATIENT_HOME = {
  ok: true,
  wa_number: '',
  patient: { ...SAMPLE_PEOPLE.patient, cancer_type: 'Breast cancer' },
  cases: [
    {
      id: 'sample-case-28', case_code: 'CASE-2026-0028', status: 'in_care',
      care_label: 'Chemotherapy infusion', line_label: 'PICC Line',
      scheduled_at: at(-1), address: '14 Rajpur Road, Civil Lines, Dehradun 248001',
      nurse_name: 'Asha Verma', doctor_name: 'Dr. Arjun Mehta',
      consented: true, arrival_verified_at: at(-0.8),
      invoice: null,
      documents: [],
      next_step: { action: 'Your nurse is with you now. Nothing is needed from you.', tone: 'done' },
    },
    {
      id: 'sample-case-22', case_code: 'CASE-2026-0022', status: 'awaiting_payment',
      care_label: 'One-time infusion', line_label: 'Chemo Port',
      scheduled_at: at(-72), address: '14 Rajpur Road, Civil Lines, Dehradun 248001',
      nurse_name: 'Asha Verma', doctor_name: 'Dr. Arjun Mehta',
      consented: true, arrival_verified_at: at(-71),
      invoice: { invoice_no: 'INV-2026-0019', total_inr: 3500, status: 'sent' },
      documents: [
        { label: 'Invoice INV-2026-0019', kind: 'invoice' },
        { label: 'Discharge summary', kind: 'discharge' },
      ],
      next_step: { action: 'Your bill is ready. Tap Pay on WhatsApp, or reply there once you have paid.', tone: 'do' },
    },
    {
      id: 'sample-case-34', case_code: 'CASE-2026-0034', status: 'assigned',
      care_label: 'Chemotherapy infusion', line_label: 'Chemo Port',
      scheduled_at: at(28), address: '14 Rajpur Road, Civil Lines, Dehradun 248001',
      nurse_name: 'Priya Nair', doctor_name: 'Dr. Arjun Mehta',
      consented: false, arrival_verified_at: null,
      invoice: null,
      documents: [],
      next_step: { action: 'Please sign the consent form we sent on WhatsApp so the session can go ahead.', tone: 'do' },
    },
  ],
  next_chemo_at: at(21 * 24),
};

const DOCTOR_HOME = {
  ok: true,
  doctor: SAMPLE_PEOPLE.doctor,
  patients: [
    {
      case_id: 'sample-case-28', case_code: 'CASE-2026-0028', patient_name: 'Meera Sharma',
      cancer_type: 'Breast cancer', status: 'in_care', care_label: 'Chemotherapy infusion',
      scheduled_at: at(-1), nurse_name: 'Asha Verma', waiting_on: null,
      next_chemo_at: at(21 * 24),
      last_event: { label: 'nurse arrival verified — session started', at: at(-0.8) },
    },
    {
      case_id: 'sample-case-22', case_code: 'CASE-2026-0022', patient_name: 'Meera Sharma',
      cancer_type: 'Breast cancer', status: 'awaiting_payment', care_label: 'One-time infusion',
      scheduled_at: at(-72), nurse_name: 'Asha Verma', waiting_on: 'payment from the family',
      next_chemo_at: null,
      last_event: { label: 'invoice sent', at: at(-70) },
    },
    {
      case_id: 'sample-case-31', case_code: 'CASE-2026-0031', patient_name: 'Ramesh Chandra',
      cancer_type: 'Colorectal cancer', status: 'otp_sent', care_label: 'One-time infusion',
      scheduled_at: at(0.8), nurse_name: 'Asha Verma', waiting_on: null,
      next_chemo_at: null,
      last_event: { label: 'arrival code sent to the family', at: at(-0.3) },
    },
    {
      case_id: 'sample-case-34', case_code: 'CASE-2026-0034', patient_name: 'Sunita Devi',
      cancer_type: 'Ovarian cancer', status: 'assigned', care_label: 'Chemotherapy infusion',
      scheduled_at: at(28), nurse_name: 'Priya Nair', waiting_on: 'consent from the family',
      next_chemo_at: null,
      last_event: { label: 'nurse assigned', at: at(-30) },
    },
  ],
};

const HOMES = { nurse: NURSE_HOME, patient: PATIENT_HOME, doctor: DOCTOR_HOME };

/**
 * Answer a portal action locally. Returns undefined for anything this module
 * does not stand in for, so the caller falls through to the real network —
 * chat, for instance, always goes to the socket server.
 */
export function sampleAnswer(action, session) {
  const role = session?.profile?.role;
  if (action === 'me') return { ok: true, profile: session.profile };
  if (action === 'logout') return { ok: true };
  if (action === `${role}_home`) return structuredClone(HOMES[role]);
  return undefined;
}
