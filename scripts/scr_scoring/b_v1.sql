-- Phase 3 historical scoring pipeline: profile_version = 'b_v1'.
-- Point-in-time Profile B rescoring from scr_fundamentals /
-- scr_adjusted_prices / scr_universe_membership (strategy='profile_b').
-- Committed retroactively per the 2026-11-10 reproducibility audit -- this
-- is the exact query used for every b_v1 backfill/rescore run in this
-- session, previously run ad-hoc via the Supabase SQL tool with no
-- committed source. Run in __START__/__END__ year-sized batches
-- (string-substitute the literal placeholders before executing).
--
-- 7 equal-weighted percentile factors: FCF yield, size (inverted), P/B
-- (inverted), trailing P/E (inverted), distance above the 12-month low
-- (inverted), growth discipline (TTM asset growth minus TTM earnings
-- growth, inverted -- earnings growth prefers ebitda TTM-over-TTM,
-- falling back to operating_income when ebitda is unavailable for either
-- period), profitability (avg of gp/assets and TTM operating-margin
-- change). See scr_trials (id=1) for full factor rationale and deviations.
insert into scr_scores (company_id, as_of_date, profile_version, factor_fcf_yield, factor_size, factor_price_book, factor_trailing_pe, factor_drawdown_recovery, factor_growth_discipline, factor_profitability, b_composite, score, missing_inputs, raw_inputs, needs_review)
with peers as (
  select company_id, as_of_date, market_cap, price, shares_outstanding, needs_review
  from scr_universe_membership where strategy='profile_b' and as_of_date >= '__START__' and as_of_date <= '__END__'
),
anchors as (
  select pk.company_id, pk.as_of_date,
    (select f.period_end from scr_fundamentals f where f.company_id=pk.company_id and f.metric='revenue' and f.filed_date<=pk.as_of_date order by f.period_end desc, f.filed_date desc limit 1) as pe0
  from peers pk
),
anchors2 as (
  select a.company_id, a.as_of_date, a.pe0,
    (select f.period_end from scr_fundamentals f where f.company_id=a.company_id and f.metric='revenue' and f.filed_date<=a.as_of_date and f.period_end <= a.pe0 - interval '320 days' order by f.period_end desc, f.filed_date desc limit 1) as pe0_prior
  from anchors a where a.pe0 is not null
),
ttm_sums as (
  select a.company_id, a.as_of_date, a.pe0, a.pe0_prior,
    (select max(pe)-min(pe) from (select distinct period_end as pe from scr_fundamentals f where f.company_id=a.company_id and f.metric='revenue' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by pe desc limit 4) x) as span_now,
    (select max(pe)-min(pe) from (select distinct period_end as pe from scr_fundamentals f where f.company_id=a.company_id and f.metric='revenue' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0_prior order by pe desc limit 4) x) as span_prior,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='operating_cash_flow' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='operating_cash_flow' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_ocf,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='capex' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='capex' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_capex,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='net_income' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='net_income' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_ni,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='ebitda' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='ebitda' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_ebitda,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='operating_income' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='operating_income' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_oi,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='revenue' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='revenue' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_rev,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='gross_profit' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='gross_profit' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_gp
  from anchors2 a
),
ttm_prior as (
  select t.*,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=t.company_id and f2.metric='ebitda' and f2.period_end=f.period_end and f2.filed_date<=t.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=t.company_id and f.metric='ebitda' and f.filed_date<=t.as_of_date and f.period_end<=t.pe0_prior order by f.period_end desc limit 4) f) as ttm_ebitda_prior,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=t.company_id and f2.metric='operating_income' and f2.period_end=f.period_end and f2.filed_date<=t.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=t.company_id and f.metric='operating_income' and f.filed_date<=t.as_of_date and f.period_end<=t.pe0_prior order by f.period_end desc limit 4) f) as ttm_oi_prior,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=t.company_id and f2.metric='revenue' and f2.period_end=f.period_end and f2.filed_date<=t.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=t.company_id and f.metric='revenue' and f.filed_date<=t.as_of_date and f.period_end<=t.pe0_prior order by f.period_end desc limit 4) f) as ttm_rev_prior,
    (select sum(v) from (select distinct f.period_end, (select f2.value from scr_fundamentals f2 where f2.company_id=t.company_id and f2.metric='gross_profit' and f2.period_end=f.period_end and f2.filed_date<=t.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=t.company_id and f.metric='gross_profit' and f.filed_date<=t.as_of_date and f.period_end<=t.pe0_prior order by f.period_end desc limit 4) f) as ttm_gp_prior
  from ttm_sums t where t.pe0_prior is not null
),
assets as (
  select a.company_id, a.as_of_date,
    (select f.value from scr_fundamentals f where f.company_id=a.company_id and f.metric='total_assets' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc, f.filed_date desc limit 1) as assets_now,
    (select f.value from scr_fundamentals f where f.company_id=a.company_id and f.metric='total_assets' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0_prior order by f.period_end desc, f.filed_date desc limit 1) as assets_prior
  from anchors2 a
),
balance as (
  select pk.company_id, pk.as_of_date,
    (select f.value from scr_fundamentals f where f.company_id=pk.company_id and f.metric='total_debt' and f.filed_date<=pk.as_of_date order by f.period_end desc, f.filed_date desc limit 1) as debt,
    (select f.value from scr_fundamentals f where f.company_id=pk.company_id and f.metric='cash_and_equivalents' and f.filed_date<=pk.as_of_date order by f.period_end desc, f.filed_date desc limit 1) as cash,
    (select f.value from scr_fundamentals f where f.company_id=pk.company_id and f.metric='stockholders_equity' and f.filed_date<=pk.as_of_date order by f.period_end desc, f.filed_date desc limit 1) as equity
  from peers pk
),
price_window as (
  select pk.company_id, pk.as_of_date,
    cur.adj_close as price_now,
    (select min(ap.adj_close) from scr_adjusted_prices ap where ap.company_id=pk.company_id and ap.date between pk.as_of_date - interval '12 months' and pk.as_of_date) as low_12m
  from peers pk
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=pk.company_id and ap.date<=pk.as_of_date order by ap.date desc limit 1) cur on true
),
raw as (
  select pk.company_id, pk.as_of_date, pk.needs_review,
    case when tp.ttm_ocf is not null and tp.ttm_capex is not null and pk.market_cap is not null and bal.debt is not null and bal.cash is not null and (pk.market_cap+bal.debt-bal.cash)<>0
      then (tp.ttm_ocf - tp.ttm_capex) / (pk.market_cap + bal.debt - bal.cash) end as fcf_yield,
    pk.market_cap as size_raw,
    case when bal.equity is not null and bal.equity>0 then pk.market_cap/bal.equity end as price_book,
    case when tp.ttm_ni is not null and tp.ttm_ni>0 then pk.market_cap/tp.ttm_ni end as trailing_pe,
    case when pw.low_12m is not null and pw.low_12m<>0 and pw.price_now is not null then pw.price_now/pw.low_12m - 1 end as drawdown_dist,
    case when asx.assets_now is not null and asx.assets_prior is not null and asx.assets_prior<>0 then asx.assets_now/asx.assets_prior - 1 end as asset_growth,
    case when tp.ttm_ebitda is not null and tp.ttm_ebitda_prior is not null and tp.ttm_ebitda_prior<>0 and tp.span_now between 250 and 300 and tp.span_prior between 250 and 300
      then tp.ttm_ebitda/tp.ttm_ebitda_prior - 1
      when tp.ttm_oi is not null and tp.ttm_oi_prior is not null and tp.ttm_oi_prior<>0 and tp.span_now between 250 and 300 and tp.span_prior between 250 and 300
      then tp.ttm_oi/tp.ttm_oi_prior - 1
    end as earnings_growth,
    case when tp.ttm_ebitda is not null and tp.ttm_ebitda_prior is not null and tp.ttm_ebitda_prior<>0 and tp.span_now between 250 and 300 and tp.span_prior between 250 and 300 then 'ebitda'
      when tp.ttm_oi is not null and tp.ttm_oi_prior is not null and tp.ttm_oi_prior<>0 and tp.span_now between 250 and 300 and tp.span_prior between 250 and 300 then 'operating_income'
    end as earnings_basis,
    case when asx.assets_now is not null and asx.assets_now<>0 and tp.ttm_gp is not null then tp.ttm_gp/asx.assets_now end as gp_over_assets,
    case when tp.ttm_oi is not null and tp.ttm_rev is not null and tp.ttm_rev<>0 and tp.ttm_oi_prior is not null and tp.ttm_rev_prior is not null and tp.ttm_rev_prior<>0 and tp.span_now between 250 and 300 and tp.span_prior between 250 and 300
      then tp.ttm_oi/tp.ttm_rev - tp.ttm_oi_prior/tp.ttm_rev_prior end as op_margin_trend
  from peers pk
  left join ttm_prior tp on tp.company_id=pk.company_id and tp.as_of_date=pk.as_of_date
  left join assets asx on asx.company_id=pk.company_id and asx.as_of_date=pk.as_of_date
  left join balance bal on bal.company_id=pk.company_id and bal.as_of_date=pk.as_of_date
  left join price_window pw on pw.company_id=pk.company_id and pw.as_of_date=pk.as_of_date
),
pcts as (
  select *,
    case when fcf_yield is not null then (2*rank() over (partition by as_of_date, (fcf_yield is not null) order by fcf_yield) + count(*) over (partition by as_of_date, fcf_yield) - 3) / (2.0*(count(*) over (partition by as_of_date, (fcf_yield is not null)) - 1)) * 100 end as p_fcf,
    case when size_raw is not null then 100 - ((2*rank() over (partition by as_of_date, (size_raw is not null) order by size_raw) + count(*) over (partition by as_of_date, size_raw) - 3) / (2.0*(count(*) over (partition by as_of_date, (size_raw is not null)) - 1)) * 100) end as p_size,
    case when price_book is not null then 100 - ((2*rank() over (partition by as_of_date, (price_book is not null) order by price_book) + count(*) over (partition by as_of_date, price_book) - 3) / (2.0*(count(*) over (partition by as_of_date, (price_book is not null)) - 1)) * 100) end as p_pb,
    case when trailing_pe is not null then 100 - ((2*rank() over (partition by as_of_date, (trailing_pe is not null) order by trailing_pe) + count(*) over (partition by as_of_date, trailing_pe) - 3) / (2.0*(count(*) over (partition by as_of_date, (trailing_pe is not null)) - 1)) * 100) end as p_pe,
    case when drawdown_dist is not null then 100 - ((2*rank() over (partition by as_of_date, (drawdown_dist is not null) order by drawdown_dist) + count(*) over (partition by as_of_date, drawdown_dist) - 3) / (2.0*(count(*) over (partition by as_of_date, (drawdown_dist is not null)) - 1)) * 100) end as p_dd,
    case when gp_over_assets is not null then (2*rank() over (partition by as_of_date, (gp_over_assets is not null) order by gp_over_assets) + count(*) over (partition by as_of_date, gp_over_assets) - 3) / (2.0*(count(*) over (partition by as_of_date, (gp_over_assets is not null)) - 1)) * 100 end as p_gpa,
    case when op_margin_trend is not null then (2*rank() over (partition by as_of_date, (op_margin_trend is not null) order by op_margin_trend) + count(*) over (partition by as_of_date, op_margin_trend) - 3) / (2.0*(count(*) over (partition by as_of_date, (op_margin_trend is not null)) - 1)) * 100 end as p_omt,
    case when asset_growth is not null and earnings_growth is not null then asset_growth - earnings_growth end as growth_disc_raw
  from raw
),
pcts2 as (
  select *,
    case when growth_disc_raw is not null then 100 - ((2*rank() over (partition by as_of_date, (growth_disc_raw is not null) order by growth_disc_raw) + count(*) over (partition by as_of_date, growth_disc_raw) - 3) / (2.0*(count(*) over (partition by as_of_date, (growth_disc_raw is not null)) - 1)) * 100) end as p_gd
  from pcts
),
factors as (
  select *,
    (select round(avg(v),2) from (values (p_gpa),(p_omt)) t(v) where v is not null) as factor_profitability_val
  from pcts2
),
composite_calc as (
  select *,
    (select avg(v) from (values (p_fcf),(p_size),(p_pb),(p_pe),(p_dd),(p_gd),(factor_profitability_val)) t(v) where v is not null) as b_composite_val
  from factors
),
scored as (
  select *,
    case when b_composite_val is not null then
      round((2*rank() over (partition by as_of_date, (b_composite_val is not null) order by b_composite_val) + count(*) over (partition by as_of_date, b_composite_val) - 3)
        / (2.0*(count(*) over (partition by as_of_date, (b_composite_val is not null)) - 1)) * 100)
    end as score_val
  from composite_calc
)
select
  company_id, as_of_date, 'b_v1',
  round(p_fcf,2), round(p_size,2), round(p_pb,2), round(p_pe,2), round(p_dd,2), round(p_gd,2), factor_profitability_val,
  b_composite_val, score_val,
  array_remove(array[
    case when fcf_yield is null then 'fcf_yield' end,
    case when size_raw is null then 'size' end,
    case when price_book is null then 'price_book' end,
    case when trailing_pe is null then 'trailing_pe' end,
    case when drawdown_dist is null then 'drawdown_recovery' end,
    case when growth_disc_raw is null then 'growth_discipline' end,
    case when factor_profitability_val is null then 'profitability' end,
    case when earnings_basis is null and growth_disc_raw is not null then null when earnings_basis='operating_income' then 'growth_discipline_used_operating_income_not_ebitda' end
  ], null),
  jsonb_build_object(
    'fcf_yield', fcf_yield, 'size_market_cap', size_raw, 'price_book', price_book, 'trailing_pe', trailing_pe,
    'drawdown_dist', drawdown_dist, 'asset_growth', asset_growth, 'earnings_growth', earnings_growth, 'earnings_basis', earnings_basis,
    'gp_over_assets', gp_over_assets, 'op_margin_trend', op_margin_trend
  ),
  needs_review
from scored
on conflict (company_id, as_of_date, profile_version) do nothing;
