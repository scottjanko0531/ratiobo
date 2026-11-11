-- TEST 1 v2 (trial_id=14): Information Coefficients
-- Round 2 corrective pass: adds a_v1_hist_ff12 (omitted from round 1).
-- Methodology unchanged from round 1 (verified exact-match reconstruction):
-- per as_of_date, Spearman rank correlation (rank()+corr() on ranks) between
-- score and forward return per horizon; NW HAC mean/t-stat across the
-- monthly series, lag=horizon_months-1. Literal query executed this round.

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
joined as (
  select u.*, f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
),
ranked as (
  select profile_version, period, as_of_date, filt,
         rank() over (partition by profile_version, as_of_date, filt order by score) as score_rank,
         rank() over (partition by profile_version, as_of_date, filt order by ret_1m)  as r1,
         rank() over (partition by profile_version, as_of_date, filt order by ret_3m)  as r3,
         rank() over (partition by profile_version, as_of_date, filt order by ret_6m)  as r6,
         rank() over (partition by profile_version, as_of_date, filt order by ret_12m) as r12,
         rank() over (partition by profile_version, as_of_date, filt order by ret_36m) as r36
  from joined
),
ic_by_date as (
  select profile_version, period, as_of_date, filt,
         corr(score_rank, r1)  as ic_1m,
         corr(score_rank, r3)  as ic_3m,
         corr(score_rank, r6)  as ic_6m,
         corr(score_rank, r12) as ic_12m,
         corr(score_rank, r36) as ic_36m
  from ranked
  group by 1, 2, 3, 4
),
agg as (
  select profile_version, period, filt, '1m'::text as horizon, (nw_mean_test(array_agg(ic_1m order by as_of_date), 0)).*
  from ic_by_date where ic_1m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '3m', (nw_mean_test(array_agg(ic_3m order by as_of_date), 2)).*
  from ic_by_date where ic_3m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '6m', (nw_mean_test(array_agg(ic_6m order by as_of_date), 5)).*
  from ic_by_date where ic_6m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '12m', (nw_mean_test(array_agg(ic_12m order by as_of_date), 11)).*
  from ic_by_date where ic_12m is not null group by 1,2,3
  union all
  select profile_version, period, filt, '36m', (nw_mean_test(array_agg(ic_36m order by as_of_date), 35)).*
  from ic_by_date where ic_36m is not null group by 1,2,3
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 14, 'information_coefficient', profile_version, period,
  jsonb_build_object(
    'filt', filt, 'horizon', horizon, 'mean_ic', mean_val, 'nw_se', nw_se, 't_stat', t_stat,
    'n_dates', n, 'effective_n', n
  )
from agg;
