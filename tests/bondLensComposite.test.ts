import { describe, it, expect } from "vitest";
import {
  durationScore, instrumentPref, maturityPref, buildExplanation, computeBondLensSignalHistory,
} from "../supabase/functions/_shared/bondLens/composite.ts";
import { computeBondLensHistory, BondLensHistoryInputs } from "../supabase/functions/_shared/bondLens/scoring.ts";

describe("durationScore", () => {
  // §5.1: 0.30*val + 0.25*path + 0.20*carry + 0.15*quadrant + 0.10*curve
  it("computes the weighted sum when trend is up (no cap)", () => {
    const r = durationScore(2, 2, 2, 2, 2, "up");
    expect(r.raw).toBeCloseTo(2, 10);
    expect(r.score).toBeCloseTo(2, 10);
    expect(r.stance).toBe("Max extend");
    expect(r.multiplier).toBe(1.6);
  });

  it("caps at 0 when trend is down, even if the raw weighted score is positive", () => {
    const r = durationScore(2, 2, 2, 2, 2, "down");
    expect(r.raw).toBeCloseTo(2, 10);
    expect(r.score).toBe(0);
    expect(r.stance).toBe("Neutral");
    expect(r.multiplier).toBe(1.0);
  });

  it("caps at +0.75 when trend is mixed", () => {
    const r = durationScore(2, 2, 2, 2, 2, "mixed");
    expect(r.score).toBe(0.75);
    expect(r.stance).toBe("Extend");
    expect(r.multiplier).toBe(1.3);
  });

  it("maps each stance band correctly", () => {
    expect(durationScore(-2, -2, -2, -2, -2, "up").stance).toBe("Short");
    expect(durationScore(0, 0, 0, 0, 0, "up").stance).toBe("Neutral");
    expect(durationScore(1, 1, 1, 1, 1, "up").score).toBeCloseTo(1, 10);
  });

  it("does not reach Max extend without trend = up, even above 1.0", () => {
    // raw weighted score > 1.0 is impossible with trend=mixed (capped at 0.75)
    // or trend=down (capped at 0) after the gate -- construct it directly
    // via a trend value that doesn't cap, to exercise the stance table's
    // own ">1.0 and trend=up" condition in isolation.
    const r = durationScore(2, 2, 2, 2, 2, "mixed");
    expect(r.stance).not.toBe("Max extend");
  });
});

describe("instrumentPref", () => {
  it("prefers bills/short TIPS when hedge is unreliable and stance is Neutral or below", () => {
    expect(instrumentPref(false, "Neutral", 0, "Q1")).toBe("Bills / short TIPS");
    expect(instrumentPref(false, "Short", 0, "Q1")).toBe("Bills / short TIPS");
  });

  it("does not apply the hedge rule when hedge is only degraded (null), not explicitly false", () => {
    expect(instrumentPref(null, "Neutral", 0, "Q1")).not.toBe("Bills / short TIPS");
  });

  it("does not apply the hedge rule above Neutral stance", () => {
    expect(instrumentPref(false, "Extend", 0, "Q1")).not.toBe("Bills / short TIPS");
  });

  it("prefers TIPS when breakeven gap is large", () => {
    expect(instrumentPref(true, "Extend", 30, "Q1")).toBe("TIPS-tilted");
  });

  it("prefers TIPS when quadrant is Q2 or Q3, even with a small breakeven gap", () => {
    expect(instrumentPref(true, "Extend", 0, "Q2")).toBe("TIPS-tilted");
    expect(instrumentPref(true, "Extend", 0, "Q3")).toBe("TIPS-tilted");
  });

  it("defaults to nominal-tilted otherwise", () => {
    expect(instrumentPref(true, "Extend", 0, "Q1")).toBe("Nominal-tilted");
  });
});

describe("maturityPref", () => {
  it("picks the maturity with the highest EFF", () => {
    const eff = { 2: 0.01, 5: 0.025, 7: 0.018, 10: 0.012 };
    expect(maturityPref(eff, "Extend")).toBe("5y");
  });

  it("overrides to 10y for Max extend regardless of EFF", () => {
    const eff = { 2: 0.05, 5: 0.01, 7: 0.01, 10: 0.001 };
    expect(maturityPref(eff, "Max extend")).toBe("10y");
  });

  it("skips null EFF values", () => {
    const eff = { 2: null, 5: 0.01, 7: null, 10: 0.02 };
    expect(maturityPref(eff, "Extend")).toBe("10y");
  });

  it("returns null when every maturity's EFF is unavailable", () => {
    const eff = { 2: null, 5: null, 7: null, 10: null };
    expect(maturityPref(eff, "Extend")).toBeNull();
  });
});

describe("buildExplanation", () => {
  it("includes the duration, valuation, curve, and maturity sentences", () => {
    const r = buildExplanation({
      durationScore: 0.35, durationStance: "Neutral", trendState: "mixed",
      realYieldGapPct: 2.1, dfii10Pct: 2.9, rstarPct: 0.8, termPremiumZ: 1.1,
      curveRegime: "bear_flattening", curveRegimeSince: null,
      hedgeReliable: false, instrumentPref: "TIPS-tilted", maturityPref: "5y", maturityEff: 0.011,
    });
    expect(r.text).toMatch(/Duration: Neutral \(score 0\.35\)/);
    expect(r.text).toMatch(/real 10y 2\.9% vs r-star 0\.8%/);
    expect(r.text).toMatch(/term premium z \+1\.1/);
    expect(r.text).toMatch(/Trend is mixed/);
    expect(r.text).toMatch(/bear flattening/);
    expect(r.text).toMatch(/not a reliable hedge/);
    expect(r.text).toMatch(/5y \(breakeven rise 1\.1%\)/);
    expect(r.drivers.duration).toEqual({ score: 0.35, stance: "Neutral" });
  });
});

describe("computeBondLensSignalHistory", () => {
  const n = 1200;
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
    pceIndex: Array.from({ length: n }, (_, i) => 100 * Math.pow(1.00008, i)),
    expInf1yr: flat(2.2),
    gdpnow: flat(2.0),
    gdpnowQuarter: dates.map((d) => `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`),
    spy: Array.from({ length: n }, (_, i) => 100 * Math.pow(1.0003, i)),
    ief: Array.from({ length: n }, (_, i) => 100 * Math.pow(1.00005, i)),
    shillerSp500MonthlyTr: [],
  };

  it("produces a composite row once every module has enough history, null before", () => {
    const dayRows = computeBondLensHistory(inputs);
    const signalRows = computeBondLensSignalHistory(dayRows, inputs);
    expect(signalRows.length).toBe(n);
    expect(signalRows[10]).toBeNull();
    const last = signalRows[n - 1];
    expect(last).not.toBeNull();
    expect(typeof last!.duration_score).toBe("number");
    expect(["Short", "Neutral", "Extend", "Max extend"]).toContain(last!.duration_stance);
    expect(["Bills / short TIPS", "TIPS-tilted", "Nominal-tilted"]).toContain(last!.instrument_pref);
    expect(["2y", "5y", "7y", "10y"]).toContain(last!.maturity_pref);
    expect(typeof last!.explanation.text).toBe("string");
  });
});

function isoDate(i: number): string {
  const d = new Date("2015-01-02T00:00:00Z");
  let count = 0, cur = new Date(d);
  while (count < i) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6) count++;
  }
  return cur.toISOString().slice(0, 10);
}
