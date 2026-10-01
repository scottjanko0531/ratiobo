import { describe, it, expect } from "vitest";
import { inflationAxis, classifyQuadrant, dailyReturns, hedgeCorrelation, stepHedgeReliable } from "../supabase/functions/_shared/bondLens/quadrant.ts";

describe("inflationAxis", () => {
  it("adds the T5YIE change and the infl_trend sign", () => {
    expect(inflationAxis(0.2, 1)).toBeCloseTo(1.2, 5);
    expect(inflationAxis(0.2, -1)).toBeCloseTo(-0.8, 5);
  });
  it("excludes (null) when either input is missing", () => {
    expect(inflationAxis(null, 1)).toBeNull();
  });
});

describe("classifyQuadrant", () => {
  it("Q1: growth up, inflation down -> mildly negative", () => {
    const r = classifyQuadrant(1, -1);
    expect(r.quadrant).toBe("Q1");
    expect(r.score).toBeLessThan(0);
  });
  it("Q2: growth up, inflation up -> negative", () => {
    expect(classifyQuadrant(1, 1).quadrant).toBe("Q2");
  });
  it("Q3: growth down, inflation up -> most negative (nominal hedge weak)", () => {
    const q2 = classifyQuadrant(1, 1);
    const q3 = classifyQuadrant(-1, 1);
    expect(q3.quadrant).toBe("Q3");
    expect(q3.score as number).toBeLessThan(q2.score as number);
  });
  it("Q4: growth down, inflation down -> strongly positive", () => {
    const r = classifyQuadrant(-1, -1);
    expect(r.quadrant).toBe("Q4");
    expect(r.score as number).toBeGreaterThan(0);
  });
  it("excludes when an axis is unavailable", () => {
    expect(classifyQuadrant(null, 1).excluded).toBe(true);
  });
});

describe("dailyReturns", () => {
  it("computes simple returns, null for the first point and any null price", () => {
    const r = dailyReturns([100, 110, null, 100]);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(0.10, 5);
    expect(r[2]).toBeNull();
    expect(r[3]).toBeNull(); // prior price is null
  });
});

describe("hedgeCorrelation", () => {
  it("returns null when there aren't enough paired returns", () => {
    const spy = [0.01, 0.02, null];
    const ief = [-0.01, -0.02, -0.01];
    expect(hedgeCorrelation(spy, ief, 2, 90)).toBeNull();
  });

  it("computes a strong negative correlation when returns move opposite", () => {
    const n = 90;
    const spy = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const ief = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? -0.01 : 0.01));
    expect(hedgeCorrelation(spy, ief, n - 1, 90)).toBeCloseTo(-1, 5);
  });
});

describe("stepHedgeReliable", () => {
  const cfg = { hedge: { corrThreshold: 0.2, hysteresisReads: 2 } } as const;

  it("holds state with no new read", () => {
    const prior = { hedgeReliable: true, streak: 0 };
    expect(stepHedgeReliable(null, "Q1", prior, cfg as any)).toEqual(prior);
  });

  it("requires 2 consecutive agreeing reads before flipping to unreliable", () => {
    let state = { hedgeReliable: true, streak: 0 };
    state = stepHedgeReliable(0.3, "Q1", state, cfg as any); // corr > threshold -> candidate unreliable
    expect(state.hedgeReliable).toBe(true); // not flipped yet
    expect(state.streak).toBe(1);
    state = stepHedgeReliable(0.3, "Q1", state, cfg as any);
    expect(state.hedgeReliable).toBe(false); // flipped after 2nd agreeing read
  });

  it("flags unreliable when quadrant is Q2/Q3 and corr > 0, even below the absolute threshold", () => {
    let state = { hedgeReliable: true, streak: 0 };
    state = stepHedgeReliable(0.05, "Q3", state, cfg as any);
    state = stepHedgeReliable(0.05, "Q3", state, cfg as any);
    expect(state.hedgeReliable).toBe(false);
  });

  it("resets the streak if a read disagrees with the pending candidate", () => {
    let state = { hedgeReliable: true, streak: 0 };
    state = stepHedgeReliable(0.3, "Q1", state, cfg as any); // streak=1 toward unreliable
    state = stepHedgeReliable(-0.1, "Q1", state, cfg as any); // disagrees -> back to reliable, streak reset
    expect(state.hedgeReliable).toBe(true);
    expect(state.streak).toBe(0);
  });
});
