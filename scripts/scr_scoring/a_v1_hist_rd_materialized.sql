-- Phase 3/4a materialized-pipeline rewrite of profile_version = 'a_v1_hist_rd'.
-- Identical to a_v1_hist_materialized.sql in this same directory, EXCEPT
-- Sign 2 adds the 4th rd_over_gp driver (R&D / TTM gross profit), matching
-- a_v1_hist_rd.sql (commit e001bb3) exactly -- including that rd_over_gp
-- flows through the same ttm_prior pass-through as gross_margin, so it is
-- ALSO null whenever pe0_prior is null, even though rd_over_gp itself has
-- no conceptual dependence on the prior period. Pure performance/
-- architecture change: reads scr_anchors_asof / scr_metric_ttm_asof
-- instead of per-row correlated subqueries against scr_fundamentals.
insert into scr_scores (company_id, as_of_date, profile_version, sign1, sign2, sign3, sign4, sign5, sign6, signs_met, composite, score, rule_breaker_pass, missing_inputs, raw_inputs, needs_review)
with peers as (
  select company_id, as_of_date, market_cap, price, shares_outstanding, needs_review
  from scr_universe_membership where strategy='a_growth' and as_of_date >= :start_date and as_of_date <= :end_date
),
anc as (
  select pk.company_id, pk.as_of_date, a.pe0, a.pe0_prior, a.span_now, a.span_prior, a.rev_q0, a.rev_q0_py
  from peers pk
  left join scr_anchors_asof a on a.company_id=pk.company_id and a.as_of_date=pk.as_of_date
),
ttm_prior as (
  select anc.company_id, anc.as_of_date,
    case when anc.pe0_prior is not null then rev.value_now end as ttm_rev_now,
    case when anc.pe0_prior is not null then anc.span_now end as span_now,
    case when anc.pe0_prior is not null then gp.value_now end as ttm_gp_now,
    case when anc.pe0_prior is not null then rd.value_now end as ttm_rd_now,
    case when anc.pe0_prior is not null then rev.value_prior end as ttm_rev_prior,
    case when anc.pe0_prior is not null then anc.span_prior end as span_prior,
    case when anc.pe0_prior is not null then gp.value_prior end as ttm_gp_prior
  from anc
  left join scr_metric_ttm_asof rev on rev.company_id=anc.company_id and rev.as_of_date=anc.as_of_date and rev.metric='revenue'
  left join scr_metric_ttm_asof gp on gp.company_id=anc.company_id and gp.as_of_date=anc.as_of_date and gp.metric='gross_profit'
  left join scr_metric_ttm_asof rd on rd.company_id=anc.company_id and rd.as_of_date=anc.as_of_date and rd.metric='research_development'
),
qtr_yoy as (
  select company_id, as_of_date, rev_q0, rev_q0_py from anc
),
assets_now as (
  select anc.company_id, anc.as_of_date, ta.value_now as assets0
  from anc
  left join scr_metric_ttm_asof ta on ta.company_id=anc.company_id and ta.as_of_date=anc.as_of_date and ta.metric='total_assets'
),
debt_cash as (
  select pk.company_id, pk.as_of_date, db.value_now as debt, ca.value_now as cash
  from peers pk
  left join scr_metric_ttm_asof db on db.company_id=pk.company_id and db.as_of_date=pk.as_of_date and db.metric='total_debt'
  left join scr_metric_ttm_asof ca on ca.company_id=pk.company_id and ca.as_of_date=pk.as_of_date and ca.metric='cash_and_equivalents'
),
returns_raw as (
  select pk.company_id, pk.as_of_date,
    cur.adj_close as close_now, y1.adj_close as close_1y, m1.adj_close as close_1m, m6.adj_close as close_6m
  from peers pk
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=pk.company_id and ap.date<=pk.as_of_date order by ap.date desc limit 1) cur on true
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=pk.company_id and ap.date<=pk.as_of_date - interval '1 year' order by ap.date desc limit 1) y1 on true
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=pk.company_id and ap.date<=pk.as_of_date - interval '1 month' order by ap.date desc limit 1) m1 on true
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=pk.company_id and ap.date<=pk.as_of_date - interval '6 months' order by ap.date desc limit 1) m6 on true
),
raw_metrics as (
  select pk.company_id, pk.as_of_date, pk.market_cap, pk.needs_review,
    case when tp.ttm_rev_prior is not null and tp.ttm_rev_prior<>0 and tp.span_now between 250 and 300 and tp.span_prior between 250 and 300
      then tp.ttm_rev_now/tp.ttm_rev_prior - 1 end as rev_growth_fy,
    case when qy.rev_q0_py is not null and qy.rev_q0_py<>0 then qy.rev_q0/qy.rev_q0_py - 1 end as rev_growth_qtr_yoy,
    case when tp.ttm_rev_now is not null and tp.ttm_rev_now<>0 then tp.ttm_gp_now/tp.ttm_rev_now end as gross_margin,
    case when an.assets0 is not null and an.assets0<>0 then tp.ttm_gp_now/an.assets0 end as gp_over_assets,
    case when tp.ttm_rev_now is not null and tp.ttm_rev_now<>0 and tp.ttm_rev_prior is not null and tp.ttm_rev_prior<>0 and tp.span_now between 250 and 300 and tp.span_prior between 250 and 300
      then tp.ttm_gp_now/tp.ttm_rev_now - tp.ttm_gp_prior/tp.ttm_rev_prior end as gross_margin_change,
    case when tp.ttm_gp_now is not null and tp.ttm_gp_now>0 and tp.ttm_rd_now is not null then tp.ttm_rd_now/tp.ttm_gp_now end as rd_over_gp,
    case when rr.close_1y is not null and rr.close_1y<>0 then rr.close_now/rr.close_1y - 1 end as ret_1y,
    case when rr.close_1y is not null and rr.close_1y<>0 and rr.close_1m is not null then rr.close_1m/rr.close_1y - 1 end as mom_12_1,
    case when rr.close_6m is not null and rr.close_6m<>0 then rr.close_now/rr.close_6m - 1 end as mom_6m,
    case when tp.ttm_rev_now is not null and tp.ttm_rev_now<>0 and pk.market_cap is not null and dc.debt is not null and dc.cash is not null
      then (pk.market_cap + dc.debt - dc.cash)/tp.ttm_rev_now end as ev_sales,
    case when tp.ttm_rev_now is not null and tp.ttm_rev_now<>0 and pk.market_cap is not null then pk.market_cap/tp.ttm_rev_now end as price_sales
  from peers pk
  left join ttm_prior tp on tp.company_id=pk.company_id and tp.as_of_date=pk.as_of_date
  left join qtr_yoy qy on qy.company_id=pk.company_id and qy.as_of_date=pk.as_of_date
  left join assets_now an on an.company_id=pk.company_id and an.as_of_date=pk.as_of_date
  left join debt_cash dc on dc.company_id=pk.company_id and dc.as_of_date=pk.as_of_date
  left join returns_raw rr on rr.company_id=pk.company_id and rr.as_of_date=pk.as_of_date
),
pcts as (
  select *,
    case when rev_growth_fy is not null then (2*rank() over (partition by as_of_date, (rev_growth_fy is not null) order by rev_growth_fy) + count(*) over (partition by as_of_date, rev_growth_fy) - 3) / (2.0*(count(*) over (partition by as_of_date, (rev_growth_fy is not null)) - 1)) * 100 end as p_rev_fy,
    case when rev_growth_qtr_yoy is not null then (2*rank() over (partition by as_of_date, (rev_growth_qtr_yoy is not null) order by rev_growth_qtr_yoy) + count(*) over (partition by as_of_date, rev_growth_qtr_yoy) - 3) / (2.0*(count(*) over (partition by as_of_date, (rev_growth_qtr_yoy is not null)) - 1)) * 100 end as p_rev_qtr,
    case when gross_margin is not null then (2*rank() over (partition by as_of_date, (gross_margin is not null) order by gross_margin) + count(*) over (partition by as_of_date, gross_margin) - 3) / (2.0*(count(*) over (partition by as_of_date, (gross_margin is not null)) - 1)) * 100 end as p_gm,
    case when gp_over_assets is not null then (2*rank() over (partition by as_of_date, (gp_over_assets is not null) order by gp_over_assets) + count(*) over (partition by as_of_date, gp_over_assets) - 3) / (2.0*(count(*) over (partition by as_of_date, (gp_over_assets is not null)) - 1)) * 100 end as p_gpa,
    case when gross_margin_change is not null then (2*rank() over (partition by as_of_date, (gross_margin_change is not null) order by gross_margin_change) + count(*) over (partition by as_of_date, gross_margin_change) - 3) / (2.0*(count(*) over (partition by as_of_date, (gross_margin_change is not null)) - 1)) * 100 end as p_gmc,
    case when rd_over_gp is not null then (2*rank() over (partition by as_of_date, (rd_over_gp is not null) order by rd_over_gp) + count(*) over (partition by as_of_date, rd_over_gp) - 3) / (2.0*(count(*) over (partition by as_of_date, (rd_over_gp is not null)) - 1)) * 100 end as p_rd,
    case when ret_1y is not null then (2*rank() over (partition by as_of_date, (ret_1y is not null) order by ret_1y) + count(*) over (partition by as_of_date, ret_1y) - 3) / (2.0*(count(*) over (partition by as_of_date, (ret_1y is not null)) - 1)) * 100 end as p_ret1y,
    case when mom_12_1 is not null then (2*rank() over (partition by as_of_date, (mom_12_1 is not null) order by mom_12_1) + count(*) over (partition by as_of_date, mom_12_1) - 3) / (2.0*(count(*) over (partition by as_of_date, (mom_12_1 is not null)) - 1)) * 100 end as p_mom121,
    case when mom_6m is not null then (2*rank() over (partition by as_of_date, (mom_6m is not null) order by mom_6m) + count(*) over (partition by as_of_date, mom_6m) - 3) / (2.0*(count(*) over (partition by as_of_date, (mom_6m is not null)) - 1)) * 100 end as p_mom6m,
    case when ev_sales is not null then (2*rank() over (partition by as_of_date, (ev_sales is not null) order by ev_sales) + count(*) over (partition by as_of_date, ev_sales) - 3) / (2.0*(count(*) over (partition by as_of_date, (ev_sales is not null)) - 1)) * 100 end as p_evs,
    case when price_sales is not null then (2*rank() over (partition by as_of_date, (price_sales is not null) order by price_sales) + count(*) over (partition by as_of_date, price_sales) - 3) / (2.0*(count(*) over (partition by as_of_date, (price_sales is not null)) - 1)) * 100 end as p_ps
  from raw_metrics
),
signs as (
  select *,
    (select round(avg(v)) from (values (p_rev_fy),(p_rev_qtr)) t(v) where v is not null) as sign1,
    (select round(avg(v)) from (values (p_gm),(p_gpa),(p_gmc),(p_rd)) t(v) where v is not null) as sign2,
    (select round(avg(v)) from (values (p_ret1y),(p_mom121),(p_mom6m)) t(v) where v is not null) as sign3,
    (select round(avg(v)) from (values (p_evs),(p_ps)) t(v) where v is not null) as sign6
  from pcts
),
composite_calc as (
  select *,
    (select avg(v) from (values (sign1),(sign2),(sign3),(sign6)) t(v) where v is not null) as composite_val,
    (select count(*) from (values (sign1),(sign2),(sign3),(sign6)) t(v) where v is not null) as n_signs_avail,
    (select count(*) from (values (sign1),(sign2),(sign3),(sign6)) t(v) where v is not null and v>=60) as n_signs_met
  from signs
),
scored as (
  select *,
    case when composite_val is not null then
      round((2*rank() over (partition by as_of_date, (composite_val is not null) order by composite_val) + count(*) over (partition by as_of_date, composite_val) - 3) / (2.0*(count(*) over (partition by as_of_date, (composite_val is not null)) - 1)) * 100)
    end as score_val
  from composite_calc
)
select
  company_id, as_of_date, 'a_v1_hist_rd',
  sign1, sign2, sign3, null, null, sign6,
  n_signs_met, composite_val, score_val,
  (score_val is not null and score_val>=60 and n_signs_met=n_signs_avail and n_signs_avail>0),
  array_remove(array[
    case when rev_growth_fy is null then 'rev_growth_fy' end,
    case when rev_growth_qtr_yoy is null then 'rev_growth_qtr_yoy' end,
    case when gross_margin is null then 'gross_margin' end,
    case when gp_over_assets is null then 'gp_over_assets' end,
    case when gross_margin_change is null then 'gross_margin_change' end,
    case when rd_over_gp is null then 'rd_over_gp' end,
    case when ret_1y is null then 'ret_1y' end,
    case when mom_12_1 is null then 'mom_12_1' end,
    case when mom_6m is null then 'mom_6m' end,
    case when ev_sales is null then 'ev_sales' end,
    case when price_sales is null then 'price_sales' end,
    'insider_ownership','institutional_ownership','judgment_ratings','forward_pe'
  ], null),
  jsonb_build_object(
    'rev_growth_fy', rev_growth_fy, 'rev_growth_qtr_yoy', rev_growth_qtr_yoy,
    'gross_margin', gross_margin, 'gp_over_assets', gp_over_assets, 'gross_margin_change', gross_margin_change,
    'rd_over_gp', rd_over_gp,
    'ret_1y', ret_1y, 'mom_12_1', mom_12_1, 'mom_6m', mom_6m,
    'ev_sales', ev_sales, 'price_sales', price_sales
  ),
  needs_review
from scored
on conflict (company_id, as_of_date, profile_version) do nothing;
