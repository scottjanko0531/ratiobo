-- VXUS and VWO resize rules, same equity-resize-backtest methodology
-- (walk-forward, no lookahead, 1-day lag) already used for
-- BTC/FBTC/GLD/GLDM/VT/VTI/PDBC/VTIP/TLT. Backfilled real daily history
-- into asset_price_history first (VXUS: 2011-01-28, 3928 rows; VWO:
-- 2005-03-10, 5411 rows -- both their own inception).
--
-- Both are trend_ma winners, same pattern as VTI (equity indices trend;
-- unlike the mean-reverting/vol-driven assets GLD/TLT/VTIP which favored
-- vol_regime). Both use N=100, exposureWhenReduced=0.
--
-- VXUS: buy-and-hold CAGR 6.82% / vol 17.71% / maxDD -35.97% / Sharpe 0.39
-- / Calmar 0.19 -> rule CAGR 5.02% / vol 11.30% / maxDD -17.11% / Sharpe
-- 0.44 / Calmar 0.29. Real CAGR cost (~1.8pp/yr) for more than halving the
-- drawdown. n=160 transitions over 16 years.
--
-- VWO: buy-and-hold CAGR 6.93% / vol 26.06% / maxDD -67.68% (severe) /
-- Sharpe 0.27 / Calmar 0.10 -> rule CAGR 6.54% / vol 15.45% / maxDD
-- -25.92% / Sharpe 0.42 / Calmar 0.25. Near-free -- CAGR barely moves while
-- drawdown drops more than 60%. n=250 transitions over 21 years, the
-- largest sample of any asset backtested this pass besides VTI itself.
insert into asset_resize_rule_config (symbol, rule_type, params, confidence_note)
values
  (
    'VXUS', 'trend_ma', '{"N":100,"exposureWhenReduced":0}'::jsonb,
    'Backtested 2011-2026 (16yrs, n=160 transitions). Calmar 0.19->0.29, max drawdown -35.97%->-17.11%. Real CAGR cost (6.82%->5.02%, ~1.8pp/yr) for the downside protection -- not free like TLT/VWO''s picks.'
  ),
  (
    'VWO', 'trend_ma', '{"N":100,"exposureWhenReduced":0}'::jsonb,
    'Backtested 2005-2026 (21yrs, n=250 transitions). Calmar 0.10->0.25, max drawdown -67.68%->-25.92% (more than halved), CAGR 6.93%->6.54% (near-free). Largest sample of any asset backtested this pass besides VTI.'
  )
on conflict (symbol) do update set
  rule_type = excluded.rule_type,
  params = excluded.params,
  confidence_note = excluded.confidence_note,
  updated_at = now();
