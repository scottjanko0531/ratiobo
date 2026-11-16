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

export function yoyPair(obs: Obs[]): { current: number; previous: number } | null {
  if (obs.length < 2) return null;
  const ya0 = findYearAgo(obs, obs[0].date);
  const ya1 = findYearAgo(obs, obs[1].date);
  if (!ya0 || !ya1) return null;
  return {
    current: (obs[0].value / ya0.value - 1) * 100,
    previous: (obs[1].value / ya1.value - 1) * 100,
  };
}
