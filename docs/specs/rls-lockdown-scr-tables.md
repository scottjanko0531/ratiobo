# Spec: Lock down the 17 RLS-disabled tables (screener + factor tables)

**Repo:** `~/Documents/GitHub/ratiobo` · **Supabase project:** `xuutmtfrpaxrzhwwokpk` (RatioBo)
**Type:** one database migration plus small hardening changes. No changes to any data.

---

## 1. Problem

The Supabase security advisor reports **17 tables in `public` with Row Level Security turned off**. Worse, `anon` and `authenticated` both hold **every** privilege on them: `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER`. The anon key ships in the frontend bundle, so anyone who has it can read, rewrite or `TRUNCATE` these tables. That includes `scr_scores` (507 MB, append-only by design), `scr_period_facts` (792 MB) and `scr_adjusted_prices` (1 GB).

The append-only triggers on `scr_scores` do **not** protect against this: `TRUNCATE` doesn't fire row-level triggers.

| Table | Size | Notes |
|---|---|---|
| `scr_adjusted_prices` | 1050 MB | read by view `scr_forward_returns` |
| `scr_period_facts` | 792 MB | |
| `scr_scores` | 507 MB | append-only guard triggers (`scr_scores_guarded`) |
| `scr_metric_ttm_asof` | 255 MB | |
| `scr_universe_membership` | 38 MB | read by view `scr_forward_returns` |
| `scr_anchors_asof` | 32 MB | |
| `scr_fwd_ret_mat` | 23 MB | |
| `scr_fwd_ret_mat_v2` | 22 MB | |
| `scr_results` | 504 kB | |
| `scr_trials` | 312 kB | |
| `scr_phase4c_holdout_monthly` | 168 kB | |
| `scr_period_facts_revisions` | 144 kB | |
| `ff3_factors` | 72 kB | |
| `scr_phase4c_monthly_full` | 72 kB | |
| `scr_phase4c_monthly_full_ex` | 72 kB | |
| `ff12_industry_ranges` | 48 kB | |
| `scr_verified_exceptions` | 48 kB | |

None of them has a `user_id` column; they all hold shared computed or reference data.

Two related exposures:
- **View `public.scr_forward_returns`** has no `security_invoker` option. It runs with its owner's rights, so it would **bypass RLS** on `scr_adjusted_prices` and `scr_universe_membership` even after they're locked down.
- **`scr_*` SQL functions** (`scr_sim_portfolio`, `scr_price_asof`, `scr_bil_price_asof`, `scr_rebuild_universe_membership`, `scr_refresh_universe_from_fool_recs`, etc.) keep Postgres's default `EXECUTE` grant to `PUBLIC`, so `anon` can call them over RPC. `scr_refresh_universe_from_fool_recs` is `SECURITY DEFINER`, which means anon can run a write against the universe.

## 2. Target state: follow the repo's existing convention

Every other computed or shared table in this repo already uses this pattern; for example `scr_prices_daily`, `scr_securities`, `scr_job_runs`, `scr_scores_corrections`, `rb_scores`, `rb_fundamentals` and `asset_price_history`:

- RLS **enabled**
- one policy, `<table>_read`: `FOR SELECT TO authenticated USING (true)`
- **no** insert/update/delete policies: writes go through `service_role` or a direct Postgres connection, both of which bypass RLS
- `anon` gets nothing

Apply exactly that pattern. Don't invent a new one.

## 3. Phase 0 findings (completed 2026-11-13)

Grepped `app/`, `lib/`, `components/`, `supabase/functions/`, `scripts/` for all 17 table names, the view, and every `scr_*` function/RPC call.

- **Zero** references to any of the 17 tables, `scr_forward_returns`, or any `scr_*` function anywhere in `app/`, `lib/`, or `components/`.
- **Zero** real references in `supabase/functions/` (two string matches in `update-inflation-regime`/`update-regime-portfolio-targets` were comments mentioning "scr_* backfills," not table access).
- **Zero** `supabase.rpc(...)` calls to any `scr_*` function from the frontend — the app's only RPC calls are `snapshot_at`, `seed_holding_snapshot`, `portfolio_daily_totals`, all unrelated.
- All real access to these 17 tables is through `scripts/scr_scoring/*.sql`, run manually via a direct/service-role Postgres connection (MCP `execute_sql`), not through PostgREST with an anon or user JWT.
- `scripts/backfill/*.mjs` and `scripts/rb-import.ts`/`rb-parity-report.ts` use `SUPABASE_SERVICE_ROLE_KEY` or a custom `SCR_INGEST_KEY`-gated edge function (`scr-ingest`, itself using the service role key internally) — none of them touch any of the 17 tables; they write to `scr_fundamentals`, `scr_securities`, `scr_prices_daily`, `scr_corporate_actions`, `scr_ticker_history` instead, which already have their own RLS/policies and aren't in scope here.

**No anon-key writers, no unauthenticated readers.** Per §3's own instruction, proceeding to Phase 1 without waiting.

**One gap found in this spec's own migration SQL**, flagged and corrected in the applied migration: `scr_rebuild_universe_membership` currently holds an *explicit* `authenticated=X` grant already (confirmed via `pg_proc.proacl`), in addition to the `PUBLIC`/`anon` grants the migration below revokes. The migration's function loop only revokes from `public, anon` — it does not touch `authenticated`. Left as originally drafted, `scr_rebuild_universe_membership` (a write function) would remain callable by any authenticated session after the migration, contradicting this spec's own stated intent ("must stay service-role only"). The applied migration adds one extra explicit `revoke execute ... from authenticated` for this function to close that gap. `scr_refresh_universe_from_fool_recs` needed no equivalent fix — it already has no `anon`/`authenticated` grant (`postgres`, `service_role` only).

All 17 tables confirmed `relrowsecurity = false`, zero existing policies, before this migration. Pre-migration row counts recorded in the PR/migration commit for the verification step.

## 4. Phase 1: migration

See `supabase/migrations/20261113_rls_lockdown_scr_tables.sql`.

```sql
-- Lock down screener/factor tables: RLS on, authenticated read-only, no anon.
-- Matches the convention used by scr_prices_daily, scr_securities, rb_scores, etc.
-- Writes continue via service_role / direct postgres (both bypass RLS).

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
```

Then, **only for the functions Phase 0 found being called from the frontend**, add `grant execute on function public.<name>(<args>) to authenticated;`. Phase 0 found none, so no such grants were added. Do **not** grant `authenticated` execute on `scr_refresh_universe_from_fool_recs` or `scr_rebuild_universe_membership`. They write data and must stay service-role only. If the frontend calls them today, route the call through an edge function instead.

Notes:
- `enable row level security` only changes table metadata. It doesn't rewrite the table, so it's instant even on the 1 GB tables.
- Trigger functions (`scr_scores_guarded`, `scr_append_only_immutable`, `scr_securities_archive_old`) are invoked by triggers, not by `EXECUTE` grants, so revoking `EXECUTE` doesn't affect them.
- Leave `postgres`, `service_role` and table ownership untouched.

## 5. Phase 2: stop this from happening again

1. `CLAUDE.md` convention note added: every new `public` table must `enable row level security` and get a `<table>_read` policy in the same migration that creates it.
2. `scripts/check-rls.sql` added — fails (non-empty result) if any `public` table has `relrowsecurity = false`.
3. **Deferred, pending confirmation:** `alter default privileges in schema public revoke all on tables from anon;` — affects every future table. Not applied without an explicit go-ahead, since it needs confirming no existing feature depends on anon reads first.

## 6. Verification

1. Supabase security advisor (`get_advisors`, type `security`) — no `rls_disabled_in_public` findings, no new `security_definer_view` findings.
2. Anon key, no session: `select` from `scr_scores`/`ff3_factors`/`scr_forward_returns` denied or empty; `insert` into `scr_trials` denied; `rpc('scr_sim_portfolio', …)` and `rpc('scr_refresh_universe_from_fool_recs')` denied.
3. Signed-in reads unaffected (no frontend reader existed to begin with, per Phase 0).
4. Write path: a service-role scoring/backfill job still writes rows and logs to `scr_job_runs`.
5. `scr_scores` append-only guard triggers still fire (tested via a rolled-back transaction).
6. Before/after row counts for all 17 tables, identical.

## 7. Rollback

```sql
-- Only if something breaks and can't be fixed forward quickly.
do $$
declare t text;
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
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('alter table public.%I disable row level security', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;
alter view public.scr_forward_returns reset (security_invoker);
```

The rollback deliberately does **not** restore the anon grants. If something needs anon access, fix that caller instead.

## 8. Out of scope

- Any change to table data, schema columns, indexes or scoring logic.
- RLS-enabled tables that already have policies.
- Moving the `scr_*` tables to a private schema.
