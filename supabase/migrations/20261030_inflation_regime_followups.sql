-- Regime Tilt Recalibration, Phase 1 follow-ups (spec v1.1 §3.5):
-- threshold margin, borderline flag, confirm-by estimate, and explicit
-- data-month/classification-month labels.

alter table inflation_regime_history
  add column if not exists cpi_margin numeric;

alter table dalio_regime_analysis
  add column if not exists infl_cpi_margin numeric,
  add column if not exists infl_borderline boolean,
  add column if not exists infl_confirm_by date,
  add column if not exists infl_classification_month date,
  add column if not exists infl_data_month date;
