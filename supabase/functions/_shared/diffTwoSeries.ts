// v1 Phase 1 (growth-inflation-indicator-gaps spec). Pure, Deno-API-free
// date-matched difference of a monthly series minus a quarterly one, the
// quarterly value carried forward to every month until a newer quarter
// publishes — for UNRATE (monthly) minus NROU (quarterly, CBO's own
// noncyclical-unemployment-rate estimate).
//
// NROU is unusual: confirmed live in Phase 0 that it is CBO's own ~10-year-
// FORWARD PROJECTION (its "most recent observation" is a future quarter,
// e.g. 2036, not a lagging real-time estimate), updated only ~once a year
// (its Budget and Economic Outlook, typically Jan/Feb). That shape turns
// out not to need any special-casing here: "most recent quarterly value at
// or before this month" finds the CBO-assigned natural-rate estimate FOR
// that specific quarter (past actual or future projection alike — CBO
// assigns one to every quarter, not just ones already observed), which is
// exactly the comparator UNRATE needs regardless of whether that quarter is
// calendar-future relative to when CBO published it.

export interface Obs {
  date: string;
  value: number;
}

export interface DiffCarryForwardResult {
  current: number;
  previous: number;
  carriedForwardQuarter: string; // the quarterly series' own date actually used for `current`
}

// `monthly` and `quarterly` must both be sorted descending by date. Returns
// null if no quarterly observation exists at or before the two most recent
// monthly dates — never guesses a value for a quarter CBO hasn't assigned
// one to.
export function diffMonthlyMinusQuarterlyCarryForward(
  monthly: Obs[],
  quarterly: Obs[],
): DiffCarryForwardResult | null {
  if (monthly.length < 2 || quarterly.length === 0) return null;
  const sortedQuarterly = [...quarterly].sort((a, b) => b.date.localeCompare(a.date));

  function carriedValue(asOfDate: string): { value: number; quarterDate: string } | undefined {
    const match = sortedQuarterly.find((q) => q.date <= asOfDate);
    return match ? { value: match.value, quarterDate: match.date } : undefined;
  }

  const c0 = carriedValue(monthly[0].date);
  const c1 = carriedValue(monthly[1].date);
  if (!c0 || !c1) return null;

  return {
    current: monthly[0].value - c0.value,
    previous: monthly[1].value - c1.value,
    carriedForwardQuarter: c0.quarterDate,
  };
}
