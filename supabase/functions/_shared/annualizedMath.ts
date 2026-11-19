// v1 Phase 1 (growth-inflation-indicator-gaps spec). Pure, Deno-API-free
// 3-month-annualized transform: ((x_t / x_t-3)^4 - 1) * 100, date-matched
// against the observation exactly 3 calendar months earlier (never a fixed
// array-position offset — a gap in the series must never silently shift the
// comparison to the wrong month, same reasoning as yoyMath.ts's findYearAgo).
//
// Rule 10 ("one gap rule") names yoyMath.ts's single-month interpolation +
// fallback for YoY transforms specifically; this reuses that SAME gap-fill
// primitive (`monthlyGapFill`, `addMonths`) for a 3-month lag instead of a
// 12-month one, rather than inventing a second, parallel gap rule. Logged
// per rule 6: extending rule 10's one-gap-rule intent to this lag, not
// duplicating it.

import { addMonths, monthlyGapFill, Obs } from "./yoyMath.ts";

function toMonthMap(obs: Obs[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of obs) m.set(o.date.slice(0, 7) + "-01", o.value);
  return m;
}

function findMonthsAgoWithGapFill(
  obs: Obs[],
  refDate: string,
  monthsBack: number,
): { value: number; usedInterpolatedMonth: string | null } | undefined {
  const refMonthKey = refDate.slice(0, 7) + "-01";
  const targetMonthKey = addMonths(refMonthKey, -monthsBack);
  const direct = obs.find((o) => o.date.slice(0, 7) + "-01" === targetMonthKey);
  if (direct) return { value: direct.value, usedInterpolatedMonth: null };
  const fill = monthlyGapFill(toMonthMap(obs), targetMonthKey);
  if (!fill) return undefined;
  return { value: fill.value, usedInterpolatedMonth: fill.usedInterpolatedMonth };
}

export interface Annualized3mResult {
  current: number;
  previous: number;
  usedInterpolatedMonth: string | null;
}

// `obs` must be sorted descending by date (obs[0] = most recent). Needs at
// least 2 recent observations plus whatever history reaches 3 months back
// from each (monthlyGapFill only bridges a single missing month, same
// strictness as yoyPair — a 2+ month gap returns null for that point rather
// than guessing).
export function annualized3mMonthly(obs: Obs[]): Annualized3mResult | null {
  if (obs.length < 2) return null;
  const ya0 = findMonthsAgoWithGapFill(obs, obs[0].date, 3);
  const ya1 = findMonthsAgoWithGapFill(obs, obs[1].date, 3);
  if (!ya0 || !ya1 || ya0.value === 0 || ya1.value === 0) return null;
  const annualize = (xt: number, xt3: number) => (Math.pow(xt / xt3, 4) - 1) * 100;
  return {
    current: annualize(obs[0].value, ya0.value),
    previous: annualize(obs[1].value, ya1.value),
    usedInterpolatedMonth: ya0.usedInterpolatedMonth ?? ya1.usedInterpolatedMonth ?? null,
  };
}
