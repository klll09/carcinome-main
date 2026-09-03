-- Carcinome Home Care — 02_rls.sql
-- Admin-only RLS. Edge functions use service role (bypasses RLS). No anon access at all.

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active
  );
$$;

REVOKE ALL ON FUNCTION is_admin() FROM anon;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles',
    'patients',
    'doctors',
    'nurses',
    'suppliers',
    'cases',
    'case_offers',
    'case_participants',
    'messages',
    'conversation_state',
    'otps',
    'consents',
    'completion_reports',
    'feedback',
    'invoices',
    'case_events',
    'settings',
    'wa_templates'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS admin_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY admin_all ON %I FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin())',
      t
    );
  END LOOP;
END $$;

-- Edge Functions run with the server-only service role. Grant this role database
-- privileges without granting anything to anonymous or browser clients.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Preserve service-role access for tables, sequences, and functions created later.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;

-- profiles: allow any authenticated user to read their own row
-- (needed to bootstrap is_admin on login).
DROP POLICY IF EXISTS own_profile ON profiles;

CREATE POLICY own_profile ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

-- Storage: admin-only access to the private `case-docs` bucket.
DROP POLICY IF EXISTS admin_read_docs ON storage.objects;

CREATE POLICY admin_read_docs ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'case-docs' AND is_admin());

DROP POLICY IF EXISTS admin_write_docs ON storage.objects;

CREATE POLICY admin_write_docs ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'case-docs' AND is_admin());