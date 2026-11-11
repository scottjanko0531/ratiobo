-- TEST 7 v2 (trial_id=20): Regime Split, redone against RatioBo's own
-- regime tables (round 2 corrective -- no price-based bull/bear proxy).
--
-- Primary cut: mc_signal_log.tier (verified: 5-level ordinal, clean 1:1 map
-- to exposure_multiplier -- FULL=1.0, NORMAL=0.8, CAUTIOUS=0.6,
-- DEFENSIVE=0.4, RISK_OFF=0.25). Favorable = tier in (FULL,NORMAL)
-- (exposure_multiplier>=0.8); unfavorable = tier in (CAUTIOUS,DEFENSIVE,RISK_OFF).
-- Each monthly as_of_date as-of-joined to the most recent mc_signal_log.date
-- <= as_of_date.
--
-- Secondary cut: macro_regime_history.market_key (verified: 90 quarterly
-- rows 2004-2026, 4-level growth/inflation quadrant: rg_ri, rg_fi, fg_ri,
-- fg_fi). Each as_of_date as-of-joined to the most recent period_date <=
-- as_of_date.
--
-- For each profile_version/period/bucket: Q5-Q1 spread (test 2 methodology)
-- AND rule_breaker_pass spread (test 3 methodology), 1m horizon, NW HAC
-- t-stat lag=0 (within-bucket months not necessarily contiguous), gross and
-- net of costs. Episode counts (months per bucket) reported explicitly as
-- their own result rows -- descriptive only given small counts in some
-- buckets, stated plainly in the report.

set statement_timeout = '5min';

-- Episode counts per bucket (profile-independent; computed once).
with months as (
  select distinct as_of_date,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period
  from scr_scores
  where as_of_date >= '2017-01-01' and as_of_date <= '2023-12-31' and profile_version = 'a_v1_hist'
),
tagged as (
  select m.as_of_date, m.period,
    (select tier from mc_signal_log s where s.date <= m.as_of_date order by s.date desc limit 1) as mc_tier,
    (select market_key from macro_regime_history r where r.period_date <= m.as_of_date order by r.period_date desc limit 1) as macro_key
  from months m
),
classified as (
  select *,
    case when mc_tier in ('FULL','NORMAL') then 'favorable' else 'unfavorable' end as mc_favorable
  from tagged
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 20, 'regime_episode_counts', 'all_profiles', period,
  jsonb_build_object('mc_favorable', mc_favorable, 'macro_key', macro_key, 'n_months', n)
from (
  select period, mc_favorable, macro_key, count(*) as n
  from classified
  group by period, mc_favorable, macro_key
) x;

-- Per-profile Q5-Q1 and rule_breaker spreads, by mc_favorable bucket.
with universe as (
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
regime_tag as (
  select distinct as_of_date,
    case when (select tier from mc_signal_log s where s.date <= u.as_of_date order by s.date desc limit 1) in ('FULL','NORMAL')
         then 'favorable' else 'unfavorable' end as mc_favorable
  from universe u
),
flagged as (
  select u.*, rt.mc_favorable,
         f.ret_1m,
         case
           when u.profile_version = 'b_v1' then
             (ntile(5) over (partition by u.profile_version, u.as_of_date, u.filt order by u.score) = 5)
           else coalesce(u.rule_breaker_pass, false)
         end as is_rb_pass,
         ntile(5) over (partition by u.profile_version, u.as_of_date, u.filt order by u.score) as q
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  join regime_tag rt on rt.as_of_date = u.as_of_date
),
per_date as (
  select profile_version, period, as_of_date, filt, mc_favorable,
         avg(ret_1m) filter (where q=5) - avg(ret_1m) filter (where q=1) as q5q1_spread,
         avg(ret_1m) filter (where is_rb_pass) - avg(ret_1m) filter (where not is_rb_pass) as rb_spread
  from flagged
  group by 1,2,3,4,5
),
agg as (
  select profile_version, period, filt, mc_favorable, 'q5_q1'::text as metric,
    (nw_mean_test(array_agg(q5q1_spread order by as_of_date), 0)).*
  from per_date where q5q1_spread is not null group by 1,2,3,4
  union all
  select profile_version, period, filt, mc_favorable, 'rule_breaker',
    (nw_mean_test(array_agg(rb_spread order by as_of_date), 0)).*
  from per_date where rb_spread is not null group by 1,2,3,4
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 20, 'regime_split_spread', profile_version, period,
  jsonb_build_object(
    'filt', filt, 'mc_favorable', mc_favorable, 'metric', metric,
    'n_months', n, 'effective_n', n, 'nw_se', nw_se, 'gross_t_stat', t_stat,
    'cost_bps_per_side', cost_bps,
    'gross_mean_spread', mean_val,
    'net_mean_spread', mean_val - 4*cost_bps/10000.0,
    'net_t_stat', (mean_val - 4*cost_bps/10000.0) / nullif(nw_se,0)
  )
from (select *, case when profile_version='b_v1' then 25 else 10 end as cost_bps from agg) z;
