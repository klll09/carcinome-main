-- Carcinome Home Care — 07_availability_hardening.sql
-- Fixes from the adversarial review of the availability/standby cascade:
-- 1. 'cancelled' response for checks superseded by lifecycle changes
--    (reassignment, cancel/archive, stale-nurse rows) — never fires the cascade.
-- 2. AT MOST ONE pending check per case (partial unique index) — kills the
--    double-fire → duplicate-pending → phantom-timeout cascade.
-- 3. merge_context(): atomic jsonb merge for conversation_state.context
--    (the TS read-modify-write raced under concurrent webhook deliveries).
-- Idempotent.

ALTER TYPE avail_response ADD VALUE IF NOT EXISTS 'cancelled';

-- Resolve any existing duplicate pendings (keep the newest) before the index.
UPDATE availability_checks a
   SET response = 'timeout', responded_at = now()
 WHERE a.response = 'pending'
   AND EXISTS (
     SELECT 1 FROM availability_checks b
      WHERE b.case_id = a.case_id AND b.response = 'pending' AND b.sent_at > a.sent_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_avail_one_pending_per_case
  ON availability_checks(case_id) WHERE response = 'pending';

-- Atomic context merge: top-level null values in p_patch DELETE that key
-- (matches the TS mergeContext contract).
CREATE OR REPLACE FUNCTION merge_context(p_phone TEXT, p_patch JSONB) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO conversation_state (phone, context, updated_at)
  VALUES (p_phone, jsonb_strip_nulls(coalesce(p_patch, '{}'::jsonb)), now())
  ON CONFLICT (phone) DO UPDATE
    SET context = jsonb_strip_nulls(coalesce(conversation_state.context, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb)),
        updated_at = now();
$$;
REVOKE ALL ON FUNCTION merge_context(TEXT, JSONB) FROM anon;
