-- Monthly incremental VM-ind scoring for ONE month-end (:as_of_date),
-- reusing exactly the methodology validated in vm_signals_build_v2.sql /
-- ttm_adhoc_build_v2.sql (shared revenue anchor, 250-300 day span guard,
-- exact-match-then-independent-fallback TTM, percentile-rank value
-- composite requiring >=2 of 4 components, 12-1 momentum, industry-ranked
-- value with <8-peer fallback to universe-wide) -- scoped to a single
-- date instead of the full 2017-2026 historical range, since this runs
-- once a month against whatever that month's broad_liquid membership is,
-- not a bulk historical build.
--
-- Run via: psql "$SUPABASE_DB_URL" -v as_of_date="'2026-11-30'" -f scripts/scr_scoring/vm_signals_monthly.sql
-- Assumes scr_rebuild_universe_membership has already populated
-- broad_liquid for :as_of_date (the monthly workflow runs the universe
-- rebuild step first).

set statement_timeout = '8min';

create temp table t_uncov_anchor as
with uncovered as (
  select um.company_id, um.as_of_date
  from scr_universe_membership um
  left join scr_anchors_asof a on a.company_id = um.company_id and a.as_of_date = um.as_of_date
  where um.strategy = 'broad_liquid' and um.as_of_date = :as_of_date and a.company_id is null
),
periods as (
  select u.company_id, u.as_of_date, f.period_end, f.filed_date,
    row_number() over (partition by u.company_id, u.as_of_date, f.period_end order by f.filed_date desc) as rn_rev
  from uncovered u
  join scr_fundamentals f on f.company_id = u.company_id and f.metric = 'revenue' and f.filed_date <= u.as_of_date
),
top4 as (
  select company_id, as_of_date, period_end,
    row_number() over (partition by company_id, as_of_date order by period_end desc) as rn_period
  from periods where rn_rev = 1
)
select company_id, as_of_date, max(period_end) as pe0, (max(period_end)-min(period_end)) as span_now
from top4 where rn_period <= 4
group by company_id, as_of_date
having count(*) = 4;

create temp table t_uncov_anchorset as
with valid as (select company_id, as_of_date from t_uncov_anchor where span_now between 250 and 300),
periods as (
  select v.company_id, v.as_of_date, f.period_end,
    row_number() over (partition by v.company_id, v.as_of_date, f.period_end order by f.filed_date desc) as rn_rev
  from valid v
  join scr_fundamentals f on f.company_id = v.company_id and f.metric = 'revenue' and f.filed_date <= v.as_of_date
),
top4 as (
  select company_id, as_of_date, period_end,
    row_number() over (partition by company_id, as_of_date order by period_end desc) as rn_period
  from periods where rn_rev = 1
)
select company_id, as_of_date, period_end from top4 where rn_period <= 4;

create temp table t_uncov_primary as
with flow_metrics as (select unnest(array['net_income','operating_cash_flow','ebitda']) as metric),
primary_vals as (
  select ast.company_id, ast.as_of_date, fm.metric, ast.period_end, f.value,
    row_number() over (partition by ast.company_id, ast.as_of_date, fm.metric, ast.period_end order by f.filed_date desc) as rn
  from t_uncov_anchorset ast
  cross join flow_metrics fm
  left join scr_fundamentals f on f.company_id = ast.company_id and f.metric = fm.metric
    and f.period_end = ast.period_end and f.filed_date <= ast.as_of_date
)
select company_id, as_of_date, metric, sum(value) as primary_sum, count(value) as n_exact
from primary_vals where rn = 1
group by company_id, as_of_date, metric;

create temp table t_uncov_fallback as
with valid as (select company_id, as_of_date from t_uncov_anchor where span_now between 250 and 300),
flow_metrics as (select unnest(array['net_income','operating_cash_flow','ebitda']) as metric),
fb_periods as (
  select v.company_id, v.as_of_date, fm.metric, f.period_end, f.filed_date, f.value,
    row_number() over (partition by v.company_id, v.as_of_date, fm.metric, f.period_end order by f.filed_date desc) as rn_rev
  from valid v
  cross join flow_metrics fm
  join scr_fundamentals f on f.company_id = v.company_id and f.metric = fm.metric and f.filed_date <= v.as_of_date
),
fb_top4 as (
  select company_id, as_of_date, metric, period_end, value,
    row_number() over (partition by company_id, as_of_date, metric order by period_end desc) as rn_period
  from fb_periods where rn_rev = 1
)
select company_id, as_of_date, metric, sum(value) as fallback_sum, count(*) as n_fallback
from fb_top4 where rn_period <= 4
group by company_id, as_of_date, metric;

create temp table t_metric_all as
with covered as (
  select um.company_id, um.as_of_date
  from scr_universe_membership um
  join scr_anchors_asof a on a.company_id=um.company_id and a.as_of_date=um.as_of_date
  where um.strategy='broad_liquid' and um.as_of_date = :as_of_date
),
flow_metrics as (select unnest(array['net_income','operating_cash_flow','ebitda']) as metric)
select c.company_id, c.as_of_date, fm.metric,
  case when a.span_now between 250 and 300 then m.value_now end as value_now
from covered c
cross join flow_metrics fm
join scr_anchors_asof a on a.company_id=c.company_id and a.as_of_date=c.as_of_date
left join scr_metric_ttm_asof m on m.company_id=c.company_id and m.as_of_date=c.as_of_date and m.metric=fm.metric
union all
select c.company_id, c.as_of_date, pm.metric, m.value_now
from covered c
cross join (select unnest(array['stockholders_equity','total_debt','cash_and_equivalents']) as metric) pm
left join scr_metric_ttm_asof m on m.company_id=c.company_id and m.as_of_date=c.as_of_date and m.metric=pm.metric
union all
select p.company_id, p.as_of_date, p.metric,
  case when p.n_exact = 4 then p.primary_sum
       when fb.n_fallback = 4 then fb.fallback_sum
       else null end
from t_uncov_primary p
left join t_uncov_fallback fb on fb.company_id=p.company_id and fb.as_of_date=p.as_of_date and fb.metric=p.metric
union all
select u.company_id, u.as_of_date, pm.metric, f.value
from (select um.company_id, um.as_of_date
      from scr_universe_membership um
      left join scr_anchors_asof a on a.company_id=um.company_id and a.as_of_date=um.as_of_date
      where um.strategy='broad_liquid' and um.as_of_date = :as_of_date and a.company_id is null) u
cross join (select unnest(array['stockholders_equity','total_debt','cash_and_equivalents']) as metric) pm
left join lateral (
  select ff.value from scr_fundamentals ff
  where ff.company_id = u.company_id and ff.metric = pm.metric and ff.filed_date <= u.as_of_date
  order by ff.period_end desc, ff.filed_date desc limit 1
) f on true;

create temp table t_raw_value as
with piv as (
  select company_id, as_of_date,
    max(value_now) filter (where metric='stockholders_equity') as se,
    max(value_now) filter (where metric='net_income') as ni,
    max(value_now) filter (where metric='operating_cash_flow') as ocf,
    max(value_now) filter (where metric='ebitda') as eb,
    max(value_now) filter (where metric='total_debt') as td,
    max(value_now) filter (where metric='cash_and_equivalents') as cash
  from t_metric_all
  group by company_id, as_of_date
)
select um.company_id, um.as_of_date, um.market_cap, um.needs_review, ff12_of_sic(sc.sic_code) as ff12,
  case when p.se is not null and um.market_cap>0 then p.se/um.market_cap end as book_price,
  case when p.ni is not null and um.market_cap>0 then p.ni/um.market_cap end as earnings_yield,
  case when p.ocf is not null and um.market_cap>0 then p.ocf/um.market_cap end as cf_yield,
  case when p.eb is not null and p.td is not null and p.cash is not null and (um.market_cap+p.td-p.cash)>0
    then p.eb/(um.market_cap+p.td-p.cash) end as ebitda_ev
from scr_universe_membership um
join scr_securities sc on sc.id=um.company_id
left join piv p on p.company_id=um.company_id and p.as_of_date=um.as_of_date
where um.strategy='broad_liquid' and um.as_of_date = :as_of_date;

create temp table t_value_pct_ind as
with bp as (select company_id, ff12,
    (2*rank() over (partition by ff12 order by book_price) + count(*) over (partition by ff12, book_price) - 3)
      / (2.0*(count(*) over (partition by ff12)-1)) * 100 as pct, count(*) over (partition by ff12) as n_peers
  from t_raw_value where book_price is not null),
ey as (select company_id, ff12,
    (2*rank() over (partition by ff12 order by earnings_yield) + count(*) over (partition by ff12, earnings_yield) - 3)
      / (2.0*(count(*) over (partition by ff12)-1)) * 100 as pct, count(*) over (partition by ff12) as n_peers
  from t_raw_value where earnings_yield is not null),
cf as (select company_id, ff12,
    (2*rank() over (partition by ff12 order by cf_yield) + count(*) over (partition by ff12, cf_yield) - 3)
      / (2.0*(count(*) over (partition by ff12)-1)) * 100 as pct, count(*) over (partition by ff12) as n_peers
  from t_raw_value where cf_yield is not null),
ee as (select company_id, ff12,
    (2*rank() over (partition by ff12 order by ebitda_ev) + count(*) over (partition by ff12, ebitda_ev) - 3)
      / (2.0*(count(*) over (partition by ff12)-1)) * 100 as pct, count(*) over (partition by ff12) as n_peers
  from t_raw_value where ebitda_ev is not null),
fb_bp as (select company_id,
    (2*rank() over (order by book_price) + count(*) over (partition by book_price) - 3) / (2.0*(count(*) over ()-1)) * 100 as pct
  from t_raw_value where book_price is not null),
fb_ey as (select company_id,
    (2*rank() over (order by earnings_yield) + count(*) over (partition by earnings_yield) - 3) / (2.0*(count(*) over ()-1)) * 100 as pct
  from t_raw_value where earnings_yield is not null),
fb_cf as (select company_id,
    (2*rank() over (order by cf_yield) + count(*) over (partition by cf_yield) - 3) / (2.0*(count(*) over ()-1)) * 100 as pct
  from t_raw_value where cf_yield is not null),
fb_ee as (select company_id,
    (2*rank() over (order by ebitda_ev) + count(*) over (partition by ebitda_ev) - 3) / (2.0*(count(*) over ()-1)) * 100 as pct
  from t_raw_value where ebitda_ev is not null)
select r.company_id,
  case when (bp.pct is not null)::int + (ey.pct is not null)::int + (cf.pct is not null)::int + (ee.pct is not null)::int >= 2
    then (coalesce(case when bp.n_peers>=8 then bp.pct else fb_bp.pct end,0)
        + coalesce(case when ey.n_peers>=8 then ey.pct else fb_ey.pct end,0)
        + coalesce(case when cf.n_peers>=8 then cf.pct else fb_cf.pct end,0)
        + coalesce(case when ee.n_peers>=8 then ee.pct else fb_ee.pct end,0))
      / ((bp.pct is not null)::int + (ey.pct is not null)::int + (cf.pct is not null)::int + (ee.pct is not null)::int)
  end as value_pct_ind
from t_raw_value r
left join bp on bp.company_id=r.company_id
left join ey on ey.company_id=r.company_id
left join cf on cf.company_id=r.company_id
left join ee on ee.company_id=r.company_id
left join fb_bp on fb_bp.company_id=r.company_id
left join fb_ey on fb_ey.company_id=r.company_id
left join fb_cf on fb_cf.company_id=r.company_id
left join fb_ee on fb_ee.company_id=r.company_id;

create temp table t_momentum_pct as
with mom as (
  select um.company_id,
    case when m1.adj_close is not null and y1.adj_close is not null and y1.adj_close<>0
      then m1.adj_close/y1.adj_close - 1 end as ret_12_1
  from scr_universe_membership um
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=um.company_id and ap.date<=um.as_of_date - interval '1 month' order by ap.date desc limit 1) m1 on true
  left join lateral (select ap.adj_close from scr_adjusted_prices ap where ap.company_id=um.company_id and ap.date<=um.as_of_date - interval '1 year' order by ap.date desc limit 1) y1 on true
  where um.strategy='broad_liquid' and um.as_of_date = :as_of_date
)
select company_id,
  (2*rank() over (order by ret_12_1) + count(*) over (partition by ret_12_1) - 3) / (2.0*(count(*) over ()-1)) * 100 as momentum_pct
from mom where ret_12_1 is not null;

insert into scr_scores (company_id, as_of_date, profile_version, sign1, sign2, composite, score, raw_inputs, needs_review)
select vi.company_id, :as_of_date, 'vm_combo_ind', vi.value_pct_ind, mp.momentum_pct,
  (vi.value_pct_ind + mp.momentum_pct)/2, (vi.value_pct_ind + mp.momentum_pct)/2, '{}'::jsonb, r.needs_review
from t_value_pct_ind vi
join t_momentum_pct mp on mp.company_id = vi.company_id
join t_raw_value r on r.company_id = vi.company_id
where vi.value_pct_ind is not null
on conflict (company_id, as_of_date, profile_version) do nothing;
