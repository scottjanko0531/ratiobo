import { describe, it, expect } from "vitest";
import { stepTierState, computeMarketConditionsHistory, TierStepInput } from "../supabase/functions/_shared/marketConditions/scoring.ts";
import { MC_CONFIG, TIER_ORDER, NORMAL_IDX, CAUTIOUS_IDX, DEFENSIVE_IDX, tierForComposite } from "../supabase/functions/_shared/marketConditions/config.ts";
import { HysteresisState } from "../supabase/functions/_shared/marketConditions/types.ts";

const neutral = (): HysteresisState => ({
  tierIndex: TIER_ORDER.indexOf("RISK_OFF"),
  upStreak: 0, downStreak: 0, trendState: "MIXED", aboveBandStreak: 0, fastPathLatched: false,
  vetoActive: false, vetoTermStructureStreak: 0, vetoClearStreak: 0,
});

function noVeto(composite: number, trendState: "UP" | "MIXED" | "DOWN" = "MIXED", aboveBandStreak = 0): TierStepInput {
  return {
    composite, trendState, aboveBandStreak,
    termStructureTriggered: false, creditWideningTriggered: false,
    fastPathTriggerNow: false, fastPathInvalidated: false,
  };
}

describe("tierForComposite — cfg.tiers override (bug fix, found building the sensitivity harness)", () => {
  it("defaults to MC_CONFIG.tiers, unchanged behavior", () => {
    expect(tierForComposite(0.9)).toBe(0); // FULL
    expect(tierForComposite(-0.9)).toBe(4); // RISK_OFF
  });

  it("actually uses a passed-in tiers array instead of silently ignoring it", () => {
    const shifted = MC_CONFIG.tiers.map((t) => ({ ...t, min: t.min === -Infinity ? t.min : t.min + 0.5 }));
    // With every threshold raised by 0.5, a composite of 0.6 (which clears
    // the ORIGINAL FULL min of 0.35) no longer clears the shifted FULL min
    // of 0.85, but does clear the shifted NORMAL min (0.05+0.5=0.55) -- it
    // should land one tier lower than under the unshifted thresholds.
    expect(tierForComposite(0.6)).toBe(0); // FULL under the real thresholds
    expect(tierForComposite(0.6, shifted)).toBe(1); // NORMAL under the shifted thresholds
  });

  it("stepTierState threads cfg.tiers through to tierForComposite (previously it did not)", () => {
    const variantCfg = { ...MC_CONFIG, tiers: MC_CONFIG.tiers.map((t) => ({ ...t, min: t.min === -Infinity ? t.min : t.min + 0.5 })) };
    const state = neutral();
    const r = stepTierState(noVeto(0.6), state, variantCfg);
    expect(r.rawTierIndex).toBe(1); // would be 0 (FULL) if cfg were still being ignored
  });
});

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

describe("stepTierState — 200-day floor (mc-1.3.0)", () => {
  it("raises tier to NORMAL when aboveBandStreak>=3 and veto is inactive, even from RISK_OFF with a low composite", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    // Low composite -> hysteresis alone would keep it at RISK_OFF/DEFENSIVE.
    const r = stepTierState(noVeto(-0.9, "MIXED", 3), state, MC_CONFIG);
    expect(r.finalTierIndex).toBeLessThanOrEqual(NORMAL_IDX);
    expect(r.floorActiveToday).toBe(true);
  });

  it("does not apply the floor before the streak reaches 3", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    const r = stepTierState(noVeto(-0.9, "MIXED", 2), state, MC_CONFIG);
    expect(r.finalTierIndex).toBe(TIER_ORDER.indexOf("RISK_OFF"));
    expect(r.floorActiveToday).toBe(false);
  });

  it("does not apply the floor when veto is active, even with a qualifying streak", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    state.vetoActive = true;
    const r = stepTierState(
      { composite: -0.9, trendState: "MIXED", aboveBandStreak: 3, termStructureTriggered: false, creditWideningTriggered: false, fastPathTriggerNow: false, fastPathInvalidated: false },
      state, MC_CONFIG,
    );
    expect(r.floorActiveToday).toBe(false);
    expect(r.finalTierIndex).toBeGreaterThanOrEqual(DEFENSIVE_IDX); // veto's own cap still applies
  });

  it("never IMPROVES a tier that's already better than NORMAL (floor, not a ceiling)", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("FULL");
    const r = stepTierState(noVeto(0.9, "MIXED", 3), state, MC_CONFIG);
    expect(r.finalTierIndex).toBe(TIER_ORDER.indexOf("FULL")); // stays FULL, not pulled down to NORMAL
  });
});

describe("stepTierState — recovery fast-path latch (mc-1.3.0)", () => {
  it("activates on trigger and shortens the upgrade window to 1 day", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    const r = stepTierState(
      { composite: 0.9, trendState: "MIXED", aboveBandStreak: 0, termStructureTriggered: false, creditWideningTriggered: false, fastPathTriggerNow: true, fastPathInvalidated: false },
      state, MC_CONFIG,
    );
    expect(r.fastPathActiveToday).toBe(true);
    expect(r.finalTierIndex).toBe(TIER_ORDER.indexOf("DEFENSIVE")); // moved same day, not after 3
  });

  it("suspends the DOWN trend cap while active", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("FULL");
    const r = stepTierState(
      { composite: 0.95, trendState: "DOWN", aboveBandStreak: 0, termStructureTriggered: false, creditWideningTriggered: false, fastPathTriggerNow: true, fastPathInvalidated: false },
      state, MC_CONFIG,
    );
    expect(r.finalTierIndex).toBeLessThan(CAUTIOUS_IDX); // NOT capped, despite trendState DOWN
  });

  it("LATCHES: stays active on a later day even though that day's own trigger conditions no longer hold", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    // Day 1: triggers, composite still low so tier doesn't reach NORMAL yet.
    let r = stepTierState(
      { composite: -0.9, trendState: "MIXED", aboveBandStreak: 0, termStructureTriggered: false, creditWideningTriggered: false, fastPathTriggerNow: true, fastPathInvalidated: false },
      state, MC_CONFIG,
    );
    state = r.nextState;
    expect(state.fastPathLatched).toBe(true);
    // Day 2: trigger conditions no longer hold (fastPathTriggerNow: false), not invalidated either -- latch should still be active.
    r = stepTierState(
      { composite: -0.9, trendState: "MIXED", aboveBandStreak: 0, termStructureTriggered: false, creditWideningTriggered: false, fastPathTriggerNow: false, fastPathInvalidated: false },
      state, MC_CONFIG,
    );
    expect(r.fastPathActiveToday).toBe(true); // still latched from yesterday
  });

  it("exits (for tomorrow) the moment tier actually reaches NORMAL, evaluated same-day not one day late", () => {
    let state = neutral();
    state.tierIndex = CAUTIOUS_IDX; // one upgrade away from NORMAL
    const r = stepTierState(
      { composite: 0.9, trendState: "MIXED", aboveBandStreak: 0, termStructureTriggered: false, creditWideningTriggered: false, fastPathTriggerNow: true, fastPathInvalidated: false },
      state, MC_CONFIG,
    );
    expect(r.finalTierIndex).toBe(NORMAL_IDX); // 1-day upgrade window reached NORMAL today
    expect(r.nextState.fastPathLatched).toBe(false); // success exit, not carried into tomorrow
  });

  it("exits via invalidation even if tier hasn't reached NORMAL yet", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("RISK_OFF");
    state.fastPathLatched = true; // already latched from a prior day
    const r = stepTierState(
      { composite: -0.9, trendState: "MIXED", aboveBandStreak: 0, termStructureTriggered: false, creditWideningTriggered: false, fastPathTriggerNow: false, fastPathInvalidated: true },
      state, MC_CONFIG,
    );
    expect(r.nextState.fastPathLatched).toBe(false);
  });
});

describe("stepTierState — stress veto", () => {
  it("activates after termStructureDays (2) consecutive triggered days, and caps at DEFENSIVE", () => {
    let state = neutral();
    state.tierIndex = TIER_ORDER.indexOf("FULL");
    let r = stepTierState({ ...noVeto(0.9), termStructureTriggered: true }, state, MC_CONFIG);
    expect(r.nextState.vetoActive).toBe(false); // only 1 day so far
    state = r.nextState;
    r = stepTierState({ ...noVeto(0.9), termStructureTriggered: true }, state, MC_CONFIG);
    expect(r.nextState.vetoActive).toBe(true); // 2nd consecutive day
    expect(r.finalTierIndex).toBeGreaterThanOrEqual(DEFENSIVE_IDX);
  });

  it("activates immediately (single day) on credit widening, unlike the term-structure condition", () => {
    const state = neutral();
    const r = stepTierState({ ...noVeto(0.9), creditWideningTriggered: true }, state, MC_CONFIG);
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
    state = stepTierState({ ...noVeto(0.9), termStructureTriggered: true }, state, MC_CONFIG).nextState;
    expect(state.vetoClearStreak).toBe(0);
  });
});

describe("stepTierState — cfg.veto.disabled (mc-1.4.0 ablation hook)", () => {
  it("default (false, MC_CONFIG's own value): completely unaffected, matches the existing suite above", () => {
    const state = neutral();
    const r = stepTierState({ ...noVeto(0.9), creditWideningTriggered: true }, state, MC_CONFIG);
    expect(r.nextState.vetoActive).toBe(true);
    expect(r.finalTierIndex).toBeGreaterThanOrEqual(DEFENSIVE_IDX);
  });

  it("true: vetoActive stays false and the tier cap never applies, even with both trigger conditions firing every day", () => {
    const disabledCfg = { ...MC_CONFIG, veto: { ...MC_CONFIG.veto, disabled: true } };
    let state = neutral();
    for (let day = 0; day < 10; day++) {
      const r = stepTierState({ ...noVeto(0.9), termStructureTriggered: true, creditWideningTriggered: true }, state, disabledCfg);
      expect(r.nextState.vetoActive).toBe(false);
      expect(r.nextState.vetoTermStructureStreak).toBe(0);
      expect(r.nextState.vetoClearStreak).toBe(0);
      state = r.nextState;
    }
  });

  it("true: the floor's own !vetoActive gate still fires normally, since a disabled veto is never active to block it", () => {
    const disabledCfg = { ...MC_CONFIG, veto: { ...MC_CONFIG.veto, disabled: true } };
    const state: HysteresisState = { ...neutral(), tierIndex: TIER_ORDER.indexOf("DEFENSIVE") };
    const r = stepTierState({ ...noVeto(-0.9, "MIXED", 3), creditWideningTriggered: true }, state, disabledCfg);
    expect(r.floorActiveToday).toBe(true);
    expect(r.finalTierIndex).toBeLessThanOrEqual(NORMAL_IDX);
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

  describe("breadthScore (Phase 2 breadth round, mc-1.3.0 config unchanged) — optional input, production-inert when omitted", () => {
    const n = 300;
    const dates = makeDates(n);
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 3 + i * 0.1);
    const baseInputs = { dates, closes, vix: new Array(n).fill(null), vix3m: new Array(n).fill(null), creditSpread: new Array(n).fill(null) };

    it("omitted (market-conditions-compute's own call shape): identical output to a run that never had the field at all", () => {
      const withUndefinedField = computeMarketConditionsHistory({ ...baseInputs, breadthScore: undefined }, MC_CONFIG);
      const withoutFieldAtAll = computeMarketConditionsHistory(baseInputs, MC_CONFIG);
      expect(withUndefinedField).toEqual(withoutFieldAtAll);
      expect(withoutFieldAtAll[0].flags.missing_pillars).toContain("breadth");
    });

    it("populated: breadth stops being a missing pillar and participates in the composite (dropped from scoring per DECISIONS.md, but the wiring itself must work for market-conditions-breadth-backtest)", () => {
      // Flat-ish synthetic closes (no `+ i * 0.1` drift) so trend's own
      // score sits well inside [-1,1] rather than already clipped at the
      // ceiling -- otherwise a maximally-bullish breadth input couldn't
      // move the composite at all and this test would prove nothing.
      const flatCloses = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 3);
      const flatInputs = { ...baseInputs, closes: flatCloses };
      const breadthScore = new Array(n).fill(1); // maximally bullish breadth every day
      const withBreadth = computeMarketConditionsHistory({ ...flatInputs, breadthScore }, MC_CONFIG);
      const withoutBreadth = computeMarketConditionsHistory(flatInputs, MC_CONFIG);
      expect(withBreadth[0].flags.missing_pillars).not.toContain("breadth");
      // A maximally bullish breadth input pulls the composite up relative to
      // the same day without it -- confirms the pillar's weight actually
      // participates in the redistribution, not just a no-op flag flip.
      expect(withBreadth[withBreadth.length - 1].composite).toBeGreaterThan(withoutBreadth[withoutBreadth.length - 1].composite);
    });
  });
});
