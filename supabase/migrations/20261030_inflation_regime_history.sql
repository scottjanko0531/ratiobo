-- Regime Tilt Recalibration, Phase 1: inflation-level classifier
-- (Bera, Harvey & Hooper). New history table, written only by
-- update-inflation-regime; read into dalio_regime_analysis by
-- get-regime-analysis. Nothing client-side reads this table directly.

create table inflation_regime_history (
  month date primary key,
  cpi_yoy numeric,
  cpi_p75 numeric,
  ip_yoy numeric,
  ip_cagr10 numeric,
  raw_state text,
  confirmed_state text,
  candidate_state text,
  candidate_count int,
  accel_3m text,
  accel_6m text,
  accel_9m text,
  accel_vote text,
  computed_at timestamptz not null default now()
);

alter table inflation_regime_history enable row level security;
revoke all on inflation_regime_history from anon, authenticated, public;
grant select, insert, update on inflation_regime_history to service_role;

alter table dalio_regime_analysis
  add column if not exists infl_level_state text,
  add column if not exists infl_candidate_state text,
  add column if not exists infl_candidate_count int,
  add column if not exists infl_accel_vote text;
