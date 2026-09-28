// Market Conditions Overlay — single config file (build spec Section 8).
// No thresholds/weights live anywhere else in this module. Bump `version`
// whenever any value below changes — it's written to every output row
// (market_conditions_scores.config_version) so historical rows stay
// interpretable against the config that produced them.
//
// Phase 1 implements trend + stress only. breadth/sentiment/macro entries
// are scaffolded now (per spec's "single config file" intent) but unused
// until Phase 2/4 — pillarWeights redistribution (scoring.ts) handles their
// absence, not a Phase-1-specific branch.

export const MC_CONFIG = {
  version: "mc-1.0.0",

  normWindow: 2520, // ~10y trading days, rolling percentile cap
  minHistory: 756, // ~3y trading days, minimum before a percentile indicator counts

  pillarWeights: { trend: 0.30, breadth: 0.25, stress: 0.25, sentiment: 0.10, macro: 0.10 },

  trend: { trendBand: 0.02, slopeLookback: 20, tenMonthRuleMonths: 10 },

  breadth: {
    divergenceHighPct: 0.02, divergenceBreadthMax: 60, divergencePenalty: 0.25,
    thrustLow: 0.40, thrustHigh: 0.615, thrustWindow: 10, thrustBonus: 0.30, thrustHoldDays: 60,
  },

  sentiment: { extremeLow: 10, extremeHigh: 90 },

  tiers: [
    { name: "FULL", min: 0.35, mult: 1.00 },
    { name: "NORMAL", min: 0.05, mult: 0.80 },
    { name: "CAUTIOUS", min: -0.25, mult: 0.60 },
    { name: "DEFENSIVE", min: -0.50, mult: 0.40 },
    { name: "RISK_OFF", min: -Infinity, mult: 0.25 },
  ],

  hysteresis: { upgradeMargin: 0.05, upgradeDays: 3, downgradeMargin: 0.02, downgradeDays: 2 },

  veto: { termStructure: 1.05, termStructureDays: 2, creditWideningBp: 100, clearDays: 5 },

  entry: {
    dipRsi: 40, dipStretch: -1.5, dipOversoldPct: 20,
    hotRsi: 75, hotStretch: 2.0, topRsi: 70,
    capitulationOversoldPct: 40, capitulationLookback: 5,
  },
} as const;

// Tier ordering, best (FULL, index 0) to worst (RISK_OFF, index 4). Every
// hysteresis/cap/veto operation in scoring.ts works on this index, not the
// name, so "cap at DEFENSIVE" is just "index = max(index, DEFENSIVE_IDX)".
export const TIER_ORDER = MC_CONFIG.tiers.map((t) => t.name);
export const CAUTIOUS_IDX = TIER_ORDER.indexOf("CAUTIOUS");
export const DEFENSIVE_IDX = TIER_ORDER.indexOf("DEFENSIVE");

export function tierForComposite(composite: number): number {
  // tiers is ordered best-to-worst with descending `min`; first tier whose
  // min the composite clears (from the top) is the match. RISK_OFF's
  // min = -Infinity always matches as the fallback.
  for (let i = 0; i < MC_CONFIG.tiers.length; i++) {
    if (composite >= MC_CONFIG.tiers[i].min) return i;
  }
  return MC_CONFIG.tiers.length - 1;
}
