import { describe, it, expect } from "vitest";
import { computeBucketGaps, resolveSimulatorKey } from "../supabase/functions/_shared/portfolioGap.ts";

describe("computeBucketGaps", () => {
  it("computes current/target/delta per bucket from holdings and a target map", () => {
    const holdings = [
      { simulator_key: "eq", current_value: 6000 },
      { simulator_key: "nb", current_value: 4000 },
    ];
    const gaps = computeBucketGaps(holdings, { eq: 20, nb: 20, gld: 10 });
    const byKey = Object.fromEntries(gaps.map((g) => [g.key, g]));

    expect(byKey.eq.currentPct).toBeCloseTo(60, 5);
    expect(byKey.eq.targetPct).toBe(20);
    expect(byKey.eq.deltaPct).toBeCloseTo(40, 5);

    expect(byKey.nb.currentPct).toBeCloseTo(40, 5);
    expect(byKey.nb.targetPct).toBe(20);
    expect(byKey.nb.deltaPct).toBeCloseTo(20, 5);
  });

  it("includes zero-holding buckets that have a nonzero target", () => {
    const holdings = [{ simulator_key: "eq", current_value: 1000 }];
    const gaps = computeBucketGaps(holdings, { eq: 50, gld: 12 });
    const gld = gaps.find((g) => g.key === "gld");
    expect(gld).toBeTruthy();
    expect(gld?.currentPct).toBe(0);
    expect(gld?.targetPct).toBe(12);
    expect(gld?.deltaPct).toBe(-12);
  });

  it("returns an empty array when there is no positive-value holding data", () => {
    expect(computeBucketGaps([], { eq: 20 })).toEqual([]);
    expect(computeBucketGaps([{ simulator_key: "eq", current_value: 0 }], { eq: 20 })).toEqual([]);
  });

  it("falls back to asset_type when simulator_key is unset", () => {
    const key = resolveSimulatorKey({ asset_type: "bond", current_value: 100 });
    expect(key).toBe("nb");
  });
});
