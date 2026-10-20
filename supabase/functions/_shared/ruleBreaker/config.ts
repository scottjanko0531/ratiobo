// Rule Breaker Screener — single config file (same "no thresholds/weights
// live anywhere else in this module" convention as marketConditions'/
// bondLens' own config.ts). Every value below was reverse-engineered
// against the real 155-symbol baseline (rb_scores where
// config_version='artifact-v15' AND partial=false, date=2026-10-19) and
// confirmed to produce an exact or near-exact match -- see each constant's
// comment for the confirmed match rate. Values still marked TODO/calibrate
// are explicit placeholders scripts/rb-calibrate.ts is meant to replace,
// not considered choices.

export const RB_CONFIG = {
  version: "rb-1.1.0-draft", // bumped once scripts/rb-calibrate.ts confirms 100% match and writes rb_config

  // "Lower is better" sub-metrics -- percentile direction is inverted for
  // these (crossSectionalRank.ts), confirmed via metrics.ts's own driver
  // formulas and their displayed names in the real export ("(lower is
  // better)"/"drops"/leverage/volatility framing).
  lowerIsBetterMetrics: new Set([
    "Net debt / EBITDA",
    "Leverage (assets / equity)",
    "Operating income drops (qtr to qtr, / assets)",
    "Price volatility (1y)",
    "Accruals (lower is better)",
    "Stock pay / sales (lower is better)",
  ]),

  // This fixed value is used as a "pinned at the cap" sentinel for
  // structurally-invalid/undefined safety-pillar ratios -- confirmed
  // literal (not +Infinity, not null) on TWO independent metrics: leverage
  // from non-positive equity (e.g. GH's leverage driver VALUE is exactly
  // 99) and netDebtOverEbitda from non-positive EBITDA with a net debt
  // position (see metrics.ts's netDebtOverEbitda). It STAYS IN the
  // ranking universe for both (confirmed via AMD leverage pct=89.61, only
  // reproducible with n=155, every symbol included). Every OTHER metric's
  // generic missing data is EXCLUDED from that metric's own ranking
  // universe instead (reducing n for just that metric) -- confirmed via
  // the real ret1y case, which only reproduces exactly with n=152 (3
  // symbols lacking ret1y excluded), not n=155 with a substituted
  // sentinel. Do not generalize this sentinel to other metrics without
  // re-confirming against real data first.
  invalidMetricSentinel: 99,

  // `screen` classification (classify.ts) -- confirmed 155/155, zero
  // exceptions.
  screen: {
    ruleBreakerMetThreshold: 6, // met === 6 -> "Rule Breaker", always
    watchlistMetFloor: 5, // met === 5 -> "Watchlist", always, regardless of score
    doesntFitMetCeiling: 1, // met <= 1 -> "Doesn't fit", always, regardless of score
    midTierScoreThreshold: 40, // met in [2,4]: score >= 40 -> Watchlist, else Doesn't fit
  },

  // `qgroup` classification -- only populated for met=6 rows; confirmed
  // zero violations across all 25 Rule Breaker rows in the baseline.
  // Exact boundary unconfirmed beyond "somewhere in (47, 51)" (highest
  // observed "spec" quality=47, lowest observed "comp" quality=51) --
  // calibration script should narrow this against more data if/when
  // available; 50 is the natural midpoint guess.
  qgroup: {
    compoundQualityThreshold: 50,
  },

  // Action-gate thresholds (vwap.ts/classify.ts) -- confirmed via
  // systematic action_why text-mining against all 155 baseline rows this
  // session, evaluated in this exact precedence order:
  //   1. rb_fool.closed_on not null -> nonew ("The Fool closed this
  //      recommendation on {date}.")
  //   2. safety < safetyVetoThreshold -> nonew ("Safety veto...") --
  //      confirmed clean: 31 vetoed rows all safety<=19, zero non-vetoed
  //      rows with safety<20.
  //   3. score < qualifyingScoreThreshold -> nonew ("Score {score} is
  //      under 50.") -- confirmed clean: max nonew-by-score=48, min
  //      qualifying score=50.
  //   4. "newly qualified" (this week's score >= threshold, last week's
  //      score from rb_scores_history < threshold) -> wait ("Newly
  //      qualified (last week {X}): confirm next week.") -- confirmed on
  //      all 6 occurrences.
  //   5. owned=true -> always hold -- confirmed 16/16, regardless of
  //      vwap_state/vwap_z.
  //   6. owned=false: vwap_state "Below VWAP"/"Above, VWAP falling" ->
  //      wait; vwap_state "Entry signal"/"Uptrend: hold" -> buy/pull/half
  //      by vwap_z band (below), with met===6 required for "buy" (every
  //      other case is "pull"/"half" with explicit "not a Rule Breaker"
  //      messaging). NOTE: only one real "buy" example exists in the
  //      baseline (met=6 AND vwap_z>=2 together) -- whether met=6 alone or
  //      the z-band alone gates "buy" vs "pull" is genuinely ambiguous
  //      from this data; scripts/rb-calibrate.ts should flag this rather
  //      than silently pick one.
  action: {
    safetyVetoThreshold: 20,
    qualifyingScoreThreshold: 50,
    buyOnPullbackZBand: [1, 2] as const, // vwap_z in [1,2) -> "pull" (met<6) or ambiguous "buy" (met=6)
    halfSizeZBand: [0, 1] as const, // vwap_z in [0,1) -> "half" (met<6)
    stretchedZThreshold: 2, // vwap_z >= 2 -> "stretched above +2σ" messaging
  },

  // Pillar aggregation (pillars.ts) -- c1-c6, met, composite, score, rank,
  // safety, quality, qgroup, weak_pillar are ALL confirmed 155/155 exact.
  // The formula was supplied directly by the user from the live screen's
  // own source code (not reverse-engineered the way everything above
  // was): c1/c2/c4 blend a computed pillar number with a human rating
  // (rb_ratings.td/moat/mgmt * 20) 50/50 when both exist; c5 is purely
  // rb_ratings.appeal * 20 (no fundamentals component, confirmed via
  // ECHO's null-rating case); c3/c6 are purely computed. safety and
  // quality are each a second-order cross-sectional percentile -- see
  // pillars.ts's header comment for the full shape. This round also found
  // and fixed 8 real metric-formula bugs (null-coercion-to-0 in
  // grossMarginChange/evOverSales's debt-or-cash/cashFlowAfterStockPay-
  // OverSales/accruals's sbc, a missing non-positive-denominator guard on
  // rdOverGrossProfit/returnOnInvestedCapital, and operatingIncomeDrop's
  // formula being a sum-of-all-declines rather than a single min-diff or
  // max-drawdown) -- see metrics.ts for each fix's detail. Nothing is
  // left unsolved in this block; `pillars` is kept as an empty object
  // because every value above (percentile engine, thresholds, sentinel)
  // already lives in this same config file, not because anything here is
  // still a placeholder.
  pillars: {},
} as const;
