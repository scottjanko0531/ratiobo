import { describe, it, expect } from "vitest";
import { diffMonthlyMinusQuarterlyCarryForward } from "../supabase/functions/_shared/diffTwoSeries.ts";

describe("diffMonthlyMinusQuarterlyCarryForward", () => {
  it("carries the latest quarter forward to monthly dates within that quarter", () => {
    const unrate = [
      { date: "2026-10-01", value: 4.1 },
      { date: "2026-09-01", value: 4.0 },
      { date: "2026-08-01", value: 4.0 },
    ];
    const nrou = [
      { date: "2026-10-01", value: 4.2 }, // Q4 2026
      { date: "2026-07-01", value: 4.19 }, // Q3 2026
    ];
    const result = diffMonthlyMinusQuarterlyCarryForward(unrate, nrou);
    expect(result).not.toBeNull();
    // Oct (Q4) carries NROU's Q4 value; Sep (Q3) carries NROU's Q3 value.
    expect(result!.current).toBeCloseTo(4.1 - 4.2, 6);
    expect(result!.previous).toBeCloseTo(4.0 - 4.19, 6);
    expect(result!.carriedForwardQuarter).toBe("2026-10-01");
  });

  it("handles NROU's real shape: a FUTURE-dated quarter is a legitimate carry target, not an error", () => {
    // Confirmed live in Phase 0: NROU is CBO's own ~10-year-forward projection,
    // so its "most recent" row can be years ahead of the monthly series' date.
    // The carry-forward rule must still pick the latest quarter AT OR BEFORE the
    // monthly date -- a future-projected quarter for a date that hasn't happened
    // yet must never be used for a PAST or CURRENT month.
    const unrate = [
      { date: "2026-10-01", value: 4.1 },
      { date: "2026-09-01", value: 4.0 },
    ];
    const nrou = [
      { date: "2036-10-01", value: 4.16 }, // a real CBO projection a decade out
      { date: "2026-07-01", value: 4.19 }, // the real "current" quarter
      { date: "2020-01-01", value: 4.5 },
    ];
    const result = diffMonthlyMinusQuarterlyCarryForward(unrate, nrou);
    expect(result).not.toBeNull();
    // Must use 2026-07-01 (<= both monthly dates), never the 2036 projection.
    expect(result!.carriedForwardQuarter).toBe("2026-07-01");
    expect(result!.current).toBeCloseTo(4.1 - 4.19, 6);
  });

  it("returns null if no quarterly observation is at or before the monthly date (never guesses forward)", () => {
    const unrate = [{ date: "2020-01-01", value: 4.1 }, { date: "2019-12-01", value: 4.0 }];
    const nrou = [{ date: "2026-07-01", value: 4.19 }]; // only future-relative-to-unrate data
    expect(diffMonthlyMinusQuarterlyCarryForward(unrate, nrou)).toBeNull();
  });

  it("returns null with fewer than 2 monthly points or no quarterly data at all", () => {
    expect(diffMonthlyMinusQuarterlyCarryForward([{ date: "2026-10-01", value: 4.1 }], [{ date: "2026-07-01", value: 4.19 }])).toBeNull();
    expect(diffMonthlyMinusQuarterlyCarryForward([{ date: "2026-10-01", value: 4.1 }, { date: "2026-09-01", value: 4.0 }], [])).toBeNull();
  });
});
