-- TEST 4 v2 (trial_id=17): Sign-level Contribution
-- Round 2 CORRECTIVE: real executed code, not reconstruction. Adds a_v1_hist_ff12.
--
-- METHODOLOGY FIX (coordinator item 6): fitted as a genuine MULTIVARIATE
-- per-date regression (Fama-MacBeth), not independent univariate
-- point-biserial correlations per predictor (the superseded round-1
-- reconstruction's approach, which reproduced point estimates exactly but
-- not standard errors -- a marginal correlation and a joint-model
-- coefficient diverge whenever predictors are mutually correlated, which
-- sign1-3/sign6 and the 7 b_v1 factors plausibly are).
--
-- Per as_of_date: fit OLS (linear probability model -- disclosed substitute
-- for logistic regression, closed-form solvable via the plpgsql
-- normal-equations solver fm_ols_coef2 below, so row-level panel data never
-- needs to leave the database) of indicator(ret_12m > that date's
-- cross-sectional median) on [intercept, z-scored predictors] jointly.
-- Collect each coefficient's per-date series, aggregate via Newey-West HAC
-- (lag=0) across dates -- the standard Fama-MacBeth construction for
-- cluster-robust-by-date inference. effective_n = n_dates (independent
-- cross-sectional fits), explicitly NOT raw row count.
--
-- Listwise deletion (ALL predictors must be non-null that date) applies --
-- this reduces the usable per-date n well below the `score`-based n used in
-- test 1 (score tolerates partial sign availability; a joint regression
-- cannot). Disclosed, not hidden.

set statement_timeout = '5min';

-- normal-equations OLS solver: design is an (n x p) 2D array, y is length n.
-- Returns p coefficients (first is the intercept, since column 1 of design
-- is always 1). Already created and unit-tested earlier this round:
--   select fm_ols_coef2(array[[1,2],[1,3],[1,4],[1,5]]::double precision[], array[3,5,7,9]::double precision[]);
--   -> [-1, 2]  (exact recovery of y = -1 + 2x)
-- Definition reproduced here for the commit record:
create or replace function fm_ols_coef2(design double precision[], y double precision[])
returns double precision[]
language plpgsql
as $$
declare
  n int := array_length(y,1);
  p int := array_length(design,2);
  xtx double precision[][];
  xty double precision[];
  aug double precision[][];
  i int; j int; k int; r int;
  factor double precision;
  tmp double precision;
  coef double precision[];
begin
  if n is null or p is null or n < p then return null; end if;
  xtx := array_fill(0::double precision, array[p,p]);
  xty := array_fill(0::double precision, array[p]);
  for r in 1..n loop
    for i in 1..p loop
      xty[i] := xty[i] + design[r][i] * y[r];
      for j in 1..p loop
        xtx[i][j] := xtx[i][j] + design[r][i] * design[r][j];
      end loop;
    end loop;
  end loop;
  aug := array_fill(0::double precision, array[p, p+1]);
  for i in 1..p loop
    for j in 1..p loop
      aug[i][j] := xtx[i][j];
    end loop;
    aug[i][p+1] := xty[i];
  end loop;
  for k in 1..p loop
    if abs(aug[k][k]) < 1e-9 then
      for r in (k+1)..p loop
        if abs(aug[r][k]) > 1e-9 then
          for j in 1..(p+1) loop
            tmp := aug[k][j]; aug[k][j] := aug[r][j]; aug[r][j] := tmp;
          end loop;
          exit;
        end if;
      end loop;
    end if;
    if abs(aug[k][k]) < 1e-9 then
      return null;
    end if;
    factor := aug[k][k];
    for j in 1..(p+1) loop
      aug[k][j] := aug[k][j] / factor;
    end loop;
    for r in 1..p loop
      if r != k then
        factor := aug[r][k];
        for j in 1..(p+1) loop
          aug[r][j] := aug[r][j] - factor * aug[k][j];
        end loop;
      end if;
    end loop;
  end loop;
  coef := array_fill(0::double precision, array[p]);
  for i in 1..p loop
    coef[i] := aug[i][p+1];
  end loop;
  return coef;
end;
$$;

-- ===== a_growth profiles: predictors = sign1, sign2, sign3, sign6 =====
with universe_a as (
  select company_id, as_of_date, profile_version, sign1, sign2, sign3, sign6,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period,
         filt.f as filt
  from scr_scores a
  cross join (values ('all'), ('excl_review')) as filt(f)
  where a.as_of_date >= '2017-01-01' and a.as_of_date <= '2023-12-31'
    and a.profile_version in ('a_v1_hist','a_v1_hist_rd','a_v1_hist_qqq_gate','a_v1_hist_ff12')
    and (filt.f = 'all' or a.needs_review = false)
    and a.sign1 is not null and a.sign2 is not null and a.sign3 is not null and a.sign6 is not null
),
joined_a as (
  select u.*, f.ret_12m
  from universe_a u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  where f.ret_12m is not null
),
z_a as (
  select profile_version, period, as_of_date, filt,
    (sign1 - avg(sign1) over (partition by profile_version, as_of_date, filt)) / stddev_pop(sign1) over (partition by profile_version, as_of_date, filt) as z1,
    (sign2 - avg(sign2) over (partition by profile_version, as_of_date, filt)) / stddev_pop(sign2) over (partition by profile_version, as_of_date, filt) as z2,
    (sign3 - avg(sign3) over (partition by profile_version, as_of_date, filt)) / stddev_pop(sign3) over (partition by profile_version, as_of_date, filt) as z3,
    (sign6 - avg(sign6) over (partition by profile_version, as_of_date, filt)) / stddev_pop(sign6) over (partition by profile_version, as_of_date, filt) as z6,
    case when percent_rank() over (partition by profile_version, as_of_date, filt order by ret_12m) > 0.5 then 1.0 else 0.0 end as y
  from joined_a
),
per_date_a as (
  select profile_version, period, as_of_date, filt,
    fm_ols_coef2(array_agg(array[1,z1,z2,z3,z6]), array_agg(y)) as coef,
    count(*) as n_obs
  from z_a
  where z1 is not null and z2 is not null and z3 is not null and z6 is not null
  group by 1,2,3,4
),
agg_a as (
  select profile_version, period, filt,
    (nw_mean_test(array_agg(coef[1] order by as_of_date), 0)).mean_val as b0_mean, (nw_mean_test(array_agg(coef[1] order by as_of_date), 0)).nw_se as b0_se, (nw_mean_test(array_agg(coef[1] order by as_of_date), 0)).t_stat as b0_t,
    (nw_mean_test(array_agg(coef[2] order by as_of_date), 0)).mean_val as b1_mean, (nw_mean_test(array_agg(coef[2] order by as_of_date), 0)).nw_se as b1_se, (nw_mean_test(array_agg(coef[2] order by as_of_date), 0)).t_stat as b1_t,
    (nw_mean_test(array_agg(coef[3] order by as_of_date), 0)).mean_val as b2_mean, (nw_mean_test(array_agg(coef[3] order by as_of_date), 0)).nw_se as b2_se, (nw_mean_test(array_agg(coef[3] order by as_of_date), 0)).t_stat as b2_t,
    (nw_mean_test(array_agg(coef[4] order by as_of_date), 0)).mean_val as b3_mean, (nw_mean_test(array_agg(coef[4] order by as_of_date), 0)).nw_se as b3_se, (nw_mean_test(array_agg(coef[4] order by as_of_date), 0)).t_stat as b3_t,
    (nw_mean_test(array_agg(coef[5] order by as_of_date), 0)).mean_val as b6_mean, (nw_mean_test(array_agg(coef[5] order by as_of_date), 0)).nw_se as b6_se, (nw_mean_test(array_agg(coef[5] order by as_of_date), 0)).t_stat as b6_t,
    count(*) as n_dates, avg(n_obs) as avg_n_obs
  from per_date_a
  where coef is not null
  group by 1,2,3
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 17, 'fama_macbeth_coef', profile_version, period, jsonb_build_object(
  'filt', filt, 'n_dates', n_dates, 'effective_n', n_dates, 'avg_n_obs_per_date', avg_n_obs,
  'intercept', jsonb_build_object('coef', b0_mean, 'se', b0_se, 't_stat', b0_t),
  'sign1', jsonb_build_object('coef', b1_mean, 'se', b1_se, 't_stat', b1_t),
  'sign2', jsonb_build_object('coef', b2_mean, 'se', b2_se, 't_stat', b2_t),
  'sign3', jsonb_build_object('coef', b3_mean, 'se', b3_se, 't_stat', b3_t),
  'sign6', jsonb_build_object('coef', b6_mean, 'se', b6_se, 't_stat', b6_t)
)
from agg_a;

-- ===== b_v1: predictors = 7 factors =====
with universe_b as (
  select company_id, as_of_date,
         factor_fcf_yield, factor_size, factor_price_book, factor_trailing_pe,
         factor_drawdown_recovery, factor_growth_discipline, factor_profitability,
         case when as_of_date <= '2021-12-31' then 'development'
              when as_of_date <= '2023-12-31' then 'validation'
              else 'holdout' end as period,
         filt.f as filt
  from scr_scores a
  cross join (values ('all'), ('excl_review')) as filt(f)
  where a.as_of_date >= '2017-01-01' and a.as_of_date <= '2023-12-31' and a.profile_version = 'b_v1'
    and (filt.f = 'all' or a.needs_review = false)
    and a.factor_fcf_yield is not null and a.factor_size is not null and a.factor_price_book is not null
    and a.factor_trailing_pe is not null and a.factor_drawdown_recovery is not null
    and a.factor_growth_discipline is not null and a.factor_profitability is not null
),
joined_b as (
  select u.*, f.ret_12m
  from universe_b u
  join scr_fwd_ret_mat f on f.company_id = u.company_id and f.as_of_date = u.as_of_date
  where f.ret_12m is not null
),
z_b as (
  select period, as_of_date, filt,
    (factor_fcf_yield - avg(factor_fcf_yield) over (partition by as_of_date, filt)) / stddev_pop(factor_fcf_yield) over (partition by as_of_date, filt) as z1,
    (factor_size - avg(factor_size) over (partition by as_of_date, filt)) / stddev_pop(factor_size) over (partition by as_of_date, filt) as z2,
    (factor_price_book - avg(factor_price_book) over (partition by as_of_date, filt)) / stddev_pop(factor_price_book) over (partition by as_of_date, filt) as z3,
    (factor_trailing_pe - avg(factor_trailing_pe) over (partition by as_of_date, filt)) / stddev_pop(factor_trailing_pe) over (partition by as_of_date, filt) as z4,
    (factor_drawdown_recovery - avg(factor_drawdown_recovery) over (partition by as_of_date, filt)) / stddev_pop(factor_drawdown_recovery) over (partition by as_of_date, filt) as z5,
    (factor_growth_discipline - avg(factor_growth_discipline) over (partition by as_of_date, filt)) / stddev_pop(factor_growth_discipline) over (partition by as_of_date, filt) as z6,
    (factor_profitability - avg(factor_profitability) over (partition by as_of_date, filt)) / stddev_pop(factor_profitability) over (partition by as_of_date, filt) as z7,
    case when percent_rank() over (partition by as_of_date, filt order by ret_12m) > 0.5 then 1.0 else 0.0 end as y
  from joined_b
),
per_date_b as (
  select period, as_of_date, filt,
    fm_ols_coef2(array_agg(array[1,z1,z2,z3,z4,z5,z6,z7]), array_agg(y)) as coef,
    count(*) as n_obs
  from z_b
  where z1 is not null and z2 is not null and z3 is not null and z4 is not null
    and z5 is not null and z6 is not null and z7 is not null
  group by 1,2,3
),
agg_b as (
  select period, filt,
    (nw_mean_test(array_agg(coef[1] order by as_of_date), 0)).mean_val as b0m, (nw_mean_test(array_agg(coef[1] order by as_of_date), 0)).nw_se as b0s, (nw_mean_test(array_agg(coef[1] order by as_of_date), 0)).t_stat as b0t,
    (nw_mean_test(array_agg(coef[2] order by as_of_date), 0)).mean_val as b1m, (nw_mean_test(array_agg(coef[2] order by as_of_date), 0)).nw_se as b1s, (nw_mean_test(array_agg(coef[2] order by as_of_date), 0)).t_stat as b1t,
    (nw_mean_test(array_agg(coef[3] order by as_of_date), 0)).mean_val as b2m, (nw_mean_test(array_agg(coef[3] order by as_of_date), 0)).nw_se as b2s, (nw_mean_test(array_agg(coef[3] order by as_of_date), 0)).t_stat as b2t,
    (nw_mean_test(array_agg(coef[4] order by as_of_date), 0)).mean_val as b3m, (nw_mean_test(array_agg(coef[4] order by as_of_date), 0)).nw_se as b3s, (nw_mean_test(array_agg(coef[4] order by as_of_date), 0)).t_stat as b3t,
    (nw_mean_test(array_agg(coef[5] order by as_of_date), 0)).mean_val as b4m, (nw_mean_test(array_agg(coef[5] order by as_of_date), 0)).nw_se as b4s, (nw_mean_test(array_agg(coef[5] order by as_of_date), 0)).t_stat as b4t,
    (nw_mean_test(array_agg(coef[6] order by as_of_date), 0)).mean_val as b5m, (nw_mean_test(array_agg(coef[6] order by as_of_date), 0)).nw_se as b5s, (nw_mean_test(array_agg(coef[6] order by as_of_date), 0)).t_stat as b5t,
    (nw_mean_test(array_agg(coef[7] order by as_of_date), 0)).mean_val as b6m, (nw_mean_test(array_agg(coef[7] order by as_of_date), 0)).nw_se as b6s, (nw_mean_test(array_agg(coef[7] order by as_of_date), 0)).t_stat as b6t,
    (nw_mean_test(array_agg(coef[8] order by as_of_date), 0)).mean_val as b7m, (nw_mean_test(array_agg(coef[8] order by as_of_date), 0)).nw_se as b7s, (nw_mean_test(array_agg(coef[8] order by as_of_date), 0)).t_stat as b7t,
    count(*) as n_dates, avg(n_obs) as avg_n_obs
  from per_date_b
  where coef is not null
  group by 1,2
)
insert into scr_results (trial_id, result_key, profile_version, period, value)
select 17, 'fama_macbeth_coef', 'b_v1', period, jsonb_build_object(
  'filt', filt, 'n_dates', n_dates, 'effective_n', n_dates, 'avg_n_obs_per_date', avg_n_obs,
  'intercept', jsonb_build_object('coef', b0m, 'se', b0s, 't_stat', b0t),
  'factor_fcf_yield', jsonb_build_object('coef', b1m, 'se', b1s, 't_stat', b1t),
  'factor_size', jsonb_build_object('coef', b2m, 'se', b2s, 't_stat', b2t),
  'factor_price_book', jsonb_build_object('coef', b3m, 'se', b3s, 't_stat', b3t),
  'factor_trailing_pe', jsonb_build_object('coef', b4m, 'se', b4s, 't_stat', b4t),
  'factor_drawdown_recovery', jsonb_build_object('coef', b5m, 'se', b5s, 't_stat', b5t),
  'factor_growth_discipline', jsonb_build_object('coef', b6m, 'se', b6s, 't_stat', b6t),
  'factor_profitability', jsonb_build_object('coef', b7m, 'se', b7s, 't_stat', b7t)
)
from agg_b;
