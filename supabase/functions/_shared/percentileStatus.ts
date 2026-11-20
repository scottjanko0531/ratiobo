// Market Cap / GDP refinement (Scott, 2026-11-20): replaces a fixed
// <120%/120-180%/>180% status band with a band relative to the
// indicator's OWN history -- a level that reads as "elevated" only
// because it's historically rare for THIS series, not because it
// crossed an arbitrary absolute line picked without calibration.

// Percentile rank of `value` within `history` (0-100): the percentage of
// historical observations at or below `value`. Uses the "inclusive"
// rank convention (ties count in the numerator) since financial
// percentile-of-history framings (e.g. "this is the Nth percentile of
// its own range") conventionally include the value's own tier.
export function percentileRank(value: number, history: number[]): number | null {
  if (history.length === 0) return null;
  const atOrBelow = history.filter((h) => h <= value).length;
  return Math.round((atOrBelow / history.length) * 1000) / 10;
}

export type PercentileStatus = "healthy" | "watch" | "danger";

// <50th percentile = normal/healthy, 50th-85th = watch, >85th = danger.
// Boundaries are lower-bound-inclusive (50.0 lands in watch, 85.0 lands
// in danger), same convention as paradigmScoring.ts's classify().
export function percentileStatus(pctRank: number): PercentileStatus {
  if (pctRank < 50) return "healthy";
  if (pctRank < 85) return "watch";
  return "danger";
}
