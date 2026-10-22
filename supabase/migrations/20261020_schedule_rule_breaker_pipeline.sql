-- Rule Breaker Screener, Phase 3 -- daily pipeline schedule. rb-refresh
-- runs in 4 slices (~40 symbols each of the ~155 active rb_companies)
-- a couple minutes apart, same reason bond-lens-ingest splits into
-- three staggered `?source=` invocations: ~2 symbols/sec x 4 Yahoo
-- calls/symbol makes one invocation covering all symbols run past a
-- single edge-function's wall-clock budget. Starts 21:15 UTC, after the
-- artifact's own 20:45 refresh (Scott's spec) so both land on the same
-- day's closing print. rb-compute runs once at 21:30, after every slice
-- has had ~9 minutes of margin to land -- it confirms all slices
-- actually finished (via rb_job_runs) before scoring anything, so a late
-- or failed slice makes it skip rather than mix today's and yesterday's
-- data. Weekdays only (no new trading data on weekends).
--
-- The bearer token is read from Supabase Vault at call time, not typed
-- into this file: `rb_pipeline_bearer_token` was created once via
--   select vault.create_secret(<token>, 'rb_pipeline_bearer_token', ...);
-- (the same token every other cron migration in this repo borrows via a
-- regex over an existing job's command text -- stored properly here
-- instead of repeating that pattern for a new pipeline).

select cron.schedule('rb-refresh-slice-0-daily', '15 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=0&limit=40', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'rb_pipeline_bearer_token')));

select cron.schedule('rb-refresh-slice-1-daily', '17 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=40&limit=40', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'rb_pipeline_bearer_token')));

select cron.schedule('rb-refresh-slice-2-daily', '19 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=80&limit=40', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'rb_pipeline_bearer_token')));

select cron.schedule('rb-refresh-slice-3-daily', '21 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-refresh?offset=120&limit=40', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 90000); $f$,
         'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'rb_pipeline_bearer_token')));

select cron.schedule('rb-compute-daily', '30 21 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/rb-compute', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 60000); $f$,
         'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'rb_pipeline_bearer_token')));
