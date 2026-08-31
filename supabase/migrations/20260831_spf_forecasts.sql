create table if not exists spf_forecasts (
  id bigint generated always as identity primary key,
  vintage_label text not null,
  variable_code text not null,
  horizon_quarters integer not null,
  value numeric not null,
  fetched_at timestamptz not null default now(),
  unique (vintage_label, variable_code, horizon_quarters)
);

comment on table spf_forecasts is 'Philadelphia Fed Survey of Professional Forecasters median forecasts (GDP & Inflation Regime Metrics spec, G4/I4 forward consensus). variable_code: RGDP (annualized q/q growth, derived from level forecasts), CPI/CORECPI/PCE/COREPCE (annualized q/q rate, direct from source), CPI10 (10-year expected inflation, horizon_quarters unused/0). horizon_quarters: quarters-ahead the forecast applies to.';
