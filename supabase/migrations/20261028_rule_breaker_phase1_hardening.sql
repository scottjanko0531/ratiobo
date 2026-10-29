-- Stock Picker Phase 1 -- harden the Rule Breaker log. See the approved
-- plan for full context. Three things:
--   1. rb_fundamentals wasn't actually append-only despite its own
--      comment claiming it (rb-refresh upserts on (symbol, asof), so a
--      same-day re-run silently overwrote). Same immutability pattern
--      as rb_scores/mc_signal_log, now for real.
--   2. rb_fool (one row per symbol, weekly-overwritten, no history) gets
--      the exact rb_ratings_history archive-trigger pattern applied to
--      it -- that migration's own code is the template.
--   3. A dedicated, narrow, revocable ingest key for the new
--      rb-ingest-ratings edge function, separate from the service-role
--      key and from rb_pipeline_bearer_token.

create or replace function rb_fundamentals_immutable() returns trigger
set search_path = ''
as $$
begin
  raise exception 'rb_fundamentals is append-only: % is not allowed', TG_OP;
end;
$$ language plpgsql;

create trigger rb_fundamentals_no_update before update on rb_fundamentals
  for each row execute function rb_fundamentals_immutable();
create trigger rb_fundamentals_no_delete before delete on rb_fundamentals
  for each row execute function rb_fundamentals_immutable();

create table rb_fool_history (
  id          bigint generated always as identity primary key,
  symbol      text not null,
  f5          numeric,
  type        text,
  first_rec   date,
  recs        integer,
  top10       boolean,
  status      text,
  closed_on   date,
  updated_at  timestamptz,
  replaced_at timestamptz not null default now()
);
create index rb_fool_history_lookup_idx on rb_fool_history (symbol, replaced_at desc);
comment on table rb_fool_history is 'Append-only archive of every prior rb_fool row, written ONLY by the SECURITY DEFINER rb_fool_archive_old trigger below -- mirrors rb_ratings_history exactly.';

create or replace function rb_fool_archive_old() returns trigger
security definer set search_path = public
as $$
begin
  insert into rb_fool_history
    (symbol, f5, type, first_rec, recs, top10, status, closed_on, updated_at, replaced_at)
  values
    (old.symbol, old.f5, old.type, old.first_rec, old.recs, old.top10,
     old.status, old.closed_on, old.updated_at, now());
  return null;
end;
$$ language plpgsql;

create trigger rb_fool_archive_on_update
  after update on rb_fool
  for each row execute function rb_fool_archive_old();

-- Trigger functions fire internally regardless of EXECUTE grants -- this
-- only closes the ability to call rb_fool_archive_old() directly via SQL/
-- RPC, mirroring rb_ratings_archive_old's own revoke exactly (see
-- 20261019_rule_breaker_fn_hardening.sql).
revoke execute on function rb_fool_archive_old() from public, anon, authenticated;

create or replace function rb_fool_history_immutable() returns trigger
set search_path = ''
as $$
begin
  raise exception 'rb_fool_history is append-only: % is not allowed', TG_OP;
end;
$$ language plpgsql;

create trigger rb_fool_history_no_update before update on rb_fool_history
  for each row execute function rb_fool_history_immutable();
create trigger rb_fool_history_no_delete before delete on rb_fool_history
  for each row execute function rb_fool_history_immutable();

alter table rb_fool_history enable row level security;
create policy rb_fool_history_read on rb_fool_history for select to authenticated using (true);

-- Superseded: the original plan was an HTTP ingest edge function keyed
-- via a Vault secret. The claude.ai workspace's network proxy blocks
-- outbound calls to *.supabase.co, so that path never worked -- the
-- real write path is the two SQL functions in
-- 20261028_rb_ingest_sql_functions.sql instead (called via the Supabase
-- connector, no key in any task prompt). The rb-ingest-ratings edge
-- function and RB_INGEST_KEY secret are now unused; left deployed
-- (harmless) rather than cleaned up, since this session has no tool to
-- delete an edge function or a secret.
