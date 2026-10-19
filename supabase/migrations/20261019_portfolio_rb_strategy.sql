-- Rule Breaker Screener, Phase 1 — per-portfolio flag, mirroring
-- use_market_overlay/use_capex_overlay/use_bond_lens_overlay exactly.
-- Ownership of an rb symbol is never stored on any rb_ table: a symbol is
-- "owned" when it's in a portfolio with rb_strategy = true via
-- portfolios -> portfolio_holdings -> holdings, quantity > 0 (Phase 2+
-- reads derive this live; Phase 1 does not build that query as a view --
-- see scripts/rb-import.ts's holdings cross-check, which uses the same
-- join ad hoc).
alter table portfolios
  add column rb_strategy boolean not null default false;
