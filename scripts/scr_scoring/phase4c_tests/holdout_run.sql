-- Phase 4c: the one committed holdout run, 2024-01-31 through 2026-10-31,
-- all 8 pre-registered configurations (scr_trials ids 23-30). Run once,
-- after fwd_ret_build.sql, portfolio_simulator.sql, and the scr_trials
-- methodology addendum (id 32) were already committed and validated on
-- development/validation data only.
--
-- Step 1: extend A2 (a_v2_discipline) and A3 (a_v2_discipline_no6)
-- scoring into the holdout window -- previously held back at validation's
-- end (2023-12-31) to keep the holdout sealed during pre-registration and
-- the information-only dev/validation report. Literal re-run of
-- a_v2_discipline.sql / a_v2_discipline_no6.sql with :start_date/:end_date
-- bound to the holdout window:
--   a_v2_discipline.sql,      start_date=2024-01-01, end_date=2026-10-31
--   a_v2_discipline_no6.sql,  start_date=2024-01-01, end_date=2026-10-31
--
-- Step 2: simulate all 8 configurations (scr_sim_portfolio), both with
-- ALL companies and with needs_review-flagged companies excluded (the
-- spec's "both ways" requirement), storing every month's result:
create table if not exists scr_phase4c_holdout_monthly (
  config_code text not null,
  as_of_date date not null,
  is_rebalance boolean,
  gate_state text,
  gross_ret numeric,
  cost_frac numeric,
  net_ret numeric,
  turnover_oneway numeric,
  primary key (config_code, as_of_date)
);

-- All companies (8 calls):
insert into scr_phase4c_holdout_monthly select 'A1_ungated', * from scr_sim_portfolio('a_v1_hist_ff12', 1, 10, false, '2024-01-31', '2026-10-31');
insert into scr_phase4c_holdout_monthly select 'A1_gated',   * from scr_sim_portfolio('a_v1_hist_ff12', 1, 10, true,  '2024-01-31', '2026-10-31');
insert into scr_phase4c_holdout_monthly select 'A2_ungated', * from scr_sim_portfolio('a_v2_discipline', 1, 10, false, '2024-01-31', '2026-10-31');
insert into scr_phase4c_holdout_monthly select 'A2_gated',   * from scr_sim_portfolio('a_v2_discipline', 1, 10, true,  '2024-01-31', '2026-10-31');
insert into scr_phase4c_holdout_monthly select 'A3_ungated', * from scr_sim_portfolio('a_v2_discipline_no6', 1, 10, false, '2024-01-31', '2026-10-31');
insert into scr_phase4c_holdout_monthly select 'A3_gated',   * from scr_sim_portfolio('a_v2_discipline_no6', 1, 10, true,  '2024-01-31', '2026-10-31');
insert into scr_phase4c_holdout_monthly select 'B1', * from scr_sim_portfolio('b_v1', 3, 25, false, '2024-01-31', '2026-10-31');
insert into scr_phase4c_holdout_monthly select 'B2', * from scr_sim_portfolio('b_v1', 6, 25, false, '2024-01-31', '2026-10-31');

-- needs_review excluded (8 more calls, config_code suffixed _ex, 7th arg true):
insert into scr_phase4c_holdout_monthly select 'A1_ungated_ex', * from scr_sim_portfolio('a_v1_hist_ff12', 1, 10, false, '2024-01-31', '2026-10-31', true);
insert into scr_phase4c_holdout_monthly select 'A1_gated_ex',   * from scr_sim_portfolio('a_v1_hist_ff12', 1, 10, true,  '2024-01-31', '2026-10-31', true);
insert into scr_phase4c_holdout_monthly select 'A2_ungated_ex', * from scr_sim_portfolio('a_v2_discipline', 1, 10, false, '2024-01-31', '2026-10-31', true);
insert into scr_phase4c_holdout_monthly select 'A2_gated_ex',   * from scr_sim_portfolio('a_v2_discipline', 1, 10, true,  '2024-01-31', '2026-10-31', true);
insert into scr_phase4c_holdout_monthly select 'A3_ungated_ex', * from scr_sim_portfolio('a_v2_discipline_no6', 1, 10, false, '2024-01-31', '2026-10-31', true);
insert into scr_phase4c_holdout_monthly select 'A3_gated_ex',   * from scr_sim_portfolio('a_v2_discipline_no6', 1, 10, true,  '2024-01-31', '2026-10-31', true);
insert into scr_phase4c_holdout_monthly select 'B1_ex', * from scr_sim_portfolio('b_v1', 3, 25, false, '2024-01-31', '2026-10-31', true);
insert into scr_phase4c_holdout_monthly select 'B2_ex', * from scr_sim_portfolio('b_v1', 6, 25, false, '2024-01-31', '2026-10-31', true);

-- Step 3: measures. All measures use the 33 months with a REALIZED
-- return (as_of_date > '2024-01-31' -- the inception row at 2024-01-31
-- has gross_ret=0 by construction, since nothing was held before the
-- very first rebalance; this matches exactly Scott's own "33 as-of dates"
-- 1-month-horizon count, just framed from the realized-return side
-- instead of the forward-looking as-of side). Benchmark/BIL monthly
-- returns come from asset_price_history via the same nearest-trading-
-- day-on-or-before convention as fwd_ret_build.sql. See the Phase 4c
-- final report (reported in chat / scr_trials.results) for the full
-- measure tables and the decision-rule evaluation -- the exact
-- aggregation queries (annualized gross/net, NW mean/t-stat via the
-- existing nw_mean_test() function with lag=0, annualized vol/Sharpe
-- using BIL as the risk-free leg, max drawdown from the cumulative NAV
-- path, turnover/breakeven, and monthly Spearman IC via rank()+corr())
-- were run ad hoc against scr_phase4c_holdout_monthly and
-- scr_fwd_ret_mat_v2/scr_scores, and their results were written directly
-- into scr_trials.results (ids 23-30) by UPDATE, plus the methodology
-- addendum at id 32. No tuning, no re-runs of this holdout, no extra
-- variants beyond the 8 pre-registered configurations.
