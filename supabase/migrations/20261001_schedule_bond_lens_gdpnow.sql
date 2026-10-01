-- Bond Lens overlay -- Atlanta Fed GDPNow intraquarter nowcast history
-- (docs/specs/bond-lens-decisions.md, 2026-10-01 follow-up entry).
-- FRED's GDPNOW is quarterly-snapshot only; this is the real source for
-- spec §4.2's "8-week change" formula. Daily at 23:20 UTC weekdays,
-- after FRED/rstar in the same offset-from-Market-Conditions window.
select cron.schedule('bond-lens-ingest-gdpnow-daily', '20 23 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/bond-lens-ingest?source=gdpnow', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 60000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));
