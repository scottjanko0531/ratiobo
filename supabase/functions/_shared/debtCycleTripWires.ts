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

// TW2 "auction demand deterioration" lives in _shared/indirectBidder.ts as
// evalAuctionDemandDeterioration (built on the same consolidated
// per-term-trailing-6 calculation the macro card and classifier use) — v2
// Phase 1 found a dead duplicate of this trip-wire still defined here, from
// before that move, still carrying the retired fixed `< 65` threshold.
// Nothing imported this copy (confirmed via grep); removed rather than kept
// as an unused alternate implementation.

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

// TW4 "positive stock-bond correlation regime" (Phase 4 rename — this used
// to be called `fiscal_dominance_confirmed`/evalFiscalDominanceConfirmed,
// but the spec's real fiscal-dominance test is a separate, 4-condition
// check below; renamed per rule 2.1 rather than letting two different
// things share one name). Stock/Bond 90d correlation has stayed positive
// continuously over the trailing ~3 months (90 calendar days) — Treasuries
// have stopped hedging equities for a sustained stretch, not just a noisy
// day or two. `armed` is still gated on that 90-day window (this wire is
// deliberately about "has it been positive for at least a confirming
// stretch," not the streak's full length).
//
// `sinceDate` is a SEPARATE question — "when did this streak actually
// start" — and must NOT be capped at the same 90-day window, or it silently
// creeps forward by ~1 day every single day the condition holds, forever,
// no matter how long the streak has actually run (confirmed live: a streak
// that started 2026-02-20 was showing "since 2026-06-12," ~90 days behind
// the evaluation date, because the old code just reported the window's own
// boundary date). Instead, walk backward through the FULL history the
// caller provides (assumed sorted desc by obs_date, with no row limit that
// would truncate a long-running streak — see update-big-cycle-metrics.ts's
// query) to find the actual first day of the unbroken positive run.
export function evalStockBondCorrPositive(
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

  let sinceDate: string | null = null;
  let ranOutOfHistory = false;
  if (armed) {
    let streakStartIdx = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].corr_90d <= 0) { streakStartIdx = i - 1; break; }
      if (i === rows.length - 1) ranOutOfHistory = true; // never found a negative day — streak may predate available data
    }
    sinceDate = streakStartIdx >= 0 ? rows[streakStartIdx].obs_date : null;
  }

  return {
    armed,
    sinceDate,
    values: { latest: rows[0].corr_90d, windowDays: window.length, sinceDateIsDataFloor: ranOutOfHistory ? 1 : 0 },
  };
}

export interface FiscalDominanceDailyRow {
  date: string;
  realFedFunds: number | null; // condition 2
  cpiYoy: number | null; // condition 4
}

// NEW "fiscal-dominance regime confirmed" (Phase 4b) — not the same test as
// the renamed TW4 above. Arms only when ALL of these hold simultaneously
// for >= `minDays` CONSECUTIVE calendar days, ending today:
//   1. net interest / receipts debt-service-strained gate is armed (v2
//      Phase 3c — the SAME hysteresis gate state as the classifier's
//      debtServiceStrained condition, not a separate raw >20 check)
//   2. real fed funds <= 0
//   3. the Fed is easing, OR Fed BS %GDP is sustained-rising, OR SOMA
//      long-duration is sustained-positive
//   4. CPI YoY > 3%
//
// Conditions 1 and 3 are both evaluated as a CURRENT state (today), not
// re-derived at each of the trailing `minDays`: condition 3 because
// isSustainedRising/isSustainedPositive are themselves already
// multi-week-window trend tests (no other trip-wire in this file re-runs a
// trend test at every historical day either — TW1 evaluates WALCL's trend
// as a current snapshot the same way); condition 1 because it is itself
// now a persistence-gated hysteresis read (v2 Phase 3b) — re-deriving a
// second, independent persistence check on top of an already-persistent
// gate would double-count the same requirement, not add a new one. Only
// conditions 2/4 are the per-day persistence check below, since each is a
// simple raw threshold on an already-daily series with no gating of its
// own.
//
// `dailyRows` must be sorted descending by date and date-joined across the
// two source series (a day only counts toward the streak if BOTH have a
// value — a day missing even one series' data breaks the streak rather
// than silently skipping it, so a real gap can't be papered over).
export function evalFiscalDominanceConfirmed(
  dailyRows: FiscalDominanceDailyRow[],
  condition3Now: boolean,
  debtServiceStrainedNow: boolean,
  minDays = 60,
): TripWireResult {
  let streak = 0;
  for (const r of dailyRows) {
    if (
      r.realFedFunds != null && r.realFedFunds <= 0 &&
      r.cpiYoy != null && r.cpiYoy > 3
    ) {
      streak++;
    } else break;
  }
  const streakHolds = streak >= minDays;
  const armed = streakHolds && condition3Now && debtServiceStrainedNow;
  const sinceDate = armed ? dailyRows[streak - 1]?.date ?? null : null;
  return {
    armed,
    sinceDate,
    values: {
      streakDays: streak,
      condition1DebtServiceStrained: debtServiceStrainedNow ? 1 : 0,
      condition3: condition3Now ? 1 : 0,
      realFedFundsLatest: dailyRows[0]?.realFedFunds ?? null,
      cpiYoyLatest: dailyRows[0]?.cpiYoy ?? null,
    },
  };
}
