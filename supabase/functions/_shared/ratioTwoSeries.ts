// v1 Phase 1 (growth-inflation-indicator-gaps spec). Pure, Deno-API-free
// date-matched ratio of two series — for Job Openings ÷ Unemployed (labor
// tightness). Matches by CALENDAR MONTH, not array position, so the two
// series don't have to publish in perfectly lockstep order. No gap-fill: if
// a given month's denominator is missing or zero, that point is skipped
// ("not released yet, or a gap — skip, don't guess", the same convention
// backfillForecastActuals already uses in fetch-macro-data), never guessed.

export interface Obs {
  date: string;
  value: number;
}

export interface RatioPairResult {
  current: number;
  previous: number;
}

// `numerator`/`denominator` must be sorted descending by date. Returns the
// two most recent calendar months where BOTH series have a real, nonzero
// value — which may not be `numerator[0]`/`numerator[1]` if the denominator
// is missing a more recent month.
export function ratioTwoSeries(numerator: Obs[], denominator: Obs[]): RatioPairResult | null {
  const denomByMonth = new Map(denominator.map((o) => [o.date.slice(0, 7), o.value]));
  const paired = numerator
    .map((o) => ({ date: o.date, num: o.value, den: denomByMonth.get(o.date.slice(0, 7)) }))
    .filter((p): p is { date: string; num: number; den: number } => p.den != null && p.den !== 0);
  if (paired.length < 2) return null;
  return {
    current: paired[0].num / paired[0].den,
    previous: paired[1].num / paired[1].den,
  };
}
