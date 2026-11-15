-- Part D (forward-test infrastructure spec): data model only -- the jobs
-- that populate these tables (A/B) are held pending the scheduling/trigger
-- investigation reported separately. All four tables are append-only by
-- explicit spec instruction: no backfilling, no rescoring past months --
-- picks and NAV points are recorded once, at the time, and never touched
-- again. RLS pattern matches supabase/migrations/20261113_rls_lockdown_scr_tables.sql
-- exactly; append-only guard matches scr_scores_guarded/scr_append_only_immutable.

create table scr_fwd_portfolios (
  id bigint generated always as identity primary key,
  name text not null unique,
  definition jsonb not null,
  start_date date not null,
  cost_rule jsonb not null,
  rebalance_rule jsonb not null,
  recorded_at timestamptz not null default now()
);

create table scr_fwd_trades (
  id bigint generated always as identity primary key,
  portfolio bigint not null references scr_fwd_portfolios(id),
  trade_date date not null,
  company_id uuid references scr_securities(id),
  symbol text not null,
  side text not null check (side = any (array['buy', 'sell'])),
  shares numeric not null,
  price numeric not null,
  cost numeric not null,
  reason text not null,
  recorded_at timestamptz not null default now()
);

create table scr_fwd_holdings (
  id bigint generated always as identity primary key,
  portfolio bigint not null references scr_fwd_portfolios(id),
  as_of_date date not null,
  company_id uuid references scr_securities(id),
  symbol text not null,
  shares numeric not null,
  weight numeric not null,
  recorded_at timestamptz not null default now(),
  unique (portfolio, as_of_date, company_id)
);

create table scr_fwd_nav (
  id bigint generated always as identity primary key,
  portfolio bigint not null references scr_fwd_portfolios(id),
  date date not null,
  nav numeric not null,
  period_return numeric,
  turnover numeric,
  costs numeric,
  recorded_at timestamptz not null default now(),
  unique (portfolio, date)
);

create index on scr_fwd_trades (portfolio, trade_date);
create index on scr_fwd_holdings (portfolio, as_of_date);
create index on scr_fwd_nav (portfolio, date);

-- RLS: enabled, authenticated read-only, no anon -- exact pattern from
-- the RLS lockdown migration.
do $$
declare
  t text;
  tbls text[] := array['scr_fwd_portfolios','scr_fwd_trades','scr_fwd_holdings','scr_fwd_nav'];
begin
  foreach t in array tbls loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- Append-only guard: reuses the existing generic trigger function
-- (scr_append_only_immutable), same as scr_scores/scr_securities.
do $$
declare
  t text;
  tbls text[] := array['scr_fwd_portfolios','scr_fwd_trades','scr_fwd_holdings','scr_fwd_nav'];
begin
  foreach t in array tbls loop
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function scr_append_only_immutable()',
      t || '_guard', t
    );
  end loop;
end $$;
