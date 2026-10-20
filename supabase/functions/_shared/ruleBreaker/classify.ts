// Rule Breaker Screener — categorical classification (screen, qgroup,
// weak_pillar, risk_type). screen/qgroup/weak_pillar are CONFIRMED exact
// against all 155 baseline rows, zero exceptions. risk_type is NOT yet
// solved (correlates with but doesn't equal rb_fool.type -- 86/110
// agreement where both exist, and 45/155 symbols have no rb_fool row at
// all) -- throws, same convention as pillars.ts's uncalibrated stubs.

import { RB_CONFIG } from "./config.ts";
import type { DriverEntry } from "./types.ts";

export class NotCalibratedError extends Error {
  constructor(field: string) {
    super(
      `${field} is not yet calibrated against the artifact baseline -- ` +
        `see classify.ts header comment and scripts/rb-calibrate.ts`,
    );
    this.name = "NotCalibratedError";
  }
}

// Confirmed 155/155, zero exceptions: met=6 -> Rule Breaker always;
// met=5 -> Watchlist always (even score=100); met<=1 -> Doesn't fit always
// (even score=26); met in [2,4] -> score>=40 decides.
export function computeScreen(met: number, score: number): "Rule Breaker" | "Watchlist" | "Doesn't fit" {
  const { ruleBreakerMetThreshold, watchlistMetFloor, doesntFitMetCeiling, midTierScoreThreshold } = RB_CONFIG.screen;
  if (met === ruleBreakerMetThreshold) return "Rule Breaker";
  if (met === watchlistMetFloor) return "Watchlist";
  if (met <= doesntFitMetCeiling) return "Doesn't fit";
  return score >= midTierScoreThreshold ? "Watchlist" : "Doesn't fit";
}

// Confirmed: only populated for met=6 (Rule Breaker) rows in the real
// export; null otherwise. Among those 25 rows, quality>=~50 -> "comp",
// else "spec" -- zero violations (highest observed "spec" quality=47,
// lowest observed "comp" quality=51; exact boundary within that gap is
// unconfirmed, see config.ts's qgroup.compoundQualityThreshold comment).
export function computeQgroup(met: number, quality: number | null): "comp" | "spec" | null {
  if (met !== RB_CONFIG.screen.ruleBreakerMetThreshold || quality == null) return null;
  return quality >= RB_CONFIG.qgroup.compoundQualityThreshold ? "comp" : "spec";
}

export interface WeakPillarInputs {
  cashDrivers: DriverEntry[];
  trendDrivers: DriverEntry[];
  profDrivers: DriverEntry[];
  safety: number | null;
}

function meanPct(entries: DriverEntry[]): number | null {
  const pcts = entries.map((e) => e.pct).filter((p): p is number => p != null);
  if (pcts.length === 0) return null;
  return pcts.reduce((s, p) => s + p, 0) / pcts.length;
}

// Confirmed: reports the LOWEST of 4 named sub-scores, populated for every
// row (not just Rule Breaker tier, unlike qgroup) -- "Cash earnings" =
// mean(cash driver pcts), "Improving" = mean(trend driver pcts),
// "Profitability" = mean(prof driver pcts), "Safety" = the safety field
// itself (not a separate mean). Confirmed exact on example cases, e.g.
// "Cash earnings 10" for a symbol whose cash pcts meaned to ~10.2, which
// was indeed the lowest of its 4 sub-scores.
export function computeWeakPillar(inputs: WeakPillarInputs): string | null {
  const candidates: Array<[string, number | null]> = [
    ["Cash earnings", meanPct(inputs.cashDrivers)],
    ["Improving", meanPct(inputs.trendDrivers)],
    ["Profitability", meanPct(inputs.profDrivers)],
    ["Safety", inputs.safety],
  ];
  let weakest: [string, number] | null = null;
  for (const [name, value] of candidates) {
    if (value == null) continue;
    if (weakest == null || value < weakest[1]) weakest = [name, value];
  }
  if (weakest == null) return null;
  return `${weakest[0]} ${Math.round(weakest[1])}`;
}

export function computeRiskType(): "Aggressive" | "Moderate" | "Cautious" {
  throw new NotCalibratedError("risk_type");
}
