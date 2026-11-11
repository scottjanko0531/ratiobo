-- TEST 6 v2 (trial_id=19): Fama-French + Momentum Factor Check, FULL loadings
-- Round 2: adds a_v1_hist_ff12; adds momentum factor (UMD, Carhart 4-factor:
-- Mkt-RF, SMB, HML, UMD); reports FULL loadings (not just alpha/R2),
-- specifically to assess whether a_growth's 2022-23 validation reversal is
-- explained by a negative HML (value) loading during a growth-underperforms
-- stretch, or is genuine sign-level alpha decay. Momentum factor loaded into
-- ff3_factors.umd this round (Ken French F-F_Momentum_Factor.csv,
-- pre-filtered to 2017-01..2023-12 before any other row read, same
-- holdout-safety discipline as the original FF3 download).
--
-- Step 1 (this file): pull the monthly 1m-horizon GROSS Q5-Q1 spread per
-- profile_version x period (filt='all' only -- test 6/7's round-1
-- methodology also used filt='all' as the headline and excl_review as a
-- robustness check; round 2 keeps that pattern) joined to Mkt-RF/SMB/HML/UMD.
-- This result overflows the tool's per-call size limit with 5 profiles, so
-- it is saved to a local overflow file and parsed via Python without ever
-- entering the orchestrating context (same pattern as round 1).

set statement_timeout = '5min';

with universe as (
  select company_id, as_of_date, profile_version, score,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period
  from scr_scores
  where as_of_date <= '2023-12-31'
    and profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','a_v1_hist_ff12','b_v1')
),
ranked as (
  select *, ntile(5) over (partition by profile_version, as_of_date order by score) as q
  from universe
),
joined as (
  select r.*, f.ret_1m
  from ranked r
  join scr_fwd_ret_mat f on f.company_id = r.company_id and f.as_of_date = r.as_of_date
),
per_date as (
  select profile_version, period, as_of_date,
         avg(ret_1m) filter (where q = 5) as q5,
         avg(ret_1m) filter (where q = 1) as q1
  from joined
  group by 1, 2, 3
)
select pd.profile_version, pd.period, pd.as_of_date, (pd.q5 - pd.q1) as spread_1m,
       ff.mkt_rf, ff.smb, ff.hml, ff.umd
from per_date pd
join ff3_factors ff on ff.month_start = date_trunc('month', pd.as_of_date)
order by 1, 2, 3;
