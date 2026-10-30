-- Regime Tilt Recalibration, Phase 2: override and shift mechanics
-- (spec v1.1 §4). structural_key_source lets update-regime-portfolio-
-- targets distinguish a fresh structural reading (crossover/leaning,
-- allowed to move a portfolio's base) from a carry-forward (never
-- allowed to). regime_blend records the current structural base, its
-- source, the inflation-level variant (no weight effect until Phase 3),
-- and the near-term blend ratio in effect, if any.

alter table dalio_regime_analysis
  add column if not exists structural_key_source text;

alter table portfolios
  add column if not exists regime_blend jsonb;
