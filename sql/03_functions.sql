-- Carcinome Home Care — 03_functions.sql

-- Race-safe ranked offer response. Returns the rank for 'yes' (NULL for 'no').
CREATE OR REPLACE FUNCTION record_offer_response(p_case UUID, p_nurse UUID, p_yes BOOLEAN)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rank INT;
BEGIN
  PERFORM 1 FROM cases WHERE id = p_case FOR UPDATE;   -- serialize rank assignment per case
  IF p_yes THEN
    SELECT COALESCE(MAX(response_rank), 0) + 1 INTO v_rank
      FROM case_offers WHERE case_id = p_case AND response = 'yes';
    UPDATE case_offers
       SET response = 'yes', responded_at = now(),
           response_rank = COALESCE(response_rank, v_rank)   -- keep original rank on repeat taps
     WHERE case_id = p_case AND nurse_id = p_nurse;
    SELECT response_rank INTO v_rank FROM case_offers WHERE case_id = p_case AND nurse_id = p_nurse;
    RETURN v_rank;
  ELSE
    UPDATE case_offers
       SET response = 'no', responded_at = now(), response_rank = NULL
     WHERE case_id = p_case AND nurse_id = p_nurse;
    RETURN NULL;
  END IF;
END $$;

-- Settings getter
CREATE OR REPLACE FUNCTION get_setting(p_key TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT value FROM settings WHERE key = p_key;
$$;

-- Is the 24h customer-service window open for a phone? (23h safety margin)
CREATE OR REPLACE FUNCTION open_window(p_phone TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT last_inbound_at > now() - interval '23 hours' FROM conversation_state WHERE phone = p_phone),
    false);
$$;

-- Dashboard: needs-action summary in one call
CREATE OR REPLACE FUNCTION get_dashboard_stats() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'today_sessions', (SELECT count(*) FROM cases WHERE (scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
                        AND status NOT IN ('archived','cancelled','paid')),
    'awaiting_nurse', (SELECT count(*) FROM cases WHERE status = 'offering'),
    'payments_to_verify', (SELECT count(*) FROM invoices WHERE status = 'paid_claimed'),
    'failed_msgs_24h', (SELECT count(*) FROM messages WHERE status = 'failed' AND created_at > now() - interval '24 hours'),
    'locked_otps', (SELECT count(*) FROM otps WHERE status = 'locked'),
    'open_cases', (SELECT count(*) FROM cases WHERE status NOT IN ('archived','cancelled'))
  );
$$;
