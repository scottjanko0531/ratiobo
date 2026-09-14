import { describe, it, expect } from "vitest";
import {
  zScore, orientedZ, renormalizeWeights, compositeScore,
  classify, classifyParadigmA, selectDominant,
} from "../supabase/functions/_shared/paradigmScoring.ts";

describe("zScore", () => {
  it("computes (current - mean) / stddev against the trailing window", () => {
    // window [1,2,3,4,5], mean=3, population stddev=sqrt(2)
    const z = zScore([1, 2, 3, 4, 5], 5);
    expect(z).toBeCloseTo(2 / Math.sqrt(2), 5);
  });
  it("returns 0 for a degenerate window (fewer than 2 points)", () => {
    expect(zScore([5], 10)).toBe(0);
    expect(zScore([], 10)).toBe(0);
  });
  it("returns 0 for a zero-variance window rather than dividing by zero", () => {
    expect(zScore([7, 7, 7, 7], 7)).toBe(0);
  });
});

describe("orientedZ", () => {
  it("leaves a positive z unchanged when sign is +1", () => {
    expect(orientedZ(1.5, 1)).toBe(1.5);
  });
  it("flips sign when sign is -1 (inverse-oriented metric)", () => {
    expect(orientedZ(1.5, -1)).toBe(-1.5);
    expect(orientedZ(-2, -1)).toBe(2);
  });
});

describe("renormalizeWeights", () => {
  it("splits weight equally across available metrics", () => {
    const w = renormalizeWeights(["a", "b", "c"]);
    expect(w).toEqual({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });
    expect(Object.values(w).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
  });
  it("re-normalizes to still sum to 1.0 when a metric is unavailable", () => {
    // 3 metrics defined, only 2 available today
    const w = renormalizeWeights(["a", "c"]);
    expect(w).toEqual({ a: 0.5, c: 0.5 });
    expect(w.b).toBeUndefined();
  });
  it("returns an empty map when nothing is available (never a silent zero)", () => {
    expect(renormalizeWeights([])).toEqual({});
  });
});

describe("compositeScore", () => {
  it("sums oriented_z * weight across metrics", () => {
    const score = compositeScore([1, -1, 2], [0.5, 0.25, 0.25]);
    expect(score).toBeCloseTo(1 * 0.5 + -1 * 0.25 + 2 * 0.25, 10);
  });
  it("treats a missing weight as 0, not a crash", () => {
    expect(compositeScore([1, 2], [0.5])).toBeCloseTo(0.5, 10);
  });
});

describe("classify", () => {
  it("classifies each band per the fixed thresholds (spec 4.5)", () => {
    expect(classify(-2)).toBe("Not Active");
    expect(classify(-0.51)).toBe("Not Active");
    expect(classify(-0.5)).toBe("Emerging"); // lower-bound inclusive
    expect(classify(0)).toBe("Emerging");
    expect(classify(0.49)).toBe("Emerging");
    expect(classify(0.5)).toBe("Active"); // lower-bound inclusive
    expect(classify(1)).toBe("Active");
    expect(classify(1.49)).toBe("Active");
    expect(classify(1.5)).toBe("Dominant"); // lower-bound inclusive
    expect(classify(3)).toBe("Dominant");
  });
});

describe("classifyParadigmA", () => {
  it("is Confirmed once the composite clears the Active threshold", () => {
    expect(classifyParadigmA(0.49)).toBe("Not Confirmed");
    expect(classifyParadigmA(0.5)).toBe("Confirmed");
    expect(classifyParadigmA(2)).toBe("Confirmed");
  });
});

describe("selectDominant", () => {
  it("picks the highest-scoring paradigm among B/C/D when it clears 0.5", () => {
    const result = selectDominant([
      { paradigm: "B", score: -0.2 },
      { paradigm: "C", score: 0.9 },
      { paradigm: "D", score: 0.3 },
    ]);
    expect(result).toBe("C");
  });
  it("returns null when no paradigm clears the Active threshold -- a real output state, not an error", () => {
    const result = selectDominant([
      { paradigm: "B", score: 0.1 },
      { paradigm: "C", score: 0.49 },
      { paradigm: "D", score: -0.3 },
    ]);
    expect(result).toBeNull();
  });
  it("returns null for an empty input", () => {
    expect(selectDominant([])).toBeNull();
  });
});

// Synthetic fixture matching the build spec's own Sept-2026 smoke-test
// description: real 10yr yields running above both their historical and
// baseline medians is evidence AGAINST Paradigm D (Print) being active
// (Print requires falling/negative real yields), while nominal GDP growth
// and corporate profits both running hot is evidence FOR Paradigm C
// (Grow). This isn't a claim about live data -- it's a sanity check that
// the scoring pipeline isn't inverted or badly miscalibrated: feed it
// textbook "C is happening, D is not" oriented z-scores and confirm the
// composite math actually says so.
describe("golden fixture: textbook Grow (C) evidence beats textbook Print (D) evidence", () => {
  it("resolves C as dominant, not D", () => {
    // Paradigm C: GDP YoY rising, corp profits/GDI rising, valuation elevated
    // -- all oriented strongly positive (evidence FOR Grow).
    const cOrientedZs = [2.2, 1.6, 1.2];
    const cWeights = Object.values(renormalizeWeights(["gdp_yoy", "corp_profits_gdi", "valuation_proxy"]));
    const cScore = compositeScore(cOrientedZs, cWeights);

    // Paradigm D: real 10yr yield is ELEVATED (raw z strongly positive), but
    // its orientation is "falling/negative confirms D" (sign = -1) -- real
    // yields running above trailing median is evidence AGAINST Print, so
    // oriented_z comes out negative. M2 YoY and dollar YoY read roughly flat.
    const realYieldOriented = orientedZ(1.6, -1); // elevated raw yield, inverse-oriented -> negative
    const dOrientedZs = [realYieldOriented, 0.1, -0.2];
    const dWeights = Object.values(renormalizeWeights(["real_10y_yield", "m2_yoy", "dollar_yoy"]));
    const dScore = compositeScore(dOrientedZs, dWeights);

    expect(classify(cScore)).toBe("Dominant");
    expect(realYieldOriented).toBeLessThan(0);
    expect(dScore).toBeLessThan(cScore);

    const dominant = selectDominant([
      { paradigm: "B", score: 0.1 },
      { paradigm: "C", score: cScore },
      { paradigm: "D", score: dScore },
    ]);
    expect(dominant).toBe("C");
  });
});
