// portal/index.ts — the patient / nurse / doctor web portals (verify_jwt OFF).
//
// ═══ WHY THIS FUNCTION EXISTS AT ALL ═══
// The dashboard SPA queries Postgres directly because RLS is admin-only: the
// publishable key in js/config.js can read nothing, so shipping it is safe.
// The portal must NOT weaken that. So the portal browser code never touches
// Postgres — it calls this function, which holds the service key and scopes
// every single read to the authenticated person. Portal authorization lives
// HERE, in one file you can read end to end, instead of in ~20 RLS policies
// spread over 10 tables where one wrong predicate leaks a cancer patient's
// medical record. Every query below therefore starts from `s.person_id`.
//
// ═══ LOGIN ═══
// Magic link over WhatsApp. The link is ALWAYS sent to the number already
// stored on the person's row — never to the number typed into the form — so
// typing someone else's number sends the link to THEM, not to you.
//   POST { action: 'request_link', role, phone }  → always { ok: true }
//   POST { action: 'verify', token }              → { ok, session, expires_at, profile }
// Raw tokens are never stored; only sha256(token). Both tables are admin-RLS.
//
// ═══ SESSION-GUARDED ACTIONS (Authorization: Bearer <session token>) ═══
//   me          → the signed-in person + their role
//   nurse_home  → the nurse dashboard payload (role must be 'nurse')
//   logout      → revoke this session
//
// ═══ PRIVACY INVARIANTS INHERITED FROM THE RELAY ═══
//   1. Participants never see each other's phone numbers. The relay hub exists
//      precisely so the patient's number stays hidden from the nurse and vice
//      versa. No payload below ever contains another person's phone.
//   2. An OPEN OFFER shows the LOCALITY only, never the street address —
//      the same rule admin-actions applies when it sends nurse_case_offer.
//      The full address appears only once she is the assigned nurse.
import { db, getServiceKey, getSetting } from '../_shared/db.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { normPhone } from '../_shared/phone.ts';
import { pick, type Lang } from '../_shared/lang.ts';
import { paramSafe, sendSmart } from '../_shared/wa.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const HOUR = 3600_000;
const IST_OFFSET = 5.5 * HOUR;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

type PortalRole = 'patient' | 'nurse' | 'doctor';
const ROLES: PortalRole[] = ['patient', 'nurse', 'doctor'];

type PortalSettings = {
  enabled: boolean;
  show_admin_login: boolean;
  sample_login: boolean;
  app_url: string;
  wa_number: string;
  link_ttl_min: number;
  session_ttl_days: number;
  max_links_per_hour: number;
};

async function portalSettings(): Promise<PortalSettings> {
  const v = (await getSetting<Partial<PortalSettings>>('portal')) ?? {};
  return {
    enabled: v.enabled !== false,
    show_admin_login: v.show_admin_login !== false,
    // Opt-IN, unlike the others: sample logins are unauthenticated, so the
    // absence of the setting must mean OFF, never on-by-default.
    sample_login: v.sample_login === true,
    app_url: String(v.app_url ?? '').trim(),
    wa_number: normPhone(String(v.wa_number ?? '')),
    link_ttl_min: Number(v.link_ttl_min ?? 15) || 15,
    session_ttl_days: Number(v.session_ttl_days ?? 30) || 30,
    max_links_per_hour: Number(v.max_links_per_hour ?? 5) || 5,
  };
}

/**
 * Issue a session for a demo account — no WhatsApp round trip.
 *
 * ⚠️ This hands a real session to anyone who asks, so it is gated twice, and
 * both gates are server-side: settings.portal.sample_login must be explicitly
 * true (absent = off), and settings.sample_people must name the person id for
 * that role. Leave either unset and this endpoint is dead — which is the
 * production configuration. Never point sample_people at a real patient.
 */
async function sampleLogin(role: PortalRole): Promise<Response> {
  const cfg = await portalSettings();
  if (!cfg.enabled || !cfg.sample_login) return json({ ok: false, error: 'sample_login_disabled' }, 403);

  const map = (await getSetting<Record<string, string>>('sample_people')) ?? {};
  const personId = map[role];
  if (!personId) return json({ ok: false, error: 'no_sample_for_role' }, 404);

  const table = role === 'patient' ? 'patients' : role === 'nurse' ? 'nurses' : 'doctors';
  const phoneCol = role === 'patient' ? 'wa_number' : 'phone';
  const { data: person } = await db
    .from(table)
    .select(`id, full_name, language_pref, ${phoneCol}`)
    .eq('id', personId)
    .maybeSingle();
  if (!person) return json({ ok: false, error: 'sample_person_missing' }, 404);

  const raw = mintToken();
  const expiresAt = new Date(Date.now() + cfg.session_ttl_days * 24 * HOUR).toISOString();
  const { error } = await db.from('portal_sessions').insert({
    token_hash: await hashToken(raw),
    role,
    person_id: personId,
    // deno-lint-ignore no-explicit-any
    phone: normPhone(String((person as any)[phoneCol] ?? '')),
    expires_at: expiresAt,
    last_seen_at: new Date().toISOString(),
  });
  if (error) {
    console.error('sample session insert failed:', error.message);
    return json({ ok: false, error: 'session_failed' }, 500);
  }
  console.warn(`sample_login issued for ${role}:${personId} — demo build`);
  return json({
    ok: true,
    session: raw,
    expires_at: expiresAt,
    profile: { role, id: person.id, full_name: person.full_name, language_pref: person.language_pref },
  });
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** 32 crypto-random bytes as base64url — the raw token the user carries. */
function mintToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** sha256 hex. The ONLY form of a token that ever touches the database. */
async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── People ─────────────────────────────────────────────────────────────────

type Person = { id: string; full_name: string; phone: string; language_pref: string };

/**
 * Find the person behind a typed phone number, in the role they claimed.
 * Returns null for unknown / opted-out / deactivated people — the caller must
 * NOT reveal which of those it was (see requestLink).
 */
async function findPerson(role: PortalRole, typedPhone: string): Promise<Person | null> {
  const p = normPhone(typedPhone);
  if (!p || p.length < 11) return null;
  try {
    if (role === 'patient') {
      const { data } = await db
        .from('patients')
        .select('id, full_name, wa_number, phone, language_pref, opted_out')
        .or(`wa_number.eq.${p},phone.eq.${p}`)
        .limit(1);
      const row = data?.[0];
      if (!row || row.opted_out) return null;
      // Deliver to wa_number: that is the number WhatsApp actually reaches.
      // A blank one means we have nowhere to send the link — treat it as
      // "not found" rather than minting a token addressed to an empty string.
      const waPhone = normPhone(row.wa_number);
      if (!waPhone) return null;
      return { id: row.id, full_name: row.full_name, phone: waPhone, language_pref: row.language_pref };
    }
    if (role === 'nurse') {
      const { data } = await db
        .from('nurses')
        .select('id, full_name, phone, language_pref, opted_out, is_active')
        .eq('phone', p)
        .maybeSingle();
      if (!data || data.opted_out || !data.is_active) return null;
      return { id: data.id, full_name: data.full_name, phone: normPhone(data.phone), language_pref: data.language_pref };
    }
    const { data } = await db
      .from('doctors')
      .select('id, full_name, phone, language_pref, opted_out')
      .eq('phone', p)
      .maybeSingle();
    if (!data || data.opted_out) return null;
    return { id: data.id, full_name: data.full_name, phone: normPhone(data.phone), language_pref: data.language_pref };
  } catch (e) {
    console.error(`findPerson(${role}) exception:`, e);
    return null;
  }
}

// ─── request_link ───────────────────────────────────────────────────────────

/**
 * ALWAYS answers { ok: true }. An attacker must not be able to learn from this
 * endpoint whether a number belongs to a cancer patient — that fact is itself
 * sensitive. Unknown number, opted out, rate-limited and delivered all look
 * identical from outside; the server logs tell the real story.
 */
async function requestLink(role: PortalRole, typedPhone: string): Promise<Response> {
  const cfg = await portalSettings();
  const generic = json({ ok: true });
  if (!cfg.enabled) return generic;
  if (!cfg.app_url) {
    console.error('portal.app_url is not set — cannot build a login link');
    return generic;
  }

  const person = await findPerson(role, typedPhone);
  if (!person) {
    console.log(`request_link: no ${role} for the typed number — answering generically`);
    return generic;
  }

  // Rate limit per DESTINATION phone, so hammering the form cannot be used to
  // spam somebody else's WhatsApp with login links.
  try {
    const { count } = await db
      .from('portal_login_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('phone', person.phone)
      .gt('created_at', new Date(Date.now() - HOUR).toISOString());
    if ((count ?? 0) >= cfg.max_links_per_hour) {
      console.warn(`request_link: rate limit hit for ${person.phone} (${count} in the last hour)`);
      return generic;
    }
  } catch (e) {
    console.error('request_link rate-limit check failed:', e);
  }

  const raw = mintToken();
  const expiresAt = new Date(Date.now() + cfg.link_ttl_min * 60_000).toISOString();
  const { error } = await db.from('portal_login_tokens').insert({
    token_hash: await hashToken(raw),
    role,
    person_id: person.id,
    phone: person.phone,
    expires_at: expiresAt,
  });
  if (error) {
    console.error('login token insert failed:', error.message);
    return generic;
  }

  const url = `${cfg.app_url.replace(/\/+$/, '/')}#portal/enter?t=${raw}`;
  const lang: Lang = person.language_pref === 'hi' ? 'hi' : 'en';
  const body = pick(lang, {
    en: `Your Carcinome Home Care sign-in link is below. It works once and expires in ${cfg.link_ttl_min} minutes.\n\n${url}\n\nIf you did not ask to sign in, ignore this message — nobody can use the link without this phone.`,
    hi: `कार्सिनोम होम केयर में साइन इन करने का आपका लिंक नीचे है। यह एक बार काम करेगा और ${cfg.link_ttl_min} मिनट में समाप्त हो जाएगा।\n\n${url}\n\nयदि आपने साइन इन का अनुरोध नहीं किया है, तो इस संदेश को अनदेखा करें — इस फ़ोन के बिना कोई भी इस लिंक का उपयोग नहीं कर सकता।`,
  });

  // Window-aware, like every other send in this system. A closed window falls
  // back to the care_update carrier with the link as a template parameter.
  const r = await sendSmart(person.phone, body, {
    name: 'care_update',
    lang,
    params: ['Carcinome Team', paramSafe(`Sign-in link (valid ${cfg.link_ttl_min} min): ${url}`, 280)],
  });
  if (!r.ok) console.error(`request_link: WhatsApp send failed for ${person.phone}:`, r.error);

  // Opportunistic housekeeping — keeps the token table from growing forever
  // without needing its own cron entry.
  db.from('portal_login_tokens')
    .delete()
    .lt('expires_at', new Date(Date.now() - 24 * HOUR).toISOString())
    .then(({ error: delErr }) => {
      if (delErr) console.error('token cleanup failed:', delErr.message);
    });

  return generic;
}

// ─── verify ─────────────────────────────────────────────────────────────────

async function verifyLink(rawToken: string): Promise<Response> {
  const cfg = await portalSettings();
  if (!cfg.enabled) return json({ ok: false, error: 'portal_disabled' }, 403);
  const raw = String(rawToken ?? '').trim();
  if (!raw) return json({ ok: false, error: 'missing_token' }, 400);

  const hash = await hashToken(raw);
  const { data: tok, error } = await db
    .from('portal_login_tokens')
    .select('id, role, person_id, phone, expires_at, used_at')
    .eq('token_hash', hash)
    .maybeSingle();
  if (error) {
    console.error('token lookup failed:', error.message);
    return json({ ok: false, error: 'lookup_failed' }, 500);
  }
  // One generic answer for absent / already-used / expired: a wrong link is a
  // wrong link, and distinguishing them only helps someone probing.
  if (!tok || tok.used_at || new Date(tok.expires_at).getTime() < Date.now()) {
    return json({ ok: false, error: 'link_invalid' }, 401);
  }

  // Burn the token FIRST, and only if this call is the one that burns it.
  // Two taps on the same link race here; the loser gets link_invalid.
  const { data: burned } = await db
    .from('portal_login_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', tok.id)
    .is('used_at', null)
    .select('id');
  if ((burned ?? []).length === 0) return json({ ok: false, error: 'link_invalid' }, 401);

  // The person must STILL be valid at redemption time — a nurse deactivated
  // between request and tap must not get in on a token minted before that.
  const person = await findPerson(tok.role as PortalRole, tok.phone);
  if (!person || person.id !== tok.person_id) {
    return json({ ok: false, error: 'account_unavailable' }, 403);
  }

  const sessionRaw = mintToken();
  const expiresAt = new Date(Date.now() + cfg.session_ttl_days * 24 * HOUR).toISOString();
  const { error: sessErr } = await db.from('portal_sessions').insert({
    token_hash: await hashToken(sessionRaw),
    role: tok.role,
    person_id: tok.person_id,
    phone: tok.phone,
    expires_at: expiresAt,
    last_seen_at: new Date().toISOString(),
  });
  if (sessErr) {
    console.error('session insert failed:', sessErr.message);
    return json({ ok: false, error: 'session_failed' }, 500);
  }

  return json({
    ok: true,
    session: sessionRaw,
    expires_at: expiresAt,
    profile: { role: tok.role, id: person.id, full_name: person.full_name, language_pref: person.language_pref },
  });
}

// ─── password_login (nurse / doctor staff accounts) ────────────────────────
async function passwordLogin(role: PortalRole, rawEmail: string, rawPassword: string): Promise<Response> {
  const cfg = await portalSettings();
  const fail = () => json({ ok: false, error: 'invalid_credentials' }, 401);
  if (!cfg.enabled) return json({ ok: false, error: 'portal_disabled' }, 403);
  if (role !== 'nurse' && role !== 'doctor') return fail();

  const email = String(rawEmail ?? '').trim().toLowerCase();
  const password = String(rawPassword ?? '');
  if (!email || !password) return fail();

    const authClient = createClient(Deno.env.get('SUPABASE_URL')!, getServiceKey(), {
    auth: { persistSession: false },
  });
  const { data: authData, error: authErr } = await authClient.auth.signInWithPassword({ email, password });
  if (authErr || !authData?.user) {
    console.error(`password_login signIn failed for ${email}:`, authErr?.message, authErr?.status);
    return fail();
  }

  const table = role === 'nurse' ? 'nurses' : 'doctors';
  const cols = role === 'nurse'
    ? 'id, full_name, phone, language_pref, opted_out, is_active'
    : 'id, full_name, phone, language_pref, opted_out';
  const { data: person, error: lookupErr } = await db
    .from(table).select(cols).eq('auth_user_id', authData.user.id).maybeSingle();
  if (lookupErr) console.error('password_login lookup failed:', lookupErr.message);

  // deno-lint-ignore no-explicit-any
  const p = person as any;
    if (!p || p.opted_out || (role === 'nurse' && !p.is_active)) {
    console.error(
      `password_login lookup rejected for ${email} (auth_user_id=${authData.user.id}):`,
      !p ? 'no matching row (auth_user_id not linked, or wrong table for role)'
        : p.opted_out ? 'row is opted_out'
        : 'row is_active is false',
    );
    return fail();
  }

  const raw = mintToken();
  const expiresAt = new Date(Date.now() + cfg.session_ttl_days * 24 * HOUR).toISOString();
  const { error: sessErr } = await db.from('portal_sessions').insert({
    token_hash: await hashToken(raw), role, person_id: p.id,
    phone: normPhone(String(p.phone ?? '')), expires_at: expiresAt,
    last_seen_at: new Date().toISOString(),
  });
  if (sessErr) {
    console.error('password_login session insert failed:', sessErr.message);
    return json({ ok: false, error: 'session_failed' }, 500);
  }

  return json({
    ok: true, session: raw, expires_at: expiresAt,
    profile: { role, id: p.id, full_name: p.full_name, language_pref: p.language_pref },
  });
}

// ─── Session guard ──────────────────────────────────────────────────────────

type Session = { id: string; role: PortalRole; person_id: string; phone: string };

async function loadSession(req: Request): Promise<Session | null> {
  const raw = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;
  try {
    const { data } = await db
      .from('portal_sessions')
      .select('id, role, person_id, phone, expires_at, revoked_at')
      .eq('token_hash', await hashToken(raw))
      .maybeSingle();
    if (!data || data.revoked_at || new Date(data.expires_at).getTime() < Date.now()) return null;

    // Touch last_seen_at, but never let that write block the request.
    db.from('portal_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(({ error }) => {
        if (error) console.error('last_seen_at update failed:', error.message);
      });

    return { id: data.id, role: data.role as PortalRole, person_id: data.person_id, phone: data.phone };
  } catch (e) {
    console.error('loadSession exception:', e);
    return null;
  }
}

// ─── Shared shaping helpers ─────────────────────────────────────────────────

/** IST "today" as a [startUtc, endUtc) pair — same trick the scheduler uses. */
function istDayRange(offsetDays = 0): { start: string; end: string } {
  const nowIst = new Date(Date.now() + IST_OFFSET);
  const startUtc = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate() + offsetDays) - IST_OFFSET;
  return { start: new Date(startUtc).toISOString(), end: new Date(startUtc + 24 * HOUR).toISOString() };
}

const CARE_LABELS_FALLBACK: Record<string, string> = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemotherapy infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};
const LINE_LABELS_FALLBACK: Record<string, string> = {
  chemo_port: 'Chemo Port',
  picc: 'PICC Line',
  peripheral: 'Peripheral Line',
  other: 'Other',
};

async function allLabels(): Promise<{ care: Record<string, string>; line: Record<string, string> }> {
  const care = (await getSetting<Record<string, string>>('care_type_labels')) ?? {};
  const line = (await getSetting<Record<string, string>>('line_type_labels')) ?? {};
  return { care: { ...CARE_LABELS_FALLBACK, ...care }, line: { ...LINE_LABELS_FALLBACK, ...line } };
}

/** Locality-level area — the ONLY geography an unassigned nurse may see. */
function areaOf(p: { locality?: string | null; pincode?: string | null } | null, address?: string | null): string {
  if (p?.locality) return p.pincode ? `${p.locality}, ${p.pincode}` : p.locality;
  const parts = String(address ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join(', ');
  return parts[0] ?? 'Area shared on assignment';
}

/**
 * The one line of "what do I do next" per case. This is the daily-chores
 * engine: it reads the same status the WhatsApp copy reads, so the phone and
 * the dashboard can never disagree about whose turn it is.
 */
function nurseNextStep(status: string, consented: boolean): { action: string; tone: 'wait' | 'do' | 'done' } {
  switch (status) {
    case 'assigned':
      return consented
        ? { action: 'Confirm you are going when we ask, then travel to the address.', tone: 'wait' }
        : { action: 'Waiting on the family to sign the consent form. Nothing for you yet.', tone: 'wait' };
    case 'consented':
      return { action: 'Consent is signed. Message us when you reach the patient’s home.', tone: 'wait' };
    case 'otp_sent':
      return { action: 'Ask the family for the 6-digit arrival number and send it on WhatsApp.', tone: 'do' };
    case 'in_care':
      return { action: 'Session is running. Submit the completion report when care is done.', tone: 'do' };
    case 'care_done':
    case 'awaiting_payment':
    case 'paid':
      return { action: 'Report received. Nothing further needed from you.', tone: 'done' };
    default:
      return { action: 'No action needed right now.', tone: 'wait' };
  }
}

// ─── nurse_home ─────────────────────────────────────────────────────────────

const NURSE_CASE_SELECT =
  'id, case_code, status, care_type, line_type, scheduled_at, address, equipment_notes, ' +
  'consented_at, arrival_verified_at, ' +
  'patients:patient_id(full_name, cancer_type, locality, pincode, language_pref)';

// NOTE: `patients` is selected WITHOUT wa_number/phone on purpose. The relay
// hub hides participants' numbers from each other; the portal must not become
// the hole in that. Contact happens through the WhatsApp thread, never direct.

async function nurseHome(s: Session): Promise<Response> {
  const { data: nurse } = await db
    .from('nurses')
    .select('id, full_name, phone, language_pref, is_eligible, is_active')
    .eq('id', s.person_id)
    .maybeSingle();
  if (!nurse || !nurse.is_active) return json({ ok: false, error: 'account_unavailable' }, 403);

  const labels = await allLabels();
  const today = istDayRange();
  const weekEnd = istDayRange(7).start;

  // ── Assigned work. Scoped to assigned_nurse_id — she can never read a case
  //    that is not hers, whatever the client asks for.
  const { data: assigned } = await db
    .from('cases')
    .select(NURSE_CASE_SELECT)
    .eq('assigned_nurse_id', nurse.id)
    .in('status', ['assigned', 'consented', 'otp_sent', 'in_care', 'care_done', 'awaiting_payment'])
    .order('scheduled_at', { ascending: true })
    .limit(60);

  // deno-lint-ignore no-explicit-any
  const shapeAssigned = (c: any) => {
    const p = c.patients as { full_name?: string; cancer_type?: string; locality?: string; pincode?: string } | null;
    return {
      id: c.id,
      case_code: c.case_code,
      status: c.status,
      care_label: labels.care[c.care_type] ?? c.care_type,
      line_label: labels.line[c.line_type] ?? c.line_type,
      scheduled_at: c.scheduled_at,
      address: c.address, // she is the assigned nurse — full address is hers
      equipment_notes: c.equipment_notes,
      patient_name: p?.full_name ?? 'Patient',
      cancer_type: p?.cancer_type ?? null,
      consented: !!c.consented_at,
      arrival_verified_at: c.arrival_verified_at,
      next_step: nurseNextStep(c.status, !!c.consented_at),
    };
  };

  const assignedRows = (assigned ?? []).map(shapeAssigned);
  const todayRows = assignedRows.filter((c) => c.scheduled_at >= today.start && c.scheduled_at < today.end);
  const upcomingRows = assignedRows.filter((c) => c.scheduled_at >= today.end && c.scheduled_at < weekEnd);
  // Anything still open but scheduled before today — a session that never got
  // closed out. It is the most important row on the page, so it gets its own
  // bucket rather than being sorted quietly to the top of "today".
  const overdueRows = assignedRows.filter(
    (c) => c.scheduled_at < today.start && !['care_done', 'awaiting_payment', 'paid'].includes(c.status),
  );

  // ── Open offers. LOCALITY ONLY — never c.address (see file header).
  const { data: offers } = await db
    .from('case_offers')
    // `cases!inner(...)` — the plain embed name, matching the shape already
    // proven in relay.ts / digest.ts / intent.ts. An alias plus !inner in one
    // token (`cases:case_id!inner`) is not the same thing and the .eq filter
    // below has to address the embed by exactly this name.
    .select(
      'id, response, sent_at, ' +
      'cases!inner(id, case_code, status, care_type, line_type, scheduled_at, address, ' +
      'patients:patient_id(locality, pincode))',
    )
    .eq('nurse_id', nurse.id)
    .eq('response', 'pending')
    .eq('cases.status', 'offering')
    .order('sent_at', { ascending: false })
    .limit(25);
  // deno-lint-ignore no-explicit-any
  const offerRows = (offers ?? []).map((o: any) => {
    const c = o.cases;
    return {
      offer_id: o.id,
      case_id: c.id,
      case_code: c.case_code,
      care_label: labels.care[c.care_type] ?? c.care_type,
      line_label: labels.line[c.line_type] ?? c.line_type,
      scheduled_at: c.scheduled_at,
      area: areaOf(c.patients, c.address),
      sent_at: o.sent_at,
    };
  });

  // ── Pending "are you going?" checks.
  const { data: checks } = await db
    .from('availability_checks')
    .select('id, case_id, kind, deadline_at, sent_at, cases:case_id(case_code, scheduled_at)')
    .eq('nurse_id', nurse.id)
    .eq('response', 'pending')
    .order('sent_at', { ascending: false })
    .limit(5);
  // deno-lint-ignore no-explicit-any
  const checkRows = (checks ?? []).map((r: any) => ({
    id: r.id,
    case_id: r.case_id,
    case_code: r.cases?.case_code ?? '',
    kind: r.kind,
    deadline_at: r.deadline_at,
    scheduled_at: r.cases?.scheduled_at ?? null,
  }));

  // ── Is a live arrival code waiting on her right now?
  const { data: otp } = await db
    .from('otps')
    .select('case_id, expires_at, attempts, cases:case_id(case_code)')
    .eq('expected_from_phone', s.phone)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const arrival = otp
    // deno-lint-ignore no-explicit-any
    ? { case_id: otp.case_id, case_code: (otp.cases as any)?.case_code ?? '', expires_at: otp.expires_at, attempts: otp.attempts }
    : null;

  // ── Standing stats.
  const since30d = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
  const [{ count: completed30d }, { count: offersTotal }, { count: offersYes }] = await Promise.all([
    db.from('cases').select('id', { count: 'exact', head: true })
      .eq('assigned_nurse_id', nurse.id)
      .in('status', ['care_done', 'awaiting_payment', 'paid', 'archived'])
      .gt('completed_at', since30d),
    db.from('case_offers').select('id', { count: 'exact', head: true }).eq('nurse_id', nurse.id),
    db.from('case_offers').select('id', { count: 'exact', head: true }).eq('nurse_id', nurse.id).eq('response', 'yes'),
  ]);

  return json({
    ok: true,
    // Carried on the dashboard payload so the page needs ONE round trip, not
    // a second call to `config` before it can draw its "reply on WhatsApp"
    // buttons — this is read on a phone, often on mobile data between homes.
    wa_number: (await portalSettings()).wa_number,
    nurse: {
      id: nurse.id,
      full_name: nurse.full_name,
      language_pref: nurse.language_pref,
      is_eligible: nurse.is_eligible,
    },
    today: todayRows,
    overdue: overdueRows,
    upcoming: upcomingRows,
    offers: offerRows,
    availability: checkRows,
    arrival,
    stats: {
      completed_30d: completed30d ?? 0,
      offers_total: offersTotal ?? 0,
      offers_accepted: offersYes ?? 0,
    },
  });
}

// ─── patient_home ───────────────────────────────────────────────────────────

/** Plain-language "what happens next" for the family. Mirrors nurseNextStep. */
function patientNextStep(status: string, consented: boolean): { action: string; tone: 'wait' | 'do' | 'done' } {
  switch (status) {
    case 'registered':
    case 'offering':
      return { action: 'We are finding the right oncology nurse for you. We will confirm on WhatsApp.', tone: 'wait' };
    case 'assigned':
      return consented
        ? { action: 'Your nurse is confirmed. Nothing is needed from you before the session.', tone: 'done' }
        : { action: 'Please sign the consent form we sent on WhatsApp so the session can go ahead.', tone: 'do' };
    case 'consented':
      return { action: 'All set. Your nurse will arrive at the scheduled time.', tone: 'done' };
    case 'otp_sent':
      return { action: 'Your nurse is on the way. Please give them the 6-digit number we sent you.', tone: 'do' };
    case 'in_care':
      return { action: 'Your nurse is with you now. Nothing is needed from you.', tone: 'done' };
    case 'care_done':
      return { action: 'Session complete. Your bill and discharge summary are on their way.', tone: 'wait' };
    case 'awaiting_payment':
      return { action: 'Your bill is ready. Tap Pay on WhatsApp, or reply there once you have paid.', tone: 'do' };
    case 'paid':
      return { action: 'Payment received — thank you. Nothing further is due.', tone: 'done' };
    default:
      return { action: 'Nothing is needed from you right now.', tone: 'wait' };
  }
}

// Nurse and doctor NAMES only — never their phone numbers. The relay hides
// participants' numbers from each other and the portal must not be the hole.
const PATIENT_CASE_SELECT =
  'id, case_code, status, care_type, line_type, scheduled_at, address, consented_at, ' +
  'arrival_verified_at, next_chemo_at, ' +
  'nurses:assigned_nurse_id(full_name), doctors:doctor_id(full_name)';

async function patientHome(s: Session): Promise<Response> {
  const { data: patient } = await db
    .from('patients')
    .select('id, full_name, cancer_type, language_pref')
    .eq('id', s.person_id)
    .maybeSingle();
  if (!patient) return json({ ok: false, error: 'account_unavailable' }, 403);

  const labels = await allLabels();
  const { data: rows } = await db
    .from('cases')
    .select(PATIENT_CASE_SELECT)
    .eq('patient_id', s.person_id)          // ← the scope. Never a client-supplied id.
    .not('status', 'in', '("cancelled")')
    .order('scheduled_at', { ascending: false })
    .limit(30);

  // Invoices for those cases, in one round trip rather than N.
  const ids = (rows ?? []).map((c) => c.id);
  const invByCase = new Map<string, { invoice_no: string; total_inr: number; status: string; pdf_path: string | null }>();
  if (ids.length) {
    const { data: invs } = await db
      .from('invoices')
      .select('case_id, invoice_no, total_inr, status, pdf_path')
      .in('case_id', ids);
    for (const i of invs ?? []) invByCase.set(i.case_id, i);
  }

  // deno-lint-ignore no-explicit-any
  const cases = (rows ?? []).map((c: any) => {
    const inv = invByCase.get(c.id) ?? null;
    const documents: { label: string; kind: string }[] = [];
    if (inv?.pdf_path) documents.push({ label: `Invoice ${inv.invoice_no}`, kind: 'invoice' });
    if (['care_done', 'awaiting_payment', 'paid'].includes(c.status)) {
      documents.push({ label: 'Discharge summary', kind: 'discharge' });
    }
    return {
      id: c.id,
      case_code: c.case_code,
      status: c.status,
      care_label: labels.care[c.care_type] ?? c.care_type,
      line_label: labels.line[c.line_type] ?? c.line_type,
      scheduled_at: c.scheduled_at,
      address: c.address,
      nurse_name: c.nurses?.full_name ?? null,
      doctor_name: c.doctors?.full_name ?? null,
      consented: !!c.consented_at,
      arrival_verified_at: c.arrival_verified_at,
      invoice: inv ? { invoice_no: inv.invoice_no, total_inr: Number(inv.total_inr ?? 0), status: inv.status } : null,
      documents,
      next_step: patientNextStep(c.status, !!c.consented_at),
    };
  });

  // The soonest next-chemo date across their cases, if a doctor set one.
  const nextChemo = (rows ?? [])
    // deno-lint-ignore no-explicit-any
    .map((c: any) => c.next_chemo_at)
    .filter(Boolean)
    .sort()[0] ?? null;

  return json({
    ok: true,
    wa_number: (await portalSettings()).wa_number,
    patient: {
      id: patient.id,
      full_name: patient.full_name,
      cancer_type: patient.cancer_type,
      language_pref: patient.language_pref,
    },
    cases,
    next_chemo_at: nextChemo,
  });
}

// ─── doctor_home ────────────────────────────────────────────────────────────

/** The same phrasing buildStatusDigest uses, so the web and STATUS agree. */
const EVENT_PHRASE: Record<string, string> = {
  registered: 'case registered',
  offers_sent: 'nurse offers sent',
  offer_yes: 'a nurse accepted the offer',
  nurse_assigned: 'nurse assigned',
  nurse_reassigned: 'nurse reassigned',
  consent_sent: 'consent form sent to the family',
  consented: 'consent signed',
  otp_issued: 'arrival code sent to the family',
  otp_verified: 'nurse arrival verified — session started',
  care_completed: 'completion report received',
  invoice_sent: 'invoice sent',
  discharge_sent: 'discharge summary sent',
  payment_claimed: 'family says they have paid',
  payment_verified: 'payment verified',
  feedback_received: 'feedback received',
  next_chemo_set: 'next chemo date set',
};

/** What, if anything, is this case stalled on? Null when it is simply moving. */
function waitingOn(status: string, consented: boolean): string | null {
  if (['registered', 'offering'].includes(status)) return 'a nurse to accept the case';
  if (status === 'assigned' && !consented) return 'consent from the family';
  if (status === 'awaiting_payment') return 'payment from the family';
  return null;
}

async function doctorHome(s: Session): Promise<Response> {
  const { data: doctor } = await db
    .from('doctors')
    .select('id, full_name, language_pref')
    .eq('id', s.person_id)
    .maybeSingle();
  if (!doctor) return json({ ok: false, error: 'account_unavailable' }, 403);

  const labels = await allLabels();
  const { data: rows } = await db
    .from('cases')
    .select(
      'id, case_code, status, care_type, scheduled_at, consented_at, next_chemo_at, ' +
      'patients:patient_id(full_name, cancer_type), nurses:assigned_nurse_id(full_name)',
    )
    .eq('doctor_id', s.person_id)           // ← the scope.
    .not('status', 'in', '("cancelled","archived")')
    .order('scheduled_at', { ascending: false })
    .limit(40);

  // Latest event per case, one query for the lot.
  const ids = (rows ?? []).map((c) => c.id);
  const lastByCase = new Map<string, { label: string; at: string }>();
  if (ids.length) {
    const { data: events } = await db
      .from('case_events')
      .select('case_id, event_type, created_at')
      .in('case_id', ids)
      .order('created_at', { ascending: false })
      .limit(400);
    for (const e of events ?? []) {
      // Ordered newest-first, so the first hit per case is the latest.
      if (!lastByCase.has(e.case_id)) {
        lastByCase.set(e.case_id, {
          label: EVENT_PHRASE[e.event_type] ?? String(e.event_type).replaceAll('_', ' '),
          at: e.created_at,
        });
      }
    }
  }

  // deno-lint-ignore no-explicit-any
  const patients = (rows ?? []).map((c: any) => ({
    case_id: c.id,
    case_code: c.case_code,
    patient_name: c.patients?.full_name ?? 'Patient',
    cancer_type: c.patients?.cancer_type ?? null,
    status: c.status,
    care_label: labels.care[c.care_type] ?? c.care_type,
    scheduled_at: c.scheduled_at,
    nurse_name: c.nurses?.full_name ?? null,
    waiting_on: waitingOn(c.status, !!c.consented_at),
    next_chemo_at: c.next_chemo_at,
    last_event: lastByCase.get(c.id) ?? null,
  }));

  return json({
    ok: true,
    wa_number: (await portalSettings()).wa_number,
    doctor: { id: doctor.id, full_name: doctor.full_name, language_pref: doctor.language_pref },
    patients,
  });
}

// ─── me / logout ────────────────────────────────────────────────────────────

async function me(s: Session): Promise<Response> {
  const table = s.role === 'patient' ? 'patients' : s.role === 'nurse' ? 'nurses' : 'doctors';
  const { data } = await db.from(table).select('id, full_name, language_pref').eq('id', s.person_id).maybeSingle();
  if (!data) return json({ ok: false, error: 'account_unavailable' }, 403);
  return json({ ok: true, profile: { role: s.role, id: data.id, full_name: data.full_name, language_pref: data.language_pref } });
}

async function logout(s: Session): Promise<Response> {
  await db.from('portal_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', s.id);
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════════════════════
// HTTP entry
// ════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const action = String(body?.action ?? '');

  try {
    // ── Public actions ──
    if (action === 'config') {
      const cfg = await portalSettings();
      // Only what the landing page needs to draw itself, plus the public
      // business number people already message. Never the TTLs, never the
      // rate limit — an attacker learns nothing useful here.
      return json({
        ok: true,
        enabled: cfg.enabled,
        show_admin_login: cfg.show_admin_login,
        sample_login: cfg.sample_login,
        wa_number: cfg.wa_number,
      });
    }
    if (action === 'request_link') {
      const role = String(body?.role ?? '') as PortalRole;
      if (!ROLES.includes(role)) return json({ ok: false, error: 'invalid_role' }, 400);
      return await requestLink(role, String(body?.phone ?? ''));
    }
    if (action === 'password_login') {
      const role = String(body?.role ?? '') as PortalRole;
      if (role !== 'nurse' && role !== 'doctor') return json({ ok: false, error: 'invalid_role' }, 400);
      return await passwordLogin(role, String(body?.email ?? ''), String(body?.password ?? ''));
    }
    if (action === 'sample_login') {
      const role = String(body?.role ?? '') as PortalRole;
      if (!ROLES.includes(role)) return json({ ok: false, error: 'invalid_role' }, 400);
      return await sampleLogin(role);
    }
    if (action === 'verify') return await verifyLink(String(body?.token ?? ''));

    // ── Session-guarded actions ──
    const s = await loadSession(req);
    if (!s) return json({ ok: false, error: 'not_signed_in' }, 401);

    switch (action) {
      case 'me':
        return await me(s);
      case 'logout':
        return await logout(s);
      case 'nurse_home':
        if (s.role !== 'nurse') return json({ ok: false, error: 'wrong_role' }, 403);
        return await nurseHome(s);
      case 'patient_home':
        if (s.role !== 'patient') return json({ ok: false, error: 'wrong_role' }, 403);
        return await patientHome(s);
      case 'doctor_home':
        if (s.role !== 'doctor') return json({ ok: false, error: 'wrong_role' }, 403);
        return await doctorHome(s);
      default:
        return json({ ok: false, error: `unknown_action: ${action}` }, 400);
    }
  } catch (e) {
    console.error(`portal ${action} exception:`, e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
