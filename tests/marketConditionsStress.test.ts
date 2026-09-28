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
    expect(result.pillarScore).not.toBeNull();
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
