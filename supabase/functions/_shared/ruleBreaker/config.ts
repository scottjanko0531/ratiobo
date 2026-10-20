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

  // vwap_state classification (vwap.ts) -- confirmed 143/155 (92%) exact
  // with this simple rule; residual 12 mismatches are all cases where
  // vwap6 moved by a very small amount week-over-week near a z>1 band,
  // suggesting a trend dead-zone or longer-lookback refinement is needed
  // -- left as a TODO for scripts/rb-calibrate.ts rather than guessed.
  vwap: {
    // Evaluated in this order: fresh 'u' signal this week wins outright;
    // else z<0 is "Below VWAP"; else (z>=0) compare this week's vwap6_a
    // to last week's to call "Uptrend: hold" vs "Above, VWAP falling".
    entrySignalWinsOutright: true,
  },

  // Pillar aggregation (pillars.ts) -- NONE of c1-c6/safety/quality are
  // confirmed. A flat mean of each pillar's driver pcts was tested against
  // the FULL 155-row baseline (not just one example) and refuted for
  // every one checked, including c1 (0/155 match -- an earlier single-
  // example "confirmation" of c1 turned out to be coincidental, see
  // pillars.ts's header comment) and safety (flat mean of its 4 driver
  // pcts gives 61.77 vs actual 75 on one example). A "percentile of a
  // combined raw metric" alternative was also tried for c1 and refuted
  // (3/154). `composite` = mean(c1..c6) and `score`/`rank` built on top of
  // it ARE confirmed exact -- only the c1-c6/safety/quality inputs feeding
  // composite remain unsolved. `c5` has no `drivers` entry at all and is a
  // discrete 5-value field (20/40/60/80/100 only) -- rb_ratings.td*20 was
  // tested and refuted (96/154 match only). All of this is
  // scripts/rb-calibrate.ts's open job.
  pillars: {
    // TODO(rb-calibrate): c1Weights, c2Weights, c3Weights, c4Weights,
    // c6Weights, safetyWeights, qualityFormula, c5Formula -- intentionally
    // absent. This likely needs a real search (e.g. linear regression
    // against the 155 ground-truth pillar values), not more hand-guessing
    // -- several plausible-sounding hypotheses were already tried and
    // refuted this session.
  },
} as const;
