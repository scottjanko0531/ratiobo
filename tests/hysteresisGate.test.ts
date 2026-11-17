import { describe, it, expect } from "vitest";
import { hysteresisGate } from "../supabase/functions/_shared/hysteresisGate.ts";
import type { WeeklyPoint } from "../supabase/functions/_shared/debtCycleClassifier.ts";

// v2 Phase 3a (debt-metrics-integrity-v2 spec). Generic on=20.5/off=19.5/
// persistMonths=2 thresholds throughout, matching DEBT_SERVICE_STRAINED_GATE
// (_shared/statusThresholds.ts) -- this file tests the pure mechanics, not
// that specific card, so it doesn't import the constant directly.
const OPTS = { on: 20.5, off: 19.5, persistMonths: 2 };

function daysAgo(n: number): string {
  const d = new Date("2026-11-17T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Builds a most-recent-first WeeklyPoint series, one "month" per value,
// spaced 30 days apart -- distinct enough that dedupeConsecutive never
// accidentally merges two different months.
function monthlySeries(valuesNewestFirst: number[]): WeeklyPoint[] {
  return valuesNewestFirst.map((value, i) => ({ date: daysAgo(i * 30), value }));
}

describe("hysteresisGate", () => {
  it("threshold crossing WITHOUT persistence does not flip the gate", () => {
    // Oldest-first: 19.0,19.1,19.2,19.3,19.4,21.0 -- a single month above
    // `on`, preceded by a long off run. Every adjacent pair differs slightly
    // so dedupeConsecutive can't accidentally merge two different months
    // (see the dedicated dedup test below). Only one above-on reading ever
    // occurs, never two in a row, so the gate must stay off.
    const series = monthlySeries([21.0, 19.4, 19.3, 19.2, 19.1, 19.0]); // newest-first
    const result = hysteresisGate(series, OPTS);
    expect(result.armed).toBe(false);
    expect(result.insufficientHistory).toBe(false);
  });

  it("a PERSISTENT crossing (2 consecutive months above `on`) flips the gate armed", () => {
    // Oldest-first: 19.0,19.1,19.2,21.0,21.1 -- the last two consecutive
    // months clear `on`.
    const series = monthlySeries([21.1, 21.0, 19.2, 19.1, 19.0]); // newest-first
    const result = hysteresisGate(series, OPTS);
    expect(result.armed).toBe(true);
  });

  it("a dip into the dead band between on/off does NOT flip an armed gate back off", () => {
    // Oldest-first: 21.0,21.1 (arms) then 20.0 (dead band: not > on, not <
    // off -- moves neither streak, so the prior armed state must hold).
    const series = monthlySeries([20.0, 21.1, 21.0]); // newest-first
    const result = hysteresisGate(series, OPTS);
    expect(result.armed).toBe(true);
  });

  it("disarm path: a PERSISTENT drop below `off` after being armed flips the gate back off (rule 7)", () => {
    // Oldest-first: 21.0,21.1 (arms), then 19.1,19.0 (2 consecutive below
    // off -- disarms). Each adjacent pair differs slightly so dedup can't
    // collapse either run and accidentally destroy the persistence signal.
    const series = monthlySeries([19.0, 19.1, 21.1, 21.0]); // newest-first
    const result = hysteresisGate(series, OPTS);
    expect(result.armed).toBe(false);
  });

  describe("insufficient history (v2 Phase 3 investigation)", () => {
    it("zero readings: armed=false, insufficientHistory=true, no fallback value to compare", () => {
      const result = hysteresisGate([], OPTS);
      expect(result).toEqual({ armed: false, insufficientHistory: true, monthsAvailable: 0, latest: null });
    });

    it("one reading above `on`: bootstrap fallback arms (single reading must clear the STRICTER bound)", () => {
      const series = monthlySeries([20.7]);
      const result = hysteresisGate(series, OPTS);
      expect(result.insufficientHistory).toBe(true);
      expect(result.monthsAvailable).toBe(1);
      expect(result.armed).toBe(true);
    });

    it("one reading in the dead band (above off, below on): bootstrap fallback does NOT arm", () => {
      // This is the live debtServiceStrained case as of 2026-11-17: MTS
      // basis has exactly 1 distinct reading (19.821), which is above
      // off=19.5 but below on=20.5 -- the bootstrap fallback only arms on
      // clearing the stricter `on` bound, so this must read not-armed.
      const series = monthlySeries([19.821]);
      const result = hysteresisGate(series, OPTS);
      expect(result.insufficientHistory).toBe(true);
      expect(result.monthsAvailable).toBe(1);
      expect(result.armed).toBe(false);
    });

    it("one reading below `off`: bootstrap fallback does not arm either", () => {
      const series = monthlySeries([18.0]);
      const result = hysteresisGate(series, OPTS);
      expect(result.insufficientHistory).toBe(true);
      expect(result.armed).toBe(false);
    });

    it("exactly persistMonths readings is enough -- no longer insufficientHistory", () => {
      const series = monthlySeries([21.1, 21.0]); // 2 distinct readings, persistMonths=2
      const result = hysteresisGate(series, OPTS);
      expect(result.insufficientHistory).toBe(false);
      expect(result.monthsAvailable).toBe(2);
      expect(result.armed).toBe(true);
    });
  });

  it("dedupes repeated daily snapshot values into one reading per month before evaluating persistence", () => {
    // Simulates the real MTS cadence: the same monthly figure gets
    // snapshotted every day until the next month's release. 45 identical
    // daily rows at 21 (above `on`) must collapse to ONE distinct reading,
    // not 45 -- so by itself (insufficient history, only 1 distinct value)
    // it must NOT read as a confirmed persistMonths=2 arm.
    const dailyRepeats: WeeklyPoint[] = Array.from({ length: 45 }, (_, i) => ({ date: daysAgo(i), value: 21 }));
    const result = hysteresisGate(dailyRepeats, OPTS);
    expect(result.monthsAvailable).toBe(1);
    expect(result.insufficientHistory).toBe(true);
  });

  it("latest reflects the most recent distinct reading", () => {
    const series = monthlySeries([19.821, 24.593, 24.439]); // newest-first
    const result = hysteresisGate(series, OPTS);
    expect(result.latest).toBe(19.821);
  });
});
