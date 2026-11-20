import { describe, it, expect } from "vitest";
import { quarterEndDate, bridgeQuarterlyByMarketChange } from "../supabase/functions/_shared/z1Bridge.ts";

describe("quarterEndDate", () => {
  it("maps each quarter-start date to that quarter's real last calendar day", () => {
    expect(quarterEndDate("2026-01-01")).toBe("2026-03-31");
    expect(quarterEndDate("2026-04-01")).toBe("2026-06-30");
    expect(quarterEndDate("2026-07-01")).toBe("2026-09-30");
    expect(quarterEndDate("2026-10-01")).toBe("2026-12-31");
  });

  it("handles a leap-year Q1 correctly", () => {
    expect(quarterEndDate("2024-01-01")).toBe("2024-03-31");
  });

  it("rolls over the year for a Q4 start", () => {
    expect(quarterEndDate("2025-10-01")).toBe("2025-12-31");
  });
});

describe("bridgeQuarterlyByMarketChange", () => {
  const marketObs = [
    { date: "2026-06-29", value: 7440.43 },
    { date: "2026-06-30", value: 7499.36 },
    { date: "2026-07-01", value: 7483.23 },
    { date: "2026-11-19", value: 7175.83 },
  ];

  it("scales the Z.1 value by the market's % change since the quarter end", () => {
    const r = bridgeQuarterlyByMarketChange("2026-04-01", 123687233, marketObs, "2026-11-19");
    expect(r).not.toBeNull();
    expect(r!.quarterEndDate).toBe("2026-06-30");
    expect(r!.marketLevelAtQuarterEnd).toBe(7499.36);
    expect(r!.marketLevelAsOf).toBe(7175.83);
    // 123,687,233 * (7175.83 / 7499.36)
    expect(r!.bridgedValue).toBeCloseTo(118351240, -2);
  });

  it("is a no-op (bridge factor exactly 1) when asOfDate IS the quarter's own end date -- the historical-backfill case", () => {
    const r = bridgeQuarterlyByMarketChange("2026-04-01", 123687233, marketObs, "2026-06-30");
    expect(r).not.toBeNull();
    expect(r!.bridgedValue).toBeCloseTo(123687233, 0);
  });

  it("falls back to the latest market obs on or before the quarter end when that exact date is missing", () => {
    const sparse = [{ date: "2026-06-25", value: 7357.49 }, { date: "2026-11-19", value: 7175.83 }];
    const r = bridgeQuarterlyByMarketChange("2026-04-01", 100, sparse, "2026-11-19");
    expect(r).not.toBeNull();
    expect(r!.marketLevelAtQuarterEnd).toBe(7357.49);
  });

  it("returns null when the market series doesn't reach back to the quarter end", () => {
    const tooShort = [{ date: "2026-11-01", value: 7000 }, { date: "2026-11-19", value: 7175.83 }];
    expect(bridgeQuarterlyByMarketChange("2026-04-01", 100, tooShort, "2026-11-19")).toBeNull();
  });

  it("returns null when the market series doesn't reach asOfDate", () => {
    expect(bridgeQuarterlyByMarketChange("2026-04-01", 100, marketObs, "2020-01-01")).toBeNull();
  });

  it("returns null when the quarter-end market level is zero", () => {
    const zeroed = [{ date: "2026-06-30", value: 0 }, { date: "2026-11-19", value: 7175.83 }];
    expect(bridgeQuarterlyByMarketChange("2026-04-01", 100, zeroed, "2026-11-19")).toBeNull();
  });
});
