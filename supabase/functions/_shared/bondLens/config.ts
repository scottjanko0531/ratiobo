// Bond Lens overlay — single config file (docs/specs/bond-lens.md §4,
// "Config" convention: "all thresholds, windows and weights live in a
// single config module... defaults below are starting points; Phase E
// sets the final values" — same framing MC_CONFIG uses for its own
// PLACEHOLDER values). Bump `version` whenever any value below changes.

export const BOND_LENS_CONFIG = {
  version: "bond-lens-1.0.1", // 2026-10-02 follow-up: continuous path/quadrant scoring, hedge/valuation/trend fallbacks, curveRegimeStrict added

  // §4's own normalization convention (v2.1 decisions, not Market
  // Conditions' percentile-rank convention): literal z-score, clipped to
  // [-3, 3], 2520-trading-day window / 756-day minimum. §4.1 and §4.3's
  // "rolling 10-year window" wording is this same convention -- 2520
  // trading days IS ten years, not a second window definition.
  normWindow: 2520,
  minHistory: 756,
  clipZ: 3,

  // §3.2: HLW r-star is quarterly and revised; apply a one-quarter
  // publication lag before it's usable (i.e. a quarter's r-star reading
  // isn't "available" until that quarter has fully elapsed).
  rstarLagDays: 91,

  // §4.2 growth_mom / §4.4 quadrant axes: both are explicitly "8-week
  // changes." lookbackDays uses calendar days (56) since GDPNOW/T5YIE
  // obs_dates aren't a clean trading calendar once forward-filled.
  // `scaleGrowth`/`scaleInfl`: continuous quadrant scoring (2026-10-02
  // follow-up #2) z-scores both axes before combining them, same
  // 2520d/756d convention as every other z-score in this module.
  // `labelPersistenceWeeks`: the DISPLAY label (Q1-Q4) needs 3 consecutive
  // weekly reads agreeing before it changes, to stop ~18x/year flips --
  // the underlying quadrant_score is continuous and updates every day,
  // unaffected by this persistence rule.
  path: { lookbackDays: 56 },
  quadrant: { lookbackDays: 56, labelPersistenceWeeks: 3 },

  // §4.4 hedge reliability: 90-trading-day SPY/IEF correlation;
  // hedge_reliable=false when corr > hedgeCorrThreshold, OR (quadrant is
  // Q2/Q3 AND corr > 0). 2-consecutive-weekly-reads hysteresis before the
  // flag flips either direction. `fallbackWindowMonths`: pre-1993 monthly
  // fallback (Shiller S&P total return vs. the synthetic 10y return,
  // Scott's 2026-10-02 follow-up) uses a 36-month rolling window instead
  // of the real-data 90-trading-day one -- monthly data simply doesn't
  // have 90 trading days per window.
  hedge: { corrWindow: 90, corrThreshold: 0.20, hysteresisReads: 2, fallbackWindowMonths: 36 },

  // §4.5 trend filter: 12-month total return vs. 12-month T-bill return
  // (time-series momentum), and price vs. its 200-trading-day SMA.
  trend: { momentumLookbackDays: 252, smaWindow: 200 },

  // §4.6 curve regime: 63-trading-day Δlevel (ΔDGS10) / Δslope
  // (Δ(DGS10-DGS5)), 2-week persistence before a regime is confirmed.
  // These are the values LIVE compute still uses (bond_signals.curve_score
  // is produced from this block, unchanged).
  curveRegime: {
    lookbackDays: 63,
    levelThresholdBp: 10,
    slopeThresholdBp: 5,
    persistenceWeeks: 2,
    scores: {
      bull_flattening: 1, bull_steepening: 0.5, neutral: 0,
      bear_flattening: -0.5, bear_steepening: -1,
    } as Record<string, number>,
  },

  // Stricter candidate thresholds (2026-10-02 follow-up #6): wider bands,
  // longer persistence, meant to cut the ~18x/year regime churn the
  // looser defaults above produce. NOT wired into live compute -- kept
  // here only so Phase E can run both side by side on the same history
  // and pick a default with real comparison numbers, per Scott's explicit
  // "keep both versions" instruction, rather than overwriting the
  // already-shipped default on a judgment call.
  curveRegimeStrict: {
    lookbackDays: 63,
    levelThresholdBp: 15,
    slopeThresholdBp: 8,
    persistenceWeeks: 4,
    scores: {
      bull_flattening: 1, bull_steepening: 0.5, neutral: 0,
      bear_flattening: -0.5, bear_steepening: -1,
    } as Record<string, number>,
  },
} as const;
