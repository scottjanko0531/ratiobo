import { describe, it, expect } from "vitest";
import { modifiedDuration, interpolateYield, carryAndRolldown, computeCarryHistory, CurveKnot } from "../supabase/functions/_shared/bondLens/carry.ts";

describe("modifiedDuration", () => {
  // Spec §4 Phase B acceptance: "A 5% 10y must give D_mod ~= 7.79."
  it("5% 10y gives D_mod ~= 7.79", () => {
    expect(modifiedDuration(0.05, 10)).toBeCloseTo(7.79, 2);
  });
});

describe("interpolateYield", () => {
  const knots: CurveKnot[] = [[0.25, 0.04], [1, 0.045], [2, 0.05], [5, 0.055], [10, 0.06]];
  it("returns an exact knot directly", () => {
    expect(interpolateYield(knots, 2)).toBe(0.05);
  });
  it("interpolates linearly between knots", () => {
    expect(interpolateYield(knots, 7.5)).toBeCloseTo(0.0575, 5); // midpoint of 5(0.055)-10(0.06)
  });
  it("returns null outside the knot range", () => {
    expect(interpolateYield(knots, 30)).toBeNull();
  });
  it("returns null if a bracketing knot is missing", () => {
    const withGap: CurveKnot[] = [[0.25, 0.04], [1, null], [2, 0.05]];
    expect(interpolateYield(withGap, 1.5)).toBeNull();
  });
});

describe("carryAndRolldown", () => {
  // Spec §4 Phase B acceptance, extended to BE: a flat 5% curve means
  // y_n - y_(n-1) = 0, so CR_10 collapses to y_10 = 0.05 regardless of
  // D_mod(9) -- BE_10 = 0.05 / 7.7946 ~= 0.64%.
  it("flat 5% curve: CR_10 = 0.05, BE_10 ~= 0.64%", () => {
    const flat: CurveKnot[] = [[0.25, 0.05], [1, 0.05], [2, 0.05], [3, 0.05], [5, 0.05], [7, 0.05], [10, 0.05], [30, 0.05]];
    const r = carryAndRolldown(flat, 10);
    expect(r.Dmod_n).toBeCloseTo(7.79, 2);
    expect(r.CR).toBeCloseTo(0.05, 6);
    expect(r.BE).toBeCloseTo(0.0064147, 6);
    expect(r.EFF).toBe(r.BE); // spec defines EFF_n with the same formula as BE_n
  });

  it("upward-sloping curve gives positive rolldown (CR > y_n)", () => {
    // Steeper at the short end (n-1) than the curve point itself would
    // suggest isn't needed here -- any y_n > y_(n-1) on an upward-sloping
    // curve makes CR_n > y_n, the standard "rolldown adds to carry" case.
    const steep: CurveKnot[] = [[0.25, 0.03], [1, 0.035], [2, 0.04], [3, 0.042], [5, 0.045], [7, 0.047], [10, 0.05], [30, 0.052]];
    const r = carryAndRolldown(steep, 10);
    expect(r.CR).toBeGreaterThan(0.05);
  });

  it("returns nulls when a required curve point is missing", () => {
    const gap: CurveKnot[] = [[0.25, 0.04], [1, 0.045], [2, 0.05]]; // no 10y point
    const r = carryAndRolldown(gap, 10);
    expect(r.CR).toBeNull();
    expect(r.BE).toBeNull();
  });
});

describe("computeCarryHistory", () => {
  it("excludes carryScore before minHistory, scores once reached", () => {
    const n = 800;
    const flat = (pct: number) => new Array(n).fill(pct);
    const inputs = {
      dates: Array.from({ length: n }, (_, i) => `d${i}`), // content unused by computeCarryHistory, only length matters
      dgs3mo: flat(3), dgs1: flat(3.5), dgs2: flat(4), dgs3: flat(4.2), dgs5: flat(4.5), dgs7: flat(4.7), dgs10: flat(5), dgs30: flat(5.2),
    };
    const history = computeCarryHistory(inputs);
    expect(history[500].carryScore.excluded).toBe(true);
    expect(history[799].carryScore.excluded).toBe(false);
    expect(history[799].byMaturity[10].CR).not.toBeNull();
  });
});
