-- TEST 5 (trial_id=10): Big Winners Analysis
-- Pre-registration: scr_trials.id=10
--
-- POST-HOC RECONSTRUCTION -- see README.md. Spot-checked (base-rate-by-quintile part
-- only) against the stored scr_results row for (a_v1_hist, development, q=1,
-- result_key='big_winner_rate_by_quintile'): stored base_rate_10x=0.016177957532861477,
-- n=6923.
--
-- SPOT-CHECK RESULT: reconstruction below gives n=6540, base_rate_10x=0.0172782874617737
-- for the same cell -- same direction and same qualitative U-shape across quintiles
-- (Q1 and Q5 both higher than the Q2-Q4 middle), but not an exact match. The
-- discrepancy is consistent with a different null/window-complete gate upstream of
-- `reached_10x_in_60m` (the original likely queried scr_forward_returns'
-- window_complete flag directly rather than scr_fwd_ret_mat's materialized column, and
-- scr_fwd_ret_mat.reached_10x_in_60m is not necessarily null-gated identically), not a
-- methodology error. Treat the exact base rates in scr_results as from the original
-- run, and this reconstruction as confirming direction/shape only. The stored rows
-- also carry no `filt` field -- they appear to have been computed once for the
-- unfiltered ("all") universe only, a gap against the "with/without needs_review"
-- ground rule, disclosed here and in the final report rather than silently patched.
--
-- Part A: base rate of reached_10x_in_60m overall and within score quintiles.

with universe as (
  select company_id, as_of_date, profile_version, score,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period
  from scr_scores
  where as_of_date <= '2023-12-31'
    and profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','b_v1')
),
joined as (
  select u.*, f.reached_10x_in_60m,
         ntile(5) over (partition by u.profile_version, u.as_of_date order by u.score) as q
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  where f.reached_10x_in_60m is not null  -- window_complete gate
)
select profile_version, period, q,
       count(*) as n,
       avg((reached_10x_in_60m)::int)::float as base_rate_10x
from joined
group by profile_version, period, q
order by profile_version, period, q;

-- Part B: mean standardized score z-score diff, winners (reached_10x_in_60m=true) vs
-- the rest of that date's universe, cluster-robust by date (implemented as the NW
-- HAC lag=0 convention used throughout this test battery for cross-sectional
-- cluster-by-date comparisons).

with universe as (
  select company_id, as_of_date, profile_version, score,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period
  from scr_scores
  where as_of_date <= '2023-12-31'
    and profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','b_v1')
    -- excl_review variant adds: and needs_review = false
),
joined as (
  select u.*, f.reached_10x_in_60m
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  where f.reached_10x_in_60m is not null
),
zscored as (
  select *,
         (score - avg(score) over (partition by profile_version, as_of_date))
           / stddev_pop(score) over (partition by profile_version, as_of_date) as z
  from joined
),
per_date as (
  select profile_version, period, as_of_date,
         count(*) filter (where reached_10x_in_60m) as n_10x_obs,
         count(*) as n_total_obs,
         avg(z) filter (where reached_10x_in_60m) - avg(z) filter (where not reached_10x_in_60m)
           as zdiff
  from zscored
  group by 1, 2, 3
  having count(*) filter (where reached_10x_in_60m) > 0
)
select profile_version, period,
       sum(n_10x_obs) as n_10x_obs, sum(n_total_obs) as n_total_obs,
       (nw_mean_test(array_agg(zdiff order by as_of_date), 0)).*
from per_date
group by profile_version, period;
