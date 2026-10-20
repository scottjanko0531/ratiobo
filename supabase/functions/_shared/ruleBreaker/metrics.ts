// Rule Breaker Screener — raw sub-metric formulas behind the `drivers`
// JSON's c1/c2/c3/c4/c6/safety/prof/cash/trend groups. Every formula below
// was confirmed field-by-field against the real 155-symbol baseline
// (rb_fundamentals.raw vs rb_scores.drivers, config_version='artifact-v15',
// date=2026-10-19) -- not guessed. Flat, not pre-split into per-group
// files: these are stateless pure math, closer to bondLens/carry.ts in
// weight than marketConditions/indicators/ (which only fragments when a
// concern carries its own state machine; none of these do).
//
// Each function returns `number | null` -- null when a required input
// field is missing, matching the real export's own null-driver convention
// (e.g. a biotech with no R&D/gross-profit ratio because gross profit is
// negative or absent).

import type { RbFundamentalsRaw } from "./types.ts";

function safeDiv(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

// ── c1: Growth ──

export function revenueGrowthLastFy(raw: RbFundamentalsRaw): number | null {
  const rev = raw.rev;
  if (!rev || rev[1] == null || rev[1] === 0 || rev[0] == null) return null;
  return rev[0] / rev[1] - 1;
}

export function revenueGrowthLatestQtrYoy(raw: RbFundamentalsRaw): number | null {
  return raw.rgQ ?? null;
}

// Always null in every confirmed baseline example -- the artifact's own
// "Growth acceleration (pts vs prior qtr)" needs two periods of
// quarter-over-quarter revenue growth (8 quarters of qrev) to compute an
// acceleration delta, but the export only carries 5 quarters. Returning
// null unconditionally matches every observed row; do not guess a formula
// without more quarters of history to test against.
export function growthAcceleration(_raw: RbFundamentalsRaw): number | null {
  return null;
}

// ── c2: Profitability / moat quality ──

export function grossMargin(raw: RbFundamentalsRaw): number | null {
  return raw.gmTTM ?? null;
}

export function grossProfitOverAssets(raw: RbFundamentalsRaw): number | null {
  const gp = raw.gp, assets = raw.assets;
  if (!gp || !assets) return null;
  return safeDiv(gp[0], assets[0]);
}

// Confirmed bug fix: must also null-check gp[0]/gp[1] explicitly -- `null`
// coerces to `0` in division, so without this a company with no gross-profit
// tracking at all (gp=[null,null], e.g. ANAB/RKT/NU) silently computed a
// fake 0 ("no change") instead of the real null, which also polluted this
// metric's cross-sectional universe for every other symbol.
export function grossMarginChange(raw: RbFundamentalsRaw): number | null {
  const gp = raw.gp, rev = raw.rev;
  if (!gp || !rev || gp[0] == null || gp[1] == null || rev[0] == null || rev[1] == null || rev[0] === 0 || rev[1] === 0) {
    return null;
  }
  const marginNow = gp[0] / rev[0];
  const marginPrior = gp[1] / rev[1];
  return marginNow - marginPrior;
}

// Non-positive gross profit makes the ratio's sign meaningless, so it nulls
// out rather than reporting a negative value -- confirmed via VELO
// (gp[0]=-7404000, rd=10653000, would otherwise compute -1.44, but the real
// driver is null).
export function rdOverGrossProfit(raw: RbFundamentalsRaw): number | null {
  const gp = raw.gp;
  if (!gp || gp[0] == null || gp[0] <= 0) return null;
  return safeDiv(raw.rd, gp[0]);
}

// ── c3: Momentum ──

export function oneYearReturn(raw: RbFundamentalsRaw): number | null {
  return raw.ret1y ?? null;
}

export function momentum12Minus1(raw: RbFundamentalsRaw): number | null {
  return raw.mom12_1 ?? null;
}

export function momentum6Month(raw: RbFundamentalsRaw): number | null {
  return raw.mom6 ?? null;
}

// ── c4: Ownership / smart backing ──

export function insiderOwnership(raw: RbFundamentalsRaw): number | null {
  return raw.ins ?? null;
}

export function netInsiderBuying6m(raw: RbFundamentalsRaw): number | null {
  return raw.insNet6m ?? null;
}

export function institutionalOwnership(raw: RbFundamentalsRaw): number | null {
  return raw.inst ?? null;
}

// ── c6: Valuation ──

// Recomputed from enterprise value, NOT the raw `evRev` field -- confirmed
// the artifact recomputes EV itself (mcap + debt - cash) rather than using
// its own stored evRev, which uses a different (unconfirmed) EV basis.
// `debt`/`cash`/`rev` are in the company's OWN reporting currency (see
// `raw.fcur`) while `mcapUsd` is already USD -- fxToUsd converts the
// former before combining them, confirmed exact across all 6
// foreign-currency symbols in the baseline (TSM/TWD, TBBB/MXN, ONON/CHF,
// TOITF/EUR, NTDOY/JPY, BNTX/EUR); for a USD-denominated symbol fxToUsd=1
// so this is a no-op.
// A missing debt or cash figure is treated as 0, not as invalidating the
// whole ratio -- confirmed exact across 6 real cases where only one of the
// two was null (NU: cash=null; NTDOY/AX/RKT/UPST/LULU: debt=null; e.g. NU's
// ev=mcapUsd+debt-0 reproduces its real EV/sales exactly).
export function evOverSales(raw: RbFundamentalsRaw, mcapUsd: number | null, fxToUsd: number | null): number | null {
  const rev = raw.rev;
  if (!rev || rev[0] == null || rev[0] === 0 || mcapUsd == null || fxToUsd == null) {
    return null;
  }
  const revUsd = rev[0] * fxToUsd;
  const debtUsd = (raw.debt ?? 0) * fxToUsd;
  const cashUsd = (raw.cash ?? 0) * fxToUsd;
  const ev = mcapUsd + debtUsd - cashUsd;
  return ev / revUsd;
}

// For a USD-denominated symbol (fxToUsd=1), the raw `ps` field is used
// directly -- confirmed exact (e.g. AMD: raw ps=21.265 matches the driver
// value exactly, while mcapUsd/rev[0]=25.35 would NOT). For a
// foreign-currency symbol, raw `ps` is instead recomputed from
// mcapUsd/revenueUsd -- confirmed exact across the same 6 foreign-currency
// symbols as evOverSales above; the raw field is apparently unreliable for
// these (likely an ADR share-count mismatch), while the mcap-based ratio
// is robust to that.
export function priceOverSales(raw: RbFundamentalsRaw, mcapUsd: number | null, fxToUsd: number | null): number | null {
  if (fxToUsd == null) return raw.ps ?? null;
  if (fxToUsd === 1) return raw.ps ?? null;
  const rev = raw.rev;
  if (!rev || rev[0] == null || rev[0] === 0 || mcapUsd == null) return null;
  return mcapUsd / (rev[0] * fxToUsd);
}

// A negative forward P/E (money-losing on a forward basis) is treated as
// undefined/null rather than reported literally -- confirmed clean across
// all 14 negative-fpe cases in the baseline (e.g. NTRA's real fpe=-1733.9
// still shows a null driver, not that literal value).
export function forwardPe(raw: RbFundamentalsRaw): number | null {
  if (raw.fpe == null || raw.fpe < 0) return null;
  return raw.fpe;
}

// ── safety ──

// Non-positive EBITDA makes the ratio's sign meaningless on its own, so it
// gets a binary override instead of the literal division -- confirmed
// clean across all 27 ebitda<=0 cases in the baseline: a net CASH position
// (debt<=cash) despite negative earnings reads as 0 (no debt risk even
// though profitless); a net DEBT position (debt>cash) with negative
// earnings reads as the fixed worst-case value 99 (debt with no earnings
// to service it). Both override the plain division entirely, not just
// clamp it.
export function netDebtOverEbitda(raw: RbFundamentalsRaw): number | null {
  if (raw.debt == null || raw.cash == null) return null;
  if (raw.ebitda != null && raw.ebitda <= 0) {
    return raw.debt - raw.cash > 0 ? 99 : 0;
  }
  return safeDiv(raw.debt - raw.cash, raw.ebitda);
}

// Non-positive equity is a structurally invalid leverage input -- callers
// should treat a null return here the same way crossSectionalRank.ts's
// invalidMetricSentinel treats it (confirmed via AMD's leverage pct=89.61,
// only reproducible with non-positive-equity symbols staying IN the
// ranking universe at the worst-case end, not excluded).
export function leverage(raw: RbFundamentalsRaw): number | null {
  const assets = raw.assets, eq = raw.eq;
  if (!assets || eq == null || eq <= 0) return null; // caller applies the sentinel
  return assets[0] / eq;
}

// Sum of every quarter-over-quarter DECLINE's magnitude across the qoi
// sequence (not just the single worst drop, and not a running-peak
// drawdown) -- confirmed exact across 119/155 real baseline cases,
// including every case with more than one separate down-move (e.g. PANW's
// two dips: 497.2M->309M and 397M->-183M sum to a combined 768.2M drop,
// not just the larger of the two). A single-max-drawdown formula was tried
// first and matches whenever there's exactly one contiguous declining
// region (e.g. SPCX, ARM, NET, CRWD) but understates real cases with
// multiple separate dips (PANW, TEAM, NBIS, FIGS, and ~30 others).
//
// When qoi itself is empty (confirmed real cases: NU, RKT, AX, UPST), the
// real formula falls back to qni (quarterly net income) as the series
// instead -- confirmed exact on all 4 (e.g. NU's qni dips 892.38M->872.06M,
// a 20.32M decline / assets[0]=74894000000 = 0.0002713..., matching the
// real driver exactly).
//
// KNOWN GAP: 36/155 real-world cases with a non-empty qoi still don't
// match exactly, and in every one the *required* total decline exceeds
// what's even possible to sum from this export's 5 quarters of qoi -- i.e.
// the real calculation draws on more quarterly history than this dataset
// captured (same documented gap as `growthAcceleration`'s "only 5 of the
// needed quarters" limitation), not a formula error.
function sumOfDeclines(series: number[]): number {
  let totalDecline = 0;
  for (let i = 1; i < series.length; i++) {
    const decline = series[i - 1] - series[i];
    if (decline > 0) totalDecline += decline;
  }
  return totalDecline;
}

export function operatingIncomeDrop(raw: RbFundamentalsRaw): number | null {
  const assets = raw.assets;
  if (!assets || assets[0] == null || assets[0] === 0) return null;
  const series = raw.qoi && raw.qoi.length >= 2 ? raw.qoi : raw.qni;
  if (!series || series.length < 2) return null;
  return sumOfDeclines(series) / assets[0];
}

export function priceVolatility1y(raw: RbFundamentalsRaw): number | null {
  return raw.rv ?? null;
}

// ── prof (feeds "Profitability" weak_pillar sub-score, reuses c2's gross-profit/assets) ──

export function operatingCashFlowOverSales(raw: RbFundamentalsRaw): number | null {
  const cfo = raw.cfo, rev = raw.rev;
  if (!cfo || !rev) return null;
  return safeDiv(cfo[0], rev[0]);
}

// A missing stock-comp figure is treated as 0, not as invalidating the
// ratio -- confirmed exact on TOITF/NTDOY (both sbc=null): e.g. TOITF's
// 412680000/1552300000 (sbc treated as 0) matches the real driver exactly.
export function cashFlowAfterStockPayOverSales(raw: RbFundamentalsRaw): number | null {
  const cfo = raw.cfo, rev = raw.rev;
  if (!cfo || !rev) return null;
  return safeDiv(cfo[0] - (raw.sbc ?? 0), rev[0]);
}

// Non-positive invested capital makes the ratio's sign meaningless, same
// pattern as leverage/rdOverGrossProfit's own invalid-denominator guards --
// confirmed via CBRS (ic=-578660000, would otherwise compute a positive
// 87th-percentile-looking ROIC from two negatives, but the real driver is
// null).
export function returnOnInvestedCapital(raw: RbFundamentalsRaw): number | null {
  if (raw.ebit == null || raw.tax == null || raw.ic == null || raw.ic <= 0) return null;
  return safeDiv(raw.ebit * (1 - raw.tax), raw.ic);
}

// ── cash (feeds "Cash earnings" weak_pillar sub-score) ──

// Confirmed formula uses the SAME cash-after-stock-pay figure as `prof`
// above, not a naive (ni-cfo)/assets -- (ni - (cfo[0]-sbc)) / assets[0].
// Same missing-sbc-treated-as-0 convention as cashFlowAfterStockPayOverSales
// above -- confirmed exact on TOITF/NTDOY.
export function accruals(raw: RbFundamentalsRaw): number | null {
  const cfo = raw.cfo, assets = raw.assets;
  if (!cfo || !assets || assets[0] == null || assets[0] === 0 || raw.ni == null) return null;
  const cashFlowAfterStockPay = cfo[0] - (raw.sbc ?? 0);
  return (raw.ni - cashFlowAfterStockPay) / assets[0];
}

export function stockPayOverSales(raw: RbFundamentalsRaw): number | null {
  const rev = raw.rev;
  if (!rev) return null;
  return safeDiv(raw.sbc, rev[0]);
}

// ── trend (feeds "Improving" weak_pillar sub-score) ──

export function changeInCashFlowMargin1y(raw: RbFundamentalsRaw): number | null {
  const cfo = raw.cfo, rev = raw.rev;
  if (!cfo || !rev || rev[0] == null || rev[1] == null || rev[0] === 0 || rev[1] === 0) return null;
  return cfo[0] / rev[0] - cfo[1] / rev[1];
}
