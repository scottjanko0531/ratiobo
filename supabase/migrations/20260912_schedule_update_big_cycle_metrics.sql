-- update-big-cycle-metrics (Debt Cycle stage classifier + trip-wire
-- evaluator) previously had no cron at all — it only ran when someone
-- visited /big-cycle or the Position Check brief panel, capped at once/day
-- via generate-debt-cycle-brief's defensive self-trigger. That meant the
-- whole pipeline (stage, trip-wires, audit log) could go silently stale for
-- however long nobody looked. Scheduled after fetch-macro-data-nightly
-- (06:00 UTC) so the macro_indicators/macro_snapshots rows it reads
-- (Fed Balance Sheet % GDP, CPI YoY, 30Y yield, DXY) are fresh for the day
-- before this runs.
select cron.schedule(
  'update-big-cycle-metrics-daily',
  '30 6 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/update-big-cycle-metrics',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
