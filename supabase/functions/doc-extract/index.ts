// doc-extract/index.ts — scan a patient document → structured field extraction.
// Serves the PATIENT NAVIGATOR portal (sibling Supabase project bcgsejdwqefcdaqxykde),
// hosted here only because this project has a Management-API PAT to deploy with.
// verify_jwt is OFF at the platform gate; the SELF-GUARD below is the auth:
// Authorization must carry a valid Patient Navigator user JWT, verified against
// the PN project's GoTrue (/auth/v1/user). No storage, no PII logging.
//
// POST { mime, data_b64, hint? } with Authorization: Bearer <PN session JWT>.
//   mime     : image/* or application/pdf
//   data_b64 : base64 payload (no data: prefix), max 8 MB of base64 text
//   hint?    : optional free-text context from the caller (e.g. "discharge summary")
// → { ok: true, fields: { ... } }   only what is printed on the document; null elsewhere.
//
// Gemini: gemini-2.5-flash with a strict responseSchema locked to the Patient
// Navigator vocabulary (js/utils/catalog.js enums). Keys: GEMINI_API_KEY with
// GEMINI_KEY_2..4 fallbacks on 429/503. Consent fields are NEVER extracted.

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Self-guard: validate the bearer as a Patient Navigator user JWT ─────────
const PN_AUTH_URL = 'https://bcgsejdwqefcdaqxykde.supabase.co/auth/v1/user';
// PN anon key (public by design — same value the portal ships in js/config.js).
const PN_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjZ3NlamR3cWVmY2RhcXh5a2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MDczNzUsImV4cCI6MjA5MzQ4MzM3NX0.JtTeQdOmKTxwPNb-Cm_uPUbruvQdBpWGahuMIx4g9iU';

async function isPnUser(jwt: string): Promise<boolean> {
  try {
    const res = await fetch(PN_AUTH_URL, {
      headers: { authorization: `Bearer ${jwt}`, apikey: PN_ANON_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const user = await res.json().catch(() => null);
    return !!user?.id;
  } catch (e) {
    console.error('PN auth check failed:', e);
    return false;
  }
}

// ── Vocabulary (mirrors PN js/utils/catalog.js + live enums) ────────────────
const GENDERS = ['male', 'female', 'other'];
const GI_SUBTYPES = [
  'oesophageal', 'gastric', 'colorectal', 'pancreatic', 'liver_hcc', 'gallbladder',
  'bile_duct', 'small_intestine', 'gist', 'anal', 'other_gi',
];
const CANCER_STAGES = ['stage_i', 'stage_ii', 'stage_iii', 'stage_iv', 'unknown', 'not_applicable'];
const TRAJECTORIES = ['curative', 'palliative', 'surveillance', 'unknown'];
const STOMA_TYPES = ['none', 'colostomy', 'ileostomy', 'urostomy', 'feeding_tube'];
const INSURANCE = ['insured', 'uninsured', 'govt_scheme', 'unknown'];
const ECONOMIC = ['bpl', 'lower_middle', 'middle', 'upper_middle', 'unknown'];
const LITERACY = ['basic', 'moderate', 'high'];

const FREE_TEXT_FIELDS = [
  'full_name', 'city', 'state', 'tnm_stage', 'biomarkers', 'current_treatment',
  'treating_hospital', 'treating_doctor', 'referring_doctor', 'caregiver_name',
  'caregiver_relationship', 'payment_method', 'employment_at_diagnosis',
  'primary_language', 'email',
] as const;

function str(desc: string): Record<string, unknown> {
  return { type: 'STRING', nullable: true, description: desc };
}
function enumStr(values: string[], desc: string): Record<string, unknown> {
  return { type: 'STRING', nullable: true, enum: values, description: desc };
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    full_name: str('Patient full name exactly as printed'),
    age: { type: 'INTEGER', nullable: true, description: 'Patient age in years' },
    gender: enumStr(GENDERS, 'Patient sex'),
    phone: str('Patient phone: exactly 10 digits, no country code, no spaces'),
    email: str('Patient email address'),
    primary_language: str('Primary language spoken'),
    city: str('City of residence'),
    state: str('Indian state of residence'),
    gi_subtype: enumStr(GI_SUBTYPES, 'GI cancer subtype the diagnosis maps to'),
    cancer_stage: enumStr(CANCER_STAGES, 'Overall stage if printed (stage_i..stage_iv)'),
    tnm_stage: str('TNM staging as printed, e.g. "T3 N1 M0"'),
    biomarkers: str('Molecular / biomarker status, e.g. "MSI-H, HER2 negative"'),
    diagnosis_month: str('Month of diagnosis as YYYY-MM'),
    current_treatment: str('Current treatment, e.g. "FOLFOX cycle 4"'),
    treating_hospital: str('Treatment centre / hospital name'),
    treating_doctor: str('Treating doctor name'),
    referring_doctor: str('Referring doctor name'),
    ecog: { type: 'INTEGER', nullable: true, description: 'ECOG performance status 0-4' },
    trajectory: enumStr(TRAJECTORIES, 'Disease trajectory / treatment intent'),
    stoma_type: enumStr(STOMA_TYPES, 'Stoma or feeding tube if any'),
    insurance_status: enumStr(INSURANCE, 'Insurance status'),
    economic_status: enumStr(ECONOMIC, 'Economic status (bpl = below poverty line)'),
    payment_method: str('How treatment is being paid for'),
    employment_at_diagnosis: str('Occupation / employment at diagnosis'),
    dependents_count: { type: 'INTEGER', nullable: true, description: 'Number of dependents at home' },
    distance_to_treatment_km: { type: 'NUMBER', nullable: true, description: 'Distance to treatment centre in km' },
    health_literacy: enumStr(LITERACY, 'Health literacy if explicitly assessed'),
    caregiver_name: str('Caregiver / attendant name'),
    caregiver_relationship: str('Caregiver relationship to patient, e.g. "son", "wife"'),
    caregiver_phone: str('Caregiver phone: exactly 10 digits'),
    caregiver_gender: enumStr(GENDERS, 'Caregiver gender'),
  },
};

const PROMPT = `You are extracting patient-intake fields from ONE medical or identity document
(prescription, discharge summary, biopsy/histopathology report, referral letter, hospital card, etc.)
for an Indian cancer-care NGO's records.

Rules — follow them exactly:
- Extract ONLY what is actually printed or clearly handwritten on the document.
- Return null for every field the document does not state. NEVER guess, infer, or fill defaults.
- Enum fields: map to the closest listed value only when the document clearly supports it; else null.
- phone / caregiver_phone: 10-digit Indian mobile numbers as digit-only strings (strip +91, 0 prefix, spaces, dashes). If not exactly 10 digits after stripping, return null.
- diagnosis_month: YYYY-MM only if a diagnosis date/month is printed.
- ecog: integer 0-4 only if an ECOG/performance status is printed.
- Names: as printed, without honorifics like Mr/Mrs/Shri/Smt (keep "Dr" out of doctor names too).
- Do not extract anything about consent.`;

// ── Gemini call with key fallback ───────────────────────────────────────────
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function geminiKeys(): string[] {
  const keys: string[] = [];
  for (const name of ['GEMINI_API_KEY', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4']) {
    const v = Deno.env.get(name);
    if (v) keys.push(v);
  }
  return keys;
}

async function callGemini(
  mime: string,
  dataB64: string,
  hint: string,
): Promise<{ ok: true; fields: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: PROMPT + (hint ? `\n\nCaller's context hint (may be wrong — trust the document): ${hint}` : '') },
        { inline_data: { mime_type: mime, data: dataB64 } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const keys = geminiKeys();
  if (!keys.length) return { ok: false, status: 500, error: 'no_gemini_key_configured' };

  let lastErr = 'gemini_unavailable';
  for (const key of keys) {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_URL}?key=${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(55_000),
      });
    } catch (e) {
      lastErr = `gemini_network: ${e instanceof Error ? e.message : String(e)}`;
      continue; // network/timeout — try the next key (different quota pool)
    }
    if (res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      lastErr = `gemini_${res.status}`;
      continue; // quota/overload — fall back to the next key
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('gemini error', res.status, payload?.error?.message ?? '');
      return { ok: false, status: 502, error: `gemini_${res.status}` };
    }
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') return { ok: false, status: 502, error: 'gemini_empty_response' };
    try {
      return { ok: true, fields: JSON.parse(text) };
    } catch {
      return { ok: false, status: 502, error: 'gemini_bad_json' };
    }
  }
  return { ok: false, status: 503, error: lastErr };
}

// ── Post-validation: never trust the model past the vocabulary ──────────────
function tenDigits(v: unknown): string | null {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

function cleanFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pickEnum = (key: string, vocab: string[]) => {
    const v = raw[key];
    if (typeof v === 'string' && vocab.includes(v)) out[key] = v;
  };
  const pickInt = (key: string, min: number, max: number) => {
    const n = Number(raw[key]);
    if (raw[key] != null && Number.isInteger(n) && n >= min && n <= max) out[key] = n;
  };

  for (const key of FREE_TEXT_FIELDS) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 300);
  }
  pickEnum('gender', GENDERS);
  pickEnum('gi_subtype', GI_SUBTYPES);
  pickEnum('cancer_stage', CANCER_STAGES);
  pickEnum('trajectory', TRAJECTORIES);
  pickEnum('stoma_type', STOMA_TYPES);
  pickEnum('insurance_status', INSURANCE);
  pickEnum('economic_status', ECONOMIC);
  pickEnum('health_literacy', LITERACY);
  pickEnum('caregiver_gender', GENDERS);
  pickInt('age', 0, 120);
  pickInt('ecog', 0, 4);
  pickInt('dependents_count', 0, 20);
  const dist = Number(raw.distance_to_treatment_km);
  if (raw.distance_to_treatment_km != null && Number.isFinite(dist) && dist >= 0 && dist < 5000) {
    out.distance_to_treatment_km = Math.round(dist);
  }
  const phone = tenDigits(raw.phone);
  if (phone) out.phone = phone;
  const cgPhone = tenDigits(raw.caregiver_phone);
  if (cgPhone) out.caregiver_phone = cgPhone;
  const dm = String(raw.diagnosis_month ?? '');
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(dm)) out.diagnosis_month = dm;

  // Belt-and-braces: consent never crosses this boundary.
  for (const key of Object.keys(out)) if (key.startsWith('consent')) delete out[key];
  return out;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const MAX_B64_CHARS = 8 * 1024 * 1024; // 8 MB of base64 text (~6 MB binary)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'missing_authorization' }, 401);
  if (!(await isPnUser(jwt))) return json({ ok: false, error: 'invalid_token' }, 401);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const mime = String(body?.mime ?? '');
  const dataB64 = String(body?.data_b64 ?? '');
  const hint = String(body?.hint ?? '').slice(0, 200);
  if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(mime)) {
    return json({ ok: false, error: 'unsupported_mime' }, 400);
  }
  if (!dataB64 || !/^[A-Za-z0-9+/=]+$/.test(dataB64.slice(0, 1000))) {
    return json({ ok: false, error: 'data_b64 required (base64, no data: prefix)' }, 400);
  }
  if (dataB64.length > MAX_B64_CHARS) return json({ ok: false, error: 'document_too_large' }, 413);

  const result = await callGemini(mime, dataB64, hint);
  if (!result.ok) return json({ ok: false, error: result.error }, result.status);

  return json({ ok: true, fields: cleanFields(result.fields) });
});
