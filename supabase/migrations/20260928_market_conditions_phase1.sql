-- Market Conditions Overlay, Phase 1 (Foundation). See
-- docs/market-conditions/DECISIONS.md for what's reused vs. new here --
-- mc_price_daily from the build spec is deliberately NOT created (reuses
-- asset_price_history, already populated by backfill-asset-price-history /
-- sync-asset-price-history for SPY).

-- Raw daily macro/vol series (VIXCLS, ^VIX3M, BAMLH0A0HYM2 in Phase 1).
-- published_at will diverge from date once Phase 4 adds weekly series
-- (AAII/NAAIM/WALCL/TGA) that must be forward-filled from their actual
-- publication date, not their as-of date -- Phase 1's three inputs are all
-- daily, so published_at = date for every row written by
-- market-conditions-ingest today.
create table mc_series_daily (
  series_id    text not null,
  date         date not null,
  published_at date not null,
  value        numeric not null,
  source       text not null,
  primary key (series_id, date)
);
create index mc_series_daily_date_idx on mc_series_daily (date);

comment on table mc_series_daily is 'Market Conditions Overlay build spec Section 4. Raw values only -- all transforms happen in supabase/functions/_shared/marketConditions/. Populated by market-conditions-ingest.';

-- Primary output table (build spec Section 4 / Section 7). One row per
-- trading day. Full rebuild on every compute run (see scoring.ts's own
-- header comment on why) -- upserted by primary key, safe to re-run for
-- any date range.
create table market_conditions_scores (
  date                 date primary key,
  config_version       text not null,

  trend_state          text not null check (trend_state in ('UP','MIXED','DOWN')),
  score_trend          numeric,
  score_breadth        numeric,
  score_stress         numeric,
  score_sentiment      numeric,
  score_macro          numeric,
  composite            numeric not null,

  raw_tier             text not null check (raw_tier in ('FULL','NORMAL','CAUTIOUS','DEFENSIVE','RISK_OFF')),
  tier                 text not null check (tier in ('FULL','NORMAL','CAUTIOUS','DEFENSIVE','RISK_OFF')),
  exposure_multiplier  numeric not null,

  entry_signal         text not null check (entry_signal in ('ADD','ADD_SMALL','NEUTRAL','WAIT','TRIM')),
  entry_reason         text,

  veto_active          boolean not null default false,
  flags                jsonb not null default '{}',
  components           jsonb not null default '{}',
  computed_at          timestamptz not null default now()
);

comment on table market_conditions_scores is 'Market Conditions Overlay build spec Section 4/7. Dashboard reads this directly via the Supabase client (no API route -- matches every other page in this repo). Phase 1: trend_state/score_trend/score_stress/composite/tier/entry_signal are live; score_breadth/score_sentiment/score_macro are null until Phase 2/4, with flags.missing_pillars recording the redistribution each day.';

-- Generic job-run log (no equivalent table existed in the repo already --
-- spec Section 9.1's own fallback).
create table mc_job_runs (
  id          bigint generated always as identity primary key,
  job_name    text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running','ok','error')),
  detail      jsonb not null default '{}'
);
create index mc_job_runs_job_started_idx on mc_job_runs (job_name, started_at desc);

comment on table mc_job_runs is 'Market Conditions Overlay build spec Section 9.1. Generic ingest/compute run log -- no equivalent table existed elsewhere in the repo to reuse.';

alter table mc_series_daily enable row level security;
alter table market_conditions_scores enable row level security;
alter table mc_job_runs enable row level security;

create policy mc_series_daily_read on mc_series_daily for select to authenticated using (true);
create policy market_conditions_scores_read on market_conditions_scores for select to authenticated using (true);
create policy mc_job_runs_read on mc_job_runs for select to authenticated using (true);
