-- TLT resize rule, same equity-resize-backtest methodology (walk-forward,
-- no lookahead, 1-day lag) already used for BTC/FBTC/GLD/GLDM/VT/VTI/PDBC/
-- VTIP. Backfilled real TLT daily history into asset_price_history first
-- (2002-07-30 to today, 6069 rows).
--
-- vol_regime V=90/trigger=1.25 dominated on every metric, not just a
-- risk/return tradeoff: buy-and-hold CAGR 3.47% / vol 14.26% / maxDD
-- -48.35% / Sharpe 0.24 / Calmar 0.07 -> rule CAGR 4.07% / vol 10.22% /
-- maxDD -23.69% / Sharpe 0.40 / Calmar 0.17 -- higher return AND lower
-- risk simultaneously, the strongest across-the-board result of any asset
-- backtested this pass. 16 transitions over 24 years gives moderate
-- confidence (more than GLDM/VTIP's thin n=4, less than VTI's n=128).
insert into asset_resize_rule_config (symbol, rule_type, params, confidence_note)
values (
  'TLT', 'vol_regime', '{"V":90,"warmup":250,"restoreMult":1.1,"triggerMult":1.25,"exposureWhenReduced":0}'::jsonb,
  'Backtested 2002-2026 (24yrs, n=16 transitions). Calmar 0.07->0.17, max drawdown -48.35%->-23.69% (more than halved), CAGR 3.47%->4.07% (higher, not just less risky). Dominates buy-and-hold on every metric tested -- moderate-confidence sample size, between GLDM/VTIP''s thin n=4 and VTI''s robust n=128.'
)
on conflict (symbol) do update set
  rule_type = excluded.rule_type,
  params = excluded.params,
  confidence_note = excluded.confidence_note,
  updated_at = now();
