-- Supabase security advisor cleanup (run after upgrading to Pro). Every
-- fix here mirrors a pattern already established elsewhere in this repo
-- -- no new conventions introduced.

-- 1. 14 tables had RLS fully disabled -- anyone with the publishable key
-- could read AND write them directly via PostgREST. None have a user_id
-- column (all system/reference state, not user-owned financial data),
-- so the fix is the same authenticated-read-only pattern already used
-- for rb_job_runs, bond_lens_portfolio_settings, etc. Writes stay
-- service-role-only (edge functions bypass RLS already).
alter table notifications enable row level security;
create policy notifications_read on notifications for select to authenticated using (true);

alter table dalio_regime_analysis enable row level security;
create policy dalio_regime_analysis_read on dalio_regime_analysis for select to authenticated using (true);

alter table nearterm_signal_state enable row level security;
create policy nearterm_signal_state_read on nearterm_signal_state for select to authenticated using (true);

alter table nearterm_signal_trigger_state enable row level security;
create policy nearterm_signal_trigger_state_read on nearterm_signal_trigger_state for select to authenticated using (true);

alter table portfolio_sector_targets enable row level security;
create policy portfolio_sector_targets_read on portfolio_sector_targets for select to authenticated using (true);

alter table backtest_cache enable row level security;
create policy backtest_cache_read on backtest_cache for select to authenticated using (true);

alter table mc_scores_snapshot_mc120 enable row level security;
create policy mc_scores_snapshot_mc120_read on mc_scores_snapshot_mc120 for select to authenticated using (true);

alter table bond_lens_phase_e_rerun_log enable row level security;
create policy bond_lens_phase_e_rerun_log_read on bond_lens_phase_e_rerun_log for select to authenticated using (true);

alter table spf_forecasts enable row level security;
create policy spf_forecasts_read on spf_forecasts for select to authenticated using (true);

alter table gauge_daily_snapshots enable row level security;
create policy gauge_daily_snapshots_read on gauge_daily_snapshots for select to authenticated using (true);

alter table tic_foreign_official_holdings enable row level security;
create policy tic_foreign_official_holdings_read on tic_foreign_official_holdings for select to authenticated using (true);

alter table ism_services_history enable row level security;
create policy ism_services_history_read on ism_services_history for select to authenticated using (true);

alter table consumer_expectations enable row level security;
create policy consumer_expectations_read on consumer_expectations for select to authenticated using (true);

alter table hud_national_mfi enable row level security;
create policy hud_national_mfi_read on hud_national_mfi for select to authenticated using (true);

-- 2. liquidity_raw_observations already had RLS enabled but NO policy at
-- all -- meaning nobody, not even a signed-in user, could read it. Same
-- read policy as above, closing the opposite kind of bug (broken access,
-- not exposure).
create policy liquidity_raw_observations_read on liquidity_raw_observations for select to authenticated using (true);

-- 3. These 3 views run as SECURITY DEFINER, bypassing RLS on the tables
-- they read. Harmless today with one real signed-in user, but
-- structurally wrong -- holdings_valued would leak across users the
-- moment a second one existed. Underlying tables (holdings/accounts/
-- transactions have real per-user "ALL" policies; macro_debt_cycle_
-- computed and mc_all_versions only read reference/signal tables that
-- already have, or now have via this same migration, authenticated-read
-- policies) so switching to invoker is safe.
alter view holdings_valued set (security_invoker = true);
alter view macro_debt_cycle_computed set (security_invoker = true);
alter view mc_all_versions set (security_invoker = true);

-- 4. Functions missing a locked search_path (schema-injection hardening).
-- mc_signal_log_immutable queries nothing, so empty is fine; the other
-- two reference unqualified table names in their body, so they need
-- 'public' specifically rather than empty.
alter function mc_signal_log_immutable() set search_path = '';
alter function snapshot_at(date) set search_path = 'public';

-- 5. seed_holding_snapshot(p_holding_id) took ANY holding id with no
-- ownership check at all, and was callable by `anon` (no sign-in
-- required). app/holdings and app/accounts only ever call it with the
-- signed-in user's own holding, so adding the ownership check and
-- revoking anon access is additive, not behavior-changing.
create or replace function public.seed_holding_snapshot(p_holding_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into portfolio_snapshots (holding_id, account_id, user_id, snapshot_date, quantity, price, cost_basis, market_value, net_gain)
  select h.id, h.account_id, h.user_id, current_date, 0, null, 0, 0, 0
  from holdings h
  where h.id = p_holding_id
    and h.user_id = auth.uid()
    and not exists (
      select 1 from portfolio_snapshots ps where ps.holding_id = p_holding_id
    )
  on conflict (holding_id, snapshot_date) do nothing;
$function$;
revoke execute on function public.seed_holding_snapshot(uuid) from anon;

-- 6. portfolio_daily_totals() aggregated across EVERY user's
-- portfolio_snapshots with no filter, and was callable by `anon`.
-- app/dashboard calls it from the signed-in user's own session, so
-- scoping to auth.uid() is additive (today there's one real user, so
-- the numbers returned don't change).
create or replace function public.portfolio_daily_totals()
returns table(snapshot_date date, total_value numeric, holding_count bigint)
language sql
stable security definer
set search_path to 'public'
as $function$
  select snapshot_date,
         sum(market_value)  as total_value,
         count(*)           as holding_count
  from   portfolio_snapshots
  where  user_id = auth.uid()
  group  by snapshot_date
  order  by snapshot_date;
$function$;
revoke execute on function public.portfolio_daily_totals() from anon;

-- Not covered here: "Leaked Password Protection Disabled" is a Supabase
-- Auth service setting (HaveIBeenPwned check), not a database object --
-- no SQL migration can toggle it. Enable it directly in the dashboard:
-- Authentication -> Policies -> Password Security.
