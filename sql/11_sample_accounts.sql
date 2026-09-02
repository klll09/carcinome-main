-- Carcinome Home Care — 11_sample_accounts.sql
-- DEMO DATA ONLY. Creates three sample people and two sample cases so the
-- portal sample logins and the group chat have something real to show without
-- touching a single genuine patient record.
--
-- ⚠️ DO NOT APPLY TO A PRODUCTION PROJECT.
--    Sample logins issue a session to anyone who asks. They are gated on
--    settings.portal.sample_login, which this file switches ON. Applying this
--    to production opens an unauthenticated door into the portal.
--    To undo, see the teardown block at the bottom.
--
-- Phone numbers use the 91-00000000xx range — structurally valid for the
-- schema, and outside any allocated Indian mobile series, so a stray send
-- cannot reach a real person. The sample nurse is is_eligible=false so she
-- never enters the real case-offer pool.
-- Idempotent.

-- ═══ PEOPLE ═══
INSERT INTO patients (id, full_name, phone, wa_number, cancer_type, address, locality, pincode, language_pref, notes)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'Meera Sharma (sample)', '910000000011', '910000000011',
  'Breast cancer', '14 Rajpur Road, Civil Lines, Dehradun 248001', 'Civil Lines', '248001', 'en',
  'SAMPLE RECORD — demo portal account. Not a real patient.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO nurses (id, full_name, phone, is_eligible, is_active, language_pref, notes)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  'Asha Verma (sample)', '910000000022',
  false,   -- never in the real offer pool
  true, 'en',
  'SAMPLE RECORD — demo portal account. Not a real nurse.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO doctors (id, full_name, phone, specialty, language_pref, default_relay)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  'Dr. Arjun Mehta (sample)', '910000000033', 'Medical Oncology', 'en', 'milestones'
) ON CONFLICT (id) DO NOTHING;

-- ═══ CASES ═══
-- One running, one awaiting payment: enough to show a room list with more than
-- a single entry and to exercise the status chips.
INSERT INTO cases (id, patient_id, doctor_id, line_type, care_type, scheduled_at, address,
                   status, assigned_nurse_id, assigned_at, consented_at, arrival_verified_at, price_inr, notes)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  'chemo_port', 'one_time_infusion', now() + interval '1 hour',
  '14 Rajpur Road, Civil Lines, Dehradun 248001',
  'in_care', '22222222-2222-4222-8222-222222222222',
  now() - interval '2 days', now() - interval '2 days', now() - interval '30 minutes',
  1, 'SAMPLE CASE — demo only.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO cases (id, patient_id, doctor_id, line_type, care_type, scheduled_at, address,
                   status, assigned_nurse_id, assigned_at, consented_at, completed_at, price_inr, notes)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  'picc', 'chemo_infusion', now() - interval '26 hours',
  '14 Rajpur Road, Civil Lines, Dehradun 248001',
  'awaiting_payment', '22222222-2222-4222-8222-222222222222',
  now() - interval '4 days', now() - interval '4 days', now() - interval '24 hours',
  1, 'SAMPLE CASE — demo only.'
) ON CONFLICT (id) DO NOTHING;

-- ═══ PARTICIPANTS (the group chat membership) ═══
INSERT INTO case_participants (case_id, role, phone, display_name, person_id, relay, active)
SELECT c.id, v.role, v.phone, v.display_name, v.person_id, v.relay, true
FROM (VALUES
  ('44444444-4444-4444-8444-444444444444'::uuid),
  ('55555555-5555-4555-8555-555555555555'::uuid)
) AS c(id)
CROSS JOIN (VALUES
  ('patient'::participant_role, '910000000011', 'Meera Sharma', '11111111-1111-4111-8111-111111111111'::uuid, 'full'::relay_mode),
  ('nurse',                     '910000000022', 'Nurse Asha Verma', '22222222-2222-4222-8222-222222222222'::uuid, 'full'),
  ('doctor',                    '910000000033', 'Dr. Arjun Mehta', '33333333-3333-4333-8333-333333333333'::uuid, 'full')
) AS v(role, phone, display_name, person_id, relay)
ON CONFLICT (case_id, phone, role) DO NOTHING;

-- ═══ A LITTLE HISTORY, so the thread is not empty on first open ═══
INSERT INTO messages (case_id, direction, phone, participant_role, msg_type, body, payload, status, created_at)
SELECT * FROM (VALUES
  ('44444444-4444-4444-8444-444444444444'::uuid, 'in'::msg_direction, '910000000011', 'patient'::participant_role,
   'web_chat', 'Namaste, the nurse has arrived. Thank you.',
   '{"via":"web_chat","sender_name":"Meera Sharma"}'::jsonb, 'delivered'::msg_status, now() - interval '25 minutes'),
  ('44444444-4444-4444-8444-444444444444', 'in', '910000000022', 'nurse',
   'web_chat', 'Infusion started at 10:30. Patient is comfortable.',
   '{"via":"web_chat","sender_name":"Asha Verma"}'::jsonb, 'delivered', now() - interval '18 minutes'),
  ('44444444-4444-4444-8444-444444444444', 'in', '910000000033', 'doctor',
   'web_chat', 'Good. Please note the BP before you finish.',
   '{"via":"web_chat","sender_name":"Dr. Arjun Mehta"}'::jsonb, 'delivered', now() - interval '10 minutes')
) AS t(case_id, direction, phone, participant_role, msg_type, body, payload, status, created_at)
WHERE NOT EXISTS (
  SELECT 1 FROM messages m
   WHERE m.case_id = '44444444-4444-4444-8444-444444444444' AND m.msg_type = 'web_chat'
);

-- ═══ SETTINGS: turn the sample doors on ═══
INSERT INTO settings (key, value) VALUES
  ('sample_people', '{"patient":"11111111-1111-4111-8111-111111111111","nurse":"22222222-2222-4222-8222-222222222222","doctor":"33333333-3333-4333-8333-333333333333"}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

UPDATE settings
   SET value = value || '{"sample_login": true}'::jsonb, updated_at = now()
 WHERE key = 'portal';

-- ═══ TEARDOWN — run this before going live ═══
-- UPDATE settings SET value = value || '{"sample_login": false}'::jsonb WHERE key = 'portal';
-- DELETE FROM settings WHERE key = 'sample_people';
-- DELETE FROM messages          WHERE case_id IN ('44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555');
-- DELETE FROM case_participants WHERE case_id IN ('44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555');
-- DELETE FROM portal_sessions   WHERE person_id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');
-- DELETE FROM cases             WHERE id IN ('44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555');
-- DELETE FROM patients WHERE id = '11111111-1111-4111-8111-111111111111';
-- DELETE FROM nurses   WHERE id = '22222222-2222-4222-8222-222222222222';
-- DELETE FROM doctors  WHERE id = '33333333-3333-4333-8333-333333333333';
