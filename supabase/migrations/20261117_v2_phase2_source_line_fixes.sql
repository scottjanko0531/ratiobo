-- Debt-Cycle Metrics Integrity v2, Phase 2b (docs/specs/debt-metrics-integrity-v2.md).
-- big_cycle_metrics.source_name is a plain editorial text column -- never
-- written by update-big-cycle-metrics/index.ts (that function only writes
-- value_numeric/value_display/status/status_label/note on each run) -- so
-- these three rows were still carrying their original seed-time source_name
-- text from before v1's MTS-basis and nominal-GDP fixes, confirmed stale
-- live on 2026-11-17: "FRED DGS10/GDPC1" (GDPC1 = real GDP; r-g has used
-- nominal GDP since v1 Phase 1) and "FRED A091RC1Q027SBEA / FYFR" (NIPA
-- interest; this card has used Treasury MTS net interest since v1 Phase 2).
-- No FK involved (plain text column), so a direct UPDATE is sufficient --
-- unlike the macro_indicators.name rename in 20261117_rename_cb_gold... .

update public.big_cycle_metrics
  set source_name = 'Macro dashboard, Long-Term Debt Cycle layer (FRED DGS10 / GDP, nominal)'
  where key = 'rate_growth_spread';

update public.big_cycle_metrics
  set source_name = 'Macro dashboard, Long-Term Debt Cycle layer (Treasury MTS: net interest ÷ receipts, trailing 12 months)'
  where key = 'interest_expense_revenue_pct';

update public.big_cycle_metrics
  set source_name = 'Treasury MTS (trailing-12 deficit) ÷ FRED GDP (trailing 4Q)'
  where key = 'deficit_pct_gdp';
