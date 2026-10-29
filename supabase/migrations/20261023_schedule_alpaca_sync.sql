-- Alpaca brokerage integration, Phase 1 -- daily sync schedule. Runs
-- once a day, well after US market close, so the day's fills/activity
-- are fully settled on Alpaca's side before syncing. Weekdays only.
-- verify_jwt=true (edge function default); reuses the bearer token
-- already stored on sync-market-data's own cron job rather than writing
-- a key into this file, same pattern as every other cron migration in
-- this repo.

select cron.schedule('sync-alpaca-account-daily', '45 23 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/sync-alpaca-account', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 60000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));
