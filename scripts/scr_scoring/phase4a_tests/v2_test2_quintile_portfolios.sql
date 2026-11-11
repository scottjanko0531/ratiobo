-- TEST 2 v2 (trial_id=15): Quintile Portfolios
-- Round 2: adds a_v1_hist_ff12. Also now run from committed code directly
-- (closing the round-1 provenance gap for this test incidentally, since the
-- full rerun covers it). Literal query executed this round.
-- Cost model: net = gross - 4*(cost_bps/10000), 4-sided long-short spread;
-- cost_bps=10 for a_growth profiles, 25 for b_v1.

set statement_timeout = '5min';

with universe as (
  select company_id, as_of_date, profile_version, score,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period,
         filt.f as filt
  from scr_scores a
  cross join (values ('all'), ('excl_review')) as filt(f)
  where a.as_of_date >= '2017-01-01' and a.as_of_date <= '2023-12-31'
    and a.profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','a_v1_hist_ff12','b_v1')
    and (filt.f = 'all' or a.needs_review = false)
),
ranked as (
  select *, ntile(5) over (partition by profile_version, as_of_date, filt order by score) as q
  from universe
),
joined as (
  select r.*, f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m
  from ranked r
  join scr_fwd_ret_mat f on f.company_id = r.company_id and f.as_of_date = r.as_of_date
),
per_date as (
  select profile_version, period, as_of_date, filt,
         avg(ret_1m)  filter (where q=5) - avg(ret_1m)  filter (where q=1) as spread_1m,
         avg(ret_3m)  filter (where q=5) - avg(ret_3m)  filter (where q=1) as spread_3m,
         avg(ret_6m)  filter (where q=5) - avg(ret_6m)  filter (where q=1) as spread_6m,
         avg(ret_12m) filter (where q=5) - avg(ret_12m) filter (where q=1) as spread_12m,
         avg(ret_36m) filter (where q=5) - avg(ret_36m) filter (where q=1) as spread_36m
  from joined
  group by 1, 2, 3, 4
),
agg as (
  select profile_version, period, filt, '1m'::text as horizon, (nw_mean_test(array_agg(spread_1m order by as_of_date), 0)).*
  from per_date where spread_1m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '3m', (nw_mean_test(array_agg(spread_3m order by as_of_date), 2)).*
  from per_date where spread_3m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '6m', (nw_mean_test(array_agg(spread_6m order by as_of_date), 5)).*
  from per_date where spread_6m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '12m', (nw_mean_test(array_agg(spread_12m order by as_of_date), 11)).*
  from per_date where spread_12m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '36m', (nw_mean_test(array_agg(spread_36m order by as_of_date), 35)).*
  from per_date where spread_36m is not null group by 1,2,3
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 15, 'q5_q1_spread', profile_version, period,
  jsonb_build_object(
    'filt', filt, 'horizon', horizon, 'n_dates', n, 'effective_n', n,
    'nw_se', nw_se, 't_stat', t_stat,
    'cost_bps_per_side', cost_bps,
    'gross_mean_spread', mean_val,
    'net_mean_spread', mean_val - 4*cost_bps/10000.0,
    'breakeven_cost_bps_per_side', mean_val * 10000.0 / 4
  )
from (
  select *, case when profile_version = 'b_v1' then 25 else 10 end as cost_bps
  from agg
) x;
