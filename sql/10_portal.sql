-- Carcinome Home Care — 10_portal.sql
-- The role portals: patient / nurse / doctor sign in on the web and see their
-- own slice of the same cases the WhatsApp number already coordinates.
--
-- LOGIN = a magic link over WhatsApp. We already own that channel and every
-- person already has a verified number on file, so there are no passwords to
-- issue, reset, or leak — and an elderly patient's family does not have to
-- remember anything. A one-time token is sent to the number ALREADY STORED on
-- the person's row (never to a number typed into the form), exchanged once for
-- a bearer session.
--
-- ═══ SECURITY POSTURE — read before touching RLS ═══
-- Row-level security on every pre-existing table stays EXACTLY as it is:
-- admin-only, `USING (is_admin())`. The portal never queries Postgres from the
-- browser. Every portal read goes through the `portal` edge function, which
-- holds the service key and scopes each query to the authenticated person in
-- one auditable file. Two consequences worth stating out loud:
--   1. The publishable key committed in js/config.js stays worthless to an
--      attacker — it still cannot read a single row. That property is why it
--      is safe to commit, and this migration does not weaken it.
--   2. There is exactly ONE place where portal authorization can be got wrong
--      (supabase/functions/portal/index.ts), not ~20 policies across 10 tables.
-- Raw tokens are NEVER stored: only sha256(token). A dump of these two tables
-- does not let anyone log in as anybody.
-- Idempotent.

-- ═══ MAGIC-LINK TOKENS ═══
CREATE TABLE IF NOT EXISTS portal_login_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT UNIQUE NOT NULL,               -- sha256 hex of the raw token
  role TEXT NOT NULL CHECK (role IN ('patient','nurse','doctor')),
  person_id UUID NOT NULL,                        -- patients.id / nurses.id / doctors.id
  phone TEXT NOT NULL,                            -- canonical, from the person's row
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Rate limiting reads this: "how many links did this phone ask for lately?"
CREATE INDEX IF NOT EXISTS idx_portal_tokens_phone ON portal_login_tokens (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_live ON portal_login_tokens (expires_at) WHERE used_at IS NULL;

-- ═══ SESSIONS ═══
CREATE TABLE IF NOT EXISTS portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT UNIQUE NOT NULL,               -- sha256 hex of the raw session token
  role TEXT NOT NULL CHECK (role IN ('patient','nurse','doctor')),
  person_id UUID NOT NULL,
  phone TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_person
  ON portal_sessions (role, person_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry
  ON portal_sessions (expires_at) WHERE revoked_at IS NULL;

-- ═══ RLS: admin-only, same as everything else ═══
-- These are an AUDIT surface for the dashboard ("who logged in, when"), not a
-- read surface for the portal itself — the edge function uses the service key.
ALTER TABLE portal_login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all ON portal_login_tokens;
CREATE POLICY admin_all ON portal_login_tokens FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS admin_all ON portal_sessions;
CREATE POLICY admin_all ON portal_sessions FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- ═══ SETTINGS ═══
-- app_url          MUST be the deployed SPA root with a trailing slash: the
--                  magic link is built as `<app_url>#portal/enter?t=<token>`.
--                  A wrong value means links that 404 on a patient's phone,
--                  which is why it is a setting and not a constant in code.
-- wa_number        the business number, digits only with country code. The
--                  portal is a WINDOW: every action still happens in the
--                  WhatsApp thread, so each page offers a wa.me link back to
--                  it. ⚠️ This default is the PILOT/TEST number — change it in
--                  the same breath as the WA_PHONE_ID secret at cutover, or
--                  the portal will send people to a number that no longer
--                  runs their cases.
-- show_admin_login flips the staff door on the landing page (hide for prod).
INSERT INTO settings (key, value) VALUES
  ('portal', '{"enabled": true, "show_admin_login": true, "app_url": "https://ubhayaab.github.io/JCF/carcinome_wpp/", "wa_number": "919389529263", "link_ttl_min": 15, "session_ttl_days": 30, "max_links_per_hour": 5}')
ON CONFLICT (key) DO NOTHING;
