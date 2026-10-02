// Bond Lens overlay — §4.2 Priced path vs. likely path. Pure, Deno-API-free.

import { indexDaysAgo, clip, ZScoreResult } from "./normalize.ts";
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
  if (firstIdx == null) return { value: null, degraded: true, reason: "quarter has no prior release yet" };
  if (firstIdx === t) {
    // t IS the quarter's own first release -- zero elapsed time, so
    // "change since first release" is undefined (division by zero).
    // Carry the prior day's own growth_mom reading forward instead
    // (Scott's documented fallback for exactly this one-day edge case,
    // 2026-10-02 follow-up #3), flagged degraded. This was the actual
    // source of the null rows observed at the end of Jan/Apr/Jul/Oct --
    // GDPNow's target_quarter label flips to the new quarter ~1 day
    // before month-end in each case, and that single day had no basis
    // for a change, so it fell through to null.
    if (t === 0) return { value: null, degraded: true, reason: "no prior growth_mom to carry forward" };
    const prior = growthMom(dates, values, targetQuarters, t - 1, lookbackDays);
    return { value: prior.value, degraded: true, reason: "first release of a new quarter -- carried prior day's growth_mom forward" };
  }
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

// Continuous path_score (2026-10-02 follow-up #4, replacing the 3-state
// mismatch formula that landed exactly on 0 whenever priced and data
// direction agreed -- 53% of months, far more "in between" than the
// spec's qualitative rule actually implies).
//
// Scott's first draft of the formula was a plain product,
// z(priced_hikes) * -z(data_momentum) -- algebraically that's always
// positive whenever the two z's have opposite signs, REGARDLESS of which
// one is positive. That collapses "hikes priced + data decelerating"
// (bond-bullish) and "cuts priced + data accelerating" (bond-bearish)
// onto the SAME sign, losing the directional distinction the old 3-state
// formula preserved. Confirmed with Scott and corrected to:
//   path = clip(-z(data_momentum) * abs(z(priced_hikes)), -2, +2)
// Sign comes from data_momentum alone (bullish when the data is cooling,
// bearish when it's heating); priced_hikes' magnitude only SCALES that
// signal (a bigger priced repricing makes the same directional read
// matter more), never flips it. data_momentum = average(z(growth_mom),
// z(infl_trend)).
export function pathScoreContinuous(pricedHikesZ: ZScoreResult, growthMomZ: ZScoreResult, inflTrendZ: ZScoreResult): { score: number | null; excluded: boolean; excludeReason?: string } {
  if (pricedHikesZ.excluded) return { score: null, excluded: true, excludeReason: pricedHikesZ.excludeReason };
  // data_momentum tolerates ONE of growth_mom/infl_trend being excluded
  // (averages whichever is available) -- both excluded is the only
  // genuine "no data" case, same reweighting spirit as §4 Phase B's
  // "missing inputs are reweighted and flagged, never silently zeroed."
  const parts = [growthMomZ, inflTrendZ].filter((z) => !z.excluded).map((z) => z.z as number);
  if (parts.length === 0) return { score: null, excluded: true, excludeReason: "growth_mom and infl_trend both unavailable" };
  const dataMomentumZ = parts.reduce((a, b) => a + b, 0) / parts.length;
  const score = clip(-dataMomentumZ * Math.abs(pricedHikesZ.z as number), -2, 2);
  return { score, excluded: false };
}
