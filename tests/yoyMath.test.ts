import { describe, it, expect } from "vitest";
import {
  findYearAgo,
  addMonths,
  monthlyGapFill,
  yoyPair,
  yoyPairWithFallback,
  type Obs,
} from "../supabase/functions/_shared/yoyMath.ts";

describe("addMonths", () => {
  it("adds within the same year", () => {
    expect(addMonths("2026-03-01", 2)).toBe("2026-05-01");
  });
  it("rolls over a year boundary, forward and backward", () => {
    expect(addMonths("2026-11-01", 2)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
  });
});

describe("findYearAgo", () => {
  it("matches by calendar year/month, not array position", () => {
    const obs: Obs[] = [
      { date: "2026-10-01", value: 10 },
      { date: "2025-10-01", value: 9 }, // the real year-ago match
      { date: "2025-09-01", value: 8 },
    ];
    expect(findYearAgo(obs, "2026-10-01")?.value).toBe(9);
  });
  it("returns undefined when the year-ago month is absent", () => {
    const obs: Obs[] = [{ date: "2026-10-01", value: 10 }];
    expect(findYearAgo(obs, "2026-10-01")).toBeUndefined();
  });
});

// v2 Phase 4a (debt-metrics-integrity-v2 spec): the general gap rule
// promoted out of inflationRegime.ts's old hardcoded single-date patch.
describe("monthlyGapFill", () => {
  it("fills a single missing month bracketed by real neighbors via geometric mean", () => {
    const series = new Map([["2025-09-01", 108], ["2025-11-01", 110]]); // 2025-10 missing
    const fill = monthlyGapFill(series, "2025-10-01");
    expect(fill).not.toBeNull();
    expect(fill!.value).toBeCloseTo(Math.sqrt(108 * 110), 10);
    expect(fill!.usedInterpolatedMonth).toBe("2025-10-01");
  });

  it("does NOT fill a two-month gap — neither missing month has a real adjacent neighbor", () => {
    const series = new Map([["2025-08-01", 108], ["2025-11-01", 110]]); // 09 and 10 both missing
    expect(monthlyGapFill(series, "2025-09-01")).toBeNull();
    expect(monthlyGapFill(series, "2025-10-01")).toBeNull();
  });

  it("returns null when the month isn't actually missing", () => {
    const series = new Map([["2025-09-01", 108], ["2025-10-01", 999], ["2025-11-01", 110]]);
    expect(monthlyGapFill(series, "2025-10-01")).toBeNull();
  });

  it("never mutates the caller's series", () => {
    const series = new Map([["2025-09-01", 108], ["2025-11-01", 110]]);
    monthlyGapFill(series, "2025-10-01");
    expect(series.has("2025-10-01")).toBe(false);
    expect(series.size).toBe(2);
  });

  it("does not fill a month missing at the series edge (no neighbor on one side)", () => {
    const series = new Map([["2025-10-01", 999], ["2025-11-01", 110]]); // nothing before 2025-10
    expect(monthlyGapFill(series, "2025-09-01")).toBeNull();
  });
});

describe("yoyPair (gap-aware)", () => {
  it("pairs normally when both year-ago months are present", () => {
    const obs: Obs[] = [
      { date: "2026-11-01", value: 110 },
      { date: "2026-10-01", value: 108 },
      { date: "2025-11-01", value: 100 },
      { date: "2025-10-01", value: 100 },
    ];
    const yoy = yoyPair(obs);
    expect(yoy).not.toBeNull();
    expect(yoy!.current).toBeCloseTo(10, 6);
    expect(yoy!.usedInterpolatedMonth).toBeNull();
  });

  it("fills a single-month gap in the year-ago position and tags usedInterpolatedMonth", () => {
    // obs[0] (2026-11) pairs directly against 2025-11 (present). obs[1]
    // (2026-10) needs 2025-10 as its year-ago, which is the gap this test
    // fills via the geometric mean of 2025-09 and 2025-11 -- so it's
    // yoy.previous, not yoy.current, that exercises the fill.
    const obs: Obs[] = [
      { date: "2026-11-01", value: 110 },
      { date: "2026-10-01", value: 108 },
      { date: "2025-11-01", value: 110 },
      // 2025-10 deliberately missing
      { date: "2025-09-01", value: 108 },
    ];
    const yoy = yoyPair(obs);
    expect(yoy).not.toBeNull();
    const filled = Math.sqrt(108 * 110); // geometric mean of 2025-09 and 2025-11
    expect(yoy!.current).toBeCloseTo(0, 6); // 110 / 110 (2025-11, present) - 1
    expect(yoy!.previous).toBeCloseTo((108 / filled - 1) * 100, 6);
    expect(yoy!.usedInterpolatedMonth).toBe("2025-10-01");
  });

  it("returns null when the year-ago gap is 2+ months (unfillable)", () => {
    const obs: Obs[] = [
      { date: "2026-11-01", value: 110 },
      { date: "2026-10-01", value: 108 },
      { date: "2025-12-01", value: 110 },
      // both 2025-11 and 2025-10 missing
      { date: "2025-08-01", value: 108 },
    ];
    expect(yoyPair(obs)).toBeNull();
  });

  it("quarterly-cadence data never spuriously triggers the fill (neighbors are structurally 3 months apart, never 1)", () => {
    const obs: Obs[] = [
      { date: "2026-10-01", value: 110 }, // Q3 2026
      { date: "2026-07-01", value: 108 }, // Q2 2026
      // 2025-10 (year-ago for Q3) deliberately missing
      { date: "2025-07-01", value: 100 }, // Q2 2025 (year-ago for Q2) -- present
    ];
    // Year-ago for obs[0] (2026-10) is 2025-10, missing; its "neighbors"
    // for a monthly gap-fill would be 2025-09/2025-11, neither of which
    // exist in a quarterly series -- correctly unfillable, not a quarterly
    // false-positive.
    expect(yoyPair(obs)).toBeNull();
  });
});

describe("yoyPairWithFallback (v2 Phase 4c)", () => {
  it("behaves identically to yoyPair when the newest observation pairs directly", () => {
    const obs: Obs[] = [
      { date: "2026-11-01", value: 110 },
      { date: "2026-10-01", value: 108 },
      { date: "2025-11-01", value: 100 },
      { date: "2025-10-01", value: 100 },
    ];
    const result = yoyPairWithFallback(obs);
    expect(result).not.toBeNull();
    expect(result!.staleReason).toBeNull();
    expect(result!.usedObsDate).toBe("2026-11-01");
  });

  it("falls back to the most recent pairable pair when the newest observation can't be paired even with gap-fill", () => {
    const obs: Obs[] = [
      { date: "2026-12-01", value: 112 }, // newest -- year-ago (2025-12) AND its neighbors (2025-11, 2026-01) all missing: unpairable
      { date: "2026-11-01", value: 110 }, // this one DOES pair: year-ago 2025-11 is present
      { date: "2026-10-01", value: 108 },
      { date: "2025-11-01", value: 100 },
      { date: "2025-10-01", value: 100 },
    ];
    const result = yoyPairWithFallback(obs);
    expect(result).not.toBeNull();
    expect(result!.usedObsDate).toBe("2026-11-01");
    expect(result!.staleReason).toContain("2026-12-01");
    expect(result!.staleReason).toContain("2026-11-01");
    // Falling back one position lands on exactly the direct (offset-0) pairing
    // yoyPair would have produced for that shifted window.
    expect(result!.current).toBeCloseTo(yoyPair(obs.slice(1))!.current, 6);
  });

  it("returns null when NO position in the series can be paired", () => {
    const obs: Obs[] = [
      { date: "2026-12-01", value: 112 },
      { date: "2026-11-01", value: 110 },
    ]; // far too short to ever find a year-ago match anywhere
    expect(yoyPairWithFallback(obs)).toBeNull();
  });
});
