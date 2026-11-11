-- TEST 5 v2 (trial_id=18): Big Winners Analysis
-- Round 2 CORRECTIVE: real executed code, not reconstruction. Adds
-- a_v1_hist_ff12. Both parts (base rate by quintile, and z-score-diff) now
-- computed with/without needs_review (round 1's quintile-rate part lacked
-- this split).

set statement_timeout = '5min';

-- Part A: base rate of reached_10x_in_60m by score quintile.
with universe as (
  select company_id, as_of_date, profile_version, score,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period,
         filt.f as filt
  from scr_scores a
  cross join (values ('all'), ('excl_review')) as filt(f)
  where a.as_of_date <= '2023-12-31'
    and a.profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','a_v1_hist_ff12','b_v1')
    and (filt.f = 'all' or a.needs_review = false)
),
joined as (
  select u.*, f.reached_10x_in_60m,
         ntile(5) over (partition by u.profile_version, u.as_of_date, u.filt order by u.score) as q
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  where f.reached_10x_in_60m is not null
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 18, 'big_winner_rate_by_quintile', profile_version, period,
  jsonb_build_object('filt', filt, 'q', q, 'n', n, 'effective_n', n, 'base_rate_10x', base_rate_10x)
from (
  select profile_version, period, filt, q, count(*) as n, avg((reached_10x_in_60m)::int)::float as base_rate_10x
  from joined
  group by profile_version, period, filt, q
) x;

-- Part B: mean standardized score z-score diff, winners vs rest, cluster-robust-by-date.
with universe2 as (
  select company_id, as_of_date, profile_version, score,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period,
         filt.f as filt
  from scr_scores a
  cross join (values ('all'), ('excl_review')) as filt(f)
  where a.as_of_date <= '2023-12-31'
    and a.profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','a_v1_hist_ff12','b_v1')
    and (filt.f = 'all' or a.needs_review = false)
),
joined2 as (
  select u.*, f.reached_10x_in_60m
  from universe2 u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  where f.reached_10x_in_60m is not null
),
zscored as (
  select *,
    (score - avg(score) over (partition by profile_version, as_of_date, filt))
      / stddev_pop(score) over (partition by profile_version, as_of_date, filt) as z
  from joined2
),
per_date as (
  select profile_version, period, as_of_date, filt,
         count(*) filter (where reached_10x_in_60m) as n_10x_obs,
         count(*) as n_total_obs,
         avg(z) filter (where reached_10x_in_60m) - avg(z) filter (where not reached_10x_in_60m) as zdiff
  from zscored
  group by 1, 2, 3, 4
  having count(*) filter (where reached_10x_in_60m) > 0
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 18, 'big_winner_zscore_diff', profile_version, period,
  jsonb_build_object(
    'filt', filt, 'n_dates', n_dates, 'effective_n', n_dates,
    'n_10x_obs', n_10x_obs, 'n_total_obs', n_total_obs,
    'mean_zscore_diff', mean_val, 'nw_se', nw_se, 't_stat', t_stat
  )
from (
  select profile_version, period, filt,
    sum(n_10x_obs) as n_10x_obs, sum(n_total_obs) as n_total_obs,
    (nw_mean_test(array_agg(zdiff order by as_of_date), 0)).mean_val as mean_val,
    (nw_mean_test(array_agg(zdiff order by as_of_date), 0)).nw_se as nw_se,
    (nw_mean_test(array_agg(zdiff order by as_of_date), 0)).t_stat as t_stat,
    (nw_mean_test(array_agg(zdiff order by as_of_date), 0)).n as n_dates
  from per_date
  group by profile_version, period, filt
) y
where mean_val is not null;
