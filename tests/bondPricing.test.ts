import { describe, it, expect } from "vitest";
import { priceParBond } from "../lib/bondPricing";

describe("priceParBond", () => {
  it("prices at exactly 100 when coupon equals yield", () => {
    expect(priceParBond(0.045, 0.045, 10)).toBeCloseTo(100, 6);
  });

  it("prices below par when yield exceeds coupon", () => {
    expect(priceParBond(0.03, 0.05, 10)).toBeLessThan(100);
  });

  it("prices above par when coupon exceeds yield", () => {
    expect(priceParBond(0.05, 0.03, 10)).toBeGreaterThan(100);
  });

  it("matches a hand-computed 2-year, semiannual example", () => {
    // 4% coupon, 5% yield, 2 years -> 4 semiannual periods of 2 paid, 2.5% discount rate per period
    const periods = [2, 2, 2, 102];
    const expected = periods.reduce((sum, cf, i) => sum + cf / Math.pow(1.025, i + 1), 0);
    expect(priceParBond(0.04, 0.05, 2)).toBeCloseTo(expected, 6);
  });

  it("returns par for zero maturity", () => {
    expect(priceParBond(0.04, 0.06, 0)).toBe(100);
  });
});
