-- TEST 6 (trial_id=11): Fama-French 3-Factor Check
-- Pre-registration: scr_trials.id=11
--
-- Step 1: pull the monthly Q5-Q1 1m-horizon GROSS spread (from Test 2's quintile
-- construction) joined to the FF3 monthly factors, for each profile_version x period,
-- for both needs_review filters ("all" and "excl_review"). Run once per filter value
-- (the "all" pull below; the "excl_review" variant is identical except the
-- `needs_review = false` predicate is applied inside the `universe` CTE and the ff3
-- join is unchanged).
--
-- ff3_factors(month_start date primary key, mkt_rf, smb, hml, rf, trailing12_mkt_rf)
-- was loaded once from the official Ken French Dartmouth data library
-- (F-F_Research_Data_Factors.csv), pre-filtered via awk to 2017-01..2023-12 before any
-- other row of the source file was read, per the holdout-safety discipline documented
-- in scr_job_runs / scr_trials.id=11.

-- ===== "all" variant =====
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
       ff.mkt_rf, ff.smb, ff.hml, ff.trailing12_mkt_rf
from per_date pd
join ff3_factors ff on ff.month_start = date_trunc('month', pd.as_of_date)
order by 1, 2, 3;

-- Step 2 (Python, statsmodels): for each (profile_version, period), regress spread_1m
-- on a constant + mkt_rf + smb + hml via OLS with HAC (Newey-West) covariance,
-- maxlags=1, matching the pre-registered se_method. See the trial's committed
-- analysis notebook-equivalent below (inlined here since no separate script file was
-- kept):
--
--   import statsmodels.api as sm
--   X = sm.add_constant(sub[['mkt_rf','smb','hml']].values)
--   model = sm.OLS(sub['spread_1m'].values, X).fit(cov_type='HAC', cov_kwds={'maxlags': 1})
--   alpha, beta_mkt, beta_smb, beta_hml = model.params
--   t_alpha, t_mkt, t_smb, t_hml = model.tvalues
--   r2 = model.rsquared
--
-- Step 3: insert alpha/betas/t-stats/R^2 (gross, filt='all'|'excl_review') into
-- scr_results(trial_id=11, result_key='ff3_regression', profile_version, period, value jsonb).
