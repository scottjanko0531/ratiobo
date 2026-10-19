-- Rule Breaker Screener (build spec, Scott Janko, Oct 19 2026) — Phase 1:
-- shared/computed tables only. No per-user ownership on anything here --
-- this is a universe of stocks and derived scores, written by future
-- Yahoo-fetch/compute jobs (Phase 2+) and read by every authenticated
-- user, same posture as market_conditions_scores / bond_signals. RLS is
-- select-only-to-authenticated; no insert/update/delete policy exists
-- anywhere in this repo for a service-role-written table (service_role
-- bypasses RLS by Supabase's default behavior) and this migration doesn't
-- break that pattern.
--
-- Phase 1 scope: schema + one-time import target only. The Yahoo-fetching
-- edge functions, the scoring engine, the UI, and portfolio integration
-- are Phase 2-4 and are NOT touched here (every column below just holds
-- whatever shape the old claude.ai artifact already produced/needs; no
-- new business logic is implied by any column, check, or index below).

create table rb_companies (
  symbol    text primary key,
  name      text not null,
  sector    text,
  industry  text,
  currency  text not null default 'USD',   -- quote currency
  source    text not null default 'our' check (source in ('fool','our')),
  added     date not null default current_date,
  note      text,
  active    boolean not null default true  -- soft-delete flag; rows are never hard-deleted (see FK notes below)
);
comment on table rb_companies is 'Rule Breaker Screener universe. Written by manual add (future UI) and scripts/rb-import.ts. active=false retires a symbol without breaking FKs from rb_fool/rb_holders_13f/rb_fundamentals/rb_weekly_bars/rb_scores/rb_ratings/rb_thesis_tags.';

create table rb_fool (
  symbol      text primary key references rb_companies(symbol),
  f5          numeric,                       -- Fool 5-yr score
  type        text check (type in ('Cautious','Moderate','Aggressive')),
  first_rec   date,
  recs        integer,
  top10       boolean not null default false,
  status      text not null default 'active' check (status in ('active','closed')),
  closed_on   date,
  updated_at  timestamptz not null default now()
);
comment on table rb_fool is 'Written by the weekly Fool job (Phase 2+). Phase 1 just provides storage + import target for the artifact''s existing fool data.';

create table rb_holders_13f (
  symbol      text not null references rb_companies(symbol),
  quarter     date not null,     -- quarter-end date, e.g. 2026-06-30
  fund        text not null,
  weight_pct  numeric,
  change      text check (change is null or change in ('new','add','cut')),  -- null = blank
  updated_at  timestamptz not null default now(),
  primary key (symbol, quarter, fund)
);
comment on table rb_holders_13f is 'Key is (symbol, quarter, fund), not the spec''s literal (symbol, quarter) -- multiple funds hold the same symbol the same quarter (9 growth funds tracked), so (symbol, quarter) alone would silently drop rows. Written by the quarterly 13F job (Phase 2+).';

create table rb_fundamentals (
  symbol      text not null references rb_companies(symbol),
  asof        date not null,
  raw         jsonb not null default '{}',
  fcur        text,      -- financial statement currency
  fx_to_usd   numeric,
  mcap_usd    numeric,
  fetched_at  timestamptz not null default now(),
  primary key (symbol, asof)
);
create index rb_fundamentals_symbol_asof_idx on rb_fundamentals (symbol, asof desc);
comment on table rb_fundamentals is 'One row per symbol per refresh (daily, ~155 symbols -- no pruning in Phase 1). Index supports "latest row per symbol" lookups. Written by the daily refresh job (Phase 2+).';

create table rb_weekly_bars (
  symbol       text not null references rb_companies(symbol),
  week_start   date not null,
  open         numeric,
  high         numeric,
  low          numeric,
  close        numeric,
  volume       bigint,
  vwap6_a      numeric,   -- 6-week VWAP, "a" line
  vwap6_sigma  numeric,   -- 6-week VWAP sigma band, "s"
  vwap12_b     numeric,   -- 12-week VWAP, "b" line
  signal       text check (signal is null or signal in ('u','d')),
  primary key (symbol, week_start)
);
create index rb_weekly_bars_symbol_week_idx on rb_weekly_bars (symbol, week_start desc);
comment on table rb_weekly_bars is 'Spec says "keep 52 weeks per symbol" -- treated as an app-query-time concern (order by week_start desc limit 52), not DB-level pruning: 155 symbols x 52+ weeks is trivially small and unbounded history may be useful for later research. Written by the daily refresh job (Phase 2+).';

-- Append-only per date+config_version (mirrors mc_signal_log exactly): a
-- later formula fix recomputes into a new config_version row, never
-- overwrites an existing one. UPDATE/DELETE rejected at the DB level for
-- every role, including service_role.
create table rb_scores (
  symbol          text not null references rb_companies(symbol),
  date            date not null,
  config_version  text not null,
  c1 boolean, c2 boolean, c3 boolean, c4 boolean, c5 boolean, c6 boolean,  -- the six screen signs
  met             smallint,
  composite       numeric,
  score           numeric,
  rank            integer,
  screen          text,
  safety          text,
  quality         numeric,
  qgroup          text,
  weak_pillar     text,
  risk_type       text,
  action          text,
  action_key      text,
  action_why      text,
  vwap_state      text check (vwap_state is null or vwap_state in ('u','d')),
  drivers         jsonb not null default '{}',
  computed_at     timestamptz not null default now(),
  primary key (symbol, date, config_version)
);
create index rb_scores_date_idx on rb_scores (date desc, config_version desc);
create index rb_scores_symbol_date_idx on rb_scores (symbol, date desc);
comment on table rb_scores is 'Append-only, mirrors mc_signal_log''s immutability pattern exactly. config_version is NOT FK''d to rb_config.config_version -- rb_config only ever holds the current version, while historical rb_scores rows legitimately reference past versions that no longer match it. Written by the daily compute job (Phase 2+); Phase 1 only seeds historical rows via scripts/rb-import.ts.';

create or replace function rb_scores_immutable() returns trigger as $$
begin
  raise exception 'rb_scores is append-only: % is not allowed', TG_OP;
end;
$$ language plpgsql;

create trigger rb_scores_no_update before update on rb_scores
  for each row execute function rb_scores_immutable();
create trigger rb_scores_no_delete before delete on rb_scores
  for each row execute function rb_scores_immutable();

-- Generic job-run log, same shape as mc_job_runs / bond_lens_job_runs.
create table rb_job_runs (
  id          bigint generated always as identity primary key,
  job_name    text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running','ok','error')),
  detail      jsonb not null default '{}'
);
create index rb_job_runs_job_started_idx on rb_job_runs (job_name, started_at desc);
comment on table rb_job_runs is 'Every rb_* job (Phase 2+ edge functions, and scripts/rb-import.ts itself) logs one row here per run. job/started/finished/status map directly; the spec''s counts/error columns fold into detail jsonb, matching mc_job_runs/bond_lens_job_runs -- no separate table used a counts/error pair anywhere else in this repo.';

-- Singleton config row (same pattern as nearterm_signal_trigger_state).
-- Deliberately a DB table, not a TS config.ts module like MC_CONFIG/
-- BOND_LENS_CONFIG -- the spec's quality_gate on/off and thresholds/weights
-- are meant to be edited at runtime (future config editor UI, Phase 3/4),
-- not only by redeploying code.
create table rb_config (
  id                   boolean primary key default true,
  config_version       text not null,
  thresholds           jsonb not null default '{}',
  weights              jsonb not null default '{}',
  quality_gate_enabled boolean not null default true,
  updated_at           timestamptz not null default now(),
  constraint rb_config_singleton check (id)
);
insert into rb_config (id, config_version, thresholds, weights, quality_gate_enabled)
values (true, 'rb-1.0.0', '{}', '{}', true)
on conflict (id) do nothing;
comment on table rb_config is 'One singleton row. config_version here is the LIVE engine''s version, bumped by Phase 2+ whenever thresholds/weights change -- distinct from the one-time historical config_version tags scripts/rb-import.ts writes into rb_scores for imported legacy rows. thresholds/weights seeded empty -- Phase 1 does not know the real scoring values yet.';

alter table rb_companies    enable row level security;
alter table rb_fool         enable row level security;
alter table rb_holders_13f  enable row level security;
alter table rb_fundamentals enable row level security;
alter table rb_weekly_bars  enable row level security;
alter table rb_scores       enable row level security;
alter table rb_job_runs     enable row level security;
alter table rb_config       enable row level security;

create policy rb_companies_read    on rb_companies    for select to authenticated using (true);
create policy rb_fool_read         on rb_fool         for select to authenticated using (true);
create policy rb_holders_13f_read  on rb_holders_13f  for select to authenticated using (true);
create policy rb_fundamentals_read on rb_fundamentals for select to authenticated using (true);
create policy rb_weekly_bars_read  on rb_weekly_bars  for select to authenticated using (true);
create policy rb_scores_read       on rb_scores       for select to authenticated using (true);
create policy rb_job_runs_read     on rb_job_runs     for select to authenticated using (true);
create policy rb_config_read       on rb_config       for select to authenticated using (true);
