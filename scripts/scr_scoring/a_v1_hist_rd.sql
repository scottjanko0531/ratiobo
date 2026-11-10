-- Phase 3 historical scoring pipeline: profile_version = 'a_v1_hist_rd'.
-- Identical to a_v1_hist.sql in this same directory, EXCEPT Sign 2
-- (profitability/moat) adds a 4th driver -- rd_over_gp (R&D expense / TTM
-- gross profit, matching live metrics.ts's rdOverGrossProfit exactly: null
-- whenever TTM gross profit is <= 0, no substitution) -- now that
-- us-gaap:ResearchAndDevelopmentExpense is extracted into scr_fundamentals
-- as the 'research_development' metric (see fundamentalsCore.mjs in
-- scripts/backfill/lib/). a_v1_hist itself is left untouched as the
-- baseline-without-R&D; this is a NEW, separate profile_version.
--
-- Committed retroactively per the 2026-11-10 reproducibility audit. Run in
-- __START__/__END__ year-sized batches (string-substitute the literal
-- placeholders before executing -- this file predates adopting :named
-- parameters for a_v1_hist.sql's run).
insert into scr_scores (company_id, as_of_date, profile_version, sign1, sign2, sign3, sign4, sign5, sign6, signs_met, composite, score, rule_breaker_pass, missing_inputs, raw_inputs, needs_review)
with peers as (
  select company_id, as_of_date, market_cap, needs_review from scr_universe_membership where strategy='a_growth' and as_of_date >= '__START__' and as_of_date <= '__END__'
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
ttm_now as (
  select a.company_id, a.as_of_date, a.pe0, a.pe0_prior,
    (select sum(v) from (select distinct f.period_end,(select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='revenue' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='revenue' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_rev_now,
    (select max(pe)-min(pe) from (select distinct period_end as pe from scr_fundamentals f where f.company_id=a.company_id and f.metric='revenue' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by pe desc limit 4) x) as span_now,
    (select sum(v) from (select distinct f.period_end,(select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='gross_profit' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='gross_profit' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_gp_now,
    (select sum(v) from (select distinct f.period_end,(select f2.value from scr_fundamentals f2 where f2.company_id=a.company_id and f2.metric='research_development' and f2.period_end=f.period_end and f2.filed_date<=a.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=a.company_id and f.metric='research_development' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc limit 4) f) as ttm_rd_now
  from anchors2 a
),
ttm_prior as (
  select t.*,
    (select sum(v) from (select distinct f.period_end,(select f2.value from scr_fundamentals f2 where f2.company_id=t.company_id and f2.metric='revenue' and f2.period_end=f.period_end and f2.filed_date<=t.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=t.company_id and f.metric='revenue' and f.filed_date<=t.as_of_date and f.period_end<=t.pe0_prior order by f.period_end desc limit 4) f) as ttm_rev_prior,
    (select max(pe)-min(pe) from (select distinct period_end as pe from scr_fundamentals f where f.company_id=t.company_id and f.metric='revenue' and f.filed_date<=t.as_of_date and f.period_end<=t.pe0_prior order by pe desc limit 4) x) as span_prior,
    (select sum(v) from (select distinct f.period_end,(select f2.value from scr_fundamentals f2 where f2.company_id=t.company_id and f2.metric='gross_profit' and f2.period_end=f.period_end and f2.filed_date<=t.as_of_date order by f2.filed_date desc limit 1) as v from scr_fundamentals f where f.company_id=t.company_id and f.metric='gross_profit' and f.filed_date<=t.as_of_date and f.period_end<=t.pe0_prior order by f.period_end desc limit 4) f) as ttm_gp_prior
  from ttm_now t where t.pe0_prior is not null
),
qtr_yoy as (
  select tn.company_id, tn.as_of_date,
    (select f.value from scr_fundamentals f where f.company_id=tn.company_id and f.metric='revenue' and f.period_end=tn.pe0 and f.filed_date<=tn.as_of_date order by f.filed_date desc limit 1) as rev_q0,
    (select f.value from scr_fundamentals f where f.company_id=tn.company_id and f.metric='revenue' and f.period_end=tn.pe0 - interval '1 year' and f.filed_date<=tn.as_of_date order by f.filed_date desc limit 1) as rev_q0_py
  from ttm_now tn
),
assets_now as (
  select a.company_id, a.as_of_date,
    (select f.value from scr_fundamentals f where f.company_id=a.company_id and f.metric='total_assets' and f.filed_date<=a.as_of_date and f.period_end<=a.pe0 order by f.period_end desc, f.filed_date desc limit 1) as assets0
  from anchors2 a
),
debt_cash as (
  select pk.company_id, pk.as_of_date,
    (select f.value from scr_fundamentals f where f.company_id=pk.company_id and f.metric='total_debt' and f.filed_date<=pk.as_of_date order by f.period_end desc, f.filed_date desc limit 1) as debt,
    (select f.value from scr_fundamentals f where f.company_id=pk.company_id and f.metric='cash_and_equivalents' and f.filed_date<=pk.as_of_date order by f.period_end desc, f.filed_date desc limit 1) as cash
  from peers pk
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
