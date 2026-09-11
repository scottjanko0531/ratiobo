-- VTIP resize rule, same equity-resize-backtest methodology (walk-forward,
-- no lookahead, 1-day lag) already used for BTC/FBTC/GLD/GLDM/VT/VTI/PDBC.
-- Backfilled real VTIP daily history into asset_price_history first
-- (2012-10-16 to today, 3495 rows -- VTIP's own inception).
--
-- vol_regime V=60/trigger=2 beat trend_ma and trailing_drawdown decisively:
-- buy-and-hold CAGR 2.18% / vol 2.52% / maxDD -6.27% / Sharpe 0.87 / Calmar
-- 0.35 -> rule CAGR 2.12% / vol 1.79% / maxDD -3.68% / Sharpe 1.18 / Calmar
-- 0.58 -- best Calmar of any asset backtested this pass, for essentially no
-- CAGR cost. trailing_drawdown never fired at ANY tested threshold across
-- the full 14yr window (VTIP's peak-to-trough moves never got deep enough
-- to trip even the most sensitive -10% cut) -- not a viable rule type for
-- this asset.
insert into asset_resize_rule_config (symbol, rule_type, params, confidence_note)
values (
  'VTIP', 'vol_regime', '{"V":60,"warmup":250,"restoreMult":1.1,"triggerMult":2,"exposureWhenReduced":0}'::jsonb,
  'Backtested 2012-2026 (14yrs, n=4 transitions). Calmar 0.35->0.58, max drawdown -6.27%->-3.68%. CAUTION: same thin-evidence pattern as GLDM -- only 4 trigger events in 14 years is a clean result but a small sample; do not treat with VTI''s-level (128-transition) confidence. trailing_drawdown never triggered at any threshold tested -- not viable for this low-volatility asset class.'
)
on conflict (symbol) do update set
  rule_type = excluded.rule_type,
  params = excluded.params,
  confidence_note = excluded.confidence_note,
  updated_at = now();
