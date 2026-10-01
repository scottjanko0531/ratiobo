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
