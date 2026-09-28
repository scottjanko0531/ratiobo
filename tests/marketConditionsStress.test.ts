import { describe, it, expect } from "vitest";
import { computeStressRawSeries, scoreStressAtIndex, vetoConditionsAtIndex } from "../supabase/functions/_shared/marketConditions/indicators/stress.ts";
import { MC_CONFIG } from "../supabase/functions/_shared/marketConditions/config.ts";

describe("computeStressRawSeries — raw values", () => {
  it("S1 = VIX / VIX3M", () => {
    const closes = [100, 100, 100];
    const vix = [20, 25, 30];
    const vix3m = [20, 20, 20];
    const creditSpread = [null, null, null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    expect(raw.s1raw[1]).toBeCloseTo(25 / 20, 10);
  });

  it("S1 is null wherever VIX3M is unavailable (pre-2006 in real data)", () => {
    const closes = [100, 100];
    const vix = [20, 20];
    const vix3m = [null, 18];
    const creditSpread = [null, null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    expect(raw.s1raw[0]).toBeNull();
    expect(raw.s1raw[1]).toBeCloseTo(20 / 18, 10);
  });

  it("S2 = credit spread level (BAA10Y), passed through unchanged", () => {
    const closes = [100, 100];
    const vix = [null, null];
    const vix3m = [null, null];
    const creditSpread = [2.03, 2.50];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    expect(raw.s2raw[1]).toBe(2.50);
  });

  it("S3 converts a 20-day credit spread change from percentage points to basis points", () => {
    // FRED units are percentage points (e.g. 2.00 = 2.00%). A change from
    // 2.00 to 2.50 over 20 days is 0.50pp = 50bp, NOT 0.5bp -- this is
    // exactly the kind of unit conversion that's silently wrong if missed.
    const n = 25;
    const closes = new Array(n).fill(100);
    const vix = new Array(n).fill(null);
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(2.00);
    creditSpread[24] = 2.50; // 20 trading days after index 4
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    expect(raw.s3raw[24]).toBeCloseTo(50, 5);
  });

  it("S4 = 20-day annualized realized vol of SPX log returns", () => {
    // Constant daily log return r for 21 points -> stdev = 0 -> S4 = 0.
    const n = 25;
    const closes = Array.from({ length: n }, (_, i) => 100 * Math.pow(1.001, i));
    const vix = new Array(n).fill(null);
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(null);
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    expect(raw.s4raw[24]).toBeCloseTo(0, 6);
  });

  it("S5 = VIX level, passed through unchanged", () => {
    const closes = [100, 100];
    const vix = [18, 22];
    const vix3m = [null, null];
    const creditSpread = [null, null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    expect(raw.s5raw[1]).toBe(22);
  });

  it("S6 (mc-1.3.0) = VIXCLS 20-day change, in VIX points", () => {
    const n = 25;
    const closes = new Array(n).fill(100);
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(null);
    const vix = new Array(n).fill(18);
    vix[24] = 25; // +7 points over 20 days
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    expect(raw.s6raw[24]).toBeCloseTo(7, 10);
  });

  it("vixSma50 is VIXCLS's own 50-day average, null-tolerant of gaps", () => {
    const n = 55;
    const closes = new Array(n).fill(100);
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(null);
    const vix = new Array(n).fill(20);
    vix[10] = null; // a gap -- should be skipped, not treated as 0
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    // 50 points ending at t=54, one of which (index 10) is null -> only 49 non-null -> not enough for a full 50-count window.
    expect(raw.vixSma50[54]).toBeNull();
  });
});

describe("scoreStressAtIndex — inversion", () => {
  it("scores a HIGH VIX level as a LOW (bearish) score, not high", () => {
    const n = 800;
    const closes = new Array(n).fill(100);
    // Mostly-calm VIX with one big spike at the end -- the spike should
    // rank near the top of its own history and, being inverted, score
    // strongly negative.
    const vix = Array.from({ length: n }, (_, i) => (i === n - 1 ? 80 : 15 + (i % 5)));
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(null);
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, n - 1, MC_CONFIG);
    expect(result.indicators.S5.percentile).toBeGreaterThan(95);
    expect(result.indicators.S5.score).toBeLessThan(-0.9);
  });

  it("excludes an indicator entirely absent from the inputs (e.g. credit spread before its FRED window starts)", () => {
    const n = 800;
    const closes = new Array(n).fill(100);
    const vix = new Array(n).fill(20);
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(null); // never available
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, n - 1, MC_CONFIG);
    expect(result.indicators.S1.excluded).toBe(true); // no VIX3M
    expect(result.indicators.S2.excluded).toBe(true); // no credit spread
    expect(result.indicators.S3.excluded).toBe(true);
    expect(result.indicators.S5.excluded).toBe(false); // VIX alone still scores
    expect(result.indicators.S6.excluded).toBe(false); // VIX alone still scores (S6 = its own 20d change)
    expect(result.pillarScore).not.toBeNull();
  });
});

describe("scoreStressAtIndex — change-vs-level weighting (mc-1.3.0)", () => {
  it("weights the aggregate as 0.125/0.125/0.25/0.125/0.125/0.25 (S1,S2,S4,S5 vs S3,S6) when all six are available", () => {
    const n = 800;
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 13) * 5); // wiggly, so S4/realized-vol is nonzero
    const vix = Array.from({ length: n }, (_, i) => 18 + (i % 7));
    const vix3m = Array.from({ length: n }, () => 19);
    const creditSpread = Array.from({ length: n }, (_, i) => 2 + Math.sin(i / 30) * 0.3);
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, n - 1, MC_CONFIG);
    const { S1, S2, S3, S4, S5, S6 } = result.indicators;
    for (const r of [S1, S2, S3, S4, S5, S6]) expect(r.excluded).toBe(false); // sanity: all six actually contributing
    const expected = 0.125 * (S1.score! + S2.score! + S4.score! + S5.score!) + 0.25 * (S3.score! + S6.score!);
    expect(result.pillarScore).toBeCloseTo(expected, 10);
  });

  it("redistributes S1's weight (0.125) across the remaining five when S1 alone is excluded (pre-2006, no VIX3M)", () => {
    const n = 800;
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 13) * 5);
    const vix = Array.from({ length: n }, (_, i) => 18 + (i % 7));
    const vix3m = new Array(n).fill(null); // S1 excluded, everything else unaffected
    const creditSpread = Array.from({ length: n }, (_, i) => 2 + Math.sin(i / 30) * 0.3);
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, n - 1, MC_CONFIG);
    const { S1, S2, S3, S4, S5, S6 } = result.indicators;
    expect(S1.excluded).toBe(true);
    for (const r of [S2, S3, S4, S5, S6]) expect(r.excluded).toBe(false);
    // Nominal weights sum to 0.875 without S1; renormalized so they sum to 1.
    const totalW = 0.125 + 0.25 + 0.125 + 0.125 + 0.25; // S2+S3+S4+S5+S6
    const expected = (0.125 * S2.score! + 0.25 * S3.score! + 0.125 * S4.score! + 0.125 * S5.score! + 0.25 * S6.score!) / totalW;
    expect(result.pillarScore).toBeCloseTo(expected, 10);
  });
});

describe("scoreStressAtIndex — S1 absolute mapping (mc-1.2.0)", () => {
  it("scores +1 at or below the low boundary (0.85), not a percentile", () => {
    const closes = [100];
    const vix = [17];
    const vix3m = [20]; // ratio 0.85
    const creditSpread = [null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, 0, MC_CONFIG);
    expect(result.indicators.S1.percentile).toBeNull(); // absolute, not percentile-ranked
    expect(result.indicators.S1.score).toBeCloseTo(1, 10);
  });

  it("scores -1 at or above the high boundary (1.05)", () => {
    const closes = [100];
    const vix = [21];
    const vix3m = [20]; // ratio 1.05
    const creditSpread = [null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, 0, MC_CONFIG);
    expect(result.indicators.S1.score).toBeCloseTo(-1, 10);
  });

  it("interpolates linearly between the boundaries, 0 at the midpoint (0.95)", () => {
    const closes = [100];
    const vix = [19];
    const vix3m = [20]; // ratio 0.95
    const creditSpread = [null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, 0, MC_CONFIG);
    expect(result.indicators.S1.score).toBeCloseTo(0, 10);
  });

  it("scores on day 1 with no minHistory buildup required (live immediately, unlike S2-S5)", () => {
    // A single day of data -- would fail every other Stress indicator's
    // minHistory=756 gate, but S1 has no such gate.
    const closes = [100];
    const vix = [17];
    const vix3m = [20];
    const creditSpread = [null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const result = scoreStressAtIndex(raw, 0, MC_CONFIG);
    expect(result.indicators.S1.excluded).toBe(false);
  });
});

describe("vetoConditionsAtIndex", () => {
  it("triggers term-structure condition when VIX/VIX3M exceeds the configured threshold", () => {
    const closes = [100];
    const vix = [30];
    const vix3m = [20]; // ratio 1.5 > 1.05
    const creditSpread = [null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const conds = vetoConditionsAtIndex(raw, 0, MC_CONFIG);
    expect(conds.termStructureTriggered).toBe(true);
  });

  it("does not trigger when the ratio is at/below threshold", () => {
    const closes = [100];
    const vix = [20];
    const vix3m = [20]; // ratio 1.0
    const creditSpread = [null];
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const conds = vetoConditionsAtIndex(raw, 0, MC_CONFIG);
    expect(conds.termStructureTriggered).toBe(false);
  });

  it("triggers credit-widening condition when 20d change exceeds the configured 45bp threshold (mc-1.1.0)", () => {
    const n = 25;
    const closes = new Array(n).fill(100);
    const vix = new Array(n).fill(null);
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(2.00);
    creditSpread[24] = 2.50; // +50bp over 20 days, just above the 45bp threshold
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const conds = vetoConditionsAtIndex(raw, 24, MC_CONFIG);
    expect(conds.creditWideningTriggered).toBe(true);
  });

  it("does not trigger below the 45bp threshold", () => {
    const n = 25;
    const closes = new Array(n).fill(100);
    const vix = new Array(n).fill(null);
    const vix3m = new Array(n).fill(null);
    const creditSpread = new Array(n).fill(2.00);
    creditSpread[24] = 2.40; // +40bp, below threshold
    const raw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const conds = vetoConditionsAtIndex(raw, 24, MC_CONFIG);
    expect(conds.creditWideningTriggered).toBe(false);
  });
});
