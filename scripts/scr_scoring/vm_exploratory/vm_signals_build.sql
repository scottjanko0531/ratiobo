-- Exploratory value+momentum test (AQR "Value and Momentum Everywhere" style).
-- Builds four profile_versions in scr_scores, scored over the broad_liquid
-- universe (2017-01..2026-09): vm_value (V), vm_momentum (M), vm_combo (VM),
-- vm_combo_ind (VM-ind). EXPLORATORY -- holdout is already spent; no result
-- here is a validation test.
--
-- Value composite = avg of percentile ranks (within the universe that date,
-- ascending -- a higher ratio is cheaper and gets a higher percentile,
-- satisfying "negative values rank lowest" automatically since a negative
-- ratio sorts below all positive ones) of:
--   book/price      = stockholders_equity.value_now / market_cap
--   earnings yield   = net_income.value_now / market_cap
--   cash-flow yield  = operating_cash_flow.value_now / market_cap
--   EBITDA/EV        = ebitda.value_now / (market_cap + total_debt.value_now
--                       - cash_and_equivalents.value_now)
-- net_income/operating_cash_flow/ebitda are TTM flows from
-- scr_metric_ttm_asof, guarded by the same span_now 250-300 day check used
-- everywhere else in this codebase for a TTM flow level (via scr_anchors_asof).
-- stockholders_equity/total_debt/cash_and_equivalents are balance-sheet point
-- values (value_now), no span guard -- same convention as a_v2_discipline's
-- total_assets treatment. EV<=0 makes EBITDA/EV undefined -- treated as a
-- missing component for that company-month. Requires >=2 of 4 components
-- present, else no value score that month.
--
-- Momentum = total return from t-12 months to t-1 month (12-1, standard
-- momentum skip-month convention), using the nearest trading price on or
-- before each target date (scr_adjusted_prices.adj_close, same
-- nearest-prior-close convention used by the universe builder and Phase 4c's
-- forward-return work). Percentile ranked ascending (higher return = cheaper^H
-- higher percentile).
--
-- Combo = 50/50 average of the value percentile and momentum percentile
-- (both already 0-100 scale, so no re-percentiling of the average itself).
-- VM-ind ranks the VALUE half within Fama-French 12 industry (ff12_of_sic on
-- scr_securities.sic_code), falling back to the full universe for any
-- industry with fewer than 8 peers that month; momentum stays universe-wide.
--
-- Percentile formula: the same midpoint-rank formula used throughout this
-- codebase (a_v1_hist_ff12.sql, a_v2_discipline.sql, etc.):
--   (2*rank() + count(ties) - 3) / (2*(n-1)) * 100
--
-- Run once for the full range, in one committed script -- no chunking
-- needed here since this is a single INSERT ... SELECT per profile, not a
-- per-row procedural loop like the universe builder.

set statement_timeout = '10min';

-- Step 1: raw value components, point-in-time. A real (not temp) table,
-- since each statement below runs as its own connection via the MCP tool --
-- a temp table wouldn't survive between them.
drop table if exists scr_vm_raw_value;
create table scr_vm_raw_value as
with u as (
  select um.company_id, um.as_of_date, um.market_cap, um.needs_review,
         ff12_of_sic(sc.sic_code) as ff12
  from scr_universe_membership um
  join scr_securities sc on sc.id = um.company_id
  where um.strategy = 'broad_liquid'
),
anc as (
  select u.company_id, u.as_of_date, a.span_now
  from u
  left join scr_anchors_asof a on a.company_id = u.company_id and a.as_of_date = u.as_of_date
),
flows as (
  select u.company_id, u.as_of_date,
    case when anc.span_now between 250 and 300 then ni.value_now end as net_income,
    case when anc.span_now between 250 and 300 then ocf.value_now end as ocf,
    case when anc.span_now between 250 and 300 then eb.value_now end as ebitda
  from u
  join anc on anc.company_id = u.company_id and anc.as_of_date = u.as_of_date
  left join scr_metric_ttm_asof ni  on ni.company_id = u.company_id and ni.as_of_date = u.as_of_date and ni.metric = 'net_income'
  left join scr_metric_ttm_asof ocf on ocf.company_id = u.company_id and ocf.as_of_date = u.as_of_date and ocf.metric = 'operating_cash_flow'
  left join scr_metric_ttm_asof eb  on eb.company_id = u.company_id and eb.as_of_date = u.as_of_date and eb.metric = 'ebitda'
),
pointvals as (
  select u.company_id, u.as_of_date,
    se.value_now as stockholders_equity,
    td.value_now as total_debt,
    cash.value_now as cash_and_equivalents
  from u
  left join scr_metric_ttm_asof se   on se.company_id = u.company_id and se.as_of_date = u.as_of_date and se.metric = 'stockholders_equity'
  left join scr_metric_ttm_asof td   on td.company_id = u.company_id and td.as_of_date = u.as_of_date and td.metric = 'total_debt'
  left join scr_metric_ttm_asof cash on cash.company_id = u.company_id and cash.as_of_date = u.as_of_date and cash.metric = 'cash_and_equivalents'
)
select
  u.company_id, u.as_of_date, u.market_cap, u.needs_review, u.ff12,
  case when p.stockholders_equity is not null and u.market_cap > 0
    then p.stockholders_equity / u.market_cap end as book_price,
  case when f.net_income is not null and u.market_cap > 0
    then f.net_income / u.market_cap end as earnings_yield,
  case when f.ocf is not null and u.market_cap > 0
    then f.ocf / u.market_cap end as cf_yield,
  case when f.ebitda is not null and p.total_debt is not null and p.cash_and_equivalents is not null
         and (u.market_cap + p.total_debt - p.cash_and_equivalents) > 0
    then f.ebitda / (u.market_cap + p.total_debt - p.cash_and_equivalents) end as ebitda_ev
from u
join flows f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
join pointvals p on p.company_id = u.company_id and p.as_of_date = u.as_of_date;

create index on scr_vm_raw_value (as_of_date);
create index on scr_vm_raw_value (company_id, as_of_date);

select as_of_date, count(*) n,
  count(book_price) n_bp, count(earnings_yield) n_ey, count(cf_yield) n_cf, count(ebitda_ev) n_ee
from scr_vm_raw_value group by 1 order by 1 limit 5;
