-- Stock Picker Phase 1 follow-up: the claude.ai workspace's network
-- proxy blocks outbound calls to *.supabase.co, so the HTTP ingest
-- endpoint (rb-ingest-ratings edge function + RB_INGEST_KEY) can't be
-- called from its scheduled tasks after all. They have the Supabase
-- connector instead, which can execute SQL -- so the write path moves
-- into two SQL functions the connector calls directly. No key in any
-- task prompt; access control is EXECUTE grants, not a bearer secret.
--
-- Field-name mapping bug found in the edge-function version: the page
-- stores rated/appeal_rated/by/source, not rated_on/appeal_rated_on/
-- rated_by/source_url. Both functions below use the page's own field
-- names as input and map them on the way in.

create or replace function rb_ingest_ratings(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid;
  v_row jsonb;
  v_symbol text;
  v_td smallint;
  v_moat smallint;
  v_mgmt smallint;
  v_appeal smallint;
  v_founder boolean;
  v_why text;
  v_appeal_why text;
  v_appeal_basis text;
  v_rated_on date;
  v_appeal_rated_on date;
  v_rated_by text;
  v_source_url text;
  v_existing rb_ratings%rowtype;
  v_changed boolean;
  v_count int := 0;
begin
  -- Single-user system today -- derive "the" user the same way
  -- rb-compute/rb-ingest-ratings already do: the one rb_strategy=true
  -- portfolio's owner. A bare `select into` scalar raises automatically
  -- if more than one row comes back, which is the fail-loud behavior
  -- wanted if that invariant ever breaks.
  select user_id into v_user_id from portfolios where rb_strategy = true;
  if v_user_id is null then
    raise exception 'rb_ingest_ratings: no portfolio with rb_strategy=true found';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_symbol := v_row->>'symbol';
    if v_symbol is null or not exists (select 1 from rb_companies where symbol = v_symbol) then
      continue;
    end if;

    v_td     := (v_row->>'td')::smallint;
    v_moat   := (v_row->>'moat')::smallint;
    v_mgmt   := (v_row->>'mgmt')::smallint;
    v_appeal := (v_row->>'appeal')::smallint;
    if (v_td is not null and v_td not between 0 and 5)
       or (v_moat is not null and v_moat not between 0 and 5)
       or (v_mgmt is not null and v_mgmt not between 0 and 5)
       or (v_appeal is not null and v_appeal not between 0 and 5) then
      continue;
    end if;

    v_founder        := coalesce((v_row->>'founder')::boolean, false);
    v_why            := v_row->>'why';
    v_appeal_why     := v_row->>'appeal_why';
    v_appeal_basis   := coalesce(v_row->>'appeal_basis', 'customer');
    -- Page's own field names -> rb_ratings' column names.
    v_rated_on        := (v_row->>'rated')::date;
    v_appeal_rated_on := (v_row->>'appeal_rated')::date;
    v_rated_by        := v_row->>'by';
    v_source_url      := v_row->>'source';

    select * into v_existing from rb_ratings where symbol = v_symbol and user_id = v_user_id;

    v_changed :=
      v_existing.symbol is null
      or v_existing.td is distinct from v_td
      or v_existing.moat is distinct from v_moat
      or v_existing.mgmt is distinct from v_mgmt
      or v_existing.appeal is distinct from v_appeal
      or v_existing.founder is distinct from v_founder
      or v_existing.why is distinct from v_why
      or v_existing.appeal_why is distinct from v_appeal_why
      or v_existing.appeal_basis is distinct from v_appeal_basis
      or v_existing.rated_on is distinct from v_rated_on
      or v_existing.appeal_rated_on is distinct from v_appeal_rated_on
      or v_existing.rated_by is distinct from v_rated_by
      or v_existing.source_url is distinct from v_source_url;

    if not v_changed then
      continue;
    end if;

    insert into rb_ratings
      (symbol, user_id, td, moat, mgmt, appeal, founder, why, appeal_why, appeal_basis,
       rated_on, appeal_rated_on, rated_by, source_url, updated_at)
    values
      (v_symbol, v_user_id, v_td, v_moat, v_mgmt, v_appeal, v_founder, v_why, v_appeal_why, v_appeal_basis,
       v_rated_on, v_appeal_rated_on, v_rated_by, v_source_url, now())
    on conflict (symbol, user_id) do update set
      td = excluded.td, moat = excluded.moat, mgmt = excluded.mgmt, appeal = excluded.appeal,
      founder = excluded.founder, why = excluded.why, appeal_why = excluded.appeal_why,
      appeal_basis = excluded.appeal_basis, rated_on = excluded.rated_on,
      appeal_rated_on = excluded.appeal_rated_on, rated_by = excluded.rated_by,
      source_url = excluded.source_url, updated_at = now();

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Supabase's default-privileges setup grants EXECUTE to anon/authenticated
-- directly at CREATE FUNCTION time, not just via the PUBLIC pseudo-role --
-- revoking from public alone leaves both roles still able to call this
-- (confirmed live: a public-only revoke left anon/authenticated listed in
-- information_schema.routine_privileges). Revoke from all three explicitly.
revoke execute on function rb_ingest_ratings(jsonb) from anon, authenticated, public;
grant execute on function rb_ingest_ratings(jsonb) to service_role;

-- Mirrors rb_ingest_ratings exactly, for rb_fool (no user_id -- key is
-- bare symbol). Field names already match the page's own 1:1 (f5/type/
-- first_rec/recs/top10/status/closed_on), unlike ratings.
create or replace function rb_ingest_fool(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row jsonb;
  v_symbol text;
  v_f5 numeric;
  v_type text;
  v_first_rec text; -- rb_fool.first_rec is text holding a bare year ("2022"), not a date
  v_recs int;
  v_top10 boolean;
  v_status text;
  v_closed_on date;
  v_existing rb_fool%rowtype;
  v_changed boolean;
  v_count int := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_symbol := v_row->>'symbol';
    if v_symbol is null or not exists (select 1 from rb_companies where symbol = v_symbol) then
      continue;
    end if;

    v_type := v_row->>'type';
    if v_type is not null and v_type not in ('Cautious', 'Moderate', 'Aggressive') then
      continue;
    end if;
    v_status := coalesce(v_row->>'status', 'active');
    if v_status not in ('active', 'closed') then
      continue;
    end if;

    v_f5        := (v_row->>'f5')::numeric;
    v_first_rec := v_row->>'first_rec';
    v_recs      := (v_row->>'recs')::int;
    v_top10     := coalesce((v_row->>'top10')::boolean, false);
    v_closed_on := (v_row->>'closed_on')::date;

    select * into v_existing from rb_fool where symbol = v_symbol;

    v_changed :=
      v_existing.symbol is null
      or v_existing.f5 is distinct from v_f5
      or v_existing.type is distinct from v_type
      or v_existing.first_rec is distinct from v_first_rec
      or v_existing.recs is distinct from v_recs
      or v_existing.top10 is distinct from v_top10
      or v_existing.status is distinct from v_status
      or v_existing.closed_on is distinct from v_closed_on;

    if not v_changed then
      continue;
    end if;

    insert into rb_fool (symbol, f5, type, first_rec, recs, top10, status, closed_on, updated_at)
    values (v_symbol, v_f5, v_type, v_first_rec, v_recs, v_top10, v_status, v_closed_on, now())
    on conflict (symbol) do update set
      f5 = excluded.f5, type = excluded.type, first_rec = excluded.first_rec,
      recs = excluded.recs, top10 = excluded.top10, status = excluded.status,
      closed_on = excluded.closed_on, updated_at = now();

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function rb_ingest_fool(jsonb) from anon, authenticated, public;
grant execute on function rb_ingest_fool(jsonb) to service_role;
