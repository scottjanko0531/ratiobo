// Bond Lens overlay — normalization helpers (docs/specs/bond-lens.md §4).
// Pure, Deno-API-free. Literal z-scores (not Market Conditions' percentile
// rank), per the v2.1 decision: magnitude ("how cheap") matters here, not
// just rank.

export function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Sample stdev (n-1 denominator) -- matches lib/riskParity.js's existing
// convention elsewhere in this repo, not Market Conditions' population
// stdevPop (which normalizes a fixed trailing window for percentile rank,
// a different statistical use case).
export function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

export function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export interface ZScoreResult {
  z: number | null;
  excluded: boolean;
  excludeReason?: string;
}

// Literal z-score of series[t] against its own trailing window (series[t]
// included, matching the "x_t is itself part of the population" convention
// already used for Market Conditions' percentileRank), capped at
// `window.normWindow` points, gated on `window.minHistory` -- before that
// minimum is reached this returns excluded=true, never a score (§4 Phase B
// acceptance: "missing inputs are reweighted and flagged, never silently
// zeroed"; the same rule extends to "not enough history yet"). Clipped to
// +/-window.clipZ.
export function rollingZScoreAt(
  series: (number | null)[], t: number, cfg: { normWindow: number; minHistory: number; clipZ: number },
): ZScoreResult {
  const x = series[t];
  if (x == null) return { z: null, excluded: true, excludeReason: "input unavailable" };
  const start = Math.max(0, t - cfg.normWindow + 1);
  const window: number[] = [];
  for (let i = start; i <= t; i++) { const v = series[i]; if (v != null) window.push(v); }
  if (window.length < cfg.minHistory) return { z: null, excluded: true, excludeReason: "insufficient history" };
  const sd = stdev(window);
  if (sd === 0) return { z: 0, excluded: false };
  return { z: clip((x - mean(window)) / sd, -cfg.clipZ, cfg.clipZ), excluded: false };
}

// Carries the last available value in `rows` forward onto `dates`, as of
// each target date, capped at `maxCarryDays` CALENDAR days of staleness.
//
// Earlier version matched by looking up `dates[i - back]` in a Map keyed
// by the source rows' own dates -- works for same-day series (every
// FRED/NY Fed daily series here) where the source date is guaranteed to
// appear verbatim in the target trading calendar, but silently breaks for
// MONTHLY series (PCEPILFE, EXPINF1YR) and r-star's quarter-start dates:
// those are frequently weekends/holidays (e.g. 2026-08-01 is a Saturday)
// that never appear in a trading-day calendar at ANY position, so no
// `back` value could ever find them -- confirmed as the actual cause of
// inflTrend/quadrant/breakeven_gap_bp going excluded on live dates despite
// a generous cap. Binary search for the latest source row with
// `date <= target`, then gate on the CALENDAR-day gap between that row's
// own date and the target -- correct regardless of whether either date is
// a trading day.
export function alignForwardFill(dates: string[], rows: { date: string; value: number }[], maxCarryDays: number): (number | null)[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: (number | null)[] = [];
  for (const target of dates) {
    let lo = 0, hi = sorted.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].date <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) { out.push(null); continue; }
    const row = sorted[ans];
    out.push(calendarDaysBetween(row.date, target) <= maxCarryDays ? row.value : null);
  }
  return out;
}

function calendarDaysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}

// §3.2's one-quarter publication lag for HLW r-star: a row's calendar
// date is pushed forward by `lagDays` before forward-filling, so a Q1
// r-star reading isn't treated as "available" until Q2 has started --
// applied here (at the input-shaping stage) rather than inside
// alignForwardFill, so that function stays a generic no-lag primitive.
export function lagDaysThenAlign(dates: string[], rows: { date: string; value: number }[], lagDays: number, maxCarryDays: number): (number | null)[] {
  const lagged = rows.map((r) => ({ date: shiftDate(r.date, lagDays), value: r.value }));
  return alignForwardFill(dates, lagged, maxCarryDays);
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Latest index j <= t such that dates[j] is at least `days` calendar days
// before dates[t] -- the "closest trading day >= N days ago" lookup every
// *_mom / 8-week-change calculation needs, robust to `dates` not being a
// uniform daily grid (weekends, holidays, forward-filled monthly series).
// Returns null if dates[t] itself is less than `days` into the series.
// Binary search, not a linear backward scan -- called once per module per
// day over a ~16k-trading-day history, so O(n) per call would be O(n^2)
// overall; `dates` is sorted ascending, so this is safe.
export function indexDaysAgo(dates: string[], t: number, days: number): number | null {
  const target = shiftDate(dates[t], -days);
  let lo = 0, hi = t, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans >= 0 ? ans : null;
}
