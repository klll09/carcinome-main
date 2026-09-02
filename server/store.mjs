// ============================================================
// Carcinome chat — data access, and THE ACCESS CONTROL MODEL.
//
// A "room" is a CASE. That is not an arbitrary choice: case_participants
// already models exactly the group this chat is for — the patient, their
// allotted nurse, and the referring doctor on one case.
//
// ═══ WHO SEES WHICH ROOMS ═══ (the whole point; everything else is plumbing)
//   patient → cases where cases.patient_id        = them
//   nurse   → cases where cases.assigned_nurse_id = them   (allotted, not merely offered)
//   doctor  → cases where cases.doctor_id         = them
//   admin   → every case, read AND write
//
// Room visibility is derived ON THE SERVER from the authenticated identity.
// A client never names a room it wants access to without canAccess() being
// re-checked against that identity — join and send both re-verify, so a
// crafted socket payload cannot reach another patient's chat.
//
// Two stores implement the same interface:
//   supabase — the real one, service key, writes into the `messages` ledger
//   demo     — in-memory, no credentials, for sample logins and offline demos
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Case statuses that still have a live conversation. */
const LIVE_STATUSES = [
  'registered', 'offering', 'assigned', 'consented', 'otp_sent',
  'in_care', 'care_done', 'awaiting_payment', 'paid',
];

const CARE_LABELS = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemotherapy infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};

// ════════════════════════════════════════════════════════════════════════════
// Supabase-backed store
// ════════════════════════════════════════════════════════════════════════════

export function supabaseStore({ url, serviceKey }) {
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  /** Portal bearer → identity. Same table and hashing as the portal function. */
  async function authenticatePortal(token) {
    if (!token) return null;
    const { data } = await db
      .from('portal_sessions')
      .select('id, role, person_id, phone, expires_at, revoked_at')
      .eq('token_hash', sha256(token))
      .maybeSingle();
    if (!data || data.revoked_at || new Date(data.expires_at).getTime() < Date.now()) return null;

    const table = data.role === 'patient' ? 'patients' : data.role === 'nurse' ? 'nurses' : 'doctors';
    const { data: person } = await db.from(table).select('id, full_name').eq('id', data.person_id).maybeSingle();
    if (!person) return null;
    return {
      kind: 'portal',
      role: data.role,
      personId: data.person_id,
      phone: data.phone,
      name: person.full_name,
    };
  }

  /** Admin Supabase JWT → identity. Mirrors the admin-actions guard exactly. */
  async function authenticateAdmin(jwt) {
    if (!jwt) return null;
    const { data: userData, error } = await db.auth.getUser(jwt);
    if (error || !userData?.user) return null;
    const { data: profile } = await db
      .from('profiles')
      .select('id, full_name, role, is_active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (!profile || profile.role !== 'admin' || !profile.is_active) return null;
    return { kind: 'admin', role: 'ops', personId: profile.id, phone: 'dashboard', name: profile.full_name };
  }

  const ROOM_SELECT =
    'id, case_code, status, care_type, scheduled_at, ' +
    'patients:patient_id(id, full_name), ' +
    'nurses:assigned_nurse_id(id, full_name), ' +
    'doctors:doctor_id(id, full_name)';

  /** THE scoping query. One branch per role — see the header block. */
  function scopedQuery(identity) {
    let q = db.from('cases').select(ROOM_SELECT).in('status', LIVE_STATUSES);
    if (identity.kind === 'admin') return q;
    if (identity.role === 'patient') return q.eq('patient_id', identity.personId);
    if (identity.role === 'nurse') return q.eq('assigned_nurse_id', identity.personId);
    if (identity.role === 'doctor') return q.eq('doctor_id', identity.personId);
    // Unknown role → deliberately impossible filter rather than an open query.
    return q.eq('id', '00000000-0000-0000-0000-000000000000');
  }

  async function listRooms(identity) {
    const { data, error } = await scopedQuery(identity).order('scheduled_at', { ascending: false }).limit(100);
    if (error) {
      console.error('listRooms failed:', error.message);
      return [];
    }
    return (data ?? []).map(shapeRoom);
  }

  /** Re-checked on EVERY join and EVERY send. Never trust a client room id. */
  async function canAccess(identity, caseId) {
    if (!caseId) return false;
    const { data } = await scopedQuery(identity).eq('id', caseId).maybeSingle();
    return !!data;
  }

  /**
   * The thread. Inbound rows + web chat only:
   *  - outbound relay copies would duplicate one human message N times
   *    (fanOut writes a row per recipient)
   *  - templates (invoice, OTP prompts) are system noise in a chat pane
   */
  async function history(caseId, limit = 100) {
    const { data, error } = await db
      .from('messages')
      .select('id, phone, participant_role, msg_type, body, payload, created_at, direction')
      .eq('case_id', caseId)
      .eq('direction', 'in')
      .in('msg_type', ['web_chat', 'text'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('history failed:', error.message);
      return [];
    }
    return (data ?? []).reverse().map((m) => shapeMessage(m, caseId));
  }

  async function append(caseId, identity, text) {
    const row = {
      case_id: caseId,
      direction: 'in',
      phone: identity.phone || 'dashboard',
      participant_role: identity.role,
      msg_type: 'web_chat',
      body: text,
      payload: { via: 'web_chat', sender_name: identity.name, sender_kind: identity.kind },
    };
    const { data, error } = await db.from('messages').insert(row).select('id, created_at').single();
    if (error) throw new Error(`chat insert failed: ${error.message}`);
    return shapeMessage({ ...row, id: data.id, created_at: data.created_at }, caseId);
  }

  return { authenticatePortal, authenticateAdmin, listRooms, canAccess, history, append };
}

function shapeRoom(c) {
  const members = [
    c.patients ? { role: 'patient', name: c.patients.full_name } : null,
    c.nurses ? { role: 'nurse', name: c.nurses.full_name } : null,
    c.doctors ? { role: 'doctor', name: c.doctors.full_name } : null,
  ].filter(Boolean);
  return {
    id: c.id,
    case_code: c.case_code,
    status: c.status,
    scheduled_at: c.scheduled_at,
    care_label: CARE_LABELS[c.care_type] ?? c.care_type,
    patient_name: c.patients?.full_name ?? 'Patient',
    nurse_name: c.nurses?.full_name ?? null,
    doctor_name: c.doctors?.full_name ?? null,
    members,
  };
}

function shapeMessage(m, caseId) {
  return {
    id: String(m.id),
    case_id: caseId,
    role: m.participant_role || 'ops',
    sender_name: m.payload?.sender_name || fallbackName(m.participant_role),
    body: m.body ?? '',
    created_at: m.created_at,
    via: m.msg_type === 'web_chat' ? 'web' : 'whatsapp',
  };
}

function fallbackName(role) {
  return { patient: 'Patient', nurse: 'Nurse', doctor: 'Doctor', ops: 'Care team', supplier: 'Supplier' }[role] || 'Participant';
}

// ════════════════════════════════════════════════════════════════════════════
// Demo store — in memory, no credentials, no network.
//
// This exists so the sample logins work with nothing deployed: `npm run demo`
// and the whole flow is clickable. It implements the SAME interface and, more
// importantly, the SAME scoping rules, so what you see in a demo is what the
// real store will do. Nothing here ever touches a real phone or a real record.
// ════════════════════════════════════════════════════════════════════════════

export function demoStore() {
  const people = {
    patient: [
      { id: 'p-meera', name: 'Meera Sharma' },
      { id: 'p-ramesh', name: 'Ramesh Chandra' },
    ],
    nurse: [{ id: 'n-asha', name: 'Asha Verma' }, { id: 'n-priya', name: 'Priya Nair' }],
    doctor: [{ id: 'd-arjun', name: 'Dr. Arjun Mehta' }],
  };

  const cases = [
    {
      id: 'case-0031', case_code: 'CASE-2026-0031', status: 'in_care',
      care_type: 'one_time_infusion', scheduled_at: hoursFromNow(1),
      patient_id: 'p-ramesh', assigned_nurse_id: 'n-asha', doctor_id: 'd-arjun',
    },
    {
      id: 'case-0028', case_code: 'CASE-2026-0028', status: 'awaiting_payment',
      care_type: 'chemo_infusion', scheduled_at: hoursFromNow(-26),
      patient_id: 'p-meera', assigned_nurse_id: 'n-asha', doctor_id: 'd-arjun',
    },
    {
      id: 'case-0034', case_code: 'CASE-2026-0034', status: 'assigned',
      care_type: 'nursing_12h', scheduled_at: hoursFromNow(28),
      patient_id: 'p-meera', assigned_nurse_id: 'n-priya', doctor_id: null,
    },
  ];

  const messages = [
    msg('case-0031', 'patient', 'Ramesh Chandra', 'Namaste, the nurse has arrived. Thank you.', -40),
    msg('case-0031', 'nurse', 'Asha Verma', 'Infusion started at 10:30. Patient is comfortable.', -32),
    msg('case-0031', 'doctor', 'Dr. Arjun Mehta', 'Good. Please note the BP before you finish.', -20),
    msg('case-0028', 'patient', 'Meera Sharma', 'We have received the invoice, paying today.', -600),
    msg('case-0028', 'ops', 'Carcinome Ops', 'Thank you — we will confirm once it reflects.', -580),
  ];
  let seq = messages.length;

  // Well-known sample tokens. These are DEMO-ONLY credentials for an in-memory
  // dataset; the demo store is never the one holding real patient records.
  // ⚠️ The prefix must match SAMPLE_PREFIX in js/portal/sample.js — that is the
  // token the browser actually presents at the socket handshake. The short
  // `sample-<role>` aliases stay so test-access.mjs and curl keep working.
  const sessions = new Map([
    ['sample-session-patient', { role: 'patient', personId: 'p-meera' }],
    ['sample-session-nurse', { role: 'nurse', personId: 'n-asha' }],
    ['sample-session-doctor', { role: 'doctor', personId: 'd-arjun' }],
    ['sample-patient', { role: 'patient', personId: 'p-meera' }],
    ['sample-nurse', { role: 'nurse', personId: 'n-asha' }],
    ['sample-doctor', { role: 'doctor', personId: 'd-arjun' }],
  ]);

  function nameOf(role, id) {
    return (people[role] || []).find((p) => p.id === id)?.name ?? 'Sample user';
  }

  function authenticatePortal(token) {
    const s = sessions.get(String(token));
    if (!s) return null;
    return { kind: 'portal', role: s.role, personId: s.personId, phone: `demo-${s.personId}`, name: nameOf(s.role, s.personId) };
  }

  // Any bearer at all is the sample admin here — the demo store has no auth
  // provider, and it holds nothing worth protecting.
  function authenticateAdmin(jwt) {
    if (!jwt) return null;
    return { kind: 'admin', role: 'ops', personId: 'admin-demo', phone: 'dashboard', name: 'Carcinome Ops' };
  }

  /** Same four branches as the Supabase store. Kept side by side on purpose. */
  function visible(identity) {
    if (identity.kind === 'admin') return cases;
    if (identity.role === 'patient') return cases.filter((c) => c.patient_id === identity.personId);
    if (identity.role === 'nurse') return cases.filter((c) => c.assigned_nurse_id === identity.personId);
    if (identity.role === 'doctor') return cases.filter((c) => c.doctor_id === identity.personId);
    return [];
  }

  const expand = (c) => ({
    ...c,
    patients: c.patient_id ? { id: c.patient_id, full_name: nameOf('patient', c.patient_id) } : null,
    nurses: c.assigned_nurse_id ? { id: c.assigned_nurse_id, full_name: nameOf('nurse', c.assigned_nurse_id) } : null,
    doctors: c.doctor_id ? { id: c.doctor_id, full_name: nameOf('doctor', c.doctor_id) } : null,
  });

  return {
    authenticatePortal: async (t) => authenticatePortal(t),
    authenticateAdmin: async (j) => authenticateAdmin(j),
    listRooms: async (identity) => visible(identity).map((c) => shapeRoom(expand(c))),
    canAccess: async (identity, caseId) => visible(identity).some((c) => c.id === caseId),
    history: async (caseId) => messages.filter((m) => m.case_id === caseId),
    append: async (caseId, identity, text) => {
      const m = {
        id: `demo-${++seq}`, case_id: caseId, role: identity.role,
        sender_name: identity.name, body: text,
        created_at: new Date().toISOString(), via: 'web',
      };
      messages.push(m);
      return m;
    },
    // Used only by the demo REST shim so sample login can hand back a token.
    _sampleToken: (role) => (sessions.has(`sample-${role}`) ? `sample-${role}` : null),
    _profile: (token) => authenticatePortal(token),

    /**
     * A nurse_home payload shaped like the edge function's, built from the
     * same in-memory cases the chat uses — so the demo shows a working
     * dashboard next to a working chat instead of half a product.
     */
    _nurseHome: (identity) => {
      const mine = cases.filter((c) => c.assigned_nurse_id === identity.personId);
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay.getTime() + 86400_000);
      const shape = (c) => ({
        id: c.id, case_code: c.case_code, status: c.status,
        care_label: CARE_LABELS[c.care_type] ?? c.care_type,
        line_label: 'Chemo Port',
        scheduled_at: c.scheduled_at,
        address: '14 Rajpur Road, Civil Lines, Dehradun 248001',
        equipment_notes: c.status === 'in_care' ? 'Infusion stand + 2 saline bags' : null,
        patient_name: nameOf('patient', c.patient_id),
        consented: true, arrival_verified_at: null,
        next_step: c.status === 'in_care'
          ? { action: 'Session is running. Submit the completion report when care is done.', tone: 'do' }
          : { action: 'Report received. Nothing further needed from you.', tone: 'done' },
      });
      const at = (c) => new Date(c.scheduled_at).getTime();
      return {
        ok: true, wa_number: '',
        nurse: { id: identity.personId, full_name: identity.name, language_pref: 'en', is_eligible: true },
        arrival: null, availability: [],
        today: mine.filter((c) => at(c) >= startOfDay && at(c) < endOfDay).map(shape),
        overdue: mine.filter((c) => at(c) < startOfDay && c.status !== 'awaiting_payment').map(shape),
        upcoming: mine.filter((c) => at(c) >= endOfDay).map(shape),
        offers: [],
        stats: { completed_30d: 11, offers_total: 18, offers_accepted: 13 },
      };
    },
  };

  function msg(caseId, role, name, body, minsAgo) {
    return {
      id: `demo-${caseId}-${role}-${minsAgo}`, case_id: caseId, role,
      sender_name: name, body, created_at: new Date(Date.now() + minsAgo * 60000).toISOString(),
      via: role === 'ops' ? 'web' : 'whatsapp',
    };
  }
  function hoursFromNow(h) { return new Date(Date.now() + h * 3600000).toISOString(); }
}

export { randomUUID };
