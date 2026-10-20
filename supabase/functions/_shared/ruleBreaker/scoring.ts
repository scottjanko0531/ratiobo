// Rule Breaker Screener — top-level orchestrator. Wires metrics.ts's raw
// formulas through crossSectionalRank.ts into pillars.ts/classify.ts/
// vwap.ts to produce one symbol's full ComputedRbScore. Will throw for
// every real symbol until scripts/rb-calibrate.ts resolves pillars.ts's
// NotCalibratedError stubs (c2-c6, safety, quality, risk_type) -- that's
// expected at this stage; this file's job is correct wiring, not papering
// over what's still unsolved.

import { RB_CONFIG } from "./config.ts";
import * as metrics from "./metrics.ts";
import { crossSectionalPercentile } from "./crossSectionalRank.ts";
import * as pillars from "./pillars.ts";
import { computeScreen, computeQgroup, computeWeakPillar, computeRiskType } from "./classify.ts";
import { computeVwapZ, computeVwapState, computeAction } from "./vwap.ts";
import type { ComputedRbScore, DriverEntry, Drivers, RbFundamentalsRaw, RbWeeklyBarInput, RbFoolInput } from "./types.ts";

export interface UniverseMember {
  symbol: string;
  raw: RbFundamentalsRaw;
  mcapUsd: number | null;
  fxToUsd: number | null;
}

// Pre-computes every symbol's raw metric value once per universe, so
// per-symbol scoring can rank against the shared sorted arrays instead of
// recomputing the whole universe's metrics for every single symbol (O(n)
// instead of O(n^2) metric evaluations across a full-universe run).
export type MetricUniverse = Record<string, number[]>;

// Leverage specifically distinguishes "null because non-positive equity"
// (structurally invalid -> the fixed worst-case value 99, STAYS in the
// ranking universe) from "null because assets/equity data is simply
// missing" (generic missing data -> excluded from the universe entirely,
// same as every other metric). Confirmed exact (e.g. GH's leverage driver
// VALUE is literally 99, not Infinity or null) -- and the same literal 99
// is independently confirmed as netDebtOverEbitda's own worst-case value
// (see metrics.ts), so this is evidently one shared "pinned at the cap"
// sentinel the safety pillar uses generally, not a leverage-specific
// invention; RB_CONFIG.invalidMetricSentinel=99 reflects that. Using 99
// rather than +Infinity also ranks identically for percentile purposes as
// long as no real leverage ratio in the universe exceeds 99, which holds
// for every symbol checked. Shared with buildDrivers below so the
// single-symbol driver value and the universe array it's ranked against
// never disagree on which symbols count as "invalid" vs "missing".
export function leverageWithSentinel(raw: RbFundamentalsRaw): number | null {
  const value = metrics.leverage(raw);
  if (value != null) return value;
  const isStructurallyInvalid = raw.assets != null && raw.eq != null && raw.eq <= 0;
  return isStructurallyInvalid ? RB_CONFIG.invalidMetricSentinel : null;
}

export function buildMetricUniverse(members: UniverseMember[]): MetricUniverse {
  const extractors: Record<string, (m: UniverseMember) => number | null> = {
    revenueGrowthLastFy: (m) => metrics.revenueGrowthLastFy(m.raw),
    revenueGrowthLatestQtrYoy: (m) => metrics.revenueGrowthLatestQtrYoy(m.raw),
    grossMargin: (m) => metrics.grossMargin(m.raw),
    grossProfitOverAssets: (m) => metrics.grossProfitOverAssets(m.raw),
    grossMarginChange: (m) => metrics.grossMarginChange(m.raw),
    rdOverGrossProfit: (m) => metrics.rdOverGrossProfit(m.raw),
    oneYearReturn: (m) => metrics.oneYearReturn(m.raw),
    momentum12Minus1: (m) => metrics.momentum12Minus1(m.raw),
    momentum6Month: (m) => metrics.momentum6Month(m.raw),
    insiderOwnership: (m) => metrics.insiderOwnership(m.raw),
    netInsiderBuying6m: (m) => metrics.netInsiderBuying6m(m.raw),
    institutionalOwnership: (m) => metrics.institutionalOwnership(m.raw),
    evOverSales: (m) => metrics.evOverSales(m.raw, m.mcapUsd, m.fxToUsd),
    priceOverSales: (m) => metrics.priceOverSales(m.raw, m.mcapUsd, m.fxToUsd),
    forwardPe: (m) => metrics.forwardPe(m.raw),
    netDebtOverEbitda: (m) => metrics.netDebtOverEbitda(m.raw),
    leverage: (m) => leverageWithSentinel(m.raw), // sentinel-but-included for non-positive equity, see above
    operatingIncomeDrop: (m) => metrics.operatingIncomeDrop(m.raw),
    priceVolatility1y: (m) => metrics.priceVolatility1y(m.raw),
    operatingCashFlowOverSales: (m) => metrics.operatingCashFlowOverSales(m.raw),
    cashFlowAfterStockPayOverSales: (m) => metrics.cashFlowAfterStockPayOverSales(m.raw),
    returnOnInvestedCapital: (m) => metrics.returnOnInvestedCapital(m.raw),
    accruals: (m) => metrics.accruals(m.raw),
    stockPayOverSales: (m) => metrics.stockPayOverSales(m.raw),
    changeInCashFlowMargin1y: (m) => metrics.changeInCashFlowMargin1y(m.raw),
  };

  // Generic missing data is EXCLUDED from each metric's own ranking
  // universe (reducing n for just that metric), not substituted with the
  // sentinel -- confirmed via the real ret1y case, which only reproduces
  // exactly (pct=93.38) with n=152 (3 symbols lacking ret1y excluded), not
  // n=155. The sentinel above is leverage's own special case, already
  // baked into its extractor, so this filter only ever removes true nulls.
  const universe: MetricUniverse = {};
  for (const [key, extract] of Object.entries(extractors)) {
    universe[key] = members.map(extract).filter((v): v is number => v != null);
  }
  return universe;
}

function pct(universe: MetricUniverse, key: string, value: number | null, lowerIsBetter = false): number | null {
  if (value == null) return null;
  const pool = universe[key];
  return crossSectionalPercentile(pool, value, { lowerIsBetter });
}

function driver(name: string, value: number | null, pctValue: number | null): DriverEntry {
  return { name, value, pct: pctValue };
}

export function buildDrivers(
  raw: RbFundamentalsRaw,
  mcapUsd: number | null,
  fxToUsd: number | null,
  universe: MetricUniverse,
): Drivers {
  const leverageValue = leverageWithSentinel(raw);

  return {
    c1: [
      driver("Revenue growth (last FY)", metrics.revenueGrowthLastFy(raw), pct(universe, "revenueGrowthLastFy", metrics.revenueGrowthLastFy(raw))),
      driver("Revenue growth (latest qtr, YoY)", metrics.revenueGrowthLatestQtrYoy(raw), pct(universe, "revenueGrowthLatestQtrYoy", metrics.revenueGrowthLatestQtrYoy(raw))),
      driver("Growth acceleration (pts vs prior qtr)", metrics.growthAcceleration(raw), null),
    ],
    c2: [
      driver("Gross margin", metrics.grossMargin(raw), pct(universe, "grossMargin", metrics.grossMargin(raw))),
      driver("Gross profit / assets", metrics.grossProfitOverAssets(raw), pct(universe, "grossProfitOverAssets", metrics.grossProfitOverAssets(raw))),
      driver("Gross margin change", metrics.grossMarginChange(raw), pct(universe, "grossMarginChange", metrics.grossMarginChange(raw))),
      driver("R&D / gross profit", metrics.rdOverGrossProfit(raw), pct(universe, "rdOverGrossProfit", metrics.rdOverGrossProfit(raw))),
    ],
    c3: [
      driver("1-year return", metrics.oneYearReturn(raw), pct(universe, "oneYearReturn", metrics.oneYearReturn(raw))),
      driver("Momentum (12-1 mo)", metrics.momentum12Minus1(raw), pct(universe, "momentum12Minus1", metrics.momentum12Minus1(raw))),
      driver("Momentum (6 mo)", metrics.momentum6Month(raw), pct(universe, "momentum6Month", metrics.momentum6Month(raw))),
    ],
    c4: [
      driver("Insider ownership", metrics.insiderOwnership(raw), pct(universe, "insiderOwnership", metrics.insiderOwnership(raw))),
      driver("Net insider buying (6 mo, % of insider shares)", metrics.netInsiderBuying6m(raw), pct(universe, "netInsiderBuying6m", metrics.netInsiderBuying6m(raw))),
      driver("Institutional ownership", metrics.institutionalOwnership(raw), pct(universe, "institutionalOwnership", metrics.institutionalOwnership(raw))),
    ],
    c6: [
      driver("EV / sales", metrics.evOverSales(raw, mcapUsd, fxToUsd), pct(universe, "evOverSales", metrics.evOverSales(raw, mcapUsd, fxToUsd))),
      driver("Price / sales", metrics.priceOverSales(raw, mcapUsd, fxToUsd), pct(universe, "priceOverSales", metrics.priceOverSales(raw, mcapUsd, fxToUsd))),
      driver("Forward P/E", metrics.forwardPe(raw), pct(universe, "forwardPe", metrics.forwardPe(raw))),
    ],
    safety: [
      driver("Net debt / EBITDA", metrics.netDebtOverEbitda(raw), pct(universe, "netDebtOverEbitda", metrics.netDebtOverEbitda(raw), true)),
      driver("Leverage (assets / equity)", leverageValue, pct(universe, "leverage", leverageValue, true)),
      driver("Operating income drops (qtr to qtr, / assets)", metrics.operatingIncomeDrop(raw), pct(universe, "operatingIncomeDrop", metrics.operatingIncomeDrop(raw), true)),
      driver("Price volatility (1y)", metrics.priceVolatility1y(raw), pct(universe, "priceVolatility1y", metrics.priceVolatility1y(raw), true)),
    ],
    prof: [
      driver("Gross profit / assets", metrics.grossProfitOverAssets(raw), pct(universe, "grossProfitOverAssets", metrics.grossProfitOverAssets(raw))),
      driver("Operating cash flow / sales", metrics.operatingCashFlowOverSales(raw), pct(universe, "operatingCashFlowOverSales", metrics.operatingCashFlowOverSales(raw))),
      driver("Cash flow after stock pay / sales", metrics.cashFlowAfterStockPayOverSales(raw), pct(universe, "cashFlowAfterStockPayOverSales", metrics.cashFlowAfterStockPayOverSales(raw))),
      driver("Return on invested capital", metrics.returnOnInvestedCapital(raw), pct(universe, "returnOnInvestedCapital", metrics.returnOnInvestedCapital(raw))),
    ],
    cash: [
      driver("Accruals (lower is better)", metrics.accruals(raw), pct(universe, "accruals", metrics.accruals(raw), true)),
      driver("Stock pay / sales (lower is better)", metrics.stockPayOverSales(raw), pct(universe, "stockPayOverSales", metrics.stockPayOverSales(raw), true)),
    ],
    trend: [
      driver("Change in cash flow margin (1 yr)", metrics.changeInCashFlowMargin1y(raw), pct(universe, "changeInCashFlowMargin1y", metrics.changeInCashFlowMargin1y(raw))),
    ],
  };
}

export interface ComputeRbScoreInput {
  symbol: string;
  date: string;
  raw: RbFundamentalsRaw;
  mcapUsd: number | null;
  fxToUsd: number | null;
  metricUniverse: MetricUniverse;
  compositeUniverse: number[]; // every symbol's composite for this date, including this one, in a fixed/stable order
  compositeUniverseIndex: number; // this symbol's own position within compositeUniverse (needed for descendingRank's tie-break -- see crossSectionalRank.ts)
  currentBar: RbWeeklyBarInput;
  priorBar: RbWeeklyBarInput | null;
  fool: RbFoolInput | null;
  owned: boolean;
  priorWeekScore: number | null;
}

export function computeRbScore(input: ComputeRbScoreInput): ComputedRbScore {
  const drivers = buildDrivers(input.raw, input.mcapUsd, input.fxToUsd, input.metricUniverse);

  const c1 = pillars.computeC1(drivers.c1);
  const c2 = pillars.computeC2(drivers.c2);
  const c3 = pillars.computeC3(drivers.c3);
  const c4 = pillars.computeC4(drivers.c4);
  const c5 = pillars.computeC5();
  const c6 = pillars.computeC6(drivers.c6);
  const safety = pillars.computeSafety(drivers.safety);
  const quality = pillars.computeQuality();

  if (c1 == null) throw new Error(`computeRbScore(${input.symbol}): c1 is null -- insufficient driver data`);
  const composite = pillars.computeComposite(c1, c2, c3, c4, c5, c6);
  const score = pillars.computeScore(composite, input.compositeUniverse);
  const rank = pillars.computeRank(input.compositeUniverse, input.compositeUniverseIndex);
  const met = [c1, c2, c3, c4, c5, c6].filter((v) => v >= 50).length; // TODO(rb-calibrate): confirm "met" = count of pillars >= 50, not yet verified against baseline

  const screen = computeScreen(met, score);
  const qgroup = computeQgroup(met, quality);
  const weakPillar = computeWeakPillar({
    cashDrivers: drivers.cash,
    trendDrivers: drivers.trend,
    profDrivers: drivers.prof,
    safety,
  });
  const riskType = computeRiskType();

  const close = input.currentBar.close;
  const vwap6a = input.currentBar.vwap6_a;
  const vwap6sigma = input.currentBar.vwap6_sigma;
  if (close == null || vwap6a == null || vwap6sigma == null) {
    throw new Error(`computeRbScore(${input.symbol}): missing weekly-bar inputs for vwap_z`);
  }
  const vwapZ = computeVwapZ(close, vwap6a, vwap6sigma);
  if (vwapZ == null) throw new Error(`computeRbScore(${input.symbol}): vwap6_sigma is zero`);
  const vwapState = computeVwapState(vwapZ, input.currentBar.signal, vwap6a, input.priorBar?.vwap6_a ?? null);
  const { action, actionKey, actionWhy } = computeAction({
    symbol: input.symbol,
    score,
    safety,
    met,
    owned: input.owned,
    vwapState,
    vwapZ,
    closedOn: input.fool?.closed_on ?? null,
    priorWeekScore: input.priorWeekScore,
    vwap6a,
    vwap6sigma,
  });

  return {
    symbol: input.symbol,
    date: input.date,
    config_version: RB_CONFIG.version,
    c1, c2, c3, c4, c5, c6,
    met,
    composite,
    score,
    rank,
    screen,
    safety,
    quality,
    qgroup,
    weak_pillar: weakPillar,
    risk_type: riskType,
    action,
    action_key: actionKey,
    action_why: actionWhy,
    vwap_state: vwapState,
    vwap_z: vwapZ,
    drivers,
  };
}
