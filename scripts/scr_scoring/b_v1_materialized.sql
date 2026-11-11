-- Phase 3/4a materialized-pipeline rewrite of profile_version = 'b_v1'.
-- Reads point-in-time TTM/point values from the pre-materialized
-- scr_anchors_asof / scr_metric_ttm_asof tables instead of recomputing
-- per-row correlated subqueries against scr_fundamentals directly. Pure
-- performance/architecture change: every formula below is byte-for-byte
-- identical to b_v1.sql (commit e001bb3), INCLUDING the quirk that
-- fcf_yield, trailing_pe, earnings_growth/earnings_basis, gp_over_assets,
-- and op_margin_trend are ALL null whenever pe0_prior is null (they all
-- flow through the ttm_prior CTE in the original, which drops the row
-- entirely when pe0_prior is null, even for metrics like fcf_yield/
-- trailing_pe that don't conceptually need a prior period). That quirk is
-- replicated via the explicit `pe0_prior is not null` guard on
-- ttm_ocf/ttm_capex/ttm_ni/ttm_ebitda/ttm_oi/ttm_rev/ttm_gp/span_now/
-- span_prior below. asset_growth/gp_over_assets's assets0 term and
-- price_book/drawdown_dist are NOT subject to this gate in the original
-- (assets CTE and balance/price_window CTEs are independent of ttm_prior),
-- so they are left ungated here too.
insert into scr_scores (company_id, as_of_date, profile_version, factor_fcf_yield, factor_size, factor_price_book, factor_trailing_pe, factor_drawdown_recovery, factor_growth_discipline, factor_profitability, b_composite, score, missing_inputs, raw_inputs, needs_review)
with peers as (
  select company_id, as_of_date, market_cap, price, shares_outstanding, needs_review
  from scr_universe_membership where strategy='profile_b' and as_of_date >= :start_date and as_of_date <= :end_date
),
anc as (
  select pk.company_id, pk.as_of_date, a.pe0, a.pe0_prior, a.span_now, a.span_prior
  from peers pk
  left join scr_anchors_asof a on a.company_id=pk.company_id and a.as_of_date=pk.as_of_date
),
ttm_prior as (
  select anc.company_id, anc.as_of_date,
    case when anc.pe0_prior is not null then anc.span_now end as span_now,
    case when anc.pe0_prior is not null then anc.span_prior end as span_prior,
    case when anc.pe0_prior is not null then ocf.value_now end as ttm_ocf,
    case when anc.pe0_prior is not null then cx.value_now end as ttm_capex,
    case when anc.pe0_prior is not null then ni.value_now end as ttm_ni,
    case when anc.pe0_prior is not null then eb.value_now end as ttm_ebitda,
    case when anc.pe0_prior is not null then oi.value_now end as ttm_oi,
    case when anc.pe0_prior is not null then rev.value_now end as ttm_rev,
    case when anc.pe0_prior is not null then gp.value_now end as ttm_gp,
    case when anc.pe0_prior is not null then eb.value_prior end as ttm_ebitda_prior,
    case when anc.pe0_prior is not null then oi.value_prior end as ttm_oi_prior,
    case when anc.pe0_prior is not null then rev.value_prior end as ttm_rev_prior,
    case when anc.pe0_prior is not null then gp.value_prior end as ttm_gp_prior
  from anc
  left join scr_metric_ttm_asof ocf on ocf.company_id=anc.company_id and ocf.as_of_date=anc.as_of_date and ocf.metric='operating_cash_flow'
  left join scr_metric_ttm_asof cx on cx.company_id=anc.company_id and cx.as_of_date=anc.as_of_date and cx.metric='capex'
  left join scr_metric_ttm_asof ni on ni.company_id=anc.company_id and ni.as_of_date=anc.as_of_date and ni.metric='net_income'
  left join scr_metric_ttm_asof eb on eb.company_id=anc.company_id and eb.as_of_date=anc.as_of_date and eb.metric='ebitda'
  left join scr_metric_ttm_asof oi on oi.company_id=anc.company_id and oi.as_of_date=anc.as_of_date and oi.metric='operating_income'
  left join scr_metric_ttm_asof rev on rev.company_id=anc.company_id and rev.as_of_date=anc.as_of_date and rev.metric='revenue'
  left join scr_metric_ttm_asof gp on gp.company_id=anc.company_id and gp.as_of_date=anc.as_of_date and gp.metric='gross_profit'
),
assets as (
  select anc.company_id, anc.as_of_date, ta.value_now as assets_now, ta.value_prior as assets_prior
  from anc
  left join scr_metric_ttm_asof ta on ta.company_id=anc.company_id and ta.as_of_date=anc.as_of_date and ta.metric='total_assets'
),
balance as (
  select pk.company_id, pk.as_of_date, db.value_now as debt, ca.value_now as cash, eq.value_now as equity
  from peers pk
  left join scr_metric_ttm_asof db on db.company_id=pk.company_id and db.as_of_date=pk.as_of_date and db.metric='total_debt'
  left join scr_metric_ttm_asof ca on ca.company_id=pk.company_id and ca.as_of_date=pk.as_of_date and ca.metric='cash_and_equivalents'
  left join scr_metric_ttm_asof eq on eq.company_id=pk.company_id and eq.as_of_date=pk.as_of_date and eq.metric='stockholders_equity'
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
