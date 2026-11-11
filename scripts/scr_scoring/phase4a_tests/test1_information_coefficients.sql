-- TEST 1 (trial_id=6): Information Coefficients
-- Pre-registration: scr_trials.id=6
--
-- POST-HOC RECONSTRUCTION -- see README.md in this directory for why. Spot-checked
-- against the already-stored scr_results rows for (a_v1_hist, development, 12m,
-- filt=all): stored mean_ic=0.00210731763369252, t_stat=0.0281502997552033, n_dates=60.
--
-- Methodology: per as_of_date, cross-sectional Spearman rank correlation between
-- `score` and the forward return for that horizon; then NW HAC mean/t-stat across the
-- monthly IC series, lag = horizon_months - 1.
--
-- Spearman = Pearson correlation of within-date ranks. Ties broken by average rank
-- (rank_avg below) to match the standard Spearman definition.

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
  select u.*, f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
),
ranked as (
  select profile_version, period, as_of_date,
         rank() over (partition by profile_version, as_of_date order by score) as score_rank,
         rank() over (partition by profile_version, as_of_date order by ret_1m)  as r1,
         rank() over (partition by profile_version, as_of_date order by ret_3m)  as r3,
         rank() over (partition by profile_version, as_of_date order by ret_6m)  as r6,
         rank() over (partition by profile_version, as_of_date order by ret_12m) as r12,
         rank() over (partition by profile_version, as_of_date order by ret_36m) as r36
  from joined
),
ic_by_date as (
  select profile_version, period, as_of_date,
         corr(score_rank, r1)  as ic_1m,
         corr(score_rank, r3)  as ic_3m,
         corr(score_rank, r6)  as ic_6m,
         corr(score_rank, r12) as ic_12m,
         corr(score_rank, r36) as ic_36m
  from ranked
  group by 1, 2, 3
)
select profile_version, period, '1m'::text as horizon,
       (nw_mean_test(array_agg(ic_1m order by as_of_date), 0)).*
from ic_by_date where ic_1m is not null group by 1, 2
union all
select profile_version, period, '3m',
       (nw_mean_test(array_agg(ic_3m order by as_of_date), 2)).*
from ic_by_date where ic_3m is not null group by 1, 2
union all
select profile_version, period, '6m',
       (nw_mean_test(array_agg(ic_6m order by as_of_date), 5)).*
from ic_by_date where ic_6m is not null group by 1, 2
union all
select profile_version, period, '12m',
       (nw_mean_test(array_agg(ic_12m order by as_of_date), 11)).*
from ic_by_date where ic_12m is not null group by 1, 2
union all
select profile_version, period, '36m',
       (nw_mean_test(array_agg(ic_36m order by as_of_date), 35)).*
from ic_by_date where ic_36m is not null group by 1, 2;

-- Result columns map to scr_results.value: mean_val->mean_ic, nw_se->nw_se,
-- t_stat->t_stat, n->n_dates (plus filt, horizon carried as literals/group keys).
