import { describe, it, expect } from "vitest";
import {
  evalMp2OnsetWatch,
  evalAuctionDemandDeterioration,
  evalDollarDivergenceWidening,
  evalFiscalDominanceConfirmed,
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

describe("evalAuctionDemandDeterioration", () => {
  it("armed: indirect bidder share below 65% across the entire trailing window", () => {
    const rows = [60, 58, 62, 55, 59, 61].map((v, i) => ({ auction_date: daysAgo(i * 14), indirect_share_pct: v }));
    const result = evalAuctionDemandDeterioration(rows, 6);
    expect(result.armed).toBe(true);
  });

  it("not armed: at least one auction in the window closed above 65%", () => {
    const rows = [60, 58, 66, 55, 59, 61].map((v, i) => ({ auction_date: daysAgo(i * 14), indirect_share_pct: v }));
    const result = evalAuctionDemandDeterioration(rows, 6);
    expect(result.armed).toBe(false);
  });
});

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

describe("evalFiscalDominanceConfirmed", () => {
  it("armed: stock/bond correlation stays positive across the trailing 90 days", () => {
    const rows = Array.from({ length: 91 }, (_, i) => ({ obs_date: daysAgo(i), corr_90d: 0.1 + i * 0.001 }));
    const result = evalFiscalDominanceConfirmed(rows);
    expect(result.armed).toBe(true);
  });

  it("not armed: correlation dips negative at some point within the trailing 90 days", () => {
    const rows = Array.from({ length: 91 }, (_, i) => ({ obs_date: daysAgo(i), corr_90d: i === 45 ? -0.05 : 0.1 }));
    const result = evalFiscalDominanceConfirmed(rows);
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
    const result = evalFiscalDominanceConfirmed(rows);
    expect(result.armed).toBe(true);
    expect(result.sinceDate).toBe(daysAgo(149));
    expect(result.sinceDate).not.toBe(daysAgo(90));
  });

  it("flags sinceDateIsDataFloor when the positive streak runs to the edge of available history", () => {
    // Every row provided is positive — the true onset predates the data we
    // have, so sinceDate should fall back to the oldest available row and
    // be flagged as a floor, not presented as if it were the real start.
    const rows = Array.from({ length: 95 }, (_, i) => ({ obs_date: daysAgo(i), corr_90d: 0.1 }));
    const result = evalFiscalDominanceConfirmed(rows);
    expect(result.armed).toBe(true);
    expect(result.sinceDate).toBe(daysAgo(94));
    expect(result.values.sinceDateIsDataFloor).toBe(1);
  });
});
