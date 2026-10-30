// Regime Tilt Recalibration, Phase 2 §4.0 — single source of truth for
// Deno-side regime weight lookups. Previously hand-copied separately in
// update-regime-portfolio-targets and run-backtest (two drifting copies
// of the same constant); consolidated here. lib/simulatorKeys.js keeps
// its own copy for the frontend (a Deno module can't be imported into a
// Next.js bundle) — see that file's getWeightSet and the drift test in
// tests/regimeShiftRules.test.ts that checks the two stay identical.
//
// getWeightSet's `variant` parameter is accepted now but ignored until
// Phase 3 (§5) fills in REGIME_WEIGHT_SETS[key][variant] — every call
// today returns the same thing REGIME_DEFAULT_WEIGHTS[key] always did.

export type WeightSet = Record<string, number>;

export const REGIME_DEFAULT_WEIGHTS: Record<string, WeightSet> = {
  rg_fi: { eq: 35, intl: 15, em: 10, nb: 20, tip: 5, com: 5, gld: 5, cash: 5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  rg_ri: { eq: 20, intl: 10, em: 20, nb: 0, tip: 15, com: 20, gld: 10, cash: 5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_ri: { eq: 5, intl: 5, em: 0, nb: 0, tip: 20, com: 30, gld: 30, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_fi: { eq: 5, intl: 5, em: 0, nb: 65, tip: 0, com: 0, gld: 15, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
};

export function getWeightSet(key: string, _variant: string = "base"): WeightSet | undefined {
  return REGIME_DEFAULT_WEIGHTS[key];
}
