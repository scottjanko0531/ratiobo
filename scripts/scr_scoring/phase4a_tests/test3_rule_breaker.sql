-- TEST 3 (trial_id=8): Rule Breaker Test across 4 profile_versions
-- Pre-registration: scr_trials.id=8
--
-- POST-HOC RECONSTRUCTION -- see README.md. Spot-checked against the stored
-- scr_results row for (a_v1_hist, development, 12m, filt=all):
-- stored mean_spread=0.0669613169111962, t_stat=1.28290034352938, n_dates=60.
--
-- For a_v1_hist / a_v1_hist_rd / a_v1_hist_qqq_gate: literal rule_breaker_pass
-- boolean column on scr_scores. For b_v1 (no such column -- not a Rule-Breaker growth
-- profile): documented PROXY = top score quintile (Q5) vs the rest.

with universe as (
  select company_id, as_of_date, profile_version, score, rule_breaker_pass,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period
  from scr_scores
  where as_of_date <= '2023-12-31'
    and profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','b_v1')
    -- excl_review variant adds: and needs_review = false
),
flagged as (
  select u.*, f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m,
         case
           when u.profile_version = 'b_v1' then
             (ntile(5) over (partition by u.profile_version, u.as_of_date order by u.score) = 5)
           else coalesce(u.rule_breaker_pass, false)
         end as is_pass
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
),
per_date as (
  select profile_version, period, as_of_date,
         (bool_or(profile_version = 'b_v1'))::boolean as is_proxy,
         avg(ret_1m)  filter (where is_pass) - avg(ret_1m)  filter (where not is_pass) as spread_1m,
         avg(ret_3m)  filter (where is_pass) - avg(ret_3m)  filter (where not is_pass) as spread_3m,
         avg(ret_6m)  filter (where is_pass) - avg(ret_6m)  filter (where not is_pass) as spread_6m,
         avg(ret_12m) filter (where is_pass) - avg(ret_12m) filter (where not is_pass) as spread_12m,
         avg(ret_36m) filter (where is_pass) - avg(ret_36m) filter (where not is_pass) as spread_36m
  from flagged
  group by profile_version, period, as_of_date
)
select profile_version, period, bool_and(is_proxy) as is_proxy, '1m'::text as horizon,
       (nw_mean_test(array_agg(spread_1m order by as_of_date), 0)).*
from per_date where spread_1m is not null group by 1, 2
union all
select profile_version, period, bool_and(is_proxy), '3m',
       (nw_mean_test(array_agg(spread_3m order by as_of_date), 2)).*
from per_date where spread_3m is not null group by 1, 2
union all
select profile_version, period, bool_and(is_proxy), '6m',
       (nw_mean_test(array_agg(spread_6m order by as_of_date), 5)).*
from per_date where spread_6m is not null group by 1, 2
union all
select profile_version, period, bool_and(is_proxy), '12m',
       (nw_mean_test(array_agg(spread_12m order by as_of_date), 11)).*
from per_date where spread_12m is not null group by 1, 2
union all
select profile_version, period, bool_and(is_proxy), '36m',
       (nw_mean_test(array_agg(spread_36m order by as_of_date), 35)).*
from per_date where spread_36m is not null group by 1, 2;
