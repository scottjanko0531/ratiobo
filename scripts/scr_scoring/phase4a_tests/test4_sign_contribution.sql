-- TEST 4 (trial_id=9): Sign-level Contribution
-- Pre-registration: scr_trials.id=9
--
-- POST-HOC RECONSTRUCTION -- see README.md. Spot-checked against the stored
-- scr_results row for (a_v1_hist, development, sign2, filt=all):
-- stored mean_corr=0.0780103860445272, nw_se=0.027979731835203, t_stat=2.78810342086187.
--
-- SPOT-CHECK RESULT: the mean_corr point estimate reproduces EXACTLY
-- (0.0780103860445272, confirming the per-date point-biserial correlation step below
-- is correct), but applying nw_mean_test(..., lag=0) to that per-date series gives
-- nw_se=0.0119703834962426 / t_stat=6.51694960892555 -- NOT a match to the stored
-- nw_se/t_stat. The original run's standard-error derivation for this test could not
-- be recovered; it produced a standard error roughly 2.3x larger than the naive
-- NW(lag=0)-on-the-correlation-series approach below, consistent with a genuinely
-- different (and unrecovered) cluster-robust-by-date SE construction, not merely a
-- different lag or degrees-of-freedom convention. Treat the mean_corr values in
-- scr_results as reconstructed-and-confirmed; treat the nw_se/t_stat/p-value values in
-- scr_results as from the original run only, not independently re-derived here.
--
-- DISCLOSED METHODOLOGY DEVIATION (per original pre-registration note, carried
-- forward here): a full panel logistic regression with cluster-robust-by-date SEs
-- would require transferring tens of thousands of row-level observations out of the
-- database into an orchestrating process. Substituted with an equivalent point-biserial
-- correlation between each standardized predictor and the binary outcome
-- (ret_12m > that date's cross-sectional median), computed per as_of_date, then
-- aggregated across dates via NW HAC (lag=0, consistent with the cluster-robust-by-date
-- intent -- each date contributes one independent cross-sectional estimate).
--
-- For a_v1_hist/a_v1_hist_rd/a_v1_hist_qqq_gate: predictors sign1, sign2, sign3, sign6
-- (z-scored within each as_of_date before correlating). For b_v1: predictors
-- factor_fcf_yield, factor_size, factor_price_book, factor_trailing_pe,
-- factor_drawdown_recovery, factor_growth_discipline, factor_profitability.

with universe as (
  select company_id, as_of_date, profile_version,
         sign1, sign2, sign3, sign6,
         factor_fcf_yield, factor_size, factor_price_book, factor_trailing_pe,
         factor_drawdown_recovery, factor_growth_discipline, factor_profitability,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period
  from scr_scores
  where as_of_date <= '2023-12-31'
    and profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','b_v1')
    -- excl_review variant adds: and needs_review = false
),
joined as (
  select u.*, f.ret_12m
  from universe u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  where f.ret_12m is not null
),
labeled as (
  select *,
         (percent_rank() over (partition by profile_version, as_of_date order by ret_12m) > 0.5)::int as y
  from joined
),
per_date_a as (
  -- a_growth predictors: point-biserial = Pearson corr(predictor, y), predictor
  -- z-scoring is a no-op for a single-date Pearson correlation (location/scale
  -- invariant), so corr() is applied directly to the raw sign columns.
  select profile_version, period, as_of_date,
         corr(sign1, y) as c_sign1, corr(sign2, y) as c_sign2,
         corr(sign3, y) as c_sign3, corr(sign6, y) as c_sign6
  from labeled
  where profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate')
  group by 1, 2, 3
),
per_date_b as (
  select period, as_of_date,
         corr(factor_fcf_yield, y) as c_fcf_yield, corr(factor_size, y) as c_size,
         corr(factor_price_book, y) as c_price_book, corr(factor_trailing_pe, y) as c_trailing_pe,
         corr(factor_drawdown_recovery, y) as c_drawdown_recovery,
         corr(factor_growth_discipline, y) as c_growth_discipline,
         corr(factor_profitability, y) as c_profitability
  from labeled
  where profile_version = 'b_v1'
  group by 1, 2
)
select profile_version, period, 'sign1'::text as predictor,
       (nw_mean_test(array_agg(c_sign1 order by as_of_date), 0)).*
from per_date_a where c_sign1 is not null group by 1, 2
union all
select profile_version, period, 'sign2', (nw_mean_test(array_agg(c_sign2 order by as_of_date), 0)).*
from per_date_a where c_sign2 is not null group by 1, 2
union all
select profile_version, period, 'sign3', (nw_mean_test(array_agg(c_sign3 order by as_of_date), 0)).*
from per_date_a where c_sign3 is not null group by 1, 2
union all
select profile_version, period, 'sign6', (nw_mean_test(array_agg(c_sign6 order by as_of_date), 0)).*
from per_date_a where c_sign6 is not null group by 1, 2
union all
select 'b_v1', period, 'factor_fcf_yield', (nw_mean_test(array_agg(c_fcf_yield order by as_of_date), 0)).*
from per_date_b where c_fcf_yield is not null group by 1
union all
select 'b_v1', period, 'factor_size', (nw_mean_test(array_agg(c_size order by as_of_date), 0)).*
from per_date_b where c_size is not null group by 1
union all
select 'b_v1', period, 'factor_price_book', (nw_mean_test(array_agg(c_price_book order by as_of_date), 0)).*
from per_date_b where c_price_book is not null group by 1
union all
select 'b_v1', period, 'factor_trailing_pe', (nw_mean_test(array_agg(c_trailing_pe order by as_of_date), 0)).*
from per_date_b where c_trailing_pe is not null group by 1
union all
select 'b_v1', period, 'factor_drawdown_recovery', (nw_mean_test(array_agg(c_drawdown_recovery order by as_of_date), 0)).*
from per_date_b where c_drawdown_recovery is not null group by 1
union all
select 'b_v1', period, 'factor_growth_discipline', (nw_mean_test(array_agg(c_growth_discipline order by as_of_date), 0)).*
from per_date_b where c_growth_discipline is not null group by 1
union all
select 'b_v1', period, 'factor_profitability', (nw_mean_test(array_agg(c_profitability order by as_of_date), 0)).*
from per_date_b where c_profitability is not null group by 1;
