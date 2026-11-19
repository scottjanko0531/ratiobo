import { describe, it, expect } from "vitest";
import { ratioTwoSeries } from "../supabase/functions/_shared/ratioTwoSeries.ts";

describe("ratioTwoSeries", () => {
  it("computes the ratio for the two most recent calendar months present in both series", () => {
    const openings = [
      { date: "2026-09-01", value: 7523 },
      { date: "2026-08-01", value: 7400 },
      { date: "2026-07-01", value: 7300 },
    ];
    const unemployed = [
      { date: "2026-10-01", value: 7068 }, // a month openings doesn't have -- irrelevant
      { date: "2026-09-01", value: 7000 },
      { date: "2026-08-01", value: 6900 },
    ];
    const result = ratioTwoSeries(openings, unemployed);
    expect(result).not.toBeNull();
    expect(result!.current).toBeCloseTo(7523 / 7000, 6);
    expect(result!.previous).toBeCloseTo(7400 / 6900, 6);
  });

  it("skips a month where the denominator is missing, rather than guessing", () => {
    const openings = [
      { date: "2026-09-01", value: 7523 },
      { date: "2026-08-01", value: 7400 }, // denominator has no August
      { date: "2026-07-01", value: 7300 },
    ];
    const unemployed = [
      { date: "2026-09-01", value: 7000 },
      { date: "2026-07-01", value: 6900 },
    ];
    const result = ratioTwoSeries(openings, unemployed);
    expect(result).not.toBeNull();
    expect(result!.current).toBeCloseTo(7523 / 7000, 6);
    expect(result!.previous).toBeCloseTo(7300 / 6900, 6); // August skipped, July is the 2nd real pair
  });

  it("skips a month where the denominator is exactly zero (division-by-zero guard)", () => {
    const openings = [{ date: "2026-09-01", value: 7523 }, { date: "2026-08-01", value: 7400 }];
    const unemployed = [{ date: "2026-09-01", value: 0 }, { date: "2026-08-01", value: 6900 }];
    expect(ratioTwoSeries(openings, unemployed)).toBeNull(); // only 1 real pair -- below the 2-pair minimum
  });

  it("returns null with fewer than 2 matched pairs", () => {
    expect(ratioTwoSeries([{ date: "2026-09-01", value: 1 }], [{ date: "2026-09-01", value: 1 }])).toBeNull();
    expect(ratioTwoSeries([], [])).toBeNull();
  });
});
