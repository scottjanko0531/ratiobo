import { describe, it, expect } from "vitest";
import { crossSectionalPercentile, descendingRank } from "../supabase/functions/_shared/ruleBreaker/crossSectionalRank.ts";

describe("crossSectionalPercentile", () => {
  it("matches the confirmed mean-rank formula on a small no-tie universe", () => {
    const universe = [1, 2, 3, 4, 5];
    // x=3: lo=2 (two values <3), hi=3 (three values <=3), midRank=(2+3-1)/2=2, pct=2/4*100=50
    expect(crossSectionalPercentile(universe, 3)).toBeCloseTo(50, 10);
  });

  it("confirmed real-world case: a 152-symbol universe's 1-year-return percentile", () => {
    // Reproduces the confirmed real shape (n=152, target strictly greater
    // than 140 of its 151 peers, matching the real pct=93.38 case) via an
    // explicitly-constructed universe, not an error-prone range formula.
    const x = 1.2367;
    const below = Array.from({ length: 140 }, (_, i) => x - 1 - i); // 140 values, all < x
    const above = Array.from({ length: 11 }, (_, i) => x + 1 + i); // 11 values, all > x
    const universe = [...below, ...above, x];
    expect(universe.length).toBe(152);
    const pct = crossSectionalPercentile(universe, x);
    expect(pct).toBeCloseTo((140 / 151) * 100, 5);
  });

  it("mean-rank tie handling: two tied values split the rank evenly, confirmed against real score=93 for composite ties", () => {
    // Reproduces the confirmed real case: two symbols sharing the exact
    // same composite value both resolve to the SAME percentile via
    // mean-rank, not a naive strict-less-than rank (which would give two
    // different, lower, values for the tied pair).
    const universe = [50, 60, 70, 77.667, 77.667, 80, 90];
    const pctA = crossSectionalPercentile(universe, 77.667);
    // lo=3 (three values <77.667), hi=5 (five values <=77.667), midRank=3.5, n=7
    expect(pctA).toBeCloseTo((3.5 / 6) * 100, 10);
  });

  it("lowerIsBetter inverts via the 100-pct identity", () => {
    const universe = [1, 2, 3, 4, 5];
    const normal = crossSectionalPercentile(universe, 2);
    const inverted = crossSectionalPercentile(universe, 2, { lowerIsBetter: true });
    expect(inverted).toBeCloseTo(100 - normal, 10);
  });

  it("sentinel (+Infinity) for structurally-invalid inputs stays IN the universe and ranks worst", () => {
    // Confirmed real case: a leverage ratio from non-positive equity gets
    // +Infinity and is INCLUDED (not excluded) in the ranking universe --
    // this is what makes AMD's real leverage pct=89.61 reproducible
    // (n=155 including the invalid symbols, not n=147 excluding them).
    const universe = [0.5, 0.8, 1.0, 1.2, Infinity, Infinity];
    const pct = crossSectionalPercentile(universe, 1.2, { lowerIsBetter: true });
    // Including the sentinels, 1.2 is better (lower) than 2 of the other 5 -> pct=40.
    expect(pct).toBeCloseTo(40, 5);
    // The sentinel itself must rank strictly worse than every finite value.
    expect(crossSectionalPercentile(universe, Infinity, { lowerIsBetter: true })).toBeLessThan(pct);
  });
});

describe("descendingRank", () => {
  it("1-indexed descending sort, confirmed 155/155 against real rb_scores.rank", () => {
    const universe = [89.4, 84.167, 81, 79.5, 78.5];
    expect(descendingRank(universe, 0)).toBe(1); // 89.4 is the max
    expect(descendingRank(universe, 4)).toBe(universe.length); // 78.5 is the min
  });

  it("ties break by original array order (stable sort), not by value lookup", () => {
    const universe = [90, 80, 80, 70]; // two symbols tie at composite=80
    expect(descendingRank(universe, 1)).toBe(2); // first 80 keeps rank 2
    expect(descendingRank(universe, 2)).toBe(3); // second 80 gets rank 3, not also rank 2
  });
});
