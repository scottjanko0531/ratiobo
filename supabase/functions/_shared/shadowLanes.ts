// Regime Shadow Targets Log (docs/specs/regime-shadow-targets.md) —
// one pure function per lane, each a side-by-side simulation of a rule
// set. Every lane calls the SAME shared functions production uses
// (getWeightSet, blendWeights, capTurnover, resolveBaseKey,
// canApplyKeyShift) — never a copy. Turnover capping itself happens in
// the orchestrator (update-regime-shadow-targets), not inside a lane,
// since it's identical across every capped lane.

import { getWeightSet, getLegacyWeightSet, WeightSet } from "./regimeWeights.ts";
import {
  computeLambda, blendWeights, resolveBaseKey, canApplyKeyShift, deriveVariant,
  StructuralKeySource, Variant,
} from "./regimeShiftRules.ts";

// Bumped by hand whenever a lane's underlying logic changes, OR
// whenever a shared weight table a lane reads from changes (even if
// no lane code itself changed) — no deploy-time git-SHA injection
// exists in this repo's Edge Function deploys (confirmed with Scott).
export const RULES_VERSION = "shadow-v3";

export type Lane = "live" | "legacy" | "phase2" | "phase3";
export const LANE_IDS: Lane[] = ["live", "legacy", "phase2", "phase3"];
export const CAPPED_LANES = new Set<Lane>(["phase2", "phase3"]);

export type { Variant };

export interface ShadowInputs {
  structuralKey: string | null;
  structuralKeySource: StructuralKeySource;
  nearActive: boolean;
  nearConfirmedKey: string | null;
  smoothedConfidence: number | null;
  inflLevelState: string | null;
  inflAccelVote: string | null;
  livePortfolio: { current_regime_key: string | null; target_allocations: WeightSet | null };
  today: Date;
}

export interface LaneState {
  baseKey: string | null;
  baseConfirmedSince: string | null;
  lastShiftDate: string | null;
  nearKey: string | null;
  lambda: number;
  currentTargets: WeightSet;
  desiredTargets: WeightSet;
}

export interface LaneResult {
  regimeKey: string | null;
  nearKey: string | null;
  lambda: number;
  variant: Variant;
  desiredTargets: WeightSet;
  blockedReason: string | null;
  nextState: LaneState;
}

export type LaneFn = (inputs: ShadowInputs, prev: LaneState) => LaneResult;

function todayStr(today: Date): string {
  return today.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Extracted verbatim (decision logic only, no Supabase/notification
// side effects) from supabase/functions/update-regime-portfolio-targets/
// index.ts at commit 6a2ccc7 — the last version of that file before
// Phase 2's rewrite in 377e6a3. (The spec cites e5896c7; that commit is
// the GRID regime-reconstruction fix, unrelated to this file — see
// docs/specs/regime-shadow-targets.md's build notes.)
export function legacyResolve(
  structuralKey: string | null,
  nearActive: boolean,
  nearConfirmedKey: string | null,
): string | null {
  return nearActive && nearConfirmedKey ? nearConfirmedKey : structuralKey;
}

export const liveLane: LaneFn = (inputs, prev) => {
  const regimeKey = inputs.livePortfolio.current_regime_key ?? prev.baseKey;
  const desiredTargets = inputs.livePortfolio.target_allocations ?? prev.currentTargets;
  return {
    regimeKey, nearKey: null, lambda: 0, variant: "base",
    desiredTargets, blockedReason: null,
    nextState: {
      baseKey: regimeKey, baseConfirmedSince: prev.baseConfirmedSince, lastShiftDate: prev.lastShiftDate,
      nearKey: null, lambda: 0, currentTargets: desiredTargets, desiredTargets,
    },
  };
};

export const legacyLane: LaneFn = (inputs, prev) => {
  const effectiveKey = legacyResolve(inputs.structuralKey, inputs.nearActive, inputs.nearConfirmedKey);
  const regimeKey = effectiveKey ?? prev.baseKey;
  // Frozen weights, not the shared (mutable) getWeightSet — legacy must
  // stay a faithful old-rules baseline even after a D-1-style base
  // revision changes what the shared table returns.
  const desiredTargets = regimeKey ? (getLegacyWeightSet(regimeKey) ?? prev.currentTargets) : prev.currentTargets;
  const changed = regimeKey !== prev.baseKey;
  return {
    regimeKey, nearKey: null, lambda: 0, variant: "base",
    desiredTargets, blockedReason: effectiveKey ? null : "below_conf_floor",
    nextState: {
      baseKey: regimeKey,
      baseConfirmedSince: changed ? todayStr(inputs.today) : prev.baseConfirmedSince,
      lastShiftDate: changed ? todayStr(inputs.today) : prev.lastShiftDate,
      nearKey: null, lambda: 0, currentTargets: desiredTargets, desiredTargets,
    },
  };
};

// Resolves a lane's desired weights at a given (baseKey, nearKey,
// lambda, variant) using the CURRENT shared getWeightSet — exported so
// the orchestrator's "rules_change" reseed operation can recompute a
// lane's targets at its existing decision-state coordinates after a
// shared weight table changes, without re-deriving carry/blend/hold.
export function resolveWeightsFor(
  baseKey: string | null, nearKey: string | null, lambda: number, variant: Variant, fallback: WeightSet,
): WeightSet {
  const wStruct = baseKey ? (getWeightSet(baseKey, variant) ?? fallback) : fallback;
  const wNear = nearKey ? (getWeightSet(nearKey, variant) ?? null) : null;
  return wNear ? blendWeights(wStruct, wNear, lambda) : wStruct;
}

// Shared by phase2Lane (variant fixed at "base") and phase3Lane
// (variant computed from the real inflation state) — carry rule,
// blended near-term override, turnover cap (applied by the
// orchestrator, not here), and minimum hold are identical between the
// two; only the variant passed to getWeightSet differs.
function computeBlendLane(inputs: ShadowInputs, prev: LaneState, variant: Variant): LaneResult {
  const today = inputs.today;
  const proposedBaseKey = resolveBaseKey(inputs.structuralKey, inputs.structuralKeySource, prev.baseKey);
  const nearActiveKey = inputs.nearActive ? inputs.nearConfirmedKey : null;

  const baseChanging = proposedBaseKey !== null && proposedBaseKey !== prev.baseKey;
  const nearKeyForThisRun = nearActiveKey && nearActiveKey !== proposedBaseKey ? nearActiveKey : null;
  const nearChanging = nearKeyForThisRun !== prev.nearKey;
  const isKeyLevelEvent = baseChanging || nearChanging;

  let finalBaseKey = proposedBaseKey ?? prev.baseKey;
  let finalNearKey = nearKeyForThisRun;
  let blockedReason: string | null = null;

  // Carry is informational on any day it actively holds the base away
  // from a would-be move, independent of whether a separate near-term
  // event is also in play this run.
  if (inputs.structuralKeySource === "carry" && inputs.structuralKey && inputs.structuralKey !== prev.baseKey) {
    blockedReason = "carry_protected";
  }

  if (isKeyLevelEvent) {
    const agreement = inputs.structuralKeySource === "crossover"
      && nearActiveKey != null
      && inputs.structuralKey === nearActiveKey
      && inputs.structuralKey !== prev.baseKey;
    const allowed = canApplyKeyShift(prev.baseConfirmedSince, today, 21, agreement);
    if (!allowed) {
      finalBaseKey = prev.baseKey;
      finalNearKey = prev.nearKey;
      const clearsOn = prev.baseConfirmedSince ? addDays(prev.baseConfirmedSince, 21) : todayStr(today);
      blockedReason = `min_hold:${clearsOn}`;
    }
  }

  const keyEventApplied = isKeyLevelEvent && !(blockedReason?.startsWith("min_hold:"));
  const lambda = finalNearKey ? computeLambda(inputs.smoothedConfidence, 0.5) : 0;
  const desiredTargets = resolveWeightsFor(finalBaseKey, finalNearKey, lambda, variant, prev.currentTargets);

  return {
    regimeKey: finalBaseKey, nearKey: finalNearKey, lambda, variant,
    desiredTargets, blockedReason,
    nextState: {
      baseKey: finalBaseKey,
      baseConfirmedSince: keyEventApplied ? todayStr(today) : prev.baseConfirmedSince,
      lastShiftDate: keyEventApplied ? todayStr(today) : prev.lastShiftDate,
      nearKey: finalNearKey, lambda,
      currentTargets: prev.currentTargets, // orchestrator overwrites after capTurnover
      desiredTargets,
    },
  };
}

// Phase 2 §4: variant is always "base" — this lane never varies by
// inflation level.
export const phase2Lane: LaneFn = (inputs, prev) => computeBlendLane(inputs, prev, "base");

// Phase 3 §5: same carry/blend/cap/hold rules as phase2, but the
// variant is the REAL computed one from today's inflation state —
// ignores the live regime_phase3_weights flag entirely (the
// orchestrator notes variants_flag_off informationally, but this
// lane's own computation is never gated by it).
export const phase3Lane: LaneFn = (inputs, prev) =>
  computeBlendLane(inputs, prev, deriveVariant(inputs.inflLevelState, inputs.inflAccelVote));

export const LANES: Partial<Record<Lane, LaneFn>> = {
  live: liveLane,
  legacy: legacyLane,
  phase2: phase2Lane,
  phase3: phase3Lane,
};

// Event derivation, run once per lane per day by the orchestrator (not
// inside a lane, since the rule is identical across lanes). A key-level
// change (base/near/variant) always gets its own specific label, the
// day it happens, regardless of whether the cap also engaged that same
// day; cap_partial/cap_complete are reserved for a day with NO key-level
// change where the lane is still catching current_targets up to an
// already-set desired_targets from a prior day's move.
export function deriveEvent(opts: {
  lane: Lane;
  capped: boolean;
  prevRegimeKey: string | null;
  nextRegimeKey: string | null;
  prevNearKey: string | null;
  nextNearKey: string | null;
  prevVariant: Variant;
  nextVariant: Variant;
  preCappedTurnover: number;
  reachedDesired: boolean;
}): string {
  const {
    lane, capped, prevRegimeKey, nextRegimeKey, prevNearKey, nextNearKey,
    prevVariant, nextVariant, preCappedTurnover, reachedDesired,
  } = opts;

  const isKeyLevelChange = nextRegimeKey !== prevRegimeKey || nextNearKey !== prevNearKey || prevVariant !== nextVariant;
  if (isKeyLevelChange) {
    if (nextRegimeKey !== prevRegimeKey) return lane === "legacy" ? "shift_full" : "base_change";
    if (prevNearKey === null && nextNearKey !== null) return "blend_start";
    if (prevNearKey !== null && nextNearKey !== null && prevNearKey !== nextNearKey) return "blend_change";
    if (prevNearKey !== null && nextNearKey === null) return "blend_end";
    return "variant_change";
  }
  if (capped && preCappedTurnover > 0) {
    return reachedDesired ? "cap_complete" : "cap_partial";
  }
  return "no_change";
}

// §4.2/§5.3: Equity Tilting's sector tilts follow the same λ as the
// sleeve-level blend. Mirrors app/portfolios/page.jsx's identical
// client-side formula (a Deno module can't be imported into that
// bundle) — tests/shadowLanes.test.ts checks the two stay in sync.
export function blendSectorTargets(
  structRows: Record<string, number>,
  nearRows: Record<string, number> | null,
  lambda: number,
): Record<string, number> {
  if (!nearRows || lambda <= 0) return { ...structRows };
  const symbols = new Set([...Object.keys(structRows), ...Object.keys(nearRows)]);
  const blended: Record<string, number> = {};
  for (const sym of symbols) {
    const s = structRows[sym] ?? 0;
    const n = nearRows[sym] ?? 0;
    blended[sym] = s + lambda * (n - s);
  }
  return blended;
}
