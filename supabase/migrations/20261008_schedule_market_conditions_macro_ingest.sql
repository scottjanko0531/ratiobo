-- Market Conditions Overlay — "Macro context" layer nightly schedule.
-- Same pg_cron + net.http_post pattern as 20260928_schedule_market_conditions.sql
-- (no Authorization header -- the function is deployed with verify_jwt=false,
-- confirmed by invoking it with no auth header and getting HTTP 200, matching
-- how net.http_post calls every other scheduled job in this repo).
--
-- Scheduled 5 minutes after market-conditions-ingest (22:30 UTC) so the two
-- don't contend for the same FRED/Yahoo rate limits at the exact same
-- second; this job is entirely independent of (and does not block) the
-- 22:40 UTC market-conditions-compute run -- it only writes to
-- mc_series_daily rows that compute never reads (display-only, not scored).
--
-- Idempotent: confirmed by invoking market-conditions-macro-ingest twice in
-- a row and checking mc_series_daily's row count for these 13 series was
-- identical before and after (74,996 both times) -- same upsert-by-primary-
-- key (series_id, date) design as every other ingest function here.

select cron.schedule(
  'market-conditions-macro-ingest-daily',
  '35 22 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/market-conditions-macro-ingest',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
