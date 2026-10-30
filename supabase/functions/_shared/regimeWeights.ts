// Regime Tilt Recalibration — single source of truth for Deno-side
// regime weight lookups. Previously hand-copied separately in
// update-regime-portfolio-targets and run-backtest (two drifting copies
// of the same constant); consolidated in Phase 2. lib/simulatorKeys.js
// keeps its own copy for the frontend (a Deno module can't be imported
// into a Next.js bundle) — see that file's getWeightSet and the drift
// test in tests/regimeWeightVariants.test.ts that checks the two stay
// identical.
//
// Phase 3 (§5, decision D-1, approved as tabled): REGIME_WEIGHT_SETS
// now has real per-variant weights for rg_ri/fg_ri. Per D-8, rg_fi/
// fg_fi never get variants — any variant lookup for those two just
// falls back to base. rg_ri has no distinct high_accel set (the
// paper's acceleration tilt only applies within fg_ri's high variant);
// an accelerating vote while rg_ri is "high" falls back to plain high.

export type WeightSet = Record<string, number>;

const ALTS = { alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 };

export const REGIME_WEIGHT_SETS: Record<string, Record<string, WeightSet>> = {
  rg_fi: {
    base: { eq: 35, intl: 15, em: 10, nb: 20, tip: 5, com: 5, gld: 5, cash: 5, ...ALTS },
  },
  rg_ri: {
    base: { eq: 20, intl: 10, em: 20, nb: 0, tip: 15, com: 20, gld: 10, cash: 5, ...ALTS },
    high: { eq: 15, intl: 8, em: 7, nb: 0, tip: 20, com: 20, gld: 20, cash: 10, ...ALTS },
    high_decel: { eq: 20, intl: 10, em: 10, nb: 0, tip: 15, com: 20, gld: 20, cash: 5, ...ALTS },
  },
  fg_ri: {
    base: { eq: 25, intl: 5, em: 0, nb: 20, tip: 15, com: 10, gld: 15, cash: 10, ...ALTS },
    high: { eq: 15, intl: 5, em: 0, nb: 15, tip: 20, com: 12, gld: 20, cash: 13, ...ALTS },
    high_accel: { eq: 15, intl: 5, em: 0, nb: 15, tip: 15, com: 12, gld: 25, cash: 13, ...ALTS },
    high_decel: { eq: 15, intl: 5, em: 0, nb: 15, tip: 25, com: 12, gld: 15, cash: 13, ...ALTS },
  },
  fg_fi: {
    base: { eq: 5, intl: 5, em: 0, nb: 65, tip: 0, com: 0, gld: 15, cash: 10, ...ALTS },
  },
};

// Backward-compat flat view — unchanged shape for callers that index
// the base set directly (e.g. getSignalKeys), so this restructuring
// doesn't ripple into every existing caller.
export const REGIME_DEFAULT_WEIGHTS: Record<string, WeightSet> = Object.fromEntries(
  Object.entries(REGIME_WEIGHT_SETS).map(([key, variants]) => [key, variants.base]),
);

// Exact variant -> "high" (for a missing high_accel/high_decel) -> base.
export function getWeightSet(key: string, variant: string = "base"): WeightSet | undefined {
  const variants = REGIME_WEIGHT_SETS[key];
  if (!variants) return undefined;
  return variants[variant] ?? variants.high ?? variants.base;
}

// Frozen, never changes — the weights as they stood before Phase 2's
// getWeightSet wrapper and Phase 3's D-1 base revision (identical to
// the original hand-coded REGIME_DEFAULT_WEIGHTS at commit 6a2ccc7,
// the same commit legacyResolve() is extracted from). Two consumers:
// (1) the `legacy` shadow lane, which must stay a faithful old-rules
// baseline rather than drifting whenever REGIME_WEIGHT_SETS changes;
// (2) the live function's gate — with regime_phase3_weights off, the
// live job uses these, not just a forced "base" variant of the new
// table, since D-1 changed fg_ri's base numbers themselves.
export const LEGACY_WEIGHTS: Record<string, WeightSet> = {
  rg_fi: { eq: 35, intl: 15, em: 10, nb: 20, tip: 5, com: 5, gld: 5, cash: 5, ...ALTS },
  rg_ri: { eq: 20, intl: 10, em: 20, nb: 0, tip: 15, com: 20, gld: 10, cash: 5, ...ALTS },
  fg_ri: { eq: 5, intl: 5, em: 0, nb: 0, tip: 20, com: 30, gld: 30, cash: 10, ...ALTS },
  fg_fi: { eq: 5, intl: 5, em: 0, nb: 65, tip: 0, com: 0, gld: 15, cash: 10, ...ALTS },
};

export function getLegacyWeightSet(key: string): WeightSet | undefined {
  return LEGACY_WEIGHTS[key];
}

// Interim treatment (Scott's decision, 2026-10-30, until Phase 4's nb
// duration split/IEI ship): D-1 gave fg_ri a new 15-20% nb target --
// new exposure, since the pre-Phase-3 fg_ri had nb=0. `nb` maps 100%
// to TLT today (no IEI held), so applying this as-is would buy pure
// long-duration bonds in Stagflation, the exact duration bet the
// paper's own evidence argues against. Until a portfolio actually
// holds IEI, redistribute fg_ri's nb evenly into cash/tip instead.
// Applied as a post-processing override on top of the D-1 table, not
// a change to REGIME_WEIGHT_SETS itself — and only for fg_ri: rg_fi/
// fg_fi's nb targets are unchanged from the pre-Phase-3 rules, not new
// exposure this phase introduced, so they're out of scope here.
export function applyNbInterimTreatment(key: string, weights: WeightSet, hasIEI: boolean): WeightSet {
  if (key !== "fg_ri" || hasIEI) return weights;
  const nb = weights.nb ?? 0;
  if (nb <= 0) return weights;
  const half = Math.round(nb / 2);
  return { ...weights, nb: 0, cash: (weights.cash ?? 0) + half, tip: (weights.tip ?? 0) + (nb - half) };
}
