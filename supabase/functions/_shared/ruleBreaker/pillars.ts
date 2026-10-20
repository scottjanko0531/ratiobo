// Rule Breaker Screener — pillar aggregation (c1-c6, composite, score,
// rank, safety, quality). CONFIRMED (exact match against all 155 baseline
// rows, verified via scripts/rb-calibrate.ts's methodology run locally
// this session): composite = mean(c1..c6); score =
// round(crossSectionalPercentile(composite)); rank =
// descendingRank(composite).
//
// NOT CONFIRMED -- c1-c6 and safety/quality/c5 are ALL still open,
// INCLUDING c1: an earlier pass in this same session concluded "c1 = mean
// of its driver pcts" from a single example (AMD: mean=80.39, actual=80,
// a near-exact coincidental match), but testing that formula against the
// full 155-row baseline refutes it outright (0/155 within even a loose
// tolerance -- e.g. ARM: mean=55.56, actual=78, a 22-point gap; most
// symbols' actual c1 is substantially HIGHER than the flat mean of their
// own displayed driver pcts, not just off by rounding). A "percentile of
// the combined raw growth value" alternative was also tested and refuted
// (3/154). Whatever combines c1's sub-metrics into one 0-100 score is
// NOT a simple mean of percentiles, in either direction. All six
// pillars throw NotCalibratedError rather than silently guessing -- this
// is scripts/rb-calibrate.ts's open job, not resolved by this session.

import { crossSectionalPercentile, descendingRank } from "./crossSectionalRank.ts";
import type { DriverEntry } from "./types.ts";

export class NotCalibratedError extends Error {
  constructor(field: string) {
    super(
      `${field} is not yet calibrated against the artifact baseline -- ` +
        `see pillars.ts header comment and scripts/rb-calibrate.ts`,
    );
    this.name = "NotCalibratedError";
  }
}

export function computeC1(_c1Drivers: DriverEntry[]): number {
  throw new NotCalibratedError("c1");
}

export function computeC2(_c2Drivers: DriverEntry[]): number {
  throw new NotCalibratedError("c2");
}

export function computeC3(_c3Drivers: DriverEntry[]): number {
  throw new NotCalibratedError("c3");
}

export function computeC4(_c4Drivers: DriverEntry[]): number {
  throw new NotCalibratedError("c4");
}

// No `drivers` entry exists for c5 at all in the real export -- it's a
// discrete 5-value field (20/40/60/80/100 only), not derived from
// continuous fundamentals the way c1-c4/c6 are.
export function computeC5(): number {
  throw new NotCalibratedError("c5");
}

export function computeC6(_c6Drivers: DriverEntry[]): number {
  throw new NotCalibratedError("c6");
}

export function computeSafety(_safetyDrivers: DriverEntry[]): number {
  throw new NotCalibratedError("safety");
}

export function computeQuality(): number {
  throw new NotCalibratedError("quality");
}

// Confirmed exact: simple mean of c1..c6.
export function computeComposite(c1: number, c2: number, c3: number, c4: number, c5: number, c6: number): number {
  return (c1 + c2 + c3 + c4 + c5 + c6) / 6;
}

// Confirmed exact (155/155, including every tie case): score is the
// cross-sectional percentile RANK of `composite` within the live universe
// (rounded), NOT composite itself and NOT a simple rescale -- score and
// composite are two genuinely different fields (score is consistently
// higher, e.g. composite=78.5 -> score=96 for one baseline example).
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
