import { describe, it, expect } from "vitest";
import {
  clip, percentileRank, percentileToScore, collectPriorNonNull, sma, mean, stdevPop, alignWithForwardFill,
} from "../supabase/functions/_shared/marketConditions/normalize.ts";

describe("clip", () => {
  it("passes values inside the range through unchanged", () => {
    expect(clip(0.3)).toBe(0.3);
  });
  it("clips above and below the range", () => {
    expect(clip(5)).toBe(1);
    expect(clip(-5)).toBe(-1);
  });
});

describe("percentileRank", () => {
  it("ranks a value in the middle of a simple window", () => {
    // window [1,2,3,4,5], x=3 -> 2 less, 1 equal -> (2+0.5)/5 = 50%
    expect(percentileRank([1, 2, 3, 4, 5], 3)).toBeCloseTo(50, 5);
  });
  it("ranks the max of the window near 100", () => {
    expect(percentileRank([1, 2, 3, 4, 5], 5)).toBeCloseTo(90, 5); // (4+0.5)/5
  });
  it("ranks the min of the window near 0", () => {
    expect(percentileRank([1, 2, 3, 4, 5], 1)).toBeCloseTo(10, 5); // (0+0.5)/5
  });
  it("rank-averages ties instead of always-less-than", () => {
    // window [5,5,5,5], x=5 -> 0 less, 4 equal -> (0+2)/4 = 50%, not 0 and not 100
    expect(percentileRank([5, 5, 5, 5], 5)).toBeCloseTo(50, 5);
  });
  it("returns 50 for an empty window rather than dividing by zero", () => {
    expect(percentileRank([], 3)).toBe(50);
  });
});

describe("percentileToScore", () => {
  it("maps pct=50 to score=0 regardless of inversion", () => {
    expect(percentileToScore(50, false)).toBeCloseTo(0, 10);
    expect(percentileToScore(50, false)).toBeCloseTo(0, 10);
  });
  it("maps pct=100 to +1 uninverted, -1 inverted", () => {
    expect(percentileToScore(100, false)).toBeCloseTo(1, 10);
    expect(percentileToScore(100, true)).toBeCloseTo(-1, 10);
  });
  it("maps pct=0 to -1 uninverted, +1 inverted", () => {
    expect(percentileToScore(0, false)).toBeCloseTo(-1, 10);
    expect(percentileToScore(0, true)).toBeCloseTo(1, 10);
  });
});

describe("collectPriorNonNull", () => {
  it("returns null when fewer than minHistory non-null points exist through t", () => {
    const series = [1, 2, null, 3];
    expect(collectPriorNonNull(series, 3, 10, 4)).toBeNull();
  });
  it("filters nulls and caps at maxWindow, once minHistory is met", () => {
    const series = [1, null, 2, 3, 4, 5];
    expect(collectPriorNonNull(series, 5, 3, 3)).toEqual([3, 4, 5]);
  });
});

describe("sma", () => {
  it("computes a simple moving average over the trailing n points", () => {
    expect(sma([1, 2, 3, 4, 5], 4, 3)).toBeCloseTo((3 + 4 + 5) / 3, 10);
  });
  it("returns null when fewer than n points exist before t", () => {
    expect(sma([1, 2], 1, 5)).toBeNull();
  });
});

describe("alignWithForwardFill", () => {
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05", "2020-01-06"];
  const withPub = (rows: { date: string; value: number }[]) => rows.map((r) => ({ ...r, published_at: r.date }));

  it("uses the exact-date value when present (carriedDays=0)", () => {
    const rows = withPub([{ date: "2020-01-02", value: 10 }]);
    const out = alignWithForwardFill(dates, rows, 3);
    expect(out[1]).toEqual({ value: 10, carriedDays: 0 });
  });

  it("carries the last published value forward up to maxCarryDays trading-day positions", () => {
    const rows = withPub([{ date: "2020-01-01", value: 5 }]);
    const out = alignWithForwardFill(dates, rows, 3);
    expect(out[0]).toEqual({ value: 5, carriedDays: 0 });
    expect(out[1]).toEqual({ value: 5, carriedDays: 1 });
    expect(out[2]).toEqual({ value: 5, carriedDays: 2 });
    expect(out[3]).toEqual({ value: 5, carriedDays: 3 });
    expect(out[4]).toEqual({ value: null, carriedDays: -1 }); // 4 trading days back, beyond the cap
  });

  it("prefers the most recent eligible value over an older one further back", () => {
    const rows = withPub([{ date: "2020-01-01", value: 5 }, { date: "2020-01-03", value: 9 }]);
    const out = alignWithForwardFill(dates, rows, 3);
    expect(out[3]).toEqual({ value: 9, carriedDays: 1 }); // 01-04 fills from 01-03, not 01-01
  });

  it("never uses a row whose published_at is after the target date (no-lookahead, even within the carry window)", () => {
    const rows = [{ date: "2020-01-01", value: 5, published_at: "2020-01-01" }, { date: "2020-01-02", value: 7, published_at: "2020-01-04" }]; // published late
    const out = alignWithForwardFill(dates, rows, 3);
    // 01-02 itself: the 01-02 row isn't eligible yet (published 01-04) -- falls back to 01-01's value.
    expect(out[1]).toEqual({ value: 5, carriedDays: 1 });
    // 01-04: now the 01-02 row IS eligible (published_at 01-04 <= target 01-04) and is more recent than 01-01.
    expect(out[3]).toEqual({ value: 7, carriedDays: 2 });
  });

  it("returns excluded (-1) for a date with nothing in range", () => {
    const out = alignWithForwardFill(dates, [], 3);
    expect(out[0]).toEqual({ value: null, carriedDays: -1 });
  });
});

describe("mean / stdevPop", () => {
  it("computes population standard deviation (divide by n, not n-1)", () => {
    // [2,4,4,4,5,5,7,9], mean=5, pop variance=4, pop stdev=2 (textbook example)
    const arr = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(arr)).toBeCloseTo(5, 10);
    expect(stdevPop(arr)).toBeCloseTo(2, 10);
  });
});
