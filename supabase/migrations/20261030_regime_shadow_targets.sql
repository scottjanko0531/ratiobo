-- Regime Shadow Targets Log (docs/specs/regime-shadow-targets.md).
-- Daily side-by-side simulation of every rule set ("lane") for each
-- regime-driven portfolio. Never writes to portfolios.

create table regime_shadow_targets (
  snapshot_date date not null,
  portfolio_id uuid not null references portfolios(id),
  lane text not null,
  rules_version text not null,
  regime_key text,
  near_key text,
  lambda numeric,
  variant text not null default 'base',
  target_allocations jsonb not null,
  sector_targets jsonb,
  turnover_vs_prev numeric not null default 0,
  turnover_uncapped numeric,
  shifted boolean not null default false,
  event text,
  blocked_reason text,
  inputs jsonb not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_date, portfolio_id, lane)
);

create table regime_shadow_state (
  portfolio_id uuid not null references portfolios(id),
  lane text not null,
  base_key text,
  base_confirmed_since date,
  last_shift_date date,
  current_targets jsonb not null,
  desired_targets jsonb not null,
  current_sector_targets jsonb,
  updated_at timestamptz not null default now(),
  primary key (portfolio_id, lane)
);

-- Same access pattern as nearterm_signal_history/nearterm_signal_state:
-- RLS on, one read policy for authenticated, service-role writes via
-- RLS bypass (no insert/update/delete policy needed). Deliberately NO
-- immutability trigger on regime_shadow_targets, unlike
-- nearterm_signal_history — the spec's ?recompute=true needs real
-- deletes; insert-only-per-day discipline is enforced in application
-- code (upsert with ignoreDuplicates), the same mechanism
-- nearterm_signal_history already relies on day to day.
alter table regime_shadow_targets enable row level security;
create policy regime_shadow_targets_read on regime_shadow_targets for select to authenticated using (true);

alter table regime_shadow_state enable row level security;
create policy regime_shadow_state_read on regime_shadow_state for select to authenticated using (true);
