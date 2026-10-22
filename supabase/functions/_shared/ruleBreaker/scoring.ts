// Rule Breaker Screener — top-level orchestrator. Wires metrics.ts's raw
// formulas through crossSectionalRank.ts into pillars.ts/classify.ts/
// vwap.ts to produce every symbol's full ComputedRbScore for one date.
//
// `safety` and `quality` are each a SECOND-ORDER cross-sectional
// percentile (first average some percentiles into a raw score, then rank
// THAT raw score again across the whole universe -- see pillars.ts's
// header comment), so this can't be a simple per-symbol function the way
// metrics.ts's formulas are: it genuinely needs two sequential
// universe-wide passes (one to collect every symbol's safetyRaw before
// any symbol's safetyPct is knowable, a second to collect every symbol's
// qraw -- which itself depends on safetyPct -- before any symbol's
// quality is knowable). `computeUniverseScores` below is that multi-pass
// orchestration; there is no single-symbol equivalent exposed, because
// there isn't a single-symbol answer for safety/quality until the whole
// universe has been seen once.

import { RB_CONFIG } from "./config.ts";
import * as metrics from "./metrics.ts";
import { crossSectionalPercentile } from "./crossSectionalRank.ts";
import * as pillars from "./pillars.ts";
import { computeScreen, computeQgroup, computeWeakPillar, computeRiskType } from "./classify.ts";
import { computeVwapZ, computeVwapState, computeAction, NO_VWAP_DATA } from "./vwap.ts";
import type {
  ComputedRbScore,
  DriverEntry,
  Drivers,
  RbFundamentalsRaw,
  RbWeeklyBarInput,
  RbFoolInput,
  RbRatingInput,
} from "./types.ts";

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

export interface SymbolScoreInput {
  symbol: string;
  date: string;
  raw: RbFundamentalsRaw;
  mcapUsd: number | null;
  fxToUsd: number | null;
  // Ascending by week_start, the LAST element is the current/latest week.
  // Fewer than 8 usable weeks (or a missing/incomplete latest bar) is
  // fine -- vwap_state/vwap_z fall back to NO_VWAP_DATA/null for this
  // symbol rather than requiring a minimum.
  weeklyBars: RbWeeklyBarInput[];
  fool: RbFoolInput | null;
  rating: RbRatingInput | null;
  owned: boolean;
  priorWeekScore: number | null;
}

interface StageA {
  input: SymbolScoreInput;
  drivers: Drivers;
  c1: number | null;
  c2: number | null;
  c3: number | null;
  c4: number | null;
  c5: number | null;
  c6: number | null;
  composite: number | null;
  safetyRaw: number | null;
  profNum: number | null;
  cashNum: number | null;
  trendNum: number | null;
}

// Computes every symbol's full score for one date. Must be called with
// EVERY symbol that should share a ranking universe that date -- a subset
// would silently rank against the wrong population (see pillars.ts's
// header comment on why safety/quality specifically need a full universe
// pass, not just composite/score/rank).
export function computeUniverseScores(members: SymbolScoreInput[]): ComputedRbScore[] {
  const metricUniverse = buildMetricUniverse(
    members.map((m) => ({ symbol: m.symbol, raw: m.raw, mcapUsd: m.mcapUsd, fxToUsd: m.fxToUsd })),
  );

  // ── Stage A: everything computable without a universe-wide pass beyond metricUniverse ──
  const stageA: StageA[] = members.map((input) => {
    const drivers = buildDrivers(input.raw, input.mcapUsd, input.fxToUsd, metricUniverse);
    const rating = input.rating;
    const c1 = pillars.computeC1(drivers.c1, rating?.td ?? null);
    const c2 = pillars.computeC2(drivers.c2, rating?.moat ?? null);
    const c3 = pillars.computeC3(drivers.c3);
    const c4 = pillars.computeC4(drivers.c4, rating?.mgmt ?? null);
    const c5 = pillars.computeC5(rating?.appeal ?? null);
    const c6 = pillars.computeC6(drivers.c6);
    const composite = pillars.computeComposite([c1, c2, c3, c4, c5, c6]);
    const safetyRaw = pillars.computeSafetyRaw(drivers.safety);
    return {
      input, drivers, c1, c2, c3, c4, c5, c6, composite, safetyRaw,
      profNum: pillars.pillarNum(drivers.prof),
      cashNum: pillars.pillarNum(drivers.cash),
      trendNum: pillars.pillarNum(drivers.trend),
    };
  });

  // ── Universe pass 1: safetyRaw -> safetyPct (second-order percentile) ──
  const safetyRawUniverse = stageA.map((s) => s.safetyRaw).filter((v): v is number => v != null);
  const safetyPcts = stageA.map((s) =>
    s.safetyRaw == null ? null : crossSectionalPercentile(safetyRawUniverse, s.safetyRaw),
  );

  // ── Stage B: qraw (depends on safetyPct, NOT safetyRaw -- see pillars.ts) ──
  const qraws = stageA.map((s, i) =>
    pillars.computeQualityRaw(s.drivers.prof, s.drivers.cash, s.drivers.trend, safetyPcts[i]),
  );

  // ── Universe pass 2: qraw -> quality (second-order percentile) ──
  const qrawUniverse = qraws.filter((v): v is number => v != null);
  const qualityPcts = qraws.map((q) => (q == null ? null : crossSectionalPercentile(qrawUniverse, q)));

  // ── Universe pass 3: composite -> score/rank (first confirmed this session, unchanged) ──
  // `compositeUniverse` drops nulls, so each stageA entry's position there
  // is NOT the same as its position in `stageA` -- track the mapping
  // explicitly rather than re-deriving it via indexOf (indexOf would
  // misattribute ties to whichever symbol happens to appear first, same
  // bug class crossSectionalRank.ts's descendingRank already guards
  // against for exactly this reason).
  const compositeUniverse: number[] = [];
  const compositeUniverseIndexByStageA: Array<number | null> = [];
  for (const s of stageA) {
    if (s.composite == null) {
      compositeUniverseIndexByStageA.push(null);
    } else {
      compositeUniverseIndexByStageA.push(compositeUniverse.length);
      compositeUniverse.push(s.composite);
    }
  }

  return stageA.map((s, i) => {
    const input = s.input;
    const safety = pillars.computeSafety(safetyPcts[i]);
    const quality = pillars.computeQuality(qualityPcts[i]);

    const compositeIndex = compositeUniverseIndexByStageA[i];
    if (s.composite == null || compositeIndex == null) {
      throw new Error(`computeUniverseScores(${input.symbol}): composite is null -- every pillar sign was null`);
    }
    const score = pillars.computeScore(s.composite, compositeUniverse);
    const rank = pillars.computeRank(compositeUniverse, compositeIndex);
    const met = pillars.computeMet([s.c1, s.c2, s.c3, s.c4, s.c5, s.c6]);

    const screen = computeScreen(met, score);
    const qgroup = computeQgroup(met, quality);
    const weakPillar = computeWeakPillar({
      cashDrivers: s.drivers.cash,
      trendDrivers: s.drivers.trend,
      profDrivers: s.drivers.prof,
      safety,
    });
    const riskType = computeRiskType(input.raw.rv ?? null);

    // VWAP is computed per-stock and may simply be missing (a newly-added
    // symbol with under 8 weeks of history, or today's refresh landing a
    // bar that's missing close/vwap6_a/vwap6_sigma) -- that is a reason to
    // fall back to NO_VWAP_DATA for THIS symbol, never a reason to throw
    // and abort the whole universe. Every symbol still gets a full
    // percentile-based score; removing one would shift everyone else's
    // rank and break parity with the live artifact.
    const currentBar = input.weeklyBars[input.weeklyBars.length - 1] as RbWeeklyBarInput | undefined;
    // The oldest weeks can be partial (not enough daily-bar lookback yet to
    // compute a 6-wk VWAP at all) -- drop those entirely rather than
    // requiring the whole raw history to be populated; `computeVwapState`'s
    // own week indexing is relative to this trimmed, valid-only series.
    const weeklyBarsForState = input.weeklyBars
      .filter((b) => b.close != null && b.vwap6_a != null)
      .map((b) => ({ close: b.close!, vwap6: b.vwap6_a! }));

    let vwapZ: number | null = null;
    let vwapState = NO_VWAP_DATA;
    if (currentBar?.close != null && currentBar.vwap6_a != null && currentBar.vwap6_sigma != null) {
      const z = computeVwapZ(currentBar.close, currentBar.vwap6_a, currentBar.vwap6_sigma);
      if (z != null) {
        vwapZ = z;
        vwapState = computeVwapState(weeklyBarsForState);
      }
    }
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
      vwap6a: currentBar?.vwap6_a ?? null,
      vwap6sigma: currentBar?.vwap6_sigma ?? null,
      price: currentBar?.close ?? null,
      riskType,
    });

    return {
      symbol: input.symbol,
      date: input.date,
      config_version: RB_CONFIG.version,
      c1: s.c1, c2: s.c2, c3: s.c3, c4: s.c4, c5: s.c5, c6: s.c6,
      met,
      composite: s.composite,
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
      drivers: s.drivers,
    };
  });
}
