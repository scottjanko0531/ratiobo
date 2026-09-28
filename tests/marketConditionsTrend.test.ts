import { describe, it, expect } from "vitest";
import { computeTrendRawSeries, scoreTrendAtIndex } from "../supabase/functions/_shared/marketConditions/indicators/trend.ts";
import { MC_CONFIG } from "../supabase/functions/_shared/marketConditions/config.ts";

// Weekday-only date sequence, matching a real trading calendar's month
// boundaries (needed for T4's month-end detection) without needing real
// holiday data for a unit fixture.
function makeDates(n: number, start = "2000-01-03"): string[] {
  const dates: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (dates.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

describe("computeTrendRawSeries / scoreTrendAtIndex — T1/T2/T3", () => {
  it("classifies a strictly increasing series as UP once enough history exists", () => {
    const n = 400;
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.5);
    const raw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const t = n - 1;
    const result = scoreTrendAtIndex(raw, t, closes, MC_CONFIG);
    expect(result.indicators.T2.score).toBe(1); // SMA200 slope positive
    expect(result.trendStateRaw).toBe("UP");
    expect(result.indicators.T3.raw).toBeGreaterThan(0); // 12-1 momentum positive
  });

  it("classifies a strictly decreasing series as DOWN once enough history exists", () => {
    const n = 400;
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, (_, i) => 500 - i * 0.5);
    const raw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const t = n - 1;
    const result = scoreTrendAtIndex(raw, t, closes, MC_CONFIG);
    expect(result.indicators.T2.score).toBe(-1);
    expect(result.trendStateRaw).toBe("DOWN");
    expect(result.indicators.T3.raw).toBeLessThan(0);
  });

  it("classifies a flat series as MIXED (T1 within the band both ways)", () => {
    const n = 400;
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, () => 100);
    const raw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const t = n - 1;
    const result = scoreTrendAtIndex(raw, t, closes, MC_CONFIG);
    expect(result.indicators.T1.raw).toBeCloseTo(0, 10);
    expect(result.trendStateRaw).toBe("MIXED");
  });

  it("excludes T1/T3 (percentile-based) before minHistory is met, without excluding T2 (binary)", () => {
    const n = 250; // enough for SMA200+slope (T2), not enough for minHistory=756 (T1/T3)
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.5);
    const raw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const t = n - 1;
    const result = scoreTrendAtIndex(raw, t, closes, MC_CONFIG);
    expect(result.indicators.T1.excluded).toBe(true);
    expect(result.indicators.T1.excludeReason).toMatch(/insufficient history/);
    expect(result.indicators.T2.excluded).toBe(false);
    expect(result.pillarScore).not.toBeNull(); // T2 alone still produces a pillar score
  });
});

describe("computeTrendRawSeries — T4 10-month rule", () => {
  it("scores +1 when the last month-end close is above the trailing 10-month SMA (rising series)", () => {
    // 11 months, 2 trading days each (Jan 3 + Jan 4, Feb 3 + Feb 4, ...),
    // strictly increasing closes -- verified by hand in the code comment.
    const dates: string[] = [];
    const closes: number[] = [];
    let val = 10;
    for (let m = 1; m <= 11; m++) {
      const mm = String(m).padStart(2, "0");
      dates.push(`2000-${mm}-03`, `2000-${mm}-04`);
      closes.push(val, val); // month-end close = val
      val += 10;
    }
    const raw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const t = dates.length - 1; // last day of month 11, close=110
    // last 10 month-ends (months 2-11): [20,30,...,110], mean=65; 110 > 65 -> +1
    expect(raw.t4raw[t]).toBe(1);
  });

  it("scores -1 for a falling series", () => {
    const dates: string[] = [];
    const closes: number[] = [];
    let val = 110;
    for (let m = 1; m <= 11; m++) {
      const mm = String(m).padStart(2, "0");
      dates.push(`2000-${mm}-03`, `2000-${mm}-04`);
      closes.push(val, val);
      val -= 10;
    }
    const raw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const t = dates.length - 1;
    expect(raw.t4raw[t]).toBe(-1);
  });

  it("is null before 10 month-ends exist", () => {
    const dates: string[] = [];
    const closes: number[] = [];
    for (let m = 1; m <= 5; m++) {
      const mm = String(m).padStart(2, "0");
      dates.push(`2000-${mm}-03`);
      closes.push(100 + m);
    }
    const raw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    expect(raw.t4raw[dates.length - 1]).toBeNull();
  });
});

describe("no-lookahead", () => {
  it("truncating the input series after t doesn't change t's own computed values", () => {
    const n = 400;
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 10) * 5 + i * 0.2);
    const t = 300;

    const fullRaw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const fullResult = scoreTrendAtIndex(fullRaw, t, closes, MC_CONFIG);

    const truncatedCloses = closes.slice(0, t + 1);
    const truncatedDates = dates.slice(0, t + 1);
    const truncRaw = computeTrendRawSeries(truncatedCloses, truncatedDates, MC_CONFIG);
    const truncResult = scoreTrendAtIndex(truncRaw, t, truncatedCloses, MC_CONFIG);

    expect(truncResult.trendStateRaw).toBe(fullResult.trendStateRaw);
    expect(truncResult.pillarScore).toBeCloseTo(fullResult.pillarScore as number, 10);
    expect(truncResult.indicators.T1.raw).toBeCloseTo(fullResult.indicators.T1.raw as number, 10);
  });
});
