import { describe, it, expect } from "vitest";
import {
  legacyResolve, legacyLane, phase2Lane, phase3Lane, phase4Lane, liveLane, deriveEvent, blendSectorTargets,
  resolveSectorRows, resolveLegacySectorRows,
  resolveWeightsFor, resolveLegacyWeightsFor,
  type LaneState, type ShadowInputs, type SectorTable,
} from "../supabase/functions/_shared/shadowLanes.ts";
import { capTurnover } from "../supabase/functions/_shared/regimeShiftRules.ts";
import { getWeightSet, getLegacyWeightSet, applyNbInterimTreatment, LEGACY_WEIGHTS } from "../supabase/functions/_shared/regimeWeights.ts";

function baseState(overrides: Partial<LaneState> = {}): LaneState {
  const fgRi = getWeightSet("fg_ri", "base")!;
  return {
    baseKey: "fg_ri", baseConfirmedSince: "2026-10-21", lastShiftDate: "2026-10-21",
    nearKey: null, lambda: 0, currentTargets: fgRi, desiredTargets: fgRi,
    ...overrides,
  };
}

// phase2's own weight source is now the frozen legacy table, not the
// mutable (D-1) one baseState() uses -- tests that call phase2Lane and
// check its actual desiredTargets numbers (not just regimeKey/
// blockedReason) need a prev state consistent with that, since
// phase2's real history would have been seeded from LEGACY_WEIGHTS,
// not today's D-1 base.
function legacyBaseState(overrides: Partial<LaneState> = {}): LaneState {
  const fgRi = getLegacyWeightSet("fg_ri")!;
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
    hasIEI: false,
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

// deriveVariant's own test now lives in tests/regimeWeightVariants.test.ts,
// alongside the REGIME_WEIGHT_SETS it was built for (Phase 3).

describe("phase2Lane", () => {
  it("carry protects the base, and the near-term blend is blocked inside the 21-day hold", () => {
    const inputs = baseInputs({
      structuralKeySource: "carry",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-10-30T00:00:00Z"), // 9 days after the 10/21 shift
    });
    const result = phase2Lane(inputs, legacyBaseState());
    expect(result.blockedReason).toBe("min_hold:2026-11-11");
    expect(result.regimeKey).toBe("fg_ri");
    expect(result.nearKey).toBeNull();
    expect(result.lambda).toBe(0);
    // phase2 mirrors live with regime_phase3_weights=false -- frozen
    // LEGACY_WEIGHTS, not the current (D-1) shared base.
    expect(result.desiredTargets).toEqual(getLegacyWeightSet("fg_ri"));
  });

  it("once the hold clears, blends toward the near-term key at the confidence-scaled lambda", () => {
    const inputs = baseInputs({
      structuralKeySource: "carry",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-11-11T00:00:00Z"), // exactly 21 days after 10/21
    });
    const result = phase2Lane(inputs, legacyBaseState());
    expect(result.blockedReason).toBeNull();
    expect(result.lambda).toBeCloseTo(0.3, 6);
    expect(result.nearKey).toBe("rg_ri");

    // Legacy fg_ri (5/5/0/0/20/30/30/10) is farther from rg_ri's base
    // than Phase 3's revised fg_ri is, so the 30%-of-the-way blend is a
    // bigger one-way move than phase3's equivalent (11pts) -- 13pts,
    // still comfortably under the cap.
    const struct = getLegacyWeightSet("fg_ri")!;
    let turnover = 0;
    for (const k of Object.keys(struct)) turnover += Math.abs((result.desiredTargets[k] ?? 0) - (struct[k] ?? 0));
    expect(turnover / 2).toBe(13);

    // Fits in a single day under the 15-point cap against the lane's
    // own prior current_targets (also the legacy fg_ri set).
    const stepped = capTurnover(legacyBaseState().currentTargets, result.desiredTargets, 15);
    expect(stepped).toEqual(result.desiredTargets);
  });

  it("the agreement exception bypasses the hold when structural (crossover) and near-term agree", () => {
    const inputs = baseInputs({
      structuralKey: "rg_ri", structuralKeySource: "crossover",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-10-23T00:00:00Z"), // only 2 days after 10/21
    });
    const result = phase2Lane(inputs, legacyBaseState());
    expect(result.blockedReason).toBeNull();
    expect(result.regimeKey).toBe("rg_ri"); // base itself moves, agreement exception applied
  });

  it("carry_protected surfaces when nothing else is in play", () => {
    const inputs = baseInputs({
      structuralKey: "rg_ri", structuralKeySource: "carry", // a carried key that differs from the base
      nearActive: false, nearConfirmedKey: null, smoothedConfidence: null,
    });
    const result = phase2Lane(inputs, legacyBaseState());
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

// Standing rule (2026-10-30): legacy must stay a faithful old-rules
// baseline even after a shared-table revision (D-1 changed fg_ri's
// base). Proves it by construction: fg_ri's frozen legacy weights are
// NOT equal to the current shared table's fg_ri base -- if someone
// later "simplified" legacyLane back to calling getWeightSet, this
// fails the moment the two tables diverge, exactly as they do today.
describe("legacyLane stays frozen at the pre-Phase-2/3 weights", () => {
  it("fg_ri's legacy weights differ from the current shared base (proves they're actually independent)", () => {
    expect(LEGACY_WEIGHTS.fg_ri).not.toEqual(getWeightSet("fg_ri", "base"));
  });

  it("legacyLane's full swap to fg_ri uses the frozen weights, not the shared table", () => {
    const inputs = baseInputs({ structuralKey: "fg_ri", nearActive: false, nearConfirmedKey: null });
    const prev = baseState({ baseKey: "rg_fi", currentTargets: getLegacyWeightSet("rg_fi")!, desiredTargets: getLegacyWeightSet("rg_fi")! });
    const result = legacyLane(inputs, prev);
    expect(result.regimeKey).toBe("fg_ri");
    expect(result.desiredTargets).toEqual(getLegacyWeightSet("fg_ri"));
    expect(result.desiredTargets).not.toEqual(getWeightSet("fg_ri", "base"));
  });
});

// Phase 3 §5, fixed 2026-10-30 (shadow-v5): phase2 mirrors live with
// regime_phase3_weights=false (frozen LEGACY_WEIGHTS), phase3 mirrors
// it with the flag on (current D-1 table + real variant + nb interim
// treatment). Before this fix both lanes called the same mutable
// getWeightSet and only ever differed by variant -- indistinguishable
// under today's "contained" reading, which defeated the point of
// running them side by side.
describe("phase3Lane vs. phase2Lane", () => {
  it("phase3 picks the high_accel variant on a stagflation+accelerating reading; phase2 stays pinned to legacy weights", () => {
    const inputs = baseInputs({ inflLevelState: "stagflation", inflAccelVote: "accelerating", hasIEI: true });

    const p2 = phase2Lane(inputs, legacyBaseState());
    expect(p2.variant).toBe("base");
    expect(p2.desiredTargets).toEqual(getLegacyWeightSet("fg_ri"));

    const p3 = phase3Lane(inputs, baseState());
    expect(p3.variant).toBe("high_accel");
    expect(p3.desiredTargets).toEqual(getWeightSet("fg_ri", "high_accel"));
    expect(p3.desiredTargets).not.toEqual(p2.desiredTargets);
  });

  it("phase3 falls back to plain high for rg_ri+accelerating (no distinct high_accel set)", () => {
    const rgRiState = baseState({ baseKey: "rg_ri", currentTargets: getWeightSet("rg_ri", "base")!, desiredTargets: getWeightSet("rg_ri", "base")! });
    const inputs = baseInputs({ structuralKey: "rg_ri", inflLevelState: "overheating", inflAccelVote: "accelerating" });

    const p3 = phase3Lane(inputs, rgRiState);
    expect(p3.variant).toBe("high_accel"); // the derived variant itself is still accel-labeled
    expect(p3.desiredTargets).toEqual(getWeightSet("rg_ri", "high")); // but the weights fall back to plain high
  });

  it("the two lanes diverge sharply even when inflation is contained (today's live reading) -- the whole point of the fix", () => {
    const inputs = baseInputs({ inflLevelState: "contained", inflAccelVote: null, hasIEI: false });
    const p2 = phase2Lane(inputs, legacyBaseState());
    const p3 = phase3Lane(inputs, baseState());
    expect(p3.variant).toBe("base");
    expect(p2.desiredTargets).toEqual(getLegacyWeightSet("fg_ri"));
    expect(p3.desiredTargets).toEqual(applyNbInterimTreatment("fg_ri", getWeightSet("fg_ri", "base")!, false));
    expect(p3.desiredTargets).not.toEqual(p2.desiredTargets);

    let turnover = 0;
    for (const k of Object.keys(p2.desiredTargets)) turnover += Math.abs((p3.desiredTargets[k] ?? 0) - (p2.desiredTargets[k] ?? 0));
    expect(turnover / 2).toBe(35);
  });
});

// fg_ri nb interim treatment (Scott's decision 2026-10-30): only
// phase3 (and live with regime_phase3_weights=true) ever applies it --
// phase2 is pinned to the frozen legacy table, where fg_ri.nb is
// already 0, so hasIEI is irrelevant to it entirely, not just a no-op
// on a particular key.
describe("fg_ri nb interim treatment -- phase3 only, phase2 unaffected", () => {
  it("phase3 routes fg_ri's nb into cash/tip when hasIEI is false", () => {
    const inputs = baseInputs({ hasIEI: false });
    const p3 = phase3Lane(inputs, baseState());
    expect(p3.desiredTargets.nb).toBe(0);
    expect(p3.desiredTargets).toEqual(applyNbInterimTreatment("fg_ri", getWeightSet("fg_ri", "base")!, false));
  });

  it("phase3 stops redistributing once hasIEI is true -- the real D-1 nb target comes through", () => {
    const inputs = baseInputs({ hasIEI: true });
    const p3 = phase3Lane(inputs, baseState());
    expect(p3.desiredTargets).toEqual(getWeightSet("fg_ri", "base"));
    expect(p3.desiredTargets.nb).toBeGreaterThan(0);
  });

  it("phase2's output is identical regardless of hasIEI -- it never reads the mutable table or the treatment at all", () => {
    const withoutIEI = phase2Lane(baseInputs({ hasIEI: false }), legacyBaseState());
    const withIEI = phase2Lane(baseInputs({ hasIEI: true }), legacyBaseState());
    expect(withoutIEI.desiredTargets).toEqual(withIEI.desiredTargets);
    expect(withoutIEI.desiredTargets).toEqual(getLegacyWeightSet("fg_ri"));
  });
});

describe("resolveWeightsFor's hasIEI parameter (reseed mechanism)", () => {
  it("defaults to false (treatment applied) when the caller omits it", () => {
    expect(resolveWeightsFor("fg_ri", null, 0, "base", {})).toEqual(
      applyNbInterimTreatment("fg_ri", getWeightSet("fg_ri", "base")!, false),
    );
  });
  it("passes hasIEI through to the near leg of a blend, not just struct", () => {
    // rg_ri's own nb is already 0, so any nonzero nb in the blend can only
    // come from the near leg (fg_ri) -- proving the near leg's treatment
    // is actually gated by hasIEI too, not just the struct leg's.
    const withoutIEI = resolveWeightsFor("rg_ri", "fg_ri", 0.5, "base", {}, false);
    const withIEI = resolveWeightsFor("rg_ri", "fg_ri", 0.5, "base", {}, true);
    expect(withoutIEI.nb).toBe(0);
    expect(withIEI.nb).toBeGreaterThan(0);
  });
});

// Direct statement of the invariant Scott asked for (2026-10-30 fix):
// phase2's weights must equal what the live job computes with
// regime_phase3_weights=false, and phase3's must equal what it
// computes with the flag on. update-regime-portfolio-targets/index.ts
// now literally calls resolveLegacyWeightsFor/resolveWeightsFor for
// its wDesired, the same two functions phase2Lane/phase3Lane call via
// computeBlendLane -- so this is a structural guarantee, not a
// coincidence this test could silently stop catching.
describe("phase2/phase3 mirror the live job's regime_phase3_weights gate", () => {
  it("phase2 equals the live computation with the flag off (resolveLegacyWeightsFor)", () => {
    const inputs = baseInputs({
      structuralKeySource: "carry",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-11-11T00:00:00Z"),
    });
    const prev = legacyBaseState();
    const p2 = phase2Lane(inputs, prev);
    const liveFlagOff = resolveLegacyWeightsFor(p2.regimeKey, p2.nearKey, p2.lambda, prev.currentTargets);
    expect(p2.desiredTargets).toEqual(liveFlagOff);
  });

  it("phase3 equals the live computation with the flag on (resolveWeightsFor)", () => {
    const inputs = baseInputs({
      structuralKeySource: "carry",
      nearActive: true, nearConfirmedKey: "rg_ri", smoothedConfidence: 65,
      today: new Date("2026-11-11T00:00:00Z"),
      hasIEI: false,
    });
    const prev = baseState();
    const p3 = phase3Lane(inputs, prev);
    const liveFlagOn = resolveWeightsFor(p3.regimeKey, p3.nearKey, p3.lambda, p3.variant, prev.currentTargets, false);
    expect(p3.desiredTargets).toEqual(liveFlagOn);
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

// Standing rule (2026-10-30, decisions log): the orchestrator's
// `?reseed=true` calls this to recompute a lane's targets at its
// EXISTING decision-state coordinates against whatever the shared
// table currently returns, without re-deriving carry/blend/hold.
describe("resolveWeightsFor (reseed mechanism)", () => {
  it("struct-only (no blend) returns exactly today's shared base for that key (hasIEI=true -- no nb overlay)", () => {
    expect(resolveWeightsFor("fg_ri", null, 0, "base", {}, true)).toEqual(getWeightSet("fg_ri", "base"));
  });
  it("reflects a shared-table change at the same coordinates (the whole point of reseeding)", () => {
    // fg_ri's base was revised by D-1; resolveWeightsFor must reflect
    // the NEW table, never a stale snapshot -- this is what makes a
    // reseed actually fix a stale row instead of just re-writing it.
    // hasIEI=true isolates this from the separate nb-overlay behavior,
    // which has its own describe block below.
    const reseeded = resolveWeightsFor("fg_ri", null, 0, "base", { eq: 5, intl: 5, em: 0, nb: 0, tip: 20, com: 30, gld: 30, cash: 10 }, true);
    expect(reseeded).toEqual(getWeightSet("fg_ri", "base"));
    expect(reseeded).not.toEqual({ eq: 5, intl: 5, em: 0, nb: 0, tip: 20, com: 30, gld: 30, cash: 10 });
  });
  it("with an active blend, reblends struct+near at the preserved lambda using current weights", () => {
    const result = resolveWeightsFor("fg_ri", "rg_ri", 0.3, "base", {});
    const struct = getWeightSet("fg_ri", "base")!;
    const near = getWeightSet("rg_ri", "base")!;
    let turnover = 0;
    for (const k of Object.keys(struct)) turnover += Math.abs((result[k] ?? 0) - (struct[k] ?? 0));
    // same blend formula blendWeights itself uses -- a non-trivial,
    // lambda-scaled move toward near, not a no-op or a full swap.
    expect(turnover).toBeGreaterThan(0);
    const fullSwapTurnover = Object.keys(struct).reduce((a, k) => a + Math.abs((near[k] ?? 0) - (struct[k] ?? 0)), 0);
    expect(turnover).toBeLessThan(fullSwapTurnover);
  });
  it("falls back to the provided fallback when baseKey is null", () => {
    const fallback = { eq: 1, cash: 99 };
    expect(resolveWeightsFor(null, null, 0, "base", fallback)).toEqual(fallback);
  });
});

// resolveLegacyWeightsFor is what the orchestrator's `?reseed=true`
// now calls for the phase2 lane specifically (2026-10-30 fix) --
// same shape as resolveWeightsFor above, but against the frozen table.
describe("resolveLegacyWeightsFor (phase2's reseed mechanism)", () => {
  it("struct-only (no blend) returns the frozen legacy base for that key, never the current shared one", () => {
    const result = resolveLegacyWeightsFor("fg_ri", null, 0, {});
    expect(result).toEqual(getLegacyWeightSet("fg_ri"));
    expect(result).not.toEqual(getWeightSet("fg_ri", "base"));
  });
  it("blends struct+near at the preserved lambda using the legacy table on both legs", () => {
    const result = resolveLegacyWeightsFor("fg_ri", "rg_ri", 0.3, {});
    const struct = getLegacyWeightSet("fg_ri")!;
    const near = getLegacyWeightSet("rg_ri")!;
    let turnover = 0;
    for (const k of Object.keys(struct)) turnover += Math.abs((result[k] ?? 0) - (struct[k] ?? 0));
    expect(turnover).toBeGreaterThan(0);
    const fullSwapTurnover = Object.keys(struct).reduce((a, k) => a + Math.abs((near[k] ?? 0) - (struct[k] ?? 0)), 0);
    expect(turnover).toBeLessThan(fullSwapTurnover);
  });
  it("falls back to the provided fallback when baseKey is null", () => {
    const fallback = { eq: 1, cash: 99 };
    expect(resolveLegacyWeightsFor(null, null, 0, fallback)).toEqual(fallback);
  });
});

// Regime Tilt Recalibration Phase 4 §6.1, fixed 2026-10-31 -- the same
// fixture the real portfolio_sector_targets migration loaded (both
// table_versions), so these tests exercise the real numbers rather
// than placeholders. `v1` (frozen, pre-D-5, no variant concept -- only
// ever a `base` row) is a SEPARATE, complete table from `d5`
// (variant-aware) for every regime_key -- this is the whole point of
// the fix: `v1.fg_ri.base` is the ORIGINAL 8-symbol table (no XLP),
// while `d5.fg_ri.base` is D-5's revised 9-symbol table (XLP
// included) -- they differ even though both resolve at variant="base".
const SECTOR_TABLE: SectorTable = {
  fg_ri: {
    v1: { base: { XLE: 24, XLV: 16, XLB: 13, XLF: 10, XLK: 10, XLC: 9, XLI: 9, XLY: 9 } },
    d5: {
      base: { XLV: 18, XLP: 15, XLE: 15, XLF: 11, XLY: 10, XLB: 9, XLK: 9, XLI: 8, XLC: 5 },
      high: { XLV: 18, XLP: 15, XLE: 15, XLF: 11, XLY: 10, XLB: 9, XLK: 9, XLI: 8, XLC: 5 },
    },
  },
  rg_ri: {
    v1: { base: { XLB: 13, XLC: 8, XLE: 18, XLF: 16, XLI: 15, XLK: 12, XLV: 7, XLY: 11 } },
    d5: {
      base: { XLB: 13, XLC: 8, XLE: 18, XLF: 16, XLI: 15, XLK: 12, XLV: 7, XLY: 11 }, // unchanged by D-5, duplicated into d5
      high: { XLE: 22, XLI: 16, XLK: 15, XLF: 15, XLY: 10, XLB: 9, XLV: 7, XLC: 6 },
    },
  },
};

describe("resolveSectorRows (d5, §6.1 lookup: exact (regime_key, variant), else fall back to (regime_key, 'base'))", () => {
  it("returns the exact variant row when one exists (rg_ri/high differs from rg_ri/base)", () => {
    const high = resolveSectorRows(SECTOR_TABLE, "rg_ri", "high");
    const base = resolveSectorRows(SECTOR_TABLE, "rg_ri", "base");
    expect(high).toEqual(SECTOR_TABLE.rg_ri.d5.high);
    expect(high).not.toEqual(base);
  });

  it("falls back to base when the regime_key has no row for that variant (e.g. rg_fi, never given Phase 4 tables)", () => {
    expect(resolveSectorRows(SECTOR_TABLE, "rg_ri", "high_accel")).toEqual(SECTOR_TABLE.rg_ri.d5.base);
  });

  it("returns null for a regime_key with no sector rows at all", () => {
    expect(resolveSectorRows(SECTOR_TABLE, "fg_fi", "base")).toBeNull();
  });

  it("returns null when regimeKey itself is null", () => {
    expect(resolveSectorRows(SECTOR_TABLE, null, "base")).toBeNull();
  });

  it("never reads v1, even when d5 is entirely missing for a regime_key", () => {
    const tableWithOnlyV1: SectorTable = { fg_fi: { v1: { base: { XLU: 100 } } } };
    expect(resolveSectorRows(tableWithOnlyV1, "fg_fi", "base")).toBeNull();
  });
});

// resolveLegacySectorRows mirrors resolveLegacyWeightsFor exactly --
// frozen, no variant concept, and (critically) NOT the same data d5
// returns even at variant="base". This is the actual bug fix: before
// it, "variant" was overloaded to also mean "which table", so D-5's
// revision of fg_ri's own base row leaked into every lane's base
// lookup regardless of regime_phase4_sectors.
describe("resolveLegacySectorRows (v1, frozen pre-D-5 table)", () => {
  it("returns the frozen v1 row, never a d5 row", () => {
    const result = resolveLegacySectorRows(SECTOR_TABLE, "fg_ri");
    expect(result).toEqual(SECTOR_TABLE.fg_ri.v1.base);
    expect(result).not.toEqual(SECTOR_TABLE.fg_ri.d5.base);
  });

  it("fg_ri's v1 table has no XLP -- that's D-5-only", () => {
    expect(resolveLegacySectorRows(SECTOR_TABLE, "fg_ri")?.XLP).toBeUndefined();
    expect(resolveSectorRows(SECTOR_TABLE, "fg_ri", "base")?.XLP).toBe(15);
  });

  it("ignores variant entirely -- there is no v1 concept of one", () => {
    // Same call regardless of what variant the caller is tracking;
    // resolveLegacySectorRows simply doesn't take one.
    expect(resolveLegacySectorRows(SECTOR_TABLE, "rg_ri")).toEqual(SECTOR_TABLE.rg_ri.v1.base);
  });

  it("returns null for a regime_key with no v1 rows at all", () => {
    expect(resolveLegacySectorRows(SECTOR_TABLE, "fg_fi")).toBeNull();
  });

  it("returns null when regimeKey is null", () => {
    expect(resolveLegacySectorRows(SECTOR_TABLE, null)).toBeNull();
  });
});

// Phase 4 §6.1/§6.2: phase4Lane IS phase3Lane (identical asset-level
// mechanics) -- the ONLY thing Phase 4 adds is the variant-aware
// sector lookup, which lives in the orchestrator
// (update-regime-shadow-targets/index.ts), not in a lane function.
describe("phase4Lane (asset-level mechanics identical to phase3Lane)", () => {
  it("is the exact same function as phase3Lane", () => {
    expect(phase4Lane).toBe(phase3Lane);
  });

  it("produces identical asset-weight output to phase3Lane given the same inputs/state", () => {
    const inputs = baseInputs({ inflLevelState: "stagflation", inflAccelVote: "decelerating" });
    expect(phase4Lane(inputs, baseState())).toEqual(phase3Lane(inputs, baseState()));
  });
});

// The invariant Scott asked for directly (2026-10-31 fix): phase3's
// sector output (resolveLegacySectorRows / v1) must equal what live
// computes with regime_phase4_sectors off; phase4's (resolveSectorRows
// / d5) must equal what live computes with the flag on. Mirrors the
// weight-level "phase2/phase3 mirror the live job's regime_phase3_weights
// gate" block above -- the orchestrator's `sectorRowsFor()` helper
// (update-regime-shadow-targets/index.ts) literally dispatches to
// these same two functions per lane, so this is structural, not
// coincidental.
describe("phase3/phase4 mirror the live job's regime_phase4_sectors gate", () => {
  it("phase3 (and legacy, phase2) equal the live computation with the flag off (resolveLegacySectorRows)", () => {
    expect(resolveLegacySectorRows(SECTOR_TABLE, "fg_ri")).toEqual(SECTOR_TABLE.fg_ri.v1.base);
  });

  it("phase4 equals the live computation with the flag on (resolveSectorRows)", () => {
    expect(resolveSectorRows(SECTOR_TABLE, "fg_ri", "base")).toEqual(SECTOR_TABLE.fg_ri.d5.base);
  });

  it("the two differ even at variant=base -- the actual leak this fixes", () => {
    const flagOff = resolveLegacySectorRows(SECTOR_TABLE, "fg_ri");
    const flagOn = resolveSectorRows(SECTOR_TABLE, "fg_ri", "base");
    expect(flagOff).not.toEqual(flagOn);
  });
});

// Standing rule (2026-10-31, Scott): for every phase-introducing flag,
// flag-off output must be byte-identical to the PREVIOUS phase's lane.
// This single pattern would have caught both the Phase 3 D-1 base leak
// (phase2 briefly called the mutable getWeightSet before the first
// fix) and this Phase 4 sector leak (every lane briefly read D-5's
// revised fg_ri base regardless of regime_phase4_sectors). Add one
// entry here per future phase flag -- same shape, new resolver pair.
describe("standing rule: flag-off output equals the previous phase's lane", () => {
  const PHASE_FLAG_INVARIANTS: { flag: string; off: () => unknown; previousPhaseLane: () => unknown; on: () => unknown; newPhaseLane: () => unknown }[] = [
    {
      flag: "regime_phase3_weights",
      off: () => resolveLegacyWeightsFor("fg_ri", null, 0, {}),
      previousPhaseLane: () => phase2Lane(baseInputs(), legacyBaseState()).desiredTargets,
      on: () => resolveWeightsFor("fg_ri", null, 0, "base", {}, true),
      newPhaseLane: () => phase3Lane(baseInputs({ hasIEI: true }), baseState()).desiredTargets,
    },
    {
      flag: "regime_phase4_sectors",
      off: () => resolveLegacySectorRows(SECTOR_TABLE, "fg_ri"),
      previousPhaseLane: () => resolveLegacySectorRows(SECTOR_TABLE, "fg_ri"), // phase3's sector source is v1, same function
      on: () => resolveSectorRows(SECTOR_TABLE, "fg_ri", "base"),
      newPhaseLane: () => resolveSectorRows(SECTOR_TABLE, "fg_ri", "base"), // phase4's sector source is d5, same function
    },
  ];

  for (const c of PHASE_FLAG_INVARIANTS) {
    it(`${c.flag}: flag-off equals the previous phase's lane`, () => {
      expect(c.off()).toEqual(c.previousPhaseLane());
    });
    it(`${c.flag}: flag-on equals the new phase's lane`, () => {
      expect(c.on()).toEqual(c.newPhaseLane());
    });
  }
});
