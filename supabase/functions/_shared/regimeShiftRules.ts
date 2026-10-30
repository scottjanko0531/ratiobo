// Regime Tilt Recalibration, Phase 2 (spec §4) — pure decision logic for
// how a regime-driven portfolio's targets move day to day. Deliberately
// split out of update-regime-portfolio-targets/index.ts (which has no
// test coverage, like every edge function in this repo) so the actual
// decision rules ARE testable, without mocking Supabase.

import { WeightSet } from "./regimeWeights.ts";

export type StructuralKeySource = "crossover" | "leaning" | "carry" | null;

// §4.2: λ = clamp((smoothedConf - 50) / 50, 0, λ_max). A confidence at
// or below the 60% floor that still reaches here (shouldn't happen —
// the floor gate runs first) or a null confidence contributes nothing.
export function computeLambda(smoothedConfidence: number | null, lambdaMax = 0.5): number {
  if (smoothedConfidence == null) return 0;
  const raw = (smoothedConfidence - 50) / 50;
  return Math.max(0, Math.min(lambdaMax, raw));
}

// §4.2: W = W_struct + λ·(W_near − W_struct), rounded to whole
// percentages with the rounding remainder pushed into cash — same
// "whole numbers, remainder to cash" convention used for the Phase 0/1
// shift-notification weights.
export function blendWeights(struct: WeightSet, near: WeightSet, lambda: number): WeightSet {
  const keys = Object.keys(struct);
  const rounded: WeightSet = {};
  for (const k of keys) {
    const s = struct[k] ?? 0;
    const n = near[k] ?? 0;
    rounded[k] = Math.round(s + lambda * (n - s));
  }
  const sum = keys.reduce((a, k) => a + rounded[k], 0);
  rounded.cash = (rounded.cash ?? 0) + (100 - sum);
  return rounded;
}

// §4.3: total one-way turnover per run, Σ|Δw|/2, capped at maxPoints.
// Within the cap, `desired` is returned unchanged (it's already the
// final whole-percentage target). Over the cap, steps `current`
// partway toward `desired` — exactly maxPoints of one-way turnover —
// so finishing a large move takes multiple daily runs.
export function capTurnover(current: WeightSet, desired: WeightSet, maxPoints = 15): WeightSet {
  const keys = Array.from(new Set([...Object.keys(current), ...Object.keys(desired)]));
  const deltas: WeightSet = {};
  let turnover = 0;
  for (const k of keys) {
    const d = (desired[k] ?? 0) - (current[k] ?? 0);
    deltas[k] = d;
    turnover += Math.abs(d);
  }
  const oneWayTurnover = turnover / 2;
  if (oneWayTurnover <= maxPoints) return { ...desired };

  const scale = maxPoints / oneWayTurnover;
  const stepped: WeightSet = {};
  for (const k of keys) {
    stepped[k] = Math.round((current[k] ?? 0) + deltas[k] * scale);
  }
  const sum = keys.reduce((a, k) => a + stepped[k], 0);
  stepped.cash = (stepped.cash ?? 0) + (100 - sum);
  return stepped;
}

// §4.1: "Only fresh readings can move the base. A carry key never moves
// a portfolio off its current base." A portfolio with no base yet
// (never activated) has nothing to protect, so it still adopts the
// carried key to get its first-ever base.
export function resolveBaseKey(
  freshKey: string | null,
  source: StructuralKeySource,
  currentBaseKey: string | null,
): string | null {
  if (source === "carry") return currentBaseKey ?? freshKey;
  return freshKey ?? currentBaseKey;
}

// §4.3: minimum 21 days between applied key-level shifts, bypassed when
// structural (from a genuine crossover) and near-term agree on a key
// that differs from the current one.
export function canApplyKeyShift(
  lastShiftDate: string | null,
  today: Date,
  minHoldDays = 21,
  agreementException = false,
): boolean {
  if (agreementException) return true;
  if (!lastShiftDate) return true;
  const diffDays = Math.floor((today.getTime() - new Date(lastShiftDate + "T00:00:00Z").getTime()) / 86_400_000);
  return diffDays >= minHoldDays;
}
