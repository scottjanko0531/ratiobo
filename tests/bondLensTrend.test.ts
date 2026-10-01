import { describe, it, expect } from "vitest";
import { sma, timeSeriesMomentum, priceVsSma, trendFilter } from "../supabase/functions/_shared/bondLens/trend.ts";

describe("sma", () => {
  it("computes a simple moving average", () => {
    expect(sma([1, 2, 3, 4, 5], 4, 5)).toBe(3);
  });
  it("returns null without enough history", () => {
    expect(sma([1, 2], 1, 5)).toBeNull();
  });
  it("returns null if any value in the window is null", () => {
    expect(sma([1, null, 3, 4, 5], 4, 5)).toBeNull();
  });
});

describe("timeSeriesMomentum", () => {
  it("subtracts the trailing 1y bill yield from the total return", () => {
    const n = 300;
    const prices = new Array(n).fill(100);
    prices[n - 1] = 105; // +5% total return over the window
    const dgs1 = new Array(n).fill(3); // 3% yield 252 days ago
    const m = timeSeriesMomentum(prices, dgs1, n - 1, 252);
    expect(m).toBeCloseTo(0.05 - 0.03, 5);
  });
  it("returns null without a full lookback window", () => {
    const prices = new Array(100).fill(100);
    const dgs1 = new Array(100).fill(3);
    expect(timeSeriesMomentum(prices, dgs1, 99, 252)).toBeNull();
  });
});

describe("priceVsSma", () => {
  it("is positive when price is above its SMA", () => {
    const prices = new Array(250).fill(100);
    prices[249] = 110;
    expect(priceVsSma(prices, 249, 200)).toBeGreaterThan(0);
  });
});

describe("trendFilter", () => {
  it("is up when both legs are positive", () => {
    expect(trendFilter(0.01, 0.02)).toMatchObject({ state: "up", score: 1.5 });
  });
  it("is down when both legs are negative", () => {
    expect(trendFilter(-0.01, -0.02)).toMatchObject({ state: "down", score: -1.5 });
  });
  it("is mixed when the legs disagree", () => {
    expect(trendFilter(0.01, -0.02)).toMatchObject({ state: "mixed", score: 0 });
  });
  it("excludes when either leg is unavailable", () => {
    expect(trendFilter(null, 0.02).excluded).toBe(true);
  });
});
