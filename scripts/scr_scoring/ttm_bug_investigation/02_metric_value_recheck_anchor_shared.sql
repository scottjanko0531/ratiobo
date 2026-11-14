-- TTM materialization bug investigation, step 1 continued: step 01 found
-- ZERO pe0 mismatches across all 131,863 scr_anchors_asof rows when pe0 is
-- recomputed from revenue's own filing calendar (as the real pipeline
-- evidently does) -- directly contradicting the earlier 16%-67% mismatch
-- rate found by computing each flow metric's pe0 INDEPENDENTLY from its own
-- filing history (scripts/scr_scoring/vm_exploratory/ttm_adhoc_build.sql).
--
-- Root cause confirmed by hand for company_id=005a149c-67e7-418b-b1bf-
-- 8ef354c597f0, as_of_date=2018-03-31: this company's `revenue` metric has
-- NO filed row for any 2017 quarter (latest is period_end=2016-12-31, filed
-- 2017-02-23) even though `net_income` DOES have 2017 quarters through
-- 2017-12-31 (filed 2018-02-22). The real materialized scr_metric_ttm_asof
-- anchors EVERY metric's TTM window to the SAME 4 period_ends that
-- scr_anchors_asof.pe0 defines from revenue -- by design, so that ratios
-- computed across metrics (e.g. gross_margin = gp/revenue) are always over
-- the same accounting periods, never racing ahead independently per metric
-- when one metric's tagging lags another's. This is NOT staleness or a bug;
-- it is the anchor-sharing convention working as intended. My own
-- ttm_adhoc_build.sql was wrong to compute each metric's pe0 independently.
--
-- This script re-validates the ORIGINAL 16%-67%-mismatch sample properly:
-- for net_income/operating_cash_flow/ebitda, use scr_anchors_asof.pe0/
-- span_now directly (not recomputed independently), then look up each of
-- the exact same 4 period_ends (derivable as pe0, and 3 more by matching
-- revenue's own period_end list) in the TARGET metric and sum. If this
-- reproduces scr_metric_ttm_asof exactly, the "bug" is fully explained as a
-- flaw in my own ad-hoc script, not in the materialized tables.

set statement_timeout = '5min';

drop table if exists scr_metric_recheck;
create table scr_metric_recheck (
  company_id uuid, as_of_date date, metric text,
  value_now_stored numeric, value_now_recomputed numeric, mismatch boolean
);
