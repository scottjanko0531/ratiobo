import { describe, it, expect } from "vitest";
import {
  realYieldGapScore, dfii10MinusRstarGap, termPremiumScore, spliceAcmWithFallback, breakevenGapBp, valuationScore,
} from "../supabase/functions/_shared/bondLens/valuation.ts";

const N = 800;

describe("realYieldGapScore", () => {
  it("excludes before minHistory", () => {
    const dfii10 = new Array(N).fill(1.5);
    const rstar = new Array(N).fill(0.5);
    const gap = dfii10MinusRstarGap(dfii10, rstar);
    expect(realYieldGapScore(dfii10, gap, 500).excluded).toBe(true);
  });

  it("scores once minHistory is reached", () => {
    const dfii10 = Array.from({ length: N }, () => 1.5 + (Math.random() - 0.5) * 0.01);
    dfii10[N - 1] = 5; // outlier -> high real yield, high gap
    const rstar = new Array(N).fill(0.5);
    const gap = dfii10MinusRstarGap(dfii10, rstar);
    const r = realYieldGapScore(dfii10, gap, N - 1);
    expect(r.excluded).toBe(false);
    expect(r.score as number).toBeGreaterThan(0);
  });
});

describe("termPremiumScore", () => {
  it("uses ACM when present (source=acm, no degradation)", () => {
    const acm = Array.from({ length: N }, () => 1.0 + (Math.random() - 0.5) * 0.01);
    const fallback = new Array(N).fill(0.8);
    const spliced = spliceAcmWithFallback(acm, fallback);
    const r = termPremiumScore(acm, spliced, N - 1);
    expect(r.source).toBe("acm");
    expect(r.degraded).toBe(false);
    expect(r.excluded).toBe(false);
  });

  it("splices in the fallback and flags degraded when ACM is null at the tail", () => {
    const acm: (number | null)[] = Array.from({ length: N }, () => 1.0 + (Math.random() - 0.5) * 0.01);
    acm[N - 1] = null; // caller's forward-fill cap already exceeded
    const fallback = new Array(N).fill(1.1);
    const spliced = spliceAcmWithFallback(acm, fallback);
    const r = termPremiumScore(acm, spliced, N - 1);
    expect(r.source).toBe("threefytp10");
    expect(r.degraded).toBe(true);
    expect(r.value).toBe(1.1);
    expect(r.excluded).toBe(false); // the fallback still has history to z-score against
  });
});

describe("breakevenGapBp", () => {
  it("is positive (favors TIPS) when the inflation view exceeds T5YIFR", () => {
    const r = breakevenGapBp(3.0, 2.6, 2.5); // inflation_view = 2.8, gap = 0.3pp = 30bp
    expect(r.excluded).toBe(false);
    expect(r.score).toBeCloseTo(30, 5);
  });

  it("excludes when any input is missing", () => {
    expect(breakevenGapBp(null, 2.6, 2.5).excluded).toBe(true);
  });
});

describe("valuationScore", () => {
  it("equal-weights real yield gap and term premium once both are available", () => {
    const dfii10 = Array.from({ length: N }, () => 1.5 + (Math.random() - 0.5) * 0.01);
    const rstar = new Array(N).fill(0.5);
    const acm = Array.from({ length: N }, () => 1.0 + (Math.random() - 0.5) * 0.01);
    const fallback = new Array(N).fill(0.8);
    const gap = dfii10MinusRstarGap(dfii10, rstar);
    const spliced = spliceAcmWithFallback(acm, fallback);
    const r = valuationScore(dfii10, gap, acm, spliced, 2.5, 2.4, 2.3, N - 1);
    expect(r.excluded).toBe(false);
    expect(r.score).toBeCloseTo(((r.realYieldGap.score as number) + (r.termPremium.score as number)) / 2, 10);
    expect(r.breakevenGapBp.excluded).toBe(false);
  });
});
