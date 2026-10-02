// Bond Lens overlay — §4.1 Carry and rolldown. Pure, Deno-API-free.

import { rollingZScoreSeries, ZScoreResult } from "./normalize.ts";
import { BOND_LENS_CONFIG } from "./config.ts";

// Modified duration of a par bond paying semiannual coupons at the given
// yield, maturing in `n` years. Hand-computed check (spec §4 Phase B
// acceptance): y=0.05, n=10 -> D_mod ~= 7.79.
export function modifiedDuration(yieldDecimal: number, n: number): number {
  return (1 / yieldDecimal) * (1 - Math.pow(1 + yieldDecimal / 2, -2 * n));
}

// Curve as (tenor years, yield decimal) knots, sorted ascending by tenor.
// Linear interpolation for any tenor between the first and last knot; null
// outside that range (never extrapolated) or if either bracketing knot is
// missing.
export type CurveKnot = [tenor: number, yieldDecimal: number | null];

export function interpolateYield(knots: CurveKnot[], tenor: number): number | null {
  for (const [t, y] of knots) if (t === tenor && y != null) return y;
  for (let i = 0; i < knots.length - 1; i++) {
    const [t0, y0] = knots[i], [t1, y1] = knots[i + 1];
    if (tenor > t0 && tenor < t1) {
      if (y0 == null || y1 == null) return null;
      return y0 + ((tenor - t0) / (t1 - t0)) * (y1 - y0);
    }
  }
  return null;
}

export interface CarryRolldownResult {
  Dmod_n: number | null;
  Dmod_n1: number | null; // D_mod(n-1), the rolldown-leg duration
  y_n1: number | null; // y_(n-1), interpolated
  CR: number | null; // 12-month carry and rolldown
  BE: number | null; // breakeven yield rise
  EFF: number | null; // efficiency -- spec §4.1 defines this with the SAME formula as BE (CR/D_mod(n)), not a typo here, just what's specified
}

// `knots` must include the tenor `n` itself and enough of the curve around
// n-1 to interpolate (or an exact match at n-1, e.g. n=2 -> y_1 = DGS1
// directly, no interpolation needed).
export function carryAndRolldown(knots: CurveKnot[], n: number): CarryRolldownResult {
  const y_n = interpolateYield(knots, n);
  const y_n1 = interpolateYield(knots, n - 1);
  if (y_n == null || y_n1 == null) {
    return { Dmod_n: null, Dmod_n1: null, y_n1, CR: null, BE: null, EFF: null };
  }
  const Dmod_n = modifiedDuration(y_n, n);
  const Dmod_n1 = modifiedDuration(y_n1, n - 1);
  const CR = y_n + Dmod_n1 * (y_n - y_n1);
  const BE = CR / Dmod_n;
  const EFF = CR / Dmod_n; // spec §4.1: "EFF_n = CR_n / D_mod(n)" -- identical to BE_n's formula as written.
  return { Dmod_n, Dmod_n1, y_n1, CR, BE, EFF };
}

export interface CarryHistoryInputs {
  dates: string[];
  dgs3mo: (number | null)[];
  dgs1: (number | null)[];
  dgs2: (number | null)[];
  dgs3: (number | null)[];
  dgs5: (number | null)[];
  dgs7: (number | null)[];
  dgs10: (number | null)[];
  dgs30: (number | null)[];
}

export interface CarryDayResult {
  carryScore: ZScoreResult;
}

// Builds every tenor's knots for one day -- factored out so
// computeCarryHistory (only needs n=10, for carry_score) and a future
// "per-maturity table for the latest day" API (spec §4.1's "Output: a
// per-maturity table", n=2/5/7/10, not wired into bond_signals -- that
// table has nowhere to land in its schema, only carry_score does) can
// share it without computeCarryHistory paying for maturities it
// never uses.
export function curveKnotsAt(inputs: CarryHistoryInputs, t: number): CurveKnot[] {
  const toDecimal = (pct: number | null) => (pct == null ? null : pct / 100);
  return [
    [0.25, toDecimal(inputs.dgs3mo[t])],
    [1, toDecimal(inputs.dgs1[t])],
    [2, toDecimal(inputs.dgs2[t])],
    [3, toDecimal(inputs.dgs3[t])],
    [5, toDecimal(inputs.dgs5[t])],
    [7, toDecimal(inputs.dgs7[t])],
    [10, toDecimal(inputs.dgs10[t])],
    [30, toDecimal(inputs.dgs30[t])],
  ];
}

// All yields in `inputs` are PERCENT (FRED convention, e.g. 4.5 for 4.5%),
// converted to decimal via curveKnotsAt since modifiedDuration's formula
// needs y/2 etc. in decimal terms. Only computes the n=10 leg -- the only
// one carry_score (the sole §4.1 output bond_signals actually stores)
// needs; computing and retaining 2/5/7 too for every one of ~16k days,
// never consumed downstream, was real GC pressure worth cutting.
export function computeCarryHistory(inputs: CarryHistoryInputs, cfg = BOND_LENS_CONFIG): CarryDayResult[] {
  const n = inputs.dates.length;
  const toDecimal = (pct: number | null) => (pct == null ? null : pct / 100);
  const cr10MinusBill: (number | null)[] = new Array(n).fill(null);

  for (let t = 0; t < n; t++) {
    const knots = curveKnotsAt(inputs, t);
    const cr10 = carryAndRolldown(knots, 10);
    const bill = toDecimal(inputs.dgs3mo[t]);
    if (cr10.CR != null && bill != null) cr10MinusBill[t] = cr10.CR - bill;
  }

  // O(n) via rollingZScoreSeries, not O(n*window) from calling
  // rollingZScoreAt per day -- real CPU time, confirmed by edge function
  // logs (bond-lens-compute hitting Supabase's ~2000ms per-invocation
  // CPU cap, not a memory limit despite the WORKER_RESOURCE_LIMIT error
  // code) once path_score/quadrant_score also went continuous and ate
  // into the same budget.
  const zSeries = rollingZScoreSeries(cr10MinusBill, cfg);
  const out: CarryDayResult[] = new Array(n);
  for (let t = 0; t < n; t++) out[t] = { carryScore: zSeries[t] };
  return out;
}
