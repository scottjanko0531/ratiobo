import { describe, it, expect } from "vitest";
import {
  revenueGrowthLastFy,
  revenueGrowthLatestQtrYoy,
  growthAcceleration,
  grossMargin,
  grossProfitOverAssets,
  grossMarginChange,
  rdOverGrossProfit,
  oneYearReturn,
  evOverSales,
  priceOverSales,
  forwardPe,
  netDebtOverEbitda,
  leverage,
  operatingIncomeDrop,
  operatingCashFlowOverSales,
  cashFlowAfterStockPayOverSales,
  returnOnInvestedCapital,
  accruals,
  stockPayOverSales,
  changeInCashFlowMargin1y,
} from "../supabase/functions/_shared/ruleBreaker/metrics.ts";
import { RbFundamentalsRaw } from "../supabase/functions/_shared/ruleBreaker/types.ts";

// Fixture reproduces a real baseline-date rb_fundamentals.raw row exactly
// (confirmed against the 2026-10-19 export this session) under a disguised
// fake ticker, same convention as tests/rbImportMapping.test.ts -- the
// formulas below were reverse-engineered by diffing this exact row's
// values against the artifact's own `drivers` JSON output, so the fixture
// is deliberately the real numbers, not invented ones.
const TESTCO_RAW: RbFundamentalsRaw = {
  assets: [76926000000, 69226000000],
  cash: 10552000000,
  cfo: [7709000000, 3041000000],
  debt: 3847000000,
  ebit: 4271000000,
  ebitda: 7275000000,
  eq: 62999000000,
  gmTTM: 0.55724,
  gp: [17152000000, 12725000000],
  ic: 66221000000,
  ni: 4335000000,
  qoi: [-134000000, 1270000000, 1752000000, 1476000000, 1990000000],
  rd: 8091000000,
  ret1y: 1.2367,
  rev: [34639000000, 25785000000, 22680000000],
  rgQ: 0.501,
  rv: 0.67515,
  sbc: 1638000000,
  tax: 0.21,
};
const TESTCO_MCAP = 878350000000;

describe("c1 growth metrics", () => {
  it("revenueGrowthLastFy = rev[0]/rev[1]-1", () => {
    expect(revenueGrowthLastFy(TESTCO_RAW)).toBeCloseTo(0.3433779, 6);
  });
  it("revenueGrowthLatestQtrYoy passes rgQ through", () => {
    expect(revenueGrowthLatestQtrYoy(TESTCO_RAW)).toBe(0.501);
  });
  it("growthAcceleration is always null (insufficient quarters in the export)", () => {
    expect(growthAcceleration(TESTCO_RAW)).toBeNull();
  });
});

describe("c2 profitability metrics", () => {
  it("grossMargin passes gmTTM through", () => {
    expect(grossMargin(TESTCO_RAW)).toBe(0.55724);
  });
  it("grossProfitOverAssets = gp[0]/assets[0]", () => {
    expect(grossProfitOverAssets(TESTCO_RAW)).toBeCloseTo(0.2229675, 6);
  });
  it("grossMarginChange = (gp[0]/rev[0]) - (gp[1]/rev[1])", () => {
    expect(grossMarginChange(TESTCO_RAW)).toBeCloseTo(0.0016604, 6);
  });
  it("rdOverGrossProfit = rd/gp[0]", () => {
    expect(rdOverGrossProfit(TESTCO_RAW)).toBeCloseTo(0.4717234, 6);
  });
});

describe("c3 momentum metrics", () => {
  it("oneYearReturn passes ret1y through", () => {
    expect(oneYearReturn(TESTCO_RAW)).toBe(1.2367);
  });
});

describe("c6 valuation metrics", () => {
  it("evOverSales recomputes EV from mcap+debt-cash, NOT the raw evRev field (fxToUsd=1, USD-denominated)", () => {
    expect(evOverSales(TESTCO_RAW, TESTCO_MCAP, 1)).toBeCloseTo(25.1637, 3);
  });

  it("evOverSales converts debt/cash/rev (company's own reporting currency) to USD via fxToUsd before combining with mcapUsd -- confirmed real foreign-currency case (TSM/TWD)", () => {
    const tsmRaw: RbFundamentalsRaw = { debt: 1064600000000, cash: 3128100000000, rev: [3809100000000, 2894300000000, 2161700000000] };
    expect(evOverSales(tsmRaw, 2179500000000, 0.030805)).toBeCloseTo(18.0326, 3);
  });

  it("priceOverSales uses the raw ps field directly when fxToUsd=1 (USD-denominated) -- confirmed: AMD's raw ps=21.265 matches exactly, while mcap/rev (25.35) would NOT", () => {
    expect(priceOverSales({ ...TESTCO_RAW, ps: 21.265 }, TESTCO_MCAP, 1)).toBe(21.265);
  });

  it("priceOverSales recomputes from mcapUsd/revenueUsd for a foreign-currency symbol, ignoring the raw ps field -- confirmed real case (TSM/TWD, raw ps=0.44076 is unreliable, likely an ADR share-count mismatch)", () => {
    const tsmRaw: RbFundamentalsRaw = { ps: 0.44076, rev: [3809100000000, 2894300000000, 2161700000000] };
    expect(priceOverSales(tsmRaw, 2179500000000, 0.030805)).toBeCloseTo(18.5743, 3);
  });

  it("forwardPe passes a positive fpe through directly", () => {
    expect(forwardPe({ fpe: 34.136 })).toBe(34.136);
  });

  it("forwardPe nulls a negative fpe (money-losing on a forward basis) rather than reporting it literally -- confirmed clean across 14 real baseline cases", () => {
    expect(forwardPe({ fpe: -1733.9 })).toBeNull();
  });
});

describe("safety metrics", () => {
  it("netDebtOverEbitda = (debt-cash)/ebitda when ebitda is positive", () => {
    expect(netDebtOverEbitda(TESTCO_RAW)).toBeCloseTo(-0.9216495, 6);
  });
  it("netDebtOverEbitda is the fixed worst-case value 99 when ebitda<=0 AND there's a net debt position -- confirmed real case (GH)", () => {
    expect(netDebtOverEbitda({ ...TESTCO_RAW, ebitda: -373910000, debt: 600000000, cash: 91500000 })).toBe(99);
  });
  it("netDebtOverEbitda is 0 when ebitda<=0 but there's a net CASH position (no real debt risk despite negative earnings) -- confirmed real case (NTRA)", () => {
    expect(netDebtOverEbitda({ ...TESTCO_RAW, ebitda: -220540000, debt: 214380000, cash: 1076100000 })).toBe(0);
  });
  it("leverage = assets[0]/eq", () => {
    expect(leverage(TESTCO_RAW)).toBeCloseTo(1.221067, 6);
  });
  it("leverage returns null for non-positive equity (caller applies the sentinel)", () => {
    expect(leverage({ ...TESTCO_RAW, eq: -500 })).toBeNull();
    expect(leverage({ ...TESTCO_RAW, eq: 0 })).toBeNull();
  });
  it("operatingIncomeDrop = -min(qoi consecutive diffs)/assets[0] when a real drop exists", () => {
    // diffs: 1404e6, 482e6, -276e6, 514e6 -> min is -276e6
    expect(operatingIncomeDrop(TESTCO_RAW)).toBeCloseTo(0.0035879, 6);
  });
  it("operatingIncomeDrop floors at 0 when every quarter-over-quarter diff is non-negative (no real drop) -- confirmed real cases (NVDA, TSM, etc.)", () => {
    expect(operatingIncomeDrop({ ...TESTCO_RAW, qoi: [100, 200, 300, 400, 500] })).toBe(0);
  });
});

describe("prof/cash/trend metrics (weak_pillar sub-scores)", () => {
  it("operatingCashFlowOverSales = cfo[0]/rev[0]", () => {
    expect(operatingCashFlowOverSales(TESTCO_RAW)).toBeCloseTo(0.2225526, 6);
  });
  it("cashFlowAfterStockPayOverSales = (cfo[0]-sbc)/rev[0]", () => {
    expect(cashFlowAfterStockPayOverSales(TESTCO_RAW)).toBeCloseTo(0.1752649, 6);
  });
  it("returnOnInvestedCapital = ebit*(1-tax)/ic", () => {
    expect(returnOnInvestedCapital(TESTCO_RAW)).toBeCloseTo(0.050952, 5);
  });
  it("accruals = (ni - (cfo[0]-sbc)) / assets[0] -- uses the cash-after-stock-pay figure, not a naive (ni-cfo)/assets", () => {
    expect(accruals(TESTCO_RAW)).toBeCloseTo(-0.0225671, 6);
  });
  it("stockPayOverSales = sbc/rev[0]", () => {
    expect(stockPayOverSales(TESTCO_RAW)).toBeCloseTo(0.0472877, 6);
  });
  it("changeInCashFlowMargin1y = cfo[0]/rev[0] - cfo[1]/rev[1]", () => {
    expect(changeInCashFlowMargin1y(TESTCO_RAW)).toBeCloseTo(0.1046158, 5);
  });
});

describe("null-input handling", () => {
  it("every metric returns null rather than NaN/throwing when a required field is missing", () => {
    const empty: RbFundamentalsRaw = {};
    expect(revenueGrowthLastFy(empty)).toBeNull();
    expect(grossProfitOverAssets(empty)).toBeNull();
    expect(evOverSales(empty, null, null)).toBeNull();
    expect(netDebtOverEbitda(empty)).toBeNull();
    expect(accruals(empty)).toBeNull();
  });
});
