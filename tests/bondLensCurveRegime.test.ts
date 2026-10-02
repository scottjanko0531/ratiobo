import { describe, it, expect } from "vitest";
import { curveRegimeRaw, classifyCurveCandidate, stepCurveRegime, CurveRegimeState } from "../supabase/functions/_shared/bondLens/curveRegime.ts";

// Pinned to the ORIGINAL thresholds/persistence (10bp/5bp/2wk), independent
// of BOND_LENS_CONFIG's own live default (2026-10-02 follow-up #8: that
// default moved to 15bp/8bp/4wk, the curveRegimeStrict promotion -- these
// tests are about classifyCurveCandidate/stepCurveRegime's MECHANICS, not
// about whatever the current live threshold happens to be, so they pin
// their own cfg rather than drifting with it).
const TEST_CFG = {
  curveRegime: {
    lookbackDays: 63, levelThresholdBp: 10, slopeThresholdBp: 5, persistenceWeeks: 2,
    scores: { bull_flattening: 1, bull_steepening: 0.5, neutral: 0, bear_flattening: -0.5, bear_steepening: -1 } as Record<string, number>,
  },
};

describe("curveRegimeRaw", () => {
  it("computes level and slope deltas in bp over the lookback window", () => {
    const n = 70;
    const dgs10 = new Array(n).fill(4.0);
    const dgs5 = new Array(n).fill(3.8);
    const dgs2 = new Array(n).fill(3.5);
    dgs10[n - 1] = 3.85; // -15bp level move
    dgs5[n - 1] = 3.75; // slope (10-5) was 0.2, now 0.10 -> -10bp (flattening)
    const r = curveRegimeRaw(dgs10, dgs5, dgs2, n - 1, 63);
    expect(r.deltaLevelBp).toBeCloseTo(-15, 5);
    expect(r.deltaSlope10s5sBp).toBeCloseTo(-10, 5);
  });
  it("returns nulls without a full lookback window", () => {
    const short = new Array(10).fill(4.0);
    expect(curveRegimeRaw(short, short, short, 9, 63).deltaLevelBp).toBeNull();
  });
});

describe("classifyCurveCandidate", () => {
  it("is neutral when the level leg doesn't clear its band", () => {
    const r = classifyCurveCandidate({ deltaLevelBp: -5, deltaSlope10s5sBp: 10, deltaSlope2s10sBp: null }, TEST_CFG);
    expect(r).toBe("neutral");
  });
  it("is neutral when the slope leg doesn't clear its band", () => {
    const r = classifyCurveCandidate({ deltaLevelBp: -15, deltaSlope10s5sBp: 2, deltaSlope2s10sBp: null }, TEST_CFG);
    expect(r).toBe("neutral");
  });
  it("is bull_flattening when level falls and slope flattens", () => {
    const r = classifyCurveCandidate({ deltaLevelBp: -15, deltaSlope10s5sBp: -10, deltaSlope2s10sBp: null }, TEST_CFG);
    expect(r).toBe("bull_flattening");
  });
  it("is bear_steepening when level rises and slope steepens", () => {
    const r = classifyCurveCandidate({ deltaLevelBp: 15, deltaSlope10s5sBp: 10, deltaSlope2s10sBp: null }, TEST_CFG);
    expect(r).toBe("bear_steepening");
  });
  it("is null when inputs are unavailable", () => {
    expect(classifyCurveCandidate({ deltaLevelBp: null, deltaSlope10s5sBp: 10, deltaSlope2s10sBp: null }, TEST_CFG)).toBeNull();
  });
});

const EMPTY_STATE: CurveRegimeState = { confirmed: null, candidate: null, candidateStreak: 0, regimeSince: null };

describe("stepCurveRegime", () => {
  it("requires 2 consecutive weekly reads before confirming a new regime", () => {
    let state = EMPTY_STATE;
    let r = stepCurveRegime("bull_flattening", "2024-01-05", state, TEST_CFG); // week 1
    expect(r.state.confirmed).toBeNull();
    state = r.state;
    r = stepCurveRegime("bull_flattening", "2024-01-12", state, TEST_CFG); // week 2
    expect(r.state.confirmed).toBe("bull_flattening");
    expect(r.state.regimeSince).toBe("2024-01-12");
    expect(r.score).toBe(1);
  });

  it("resets the candidate streak if the weekly read changes", () => {
    let state = EMPTY_STATE;
    let r = stepCurveRegime("bull_flattening", "2024-01-05", state, TEST_CFG);
    state = r.state;
    r = stepCurveRegime("neutral", "2024-01-12", state, TEST_CFG); // disagrees -> new candidate, streak resets
    expect(r.state.confirmed).toBeNull();
    expect(r.state.candidateStreak).toBe(1);
  });

  it("flags the bear_flattening -> bull_flattening late-cycle transition", () => {
    // Confirm bear_flattening first.
    let state = EMPTY_STATE;
    state = stepCurveRegime("bear_flattening", "2024-01-05", state, TEST_CFG).state;
    let r = stepCurveRegime("bear_flattening", "2024-01-12", state, TEST_CFG);
    expect(r.state.confirmed).toBe("bear_flattening");
    state = r.state;
    // Now transition to bull_flattening.
    state = stepCurveRegime("bull_flattening", "2024-01-19", state, TEST_CFG).state;
    r = stepCurveRegime("bull_flattening", "2024-01-26", state, TEST_CFG);
    expect(r.state.confirmed).toBe("bull_flattening");
    expect(r.lateycleTransition).toBe(true);
  });

  it("does not flag the transition for any other regime change", () => {
    let state = EMPTY_STATE;
    state = stepCurveRegime("neutral", "2024-01-05", state, TEST_CFG).state;
    state = stepCurveRegime("neutral", "2024-01-12", state, TEST_CFG).state;
    state = stepCurveRegime("bull_flattening", "2024-01-19", state, TEST_CFG).state;
    const r = stepCurveRegime("bull_flattening", "2024-01-26", state, TEST_CFG);
    expect(r.state.confirmed).toBe("bull_flattening");
    expect(r.lateycleTransition).toBe(false);
  });
});
