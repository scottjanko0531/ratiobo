import { describe, it, expect } from "vitest";
import { pricedHikes, inflTrend, growthMom, growthMomFallback, pathScore } from "../supabase/functions/_shared/bondLens/path.ts";

describe("pricedHikes", () => {
  it("positive when 2y yield exceeds fed funds (hikes priced)", () => {
    expect(pricedHikes(4.5, 4.0)).toBe(0.5);
  });
  it("negative when 2y yield is below fed funds (cuts priced)", () => {
    expect(pricedHikes(3.5, 4.0)).toBe(-0.5);
  });
  it("null when either input is missing", () => {
    expect(pricedHikes(null, 4.0)).toBeNull();
  });
});

describe("inflTrend", () => {
  it("computes 3mo annualized minus 12mo rate from an index level", () => {
    const dates = Array.from({ length: 400 }, (_, i) => isoDate(i));
    const pce = new Array(400).fill(100);
    // Index flat for a year, then +0.5% in the last 3 months -> 3mo annualized > 0, 12mo ~= 0.5%.
    for (let i = 300; i < 400; i++) pce[i] = 100.5;
    const r = inflTrend(pce, dates, 399);
    expect(r.excluded).toBe(false);
    expect(r.raw.rate12mo).toBeCloseTo(0.005, 3);
    expect(r.score).not.toBeNull();
  });

  it("excludes when there isn't a year of history yet", () => {
    const dates = Array.from({ length: 100 }, (_, i) => isoDate(i));
    const pce = new Array(100).fill(100);
    expect(inflTrend(pce, dates, 99).excluded).toBe(true);
  });
});

describe("growthMom", () => {
  const dates = Array.from({ length: 120 }, (_, i) => isoDate(i));

  it("computes a plain 8-week change within the same target quarter", () => {
    const values = new Array(120).fill(2.0);
    values[119] = 2.5;
    const quarters = new Array(120).fill("2026Q3");
    const r = growthMom(dates, values, quarters, 119, 56);
    expect(r.degraded).toBe(false);
    expect(r.value).toBeCloseTo(0.5, 5);
  });

  it("falls back to the scaled version across a quarter boundary", () => {
    const values = new Array(120).fill(2.0);
    const quarters: (string | null)[] = new Array(120).fill("2026Q2");
    // New quarter starts 10 days before t=119, first release 2.0, now 2.2.
    for (let i = 110; i <= 119; i++) quarters[i] = "2026Q3";
    values[110] = 2.0;
    values[119] = 2.2;
    const r = growthMom(dates, values, quarters, 119, 56);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/scaled/);
    // change-since-first (0.2) over 9 days, scaled to 56 days -> 0.2/9*56 ~= 1.244
    expect(r.value).toBeCloseTo((0.2 / 9) * 56, 2);
  });

  it("is degraded null when GDPNow or target_quarter is unavailable", () => {
    const values = new Array(120).fill(null);
    const quarters = new Array(120).fill(null);
    const r = growthMom(dates, values, quarters, 119, 56);
    expect(r.value).toBeNull();
    expect(r.degraded).toBe(true);
  });
});

describe("growthMomFallback", () => {
  it("combines 3mo breakeven change and curve-slope momentum", () => {
    const dates = Array.from({ length: 100 }, (_, i) => isoDate(i));
    const t5yie = new Array(100).fill(2.0);
    t5yie[99] = 2.2;
    const slope = new Array(100).fill(0.5);
    slope[99] = 0.7;
    const r = growthMomFallback(dates, t5yie, slope, dates, 99);
    expect(r.degraded).toBe(true);
    expect(r.value).toBeCloseTo(0.4, 5); // (2.2-2.0) + (0.7-0.5)
  });
});

describe("pathScore", () => {
  it("is bond-bullish when hikes are priced and growth is decelerating", () => {
    const r = pathScore(4.5, 4.0, { value: -1.5, degraded: false }, { raw: null, score: null, excluded: true });
    expect(r.excluded).toBe(false);
    expect(r.score).toBeGreaterThan(0);
  });

  it("is bond-bearish when cuts are priced and growth is accelerating", () => {
    const r = pathScore(3.5, 4.0, { value: 1.5, degraded: false }, { raw: null, score: null, excluded: true });
    expect(r.score).toBeLessThan(0);
  });

  it("is near-neutral when priced direction and data direction agree", () => {
    const r = pathScore(4.5, 4.0, { value: 1.5, degraded: false }, { raw: null, score: null, excluded: true });
    expect(r.score).toBeCloseTo(0, 10); // avoids a -0 vs 0 Object.is mismatch, not a logic difference
  });

  it("excludes when growth_mom is unavailable", () => {
    const r = pathScore(4.5, 4.0, { value: null, degraded: true }, { raw: null, score: null, excluded: true });
    expect(r.excluded).toBe(true);
  });
});

function isoDate(i: number): string {
  const d = new Date("2020-01-01T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
