// Bond Lens overlay — single config file (docs/specs/bond-lens.md §4,
// "Config" convention: "all thresholds, windows and weights live in a
// single config module... defaults below are starting points; Phase E
// sets the final values" — same framing MC_CONFIG uses for its own
// PLACEHOLDER values). Bump `version` whenever any value below changes.

export const BOND_LENS_CONFIG = {
  version: "bond-lens-1.0.0",

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
  path: { lookbackDays: 56 },
  quadrant: { lookbackDays: 56 },

  // §4.4 hedge reliability: 90-trading-day SPY/IEF correlation;
  // hedge_reliable=false when corr > hedgeCorrThreshold, OR (quadrant is
  // Q2/Q3 AND corr > 0). 2-consecutive-weekly-reads hysteresis before the
  // flag flips either direction.
  hedge: { corrWindow: 90, corrThreshold: 0.20, hysteresisReads: 2 },

  // §4.5 trend filter: 12-month total return vs. 12-month T-bill return
  // (time-series momentum), and price vs. its 200-trading-day SMA.
  trend: { momentumLookbackDays: 252, smaWindow: 200 },

  // §4.6 curve regime: 63-trading-day Δlevel (ΔDGS10) / Δslope
  // (Δ(DGS10-DGS5)), 2-week persistence before a regime is confirmed.
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
} as const;
