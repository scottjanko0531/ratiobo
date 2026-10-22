-- update-regime-portfolio-targets is switching from "drive the regime
-- purely off the near-term/medium-term Forward Signal" to "drive it off the
-- active Structural regime, overridden by the Near-Term Forward Signal only
-- once that signal clears the 60% confidence floor and holds for 7 days"
-- (Scott's spec). That function needs the structural regime as a raw KEY it
-- can look up in REGIME_DEFAULT_WEIGHTS -- structural_regime only ever held
-- a display label ("Stagflation", "Reflation"), not a key ("fg_ri", "rg_ri").
--
-- get-regime-analysis now computes and writes this column itself (same
-- precedence as structural_regime's label: a real crossover wins; failing
-- that, "stay in the last, true regime" when both growth and inflation are
-- inside their dead bands; failing that, the nearSide-implied leaning
-- quadrant when only one axis is; null only when GDP/CPI data is genuinely
-- missing, not merely dead-banded).
alter table dalio_regime_analysis
  add column if not exists structural_key text;
