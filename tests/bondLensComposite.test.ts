import { describe, it, expect } from "vitest";
import {
  durationScore, instrumentPref, maturityPref, buildExplanation, computeBondLensSignalHistory,
} from "../supabase/functions/_shared/bondLens/composite.ts";
import { computeBondLensHistory, BondLensHistoryInputs } from "../supabase/functions/_shared/bondLens/scoring.ts";

describe("durationScore", () => {
  // §5.1 v3: duration_score = valuation_score alone, no other module, no
  // trend gate, capped at Extend (1.3x) -- Phase E's decision
  // (docs/specs/bond-lens-phase-e-report.md).
  it("passes valuation_score through unchanged as the score", () => {
    expect(durationScore(0.35).score).toBeCloseTo(0.35, 10);
    expect(durationScore(-1.2).score).toBeCloseTo(-1.2, 10);
  });

  it("maps each stance band correctly, with no Max-extend band", () => {
    expect(durationScore(-2).stance).toBe("Short");
    expect(durationScore(-0.75).stance).toBe("Neutral"); // boundary: strictly < -0.75 is Short, so exactly -0.75 lands in Neutral
    expect(durationScore(0).stance).toBe("Neutral");
    expect(durationScore(0.5).stance).toBe("Neutral");
    expect(durationScore(0.51).stance).toBe("Extend");
    expect(durationScore(2).stance).toBe("Extend"); // capped -- no band above Extend exists anymore
  });

  it("caps the multiplier at 1.3x (Extend) regardless of how high the score goes", () => {
    expect(durationScore(1.5).multiplier).toBe(1.3);
    expect(durationScore(5).multiplier).toBe(1.3);
  });

  it("multiplier bands: 0.5x Short, 1.0x Neutral, 1.3x Extend", () => {
    expect(durationScore(-2).multiplier).toBe(0.5);
    expect(durationScore(0).multiplier).toBe(1.0);
    expect(durationScore(1).multiplier).toBe(1.3);
  });
});

describe("instrumentPref", () => {
  it("prefers bills/short TIPS when hedge is unreliable and stance is Neutral or below", () => {
    expect(instrumentPref(false, "Neutral", 0, "Q1")).toBe("bills_short_tips");
    expect(instrumentPref(false, "Short", 0, "Q1")).toBe("bills_short_tips");
  });

  it("does not apply the hedge rule when hedge is only degraded (null), not explicitly false", () => {
    expect(instrumentPref(null, "Neutral", 0, "Q1")).not.toBe("bills_short_tips");
  });

  it("does not apply the hedge rule above Neutral stance", () => {
    expect(instrumentPref(false, "Extend", 0, "Q1")).not.toBe("bills_short_tips");
  });

  it("prefers TIPS when breakeven gap is large", () => {
    expect(instrumentPref(true, "Extend", 30, "Q1")).toBe("tips_tilted");
  });

  it("prefers TIPS when quadrant is Q2 or Q3, even with a small breakeven gap", () => {
    expect(instrumentPref(true, "Extend", 0, "Q2")).toBe("tips_tilted");
    expect(instrumentPref(true, "Extend", 0, "Q3")).toBe("tips_tilted");
  });

  it("defaults to nominal-tilted otherwise", () => {
    expect(instrumentPref(true, "Extend", 0, "Q1")).toBe("nominal_tilted");
  });
});

describe("maturityPref", () => {
  // v3: no stance param anymore -- the old "Max extend overrides to 10y"
  // rule is gone along with the Max-extend stance itself.
  it("picks the maturity with the highest EFF", () => {
    const eff = { 2: 0.01, 5: 0.025, 7: 0.018, 10: 0.012 };
    expect(maturityPref(eff)).toBe("5y");
  });

  it("skips null EFF values", () => {
    const eff = { 2: null, 5: 0.01, 7: null, 10: 0.02 };
    expect(maturityPref(eff)).toBe("10y");
  });

  it("returns \"bills\" when every maturity's EFF is unavailable", () => {
    const eff = { 2: null, 5: null, 7: null, 10: null };
    expect(maturityPref(eff)).toBe("bills");
  });

  it("returns \"bills\" when every available EFF is non-positive (inverted curve)", () => {
    const eff = { 2: -0.1, 5: -0.2, 7: null, 10: -0.05 };
    expect(maturityPref(eff)).toBe("bills");
  });
});

describe("buildExplanation", () => {
  const maturityTable = {
    2: { BE: 0.01, EFF: 0.5 }, 5: { BE: 0.012, EFF: 0.85 }, 7: { BE: 0.011, EFF: 0.6 }, 10: { BE: 0.013, EFF: 0.3 },
  };

  it("includes the duration, valuation, curve, and maturity sentences", () => {
    const r = buildExplanation({
      durationScore: 0.35,
      durationStance: "Neutral", trendState: "mixed",
      realYieldGapPct: 2.1, dfii10Pct: 2.9, rstarPct: 0.8, termPremiumZ: 1.1,
      curveRegime: "bear_flattening", curveRegimeSince: null,
      hedgeReliable: false, instrumentPref: "tips_tilted", maturityPref: "5y", maturityEff: 0.85, maturityTable,
    });
    expect(r.text).toMatch(/Duration: Neutral \(score 0\.35\)/);
    expect(r.text).toMatch(/real 10y 2\.9% vs r-star 0\.8%/);
    expect(r.text).toMatch(/term premium z \+1\.1/);
    expect(r.text).toMatch(/Trend \(context\): mixed/);
    expect(r.text).toMatch(/bear flattening/);
    expect(r.text).toMatch(/not a reliable hedge/);
    expect(r.text).toMatch(/5y \(risk-adjusted carry 0\.85\)/);
    expect(r.text).toMatch(/Display only/);
    expect(r.drivers.duration).toEqual({ score: 0.35, stance: "Neutral" });
    expect((r.drivers.maturity as { table: unknown; display_only: boolean }).table).toEqual(maturityTable);
    expect((r.drivers.maturity as { display_only: boolean }).display_only).toBe(true);
  });

  it("explains \"bills\" maturity preference without an EFF sentence", () => {
    const r = buildExplanation({
      durationScore: -0.2,
      durationStance: "Neutral", trendState: "up",
      realYieldGapPct: null, dfii10Pct: null, rstarPct: null, termPremiumZ: null,
      curveRegime: null, curveRegimeSince: null,
      hedgeReliable: true, instrumentPref: "nominal_tilted", maturityPref: "bills", maturityEff: null, maturityTable,
    });
    expect(r.text).toMatch(/prefer bills/);
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

  it("produces a composite row once valuation_score has enough history, null before -- v3's only gate", () => {
    const dayRows = computeBondLensHistory(inputs);
    const signalRows = computeBondLensSignalHistory(dayRows, inputs);
    expect(signalRows.length).toBe(n);
    expect(signalRows[10]).toBeNull(); // too early for even valuation_score's own z-score warmup
    const last = signalRows[n - 1];
    expect(last).not.toBeNull();
    expect(typeof last!.duration_score).toBe("number");
    expect(["Short", "Neutral", "Extend"]).toContain(last!.duration_stance); // no Max extend in v3
    expect(["bills_short_tips", "tips_tilted", "nominal_tilted"]).toContain(last!.instrument_pref);
    expect(["2y", "5y", "7y", "10y", "bills"]).toContain(last!.maturity_pref);
    expect(typeof last!.explanation.text).toBe("string");
  });

  it("no longer requires carry_score/trend_state to emit a row -- the gate is valuation_score alone", () => {
    const dayRows = computeBondLensHistory(inputs);
    const signalRows = computeBondLensSignalHistory(dayRows, inputs);
    const firstNonNullIdx = signalRows.findIndex((r) => r != null);
    expect(firstNonNullIdx).toBeGreaterThan(0);
    const firstRow = dayRows[firstNonNullIdx];
    expect(firstRow.valuation_score).not.toBeNull();
    // Confirms the row didn't wait on carry_score specifically (carry's own
    // synthetic z-score warmup in this fixture may differ from valuation's) --
    // the point of the test is the GATE, not that carry happens to be null here.
  });
});

// §5.4 (2026-10-02 follow-up #7): the old EFF_n (CR_n/D_mod(n), now BE_n)
// only looked at curve SHAPE -- two curves with identical shape but wildly
// different day-to-day yield vol would score identically. The new Sharpe-
// style EFF_n = (CR_n - y_3m) / (D_mod(n) * sigma_n) must NOT do that --
// this proves sigma_n's denominator is doing real work, not just along
// for the ride.
describe("maturity preference EFF_n responds to yield volatility, not just curve shape", () => {
  const n = 1200;
  const dates = Array.from({ length: n }, (_, i) => isoDate(i));
  const flat = (v: number) => Array.from({ length: n }, () => v);

  // Deterministic alternating +/-amplitude around 4% -- every daily change
  // in dgs2 has EXACTLY magnitude 2*amplitude, so its trailing stdev is
  // exactly 2*amplitude regardless of window position (a clean, phase-
  // independent way to control sigma_2 without relying on a specific day
  // of a random or sinusoidal series landing favorably).
  function buildInputs(dgs2Amplitude: number): BondLensHistoryInputs {
    const dgs2 = Array.from({ length: n }, (_, i) => 4 + dgs2Amplitude * (i % 2 === 0 ? 1 : -1));
    return {
      dates,
      dgs3mo: flat(2), dgs1: flat(2.5), dgs2, dgs3: flat(3.3),
      dgs5: flat(3.6), dgs7: flat(3.8), dgs10: flat(4), dgs30: flat(4.2),
      dfii5: flat(1.5), dfii10: flat(1.8),
      t5yie: flat(2.3), t10yie: flat(2.4), t5yifr: flat(2.5),
      dff: flat(1.8),
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
  }

  function eff2AtEnd(dgs2Amplitude: number): number | null {
    const inputs = buildInputs(dgs2Amplitude);
    const dayRows = computeBondLensHistory(inputs);
    const signalRows = computeBondLensSignalHistory(dayRows, inputs);
    const last = signalRows[n - 1];
    const table = (last!.explanation.drivers as { maturity: { table: Record<number, { EFF: number | null }> } }).maturity.table;
    return table[2].EFF;
  }

  it("gives a jumpy 2y yield a lower EFF_2 than a calm one, for the same curve shape", () => {
    const calm = eff2AtEnd(0.01);
    const jumpy = eff2AtEnd(0.8);
    expect(calm).not.toBeNull();
    expect(jumpy).not.toBeNull();
    expect(calm as number).toBeGreaterThan(jumpy as number);
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
