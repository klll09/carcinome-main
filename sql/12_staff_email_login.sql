-- Carcinome Home Care — 12_staff_email_login.sql
-- Nurse and doctor portal accounts authenticate with Supabase Auth email +
-- password. Patients remain on the existing WhatsApp magic-link login.
--
-- This migration stores only a link to auth.users; no password is ever stored
-- in a public application table.

ALTER TABLE nurses
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Email addresses are case-insensitive. Use NULL until a staff member has one.
ALTER TABLE nurses
  DROP CONSTRAINT IF EXISTS nurses_email_format;

ALTER TABLE nurses
  ADD CONSTRAINT nurses_email_format
  CHECK (email IS NULL OR email = lower(trim(email)));

ALTER TABLE doctors
  DROP CONSTRAINT IF EXISTS doctors_email_format;

ALTER TABLE doctors
  ADD CONSTRAINT doctors_email_format
  CHECK (email IS NULL OR email = lower(trim(email)));

CREATE UNIQUE INDEX IF NOT EXISTS uq_nurses_email_ci
  ON nurses (lower(email))
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_doctors_email_ci
  ON doctors (lower(email))
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_nurses_auth_user
  ON nurses (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_doctors_auth_user
  ON doctors (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- After creating Supabase Auth users with matching email addresses,
-- rerun this file to connect each staff row to its Auth account.
UPDATE nurses AS n
SET auth_user_id = u.id
FROM auth.users AS u
WHERE n.email IS NOT NULL
  AND lower(n.email) = lower(u.email)
  AND n.auth_user_id IS DISTINCT FROM u.id;

UPDATE doctors AS d
SET auth_user_id = u.id
FROM auth.users AS u
WHERE d.email IS NOT NULL
  AND lower(d.email) = lower(u.email)
  AND d.auth_user_id IS DISTINCT FROM u.id;

-- A nurse/doctor can sign in only when login_enabled is true.
SELECT 'nurse' AS role, id, full_name, email, auth_user_id IS NOT NULL AS login_enabled
FROM nurses
WHERE email IS NOT NULL

UNION ALL

SELECT 'doctor' AS role, id, full_name, email, auth_user_id IS NOT NULL AS login_enabled
FROM doctors
WHERE email IS NOT NULL

ORDER BY role, full_name;