-- Exploratory value+momentum test: the one simulator run, all 4
-- configurations (V, M, VM, VM-ind), both ways (all companies / needs_review
-- excluded), full period 2017-01-31..2026-09-30. Reuses the Phase 4c
-- simulator (scr_sim_portfolio) unmodified: monthly rebalance, 10 bps per
-- side (equity names), no gate (p_gated=false -- no market-conditions gate
-- concept in this test), ranked by scr_scores.score (sign1=value or
-- momentum, sign2=momentum for the combo profiles, score=composite --
-- corrected via scr_scores_corrections after an initial oversight left
-- score null on insert).
--
-- Depends on scr_fwd_ret_mat_v2 being extended to cover broad_liquid
-- (fwd_ret_build_v2_broad_liquid.sql, committed first).

create table scr_vm_sim_monthly (
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

insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'V', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_value', 1, 10, false, '2017-01-31', '2026-09-30', false);
insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'V_ex', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_value', 1, 10, false, '2017-01-31', '2026-09-30', true);

insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'M', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_momentum', 1, 10, false, '2017-01-31', '2026-09-30', false);
insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'M_ex', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_momentum', 1, 10, false, '2017-01-31', '2026-09-30', true);

insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'VM', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_combo', 1, 10, false, '2017-01-31', '2026-09-30', false);
insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'VM_ex', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_combo', 1, 10, false, '2017-01-31', '2026-09-30', true);

insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'VM_ind', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_combo_ind', 1, 10, false, '2017-01-31', '2026-09-30', false);
insert into scr_vm_sim_monthly (config_code, as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway)
select 'VM_ind_ex', as_of_date, is_rebalance, gate_state, gross_ret, cost_frac, net_ret, turnover_oneway
from scr_sim_portfolio('vm_combo_ind', 1, 10, false, '2017-01-31', '2026-09-30', true);
