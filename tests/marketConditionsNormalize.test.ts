import { describe, it, expect } from "vitest";
import {
  clip, percentileRank, percentileToScore, collectPriorNonNull, sma, mean, stdevPop,
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

describe("mean / stdevPop", () => {
  it("computes population standard deviation (divide by n, not n-1)", () => {
    // [2,4,4,4,5,5,7,9], mean=5, pop variance=4, pop stdev=2 (textbook example)
    const arr = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(arr)).toBeCloseTo(5, 10);
    expect(stdevPop(arr)).toBeCloseTo(2, 10);
  });
});
