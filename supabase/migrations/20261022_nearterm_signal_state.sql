-- Centralizes the Near-Term Forward Signal's own pending/confirmed clock.
-- Previously each regime_driven portfolio tracked its own
-- pending_regime_key/pending_regime_since, which was fine when the rule
-- was per-portfolio but became pure duplication once both All Weather
-- portfolios started reading the identical signal with the identical
-- 60%-floor/7-day-confirmation rule (see 20261021's structural-regime
-- change). This table is the one place that clock actually lives now;
-- update-regime-portfolio-targets computes it ONCE per run and mirrors
-- pending_key/pending_since onto every regime_driven portfolio's own
-- columns afterward (so the /portfolios page's existing display keeps
-- working unchanged) rather than each portfolio re-deriving it
-- independently. It's also the one source the Macro page's Near-Term
-- panel and the notification-firing logic both read/trigger from.
--
-- pending_key/pending_since: the date the CURRENT near-term key first
-- crossed the 60% confidence floor, continuously held since -- "the date
-- the signal strength moved above 60%." Cleared (both null) the moment
-- the live signal drops below the floor or changes key.
--
-- confirmed_key/confirmed_since: the key and date of the most recent
-- override that actually reached the 7-day confirmation window. This is
-- historical -- it does NOT get cleared when the signal later reverts --
-- so "last confirmed: Reflation on 2026-10-29" stays answerable even
-- after structural regains control. `active` is the live flag for
-- whether that confirmed override is STILL the one driving portfolios
-- today ("the new regime is in place").
create table if not exists nearterm_signal_state (
  id boolean primary key default true,
  pending_key text,
  pending_since date,
  confirmed_key text,
  confirmed_since date,
  active boolean not null default false,
  updated_at timestamptz,
  constraint nearterm_signal_state_singleton check (id)
);
insert into nearterm_signal_state (id, active)
values (true, false)
on conflict (id) do nothing;
