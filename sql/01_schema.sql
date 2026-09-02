-- Carcinome Home Care — 01_schema.sql
-- Core entities, enums, ledger, state. Idempotent-ish (IF NOT EXISTS where possible).

-- ═══ ENUMS ═══
DO $$ BEGIN CREATE TYPE line_type AS ENUM ('chemo_port','picc','peripheral','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE care_type AS ENUM ('one_time_infusion','chemo_infusion','nursing_12h','nursing_24h'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE case_status AS ENUM ('registered','offering','assigned','consented','otp_sent','in_care','care_done','awaiting_payment','paid','archived','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE offer_response AS ENUM ('pending','yes','no','expired','withdrawn'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE participant_role AS ENUM ('patient','nurse','doctor','ops','supplier'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE relay_mode AS ENUM ('full','milestones','muted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE msg_direction AS ENUM ('in','out'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE msg_status AS ENUM ('pending','accepted','sent','delivered','read','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE otp_status AS ENUM ('active','verified','expired','locked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invoice_status AS ENUM ('draft','sent','paid_claimed','paid_verified','void'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══ SEQUENCES ═══
CREATE SEQUENCE IF NOT EXISTS patient_code_seq;
CREATE SEQUENCE IF NOT EXISTS case_code_seq;
CREATE SEQUENCE IF NOT EXISTS invoice_seq;

-- ═══ updated_at helper ═══
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ═══ ADMIN AUTH ═══
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_profiles_updated ON profiles;
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══ PEOPLE ═══
CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_code TEXT UNIQUE NOT NULL DEFAULT ('CHC-'||to_char(now(),'YYYY')||'-'||lpad(nextval('patient_code_seq')::text,4,'0')),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  wa_number TEXT NOT NULL,
  cancer_type TEXT NOT NULL,
  address TEXT NOT NULL,
  locality TEXT,
  pincode TEXT,
  language_pref TEXT NOT NULL DEFAULT 'en' CHECK (language_pref IN ('en','hi')),
  notes TEXT,
  opted_out BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_patients_wa ON patients(wa_number);
DROP TRIGGER IF EXISTS trg_patients_updated ON patients;
CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  specialty TEXT,
  language_pref TEXT NOT NULL DEFAULT 'en' CHECK (language_pref IN ('en','hi')),
  default_relay relay_mode NOT NULL DEFAULT 'milestones',
  opted_out BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nurses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  is_eligible BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  language_pref TEXT NOT NULL DEFAULT 'en' CHECK (language_pref IN ('en','hi')),
  skills JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  opted_out BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nurses_eligible ON nurses(is_eligible) WHERE is_active;

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  language_pref TEXT NOT NULL DEFAULT 'en' CHECK (language_pref IN ('en','hi')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  opted_out BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ CASES (the spine) ═══
CREATE TABLE IF NOT EXISTS cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_code TEXT UNIQUE NOT NULL DEFAULT ('CASE-'||to_char(now(),'YYYY')||'-'||lpad(nextval('case_code_seq')::text,4,'0')),
  patient_id UUID NOT NULL REFERENCES patients(id),
  doctor_id UUID REFERENCES doctors(id),
  supplier_id UUID REFERENCES suppliers(id),
  line_type line_type NOT NULL,
  care_type care_type NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  address TEXT NOT NULL,
  equipment_notes TEXT,
  discharge_upload_path TEXT,
  notes TEXT,
  status case_status NOT NULL DEFAULT 'registered',
  assigned_nurse_id UUID REFERENCES nurses(id),
  assigned_at TIMESTAMPTZ,
  consented_at TIMESTAMPTZ,
  arrival_verified_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  price_inr NUMERIC(10,2),
  cancelled_reason TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_sched ON cases(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_cases_nurse ON cases(assigned_nurse_id);
CREATE INDEX IF NOT EXISTS idx_cases_patient ON cases(patient_id);
DROP TRIGGER IF EXISTS trg_cases_updated ON cases;
CREATE TRIGGER trg_cases_updated BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══ NURSE OFFERS ═══
CREATE TABLE IF NOT EXISTS case_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  nurse_id UUID NOT NULL REFERENCES nurses(id),
  sent_wamid TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response offer_response NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMPTZ,
  response_rank INT,
  UNIQUE(case_id, nurse_id)
);
CREATE INDEX IF NOT EXISTS idx_offers_case ON case_offers(case_id, response, response_rank);
CREATE INDEX IF NOT EXISTS idx_offers_nurse_pending ON case_offers(nurse_id) WHERE response = 'pending';

-- ═══ RELAY HUB ═══
CREATE TABLE IF NOT EXISTS case_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  role participant_role NOT NULL,
  phone TEXT NOT NULL,
  display_name TEXT NOT NULL,
  person_id UUID,
  relay relay_mode NOT NULL DEFAULT 'full',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(case_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_participants_phone ON case_participants(phone) WHERE active;

-- ═══ MESSAGE LEDGER ═══
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wamid TEXT UNIQUE,
  direction msg_direction NOT NULL,
  case_id UUID REFERENCES cases(id),
  phone TEXT NOT NULL,
  participant_role participant_role,
  msg_type TEXT NOT NULL,
  template_name TEXT,
  body TEXT,
  payload JSONB,
  status msg_status NOT NULL DEFAULT 'pending',
  status_at TIMESTAMPTZ,
  error JSONB,
  pricing_category TEXT,
  billable BOOLEAN NOT NULL DEFAULT false,
  relay_of BIGINT REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_failed ON messages(status) WHERE status = 'failed';

-- ═══ PER-PHONE STATE + 24h WINDOW ═══
CREATE TABLE IF NOT EXISTS conversation_state (
  phone TEXT PRIMARY KEY,
  active_case_id UUID REFERENCES cases(id),
  flow TEXT,
  step TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  last_autoreply_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ OTP HANDSHAKE ═══
CREATE TABLE IF NOT EXISTS otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id),
  code TEXT NOT NULL,
  issued_to_phone TEXT NOT NULL,
  expected_from_phone TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  status otp_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_otps_expected ON otps(expected_from_phone) WHERE status = 'active';

-- ═══ FLOW RESULTS ═══
CREATE TABLE IF NOT EXISTS consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID UNIQUE NOT NULL REFERENCES cases(id),
  patient_id UUID REFERENCES patients(id),
  flow_token TEXT,
  agreed BOOLEAN NOT NULL,
  signed_name TEXT,
  relationship TEXT,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS completion_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID UNIQUE NOT NULL REFERENCES cases(id),
  nurse_id UUID REFERENCES nurses(id),
  meds_administered TEXT,
  started_hhmm TEXT,
  ended_hhmm TEXT,
  complications TEXT,
  complication_notes TEXT,
  notes TEXT,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID UNIQUE NOT NULL REFERENCES cases(id),
  patient_id UUID REFERENCES patients(id),
  overall_rating INT CHECK (overall_rating BETWEEN 1 AND 5),
  nurse_rating INT CHECK (nurse_rating BETWEEN 1 AND 5),
  recommend BOOLEAN,
  comments TEXT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ BILLING ═══
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID UNIQUE NOT NULL REFERENCES cases(id),
  invoice_no TEXT UNIQUE NOT NULL DEFAULT ('INV-'||to_char(now(),'YYYY')||'-'||lpad(nextval('invoice_seq')::text,4,'0')),
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal_inr NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_inr NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_inr NUMERIC(10,2) NOT NULL DEFAULT 0,
  upi_vpa TEXT,
  payment_provider TEXT NOT NULL DEFAULT 'upi_intent',
  status invoice_status NOT NULL DEFAULT 'draft',
  pdf_path TEXT,
  sent_at TIMESTAMPTZ,
  paid_claimed_at TIMESTAMPTZ,
  paid_verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ TIMELINE / AUDIT ═══
CREATE TABLE IF NOT EXISTS case_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(case_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_event_once ON case_events(case_id, event_type)
  WHERE event_type IN ('reminder_24h','reminder_morning','offers_sent','invoice_sent','feedback_invite_1');

-- ═══ CONFIG + TEMPLATE REGISTRY ═══
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES profiles(id)
);

CREATE TABLE IF NOT EXISTS wa_templates (
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'UTILITY',
  body TEXT,
  variables JSONB,
  buttons JSONB,
  status TEXT NOT NULL DEFAULT 'draft',
  graph_id TEXT,
  rejection_reason TEXT,
  last_synced_at TIMESTAMPTZ,
  PRIMARY KEY (name, language)
);

-- ═══ REALTIME (dashboard live timeline) ═══
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE messages;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE case_events;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE cases;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
