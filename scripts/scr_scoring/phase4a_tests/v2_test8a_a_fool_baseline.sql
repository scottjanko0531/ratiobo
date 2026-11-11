-- TEST 8a v2 (trial_id=21): "A-Fool" full-universe-equal-weight baseline
-- KEPT under its own trial id per explicit coordinator instruction (round
-- 1's baseline methodology is not being replaced, just supplemented -- see
-- v2_test8b_fool_restricted.sql for the new Fool-picks-restricted test).
-- Round 2: adds a_v1_hist_ff12. Correct development lower bound applied
-- from the start (as_of_date >= '2017-01-01'), learned from the bug found
-- and fixed in tests 1-7 this round.

set statement_timeout = '5min';

with q5_by_filt as (
  select profile_version, period, as_of_date, filt,
         avg(ret_1m) as ret_1m, avg(ret_3m) as ret_3m, avg(ret_6m) as ret_6m,
         avg(ret_12m) as ret_12m, avg(ret_36m) as ret_36m
  from (
    select s.profile_version,
           case when s.as_of_date <= '2021-12-31' then 'development'
                when s.as_of_date <= '2023-12-31' then 'validation'
                else 'holdout' end as period,
           s.as_of_date,
           filt.f as filt,
           f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m,
           ntile(5) over (partition by s.profile_version, s.as_of_date, filt.f order by s.score) as q
    from scr_scores s
    join scr_fwd_ret_mat f on f.company_id = s.company_id and f.as_of_date = s.as_of_date
    cross join (values ('all'), ('excl_review')) as filt(f)
    where s.as_of_date >= '2017-01-01' and s.as_of_date <= '2023-12-31'
      and s.profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','a_v1_hist_ff12','b_v1')
      and (filt.f = 'all' or s.needs_review = false)
  ) x
  where q = 5
  group by profile_version, period, as_of_date, filt
),
base_by_filt as (
  select strategy, period, as_of_date, filt,
         avg(ret_1m) as ret_1m, avg(ret_3m) as ret_3m, avg(ret_6m) as ret_6m,
         avg(ret_12m) as ret_12m, avg(ret_36m) as ret_36m
  from (
    select m.strategy,
           case when m.as_of_date <= '2021-12-31' then 'development'
                when m.as_of_date <= '2023-12-31' then 'validation'
                else 'holdout' end as period,
           m.as_of_date,
           filt.f as filt,
           f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m
    from scr_universe_membership m
    join scr_fwd_ret_mat f on f.company_id = m.company_id and f.as_of_date = m.as_of_date
    cross join (values ('all'), ('excl_review')) as filt(f)
    where m.as_of_date >= '2017-01-01' and m.as_of_date <= '2023-12-31'
      and (filt.f = 'all' or m.needs_review = false)
  ) y
  group by strategy, period, as_of_date, filt
),
profile_strategy (profile_version, strategy) as (
  values ('a_v1_hist','a_growth'), ('a_v1_hist_rd','a_growth'),
         ('a_v1_hist_qqq_gate','a_growth'), ('a_v1_hist_ff12','a_growth'), ('b_v1','profile_b')
),
panel as (
  select q.profile_version, q.period, q.as_of_date, q.filt,
         q.ret_1m  - b.ret_1m  as spread_1m,
         q.ret_3m  - b.ret_3m  as spread_3m,
         q.ret_6m  - b.ret_6m  as spread_6m,
         q.ret_12m - b.ret_12m as spread_12m,
         q.ret_36m - b.ret_36m as spread_36m
  from q5_by_filt q
  join profile_strategy ps on ps.profile_version = q.profile_version
  join base_by_filt b on b.strategy = ps.strategy and b.period = q.period
                      and b.as_of_date = q.as_of_date and b.filt = q.filt
),
agg as (
  select profile_version, period, filt, '1m'::text as horizon,
         (nw_mean_test(array_agg(spread_1m order by as_of_date), 0)).*
  from panel where spread_1m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '3m',
         (nw_mean_test(array_agg(spread_3m order by as_of_date), 2)).*
  from panel where spread_3m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '6m',
         (nw_mean_test(array_agg(spread_6m order by as_of_date), 5)).*
  from panel where spread_6m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '12m',
         (nw_mean_test(array_agg(spread_12m order by as_of_date), 11)).*
  from panel where spread_12m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '36m',
         (nw_mean_test(array_agg(spread_36m order by as_of_date), 35)).*
  from panel where spread_36m is not null group by 1,2,3
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 21, 'a_fool_baseline_comparison', profile_version, period,
  jsonb_build_object(
    'filt', filt, 'horizon', horizon, 'n_months', n, 'effective_n', n,
    'gross_mean_spread', mean_val, 'nw_se', nw_se, 'gross_t_stat', t_stat,
    'cost_bps_per_side', cost_bps,
    'net_mean_spread', mean_val - 2*cost_bps/10000.0,
    'net_t_stat', (mean_val - 2*cost_bps/10000.0) / nullif(nw_se,0)
  )
from (
  select *, case when profile_version='b_v1' then 25 else 10 end as cost_bps
  from agg
) final;
