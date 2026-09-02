-- Carcinome Home Care — 04_seed.sql (idempotent upserts)

INSERT INTO settings (key, value) VALUES
  ('pricing', '{"one_time_infusion": 3500, "chemo_infusion": 5000, "nursing_12h": 2500, "nursing_24h": 4500}'),
  ('upi_vpa', '"carcinome@upi"'),
  ('supervisor_phones', '[]'),
  ('ops_phones', '[]'),
  ('sla_offer_hours', '6'),
  ('otp_ttl_min', '30'),
  ('business_name', '"Carcinome Home Care"'),
  ('toggles', '{"relay": true, "reminders": true, "feedback_chaser": true}'),
  ('flow_ids', '{}'),
  ('care_type_labels', '{"one_time_infusion":"One-time infusion","chemo_infusion":"Chemotherapy infusion","nursing_12h":"12-hour nursing","nursing_24h":"24-hour nursing"}'),
  ('line_type_labels', '{"chemo_port":"Chemo Port","picc":"PICC Line","peripheral":"Peripheral Line","other":"Other"}')
ON CONFLICT (key) DO NOTHING;
