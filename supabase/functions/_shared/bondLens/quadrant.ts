// Bond Lens overlay — §4.4 Growth/inflation surprise quadrant and hedge
// reliability. Pure, Deno-API-free.

import { Quadrant } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";
import { ZScoreResult } from "./normalize.ts";

// Inflation axis: the change in T5YIE (8-week, by index) plus the sign of
// infl_trend -- spec §4.4. `t5yieChange` is T5YIE[t] - T5YIE[t-8w];
// `inflTrendSign` is +1/0/-1 from §4.2's infl_trend at the same date.
export function inflationAxis(t5yieChange: number | null, inflTrendSign: number | null): number | null {
  if (t5yieChange == null || inflTrendSign == null) return null;
  return t5yieChange + inflTrendSign;
}

// Quadrant LABEL (display only, 2026-10-02 follow-up #2 -- quadrant_score
// is now continuous, computed by quadrantScoreContinuous below). The
// label is still the plain sign-based classification the spec's own
// table describes.
export function classifyQuadrantLabel(growthMom: number | null, inflAxis: number | null): Quadrant | null {
  if (growthMom == null || inflAxis == null) return null;
  const growthUp = growthMom >= 0;
  const inflUp = inflAxis >= 0;
  return growthUp ? (inflUp ? "Q2" : "Q1") : (inflUp ? "Q3" : "Q4");
}

export interface QuadrantLabelState {
  confirmed: Quadrant | null;
  candidate: Quadrant | null;
  candidateStreak: number;
}

// 3-week persistence before the DISPLAYED label changes (2026-10-02
// follow-up #2: the label was flipping ~18x/year off a noisy sign flip;
// the continuous score already reacts daily, this only slows down the
// Q1-Q4 badge). Same walk-forward hysteresis pattern as hedge_reliable
// and curve_regime. Evaluated at weekly reads only (same cadence as
// those two), via a candidate label computed from THAT week's own
// growth_mom/inflAxis.
export function stepQuadrantLabel(
  candidate: Quadrant | null, prior: QuadrantLabelState, cfg = BOND_LENS_CONFIG,
): QuadrantLabelState {
  if (candidate == null) return prior; // no new read -- hold state
  if (candidate === prior.candidate) {
    const candidateStreak = prior.candidateStreak + 1;
    if (candidate !== prior.confirmed && candidateStreak >= cfg.quadrant.labelPersistenceWeeks) {
      return { confirmed: candidate, candidate, candidateStreak };
    }
    return { ...prior, candidateStreak };
  }
  return { ...prior, candidate, candidateStreak: 1 };
}

export interface QuadrantScoreResult {
  score: number | null;
  excluded: boolean;
  excludeReason?: string;
}

// Continuous quadrant_score (2026-10-02 follow-up #2, replacing the fixed
// 4-point lookup table that swung up to 4 points on a single noisy sign
// flip): score = clip(-(growth_z + infl_z) / 2, -2, +2), where both axes
// are z-scored over the same 2520d/756d rolling window every other
// z-score in this module uses. Higher growth and higher inflation are
// both bond-bearish for nominal duration, hence the negative sign;
// dividing by 2 keeps a "both axes strongly up" reading at the same -2
// floor the old table's worst case (Q3) used, without needing a separate
// asymmetric stagflation penalty -- Scott's own formula, a documented
// simplification of the old table's qualitative stagflation emphasis.
export function quadrantScoreContinuous(growthZ: ZScoreResult, inflZ: ZScoreResult): QuadrantScoreResult {
  if (growthZ.excluded || inflZ.excluded) {
    return { score: null, excluded: true, excludeReason: growthZ.excludeReason ?? inflZ.excludeReason };
  }
  const score = -((growthZ.z as number) + (inflZ.z as number)) / 2;
  return { score: Math.max(-2, Math.min(2, score)), excluded: false };
}

// --- Hedge reliability ---

export function dailyReturns(prices: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [null];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i];
    out.push(p0 != null && p1 != null && p0 !== 0 ? p1 / p0 - 1 : null);
  }
  return out;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

// Rolling `window`-trading-day correlation of two return series ending at
// (and including) index t. Null (excluded, not zero) if either series
// lacks enough non-null returns in that window -- before SPY/IEF both
// have `window` days of REAL overlapping history (IEF inception
// 2002-07-30, so in practice ~Dec 2002), this always returns null; the
// caller (scoring.ts) falls back to the pre-1993 monthly construction in
// syntheticBond.ts for that whole pre-real-data stretch, rather than
// treating a null here as "reliable by default."
export function hedgeCorrelation(spyReturns: (number | null)[], ieftReturns: (number | null)[], t: number, window: number): number | null {
  const xs: number[] = [], ys: number[] = [];
  for (let i = Math.max(0, t - window + 1); i <= t; i++) {
    const x = spyReturns[i], y = ieftReturns[i];
    if (x != null && y != null) { xs.push(x); ys.push(y); }
  }
  if (xs.length < window) return null;
  return pearson(xs, ys);
}

export interface HedgeState {
  hedgeReliable: boolean | null; // null = no real-or-fallback correlation reading exists yet (degraded), never a silent default
  streak: number; // consecutive weekly reads agreeing with the CURRENT hedgeReliable value
}

// hedge_reliable = false when corr > threshold, OR (quadrant is Q2/Q3 AND
// corr > 0) -- spec §4.4. Only flips after `hysteresisReads` consecutive
// weekly reads agreeing with the new value (spec: "the flag only flips
// after 2 consecutive weekly reads"), same walk-forward-state pattern as
// Market Conditions' resolveTrendState.
//
// `degraded` on the result marks this read as having come from the
// pre-1993 monthly fallback rather than the real 90-day SPY/IEF
// correlation -- the caller passes the fallback-or-real corr value in
// either case; this function itself doesn't know which source it is,
// only that a reading of `null` here means NEITHER source had enough
// history (2026-10-02 follow-up #1: this used to silently hold the
// initial `true` default forever when `corr` was null for the entire
// pre-ETF period -- the actual bug, not the Jan-Jul 2022 window, which a
// direct SQL check showed was a genuinely negative-to-near-zero real
// correlation that only crossed positive and triggered the rule on
// 2022-07-22, exactly as the hysteresis-confirmed data in bond_signals
// already showed).
export function stepHedgeReliable(
  corr: number | null, quadrant: Quadrant | null, prior: HedgeState, cfg = BOND_LENS_CONFIG,
): HedgeState {
  if (corr == null) {
    // No reading this week from EITHER source. If we've never established
    // a real value, stay null (degraded) -- never default to true. If we
    // have an established value, hold it (a single missing week of price
    // data shouldn't erase a known state).
    return prior.hedgeReliable === null ? { hedgeReliable: null, streak: 0 } : prior;
  }
  const wouldBeUnreliable = corr > cfg.hedge.corrThreshold || ((quadrant === "Q2" || quadrant === "Q3") && corr > 0);
  const candidate = !wouldBeUnreliable; // candidate = "hedge IS reliable"
  if (candidate === prior.hedgeReliable) return { hedgeReliable: prior.hedgeReliable, streak: 0 };
  const streak = prior.streak + 1;
  if (streak >= cfg.hedge.hysteresisReads) return { hedgeReliable: candidate, streak: 0 };
  return { hedgeReliable: prior.hedgeReliable, streak };
}
