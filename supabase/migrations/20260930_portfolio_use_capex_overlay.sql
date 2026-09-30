-- Per-portfolio opt-in for the AI Capex Cycle overlay, independent of the
-- global capex_model_config.shadow_mode kill switch -- mirrors
-- use_market_overlay (20260930_market_overlay_portfolio_fields.sql): a
-- portfolio that turns this on gets capex's per-symbol cuts applied to its
-- own Portfolio Actions / Market Conditions Overlay math regardless of the
-- system-wide shadow-mode setting.
alter table portfolios
  add column use_capex_overlay boolean not null default false;
