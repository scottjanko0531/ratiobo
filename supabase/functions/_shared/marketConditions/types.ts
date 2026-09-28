// Market Conditions Overlay — shared types. Pure, Deno-API-free (same
// convention as debtCycleClassifier.ts / paradigmScoring.ts): imported both
// by the edge functions and by Vitest under Node.

export interface DateValue {
  date: string; // YYYY-MM-DD
  value: number;
}

export type TrendState = "UP" | "MIXED" | "DOWN";
export type TierName = "FULL" | "NORMAL" | "CAUTIOUS" | "DEFENSIVE" | "RISK_OFF";
export type EntrySignalName = "ADD" | "ADD_SMALL" | "NEUTRAL" | "WAIT" | "TRIM";
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
  vetoActive: boolean;
  vetoTermStructureStreak: number; // consecutive days VIX/VIX3M > threshold
  vetoClearStreak: number; // consecutive days BOTH veto conditions false
}

// Optional fields present only from Phase 2+ (breadth/oscillators). Entry
// rules that reference them are skipped entirely when undefined, per spec
// Section 7.4: "Before Phase 2 (no breadth), rules referencing breadth
// fields are skipped."
export interface EntrySignalInput {
  trendState: TrendState;
  vetoActive: boolean;
  breadthScore?: number;
  breadthDivergence?: boolean;
  breadthThrustNew?: boolean; // thrust triggered within its own hold window's first 10 days
  rsi14?: number;
  stretch50d?: number;
  pctOversold?: number;
  vixTermStructureRecentlyAbove1?: boolean; // was VIX/VIX3M > 1.0 within last N days
  vixTermStructureNowBelow1?: boolean;
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
