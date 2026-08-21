// Pure, Deno-API-free trip-wire evaluators for the Debt Cycle Position Check
// panel. These are the doc's four explicitly-named early-warning signals —
// deliberately NOT the same tests as the stage classifier's own internal
// gates (debtCycleClassifier.ts): trip-wires are meant to fire earlier and
// on a single/short streak, while the classifier requires a longer confirmed
// trend before actually moving the stage. Lives in _shared/ for the same
// reason as the classifier: importable by both the edge function and Vitest.

import { dedupeConsecutive, WeeklyPoint } from "./debtCycleClassifier.ts";

export interface TripWireResult {
  armed: boolean;
  sinceDate: string | null;
  values: Record<string, number | null>;
}

// TW1 "MP2 onset watch": Fed Balance Sheet % GDP shows 2 consecutive
// positive print-to-print deltas (turning up off a flat/falling base) while
// CPI YoY is running above 2.5% at the same time — an early signal that
// fresh QE may be starting into a still-inflationary backdrop.
export function evalMp2OnsetWatch(walclPrints: WeeklyPoint[], cpiYoy: number | null): TripWireResult {
  const distinct = dedupeConsecutive(walclPrints).slice(0, 3);
  if (distinct.length < 3 || cpiYoy == null) {
    return { armed: false, sinceDate: null, values: { walclLatest: distinct[0]?.value ?? null, cpiYoy } };
  }
  const [latest, prev, prev2] = distinct;
  const armed = latest.value - prev.value > 0 && prev.value - prev2.value > 0 && cpiYoy > 2.5;
  return {
    armed,
    sinceDate: armed ? prev2.date : null,
    values: { walclLatest: latest.value, walclPrev: prev.value, walclPrev2: prev2.value, cpiYoy },
  };
}

// TW2 "auction demand deterioration": Indirect Bidder Share (10Y/30Y) has
// failed to close back above ~65% for the trailing `n` auctions — a
// persistent failure to recover, not a single weak print.
export function evalAuctionDemandDeterioration(
  rows: { auction_date: string; indirect_share_pct: number }[],
  n = 6,
): TripWireResult {
  const window = rows.slice(0, n);
  if (!window.length) return { armed: false, sinceDate: null, values: { trailingAvg: null, latest: null } };
  const armed = window.every((r) => r.indirect_share_pct < 65);
  const trailingAvg = window.reduce((s, r) => s + r.indirect_share_pct, 0) / window.length;
  return {
    armed,
    sinceDate: armed ? window[window.length - 1].auction_date : null,
    values: { trailingAvg, latest: window[0].indirect_share_pct },
  };
}

// TW3 "dollar confidence divergence widening": 30Y yield sits at a new cycle
// high (its own trailing-window max) while DXY's concurrent 3-month change
// is flat-to-negative — rates pushing higher without the dollar confirming.
export function evalDollarDivergenceWidening(
  t30ySeries: WeeklyPoint[],
  dxyChange3mPct: number | null,
): TripWireResult {
  if (!t30ySeries.length) {
    return { armed: false, sinceDate: null, values: { t30yLatest: null, t30yCycleMax: null, dxyChange3mPct } };
  }
  const latest = t30ySeries[0];
  const cycleMax = Math.max(...t30ySeries.map((p) => p.value));
  const isCycleHigh = latest.value >= cycleMax;
  const armed = isCycleHigh && dxyChange3mPct != null && dxyChange3mPct <= 0;
  return {
    armed,
    sinceDate: armed ? latest.date : null,
    values: { t30yLatest: latest.value, t30yCycleMax: cycleMax, dxyChange3mPct },
  };
}

// TW4 "fiscal-dominance regime confirmed": Stock/Bond 90d correlation has
// stayed positive continuously over the trailing ~3 months (90 calendar
// days) — Treasuries have stopped hedging equities for a sustained stretch,
// not just a noisy day or two.
export function evalFiscalDominanceConfirmed(
  rows: { obs_date: string; corr_90d: number }[],
): TripWireResult {
  if (!rows.length) return { armed: false, sinceDate: null, values: { latest: null } };
  const latestDate = new Date(rows[0].obs_date + "T00:00:00Z");
  const cutoff = new Date(latestDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const window = rows.filter((r) => r.obs_date >= cutoffStr);
  if (!window.length) return { armed: false, sinceDate: null, values: { latest: rows[0].corr_90d } };
  const armed = window.every((r) => r.corr_90d > 0);
  return {
    armed,
    sinceDate: armed ? window[window.length - 1].obs_date : null,
    values: { latest: rows[0].corr_90d, windowDays: window.length },
  };
}
