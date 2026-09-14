-- Fiscal Policy Paradigm scorecard (42 Macro's Paradigm A-E sovereign-debt-
-- resolution framework: Cut -> Grow -> Print -> [War]). New section on the
-- Big Cycle page, complementing the Long Term Debt Cycle section. Every
-- number is FRED-derived and computed (z-score/orientation/weight/composite/
-- classification) -- no manual-entry field anywhere, per the build spec's
-- own acceptance criteria. Deliberately NOT built on big_cycle_cycles/
-- big_cycle_metrics (Dalio's 3 cycles) -- every big_cycle_metrics row
-- requires a cycle_id NOT NULL FK, and forcing a "fake cycle" row for an
-- unrelated framework would be a worse fit than these purpose-built tables.

-- One row per (metric, observation date) -- full pulled FRED history per
-- metric, needed to compute each day's trailing 10yr z-score window and to
-- render the drill-down's raw historical chart.
create table big_cycle_paradigm_raw_series (
  id bigserial primary key,
  metric_key text not null,
  fred_series_id text not null,
  obs_date date not null,
  value numeric not null,
  fetched_at timestamptz not null default now(),
  unique (metric_key, obs_date)
);

-- One row per (metric, paradigm, day) -- that day's computed z-score/
-- orientation/weight. Keyed by (metric_key, paradigm), not just metric_key,
-- because one metric (trade_gdp) feeds two paradigms' composites (B and E,
-- per the build spec) with potentially different weights in each context,
-- even though raw_value/z_score are identical across both rows.
-- available=false + unavailable_reason set (never a silently zeroed/
-- defaulted row) when a FRED series fails to fetch that day -- see the
-- build spec's graceful-degradation requirement.
create table big_cycle_paradigm_metric_scores (
  id bigserial primary key,
  recorded_at date not null,
  metric_key text not null,
  paradigm text not null check (paradigm in ('A','B','C','D','E')),
  raw_value numeric,
  z_score numeric,
  oriented_z numeric,
  weight numeric,
  available boolean not null default true,
  unavailable_reason text,
  run_at timestamptz not null default now(),
  unique (metric_key, paradigm, recorded_at)
);

-- One row per (paradigm, day) -- the composite score/classification/
-- coverage that day. label is one of the fixed classification-threshold
-- outputs (Not Active/Emerging/Active/Dominant) or Confirmed/Not Confirmed
-- for Paradigm A's special-case display.
create table big_cycle_paradigm_scores (
  id bigserial primary key,
  recorded_at date not null,
  paradigm text not null check (paradigm in ('A','B','C','D','E')),
  composite_score numeric not null,
  label text not null,
  coverage_pct numeric not null,
  low_coverage boolean not null default false,
  run_at timestamptz not null default now(),
  unique (paradigm, recorded_at)
);

alter table big_cycle_paradigm_raw_series enable row level security;
alter table big_cycle_paradigm_metric_scores enable row level security;
alter table big_cycle_paradigm_scores enable row level security;

create policy "public read" on big_cycle_paradigm_raw_series
  for select to public using (true);
create policy "public read" on big_cycle_paradigm_metric_scores
  for select to public using (true);
create policy "public read" on big_cycle_paradigm_scores
  for select to public using (true);
