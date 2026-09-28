import { describe, it, expect } from "vitest";
import { stepTierState, computeMarketConditionsHistory, TierStepInput } from "../supabase/functions/_shared/marketConditions/scoring.ts";
import { MC_CONFIG, TIER_ORDER, CAUTIOUS_IDX, DEFENSIVE_IDX } from "../supabase/functions/_shared/marketConditions/config.ts";
import { HysteresisState } from "../supabase/functions/_shared/marketConditions/types.ts";

const neutral = (): HysteresisState => ({
  tierIndex: TIER_ORDER.indexOf("RISK_OFF"),
  upStreak: 0, downStreak: 0, trendState: "MIXED",
  vetoActive: false, vetoTermStructureStreak: 0, vetoClearStreak: 0,
});

function noVeto(composite: number, trendState: "UP" | "MIXED" | "DOWN" = "MIXED"): TierStepInput {
  return { composite, trendState, termStructureTriggered: false, creditWideningTriggered: false };
}

describe("stepTierState — hysteresis", () => {
  it("moves at most one tier per day even when composite justifies a bigger jump, and re-requires the full day-count for each subsequent step (upgradeDays=3)", () => {
    let state = neutral(); // RISK_OFF
    const tiers: number[] = [];
    for (let day = 0; day < 6; day++) {
      const { finalTierIndex, nextState } = stepTierState(noVeto(0.9), state, MC_CONFIG);
      tiers.push(finalTierIndex);
      state = nextState;
    }
    // RISK_OFF -> stays RISK_OFF for 2 days (streak building) -> DEFENSIVE on day 3
    // -> stays DEFENSIVE for 2 more days -> CAUTIOUS on day 6.
    expect(tiers).toEqual([4, 4, 3, 3, 3, 2]);
  });

  it("downgrades faster than it upgrades (downgradeDays=2 vs upgradeDays=3)", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("FULL");
    const tiers: number[] = [];
    for (let day = 0; day < 4; day++) {
      const { finalTierIndex, nextState } = stepTierState(noVeto(-0.9), state, MC_CONFIG);
      tiers.push(finalTierIndex);
      state = nextState;
    }
    // FULL -> 1 day building -> NORMAL on day 2 -> 1 day building -> CAUTIOUS on day 4.
    expect(tiers).toEqual([0, 1, 1, 2]);
  });

  it("does not move on a composite that doesn't clear the margin, even if it's in the next tier's raw range", () => {
    // NORMAL's min is 0.05; upgrading to FULL (min 0.35) requires clearing
    // 0.35 + upgradeMargin(0.05) = 0.40. A composite of 0.36 clears the raw
    // FULL threshold but not the margin -- should never upgrade.
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("NORMAL");
    for (let day = 0; day < 10; day++) {
      const { finalTierIndex, nextState } = stepTierState(noVeto(0.36), state, MC_CONFIG);
      expect(finalTierIndex).toBe(TIER_ORDER.indexOf("NORMAL"));
      state = nextState;
    }
  });

  it("resets the streak on a non-qualifying day instead of accumulating across gaps", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    let r = stepTierState(noVeto(0.9), state, MC_CONFIG); state = r.nextState; // upStreak=1
    r = stepTierState(noVeto(0.9), state, MC_CONFIG); state = r.nextState; // upStreak=2
    r = stepTierState(noVeto(-0.9), state, MC_CONFIG); state = r.nextState; // breaks streak -> upStreak=0
    expect(state.tierIndex).toBe(TIER_ORDER.indexOf("RISK_OFF")); // never reached upgradeDays=3
    expect(state.upStreak).toBe(0);
  });
});

describe("stepTierState — trend cap", () => {
  it("caps the tier at CAUTIOUS or worse for as long as trend is DOWN, regardless of how bullish the composite is", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    for (let day = 0; day < 20; day++) {
      const { finalTierIndex, nextState } = stepTierState(noVeto(0.95, "DOWN"), state, MC_CONFIG);
      expect(finalTierIndex).toBeGreaterThanOrEqual(CAUTIOUS_IDX);
      state = nextState;
    }
  });

  it("releases the cap once trend is no longer DOWN, letting hysteresis resume from where the capped tier sat", () => {
    let state = neutral();
    for (let day = 0; day < 10; day++) {
      state = stepTierState(noVeto(0.95, "DOWN"), state, MC_CONFIG).nextState;
    }
    expect(state.tierIndex).toBe(CAUTIOUS_IDX);
    const { finalTierIndex } = stepTierState(noVeto(0.95, "UP"), state, MC_CONFIG);
    expect(finalTierIndex).toBeLessThanOrEqual(CAUTIOUS_IDX); // free to improve again
  });
});

describe("stepTierState — stress veto", () => {
  it("activates after termStructureDays (2) consecutive triggered days, and caps at DEFENSIVE", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("FULL");
    let r = stepTierState({ composite: 0.9, trendState: "MIXED", termStructureTriggered: true, creditWideningTriggered: false }, state, MC_CONFIG);
    expect(r.nextState.vetoActive).toBe(false); // only 1 day so far
    state = r.nextState;
    r = stepTierState({ composite: 0.9, trendState: "MIXED", termStructureTriggered: true, creditWideningTriggered: false }, state, MC_CONFIG);
    expect(r.nextState.vetoActive).toBe(true); // 2nd consecutive day
    expect(r.finalTierIndex).toBeGreaterThanOrEqual(DEFENSIVE_IDX);
  });

  it("activates immediately (single day) on credit widening, unlike the term-structure condition", () => {
    const state = neutral();
    const r = stepTierState({ composite: 0.9, trendState: "MIXED", termStructureTriggered: false, creditWideningTriggered: true }, state, MC_CONFIG);
    expect(r.nextState.vetoActive).toBe(true);
    expect(r.finalTierIndex).toBeGreaterThanOrEqual(DEFENSIVE_IDX);
  });

  it("clears only after vetoClearDays (5) consecutive days with BOTH conditions false", () => {
    let state = neutral();
    state.vetoActive = true;
    for (let day = 0; day < 4; day++) {
      const r = stepTierState(noVeto(0.9), state, MC_CONFIG);
      expect(r.nextState.vetoActive).toBe(true); // still clearing
      state = r.nextState;
    }
    const r5 = stepTierState(noVeto(0.9), state, MC_CONFIG);
    expect(r5.nextState.vetoActive).toBe(false); // 5th consecutive clean day
  });

  it("resets the clear streak if a condition fires again mid-clearing", () => {
    let state = neutral();
    state.vetoActive = true;
    for (let day = 0; day < 3; day++) state = stepTierState(noVeto(0.9), state, MC_CONFIG).nextState;
    // a fresh trigger on day 4 should reset the clear streak
    state = stepTierState({ composite: 0.9, trendState: "MIXED", termStructureTriggered: true, creditWideningTriggered: false }, state, MC_CONFIG).nextState;
    expect(state.vetoClearStreak).toBe(0);
  });
});

describe("stepTierState — determinism (idempotency at the pure-function level)", () => {
  it("produces identical output for identical input, called twice", () => {
    const state = neutral();
    const input = noVeto(0.42, "UP");
    const r1 = stepTierState(input, state, MC_CONFIG);
    const r2 = stepTierState(input, state, MC_CONFIG);
    expect(r1).toEqual(r2);
  });
});

describe("computeMarketConditionsHistory — integration", () => {
  function makeDates(n: number, start = "2000-01-03"): string[] {
    const dates: string[] = [];
    const d = new Date(`${start}T00:00:00Z`);
    while (dates.length < n) {
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return dates;
  }

  it("emits no rows before any pillar has data, then emits once trend becomes computable", () => {
    const n = 250;
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.3);
    const rows = computeMarketConditionsHistory({
      dates, closes,
      vix: new Array(n).fill(null), vix3m: new Array(n).fill(null), creditSpread: new Array(n).fill(null),
    }, MC_CONFIG);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(n); // trend (T2) only becomes computable partway through
    expect(rows[0].scoreBreadth).toBeNull();
    expect(rows[0].flags.missing_pillars).toEqual(expect.arrayContaining(["breadth", "sentiment", "macro"]));
  });

  it("is deterministic: recomputing over the same inputs produces identical rows (idempotency, spec Section 9.1)", () => {
    const n = 300;
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 3 + i * 0.1);
    const inputs = { dates, closes, vix: new Array(n).fill(null), vix3m: new Array(n).fill(null), creditSpread: new Array(n).fill(null) };
    const rows1 = computeMarketConditionsHistory(inputs, MC_CONFIG);
    const rows2 = computeMarketConditionsHistory(inputs, MC_CONFIG);
    expect(rows1).toEqual(rows2);
  });
});
