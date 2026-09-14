// Fiscal Policy Paradigm scorecard — pure scoring math (42 Macro's Paradigm
// A-E sovereign-debt-resolution framework). Lives in _shared/ for the same
// reason as debtCycleClassifier.ts: importable by both the edge function
// and Vitest, no Deno-only APIs, no network calls.
//
// Per the build spec's own product requirements: no hand-picked weights
// (Section 4.3 — equal weight among available metrics, re-normalized fresh
// on every refresh) and fixed, non-editable classification thresholds
// (Section 4.5). This file is the ONE place that logic lives — nothing
// overrides a weight or a threshold anywhere else in the codebase.

// z = (current - trailing_mean) / trailing_stddev, using the population
// stddev (divide by n, not n-1) of the trailing window itself — the window
// IS the full population being compared against, not a sample estimating a
// larger population. Returns 0 (not NaN) for a degenerate window (<2
// points, or zero variance) rather than propagating a NaN into the
// composite score.
export function zScore(trailingValues: number[], current: number): number {
  const n = trailingValues.length;
  if (n < 2) return 0;
  const mean = trailingValues.reduce((a, b) => a + b, 0) / n;
  const variance = trailingValues.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;
  return (current - mean) / stddev;
}

// Each metric's sign is fixed in its definition (paradigmMetrics.ts), not
// adjustable at runtime — this just applies it so a positive oriented_z
// always means "more evidence for this paradigm," regardless of whether
// the raw metric itself moves up or down to mean that.
export function orientedZ(z: number, sign: 1 | -1): number {
  return z * sign;
}

// Equal weight across whichever metric keys are actually available today —
// the "automatic" half of "automatically weighted": no metric is worth
// more than another a priori. If a metric's FRED pull failed, it's simply
// absent from `availableKeys` and the remaining metrics' weights sum back
// to 1.0 on their own, recomputed fresh every call (never cached from a
// prior day where more metrics were available).
export function renormalizeWeights(availableKeys: string[]): Record<string, number> {
  const n = availableKeys.length;
  if (n === 0) return {};
  const w = 1 / n;
  return Object.fromEntries(availableKeys.map((k) => [k, w]));
}

export function compositeScore(orientedZs: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < orientedZs.length; i++) sum += orientedZs[i] * (weights[i] ?? 0);
  return sum;
}

export type ParadigmLabel = "Not Active" | "Emerging" | "Active" | "Dominant";

// Fixed thresholds (spec 4.5), not editable anywhere in the UI. Band
// boundaries are lower-bound-inclusive (score === 0.5 lands in Active,
// score === 1.5 lands in Dominant) — the spec's own table states boundaries
// as "-0.5 to 0.5" / "0.5 to 1.5" without specifying which side is
// inclusive; this is the one consistent convention applied throughout.
export function classify(score: number): ParadigmLabel {
  if (score < -0.5) return "Not Active";
  if (score < 0.5) return "Emerging";
  if (score < 1.5) return "Active";
  return "Dominant";
}

// Paradigm A is the originating condition B/C/D respond to, not a
// competing response path — displayed as Confirmed/Not Confirmed rather
// than in the same B/C/D horse race (spec 4.6). Confirmed once its
// composite score clears the same Active threshold (0.5) the other
// paradigms use — same math, different display framing only.
export type ParadigmAStatus = "Confirmed" | "Not Confirmed";
export function classifyParadigmA(score: number): ParadigmAStatus {
  return score >= 0.5 ? "Confirmed" : "Not Confirmed";
}

// Among B/C/D only: highest composite score wins, but ONLY if it clears
// the Active threshold (0.5) — otherwise returns null, meaning "no
// paradigm currently dominant." That's a real, meaningful output state
// (spec 4.7), not an error to paper over with a forced pick.
export function selectDominant(scores: { paradigm: string; score: number }[]): string | null {
  if (scores.length === 0) return null;
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  return best.score >= 0.5 ? best.paradigm : null;
}
