-- Lock down screener/factor tables: RLS on, authenticated read-only, no anon.
-- Matches the convention used by scr_prices_daily, scr_securities, rb_scores, etc.
-- Writes continue via service_role / direct postgres (both bypass RLS).
-- Spec: docs/specs/rls-lockdown-scr-tables.md

do $$
declare
  t text;
  tbls text[] := array[
    'scr_universe_membership','scr_verified_exceptions','scr_adjusted_prices',
    'scr_scores','scr_trials','ff12_industry_ranges','scr_period_facts',
    'scr_period_facts_revisions','scr_anchors_asof','scr_metric_ttm_asof',
    'scr_results','scr_fwd_ret_mat','ff3_factors','scr_fwd_ret_mat_v2',
    'scr_phase4c_holdout_monthly','scr_phase4c_monthly_full',
    'scr_phase4c_monthly_full_ex'
  ];
begin
  foreach t in array tbls loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- View must respect caller's RLS instead of owner's rights
alter view public.scr_forward_returns set (security_invoker = true);
revoke all on public.scr_forward_returns from anon;
revoke insert, update, delete, truncate, references, trigger on public.scr_forward_returns from authenticated;

-- Functions: nobody unauthenticated should call scr_* over RPC
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'scr\_%'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- Phase 0 finding: scr_rebuild_universe_membership writes data and already held
-- an explicit `authenticated` grant pre-dating this migration, which the generic
-- public/anon revoke above does not touch. Close it explicitly so it matches
-- scr_refresh_universe_from_fool_recs (service_role-only, no frontend caller).
revoke execute on function public.scr_rebuild_universe_membership(date, date) from authenticated;
