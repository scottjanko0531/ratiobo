-- Ad-hoc TTM/point-value computation for the ~102k broad_liquid company-months
-- that fall OUTSIDE the existing a_growth/profile_b materialized coverage in
-- scr_metric_ttm_asof / scr_anchors_asof (those tables were only ever built
-- for those two universes). Scott's decision: compute these ad-hoc from
-- scr_fundamentals for THIS exploratory run only, rather than extending the
-- materialized pipeline (too costly -- same risk class as the session's
-- original Disk I/O crisis).
--
-- Methodology reverse-engineered from scr_metric_ttm_asof/scr_anchors_asof's
-- actual stored values (no build script for those tables exists in the repo
-- -- confirmed by grep; they were materialized via ad-hoc SQL like scr_scores
-- originally was). Verified exactly against company_id=00525f8d-df46-4efc-
-- 8a1c-ec9d1e7c2eec, as_of_date=2022-06-30, metric=net_income: stored
-- value_now=419326000 reproduced exactly as the sum of the 4 most recent
-- distinct period_end quarters (each quarter's value taken from the row with
-- the latest filed_date <= as_of_date for that period_end), with pe0 =
-- 2022-02-28, span_now = pe0 - (4th-most-recent period_end) = 273 days
-- (matching stored span_now=273), max_filed_date_used = that latest quarter's
-- own filed_date (2022-04-04, matching exactly). Point-value metrics
-- (stockholders_equity/total_debt/cash_and_equivalents) verified the same way
-- against total_debt=574625000: the SINGLE most recent period's value, no
-- summing, no span guard -- confirmed against scr_fundamentals directly.
--
-- Flow metrics (TTM, span-guarded 250-300 days): net_income, operating_cash_flow, ebitda
-- Point metrics (latest value, no span guard): stockholders_equity, total_debt, cash_and_equivalents
--
-- *** NOT VALIDATED -- DO NOT USE AS-IS. ***
-- Equivalence check against scr_metric_ttm_asof on a sample of COVERED
-- company-months (same logic, re-run on rows that already have materialized
-- values) found a pervasive mismatch rate of 16%-67% depending on as_of_date
-- (2018-03-31 worst, 2024-01-31 best), not an isolated artifact. Root cause
-- for one concrete example: company_id=005a149c-67e7-418b-b1bf-8ef354c597f0,
-- as_of_date=2018-03-31, metric=net_income -- this script's logic correctly
-- picks pe0=2017-12-31 (filed 2018-02-22, the actual latest quarter filed
-- before the as-of date) and sums to 109,658,000; the STORED
-- scr_anchors_asof row for this exact company/date has pe0=2016-12-31 (filed
-- 2017-02-23) -- a full year older -- giving scr_metric_ttm_asof's stored
-- net_income value_now=37,172,000. The stored materialized table is using a
-- stale/wrong "most recent quarter" for a meaningful fraction of rows, not
-- just this one. This may be a live instance of (or related to) the
-- "exact-vs-nearest-period matching bug" / "out-of-order-filing pe0_prior
-- bug" mentioned in scripts/scr_scoring/phase4a_tests/round2_provenance_check.md
-- as already found-and-fixed -- but the fix evidently wasn't applied by
-- correcting these tables' stored rows for every company/date, or this case
-- predates/escaped it. No build script for scr_anchors_asof/scr_metric_ttm_asof
-- exists anywhere in the repo to check against (confirmed via repo-wide grep).
-- Stopped here rather than guess further -- reported to Scott as a genuine
-- blocker. This script's OWN logic is internally consistent and was hand-
-- verified against raw scr_fundamentals for the one clean example in the
-- comment below; the problem is that it does not reproduce whatever the
-- original (undocumented) materialization actually did for every row, so it
-- cannot be trusted to be "the same methodology" as asked.

set statement_timeout = '8min';

drop table if exists scr_vm_ttm_adhoc;
create table scr_vm_ttm_adhoc (
  company_id uuid, as_of_date date, metric text,
  value_now numeric, pe0 date, span_now integer, max_filed_date_used date
);

with uncovered as (
  select um.company_id, um.as_of_date
  from scr_universe_membership um
  left join scr_anchors_asof a on a.company_id = um.company_id and a.as_of_date = um.as_of_date
  where um.strategy = 'broad_liquid' and a.company_id is null
),
flow_metrics as (select unnest(array['net_income','operating_cash_flow','ebitda']) as metric),
flow_periods as (
  select u.company_id, u.as_of_date, fm.metric, f.period_end, f.filed_date, f.value,
    row_number() over (partition by u.company_id, u.as_of_date, fm.metric, f.period_end order by f.filed_date desc) as rn_rev
  from uncovered u
  cross join flow_metrics fm
  join scr_fundamentals f on f.company_id = u.company_id and f.metric = fm.metric and f.filed_date <= u.as_of_date
),
flow_latest as (
  select company_id, as_of_date, metric, period_end, filed_date, value,
    row_number() over (partition by company_id, as_of_date, metric order by period_end desc) as rn_period
  from flow_periods where rn_rev = 1
),
flow_agg as (
  select company_id, as_of_date, metric,
    sum(value) as value_now,
    max(period_end) as pe0,
    max(filed_date) filter (where rn_period = 1) as max_filed_date_used,
    (max(period_end) - min(period_end)) as span_now,
    count(*) as n_periods
  from flow_latest where rn_period <= 4
  group by company_id, as_of_date, metric
)
insert into scr_vm_ttm_adhoc (company_id, as_of_date, metric, value_now, pe0, span_now, max_filed_date_used)
select company_id, as_of_date, metric,
  case when n_periods = 4 and span_now between 250 and 300 then value_now end,
  case when n_periods = 4 and span_now between 250 and 300 then pe0 end,
  case when n_periods = 4 and span_now between 250 and 300 then span_now end,
  case when n_periods = 4 and span_now between 250 and 300 then max_filed_date_used end
from flow_agg;

with uncovered as (
  select um.company_id, um.as_of_date
  from scr_universe_membership um
  left join scr_anchors_asof a on a.company_id = um.company_id and a.as_of_date = um.as_of_date
  where um.strategy = 'broad_liquid' and a.company_id is null
),
point_metrics as (select unnest(array['stockholders_equity','total_debt','cash_and_equivalents']) as metric),
point_rows as (
  select u.company_id, u.as_of_date, pm.metric, f.period_end, f.filed_date, f.value,
    row_number() over (partition by u.company_id, u.as_of_date, pm.metric order by f.period_end desc, f.filed_date desc) as rn
  from uncovered u
  cross join point_metrics pm
  join scr_fundamentals f on f.company_id = u.company_id and f.metric = pm.metric and f.filed_date <= u.as_of_date
)
insert into scr_vm_ttm_adhoc (company_id, as_of_date, metric, value_now, pe0, span_now, max_filed_date_used)
select company_id, as_of_date, metric, value, period_end, null, filed_date
from point_rows where rn = 1;

create index on scr_vm_ttm_adhoc (company_id, as_of_date, metric);

select metric, count(*) n, count(value_now) n_present
from scr_vm_ttm_adhoc group by metric order by metric;
