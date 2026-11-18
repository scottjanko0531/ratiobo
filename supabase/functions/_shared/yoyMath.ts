// Pure, Deno-API-free date-matched year-over-year helpers — extracted from
// fetch-macro-data/index.ts (which can't be imported under Vitest; its
// module scope calls Deno.env.get(...)! directly) so the date-matching
// logic itself is unit-testable. Same split rationale as
// debtCycleClassifier.ts's own header comment.

export interface Obs { date: string; value: number }

// Finds the observation one calendar year before `refDate` (same month,
// year - 1) — NOT "N positions back in the array" — so a missing month in
// the series (a gap) never silently shifts the year-ago match to the wrong
// month.
export function findYearAgo(obs: Obs[], refDate: string): Obs | undefined {
  const d = new Date(refDate);
  const targetYear = d.getUTCFullYear() - 1;
  const targetMonth = d.getUTCMonth();
  return obs.find((o) => {
    const od = new Date(o.date);
    return od.getUTCFullYear() === targetYear && od.getUTCMonth() === targetMonth;
  });
}

// v2 Phase 4a: addMonths on a "YYYY-MM-01" month-key string. Promoted here
// from _shared/inflationRegime.ts (still re-exported there for
// get-regime-analysis/index.ts's existing import) since it's the month-key
// arithmetic the general gap rule below needs, not anything
// inflation-regime-specific.
export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

export interface MonthlyGapFill {
  value: number;
  usedInterpolatedMonth: string;
}

// v2 Phase 4a: the ONE gap rule for monthly price/economic indexes,
// promoted out of inflationRegime.ts's old hardcoded GAP_MONTH block
// (originally: "CPIAUCSL is missing Oct 2025 (government shutdown)").
// Generalized: ANY month missing from `series` (keyed by "YYYY-MM-01"),
// bracketed by REAL observations in the immediately preceding and
// following calendar months, gets a one-off geometric-mean fill — for
// computing a YoY ratio on either side of the gap ONLY. Never mutates
// `series`, never persisted to any raw-series table (callers get a value
// back; they decide what to do with it). A gap of 2+ consecutive months
// is never filled — returns null, same strict behavior as before.
export function monthlyGapFill(series: Map<string, number>, gapMonth: string): MonthlyGapFill | null {
  if (series.has(gapMonth)) return null; // not actually missing — nothing to fill
  const before = series.get(addMonths(gapMonth, -1));
  const after = series.get(addMonths(gapMonth, 1));
  if (before == null || after == null) return null;
  return { value: Math.sqrt(before * after), usedInterpolatedMonth: gapMonth };
}

function toMonthMap(obs: Obs[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of obs) m.set(o.date.slice(0, 7) + "-01", o.value);
  return m;
}

// Same job as findYearAgo, but falls back to monthlyGapFill when the exact
// year-ago month is missing. `obs` doesn't need to be monthly for this to
// be safe: a quarterly series' observations are 3 calendar months apart,
// so the "immediately preceding/following calendar month" neighbors this
// looks for are structurally never present in a quarterly obs array —
// the fill path simply never fires for non-monthly series, no special
// casing required by callers.
function findYearAgoWithGapFill(
  obs: Obs[],
  refDate: string,
): { value: number; usedInterpolatedMonth: string | null } | undefined {
  const direct = findYearAgo(obs, refDate);
  if (direct) return { value: direct.value, usedInterpolatedMonth: null };
  const d = new Date(refDate);
  const targetMonth = `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const fill = monthlyGapFill(toMonthMap(obs), targetMonth);
  if (!fill) return undefined;
  return { value: fill.value, usedInterpolatedMonth: fill.usedInterpolatedMonth };
}

export interface YoyPairResult {
  current: number;
  previous: number;
  usedInterpolatedMonth: string | null;
}

export function yoyPair(obs: Obs[]): YoyPairResult | null {
  if (obs.length < 2) return null;
  const ya0 = findYearAgoWithGapFill(obs, obs[0].date);
  const ya1 = findYearAgoWithGapFill(obs, obs[1].date);
  if (!ya0 || !ya1) return null;
  return {
    current: (obs[0].value / ya0.value - 1) * 100,
    previous: (obs[1].value / ya1.value - 1) * 100,
    usedInterpolatedMonth: ya0.usedInterpolatedMonth ?? ya1.usedInterpolatedMonth ?? null,
  };
}

export interface YoyPairWithFallbackResult extends YoyPairResult {
  usedObsDate: string;
  staleReason: string | null;
}

// v2 Phase 4c: when even gap-filling can't pair the newest observation
// (e.g. a 2+ month gap, or the series itself just hasn't published yet),
// walk back to the most recent observation that CAN be paired, rather
// than freezing the card forever. `staleReason` is set whenever the
// returned pairing isn't the newest observation, so callers/UI can flag
// it rather than silently presenting old data as current.
export function yoyPairWithFallback(obs: Obs[]): YoyPairWithFallbackResult | null {
  for (let offset = 0; offset < obs.length - 1; offset++) {
    const pair = yoyPair(obs.slice(offset));
    if (pair) {
      return {
        ...pair,
        usedObsDate: obs[offset].date,
        staleReason: offset === 0 ? null : `newest observation (${obs[0].date}) could not be paired; using ${obs[offset].date} instead`,
      };
    }
  }
  return null;
}
