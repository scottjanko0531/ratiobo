// Rule Breaker Screener — pillar aggregation (c1-c6, met, composite, score,
// rank, safety, quality). Formula supplied directly by the user from the
// live screen's own source code (not reverse-engineered) and confirmed
// 155/155 exact against the full real baseline this session, once 8 real
// bugs in metrics.ts's underlying sub-metric formulas were found and fixed
// (see metrics.ts for each one) -- this file's own formulas needed no
// changes once those were corrected.
//
// Key shape: c1/c2/c4 BLEND a computed pillar number with a human rating
// (rb_ratings.td/moat/mgmt respectively, scaled *20); c5 is PURELY a
// rating (rb_ratings.appeal*20, no fundamentals-derived component at all
// -- matches this session's earlier finding that c5 has no `drivers`
// entry); c3/c6 are purely computed, no rating blend. `safety` and
// `quality` are each a SECOND-ORDER cross-sectional percentile: first
// average some driver/pillar percentiles into a raw score, then rank that
// raw score again across the whole universe.

import { crossSectionalPercentile, descendingRank } from "./crossSectionalRank.ts";
import type { DriverEntry } from "./types.ts";

// Mean of a driver group's non-null percentiles. The caller must compute
// those percentiles fresh from raw data (crossSectionalRank.ts), NOT read
// them back from a stored `drivers` JSON that may be rounded to 2 decimals
// -- that rounding is coarse enough to flip a result right at a .5
// boundary (confirmed real case: RGEN's c6 lands exactly on 80.5).
export function pillarNum(drivers: DriverEntry[]): number | null {
  const pcts = drivers.map((d) => d.pct).filter((p): p is number => p != null);
  if (pcts.length === 0) return null;
  return pcts.reduce((sum, p) => sum + p, 0) / pcts.length;
}

// A human rating (rb_ratings.td/moat/mgmt/appeal, each 0-5) scaled onto
// the same 0-100 space as the computed pillar numbers.
export function rating20(rating: number | null): number | null {
  return rating == null ? null : rating * 20;
}

// Average of a computed pillar number and a human rating when BOTH exist;
// whichever one exists when only one does; null when neither does.
export function blend(computed: number | null, rating: number | null): number | null {
  if (computed != null && rating != null) return 0.5 * computed + 0.5 * rating;
  return computed ?? rating;
}

function roundOrNull(value: number | null): number | null {
  return value == null ? null : Math.round(value);
}

export function computeC1(c1Drivers: DriverEntry[], td: number | null): number | null {
  return roundOrNull(blend(pillarNum(c1Drivers), rating20(td)));
}

export function computeC2(c2Drivers: DriverEntry[], moat: number | null): number | null {
  return roundOrNull(blend(pillarNum(c2Drivers), rating20(moat)));
}

export function computeC3(c3Drivers: DriverEntry[]): number | null {
  return roundOrNull(pillarNum(c3Drivers));
}

export function computeC4(c4Drivers: DriverEntry[], mgmt: number | null): number | null {
  return roundOrNull(blend(pillarNum(c4Drivers), rating20(mgmt)));
}

// Purely a human rating -- no fundamentals-derived component at all
// (matches the earlier finding this session that c5 has no `drivers`
// entry in the real export). Null when there's no rating for this symbol
// at all (confirmed real case: ECHO has no rb_ratings row, c5=null).
export function computeC5(appeal: number | null): number | null {
  return roundOrNull(rating20(appeal));
}

export function computeC6(c6Drivers: DriverEntry[]): number | null {
  return roundOrNull(pillarNum(c6Drivers));
}

// Count of the six ROUNDED signs that are >=60 (not >=50 -- an earlier
// placeholder in this file guessed 50; the real threshold supplied this
// session is 60). Null signs don't count.
export function computeMet(signs: Array<number | null>): number {
  return signs.filter((s) => s != null && s >= 60).length;
}

// Mean of the six ROUNDED signs, skipping nulls (e.g. ECHO's null c5 just
// reduces the denominator to 5, it isn't treated as 0).
export function computeComposite(signs: Array<number | null>): number | null {
  const nonNull = signs.filter((s): s is number => s != null);
  if (nonNull.length === 0) return null;
  return nonNull.reduce((sum, s) => sum + s, 0) / nonNull.length;
}

// Stage 1 of `safety`: mean of the 4 safety driver percentiles. Those
// percentiles are already direction-inverted ("lower is better" ->
// crossSectionalRank.ts's lowerIsBetter flag) by the caller building
// `safetyDrivers`, so this is just a flat mean, same shape as pillarNum.
export function computeSafetyRaw(safetyDrivers: DriverEntry[]): number | null {
  return pillarNum(safetyDrivers);
}

// Stage 2: `safetyRaw` itself gets cross-sectionally ranked AGAIN across
// the whole universe (a percentile of a percentile-average) -- the caller
// supplies that rank already computed (scoring.ts does this as a
// universe-wide pass, see computeUniverseScores). Null safetyRaw (every
// driver was null) defaults to the pct midpoint 50 before rounding, not to
// null.
export function computeSafety(safetyPct: number | null): number {
  return Math.round(safetyPct ?? 50);
}

// Stage 1 of `quality`: mean of prof/cash/trend pillar numbers AND the
// already-computed safetyPct (NOT safetyRaw -- quality blends in the
// safety PERCENTILE, one stage further downstream than the raw average).
export function computeQualityRaw(
  profDrivers: DriverEntry[],
  cashDrivers: DriverEntry[],
  trendDrivers: DriverEntry[],
  safetyPct: number | null,
): number | null {
  const parts = [pillarNum(profDrivers), pillarNum(cashDrivers), pillarNum(trendDrivers), safetyPct];
  const nonNull = parts.filter((p): p is number => p != null);
  if (nonNull.length === 0) return null;
  return nonNull.reduce((sum, p) => sum + p, 0) / nonNull.length;
}

// Stage 2: qraw cross-sectionally ranked across the whole universe (same
// two-stage shape as safety). Caller supplies the already-computed rank.
export function computeQuality(qualityPct: number | null): number | null {
  return roundOrNull(qualityPct);
}

// Confirmed exact (155/155, including every tie case): score is the
// cross-sectional percentile RANK of `composite` within the live universe
// (rounded). `compositeUniverse` must include every symbol's composite,
// non-null only (per the shared pct() convention -- nulls are excluded
// from ranking universes throughout this module, not substituted).
export function computeScore(composite: number, compositeUniverse: number[]): number {
  return Math.round(crossSectionalPercentile(compositeUniverse, composite));
}

// Confirmed exact: 1-indexed descending sort of composite (stable
// tie-break, see crossSectionalRank.ts's descendingRank comment).
// `compositeUniverse` must include this symbol's own composite at
// `targetIndex`.
export function computeRank(compositeUniverse: number[], targetIndex: number): number {
  return descendingRank(compositeUniverse, targetIndex);
}
