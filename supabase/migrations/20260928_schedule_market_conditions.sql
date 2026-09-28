-- Market Conditions Overlay, Phase 1 — nightly schedule. Same pg_cron +
-- net.http_post pattern as every other scheduled job in this repo (e.g.
-- 20260908_schedule_asset_resize_overlay_jobs.sql). Ingest runs first,
-- compute 10 minutes later to give it room to finish; compute also doubles
-- as the backfill job (see market-conditions-compute/index.ts's own header
-- comment), so no separate backfill schedule is needed.
--
-- 22:30 UTC weekdays = after US market close and same-day FRED/Yahoo
-- updates, matching the build spec's own "weekdays, after close" intent
-- (spec Section 9.1 suggested 23:30 UTC for a single combined job; split
-- into two here since ingest and compute are separate functions).

select cron.schedule(
  'market-conditions-ingest-daily',
  '30 22 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/market-conditions-ingest',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'market-conditions-compute-daily',
  '40 22 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/market-conditions-compute',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
