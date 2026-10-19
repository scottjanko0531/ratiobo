-- Rule Breaker Screener, Phase 1 — user-owned tables: ratings, ratings
-- history, theses, and thesis<->symbol tags. Deliberate deviation from the
-- spec's literal rb_ratings key (bare `symbol`, implying one global rating
-- per stock): the acceptance test explicitly requires "a second test user
-- cannot read or write Scott's ratings," so the real key is (symbol,
-- user_id) and RLS is full per-user CRUD, same posture as portfolios/tags.

create table rb_ratings (
  symbol        text not null references rb_companies(symbol),
  user_id       uuid not null references auth.users(id),
  td            smallint check (td between 0 and 5),
  moat          smallint check (moat between 0 and 5),
  mgmt          smallint check (mgmt between 0 and 5),
  appeal        smallint check (appeal between 0 and 5),
  founder       boolean not null default false,
  why           text,
  appeal_why    text,
  appeal_basis  text not null default 'customer',
  rated_by      uuid references auth.users(id),
  rated_on      date,
  source_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (symbol, user_id)
);
comment on table rb_ratings is 'Key is (symbol, user_id), not the spec''s literal bare symbol -- see migration header. Written by the ratings editor (future UI) and scripts/rb-import.ts.';

create table rb_ratings_history (
  id            bigint generated always as identity primary key,
  symbol        text not null,
  user_id       uuid not null references auth.users(id),
  td            smallint,
  moat          smallint,
  mgmt          smallint,
  appeal        smallint,
  founder       boolean,
  why           text,
  appeal_why    text,
  appeal_basis  text,
  rated_by      uuid,
  rated_on      date,
  source_url    text,
  created_at    timestamptz,
  updated_at    timestamptz,
  replaced_at   timestamptz not null default now()
);
create index rb_ratings_history_lookup_idx on rb_ratings_history (symbol, user_id, replaced_at desc);
comment on table rb_ratings_history is 'Append-only archive of every prior rb_ratings row, written ONLY by the SECURITY DEFINER rb_ratings_archive_old trigger below -- there is no insert/update/delete RLS policy for ordinary users, and UPDATE/DELETE are rejected outright by trigger (defense in depth), matching the no-write-policy-for-computed-data doctrine used everywhere else in this repo.';

create or replace function rb_ratings_archive_old() returns trigger
security definer set search_path = public
as $$
begin
  insert into rb_ratings_history
    (symbol, user_id, td, moat, mgmt, appeal, founder, why, appeal_why,
     appeal_basis, rated_by, rated_on, source_url, created_at, updated_at, replaced_at)
  values
    (old.symbol, old.user_id, old.td, old.moat, old.mgmt, old.appeal, old.founder,
     old.why, old.appeal_why, old.appeal_basis, old.rated_by, old.rated_on,
     old.source_url, old.created_at, old.updated_at, now());
  return null;
end;
$$ language plpgsql;

create trigger rb_ratings_archive_on_update
  after update on rb_ratings
  for each row execute function rb_ratings_archive_old();

create or replace function rb_ratings_history_immutable() returns trigger as $$
begin
  raise exception 'rb_ratings_history is append-only: % is not allowed', TG_OP;
end;
$$ language plpgsql;

create trigger rb_ratings_history_no_update before update on rb_ratings_history
  for each row execute function rb_ratings_history_immutable();
create trigger rb_ratings_history_no_delete before delete on rb_ratings_history
  for each row execute function rb_ratings_history_immutable();

create table rb_theses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id),
  name        text not null,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table rb_thesis_tags (
  symbol     text not null references rb_companies(symbol),
  thesis_id  uuid not null references rb_theses(id) on delete cascade,
  primary key (symbol, thesis_id)
);
comment on table rb_thesis_tags is 'Junction table, no own user_id column -- ownership flows through rb_theses.user_id, mirroring account_tags (ownership via accounts.user_id).';

alter table rb_ratings         enable row level security;
alter table rb_ratings_history enable row level security;
alter table rb_theses          enable row level security;
alter table rb_thesis_tags     enable row level security;

create policy "users manage own rb_ratings" on rb_ratings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users read own rb_ratings_history" on rb_ratings_history
  for select to authenticated using (auth.uid() = user_id);

create policy "users manage own rb_theses" on rb_theses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users manage own rb_thesis_tags" on rb_thesis_tags
  for all using (exists (select 1 from rb_theses t where t.id = rb_thesis_tags.thesis_id and t.user_id = auth.uid()))
  with check (exists (select 1 from rb_theses t where t.id = rb_thesis_tags.thesis_id and t.user_id = auth.uid()));
