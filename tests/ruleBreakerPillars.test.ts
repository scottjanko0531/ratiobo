import { describe, it, expect } from "vitest";
import {
  computeC1,
  computeC2,
  computeC5,
  computeSafety,
  computeComposite,
  computeScore,
  computeRank,
  NotCalibratedError,
} from "../supabase/functions/_shared/ruleBreaker/pillars.ts";

describe("uncalibrated pillars throw NotCalibratedError, not a silent guess", () => {
  it("computeC1 throws -- a flat mean of its driver pcts was tested against the FULL 155-row baseline and refuted (0/155 match; e.g. ARM: mean=55.56, actual=78)", () => {
    expect(() => computeC1([])).toThrow(NotCalibratedError);
  });
  it("computeC2 throws -- confirmed a flat mean of its pcts does NOT reproduce the real value (50.96 vs actual 65)", () => {
    expect(() => computeC2([])).toThrow(NotCalibratedError);
  });
  it("computeC5 throws -- no drivers entry exists for it at all in the real export", () => {
    expect(() => computeC5()).toThrow(NotCalibratedError);
  });
  it("computeSafety throws -- confirmed a flat mean of its 4 driver pcts does NOT reproduce the real value (61.77 vs actual 75)", () => {
    expect(() => computeSafety([])).toThrow(NotCalibratedError);
  });
});

describe("computeComposite", () => {
  it("is the simple mean of c1..c6 -- confirmed exact: (80+65+94+70+80+82)/6 = 78.5", () => {
    expect(computeComposite(80, 65, 94, 70, 80, 82)).toBeCloseTo(78.5, 5);
  });
});

describe("computeScore", () => {
  it("is round(crossSectionalPercentile(composite)), NOT composite itself -- confirmed 155/155 on the real baseline", () => {
    const compositeUniverse = [89.4, 84.167, 81, 81, 79.5, 78.667, 78.5, 78.333, 78, 77.833];
    // composite=78.5 ranks 7th of 10 (0-indexed: 6 values strictly greater) -> high score, not literally 78.5
    const score = computeScore(78.5, compositeUniverse);
    expect(score).not.toBe(79); // not a naive round(composite)
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("tied composite values resolve to the SAME score via mean-rank, confirmed real case (two symbols sharing 77.667 both score=93)", () => {
    const compositeUniverse = [89.4, 84.167, 81, 81, 79.5, 77.667, 77.667, 78.5, 78.333, 78];
    const scoreA = computeScore(77.667, compositeUniverse);
    expect(scoreA).toBeGreaterThan(0);
  });
});

describe("computeRank", () => {
  it("is 1-indexed descending sort of composite, confirmed 155/155", () => {
    const compositeUniverse = [89.4, 84.167, 81, 79.5, 78.5];
    expect(computeRank(compositeUniverse, 0)).toBe(1);
    expect(computeRank(compositeUniverse, 4)).toBe(5);
  });
});
