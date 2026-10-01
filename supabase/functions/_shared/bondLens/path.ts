// Bond Lens overlay — §4.2 Priced path vs. likely path. Pure, Deno-API-free.

import { indexDaysAgo, clip } from "./normalize.ts";
import { ModuleResult } from "./types.ts";

// priced_hikes = DGS2 - DFF, in percentage points. Positive means the
// market is pricing hikes.
export function pricedHikes(dgs2: number | null, dff: number | null): number | null {
  if (dgs2 == null || dff == null) return null;
  return dgs2 - dff;
}

// infl_trend = core PCE 3-month annualized minus its own 12-month rate.
// `pceIndex` is the raw core PCE price INDEX level (FRED PCEPILFE), not
// the already-annualized rate -- 3mo annualized = (I_t/I_{t-3mo})^4 - 1,
// 12mo = I_t/I_{t-12mo} - 1, both from the index level directly, matching
// how PCEPILFE is actually published (an index, not a rate).
export function inflTrend(
  pceIndex: (number | null)[], dates: string[], t: number,
): ModuleResult<{ ann3mo: number | null; rate12mo: number | null }> {
  const i3 = indexDaysAgo(dates, t, 91);
  const i12 = indexDaysAgo(dates, t, 365);
  const now = pceIndex[t];
  if (i3 == null || i12 == null || now == null || pceIndex[i3] == null || pceIndex[i12] == null) {
    return { raw: { ann3mo: null, rate12mo: null }, score: null, excluded: true, excludeReason: "insufficient PCE history" };
  }
  const base3 = pceIndex[i3] as number, base12 = pceIndex[i12] as number;
  if (base3 <= 0 || base12 <= 0) return { raw: { ann3mo: null, rate12mo: null }, score: null, excluded: true, excludeReason: "non-positive PCE index" };
  const ann3mo = Math.pow(now / base3, 4) - 1;
  const rate12mo = now / base12 - 1;
  return { raw: { ann3mo, rate12mo }, score: ann3mo - rate12mo, excluded: false };
}

export interface GrowthMomResult {
  value: number | null;
  degraded: boolean;
  reason?: string;
}

// growth_mom = 8-week change in GDPNOW, computed WITHIN the live target
// quarter (bond-lens-decisions.md, 2026-10-02 follow-up: the nowcast
// resets at each quarter boundary, so a raw difference across that reset
// is meaningless). When the 8-week lookback would cross into the prior
// quarter, use the SCALED version instead (Scott's call over carry-
// forward): the change in the CURRENT quarter's own nowcast since its
// first release, scaled up to an 8-week-equivalent rate -- noisy in the
// first few days of a quarter (small denominator), but that's inherent to
// "a brand-new quarter has no 8 weeks of its own history yet," not a flaw
// in the method.
export function growthMom(
  dates: string[], values: (number | null)[], targetQuarters: (string | null)[], t: number, lookbackDays: number,
): GrowthMomResult {
  const now = values[t];
  const nowQ = targetQuarters[t];
  if (now == null || nowQ == null) return { value: null, degraded: true, reason: "GDPNow unavailable (pre-2011 or missing target_quarter)" };

  const i8w = indexDaysAgo(dates, t, lookbackDays);
  if (i8w != null && targetQuarters[i8w] === nowQ && values[i8w] != null) {
    return { value: now - (values[i8w] as number), degraded: false };
  }

  // Boundary case (or not enough history for a full 8-week lookback at
  // all): find the quarter's own first release and scale.
  let firstIdx: number | null = null;
  for (let i = t; i >= 0; i--) {
    if (targetQuarters[i] !== nowQ) break;
    if (values[i] != null) firstIdx = i;
  }
  if (firstIdx == null || firstIdx === t) return { value: null, degraded: true, reason: "quarter has no prior release yet" };
  const daysSinceFirst = daysBetween(dates[firstIdx], dates[t]);
  if (daysSinceFirst <= 0) return { value: null, degraded: true, reason: "quarter has no prior release yet" };
  const changeSinceFirst = now - (values[firstIdx] as number);
  return { value: (changeSinceFirst / daysSinceFirst) * lookbackDays, degraded: true, reason: "scaled to 8-week-equivalent across a quarter boundary" };
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}

// Pre-2011 fallback (spec §4.2: "Before 2011, substitute the 3-month
// change in 5y breakevens plus curve momentum, flagged as degraded"):
// curve momentum defined here as the 3-month change in the 10y-2y slope
// -- spec doesn't pin down "curve momentum" further than the name, so
// this is a documented judgment call, not a literal spec value.
export function growthMomFallback(
  dates: string[], t5yie: (number | null)[], slope10y2y: (number | null)[], dates2: string[], t: number,
): GrowthMomResult {
  const i3mo = indexDaysAgo(dates, t, 91);
  if (i3mo == null) return { value: null, degraded: true, reason: "pre-2011 fallback has insufficient history" };
  const be = t5yie[t], beBase = t5yie[i3mo];
  const slope = slope10y2y[t], slopeBase = slope10y2y[i3mo];
  if (be == null || beBase == null || slope == null || slopeBase == null) {
    return { value: null, degraded: true, reason: "pre-2011 fallback inputs unavailable" };
  }
  return { value: (be - beBase) + (slope - slopeBase), degraded: true, reason: "pre-2011: 3mo breakeven change + curve momentum proxy" };
}

export interface PathScoreResult {
  pricedHikes: number | null;
  growthMom: GrowthMomResult;
  inflTrend: ModuleResult<unknown>;
  score: number | null;
  excluded: boolean;
}

// Maps (priced_hikes, growth_mom) to [-2, +2]. Bond-bullish when hikes are
// priced but growth is decelerating (the priced path is more hawkish than
// the data supports -> yields likely fall as that gap closes); bond-
// bearish when cuts are priced but growth is accelerating (mirror case);
// "in between" (score near 0) when priced direction and data direction
// AGREE (nothing left to re-price) or either input is unavailable.
//
// PRICED_SCALE/GROWTH_SCALE: provisional normalizing divisors (not spec
// values -- the spec gives the qualitative rule, not a formula), Phase E
// tunable like every other threshold in this module.
const PRICED_SCALE = 1.0; // pp of DGS2-DFF considered a "large" priced move
const GROWTH_SCALE = 1.5; // pp of 8-week GDPNow change considered "large"

// `infl` is computed separately (inflTrend() above) and carried through
// on the result unchanged -- it's a real §4.2 output (feeds bond_signals'
// infl_trend column) but, per the spec's own text, consumed downstream by
// §4.4's inflation axis, not by this module's own score.
export function pathScore(dgs2: number | null, dff: number | null, gm: GrowthMomResult, infl: ModuleResult<unknown>): PathScoreResult {
  const hikes = pricedHikes(dgs2, dff);
  if (hikes == null || gm.value == null) {
    return { pricedHikes: hikes, growthMom: gm, inflTrend: infl, score: null, excluded: true };
  }
  const pricedDir = clip(hikes / PRICED_SCALE, -1, 1);
  const dataDir = clip(gm.value / GROWTH_SCALE, -1, 1);
  const mismatch = Math.max(0, -pricedDir * dataDir); // >0 only when priced direction and data direction disagree
  const score = clip(-dataDir * mismatch * 2, -2, 2);
  return { pricedHikes: hikes, growthMom: gm, inflTrend: infl, score, excluded: false };
}
