// Bond Lens overlay — shared types (docs/specs/bond-lens.md §4). Pure,
// Deno-API-free, same convention as _shared/marketConditions/types.ts:
// imported both by the edge functions and by Vitest under Node.

export interface DateValue {
  date: string; // YYYY-MM-DD
  value: number;
}

// Every module's per-day result carries raw inputs alongside the score so
// the explanation text (bond_lens_signal.explanation) and the "missing
// inputs are reweighted and flagged, never silently zeroed" rule (§4
// Phase B acceptance) have something to point to. `score` is null exactly
// when `excluded` is true.
export interface ModuleResult<TRaw> {
  raw: TRaw;
  score: number | null;
  excluded: boolean;
  excludeReason?: string;
}

export type TrendState = "up" | "down" | "mixed";
export type Quadrant = "Q1" | "Q2" | "Q3" | "Q4";
export type CurveRegime = "bull_flattening" | "bull_steepening" | "neutral" | "bear_flattening" | "bear_steepening";

// §4.4 hedge_reliable and §4.6 curve regime both need day-to-day
// persistence across compute runs (2-consecutive-weekly-reads hysteresis;
// 2-week regime-confirmation), so the walk-forward history computation
// carries this state forward exactly like HysteresisState in
// _shared/marketConditions/types.ts.
export interface BondLensHysteresisState {
  hedgeReliable: boolean;
  hedgeReliableStreak: number; // consecutive weekly reads agreeing with the CURRENT hedgeReliable value
  curveRegime: CurveRegime | null;
  curveRegimeCandidate: CurveRegime | null;
  curveRegimeCandidateStreak: number;
  regimeSince: string | null; // date the confirmed curveRegime took effect
  bearFlatteningSeen: boolean; // for the bear_flattening -> bull_flattening late-cycle transition flag
}
