import { describe, it, expect } from "vitest";
import {
  inflationAxis, classifyQuadrantLabel, stepQuadrantLabel, quadrantScoreContinuous,
  dailyReturns, hedgeCorrelation, stepHedgeReliable,
} from "../supabase/functions/_shared/bondLens/quadrant.ts";

describe("inflationAxis", () => {
  it("adds the T5YIE change and the infl_trend sign", () => {
    expect(inflationAxis(0.2, 1)).toBeCloseTo(1.2, 5);
    expect(inflationAxis(0.2, -1)).toBeCloseTo(-0.8, 5);
  });
  it("excludes (null) when either input is missing", () => {
    expect(inflationAxis(null, 1)).toBeNull();
  });
});

describe("classifyQuadrantLabel", () => {
  it("Q1: growth up, inflation down", () => {
    expect(classifyQuadrantLabel(1, -1)).toBe("Q1");
  });
  it("Q2: growth up, inflation up", () => {
    expect(classifyQuadrantLabel(1, 1)).toBe("Q2");
  });
  it("Q3: growth down, inflation up", () => {
    expect(classifyQuadrantLabel(-1, 1)).toBe("Q3");
  });
  it("Q4: growth down, inflation down", () => {
    expect(classifyQuadrantLabel(-1, -1)).toBe("Q4");
  });
  it("null when an axis is unavailable", () => {
    expect(classifyQuadrantLabel(null, 1)).toBeNull();
  });
});

describe("quadrantScoreContinuous", () => {
  // 2026-10-02 follow-up #2: score = clip(-(growth_z + infl_z)/2, -2, 2).
  it("both axes up (hot growth, hot inflation) -> strongly negative", () => {
    const r = quadrantScoreContinuous({ z: 2, excluded: false }, { z: 2, excluded: false });
    expect(r.score).toBeCloseTo(-2, 6);
  });
  it("both axes down (cold growth, cold inflation) -> strongly positive", () => {
    const r = quadrantScoreContinuous({ z: -2, excluded: false }, { z: -2, excluded: false });
    expect(r.score).toBeCloseTo(2, 6);
  });
  it("clips at the +/-2 output bound even if z's are more extreme", () => {
    const r = quadrantScoreContinuous({ z: -3, excluded: false }, { z: -3, excluded: false });
    expect(r.score).toBe(2);
  });
  it("excludes when either axis is excluded", () => {
    const r = quadrantScoreContinuous({ z: null, excluded: true, excludeReason: "x" }, { z: 1, excluded: false });
    expect(r.excluded).toBe(true);
    expect(r.score).toBeNull();
  });
});

describe("stepQuadrantLabel", () => {
  it("requires 3 consecutive agreeing reads before the displayed label changes", () => {
    let state = { confirmed: "Q1" as const, candidate: "Q1" as const, candidateStreak: 0 };
    state = stepQuadrantLabel("Q3", state);
    expect(state.confirmed).toBe("Q1"); // not yet
    state = stepQuadrantLabel("Q3", state);
    expect(state.confirmed).toBe("Q1"); // still not yet (2 reads)
    state = stepQuadrantLabel("Q3", state);
    expect(state.confirmed).toBe("Q3"); // 3rd agreeing read confirms
  });
  it("resets the streak when a read disagrees with the pending candidate", () => {
    let state = { confirmed: "Q1" as const, candidate: "Q1" as const, candidateStreak: 0 };
    state = stepQuadrantLabel("Q3", state);
    state = stepQuadrantLabel("Q2", state); // disagrees with Q3 candidate
    expect(state.candidate).toBe("Q2");
    expect(state.candidateStreak).toBe(1);
    expect(state.confirmed).toBe("Q1");
  });
  it("holds state when there's no new read", () => {
    const prior = { confirmed: "Q4" as const, candidate: "Q4" as const, candidateStreak: 0 };
    expect(stepQuadrantLabel(null, prior)).toBe(prior);
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

  it("2026-10-02 follow-up #1: stays null (degraded), never defaults to true, when no reading has ever existed", () => {
    const prior = { hedgeReliable: null, streak: 0 };
    const next = stepHedgeReliable(null, "Q1", prior, cfg as any);
    expect(next.hedgeReliable).toBeNull();
  });

  it("establishes a real value once a reading arrives, from a null starting state", () => {
    const prior = { hedgeReliable: null, streak: 0 };
    // candidate = reliable (corr well below threshold); null !== true counts as a "change" the first time
    const next = stepHedgeReliable(-0.1, "Q1", prior, cfg as any);
    expect(next.hedgeReliable).toBeNull(); // first agreeing read, streak 1 -- hysteresis still applies from null
    const next2 = stepHedgeReliable(-0.1, "Q1", next, cfg as any);
    expect(next2.hedgeReliable).toBe(true); // 2nd agreeing read confirms
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
