-- Bond Lens overlay -- ACM term premium's ongoing daily refresh deferred
-- (docs/specs/bond-lens-decisions.md, 2026-10-01 follow-up entry). The
-- ~10MB NY Fed .xls decodes to ~363MB of heap in the xlsx library
-- regardless of sheet/row filtering -- confirmed locally, not fixable
-- inside the edge function's memory budget. Historical data stays
-- populated via the one-time backfill; FRED and r-star keep their daily
-- jobs (r-star's much smaller file parses fine standalone).
select cron.unschedule('bond-lens-ingest-acm-daily');
