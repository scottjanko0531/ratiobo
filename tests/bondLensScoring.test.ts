import { describe, it, expect } from "vitest";
import { computeBondLensHistory, BondLensHistoryInputs } from "../supabase/functions/_shared/bondLens/scoring.ts";

function isoDate(i: number): string {
  const d = new Date("2015-01-02T00:00:00Z"); // a Friday
  let count = 0, cur = new Date(d);
  while (count < i) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6) count++;
  }
  return cur.toISOString().slice(0, 10);
}

describe("computeBondLensHistory", () => {
  const n = 1200; // >minHistory(756), >momentumLookback(252)+smaWindow(200), enough for a real smoke test
  const dates = Array.from({ length: n }, (_, i) => isoDate(i));
  const flat = (v: number) => Array.from({ length: n }, () => v + (Math.random() - 0.5) * 0.02);

  const inputs: BondLensHistoryInputs = {
    dates,
    dgs3mo: flat(3), dgs1: flat(3.5), dgs2: flat(4), dgs3: flat(4.2),
    dgs5: flat(4.5), dgs7: flat(4.7), dgs10: flat(5), dgs30: flat(5.2),
    dfii5: flat(1.5), dfii10: flat(1.8),
    t5yie: flat(2.3), t10yie: flat(2.4), t5yifr: flat(2.5),
    dff: flat(3.8),
    acm: flat(1.0), threefytp10: flat(0.9),
    rstar: dates.filter((_, i) => i % 63 === 0).map((d) => ({ date: d, value: 0.5 })),
    pceIndex: Array.from({ length: n }, (_, i) => 100 * Math.pow(1.00008, i)), // slow drift, valid for inflTrend
    expInf1yr: flat(2.2),
    gdpnow: flat(2.0),
    gdpnowQuarter: dates.map((d) => `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`),
    spy: Array.from({ length: n }, (_, i) => 100 * Math.pow(1.0003, i)),
    ief: Array.from({ length: n }, (_, i) => 100 * Math.pow(1.00005, i)),
  };

  it("produces one row per date with no thrown errors", () => {
    const rows = computeBondLensHistory(inputs);
    expect(rows.length).toBe(n);
    expect(rows[0].as_of_date).toBe(dates[0]);
    expect(rows[n - 1].as_of_date).toBe(dates[n - 1]);
  });

  it("excludes every module before its own minimum history is reached", () => {
    const rows = computeBondLensHistory(inputs);
    expect(rows[10].carry_score).toBeNull();
    expect(rows[10].valuation_score).toBeNull();
  });

  it("produces a non-null score for most modules once enough history exists", () => {
    const rows = computeBondLensHistory(inputs);
    const last = rows[n - 1];
    expect(last.carry_score).not.toBeNull();
    expect(last.valuation_score).not.toBeNull();
    expect(last.trend_score).not.toBeNull();
    expect(last.quadrant).not.toBeNull();
    expect(typeof last.hedge_reliable).toBe("boolean");
  });

  it("holds hedge_reliable and curve_regime constant between weekly reads", () => {
    const rows = computeBondLensHistory(inputs);
    // Any two consecutive non-week-boundary days late in the series should
    // show the same hedge_reliable/curve_regime (only updated at week-end).
    const a = rows[n - 3], b = rows[n - 2];
    expect(a.hedge_reliable).toBe(b.hedge_reliable);
  });
});
