-- TTM materialization bug investigation, step 1: determine true scope.
-- Recomputes pe0/span_now/max_filed_date_used fresh from scr_fundamentals
-- (metric='revenue', the anchor metric -- scr_anchors_asof's rev_q0/rev_q0_py
-- columns confirm pe0 is anchored to revenue's own quarterly filing
-- calendar, and every other flow metric's TTM window in scr_metric_ttm_asof
-- is looked up against that same pe0) for EVERY row in scr_anchors_asof,
-- using the hand-verified rule: the 4 most recent distinct period_end
-- quarters with filed_date <= as_of_date (taking each quarter's
-- latest-filed value if revised), pe0 = the most recent of those 4,
-- span_now = pe0 - (4th-most-recent period_end), in days.
--
-- Writes one row per scr_anchors_asof row into scr_pe0_recheck with both
-- stored and recomputed values, for a full-population comparison (not a
-- sample) -- this is the true-scope measurement Scott asked for.

set statement_timeout = '8min';

drop table if exists scr_pe0_recheck;
create table scr_pe0_recheck as
with periods as (
  select a.company_id, a.as_of_date, f.period_end, f.filed_date, f.value,
    row_number() over (partition by a.company_id, a.as_of_date, f.period_end order by f.filed_date desc) as rn_rev
  from scr_anchors_asof a
  join scr_fundamentals f on f.company_id = a.company_id and f.metric = 'revenue' and f.filed_date <= a.as_of_date
),
latest_per_period as (
  select company_id, as_of_date, period_end, filed_date, value,
    row_number() over (partition by company_id, as_of_date order by period_end desc) as rn_period
  from periods where rn_rev = 1
),
recomputed as (
  select company_id, as_of_date,
    max(period_end) as pe0_recomputed,
    (max(period_end) - min(period_end)) as span_now_recomputed,
    max(filed_date) filter (where rn_period = 1) as max_filed_recomputed,
    count(*) as n_periods
  from latest_per_period where rn_period <= 4
  group by company_id, as_of_date
)
select
  a.company_id, a.as_of_date,
  a.pe0 as pe0_stored, r.pe0_recomputed, r.n_periods,
  a.span_now as span_now_stored, r.span_now_recomputed,
  a.max_filed_date_used as max_filed_stored, r.max_filed_recomputed,
  (a.pe0 is distinct from r.pe0_recomputed) as pe0_mismatch
from scr_anchors_asof a
left join recomputed r on r.company_id = a.company_id and r.as_of_date = a.as_of_date;

create index on scr_pe0_recheck (as_of_date);
create index on scr_pe0_recheck (company_id);

select count(*) n, count(*) filter (where pe0_mismatch) as n_mismatch,
  round(100.0 * count(*) filter (where pe0_mismatch) / count(*), 1) as pct_mismatch
from scr_pe0_recheck;
