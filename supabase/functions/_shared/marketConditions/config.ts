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
  // mc-1.1.0: switched the Stress pillar's credit-spread input from
  // BAMLH0A0HYM2 (HY OAS) to BAA10Y after discovering FRED now serves
  // BAMLH0A0HYM2 as only a rolling ~3y window (see DECISIONS.md).
  // veto.creditWideningBp dropped from 100 to 45 as an explicit PLACEHOLDER
  // -- BAA10Y (an investment-grade spread) moves in materially smaller
  // increments than HY OAS did, so the old 100bp threshold would almost
  // never fire; 45bp has not been backtested/calibrated and is flagged for
  // Phase 5.
  //
  // mc-1.2.0: diagnosed a real recovery-lag bug (SPX closed back above its
  // 200d SMA 7-17 weeks before trend_state left DOWN in 4 of 6 historical
  // episodes checked -- see DECISIONS.md) and fixed it two ways:
  //   1. trend.ts's resolveTrendState: DOWN now exits to MIXED after 3
  //      consecutive days above the band, regardless of slope (previously
  //      required aboveBand AND slopeUp together, which let a choppy
  //      recovery get stuck oscillating in the dead band indefinitely).
  //   2. `recovery` below: an explicit fast-path that shortens the
  //      hysteresis upgrade window and lifts the DOWN trend cap when
  //      term-structure/credit/price conditions all turn favorable at
  //      once. Every value in `recovery` is a PLACEHOLDER -- none have
  //      been backtested, flagged for Phase 5 calibration, not a
  //      considered choice.
  //   3. indicators/stress.ts's S1 (VIX/VIX3M): switched from percentile
  //      normalization to an absolute linear mapping, live from VIX3M's
  //      own 2006 start rather than gated by minHistory=756 on top of that
  //      -- percentile ranking made "is the term structure inverted right
  //      now" relative to 10 years of history instead of an absolute read,
  //      which is backwards for a level that has a genuinely meaningful
  //      fixed reference point (1.0).
  version: "mc-1.2.0",

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

  veto: { termStructure: 1.05, termStructureDays: 2, creditWideningBp: 45, clearDays: 5 }, // creditWideningBp: placeholder pending Phase 5 recalibration for BAA10Y

  // mc-1.2.0. ALL PLACEHOLDER VALUES, none backtested -- see DECISIONS.md,
  // Phase 5. When VIX/VIX3M < vixTermStructureMax AND the 20d BAA10Y change
  // < baa10yChangeMaxBp AND close > SMA50 all hold on the same day: the
  // hysteresis upgrade requirement drops to fastPathUpgradeDays (instead of
  // hysteresis.upgradeDays), and the DOWN trend cap is not applied that day
  // (a no-op unless trend_state is actually DOWN).
  recovery: {
    enabled: true,
    vixTermStructureMax: 0.90,
    baa10yChangeMaxBp: 0, // BAA10Y 20d change must be NEGATIVE (spread tightening) to count
    fastPathUpgradeDays: 1,
  },

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
