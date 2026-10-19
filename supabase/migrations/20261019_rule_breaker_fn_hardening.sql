-- Follow-up hardening for the two Rule Breaker migrations just applied,
-- per Supabase's own security advisor run immediately after:
--   1. rb_scores_immutable / rb_ratings_history_immutable had no
--      search_path set (mutable search_path WARN) -- both are pure
--      raise-exception trigger functions with no object references, so
--      search_path = '' is safe and fully locks it down.
--   2. rb_ratings_archive_old is SECURITY DEFINER and was callable
--      directly via RPC by anon/authenticated (it's meant to fire only as
--      an AFTER UPDATE trigger on rb_ratings) -- revoke EXECUTE from
--      those roles. Triggers invoke the function through the trigger
--      mechanism, not a normal privileged call, so this does not affect
--      the archive-on-update behavior.

create or replace function rb_scores_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'rb_scores is append-only: % is not allowed', TG_OP;
end;
$$;

create or replace function rb_ratings_history_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'rb_ratings_history is append-only: % is not allowed', TG_OP;
end;
$$;

revoke execute on function rb_ratings_archive_old() from public, anon, authenticated;
