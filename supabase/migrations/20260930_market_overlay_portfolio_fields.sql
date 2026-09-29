-- Phase 6: per-portfolio opt-in for the Market Conditions overlay.
alter table portfolios
  add column use_market_overlay boolean not null default false;

-- Tier the portfolio was last rebalanced to, so the overlay only proposes a
-- rebalance on a tier change (not on every daily composite/score move).
-- Null until the portfolio has ever been marked rebalanced under the overlay.
alter table portfolios
  add column last_rebalanced_tier text;

alter table portfolios
  add constraint portfolios_last_rebalanced_tier_check
  check (last_rebalanced_tier is null or last_rebalanced_tier = ANY (
    ARRAY['FULL'::text, 'NORMAL'::text, 'CAUTIOUS'::text, 'DEFENSIVE'::text, 'RISK_OFF'::text]
  ));
