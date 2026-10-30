import { describe, it, expect } from "vitest";
import {
  computeLambda,
  blendWeights,
  capTurnover,
  resolveBaseKey,
  canApplyKeyShift,
} from "../supabase/functions/_shared/regimeShiftRules.ts";
// getWeightSet/REGIME_WEIGHT_SETS drift + fallback-chain tests now live
// in tests/regimeWeightVariants.test.ts (Phase 3) — variant is no
// longer a no-op, so the "ignores variant" assertion that used to live
// here is obsolete.

describe("computeLambda", () => {
  it("matches the spec's own 65% -> 0.30 example", () => {
    expect(computeLambda(65)).toBeCloseTo(0.3, 6);
  });
  it("floors at 0 for confidence at or below 50", () => {
    expect(computeLambda(50)).toBe(0);
    expect(computeLambda(40)).toBe(0);
  });
  it("clamps at lambdaMax even for very high confidence", () => {
    expect(computeLambda(100, 0.5)).toBe(0.5);
    expect(computeLambda(90, 0.5)).toBe(0.5); // raw would be 0.8, clamped to 0.5
  });
  it("returns 0 for a null confidence", () => {
    expect(computeLambda(null)).toBe(0);
  });
});

describe("blendWeights", () => {
  // Full weight sets (sum to 100), same shape as REGIME_DEFAULT_WEIGHTS —
  // blendWeights' "remainder to cash" fixup only makes sense against a
  // real full set, not an arbitrary partial one.
  const struct = { eq: 20, nb: 20, tip: 15, com: 20, gld: 10, intl: 10, em: 5, cash: 0 };
  const near = { eq: 40, nb: 0, tip: 15, com: 20, gld: 10, intl: 10, em: 5, cash: 0 };

  it("sums to exactly 100 after rounding, remainder absorbed by cash", () => {
    const blended = blendWeights(struct, near, 0.3);
    const sum = Object.values(blended).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
  it("lambda=0 returns struct unchanged", () => {
    expect(blendWeights(struct, near, 0)).toEqual(struct);
  });
  it("lambda=1 returns near unchanged (modulo rounding)", () => {
    expect(blendWeights(struct, near, 1)).toEqual(near);
  });
  it("interpolates linearly at a fractional lambda", () => {
    // eq: 20 + 0.3*(40-20) = 26; nb: 20 + 0.3*(0-20) = 14; everything else unchanged.
    expect(blendWeights(struct, near, 0.3)).toEqual({ eq: 26, nb: 14, tip: 15, com: 20, gld: 10, intl: 10, em: 5, cash: 0 });
  });
});

describe("capTurnover", () => {
  it("passes desired through unchanged when within the cap", () => {
    const cur = { eq: 20, cash: 80 };
    const desired = { eq: 25, cash: 75 }; // 5pt one-way turnover
    expect(capTurnover(cur, desired, 15)).toEqual(desired);
  });

  it("steps exactly maxPoints of one-way turnover when over the cap", () => {
    const cur = { eq: 20, cash: 80 };
    const desired = { eq: 50, cash: 50 }; // 30pt one-way turnover, capped at 15
    const stepped = capTurnover(cur, desired, 15);
    let turnover = 0;
    for (const k of new Set([...Object.keys(cur), ...Object.keys(stepped)])) {
      turnover += Math.abs((stepped[k] ?? 0) - (cur[k] ?? 0));
    }
    expect(turnover / 2).toBe(15);
    // Halfway in direction of desired: eq 20->50 is +30 full move, half of
    // the 30pt gap (15 of 30) is the midpoint, eq should land at 35.
    expect(stepped.eq).toBe(35);
  });

  it("converges to the desired target over repeated daily calls", () => {
    const desired = { eq: 50, cash: 50 };
    let cur = { eq: 20, cash: 80 };
    for (let day = 0; day < 10; day++) {
      cur = capTurnover(cur, desired, 15);
      if (cur.eq === desired.eq && cur.cash === desired.cash) break;
    }
    expect(cur).toEqual(desired);
  });
});

describe("resolveBaseKey", () => {
  it("a carry source never moves the base off its current key", () => {
    expect(resolveBaseKey("rg_ri", "carry", "fg_ri")).toBe("fg_ri");
  });
  it("a carry source with no existing base adopts the carried key", () => {
    expect(resolveBaseKey("rg_ri", "carry", null)).toBe("rg_ri");
  });
  it("a crossover source adopts the fresh key", () => {
    expect(resolveBaseKey("rg_ri", "crossover", "fg_ri")).toBe("rg_ri");
  });
  it("a leaning source adopts the fresh key", () => {
    expect(resolveBaseKey("rg_ri", "leaning", "fg_ri")).toBe("rg_ri");
  });
  it("a null source with no fresh key keeps the current base", () => {
    expect(resolveBaseKey(null, null, "fg_ri")).toBe("fg_ri");
  });
});

describe("canApplyKeyShift", () => {
  it("blocks a shift inside the 21-day hold without the agreement exception", () => {
    const lastShift = "2026-10-21";
    const today = new Date("2026-10-30T00:00:00Z"); // 9 days later
    expect(canApplyKeyShift(lastShift, today, 21, false)).toBe(false);
  });
  it("allows a shift at exactly 21 days", () => {
    const lastShift = "2026-10-01";
    const today = new Date("2026-10-22T00:00:00Z"); // exactly 21 days later
    expect(canApplyKeyShift(lastShift, today, 21, false)).toBe(true);
  });
  it("allows an immediate shift when structural and near-term agree", () => {
    const lastShift = "2026-10-21";
    const today = new Date("2026-10-23T00:00:00Z"); // only 2 days later
    expect(canApplyKeyShift(lastShift, today, 21, true)).toBe(true);
  });
  it("allows the very first shift (no prior shift date)", () => {
    expect(canApplyKeyShift(null, new Date("2026-10-30T00:00:00Z"), 21, false)).toBe(true);
  });
});
