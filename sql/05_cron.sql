-- Carcinome Home Care — 05_cron.sql
-- pg_cron → pg_net → scheduler edge function. All schedules are UTC.
--
-- ⚠️ COMMITTED FILE (public repo): {{SUPABASE_URL}} and {{CRON_SECRET}} are literal
-- placeholders. scripts/setup_cron.mjs substitutes real values from .env and applies
-- the result via the Management API. NEVER hardcode the secret here.
--
-- Idempotent: each job is unscheduled first (if present), then (re)scheduled.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $do$
DECLARE
  v_job TEXT;
BEGIN
  FOREACH v_job IN ARRAY ARRAY[
    'carcinome_reminders_24h',
    'carcinome_reminders_morning',
    'carcinome_otp_issue',
    'carcinome_otp_expiry',
    'carcinome_sla_nudge',
    'carcinome_feedback_chaser_am',
    'carcinome_feedback_chaser_pm',
    'carcinome_archiver',
    'carcinome_availability'
  ] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job) THEN
      PERFORM cron.unschedule(v_job);
    END IF;
  END LOOP;
END
$do$;

-- reminders_24h — hourly (catches every session as it enters the [T-25h, T-23h] window)
SELECT cron.schedule(
  'carcinome_reminders_24h',
  '0 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'reminders_24h')
  );
  $cmd$
);

-- reminders_morning — 02:30 UTC = 08:00 IST
SELECT cron.schedule(
  'carcinome_reminders_morning',
  '30 2 * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'reminders_morning')
  );
  $cmd$
);

-- otp_issue — every 15 min (sessions starting within the next 60 min)
SELECT cron.schedule(
  'carcinome_otp_issue',
  '*/15 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'otp_issue')
  );
  $cmd$
);

-- otp_expiry — every 5 min (expire stale codes + late-arrival alerts)
SELECT cron.schedule(
  'carcinome_otp_expiry',
  '*/5 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'otp_expiry')
  );
  $cmd$
);

-- sla_nudge — every 15 min (offering cases past settings.sla_offer_hours; 3h re-nudge cooldown in-function)
SELECT cron.schedule(
  'carcinome_sla_nudge',
  '*/15 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'sla_nudge')
  );
  $cmd$
);

-- feedback_chaser — 05:30 UTC = 11:00 IST and 11:30 UTC = 17:00 IST
SELECT cron.schedule(
  'carcinome_feedback_chaser_am',
  '30 5 * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'feedback_chaser')
  );
  $cmd$
);

SELECT cron.schedule(
  'carcinome_feedback_chaser_pm',
  '30 11 * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'feedback_chaser')
  );
  $cmd$
);

-- availability — every 5 min (auto "are you going?" checks inside the pre-session
-- window when settings.availability.auto_check is on + the timeout reaper that
-- fires the standby cascade when a nurse goes silent past the deadline)
SELECT cron.schedule(
  'carcinome_availability',
  '*/5 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'availability')
  );
  $cmd$
);

-- archiver — 21:00 UTC = 02:30 IST (paid cases completed >7 days ago)
SELECT cron.schedule(
  'carcinome_archiver',
  '0 21 * * *',
  $cmd$
  SELECT net.http_post(
    url     := '{{SUPABASE_URL}}/functions/v1/scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '{{CRON_SECRET}}'),
    body    := jsonb_build_object('job', 'archiver')
  );
  $cmd$
);
