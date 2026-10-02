import { describe, it, expect } from "vitest";
import {
  syntheticBondTotalReturnIndex, spliceSyntheticBeforeReal, monthEndIndices,
  monthlyReturnsFromDailyIndex, rollingMonthlyCorrelation, monthlyCorrAsOf,
} from "../supabase/functions/_shared/bondLens/syntheticBond.ts";

describe("syntheticBondTotalReturnIndex", () => {
  it("rising yields push the index down (duration effect dominates)", () => {
    const yields = [5, 5, 5.5, 6, 6.5]; // steadily rising 10y yield, percent
    const idx = syntheticBondTotalReturnIndex(yields);
    expect(idx[0]).toBe(100);
    expect(idx[4] as number).toBeLessThan(idx[0] as number);
  });

  it("flat yields drift up from positive carry alone", () => {
    const yields = [5, 5, 5, 5, 5];
    const idx = syntheticBondTotalReturnIndex(yields);
    expect(idx[4] as number).toBeGreaterThan(idx[0] as number);
  });

  it("holds flat across a null gap rather than throwing", () => {
    const yields = [5, null, 5.2];
    const idx = syntheticBondTotalReturnIndex(yields);
    expect(idx[1]).toBe(idx[0]);
    expect(idx[2]).not.toBeNull();
  });
});

describe("spliceSyntheticBeforeReal", () => {
  it("rescales the synthetic leg so the join is continuous", () => {
    const synthetic = [50, 55, 60, 65, 70];
    const real = [null, null, null, 120, 130];
    const out = spliceSyntheticBeforeReal(real, synthetic);
    // join at index 3: synthetic[3]=65 -> real[3]=120, scale = 120/65
    expect(out[3]).toBe(120);
    expect(out[4]).toBe(130);
    expect(out[0] as number).toBeCloseTo(50 * (120 / 65), 6);
    expect(out[2] as number).toBeCloseTo(60 * (120 / 65), 6);
  });

  it("returns real unchanged when real already covers everything", () => {
    const real = [1, 2, 3];
    const synthetic = [9, 9, 9];
    expect(spliceSyntheticBeforeReal(real, synthetic)).toEqual(real);
  });
});

describe("monthEndIndices / monthlyReturnsFromDailyIndex", () => {
  const dates = ["2020-01-30", "2020-01-31", "2020-02-27", "2020-02-28", "2020-03-02"];
  it("finds the last trading day of each month", () => {
    expect(monthEndIndices(dates)).toEqual([1, 3, 4]);
  });

  it("computes month-end-to-month-end returns", () => {
    const index = [100, 110, 115, 121, 130];
    const rets = monthlyReturnsFromDailyIndex(dates, index);
    expect(rets).toHaveLength(2);
    expect(rets[0]).toEqual({ date: "2020-02-28", value: 121 / 110 - 1 });
    expect(rets[1]).toEqual({ date: "2020-03-02", value: 130 / 121 - 1 });
  });
});

describe("rollingMonthlyCorrelation / monthlyCorrAsOf", () => {
  it("is null before the window fills, then reads a real correlation", () => {
    const n = 40;
    const dates = Array.from({ length: n }, (_, i) => `m${i}`);
    const xs = dates.map((date, i) => ({ date, value: i % 2 === 0 ? 0.01 : -0.01 }));
    const ys = dates.map((date, i) => ({ date, value: i % 2 === 0 ? 0.02 : -0.02 })); // perfectly co-moving
    const series = rollingMonthlyCorrelation(xs, ys, 36);
    expect(series[34].corr).toBeNull(); // only 35 points so far
    expect(series[35].corr).toBeCloseTo(1, 6); // 36th point: window complete, perfectly correlated
  });

  it("monthlyCorrAsOf looks up the latest reading on or before a target date", () => {
    const series = [
      { date: "2020-01-31", corr: 0.1 },
      { date: "2020-02-29", corr: 0.2 },
      { date: "2020-03-31", corr: 0.3 },
    ];
    expect(monthlyCorrAsOf(series, "2020-02-15")).toBe(0.1);
    expect(monthlyCorrAsOf(series, "2020-02-29")).toBe(0.2);
    expect(monthlyCorrAsOf(series, "2019-12-31")).toBeNull();
  });
});
