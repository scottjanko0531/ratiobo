-- Bond Lens overlay (docs/specs/bond-lens.md v2.1) -- daily raw-series
-- ingestion schedule. Offset from Market Conditions' 22:30/22:40 UTC jobs
-- (bond-lens-decisions.md's infrastructure decision), weekdays only (FRED/
-- NY Fed don't publish new values on weekends). Three separate times for
-- the three sources (fred/acm/rstar) -- bond-lens-ingest hits
-- WORKER_RESOURCE_LIMIT running them together in one invocation (ACM's
-- ~10MB XLS parse is the big one), same reason market-conditions-
-- crossmarket calls per-symbol instead of all at once.
--
-- bond-lens-ingest has verify_jwt=true (edge function default on this
-- project unless explicitly turned off at deploy time); reuses the
-- Authorization header already stored on sync-market-data's own cron job
-- rather than writing a key into this file, same pattern as
-- compute-capex-cycle's schedule (20260926_ai_capex_cycle_overlay.sql).

select cron.schedule('bond-lens-ingest-fred-daily', '50 22 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/bond-lens-ingest?source=fred', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 60000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));

select cron.schedule('bond-lens-ingest-acm-daily', '0 23 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/bond-lens-ingest?source=acm', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 60000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));

select cron.schedule('bond-lens-ingest-rstar-daily', '10 23 * * 1-5',
  format($f$ SELECT net.http_post(url := 'https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/bond-lens-ingest?source=rstar', headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb, timeout_milliseconds := 60000); $f$,
         (select substring(command from 'Bearer [A-Za-z0-9._-]+') from cron.job where jobname = 'sync-market-data-every-15-min')));
