import { describe, it, expect } from "vitest";
import { pricedHikes, inflTrend, growthMom, growthMomFallback, pathScoreContinuous } from "../supabase/functions/_shared/bondLens/path.ts";

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

  it("falls back to the scaled version once at least 10 trading days have elapsed", () => {
    const values = new Array(120).fill(2.0);
    const quarters: (string | null)[] = new Array(120).fill("2026Q2");
    // New quarter starts 19 trading days before t=119 (>= the 10-day minimum), first release 2.0, now 2.2.
    for (let i = 100; i <= 119; i++) quarters[i] = "2026Q3";
    values[100] = 2.0;
    values[119] = 2.2;
    const r = growthMom(dates, values, quarters, 119, 56);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/scaled/);
    // change-since-first (0.2) over 19 days, scaled to 56 days -> 0.2/19*56 ~= 0.589
    expect(r.value).toBeCloseTo((0.2 / 19) * 56, 2);
  });

  // 2026-10-02 follow-up #2: fewer than 10 trading days since the
  // quarter's first release makes the scaled estimate too noisy to trust
  // (scaling a 1-2 day change by up to 56x) -- carry the prior day's
  // reading forward instead, flagged degraded, same mechanism as the
  // firstIdx === t case this now subsumes.
  it("carries the prior day's growth_mom forward when fewer than 10 trading days have elapsed since the quarter's first release", () => {
    const values = new Array(120).fill(2.0);
    const quarters: (string | null)[] = new Array(120).fill("2026Q2");
    for (let i = 112; i <= 119; i++) quarters[i] = "2026Q3"; // 7 trading days old at t=119
    values[111] = 2.3; // last day of 2026Q2
    values[112] = 2.0; // 2026Q3's first release
    values[119] = 2.9; // only 7 trading days later -- would scale a 0.9pt move by 8x
    const prior = growthMom(dates, values, quarters, 118, 56); // still 2026Q3, 6 trading days old
    const r = growthMom(dates, values, quarters, 119, 56);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/fewer than 10 trading days/);
    expect(r.value).toBeCloseTo(prior.value as number, 10);
  });

  it("is degraded null when GDPNow or target_quarter is unavailable", () => {
    const values = new Array(120).fill(null);
    const quarters = new Array(120).fill(null);
    const r = growthMom(dates, values, quarters, 119, 56);
    expect(r.value).toBeNull();
    expect(r.degraded).toBe(true);
  });

  // 2026-10-02 follow-up #3: the exact day target_quarter flips to a new
  // quarter has no prior same-quarter release to diff against -- this
  // used to fall through to a flat null (observed as null rows at the
  // end of Jan/Apr/Jul/Oct). It should now carry the prior day's own
  // growth_mom reading forward instead, flagged degraded.
  it("carries the prior day's growth_mom forward on the exact day a new quarter's first release lands", () => {
    const values = new Array(120).fill(2.0);
    const quarters: (string | null)[] = new Array(120).fill("2026Q2");
    values[118] = 2.3; // last day of 2026Q2, 8-week change = 0.3 (same-quarter, not degraded)
    quarters[119] = "2026Q3";
    values[119] = 2.6; // t=119 IS 2026Q3's own first release -- no prior same-quarter release exists
    const prior = growthMom(dates, values, quarters, 118, 56);
    expect(prior.degraded).toBe(false);
    const r = growthMom(dates, values, quarters, 119, 56);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/carried prior day/);
    expect(r.value).toBeCloseTo(prior.value as number, 10);
  });

  it("is degraded null (not a carry-forward) on the very first day of the whole series", () => {
    const quarters: (string | null)[] = new Array(120).fill(null);
    quarters[0] = "2026Q1";
    const values = new Array(120).fill(null);
    values[0] = 1.0;
    const r = growthMom(dates, values, quarters, 0, 56);
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

describe("pathScoreContinuous", () => {
  // 2026-10-02 follow-up #4: path = clip(-z(data_momentum) * abs(z(priced_hikes)), -2, 2).
  // Sign comes from data_momentum (cooling -> bullish/positive, heating ->
  // bearish/negative); priced_hikes' magnitude only scales the strength.
  // (The literal "z(priced_hikes) * -z(data_momentum)" product Scott
  // first proposed can't distinguish these two cases -- confirmed with
  // him and corrected to the formula below.)
  it("is bond-bullish (positive) when data is decelerating, regardless of priced_hikes' sign", () => {
    const cooling = { z: -1.5, excluded: false };
    const r = pathScoreContinuous({ z: 1.2, excluded: false }, cooling, { z: null, excluded: true });
    expect(r.excluded).toBe(false);
    expect(r.score).toBeGreaterThan(0);
  });

  it("is bond-bearish (negative) when data is accelerating, regardless of priced_hikes' sign", () => {
    const heating = { z: 1.5, excluded: false };
    const r = pathScoreContinuous({ z: -1.2, excluded: false }, heating, { z: null, excluded: true });
    expect(r.score).toBeLessThan(0);
  });

  it("scales with priced_hikes' magnitude without flipping sign", () => {
    const cooling = { z: -1, excluded: false };
    const small = pathScoreContinuous({ z: 0.2, excluded: false }, cooling, { z: null, excluded: true });
    const big = pathScoreContinuous({ z: 1.8, excluded: false }, cooling, { z: null, excluded: true });
    expect(small.score as number).toBeGreaterThan(0);
    expect(big.score as number).toBeGreaterThan(small.score as number);
  });

  it("averages growth_mom and infl_trend z-scores when both are available", () => {
    const r = pathScoreContinuous({ z: 1, excluded: false }, { z: -1, excluded: false }, { z: -3, excluded: false });
    // data_momentum = avg(-1, -3) = -2 -> score = -(-2)*abs(1) = 2, clipped to 2
    expect(r.score).toBe(2);
  });

  it("excludes when priced_hikes is unavailable", () => {
    const r = pathScoreContinuous({ z: null, excluded: true, excludeReason: "x" }, { z: 1, excluded: false }, { z: 1, excluded: false });
    expect(r.excluded).toBe(true);
  });

  it("excludes when growth_mom and infl_trend are both unavailable", () => {
    const r = pathScoreContinuous({ z: 1, excluded: false }, { z: null, excluded: true }, { z: null, excluded: true });
    expect(r.excluded).toBe(true);
  });
});

function isoDate(i: number): string {
  const d = new Date("2020-01-01T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
