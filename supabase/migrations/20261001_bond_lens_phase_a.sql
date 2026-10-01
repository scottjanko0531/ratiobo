-- Bond Lens overlay (docs/specs/bond-lens.md v2.1) -- Phase A: storage.
--
-- Per-portfolio toggle, mirroring use_market_overlay/use_capex_overlay
-- exactly (bond-lens-decisions.md #1): this boolean is the SOLE on/off
-- switch. bond_lens_portfolio_settings holds every other knob and has
-- no enabled column of its own, to avoid a second source of truth.
alter table portfolios
  add column use_bond_lens_overlay boolean not null default false;

-- ── Global market signal (computed once, every portfolio reads the same row) ──

-- Raw series from every source (FRED, NY Fed ACM term premium, NY Fed
-- HLW r-star), one row per (series_id, obs_date). fetched_at (not a
-- published_at/lookahead column) is what the spec asks for here --
-- publication-lag handling (e.g. r-star's one-quarter lag) is applied by
-- whichever Phase B module reads this table, not baked into storage.
create table bond_raw_series (
  series_id   text not null,
  obs_date    date not null,
  value       numeric not null,
  source      text not null,
  fetched_at  timestamptz not null default now(),
  primary key (series_id, obs_date)
);

-- One row per module-compute run; one column per Phase B module output
-- (populated starting Phase B -- Phase A just creates the shape).
-- inputs_hash lets a later run detect "nothing changed since last time."
create table bond_signals (
  as_of_date       date primary key,
  carry_score      numeric,
  path_score       numeric,
  valuation_score  numeric,
  quadrant_score   numeric,
  curve_score      numeric,
  trend_score      numeric,
  trend_state      text,
  quadrant         text,
  curve_regime     text,
  hedge_reliable   boolean,
  breakeven_gap_bp numeric,
  inputs_hash      text,
  computed_at      timestamptz not null default now()
);

-- The published composite -- what every enabled portfolio's sleeve
-- reallocation (Phase D) actually reads.
create table bond_lens_signal (
  as_of_date           date primary key,
  duration_score       numeric not null,
  duration_stance      text not null check (duration_stance in ('Short','Neutral','Extend','Max extend')),
  duration_multiplier  numeric not null,
  instrument_pref      text not null check (instrument_pref in ('bills_short_tips','tips_tilted','nominal_tilted')),
  maturity_pref        text not null check (maturity_pref in ('2y','5y','7y','10y')),
  hedge_reliable       boolean not null,
  curve_regime         text,
  quadrant             text,
  explanation          jsonb not null default '{}'::jsonb,
  computed_at          timestamptz not null default now()
);

-- ── Per-portfolio application (Phase D populates/reads these; created now) ──

-- Every column here is a real, used knob (bond-lens-decisions.md #1):
-- no enabled column (that's portfolios.use_bond_lens_overlay), no
-- solver_override_enabled (removed from v1, #4). macro_pillar_enabled
-- stays, default false, inert until Market Conditions Phase 4 ships (#5).
create table bond_lens_portfolio_settings (
  portfolio_id          uuid primary key references portfolios(id) on delete cascade,
  benchmark_duration    numeric,            -- null -> sleeve's strategic duration (spec 6.1)
  tips_split_when_tilted numeric not null default 0.60,
  eligible_instruments  jsonb,              -- null -> held instruments + default substitute list (spec 6.3)
  include_credit        boolean not null default true,
  macro_pillar_enabled  boolean not null default false,
  min_trade_threshold   numeric not null default 0.005,  -- fraction of portfolio, spec default 0.5%
  updated_at            timestamptz not null default now(),
  updated_by            uuid
);

create table bond_lens_portfolio_adjustments (
  id                 bigint generated always as identity primary key,
  portfolio_id       uuid not null references portfolios(id) on delete cascade,
  as_of_date         date not null,
  signal_as_of_date  date not null,
  current_sleeve     jsonb not null,   -- { weight, duration, mix: {nominal, tips, bills, credit}, maturity_profile }
  target_sleeve      jsonb not null,   -- same shape
  holdings           jsonb not null default '[]'::jsonb,  -- [{ holding_id, symbol, current_weight, target_weight, delta, rationale }]
  target_reachable   boolean not null default true,
  gap_note           text,
  created_at         timestamptz not null default now(),
  unique (portfolio_id, as_of_date)
);

create table bond_lens_toggle_log (
  id            bigint generated always as identity primary key,
  portfolio_id  uuid not null references portfolios(id) on delete cascade,
  action        text not null check (action in ('enabled','disabled','settings_changed')),
  old_value     jsonb,
  new_value     jsonb,
  changed_at    timestamptz not null default now()
);

-- ── Holdings classification (populated only after Scott confirms the
-- Phase A worksheet -- bond-lens-decisions.md #3; table created empty now) ──
create table bond_instrument_meta (
  holding_id          uuid primary key references holdings(id) on delete cascade,
  is_bond             boolean not null,
  bond_type           text check (bond_type in (
    'treasury_nominal','tips','bills_cash_like','agency_mbs',
    'ig_corporate','muni','aggregate','high_yield','em_debt','other'
  )),
  effective_duration  numeric,
  duration_as_of      date,       -- staleness check: ETF/fund duration is manual, warn after 90 days (spec 6.1/v2.1 worksheet)
  maturity_bucket     text check (maturity_bucket in ('0-1y','1-3y','3-7y','7-12y','12y+')),
  inflation_linked    boolean not null default false,
  in_scope            boolean not null default false,
  exclusion_reason    text,       -- e.g. "high_yield", "unclassified", "no_market_duration"
  updated_at          timestamptz not null default now()
);

-- ── Job run log, mirroring mc_job_runs' shape ──
create table bond_lens_job_runs (
  id           bigint generated always as identity primary key,
  job_name     text not null,
  started_at   timestamptz not null,
  finished_at  timestamptz,
  status       text not null,
  detail       jsonb not null default '{}'::jsonb
);

-- RLS: same convention as every other table in this project (authenticated
-- read, service-role write only).
alter table bond_raw_series enable row level security;
alter table bond_signals enable row level security;
alter table bond_lens_signal enable row level security;
alter table bond_lens_portfolio_settings enable row level security;
alter table bond_lens_portfolio_adjustments enable row level security;
alter table bond_lens_toggle_log enable row level security;
alter table bond_instrument_meta enable row level security;
alter table bond_lens_job_runs enable row level security;

create policy bond_raw_series_read on bond_raw_series for select to authenticated using (true);
create policy bond_signals_read on bond_signals for select to authenticated using (true);
create policy bond_lens_signal_read on bond_lens_signal for select to authenticated using (true);
create policy bond_lens_portfolio_settings_read on bond_lens_portfolio_settings for select to authenticated using (true);
create policy bond_lens_portfolio_adjustments_read on bond_lens_portfolio_adjustments for select to authenticated using (true);
create policy bond_lens_toggle_log_read on bond_lens_toggle_log for select to authenticated using (true);
create policy bond_instrument_meta_read on bond_instrument_meta for select to authenticated using (true);
create policy bond_lens_job_runs_read on bond_lens_job_runs for select to authenticated using (true);
