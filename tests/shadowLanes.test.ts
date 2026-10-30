import { describe, it, expect } from "vitest";
import {
  legacyResolve, phase2Lane, liveLane, deriveVariant, deriveEvent, blendSectorTargets,
  type LaneState, type ShadowInputs,
} from "../supabase/functions/_shared/shadowLanes.ts";
import { capTurnover } from "../supabase/functions/_shared/regimeShiftRules.ts";
import { getWeightSet } from "../supabase/functions/_shared/regimeWeights.ts";

function baseState(overrides: Partial<LaneState> = {}): LaneState {
  const fgRi = getWeightSet("fg_ri", "base")!;
  return {
    baseKey: "fg_ri", baseConfirmedSince: "2026-10-21", lastShiftDate: "2026-10-21",
    nearKey: null, lambda: 0, currentTargets: fgRi, desiredTargets: fgRi,
    ...overrides,
  };
}

function baseInputs(overrides: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    structuralKey: "fg_ri", structuralKeySource: "carry",
    nearActive: false, nearConfirmedKey: null, smoothedConfidence: null,
    inflLevelState: "contained", inflAccelVote: null,
    livePortfolio: { current_regime_key: "fg_ri", target_allocations: getWeightSet("fg_ri", "base")! },
    today: new Date("2026-10-30T00:00:00Z"),
    ...overrides,
  };
}

// Spec §6 / §2: extracted from commit 6a2ccc7 (the correct pre-Phase-2
// version — the spec's own cited e5896c7 is the unrelated GRID fix).
describe("legacyResolve", () => {
  it("9/18 — first activation, structural only: Disinflationary Boom", () => {
    expect(legacyResolve("rg_fi", false, null)).toBe("rg_fi");
  });
  it("10/21 — carry-forward structural, no override: Stagflation", () => {
    expect(legacyResolve("fg_ri", false, null)).toBe("fg_ri");
  });
  it("10/30 — near-term override active and confirmed: Reflation", () => {
    expect(legacyResolve("fg_ri", true, "rg_ri")).toBe("rg_ri");
  });
});

describe("deriveVariant", () => {
  it("contained is always base, regardless of accel vote", () => {
    expect(deriveVariant("contained", "accelerating")).toBe("base");
    expect(deriveVariant("contained", null)).toBe("base");
  });
  it("overheating/stagflation with a mixed vote is plain high", () => {
    expect(deriveVariant("overheating", "mixed")).toBe("high");
    expect(deriveVariant("stagflation", null)).toBe("high");
  });
  it("overheating/stagflation with a clear vote gets the accel/decel suffix", () => {
    expect(deriveVariant("overheating", "accelerating")).toBe("high_accel");
    expect(deriveVariant("stagflation", "decelerating")).toBe("high_decel");
  });
});

describe("phase2Lane", () => {
  it("carry protects the base, and the near-term blend is blocked inside the 21-day hold", () => {
    const inputs = baseInputs({
      structuralKeySource: "carry",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-10-30T00:00:00Z"), // 9 days after the 10/21 shift
    });
    const result = phase2Lane(inputs, baseState());
    expect(result.blockedReason).toBe("min_hold:2026-11-11");
    expect(result.regimeKey).toBe("fg_ri");
    expect(result.nearKey).toBeNull();
    expect(result.lambda).toBe(0);
    expect(result.desiredTargets).toEqual(getWeightSet("fg_ri", "base"));
  });

  it("once the hold clears, blends toward the near-term key at the confidence-scaled lambda", () => {
    const inputs = baseInputs({
      structuralKeySource: "carry",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-11-11T00:00:00Z"), // exactly 21 days after 10/21
    });
    const result = phase2Lane(inputs, baseState());
    expect(result.blockedReason).toBeNull();
    expect(result.lambda).toBeCloseTo(0.3, 6);
    expect(result.nearKey).toBe("rg_ri");

    const struct = getWeightSet("fg_ri", "base")!;
    let turnover = 0;
    for (const k of Object.keys(struct)) turnover += Math.abs((result.desiredTargets[k] ?? 0) - (struct[k] ?? 0));
    expect(turnover / 2).toBeGreaterThanOrEqual(12);
    expect(turnover / 2).toBeLessThanOrEqual(13);

    // Fits in a single day under the 15-point cap against the lane's
    // own prior current_targets (also the fg_ri set).
    const stepped = capTurnover(baseState().currentTargets, result.desiredTargets, 15);
    expect(stepped).toEqual(result.desiredTargets);
  });

  it("the agreement exception bypasses the hold when structural (crossover) and near-term agree", () => {
    const inputs = baseInputs({
      structuralKey: "rg_ri", structuralKeySource: "crossover",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-10-23T00:00:00Z"), // only 2 days after 10/21
    });
    const result = phase2Lane(inputs, baseState());
    expect(result.blockedReason).toBeNull();
    expect(result.regimeKey).toBe("rg_ri"); // base itself moves, agreement exception applied
  });

  it("carry_protected surfaces when nothing else is in play", () => {
    const inputs = baseInputs({
      structuralKey: "rg_ri", structuralKeySource: "carry", // a carried key that differs from the base
      nearActive: false, nearConfirmedKey: null, smoothedConfidence: null,
    });
    const result = phase2Lane(inputs, baseState());
    expect(result.blockedReason).toBe("carry_protected");
    expect(result.regimeKey).toBe("fg_ri"); // base unmoved
  });

  it("independence: changing livePortfolio inputs doesn't change the lane's output", () => {
    const inputs = baseInputs({
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-11-11T00:00:00Z"),
    });
    const a = phase2Lane(inputs, baseState());
    const b = phase2Lane({ ...inputs, livePortfolio: { current_regime_key: "rg_fi", target_allocations: getWeightSet("rg_fi", "base")! } }, baseState());
    expect(a).toEqual(b);
  });
});

describe("liveLane", () => {
  it("just echoes the live portfolio, no simulation", () => {
    const inputs = baseInputs({ livePortfolio: { current_regime_key: "rg_ri", target_allocations: getWeightSet("rg_ri", "base")! } });
    const result = liveLane(inputs, baseState());
    expect(result.regimeKey).toBe("rg_ri");
    expect(result.desiredTargets).toEqual(getWeightSet("rg_ri", "base"));
    expect(result.blockedReason).toBeNull();
  });
});

// Spec §6: a 40-point desired move takes 3 days under the 15-point cap.
describe("capped multi-day convergence + deriveEvent", () => {
  it("logs cap_partial twice and cap_complete once, with no key-level change", () => {
    const desired = { eq: 60, cash: 40 };
    let current = { eq: 20, cash: 80 };
    const events: string[] = [];
    for (let day = 0; day < 5 && !(current.eq === desired.eq && current.cash === desired.cash); day++) {
      let preCappedTurnover = 0;
      for (const k of new Set([...Object.keys(current), ...Object.keys(desired)])) {
        preCappedTurnover += Math.abs((desired[k] ?? 0) - (current[k] ?? 0));
      }
      preCappedTurnover /= 2;
      const stepped = capTurnover(current, desired, 15);
      const reachedDesired = stepped.eq === desired.eq && stepped.cash === desired.cash;
      events.push(deriveEvent({
        lane: "phase2", capped: true,
        prevRegimeKey: "fg_ri", nextRegimeKey: "fg_ri",
        prevNearKey: null, nextNearKey: null,
        prevVariant: "base", nextVariant: "base",
        preCappedTurnover, reachedDesired,
      }));
      current = stepped;
    }
    expect(events).toEqual(["cap_partial", "cap_partial", "cap_complete"]);
  });

  it("a key-level change that completes in a single day is labeled by the key event, not cap_complete", () => {
    const event = deriveEvent({
      lane: "phase2", capped: true,
      prevRegimeKey: "fg_ri", nextRegimeKey: "fg_ri",
      prevNearKey: null, nextNearKey: "rg_ri",
      prevVariant: "base", nextVariant: "base",
      preCappedTurnover: 13, reachedDesired: true,
    });
    expect(event).toBe("blend_start");
  });

  it("legacy's full swap is shift_full, not base_change", () => {
    const event = deriveEvent({
      lane: "legacy", capped: false,
      prevRegimeKey: "fg_ri", nextRegimeKey: "rg_ri",
      prevNearKey: null, nextNearKey: null,
      prevVariant: "base", nextVariant: "base",
      preCappedTurnover: 0, reachedDesired: true,
    });
    expect(event).toBe("shift_full");
  });

  it("blend_end when a near key reverts to null with the base unchanged", () => {
    const event = deriveEvent({
      lane: "phase2", capped: true,
      prevRegimeKey: "fg_ri", nextRegimeKey: "fg_ri",
      prevNearKey: "rg_ri", nextNearKey: null,
      prevVariant: "base", nextVariant: "base",
      preCappedTurnover: 0, reachedDesired: true,
    });
    expect(event).toBe("blend_end");
  });

  it("no_change when nothing moved at all", () => {
    const event = deriveEvent({
      lane: "phase2", capped: true,
      prevRegimeKey: "fg_ri", nextRegimeKey: "fg_ri",
      prevNearKey: null, nextNearKey: null,
      prevVariant: "base", nextVariant: "base",
      preCappedTurnover: 0, reachedDesired: true,
    });
    expect(event).toBe("no_change");
  });
});

describe("every regime weight set sums to 100", () => {
  it.each(["rg_fi", "rg_ri", "fg_ri", "fg_fi"])("%s", (key) => {
    const w = getWeightSet(key, "base")!;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});

describe("blendSectorTargets", () => {
  it("lambda=0 or no near rows returns struct unchanged", () => {
    const struct = { XLE: 20, XLF: 80 };
    expect(blendSectorTargets(struct, null, 0.3)).toEqual(struct);
    expect(blendSectorTargets(struct, { XLE: 50, XLF: 50 }, 0)).toEqual(struct);
  });
  it("blends missing symbols as 0 on either side", () => {
    const struct = { XLE: 20, XLF: 80 };
    const near = { XLE: 0, XLV: 100 };
    const blended = blendSectorTargets(struct, near, 0.5);
    expect(blended.XLE).toBeCloseTo(10, 6); // 20 + 0.5*(0-20)
    expect(blended.XLF).toBeCloseTo(40, 6); // 80 + 0.5*(0-80)
    expect(blended.XLV).toBeCloseTo(50, 6); // 0 + 0.5*(100-0)
  });
});
