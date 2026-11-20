// Scott's live-site-issue follow-up (S&P 500/GDP → real Buffett Indicator).
// The Fed's Z.1 Financial Accounts (corporate equities market value) only
// releases quarterly, with a multi-month lag -- a card backed directly by
// it would only ever step once per quarter. This scales the most recent
// real quarterly print forward by a daily market index's own percentage
// change since that quarter's end, so the card can update daily/live
// between releases without fabricating a new quarterly data point.

export interface Obs {
  date: string;
  value: number;
}

function latestOnOrBefore(series: Obs[], cutoff: string): Obs | null {
  let result: Obs | null = null;
  for (const o of series) {
    if (o.date <= cutoff) result = o;
    else break;
  }
  return result;
}

// The last calendar day of the quarter a FRED quarterly observation
// (dated by quarter START, e.g. "2026-04-01" = Q2 2026, per FRED's own
// convention) actually represents.
export function quarterEndDate(quarterStartDate: string): string {
  const d = new Date(quarterStartDate + "T00:00:00Z");
  const nextQuarterStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1));
  nextQuarterStart.setUTCDate(nextQuarterStart.getUTCDate() - 1);
  return nextQuarterStart.toISOString().slice(0, 10);
}

export interface BridgeResult {
  bridgedValue: number;
  z1ObsDate: string;
  quarterEndDate: string;
  marketLevelAtQuarterEnd: number;
  marketLevelAsOf: number;
}

// `marketObs` must be sorted ascending (same convention as every other
// FRED fetch in this codebase). Returns null if the market series doesn't
// cover either reference date, or if the quarter-end level is zero. When
// `asOfDate` falls ON the quarter's own end date (the historical-backfill
// case -- each real quarterly print evaluated at its own quarter end),
// the bridge factor is exactly 1 and `bridgedValue === z1Value`, by
// construction -- this is the same methodology applied retroactively,
// not a special case.
export function bridgeQuarterlyByMarketChange(
  z1ObsDate: string, z1Value: number, marketObs: Obs[], asOfDate: string,
): BridgeResult | null {
  const qEnd = quarterEndDate(z1ObsDate);
  const atQuarterEnd = latestOnOrBefore(marketObs, qEnd);
  const atAsOf = latestOnOrBefore(marketObs, asOfDate);
  if (!atQuarterEnd || !atAsOf || atQuarterEnd.value === 0) return null;
  const bridgedValue = z1Value * (atAsOf.value / atQuarterEnd.value);
  return {
    bridgedValue, z1ObsDate, quarterEndDate: qEnd,
    marketLevelAtQuarterEnd: atQuarterEnd.value, marketLevelAsOf: atAsOf.value,
  };
}
