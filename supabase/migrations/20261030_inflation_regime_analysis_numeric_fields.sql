-- Regime Tilt Recalibration Phase 1 — the macro page's inflation-level
-- tile also shows CPI YoY vs. its 75th percentile and IP YoY vs. its
-- CAGR10, not just the classified state, so those raw inputs need their
-- own columns too (get-regime-analysis's cached-row response can only
-- return what's actually persisted here).

alter table dalio_regime_analysis
  add column if not exists infl_cpi_yoy numeric,
  add column if not exists infl_cpi_p75 numeric,
  add column if not exists infl_ip_yoy numeric,
  add column if not exists infl_ip_cagr10 numeric;
