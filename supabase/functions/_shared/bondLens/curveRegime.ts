// Bond Lens overlay — §4.6 Curve regime classifier (cross-check). Pure,
// Deno-API-free.

import { CurveRegime } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";

export interface CurveRegimeRaw {
  deltaLevelBp: number | null; // Δ DGS10, over the lookback window
  deltaSlope10s5sBp: number | null; // Δ (DGS10 - DGS5), the classification's own slope leg
  deltaSlope2s10sBp: number | null; // stored cross-check only (spec: "store a 2s10s variant as well") -- not used in classification
}

export function curveRegimeRaw(
  dgs10: (number | null)[], dgs5: (number | null)[], dgs2: (number | null)[], t: number, lookback = BOND_LENS_CONFIG.curveRegime.lookbackDays,
): CurveRegimeRaw {
  const i0 = t - lookback;
  if (i0 < 0) return { deltaLevelBp: null, deltaSlope10s5sBp: null, deltaSlope2s10sBp: null };
  const y10_0 = dgs10[i0], y10_1 = dgs10[t], y5_0 = dgs5[i0], y5_1 = dgs5[t], y2_0 = dgs2[i0], y2_1 = dgs2[t];
  const deltaLevelBp = y10_0 != null && y10_1 != null ? (y10_1 - y10_0) * 100 : null;
  const deltaSlope10s5sBp = y10_0 != null && y10_1 != null && y5_0 != null && y5_1 != null
    ? ((y10_1 - y5_1) - (y10_0 - y5_0)) * 100 : null;
  const deltaSlope2s10sBp = y10_0 != null && y10_1 != null && y2_0 != null && y2_1 != null
    ? ((y10_1 - y2_1) - (y10_0 - y2_0)) * 100 : null;
  return { deltaLevelBp, deltaSlope10s5sBp, deltaSlope2s10sBp };
}

// Classification (spec §4.6): level is bull if Δlevel < -10bp, bear if
// > +10bp; slope is steepening if Δslope > +5bp, flattening if < -5bp.
// "Neutral: if either leg is below its threshold" -- i.e. if level OR
// slope fails to clear its own band, the OVERALL regime is "neutral",
// not a hybrid; only when BOTH legs clear their bands does one of the
// four directional regimes apply.
export function classifyCurveCandidate(raw: CurveRegimeRaw, cfg = BOND_LENS_CONFIG): CurveRegime | null {
  const { deltaLevelBp, deltaSlope10s5sBp } = raw;
  if (deltaLevelBp == null || deltaSlope10s5sBp == null) return null;
  const bull = deltaLevelBp < -cfg.curveRegime.levelThresholdBp;
  const bear = deltaLevelBp > cfg.curveRegime.levelThresholdBp;
  const steepening = deltaSlope10s5sBp > cfg.curveRegime.slopeThresholdBp;
  const flattening = deltaSlope10s5sBp < -cfg.curveRegime.slopeThresholdBp;
  if (!(bull || bear) || !(steepening || flattening)) return "neutral";
  if (bull) return steepening ? "bull_steepening" : "bull_flattening";
  return steepening ? "bear_steepening" : "bear_flattening";
}

export interface CurveRegimeState {
  confirmed: CurveRegime | null;
  candidate: CurveRegime | null;
  candidateStreak: number;
  regimeSince: string | null;
}

export interface CurveRegimeStepResult {
  state: CurveRegimeState;
  lateycleTransition: boolean; // bear_flattening -> bull_flattening, spec's explicit "late-cycle confirmation event"
  score: number | null;
}

// 2-week persistence before a CANDIDATE regime is confirmed (spec:
// "2-week persistence before a regime is confirmed") -- same
// walk-forward hysteresis pattern as hedge_reliable (§4.4) and Market
// Conditions' resolveTrendState, just keyed on a 5-way label instead of
// a boolean/3-way one.
export function stepCurveRegime(
  candidate: CurveRegime | null, date: string, prior: CurveRegimeState, cfg = BOND_LENS_CONFIG,
): CurveRegimeStepResult {
  if (candidate == null) {
    return { state: prior, lateycleTransition: false, score: prior.confirmed ? cfg.curveRegime.scores[prior.confirmed] : null };
  }
  let next: CurveRegimeState;
  let justConfirmedChange = false;
  if (candidate === prior.candidate) {
    const candidateStreak = prior.candidateStreak + 1;
    if (candidate !== prior.confirmed && candidateStreak >= cfg.curveRegime.persistenceWeeks) {
      next = { confirmed: candidate, candidate, candidateStreak, regimeSince: date };
      justConfirmedChange = true;
    } else {
      next = { ...prior, candidateStreak };
    }
  } else {
    next = { ...prior, candidate, candidateStreak: 1 };
  }
  // "bear_flattening -> bull_flattening" is a direct transition between
  // the immediately preceding confirmed regime and the newly confirmed
  // one -- not "bear_flattening seen at any point before now."
  const lateycleTransition = justConfirmedChange && next.confirmed === "bull_flattening" && prior.confirmed === "bear_flattening";
  return { state: next, lateycleTransition, score: next.confirmed ? cfg.curveRegime.scores[next.confirmed] : null };
}
