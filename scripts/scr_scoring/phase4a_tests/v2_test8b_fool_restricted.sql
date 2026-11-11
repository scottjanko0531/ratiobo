-- TEST 8b v2 (trial_id=22): "A-Fool" Rule-Breaker-picks-restricted comparison (NEW)
--
-- Per explicit coordinator correction: "A-fool" means the actual Motley
-- Fool Rule Breaker picks tracked by RatioBo, not a full-universe naive
-- baseline (that baseline is kept separately, see v2_test8a). Schema
-- verified directly this round (not assumed): scr_universe_history has
-- source='rb_fool_recs' (confirmed -- it is the ONLY source value in the
-- table), columns company_id/added_date/source_rec_id (210 rows total,
-- added_date spans 2005-01-18 to 2026-10-20). scr_universe_closed_events
-- tracks closures, joined by source_rec_id (company_id/closed_date).
--
-- SURVIVOR-BIAS FINDING (verified, not assumed): both tables were
-- populated in a SINGLE backfill batch on 2026-11-05 (all 210 add-rows,
-- all 43 close-rows share that created_at day). The close-events table's
-- closed_date ranges ONLY from 2025-07-29 to 2026-10-23 -- there is NO
-- closure data before 2025-07-29 at all. This means any as_of_date before
-- 2025-07-29 that computes "active Fool picks" via
-- (added_date <= as_of_date AND no closed_events match) will systematically
-- treat picks that were ADDED AND FULLY CLOSED OUT before 2025-07-29 as
-- still active (since their closure, if any, predates the tracked window
-- and is invisible) -- a genuine survivorship-type look-ahead bias.
-- CONFIRMS the coordinator-relayed "~July 2025" cutoff; exact date 2025-07-29.
--
-- CONSEQUENCE: both pre-registered periods (development 2017-2021,
-- validation 2022-2023) are ENTIRELY before 2025-07-29, so every row this
-- test produces for both periods is survivor-biased per the above. This is
-- disclosed prominently in the committed report, not just here -- this
-- test cannot currently produce a bias-free reading for either
-- pre-registered period; it is descriptive/exploratory only, per
-- coordinator's own framing for small-sample regime results.
--
-- Methodology (same as test 3): rule_breaker_pass=true vs rest spread,
-- restricted to companies with an active Fool rec that date. b_v1 keeps its
-- test-3 proxy (Q5 vs rest), also restricted to the Fool-picks universe
-- (even though b_v1 is not itself a Rule-Breaker-style profile, this keeps
-- the comparison internally consistent with test 3's own proxy choice).

set statement_timeout = '5min';

with fool_episodes as (
  select h.company_id, h.added_date,
         coalesce(
           (select min(c.closed_date) from scr_universe_closed_events c where c.source_rec_id = h.source_rec_id),
           '9999-12-31'::date
         ) as closed_date
  from scr_universe_history h
  where h.source = 'rb_fool_recs'
),
universe as (
  select company_id, as_of_date, profile_version, score, rule_breaker_pass,
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
fool_restricted as (
  select u.*
  from universe u
  where exists (
    select 1 from fool_episodes fe
    where fe.company_id = u.company_id
      and fe.added_date <= u.as_of_date
      and fe.closed_date > u.as_of_date
  )
),
flagged as (
  select u.*, f.ret_1m, f.ret_3m, f.ret_6m, f.ret_12m, f.ret_36m,
         case
           when u.profile_version = 'b_v1' then
             (ntile(5) over (partition by u.profile_version, u.as_of_date, u.filt order by u.score) = 5)
           else coalesce(u.rule_breaker_pass, false)
         end as is_pass
  from fool_restricted u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
),
per_date as (
  select profile_version, period, as_of_date, filt,
         count(*) as n_fool_universe,
         count(*) filter (where is_pass) as n_pass,
         avg(ret_1m)  filter (where is_pass) - avg(ret_1m)  filter (where not is_pass) as spread_1m,
         avg(ret_12m) filter (where is_pass) - avg(ret_12m) filter (where not is_pass) as spread_12m
  from flagged
  group by 1, 2, 3, 4
),
agg as (
  select profile_version, period, filt, '1m'::text as horizon,
    sum(n_fool_universe) as total_universe_obs, avg(n_fool_universe) as avg_universe_per_date,
    (nw_mean_test(array_agg(spread_1m order by as_of_date), 0)).*
  from per_date where spread_1m is not null and n_pass > 0 and n_pass < n_fool_universe group by 1,2,3
  union all
  select profile_version, period, filt, '12m',
    sum(n_fool_universe), avg(n_fool_universe),
    (nw_mean_test(array_agg(spread_12m order by as_of_date), 11)).*
  from per_date where spread_12m is not null and n_pass > 0 and n_pass < n_fool_universe group by 1,2,3
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 22, 'fool_restricted_spread', profile_version, period,
  jsonb_build_object(
    'filt', filt, 'horizon', horizon, 'n_dates', n, 'effective_n', n,
    'avg_universe_per_date', avg_universe_per_date, 'total_universe_obs', total_universe_obs,
    'nw_se', nw_se, 't_stat', t_stat, 'mean_spread', mean_val,
    'survivor_biased', true, 'survivor_bias_cutoff', '2025-07-29',
    'is_proxy', (profile_version = 'b_v1')
  )
from agg;
