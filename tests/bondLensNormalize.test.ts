import { describe, it, expect } from "vitest";
import { mean, stdev, rollingZScoreAt, rollingZScoreSeries, alignForwardFill, lagDaysThenAlign, indexDaysAgo } from "../supabase/functions/_shared/bondLens/normalize.ts";

const CFG = { normWindow: 2520, minHistory: 756, clipZ: 3 };

describe("mean/stdev", () => {
  it("sample stdev uses n-1", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });
});

describe("rollingZScoreAt", () => {
  it("excludes when input is null", () => {
    const series = [1, null, 3];
    expect(rollingZScoreAt(series, 1, CFG).excluded).toBe(true);
  });

  it("excludes before minHistory is reached", () => {
    const series = Array.from({ length: 500 }, (_, i) => i);
    expect(rollingZScoreAt(series, 499, CFG).excluded).toBe(true);
  });

  it("scores once minHistory is reached", () => {
    const series = Array.from({ length: 800 }, () => 1 + Math.random() * 0.001);
    series[799] = 1000; // extreme outlier
    const r = rollingZScoreAt(series, 799, CFG);
    expect(r.excluded).toBe(false);
    expect(r.z).toBe(3); // clipped
  });

  it("clips to +/-clipZ", () => {
    const series = new Array(800).fill(0);
    series[799] = -1000;
    const r = rollingZScoreAt(series, 799, CFG);
    expect(r.z).toBe(-3);
  });

  it("returns 0 when the window has zero variance", () => {
    const series = new Array(800).fill(5);
    const r = rollingZScoreAt(series, 799, CFG);
    expect(r.z).toBe(0);
  });
});

describe("rollingZScoreSeries", () => {
  // O(n) incremental version, added to keep bond-lens-compute under
  // WORKER_RESOURCE_LIMIT once path_score/quadrant_score went continuous
  // -- must match rollingZScoreAt called at every index exactly.
  it("matches rollingZScoreAt called at every index, including nulls and an outlier", () => {
    const series: (number | null)[] = Array.from({ length: 900 }, (_, i) => (i % 17 === 0 ? null : 1 + Math.sin(i) * 0.3));
    series[850] = 1000; // outlier, should clip the same way in both
    const batch = rollingZScoreSeries(series, CFG);
    for (let t = 0; t < series.length; t++) {
      const single = rollingZScoreAt(series, t, CFG);
      expect(batch[t].excluded).toBe(single.excluded);
      if (!single.excluded) expect(batch[t].z as number).toBeCloseTo(single.z as number, 9);
    }
  });

  it("excludes when input is null", () => {
    const series = [1, null, 3];
    expect(rollingZScoreSeries(series, CFG)[1].excluded).toBe(true);
  });
});

describe("alignForwardFill", () => {
  it("carries the last value forward within the cap", () => {
    const dates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"];
    const rows = [{ date: "2024-01-01", value: 10 }, { date: "2024-01-03", value: 20 }];
    expect(alignForwardFill(dates, rows, 1)).toEqual([10, 10, 20, 20]);
  });

  it("returns null past the carry cap", () => {
    const dates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"];
    const rows = [{ date: "2024-01-01", value: 10 }];
    expect(alignForwardFill(dates, rows, 1)).toEqual([10, 10, null, null]);
  });
});

describe("lagDaysThenAlign", () => {
  it("shifts availability forward by lagDays (r-star's one-quarter lag)", () => {
    // A dense daily calendar, since alignForwardFill matches on exact
    // calendar dates present in `dates` -- a real bond_raw_series daily
    // calendar always includes the shifted date; a sparse mock wouldn't.
    const dates: string[] = [];
    for (let d = new Date("2024-01-01T00:00:00Z"); d <= new Date("2024-04-10T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    const rows = [{ date: "2024-01-01", value: 1 }]; // Q1 reading
    // 91-day lag pushes availability to 2024-04-01 -- not yet visible on 2024-02-01, visible from 2024-04-01 on.
    const out = lagDaysThenAlign(dates, rows, 91, 5);
    expect(out[dates.indexOf("2024-02-01")]).toBeNull();
    expect(out[dates.indexOf("2024-04-01")]).toBe(1);
    expect(out[dates.indexOf("2024-04-05")]).toBe(1);
  });
});

describe("indexDaysAgo", () => {
  it("finds the index ~N calendar days back", () => {
    const dates = ["2024-01-01", "2024-01-15", "2024-02-01", "2024-02-26", "2024-03-01"];
    // 56 days before 2024-02-26 is ~2024-01-01; before 2024-03-01 is ~2024-01-05 -> index 0.
    expect(indexDaysAgo(dates, 3, 56)).toBe(0);
    expect(indexDaysAgo(dates, 4, 56)).toBe(0);
  });

  it("returns null when there isn't enough history yet", () => {
    const dates = ["2024-01-01", "2024-01-02"];
    expect(indexDaysAgo(dates, 1, 56)).toBeNull();
  });
});
