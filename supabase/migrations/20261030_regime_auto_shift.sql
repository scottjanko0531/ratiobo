-- Regime Tilt Recalibration, Phase 0: manual hold flag. Lets Scott pause
-- a regime-driven portfolio's auto-shifting (target_allocations/
-- current_regime_key writes) without stopping the underlying Near-Term
-- signal clock, so later phases of the spec can be developed/tested
-- without All Weather Alpha / With Equity Tilting actually moving real
-- dollars on a shift that hasn't been reviewed yet. Both columns default
-- to today's actual behavior -- no backfill needed.

alter table portfolios add column if not exists regime_auto_shift boolean not null default true;
alter table portfolio_regime_shifts add column if not exists applied boolean not null default true;
