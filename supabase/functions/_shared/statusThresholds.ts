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
