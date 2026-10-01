// Bond Lens overlay — §4.4 Growth/inflation surprise quadrant and hedge
// reliability. Pure, Deno-API-free.

import { Quadrant } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";

// Inflation axis: the change in T5YIE (8-week, by index) plus the sign of
// infl_trend -- spec §4.4. `t5yieChange` is T5YIE[t] - T5YIE[t-8w];
// `inflTrendSign` is +1/0/-1 from §4.2's infl_trend at the same date.
export function inflationAxis(t5yieChange: number | null, inflTrendSign: number | null): number | null {
  if (t5yieChange == null || inflTrendSign == null) return null;
  return t5yieChange + inflTrendSign;
}

// Quadrant mapping (spec §4.4 table). quadrant_score is a documented
// judgment call (spec gives the qualitative ranking, not numbers): Q4
// (falling growth, falling inflation) is the classic "flight to quality"
// regime, strongly favorable; Q3 (falling growth, rising inflation --
// stagflation) is worst for NOMINAL duration specifically, since that's
// exactly where the stock-bond hedge breaks down (spec's own "nominal
// hedge weak" wording) -- more negative than Q2, not just "also negative."
const QUADRANT_SCORES: Record<Quadrant, number> = { Q4: 2, Q1: -0.5, Q2: -1.5, Q3: -2 };

export interface QuadrantResult {
  quadrant: Quadrant | null;
  raw: { growthMom: number | null; inflAxis: number | null };
  score: number | null;
  excluded: boolean;
  excludeReason?: string;
}

export function classifyQuadrant(growthMom: number | null, inflAxis: number | null): QuadrantResult {
  if (growthMom == null || inflAxis == null) {
    return { quadrant: null, raw: { growthMom, inflAxis }, score: null, excluded: true, excludeReason: "growth_mom or inflation axis unavailable" };
  }
  const growthUp = growthMom >= 0;
  const inflUp = inflAxis >= 0;
  const quadrant: Quadrant = growthUp ? (inflUp ? "Q2" : "Q1") : (inflUp ? "Q3" : "Q4");
  return { quadrant, raw: { growthMom, inflAxis }, score: QUADRANT_SCORES[quadrant], excluded: false };
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
// lacks enough non-null returns in that window -- spec §4.4: "Use
// synthetic returns as the fallback" when SPY/IEF price history is
// unavailable; that synthetic-return construction (price_par_bond-driven)
// isn't built here yet, so this module correctly reports "unavailable"
// rather than silently treating a null as zero correlation. TODO once a
// real caller needs it pre-ETF-inception.
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
  hedgeReliable: boolean;
  streak: number; // consecutive weekly reads agreeing with the CURRENT hedgeReliable value
}

// hedge_reliable = false when corr > threshold, OR (quadrant is Q2/Q3 AND
// corr > 0) -- spec §4.4. Only flips after `hysteresisReads` consecutive
// weekly reads agreeing with the new value (spec: "the flag only flips
// after 2 consecutive weekly reads"), same walk-forward-state pattern as
// Market Conditions' resolveTrendState.
export function stepHedgeReliable(
  corr: number | null, quadrant: Quadrant | null, prior: HedgeState, cfg = BOND_LENS_CONFIG,
): HedgeState {
  if (corr == null) return prior; // no new read this week -- hold state, don't count toward either streak
  const wouldBeUnreliable = corr > cfg.hedge.corrThreshold || ((quadrant === "Q2" || quadrant === "Q3") && corr > 0);
  const candidate = !wouldBeUnreliable; // candidate = "hedge IS reliable"
  if (candidate === prior.hedgeReliable) return { hedgeReliable: prior.hedgeReliable, streak: 0 };
  const streak = prior.streak + 1;
  if (streak >= cfg.hedge.hysteresisReads) return { hedgeReliable: candidate, streak: 0 };
  return { hedgeReliable: prior.hedgeReliable, streak };
}
