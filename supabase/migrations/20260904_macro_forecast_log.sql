create table if not exists macro_forecast_log (
  id bigint generated always as identity primary key,
  series text not null check (series in ('gdp', 'cpi')),
  issue_date date not null,
  target_date date not null,
  horizon_label text not null,
  forecast_value numeric not null,
  naive_forecast_value numeric not null,
  error_band_pp numeric,
  confidence integer,
  state text not null check (state in ('accelerating', 'decelerating', 'persistence')),
  actual_value numeric,
  actual_filled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (series, issue_date)
);

comment on table macro_forecast_log is '3-month-forward-forecast spec: every GDP/CPI point forecast Ratiobo actually issues in production (NOT backtest replays — those live only in supabase/functions/growth-axis-backtest''s stateless reports). forecast_value/naive_forecast_value are the SAME level-anchored value by design (the point forecast never differs from the flat/naive anchor, for any state — momentum-decay extrapolation was disproven twice over) and kept as separate columns only for schema flexibility if that ever changes. state: the axis''s Accelerating/Decelerating/Persistence read at issue time (see resolveAxisState) — the directional CLAIM being scored, distinct from the point number, which never differs by state. actual_value/actual_filled_at are populated once the real print for target_date lands (see fetch-macro-data''s actuals-backfill step) via an exact date match, never estimated.';

alter table macro_forecast_log enable row level security;

create policy macro_forecast_log_read on macro_forecast_log
  for select to authenticated using (true);
