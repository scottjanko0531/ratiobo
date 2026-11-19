import { describe, it, expect } from "vitest";
import { annualized3mMonthly } from "../supabase/functions/_shared/annualizedMath.ts";

// Ascending-value series, descending by date (obs[0] = most recent), no gaps.
function monthlySeries(startValue: number, monthlyGrowthPct: number, months: number, endDate = "2026-10-01") {
  const out = [];
  let v = startValue;
  const vals: number[] = [];
  for (let i = 0; i < months; i++) { vals.push(v); v *= 1 + monthlyGrowthPct / 100; }
  const end = new Date(endDate + "T00:00:00Z");
  for (let i = 0; i < months; i++) {
    const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - i);
    out.push({ date: d.toISOString().slice(0, 7) + "-01", value: vals[months - 1 - i] });
  }
  return out; // descending by date
}

describe("annualized3mMonthly", () => {
  it("computes ((x_t/x_t-3)^4 - 1) * 100 exactly for a clean, gapless series", () => {
    // 1% MoM growth compounded 3 months = 1.01^3; annualized = 1.01^12 - 1 in the
    // steady-state case, but this formula only looks 3 months back and powers by 4
    // (4 * 3-month periods per year), which for constant 1% MoM growth works out to
    // the SAME annualized rate as 1.01^12 - 1 (both are just "1% MoM forever,
    // annualized"), so this is a clean independent check of the formula itself.
    const obs = monthlySeries(100, 1, 8); // 8 months of 1% MoM growth, no gaps
    const result = annualized3mMonthly(obs);
    expect(result).not.toBeNull();
    const expected = (Math.pow(1.01, 12) - 1) * 100;
    expect(result!.current).toBeCloseTo(expected, 4);
    expect(result!.usedInterpolatedMonth).toBeNull();
  });

  it("date-matches across the known Oct 2025 gap via the shared one-month gap-fill rule", () => {
    // Sep/Nov 2025 present, Oct 2025 missing (the real BLS gap) -- computing
    // annualized-3m for Jan 2026 needs the Oct 2025 value (3 months back),
    // which must come from yoyMath's monthlyGapFill (geometric mean of Sep/Nov),
    // not from skipping straight to Sep or failing outright.
    const obs = [
      { date: "2026-01-01", value: 103.0 },
      { date: "2025-12-01", value: 102.0 },
      { date: "2025-11-01", value: 101.0 },
      // 2025-10-01 missing -- the real gap
      { date: "2025-09-01", value: 99.0 },
    ];
    const result = annualized3mMonthly(obs);
    expect(result).not.toBeNull();
    const expectedOct = Math.sqrt(99.0 * 101.0); // monthlyGapFill's geometric mean
    const expectedCurrent = (Math.pow(103.0 / expectedOct, 4) - 1) * 100;
    expect(result!.current).toBeCloseTo(expectedCurrent, 6);
    expect(result!.usedInterpolatedMonth).toBe("2025-10-01");
  });

  it("returns null when the gap is 2+ consecutive months (never guesses)", () => {
    const obs = [
      { date: "2026-01-01", value: 103.0 },
      { date: "2025-12-01", value: 102.0 },
      // both 2025-11-01 and 2025-10-01 missing -- a real 2-month gap
      { date: "2025-09-01", value: 99.0 },
    ];
    expect(annualized3mMonthly(obs)).toBeNull();
  });

  it("returns null with fewer than 2 observations", () => {
    expect(annualized3mMonthly([{ date: "2026-01-01", value: 100 }])).toBeNull();
    expect(annualized3mMonthly([])).toBeNull();
  });
});
