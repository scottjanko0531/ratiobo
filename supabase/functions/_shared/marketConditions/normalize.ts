// Market Conditions Overlay — normalization helpers (build spec Section 5).
// Pure, Deno-API-free.

export function clip(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

// Percentile rank of `x` within `window`, as a value in [0, 100]. `window`
// is expected to include `x` itself (walk-forward: x_t is itself part of
// the trailing population once t has passed — matches the spec's own
// "percentile_rank(x_t, window=...)" wording). Ties are rank-averaged
// (standard mean-rank convention) rather than always-less-than, so a value
// repeated at the extreme doesn't silently pin the score at exactly +/-1.
export function percentileRank(window: number[], x: number): number {
  if (window.length === 0) return 50;
  let less = 0, equal = 0;
  for (const v of window) {
    if (v < x) less++;
    else if (v === x) equal++;
  }
  return ((less + 0.5 * equal) / window.length) * 100;
}

// pct in [0,100] -> score in [-1,1]. invert=true for "higher raw value is
// worse" inputs (VIX, credit spreads, etc — spec Section 6.3's stress
// sub-indicators are all inverted).
export function percentileToScore(pct: number, invert = false): number {
  const raw = 2 * (pct / 100) - 1;
  return clip(invert ? -raw : raw);
}

// Trailing window of `series` ending at (and including) index `t`, capped
// at `maxWindow` points, or null if fewer than `minHistory` points exist —
// the spec's "insufficient history -> exclude" gate (Section 5). Excludes
// index `t` itself from the RETURNED window's length check against
// minHistory in the sense that t+1 total points (0..t inclusive) must reach
// minHistory, i.e. minHistory counts t as one of its own history points,
// matching percentileRank's "window includes x" convention above.
export function rollingWindow<T>(series: T[], t: number, maxWindow: number, minHistory: number): T[] | null {
  if (t + 1 < minHistory) return null;
  const start = Math.max(0, t - maxWindow + 1);
  return series.slice(start, t + 1);
}

// Trailing non-null history of `series` (which may contain nulls for early
// dates before its own lookback is satisfied), ending at and including
// index t, capped at maxWindow points, gated on minHistory non-null points.
// Returns null if that gate isn't met — the spec's "insufficient history ->
// exclude" rule (Section 5), applied uniformly by every percentile-based
// indicator (T1/T3 in trend.ts, S1-S5 in stress.ts) via this one function.
export function collectPriorNonNull(series: (number | null)[], t: number, maxWindow: number, minHistory: number): number[] | null {
  const vals: number[] = [];
  for (let i = Math.max(0, t - maxWindow + 1); i <= t; i++) {
    const v = series[i];
    if (v != null) vals.push(v);
  }
  if (vals.length < minHistory) return null;
  return vals;
}

export interface SeriesRowWithPublish { date: string; value: number; published_at: string }
export interface ForwardFillResult { value: number | null; carriedDays: number }

// Aligns a raw series to `dates` (the target trading calendar), carrying
// the last published value forward up to `maxCarryDays` TRADING-DAY
// positions in `dates` (not calendar days) when a date has no exact match.
// `carriedDays` is 0 for an exact match, 1..maxCarryDays for a forward-fill,
// and the result is `{ value: null, carriedDays: -1 }` when nothing usable
// exists within the cap.
//
// "Respecting published_at": a row is only eligible to fill date `t` if its
// own published_at <= t -- the no-lookahead guarantee. For Phase 1's daily
// series (VIXCLS/VIX3M/BAA10Y) published_at always equals the row's own
// date, so this never changes behavior today, but it's the same mechanism
// Phase 4's weekly series (whose published_at genuinely lags their as-of
// date) will need, built once rather than twice.
export function alignWithForwardFill(dates: string[], rows: SeriesRowWithPublish[], maxCarryDays: number): ForwardFillResult[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: ForwardFillResult[] = [];
  for (let i = 0; i < dates.length; i++) {
    const t = dates[i];
    let found: ForwardFillResult | null = null;
    for (let back = 0; back <= maxCarryDays; back++) {
      const idx = i - back;
      if (idx < 0) break;
      const row = byDate.get(dates[idx]);
      if (row && row.published_at <= t) { found = { value: row.value, carriedDays: back }; break; }
    }
    out.push(found ?? { value: null, carriedDays: -1 });
  }
  return out;
}

export function sma(values: number[], t: number, n: number): number | null {
  if (t - n + 1 < 0) return null;
  let s = 0;
  for (let i = t - n + 1; i <= t; i++) s += values[i];
  return s / n;
}

export function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stdevPop(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
}
