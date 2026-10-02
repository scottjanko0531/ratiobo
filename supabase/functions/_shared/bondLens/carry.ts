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
  BE: number | null; // breakeven yield rise -- CR_n / D_mod(n). Kept in the UI per-maturity table.
}

// (2026-10-02 follow-up #7, Scott's "my spec error" fix): this used to also
// return an `EFF` field with the SAME formula as BE (CR/D_mod(n)) -- that
// field is gone. EFF_n is now a genuinely different, risk-adjusted metric
// (excess carry per unit of yield vol: (CR_n - y_3m) / (D_mod(n) * sigma_n)
// -- see composite.ts's sharpeEffHistory), which needs a full trailing
// history of daily yield changes (sigma_n's own rolling window) that a
// single day's curve knots can't supply -- so it's computed one level up,
// in composite.ts, not here.
//
// `knots` must include the tenor `n` itself and enough of the curve around
// n-1 to interpolate (or an exact match at n-1, e.g. n=2 -> y_1 = DGS1
// directly, no interpolation needed).
export function carryAndRolldown(knots: CurveKnot[], n: number): CarryRolldownResult {
  const y_n = interpolateYield(knots, n);
  const y_n1 = interpolateYield(knots, n - 1);
  if (y_n == null || y_n1 == null) {
    return { Dmod_n: null, Dmod_n1: null, y_n1, CR: null, BE: null };
  }
  const Dmod_n = modifiedDuration(y_n, n);
  const Dmod_n1 = modifiedDuration(y_n1, n - 1);
  const CR = y_n + Dmod_n1 * (y_n - y_n1);
  const BE = CR / Dmod_n;
  return { Dmod_n, Dmod_n1, y_n1, CR, BE };
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
  // DTB3 (secondary-market 3mo T-bill, FRED from 1954) -- fallback bill
  // yield wherever DGS3MO (from 1981-09-01) is unavailable, so carry_score
  // and the maturity-pref Sharpe ratio's y_3m term can both extend back to
  // DTB3's start once it's backfilled (scripts/backfill-dtb3.mjs). Optional
  // -- every existing caller/test that doesn't supply it just gets the
  // pre-this-change DGS3MO-only behavior (billYieldPct falls through to
  // null, same as `dgs3mo[t] ?? null` always did).
  dtb3?: (number | null)[];
}

// The 3-month bill yield (percent, FRED convention) used for both
// carry_score's bill leg and the maturity-pref Sharpe ratio's y_3m: DGS3MO
// first, DTB3 as a fallback wherever DGS3MO is null (pre-1981-09, or any
// gap). Factored out so both call sites use the exact same fallback rule.
export function billYieldPct(inputs: CarryHistoryInputs, t: number): number | null {
  return inputs.dgs3mo[t] ?? inputs.dtb3?.[t] ?? null;
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
    [0.25, toDecimal(billYieldPct(inputs, t))],
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
    const bill = toDecimal(billYieldPct(inputs, t));
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
