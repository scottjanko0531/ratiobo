// Pure, Deno-API-free status-threshold functions for the Phase 3
// (debt-metrics-integrity spec) cards whose status moved from a level-based
// read to a trend/stance/change-based one. Extracted from fetch-macro-data
// (which can't be imported under Vitest; its module-scope Deno.env.get(...)!
// calls would throw) so each threshold decision is independently
// unit-testable — closes out the spec's §5 test checklist item "gold trend
// status; real fed funds stance mapping; convenience-yield change status."

export type ThresholdStatus = "healthy" | "watch" | "danger";
export type Stance = "accommodative" | "neutral" | "restrictive";

// Phase 3a: "Gold Price (3M Avg)" — status follows the TREND (3M avg vs.
// the prior 3M avg), not the price level. Thresholds are a starting point,
// not calibrated (see the Phase 3 decisions log).
export function goldTrendStatus(current3mAvg: number, prior3mAvg: number): ThresholdStatus {
  const trendPct = (current3mAvg / prior3mAvg - 1) * 100;
  if (trendPct > 5) return "danger";
  if (trendPct > 0) return "watch";
  return "healthy";
}

// Phase 3a: "Central Bank Gold Purchases (4Q, tonnes)" — one-sided z-score
// threshold (only a buying SURGE is the signal this card exists to catch).
export function goldPurchasesZScoreStatus(zScore: number): ThresholdStatus {
  if (zScore > 2) return "danger";
  if (zScore > 1) return "watch";
  return "healthy";
}

// Phase 3b: "Real Fed Funds Rate" — a stance family, not a risk level.
export function realFedFundsStance(realFedFunds: number): Stance {
  if (realFedFunds < 0) return "accommodative";
  if (realFedFunds <= 1.5) return "neutral";
  return "restrictive";
}

// Phase 3c: "Treasury Convenience Yield (10Y)" — status follows the CHANGE
// (current level minus its trailing 1-year average, in bp), not the
// level's sign.
export function convenienceYieldChangeStatus(currentBp: number, avg1yBp: number): ThresholdStatus {
  const deltaBp = currentBp - avg1yBp;
  if (deltaBp < -15) return "danger";
  if (deltaBp < -5) return "watch";
  return "healthy";
}

// v2 Phase 1 (debt-metrics-integrity-v2 spec): the ONE threshold source for
// Indirect Bidder Share — the card, classifyDebtCycleStageV2's
// mp3AuctionDemandWeak gate, and the auction-demand trip-wire all import
// this instead of three separately-inlined numbers (55/57.5/65, the exact
// drift the v1 Phase 4a "one calculation" fix didn't close, because it
// consolidated the CALCULATION but left each consumer's own fixed-level
// THRESHOLD in place against a metric whose typical range has structurally
// shifted — see docs/specs/debt-metrics-integrity-decisions.md's v2 Phase 0
// distribution work). All z-score boundaries are uncalibrated starting
// points, logged per rule 6 — not statistically fit, just directionally
// reasonable given the real distribution (full-history stdev 7.05,
// trailing-2yr stdev 2.02).
export const INDIRECT_BIDDER_THRESHOLDS = {
  // Card status: z vs. the metric's FULL history.
  card: { watchZ: -1, dangerZ: -2 },
  // Classifier mp3AuctionDemandWeak: a single, stronger boundary (MP3-
  // adjacent evidence needs more than "watch"-level weakness).
  classifierWeakZ: -1.5,
  // Trip-wire (early warning, relative to its own trailing 2-year mean —
  // a different, shorter reference window than the card/classifier's full
  // history, since "early warning" means "unusual lately," not "unusual
  // ever"): arms on a sustained move below the mean, disarms on a
  // sustained move back toward it (hysteresis — rule 7, every gate needs
  // a real disarm path).
  tripWire: { armSdMultiplier: 1, armPersistRounds: 3, disarmSdMultiplier: 0.5, disarmPersistRounds: 2 },
};

export function indirectBidderCardStatus(z: number): ThresholdStatus {
  if (z > INDIRECT_BIDDER_THRESHOLDS.card.watchZ) return "healthy";
  if (z > INDIRECT_BIDDER_THRESHOLDS.card.dangerZ) return "watch";
  return "danger";
}

export function indirectBidderIsWeak(z: number): boolean {
  return z <= INDIRECT_BIDDER_THRESHOLDS.classifierWeakZ;
}

// v2 Phase 3 (debt-metrics-integrity-v2 spec): the one threshold source for
// the debt-service-strained hysteresis gate (_shared/hysteresisGate.ts) --
// shared by the classifier's debtServiceStrained condition and the
// fiscal-dominance trip-wire's condition 1 (Phase 3c: same gate state, not
// a second independent >20 check). Uncalibrated starting point, logged per
// rule 6 -- a symmetric 1-point dead band around the Dalio 20% checkpoint,
// not statistically fit.
export const DEBT_SERVICE_STRAINED_GATE = { on: 20.5, off: 19.5, persistMonths: 2 };
