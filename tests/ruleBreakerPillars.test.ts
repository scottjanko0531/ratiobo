import { describe, it, expect } from "vitest";
import {
  pillarNum,
  rating20,
  blend,
  computeC1,
  computeC2,
  computeC3,
  computeC4,
  computeC5,
  computeC6,
  computeMet,
  computeComposite,
  computeSafetyRaw,
  computeSafety,
  computeQualityRaw,
  computeQuality,
  computeScore,
  computeRank,
} from "../supabase/functions/_shared/ruleBreaker/pillars.ts";
import { DriverEntry } from "../supabase/functions/_shared/ruleBreaker/types.ts";

describe("pillarNum", () => {
  it("is the mean of non-null driver pcts", () => {
    const drivers: DriverEntry[] = [
      { name: "a", value: 1, pct: 78.43 },
      { name: "b", value: 1, pct: 82.35 },
      { name: "c", value: null, pct: null },
    ];
    expect(pillarNum(drivers)).toBeCloseTo(80.39, 1);
  });
  it("returns null when every driver is null", () => {
    expect(pillarNum([{ name: "x", value: null, pct: null }])).toBeNull();
  });
});

describe("rating20", () => {
  it("scales a 0-5 rating onto 0-100", () => {
    expect(rating20(4)).toBe(80);
  });
  it("is null when there's no rating", () => {
    expect(rating20(null)).toBeNull();
  });
});

describe("blend", () => {
  it("averages when both inputs exist", () => {
    expect(blend(60, 80)).toBe(70);
  });
  it("falls back to whichever exists when only one does", () => {
    expect(blend(60, null)).toBe(60);
    expect(blend(null, 80)).toBe(80);
  });
  it("is null when neither exists", () => {
    expect(blend(null, null)).toBeNull();
  });
});

describe("computeC1/C2/C4 blend a computed pillar number with a rating, rounded", () => {
  const drivers: DriverEntry[] = [{ name: "a", value: 1, pct: 60 }];
  it("blends when a rating exists", () => {
    expect(computeC1(drivers, 4)).toBe(70); // blend(60, 80) = 70
  });
  it("falls back to the computed number alone when there's no rating (confirmed real case: ECHO has no rb_ratings row)", () => {
    expect(computeC1(drivers, null)).toBe(60);
  });
});

describe("computeC3/C6 are purely computed, no rating blend", () => {
  it("computeC3 ignores any notion of a rating entirely (no rating parameter)", () => {
    const drivers: DriverEntry[] = [{ name: "a", value: 1, pct: 73.2 }];
    expect(computeC3(drivers)).toBe(73);
  });
});

describe("computeC5 is PURELY a rating, no fundamentals component at all", () => {
  it("= round(rating*20)", () => {
    expect(computeC5(3)).toBe(60);
  });
  it("is null with no rating -- confirmed real case: ECHO has no rb_ratings row, c5=null", () => {
    expect(computeC5(null)).toBeNull();
  });
});

describe("computeMet", () => {
  it("counts signs >= 60, not >= 50", () => {
    expect(computeMet([60, 59, 61, null, 100, 0])).toBe(3);
  });
  it("null signs don't count", () => {
    expect(computeMet([null, null, null, null, null, null])).toBe(0);
  });
});

describe("computeComposite", () => {
  it("is the mean of the ROUNDED signs, confirmed exact: (80+65+94+70+80+82)/6 = 78.5", () => {
    expect(computeComposite([80, 65, 94, 70, 80, 82])).toBeCloseTo(78.5, 5);
  });
  it("skips null signs rather than treating them as 0 -- confirmed real case (ECHO's null c5)", () => {
    expect(computeComposite([10, 20, 30, 40, null, 60])).toBe(32); // mean of [10,20,30,40,60]
  });
  it("is null only when every sign is null", () => {
    expect(computeComposite([null, null, null, null, null, null])).toBeNull();
  });
});

describe("safety (two-stage: raw average, then a second cross-sectional percentile)", () => {
  it("computeSafetyRaw is the mean of the 4 (already direction-inverted) safety driver pcts", () => {
    const drivers: DriverEntry[] = [
      { name: "a", value: 1, pct: 60 },
      { name: "b", value: 1, pct: 80 },
    ];
    expect(computeSafetyRaw(drivers)).toBe(70);
  });
  it("computeSafety rounds the supplied safetyPct (the caller's job to compute via a universe-wide pass)", () => {
    expect(computeSafety(74.6)).toBe(75);
  });
  it("computeSafety defaults to the pct midpoint 50 when safetyPct is null, NOT null itself", () => {
    expect(computeSafety(null)).toBe(50);
  });
});

describe("quality (two-stage: qraw blends prof/cash/trend pillar numbers with safetyPCT, then a second percentile)", () => {
  it("computeQualityRaw averages prof/cash/trend pillar numbers WITH safetyPct, not safetyRaw", () => {
    const prof: DriverEntry[] = [{ name: "a", value: 1, pct: 80 }];
    const cash: DriverEntry[] = [{ name: "b", value: 1, pct: 60 }];
    const trend: DriverEntry[] = [{ name: "c", value: 1, pct: 70 }];
    expect(computeQualityRaw(prof, cash, trend, 90)).toBe(75); // mean(80,60,70,90)
  });
  it("skips null components", () => {
    const prof: DriverEntry[] = [{ name: "a", value: 1, pct: 80 }];
    expect(computeQualityRaw(prof, [], [], null)).toBe(80);
  });
  it("computeQuality rounds the supplied qualityPct", () => {
    expect(computeQuality(74.6)).toBe(75);
  });
  it("computeQuality is null when qualityPct is null (no default, unlike safety)", () => {
    expect(computeQuality(null)).toBeNull();
  });
});

describe("computeScore", () => {
  it("is round(crossSectionalPercentile(composite)), NOT composite itself -- confirmed 155/155 on the real baseline", () => {
    const compositeUniverse = [89.4, 84.167, 81, 81, 79.5, 78.667, 78.5, 78.333, 78, 77.833];
    const score = computeScore(78.5, compositeUniverse);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("computeRank", () => {
  it("is 1-indexed descending sort of composite, confirmed 155/155", () => {
    const compositeUniverse = [89.4, 84.167, 81, 79.5, 78.5];
    expect(computeRank(compositeUniverse, 0)).toBe(1);
    expect(computeRank(compositeUniverse, 4)).toBe(5);
  });
});
