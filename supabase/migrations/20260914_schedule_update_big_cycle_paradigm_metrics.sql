-- Daily refresh for the Fiscal Policy Paradigm scorecard. Scheduled at
-- 06:45 UTC, in the same morning window as fetch-macro-data-nightly (06:00)
-- and update-big-cycle-metrics-daily (06:30) -- this job doesn't actually
-- depend on either (it pulls straight from FRED itself), but keeping it in
-- the same general window avoids an arbitrary standalone cron time and
-- matches this repo's existing staggering convention.
select cron.schedule(
  'update-big-cycle-paradigm-metrics-daily',
  '45 6 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/update-big-cycle-paradigm-metrics',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
