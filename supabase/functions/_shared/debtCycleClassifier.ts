// Pure, Deno-API-free classifier for the debt cycle's monetary/fiscal stage
// (MP1 / MP1 (strained) / MP2 / MP3), per Dalio's Principles for Navigating
// Big Debt Crises. Lives in _shared/ (not update-big-cycle-metrics/index.ts
// directly) specifically so it can be imported by both the edge function and
// Vitest under Node — the edge function's module-scope Deno.env.get(...)!
// calls would throw if this logic lived there and Vitest tried to import it.
//
// Replaces the old single-snapshot classifyDebtCycleStage(): that version
// treated a single weekly WALCL reading as sufficient evidence of "QE is
// active," and used r-g >= 2 as the strained threshold, which doesn't match
// Dalio's own stated r > g test (confirmed against the 2026-08-21 fixture,
// which only resolves to "MP1 (strained)" under a >0 reading).

import { indirectBidderIsWeak } from "./statusThresholds.ts";
import { HysteresisGateResult } from "./hysteresisGate.ts";

export interface WeeklyPoint {
  date: string;
  value: number;
}

export interface ClassifierInput {
  fedFundsMid: number;
  interestExpenseRevenuePct: number; // raw latest reading -- informational only now (shown in the Position Check detail text); the actual gate is debtServiceStrainedGate below (v2 Phase 3)
  // v2 Phase 3: hysteresis gate on net-interest/receipts, computed by the
  // caller via _shared/hysteresisGate.ts against DEBT_SERVICE_STRAINED_GATE
  // (_shared/statusThresholds.ts) -- the ONE threshold source also used by
  // the fiscal-dominance trip-wire's condition 1 (Phase 3c), so a single
  // month crossing 20% can't flip the stage on its own.
  debtServiceStrainedGate: HysteresisGateResult;
  rateGrowthSpread: number; // r - g (DGS10 minus nominal GDP YoY; see debt-metrics-integrity spec Phase 1a)
  effectiveRateGrowthSpread: number | null; // r_eff - g; informational only, not a gate (Phase 1b)
  // v2 Phase 6a: "refinancing pressure ahead" informational inputs --
  // convergenceGap = dgs10 - rEff; NOT a stage gate, same as
  // effectiveRateGrowthSpread above. All four read from the r_eff card's
  // own metadata (fetch-macro-data's effective_rate_minus_nominal_yoy
  // case); dgs10 here is DERIVED (rEff + convergenceGap), not a separate
  // fetch.
  rEff: number | null;
  convergenceGap: number | null;
  dgs10: number | null;
  rEff12moAgo: number | null; // for the Position Check's trend arrow; null if insufficient history
  debtToTaxRevenueX: number | null; // informational only, not a gate
  walclPctGdpSeries: WeeklyPoint[]; // most-recent-first
  // Precomputed by the caller via _shared/indirectBidder.ts's
  // computeIndirectBidderSnapshot(rows, 0).value — v1 Phase 4a
  // consolidation, so this classifier gate, the macro card, and the
  // auction-demand trip-wire all read the exact same number off the same
  // table instead of three independently-pooled averages. Informational
  // only now (shown in the Position Check detail text) — the actual gate
  // uses indirectBidderShareZ below (v2 Phase 1).
  indirectBidderShareAvg6: number | null;
  // z-score of indirectBidderShareAvg6 against the metric's own full
  // history (_shared/indirectBidder.ts's computeIndirectBidderFullSeries +
  // zScoreOf) — v2 Phase 1: the raw value's fixed 57.5 threshold could
  // never reflect that this metric's typical range has structurally
  // shifted over time (see the v2 Phase 0 distribution). Comparing
  // relative to history instead.
  indirectBidderShareZ: number | null;
  bidToCoverSeries: WeeklyPoint[]; // trailing auctions, most-recent-first
  somaLongDurationDeltaSeries: WeeklyPoint[]; // trailing weeks, most-recent-first
}

export type TrendConfidence = "normal" | "low" | "unknown";

export interface ClassifierResult {
  stage: "MP1" | "MP1 (strained)" | "MP2" | "MP3";
  conditions: {
    debtServiceStrained: boolean;
    rGreaterG: boolean;
    fedPrintingRising: boolean;
    mp2Gate: boolean;
    mp3AuctionDemandWeak: boolean;
    mp3SomaAbsorbing: boolean;
  };
  trendConfidence: TrendConfidence;
  rawInputs: Record<string, number | null>;
}

// Collapses consecutive equal-value prints (e.g. a weekly series sampled
// into a daily snapshot table, where most days repeat the prior week's
// value) into distinct observations, most-recent-first preserved.
export function dedupeConsecutive(series: WeeklyPoint[]): WeeklyPoint[] {
  const out: WeeklyPoint[] = [];
  for (const p of series) {
    if (out.length === 0 || Math.abs(out[out.length - 1].value - p.value) > 1e-9) out.push(p);
  }
  return out;
}

// "Sustained rising" = at most one non-rising print-to-print delta in the
// window, AND the total move over the window is at least `epsilon`. At the
// full 8-print window this is exactly "6 of 7 deltas >= 0." With fewer than
// `lookback` distinct prints available, the same one-down-tick tolerance is
// applied to whatever exists (min 2 prints) and confidence drops to "low";
// with fewer than 2 distinct prints, rising is forced false ("unknown") —
// thin data should never silently promote the stage.
export function isSustainedRising(
  series: WeeklyPoint[],
  lookback = 8,
  minUp = 6,
  epsilon = 0.1,
): { rising: boolean; confidence: TrendConfidence } {
  const distinct = dedupeConsecutive(series);
  const window = distinct.slice(0, lookback);
  if (window.length < 2) return { rising: false, confidence: "unknown" };

  const deltaCount = window.length - 1;
  let upCount = 0;
  for (let i = 0; i < deltaCount; i++) {
    if (window[i].value - window[i + 1].value >= 0) upCount++;
  }
  const allowedDown = Math.max(0, lookback - 1 - minUp); // 1 at the full 8-print window
  const totalMove = window[0].value - window[window.length - 1].value;
  const rising = (deltaCount - upCount) <= allowedDown && totalMove >= epsilon;
  const confidence: TrendConfidence = window.length >= lookback ? "normal" : "low";
  return { rising, confidence };
}

// "Sustained positive" = at least `minPositive` of the `lookback` most
// recent distinct readings are > 0 (used for weekly SOMA absorption deltas,
// which are already period-over-period changes, not levels).
export function isSustainedPositive(
  series: WeeklyPoint[],
  lookback = 8,
  minPositive = 6,
): { positive: boolean; confidence: TrendConfidence } {
  const distinct = dedupeConsecutive(series);
  const window = distinct.slice(0, lookback);
  if (window.length < 2) return { positive: false, confidence: "unknown" };

  const positiveCount = window.filter((p) => p.value > 0).length;
  const requiredPositive = window.length >= lookback
    ? minPositive
    : Math.max(1, Math.round(window.length * (minPositive / lookback)));
  const confidence: TrendConfidence = window.length >= lookback ? "normal" : "low";
  return { positive: positiveCount >= requiredPositive, confidence };
}

export function trailingAverage(series: WeeklyPoint[], n = 6): number | null {
  const window = series.slice(0, n);
  if (!window.length) return null;
  return window.reduce((s, p) => s + p.value, 0) / window.length;
}

export function classifyDebtCycleStageV2(input: ClassifierInput): ClassifierResult {
  const debtServiceStrained = input.debtServiceStrainedGate.armed;
  const rGreaterG = input.rateGrowthSpread > 0;

  const walclTrend = isSustainedRising(input.walclPctGdpSeries);
  const fedPrintingRising = walclTrend.rising;
  const mp2Gate = input.fedFundsMid < 0.5 && fedPrintingRising;

  const indirectBidderAvg6 = input.indirectBidderShareAvg6;
  const indirectBidderZ = input.indirectBidderShareZ;
  const bidToCoverAvg6 = trailingAverage(input.bidToCoverSeries, 6);
  const mp3AuctionDemandWeak =
    (indirectBidderZ != null && indirectBidderIsWeak(indirectBidderZ)) ||
    (bidToCoverAvg6 != null && bidToCoverAvg6 < 2.0);

  const somaTrend = isSustainedPositive(input.somaLongDurationDeltaSeries);
  const mp3SomaAbsorbing = somaTrend.positive;

  let stage: ClassifierResult["stage"];
  if (mp2Gate && mp3AuctionDemandWeak && mp3SomaAbsorbing) {
    stage = "MP3";
  } else if (mp2Gate) {
    stage = "MP2";
  } else {
    const strainedCount = [debtServiceStrained, rGreaterG, fedPrintingRising].filter(Boolean).length;
    stage = strainedCount >= 2 ? "MP1 (strained)" : "MP1";
  }

  const confidences = [walclTrend.confidence, somaTrend.confidence];
  const trendConfidence: TrendConfidence = confidences.includes("unknown")
    ? "unknown"
    : confidences.includes("low")
    ? "low"
    : "normal";

  return {
    stage,
    conditions: {
      debtServiceStrained,
      rGreaterG,
      fedPrintingRising,
      mp2Gate,
      mp3AuctionDemandWeak,
      mp3SomaAbsorbing,
    },
    trendConfidence,
    rawInputs: {
      fedFundsMid: input.fedFundsMid,
      interestExpenseRevenuePct: input.interestExpenseRevenuePct,
      rateGrowthSpread: input.rateGrowthSpread,
      effectiveRateGrowthSpread: input.effectiveRateGrowthSpread,
      rEff: input.rEff,
      convergenceGap: input.convergenceGap,
      dgs10: input.dgs10,
      rEff12moAgo: input.rEff12moAgo,
      debtToTaxRevenueX: input.debtToTaxRevenueX,
      indirectBidderShareAvg6: indirectBidderAvg6,
      indirectBidderShareZ: indirectBidderZ,
      bidToCoverAvg6: bidToCoverAvg6,
      // v2 Phase 3b: rawInputs records BOTH the raw value (above) and the
      // gate state, so the Position Check can show e.g. "19.8% (gate: off,
      // needs >20.5% for 2 months)" instead of just the boolean.
      debtServiceStrainedGateInsufficientHistory: input.debtServiceStrainedGate.insufficientHistory ? 1 : 0,
      debtServiceStrainedGateMonthsAvailable: input.debtServiceStrainedGate.monthsAvailable,
    },
  };
}
