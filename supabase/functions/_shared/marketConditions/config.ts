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
  //
  // mc-1.3.0: mc-1.2.0's fix worked on the mechanism it targeted (trend
  // state label) but barely moved the ACTUAL recovery date for 3 of 4
  // episodes, because the composite itself -- specifically T1/T3's
  // percentile ranking against 10 years of history -- turned out to be the
  // real bottleneck once the trend cap stopped binding (a bare SMA200
  // cross ranks low percentile-wise even though technically bullish). Four
  // more changes, diagnosed from that finding:
  //   1. `recovery.tierFloor` (stepTierState): once close has closed above
  //      the band for 3 consecutive days AND veto is inactive, tier cannot
  //      be worse than NORMAL -- independent of hysteresis's day-count,
  //      applied after hysteresis and before the veto's own cap.
  //   2. T1 and T3 (indicators/trend.ts) switch from percentile rank to
  //      absolute mappings -- T1 linear over +/-5% distance from SMA200,
  //      T3 a vol-adjusted momentum ratio clipped to [-1,1]. Both also drop
  //      the minHistory=756 gate entirely: an absolute formula doesn't
  //      need a trailing population to rank against, so the gate was
  //      vestigial once percentile ranking was gone -- T1/T3 are now live
  //      as soon as their own lookback (SMA200, or momentum+252d vol) is
  //      satisfied, same as T2/T4 always were.
  //   3. The recovery fast-path becomes a LATCH (config.recovery,
  //      stepTierState): once triggered it stays active across days even
  //      if the original trigger conditions stop holding, until tier
  //      reaches NORMAL or it's invalidated (close < SMA50, or
  //      VIX/VIX3M > vixTermStructureInvalidate). Previously it was
  //      re-evaluated fresh every day, which (diagnosed against mc-1.2.0's
  //      own results) meant it activated early in 2009/2022 but wasn't
  //      simultaneously active on the specific day composite finally
  //      cleared its margin, so it never actually helped either case.
  //      Pre-2006 (no VIX3M) fallback trigger: VIXCLS below its own 50-day
  //      average AND falling over 20 days -- lets the fast-path apply to
  //      2002 for the first time, which was structurally impossible before.
  //   4. Stress pillar adds S6 (VIXCLS 20-day change, inverted percentile)
  //      and moves from equal-weight to an explicit change-vs-level split:
  //      S3+S6 (the two "is it moving" indicators) total 50% of the
  //      pillar, S1+S2+S4+S5 (the four "where does it sit" indicators)
  //      share the other 50%.
  //
  // Phase 2 breadth round (2026-09-30): built and validated a proxy
  // breadth pillar (indicators/breadth.ts) -- REJECTED on its own
  // pre-registered criteria (worse Calmar on every market tested, see
  // DECISIONS.md). Config version was NOT bumped for that round --
  // breadthScore stays an unused optional ComputeInputs field in
  // production, `breadth` below is dead weight kept only as a reference
  // for whoever revisits breadth later, not a live tuning surface.
  //
  // mc-1.4.0 entry-rule round (2026-09-30), following the entry-signal
  // validation report: E-TOP/E-THRUST/E-CAPITULATION removed (depended on
  // the rejected breadth pillar, never reachable anyway); E-VETO removed
  // (failed its own pre-registered validation in all 4 markets tested --
  // veto days showed ABOVE-average forward returns, the opposite of what
  // a WAIT signal should mean); E-DIP rewired onto the newly-wired O1
  // (RSI14, Wilder) / O2 (stretch-vs-SMA50 z-score) oscillators
  // (indicators/oscillators.ts), dropping the breadthScore/pctOversold
  // conditions it could never previously satisfy. `entry`'s
  // dipOversoldPct/topRsi/capitulationOversoldPct/capitulationLookback
  // are removed -- their only consumers (E-TOP/E-CAPITULATION, and
  // E-DIP's now-dropped oversold condition) no longer exist. `veto.
  // disabled` added (default false, zero production effect) -- a
  // diagnostic-only hook for the tier-veto ablation test in this same
  // round (see DECISIONS.md); tier logic itself is otherwise UNCHANGED
  // this round unless the ablation's own pre-registered rule said
  // otherwise.
  version: "mc-1.4.0",

  normWindow: 2520, // ~10y trading days, rolling percentile cap
  minHistory: 756, // ~3y trading days, minimum before a percentile indicator counts

  pillarWeights: { trend: 0.30, breadth: 0.25, stress: 0.25, sentiment: 0.10, macro: 0.10 },

  // t1BoundPct: T1's +/-X% linear mapping bound (mc-1.3.0). Was a hardcoded
  // local constant in trend.ts until the mc-1.3.0 robustness round needed
  // to vary it in a sensitivity sweep -- moved here for the same reason
  // tierForComposite's cfg-ignoring bug got fixed then: not a tuning
  // change, the default (0.05) is unchanged, just made overridable like
  // every other threshold in this file.
  trend: { trendBand: 0.02, slopeLookback: 20, tenMonthRuleMonths: 10, t1BoundPct: 0.05 },

  // Phase 2 breadth round (2026-09-30, config version NOT bumped for this
  // -- see the top-of-file changelog): PB1-PB3 + divergence (proxy pillar,
  // indicators/breadth.ts) were the only breadth sub-indicators ever
  // scored into the composite -- REJECTED on pre-registered criteria, kept
  // here only as reference for anyone revisiting breadth later.
  // divergenceCountMax/divergenceLookbackDays/pb3BoundPct are this
  // rejected pillar's own thresholds, dead weight, not a live tuning
  // surface.
  breadth: {
    divergenceHighPct: 0.02, divergenceCountMax: 5, divergenceLookbackDays: 60, divergencePenalty: 0.25,
    pb3BoundPct: 0.03,
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

  // disabled: mc-1.4.0, diagnostic-only, default false (zero production
  // effect at this value) -- lets market-conditions-veto-ablation force
  // vetoActive to stay false for the entire history without touching
  // stepTierState's real logic, to test whether the TIER veto (which caps
  // exposure -- a separate mechanism from the entry-signal E-VETO rule
  // removed this round) is itself pulling its weight. See DECISIONS.md for
  // the ablation result and the pre-registered keep/remove rule.
  veto: { termStructure: 1.05, termStructureDays: 2, creditWideningBp: 45, clearDays: 5, disabled: false }, // creditWideningBp: placeholder pending Phase 5 recalibration for BAA10Y

  // ALL PLACEHOLDER VALUES, none backtested -- see DECISIONS.md, Phase 5.
  // Trigger (mc-1.2.0): VIX/VIX3M < vixTermStructureMax AND the 20d BAA10Y
  // change < baa10yChangeMaxBp AND close > SMA50, all the same day (or,
  // pre-2006 with no VIX3M, VIXCLS < its own 50d average AND falling over
  // 20 days, in place of the VIX/VIX3M leg). Once triggered (mc-1.3.0),
  // LATCHES active across days -- hysteresis upgrade requirement drops to
  // fastPathUpgradeDays and the DOWN trend cap is suspended -- until tier
  // reaches NORMAL, or invalidated by close < SMA50 or
  // VIX/VIX3M > vixTermStructureInvalidate (only evaluable post-2006;
  // pre-2006 latches can only invalidate via the SMA50 break -- no
  // invalidation-side fallback was specified for the VIX3M-less case, so
  // none is invented here).
  recovery: {
    enabled: true,
    vixTermStructureMax: 0.90,
    vixTermStructureInvalidate: 1.0,
    baa10yChangeMaxBp: 0, // BAA10Y 20d change must be NEGATIVE (spread tightening) to count
    fastPathUpgradeDays: 1,
    tierFloor: "NORMAL", // mc-1.3.0: 200d-above-band-3-days floor, see stepTierState
  },

  // mc-1.4.0: dipOversoldPct/topRsi/capitulationOversoldPct/
  // capitulationLookback removed -- their only consumers (E-TOP,
  // E-CAPITULATION, and E-DIP's now-dropped pctOversold condition) no
  // longer exist. dipRsi/dipStretch/hotRsi/hotStretch unchanged, now
  // actually live (see entrySignal.ts, indicators/oscillators.ts).
  entry: {
    dipRsi: 40, dipStretch: -1.5,
    hotRsi: 75, hotStretch: 2.0,
  },
} as const;

// Tier ordering, best (FULL, index 0) to worst (RISK_OFF, index 4). Every
// hysteresis/cap/veto operation in scoring.ts works on this index, not the
// name, so "cap at DEFENSIVE" is just "index = max(index, DEFENSIVE_IDX)".
export const TIER_ORDER = MC_CONFIG.tiers.map((t) => t.name);
export const NORMAL_IDX = TIER_ORDER.indexOf("NORMAL");
export const CAUTIOUS_IDX = TIER_ORDER.indexOf("CAUTIOUS");
export const DEFENSIVE_IDX = TIER_ORDER.indexOf("DEFENSIVE");

// Bug fix (found while building the parameter-sensitivity harness, not a
// tuning change): this previously read the module-level MC_CONFIG.tiers
// unconditionally, silently ignoring any `cfg` a caller passed to
// stepTierState — invisible in production (cfg is always MC_CONFIG there)
// but wrong for testing config variants, which is the entire point of a
// sensitivity sweep. Default param preserves every existing call site's
// behavior exactly; stepTierState now passes cfg.tiers explicitly.
export function tierForComposite(composite: number, tiers: readonly { name: string; min: number; mult: number }[] = MC_CONFIG.tiers): number {
  // tiers is ordered best-to-worst with descending `min`; first tier whose
  // min the composite clears (from the top) is the match. RISK_OFF's
  // min = -Infinity always matches as the fallback.
  for (let i = 0; i < tiers.length; i++) {
    if (composite >= tiers[i].min) return i;
  }
  return tiers.length - 1;
}
