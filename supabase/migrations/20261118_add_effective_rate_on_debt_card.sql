-- Debt-Cycle Metrics Integrity v2, Phase 6b (docs/specs/debt-metrics-integrity-v2.md).
-- New Big Cycle card "Effective Rate on Federal Debt (r_eff)" -- a
-- cross-ref of the existing "Effective Rate vs. Nominal Growth (r_eff −
-- g)" Macro indicator, same pattern as every other api_macro_xref row in
-- this table (rate_growth_spread, convenience_yield_10y, etc.). Status
-- bands are based on the convergence gap (10Y − r_eff), not r_eff's own
-- level: < 0.5 healthy / 0.5-1.5 watch / > 1.5 danger, computed live in
-- update-big-cycle-metrics/index.ts's computeMacroCrossRefUpdates --
-- logged as uncalibrated, same convention as every other threshold in
-- this spec. value_numeric/value_display/status/status_label/note are
-- all filled in by that function's next run; this migration only seeds
-- the row's identity (key/label/source/sort_order) so the update() by
-- key has a row to find.
insert into public.big_cycle_metrics
  (cycle_id, key, label, source_name, source_url, refresh_method, sort_order)
values (
  'da204e3f-ae22-47dd-95bb-2844d4f75685',
  'effective_rate_on_debt',
  'Effective Rate on Federal Debt (r_eff)',
  'Macro dashboard, Long-Term Debt Cycle layer (Treasury MTS net interest ÷ average debt held by the public, trailing 12 months)',
  null,
  'api_macro_xref',
  20
);
