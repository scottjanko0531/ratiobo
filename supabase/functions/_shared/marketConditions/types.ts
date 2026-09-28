// Market Conditions Overlay — shared types. Pure, Deno-API-free (same
// convention as debtCycleClassifier.ts / paradigmScoring.ts): imported both
// by the edge functions and by Vitest under Node.

export interface DateValue {
  date: string; // YYYY-MM-DD
  value: number;
}

export type TrendState = "UP" | "MIXED" | "DOWN";
export type TierName = "FULL" | "NORMAL" | "CAUTIOUS" | "DEFENSIVE" | "RISK_OFF";
// mc-1.4.0: ADD_SMALL/TRIM dropped along with E-CAPITULATION/E-TOP (both
// depended on the rejected breadth pillar) -- see entrySignal.ts.
export type EntrySignalName = "ADD" | "NEUTRAL" | "WAIT";
export type PillarName = "trend" | "breadth" | "stress" | "sentiment" | "macro";

// One normalized sub-indicator's full trail: raw value, percentile rank
// (percentile-normalized indicators only — null for binary +/-1 ones),
// and the final [-1,1] score. `excluded` covers both "insufficient history"
// (spec Section 5) and "input not available yet" (e.g. Phase 2+ series).
export interface SubIndicatorResult {
  raw: number | null;
  percentile: number | null;
  score: number | null;
  excluded: boolean;
  excludeReason?: string;
}

export interface PillarResult {
  score: number | null; // null = pillar entirely unavailable this day
  indicators: Record<string, SubIndicatorResult>;
}

export interface HysteresisState {
  tierIndex: number; // 0=FULL .. 4=RISK_OFF (see config.ts TIER_ORDER)
  upStreak: number;
  downStreak: number;
  trendState: TrendState;
  aboveBandStreak: number; // consecutive days close > SMA200*(1+band) -- mc-1.2.0's DOWN-exit condition (indicators/trend.ts's resolveTrendState)
  fastPathLatched: boolean; // mc-1.3.0: recovery fast-path latch state (scoring.ts's stepTierState)
  vetoActive: boolean;
  vetoTermStructureStreak: number; // consecutive days VIX/VIX3M > threshold
  vetoClearStreak: number; // consecutive days BOTH veto conditions false
}

// mc-1.4.0 entry-rule round: trimmed to what the surviving rules
// (E-DIP/E-HOT/E-DOWN/E-DEFAULT) actually read. vetoActive is gone --
// E-VETO itself was removed (failed its pre-registered validation
// criterion in 4/4 markets, see DECISIONS.md); the tier-level stress veto
// is unaffected and still tracked separately via DayScoreRow.vetoActive/
// flags.veto, just no longer feeds entry-signal evaluation. breadthScore/
// breadthDivergence/breadthThrustNew/pctOversold/vixTermStructure* are
// gone with E-TOP/E-THRUST/E-CAPITULATION (all depended on the rejected
// breadth pillar) -- not "deferred to Phase 2," permanently removed per
// explicit instruction, no replacement rules.
export interface EntrySignalInput {
  trendState: TrendState;
  rsi14?: number; // O1, indicators/oscillators.ts
  stretch50d?: number; // O2, indicators/oscillators.ts
}

export interface EntrySignalResult {
  signal: EntrySignalName;
  reason: string; // rule ID, e.g. "E-VETO", "E-DEFAULT"
}

export interface DayScoreRow {
  date: string;
  configVersion: string;
  trendState: TrendState;
  scoreTrend: number | null;
  scoreBreadth: number | null;
  scoreStress: number | null;
  scoreSentiment: number | null;
  scoreMacro: number | null;
  composite: number;
  rawTier: TierName;
  tier: TierName;
  exposureMultiplier: number;
  entrySignal: EntrySignalName;
  entryReason: string;
  vetoActive: boolean;
  flags: Record<string, unknown>;
  components: Record<string, unknown>;
}
