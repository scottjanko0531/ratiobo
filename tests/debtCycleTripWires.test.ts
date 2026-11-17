import { describe, it, expect } from "vitest";
import {
  evalMp2OnsetWatch,
  evalStockBondCorrPositive,
  evalDollarDivergenceWidening,
  evalFiscalDominanceConfirmed,
  type FiscalDominanceDailyRow,
} from "../supabase/functions/_shared/debtCycleTripWires.ts";
import type { WeeklyPoint } from "../supabase/functions/_shared/debtCycleClassifier.ts";

function daysAgo(n: number): string {
  const d = new Date("2026-08-21T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe("evalMp2OnsetWatch", () => {
  it("armed: 2 consecutive positive WALCL deltas while CPI YoY > 2.5%", () => {
    const walcl: WeeklyPoint[] = [
      { date: daysAgo(0), value: 21.2 },
      { date: daysAgo(7), value: 21.0 },
      { date: daysAgo(14), value: 20.7 },
    ];
    const result = evalMp2OnsetWatch(walcl, 3.0);
    expect(result.armed).toBe(true);
    expect(result.sinceDate).toBe(daysAgo(14));
  });

  it("not armed: CPI YoY at or below 2.5% even with a rising WALCL trend", () => {
    const walcl: WeeklyPoint[] = [
      { date: daysAgo(0), value: 21.2 },
      { date: daysAgo(7), value: 21.0 },
      { date: daysAgo(14), value: 20.7 },
    ];
    const result = evalMp2OnsetWatch(walcl, 2.1);
    expect(result.armed).toBe(false);
  });
});

// v2 Phase 1: evalAuctionDemandDeterioration's tests moved to
// tests/indirectBidder.test.ts, alongside the rest of _shared/indirectBidder.ts's
// coverage (the function's signature changed from (rows, n) to
// (rows, thresholds, trailingYears) as part of the hysteresis rewrite — see
// docs/specs/debt-metrics-integrity-v2.md Phase 1).

describe("evalDollarDivergenceWidening", () => {
  it("armed: 30Y yield at a cycle high while DXY's 3-month change is flat-to-negative", () => {
    const t30y: WeeklyPoint[] = [
      { date: daysAgo(0), value: 5.25 },
      { date: daysAgo(30), value: 5.1 },
      { date: daysAgo(200), value: 5.0 },
    ];
    const result = evalDollarDivergenceWidening(t30y, -0.5);
    expect(result.armed).toBe(true);
  });

  it("not armed: DXY rising in sympathy even at a 30Y cycle high", () => {
    const t30y: WeeklyPoint[] = [
      { date: daysAgo(0), value: 5.25 },
      { date: daysAgo(30), value: 5.1 },
      { date: daysAgo(200), value: 5.0 },
    ];
    const result = evalDollarDivergenceWidening(t30y, 1.2);
    expect(result.armed).toBe(false);
  });
});

// Phase 4b rename: fiscal_dominance_confirmed -> stock_bond_corr_positive.
// Same logic, same function body, just renamed (evalFiscalDominanceConfirmed
// -> evalStockBondCorrPositive) — these are the SAME test cases that existed
// before the rename, passing unchanged under the new name.
describe("evalStockBondCorrPositive", () => {
  it("armed: stock/bond correlation stays positive across the trailing 90 days", () => {
    const rows = Array.from({ length: 91 }, (_, i) => ({ obs_date: daysAgo(i), corr_90d: 0.1 + i * 0.001 }));
    const result = evalStockBondCorrPositive(rows);
    expect(result.armed).toBe(true);
  });

  it("not armed: correlation dips negative at some point within the trailing 90 days", () => {
    const rows = Array.from({ length: 91 }, (_, i) => ({ obs_date: daysAgo(i), corr_90d: i === 45 ? -0.05 : 0.1 }));
    const result = evalStockBondCorrPositive(rows);
    expect(result.armed).toBe(false);
  });

  it("sinceDate reflects the streak's true start, not the 90-day window boundary, when the streak runs longer than 90 days", () => {
    // 200 days of history: negative through day 150 (oldest), positive from
    // day 149 down to today (0) — a ~150-day unbroken streak, well past the
    // 90-day window this wire's `armed` check uses. The old implementation
    // reported window[window.length-1].obs_date here (~daysAgo(90)); the
    // fix must report the streak's real start instead.
    const rows = Array.from({ length: 201 }, (_, i) => ({
      obs_date: daysAgo(i),
      corr_90d: i <= 149 ? 0.1 : -0.05,
    }));
    const result = evalStockBondCorrPositive(rows);
    expect(result.armed).toBe(true);
    expect(result.sinceDate).toBe(daysAgo(149));
    expect(result.sinceDate).not.toBe(daysAgo(90));
  });

  it("flags sinceDateIsDataFloor when the positive streak runs to the edge of available history", () => {
    // Every row provided is positive — the true onset predates the data we
    // have, so sinceDate should fall back to the oldest available row and
    // be flagged as a floor, not presented as if it were the real start.
    const rows = Array.from({ length: 95 }, (_, i) => ({ obs_date: daysAgo(i), corr_90d: 0.1 }));
    const result = evalStockBondCorrPositive(rows);
    expect(result.armed).toBe(true);
    expect(result.sinceDate).toBe(daysAgo(94));
    expect(result.values.sinceDateIsDataFloor).toBe(1);
  });
});

// Phase 4b: the NEW fiscal_dominance_confirmed. Arms only when conditions
// 1/2/4 have ALL held simultaneously for >= 60 consecutive days AND
// condition 3 holds today.
// v2 Phase 3c: condition 1 (net interest/receipts) is no longer a per-day
// raw >20 check on its own history -- it's wired to the SAME
// debtServiceStrained hysteresis gate state the classifier computes
// (_shared/hysteresisGate.ts), passed in here as debtServiceStrainedNow,
// the same way condition 3 is already a current-only read rather than a
// per-day one. The per-day streak below now only covers conditions 2/4.
describe("evalFiscalDominanceConfirmed (Phase 4b, v2 Phase 3c rewiring)", () => {
  function buildDailyRows(n: number, overrides: Partial<FiscalDominanceDailyRow> = {}): FiscalDominanceDailyRow[] {
    return Array.from({ length: n }, (_, i) => ({
      date: daysAgo(i),
      realFedFunds: -0.5,
      cpiYoy: 3.5,
      ...overrides,
    }));
  }

  it("armed: conditions 2/4 held for 65 consecutive days, condition 3 true today, and the debt-service-strained gate armed (synthetic — live data is unarmed right now)", () => {
    const rows = buildDailyRows(65);
    const result = evalFiscalDominanceConfirmed(rows, true, true, 60);
    expect(result.armed).toBe(true);
    expect(result.values.streakDays).toBe(65);
    expect(result.sinceDate).toBe(daysAgo(64));
  });

  it("not armed: condition 3 (Fed posture) is false today even though 2/4 have held 65 days and the gate is armed", () => {
    const rows = buildDailyRows(65);
    const result = evalFiscalDominanceConfirmed(rows, false, true, 60);
    expect(result.armed).toBe(false);
    expect(result.values.streakDays).toBe(65);
  });

  it("not armed: condition 1 — the debt-service-strained gate reads OFF today even though 2/4 have held 65 days and condition 3 is true, proving condition 1 actually gates the result rather than always passing now", () => {
    const rows = buildDailyRows(65);
    const result = evalFiscalDominanceConfirmed(rows, true, false, 60);
    expect(result.armed).toBe(false);
    expect(result.values.streakDays).toBe(65);
    expect(result.values.condition1DebtServiceStrained).toBe(0);
  });

  it("not armed: the 2/4 streak is only 59 days, one short of the 60-day minimum", () => {
    const rows = buildDailyRows(59);
    const result = evalFiscalDominanceConfirmed(rows, true, true, 60);
    expect(result.armed).toBe(false);
    expect(result.values.streakDays).toBe(59);
  });

  it("not armed: real fed funds goes positive partway through an otherwise-qualifying window, breaking the streak", () => {
    const rows = buildDailyRows(65);
    rows[10].realFedFunds = 0.3; // breaks the streak 10 days back from today
    const result = evalFiscalDominanceConfirmed(rows, true, true, 60);
    expect(result.armed).toBe(false);
    expect(result.values.streakDays).toBe(10);
  });

  it("not armed: a day missing even one of the two series breaks the streak rather than being skipped", () => {
    const rows = buildDailyRows(65);
    rows[5].cpiYoy = null;
    const result = evalFiscalDominanceConfirmed(rows, true, true, 60);
    expect(result.armed).toBe(false);
    expect(result.values.streakDays).toBe(5);
  });

  it("live reality right now: the debt-service-strained gate reads not-armed (v2 Phase 3 bootstrap — see hysteresisGate.test.ts), so this trip-wire can't arm regardless of conditions 2/3/4", () => {
    const rows = buildDailyRows(65);
    const result = evalFiscalDominanceConfirmed(rows, true, false, 60);
    expect(result.armed).toBe(false);
  });
});
