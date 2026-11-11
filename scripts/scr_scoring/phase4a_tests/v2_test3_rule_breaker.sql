-- TEST 3 v2 (trial_id=16): Rule Breaker Test
-- Round 2: adds a_v1_hist_ff12. Literal query executed this round.
-- b_v1 has no rule_breaker_pass concept -> documented PROXY: Q5 vs rest.

set statement_timeout = '5min';

with universe as (
  select company_id, as_of_date, profile_version, score, rule_breaker_pass,
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
flagged as (
  select u.*, f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m,
         case
           when u.profile_version = 'b_v1' then
             (ntile(5) over (partition by u.profile_version, u.as_of_date, u.filt order by u.score) = 5)
           else coalesce(u.rule_breaker_pass, false)
         end as is_pass
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
),
per_date as (
  select profile_version, period, as_of_date, filt,
         avg(ret_1m)  filter (where is_pass) - avg(ret_1m)  filter (where not is_pass) as spread_1m,
         avg(ret_3m)  filter (where is_pass) - avg(ret_3m)  filter (where not is_pass) as spread_3m,
         avg(ret_6m)  filter (where is_pass) - avg(ret_6m)  filter (where not is_pass) as spread_6m,
         avg(ret_12m) filter (where is_pass) - avg(ret_12m) filter (where not is_pass) as spread_12m,
         avg(ret_36m) filter (where is_pass) - avg(ret_36m) filter (where not is_pass) as spread_36m
  from flagged
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
select 16, 'rule_breaker_spread', profile_version, period,
  jsonb_build_object(
    'filt', filt, 'horizon', horizon, 'n_dates', n, 'effective_n', n,
    'nw_se', nw_se, 't_stat', t_stat, 'mean_spread', mean_val,
    'is_proxy', (profile_version = 'b_v1')
  )
from agg;
