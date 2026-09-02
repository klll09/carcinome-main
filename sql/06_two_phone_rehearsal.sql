-- Carcinome Home Care — 06_two_phone_rehearsal.sql
-- 1. Multi-role participants: one phone may hold SEVERAL roles on the same case
--    (rehearsal reality: phone A = nurse-1 + doctor, phone B = patient + nurse-2).
--    unique(case_id, phone) → unique(case_id, phone, role); relay dedupes per phone.
-- 2. Availability handshake: "are you going right now?" checks + standby cascade.
-- 3. Next-chemo date: set by the doctor over WhatsApp after discharge.
-- Idempotent.

-- ═══ 1. case_participants: (case_id, phone) → (case_id, phone, role) ═══
DO $$
DECLARE con TEXT;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'case_participants'::regclass
     AND contype = 'u'
     AND conkey = (
       SELECT array_agg(attnum ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = 'case_participants'::regclass AND attname IN ('case_id','phone'));
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE case_participants DROP CONSTRAINT %I', con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'case_participants'::regclass
       AND conname = 'case_participants_case_phone_role_key') THEN
    ALTER TABLE case_participants
      ADD CONSTRAINT case_participants_case_phone_role_key UNIQUE (case_id, phone, role);
  END IF;
END $$;

-- ═══ 2. Availability checks (primary nurse "going now?" + standby offers) ═══
DO $$ BEGIN CREATE TYPE avail_kind AS ENUM ('primary','standby'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE avail_response AS ENUM ('pending','yes','no','timeout'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS availability_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  nurse_id UUID NOT NULL REFERENCES nurses(id),
  nurse_phone TEXT NOT NULL,
  kind avail_kind NOT NULL DEFAULT 'primary',
  response avail_response NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_avail_case ON availability_checks(case_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_avail_pending ON availability_checks(deadline_at) WHERE response = 'pending';
CREATE INDEX IF NOT EXISTS idx_avail_phone_pending ON availability_checks(nurse_phone) WHERE response = 'pending';

ALTER TABLE availability_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all ON availability_checks;
CREATE POLICY admin_all ON availability_checks FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE availability_checks;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══ 3. Next chemo date (doctor-entered over WhatsApp) ═══
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_chemo_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_chemo_set_by TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS next_chemo_set_at TIMESTAMPTZ;

-- ═══ 4. Settings ═══
INSERT INTO settings (key, value) VALUES
  ('availability', '{"timeout_min": 20, "auto_check": false, "check_before_min": 120}')
ON CONFLICT (key) DO NOTHING;
