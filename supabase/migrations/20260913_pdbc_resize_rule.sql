-- PDBC resize rule, same equity-resize-backtest methodology (walk-forward,
-- no lookahead, 1-day lag, scored on CAGR/vol/maxDD/Sharpe/Calmar vs
-- buy-and-hold) already used for BTC/FBTC/GLD/GLDM/VT/VTI. Backfilled real
-- PDBC daily history into asset_price_history first (2014-11-07 to today,
-- 2977 rows -- PDBC's own inception, no proxy substitution needed).
--
-- trend_ma N=50 beat trailing_drawdown and vol_regime on both Calmar and
-- Sharpe: buy-and-hold CAGR 4.89% / vol 18.14% / maxDD -49.52% / Sharpe 0.27
-- / Calmar 0.10 -> rule CAGR 4.38% / vol 13.05% / maxDD -32.02% / Sharpe
-- 0.34 / Calmar 0.14. exposureWhenReduced=0 (full cut) beat 0.5 (half) on
-- every risk metric for a small CAGR cost, same tradeoff pattern as VTI's
-- own rule.
insert into asset_resize_rule_config (symbol, rule_type, params, confidence_note)
values (
  'PDBC', 'trend_ma', '{"N":50,"exposureWhenReduced":0}'::jsonb,
  'Backtested 2014-2026 (11yrs, n=198 transitions). Calmar 0.10->0.14, max drawdown -49.5%->-32.0%. Turnover is notably higher than VTI''s 252-day rule (~18 transitions/yr vs ~5/yr) since 50-day MA is more reactive -- no transaction costs modeled in the backtest, so real-world drag from this turnover is not yet accounted for.'
)
on conflict (symbol) do update set
  rule_type = excluded.rule_type,
  params = excluded.params,
  confidence_note = excluded.confidence_note,
  updated_at = now();
