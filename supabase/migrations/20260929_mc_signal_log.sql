-- Market Conditions Overlay — append-only signal log. market_conditions_scores
-- is a full-rebuild derived table (recomputed from scratch on every compute
-- run — see scoring.ts's header comment); mc_signal_log is the separate,
-- immutable record of what the overlay actually said each date, for audit
-- purposes. market-conditions-compute inserts into this with ON CONFLICT
-- (date) DO NOTHING, so a date already logged is never touched again even
-- if a later config change or bug fix would recompute it differently.
--
-- "Append-only" is enforced at the DB level, not just by application code
-- discipline: UPDATE and DELETE are rejected by trigger for every role,
-- including the service role used by the edge functions.
create table mc_signal_log (
  date                 date primary key,
  config_version       text not null,
  tier                 text not null check (tier in ('FULL','NORMAL','CAUTIOUS','DEFENSIVE','RISK_OFF')),
  raw_tier             text not null check (raw_tier in ('FULL','NORMAL','CAUTIOUS','DEFENSIVE','RISK_OFF')),
  exposure_multiplier  numeric not null,
  entry_signal         text not null check (entry_signal in ('ADD','ADD_SMALL','NEUTRAL','WAIT','TRIM')),
  composite            numeric not null,
  score_trend          numeric,
  score_breadth        numeric,
  score_stress         numeric,
  score_sentiment      numeric,
  score_macro          numeric,
  computed_at          timestamptz not null default now()
);

comment on table mc_signal_log is 'Append-only record of the overlay''s real-time output, one row per date, never overwritten (see the mc_signal_log_immutable trigger) -- distinct from market_conditions_scores, which is a full-rebuild derived table. Requested explicitly so a later config/bug-fix recompute cannot silently rewrite history of what the system actually said on a given day.';

create or replace function mc_signal_log_immutable() returns trigger as $$
begin
  raise exception 'mc_signal_log is append-only: % is not allowed', TG_OP;
end;
$$ language plpgsql;

create trigger mc_signal_log_no_update before update on mc_signal_log
  for each row execute function mc_signal_log_immutable();
create trigger mc_signal_log_no_delete before delete on mc_signal_log
  for each row execute function mc_signal_log_immutable();

alter table mc_signal_log enable row level security;
create policy mc_signal_log_read on mc_signal_log for select to authenticated using (true);
