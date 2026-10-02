-- Bond Lens overlay -- bond-lens-compute had NO recurring schedule at
-- all (discovered during the 2026-10-02 follow-up's §7 staleness check:
-- every ingest job was scheduled, but nothing ever re-ran the per-day
-- walk through §4's modules, so bond_signals would silently go stale
-- even with fresh inputs). Daily at 23:40 UTC weekdays, after the three
-- ingest jobs (22:50/23:10/23:20) have had time to finish.
select cron.schedule('bond-lens-compute-daily', '40 23 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/bond-lens-compute', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 60000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));
