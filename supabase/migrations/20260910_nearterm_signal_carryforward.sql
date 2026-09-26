alter table portfolios
  add column if not exists regime_signal_horizon text not null default 'medium_term';

alter table portfolios
  add constraint portfolios_regime_signal_horizon_check
  check (regime_signal_horizon in ('near_term', 'medium_term'));

-- Singleton tracking row for Layer 2's event-driven/7-day-fallback recompute
-- trigger in fetch-macro-data: records the last time a FORCED (?refresh=true)
-- call to get-regime-analysis was made, distinct from the routine once-daily
-- lazy-cache row that other crons create regardless of whether new data
-- actually landed.
create table if not exists nearterm_signal_trigger_state (
  id boolean primary key default true,
  last_forced_at timestamptz,
  last_forced_reason text,
  constraint nearterm_signal_trigger_state_singleton check (id)
);
insert into nearterm_signal_trigger_state (id, last_forced_at, last_forced_reason)
values (true, null, null)
on conflict (id) do nothing;
