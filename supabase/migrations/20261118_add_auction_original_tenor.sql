-- Debt-Cycle Metrics Integrity v3, Phase 1b (docs/specs/debt-metrics-integrity-v3.md).
-- Adds a derived original_tenor column to treasury_auction_results so
-- consumers can filter `original_tenor IN ('10Y','30Y')` instead of
-- exact-matching security_term === '10-Year'/'30-Year' (which silently
-- excludes every reopening -- the v3 Phase 0 investigation found 4 real
-- 10Y reopening labels and 5 real 30Y ones, not just the two the spec's
-- own problem table used as examples).
--
-- DDL only -- no backfill UPDATE here. The mapping logic lives in exactly
-- one place, _shared/auctionTenor.ts's mapSecurityTermToTenor(), per the
-- spec's "one shared mapping function" instruction; duplicating that
-- regex logic in SQL here would create a second place for the two to
-- drift apart. Backfilling the column for existing rows happens as a
-- side effect of running the rewritten ingest function's `?full=true`
-- mode (Phase 1e) -- that mode re-fetches and re-upserts the entire
-- 2010+ history anyway, so every row (new and pre-existing) gets
-- original_tenor populated by the same one function, in the same pass.
alter table public.treasury_auction_results
  add column if not exists original_tenor text;

comment on column public.treasury_auction_results.original_tenor is
  'Derived from security_term via _shared/auctionTenor.ts''s mapSecurityTermToTenor() -- the ORIGINAL issuance maturity (e.g. "10Y"), not the remaining maturity a reopening''s security_term string describes. Null for Bills/CMBs and any unrecognized term (never a guessed value). Populated on upsert by ingest-auction-results; backfilled for pre-existing rows by that function''s ?full=true mode.';

create index if not exists treasury_auction_results_original_tenor_idx
  on public.treasury_auction_results (original_tenor);
