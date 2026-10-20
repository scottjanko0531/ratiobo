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

export function grossMarginChange(raw: RbFundamentalsRaw): number | null {
  const gp = raw.gp, rev = raw.rev;
  if (!gp || !rev || rev[0] == null || rev[1] == null || rev[0] === 0 || rev[1] === 0) return null;
  const marginNow = gp[0] / rev[0];
  const marginPrior = gp[1] / rev[1];
  return marginNow - marginPrior;
}

export function rdOverGrossProfit(raw: RbFundamentalsRaw): number | null {
  const gp = raw.gp;
  if (!gp) return null;
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
export function evOverSales(raw: RbFundamentalsRaw, mcapUsd: number | null, fxToUsd: number | null): number | null {
  const rev = raw.rev;
  if (!rev || rev[0] == null || rev[0] === 0 || mcapUsd == null || raw.debt == null || raw.cash == null || fxToUsd == null) {
    return null;
  }
  const revUsd = rev[0] * fxToUsd;
  const debtUsd = raw.debt * fxToUsd;
  const cashUsd = raw.cash * fxToUsd;
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

// Most negative single-quarter operating-income drop, normalized by
// assets and sign-flipped so a real drop reads as a positive number,
// floored at 0 when there's no real drop at all (every quarter-over-
// quarter diff non-negative) -- confirmed clean across 18 no-drop baseline
// cases (e.g. NVDA, TSM: minDiff is a large positive number, i.e. pure
// growth every quarter, and the driver value is exactly 0, not a negative
// number representing "best case").
//
// KNOWN GAP: for the ~8 of 155 baseline symbols that DO have a real drop
// (CRWD, NET, PANW, ABNB, GH, AXON, IOT, SPCX), this formula's sign and
// floor behavior are right but the MAGNITUDE is consistently off by
// 10-40% (e.g. CRWD: this formula gives 0.0040, real value is 0.0042).
// `assets[0]` alone and `mean(assets[0], assets[1])` were both tried as
// the denominator and neither reproduces the real value exactly for any
// of these 8 -- the real denominator is something else not yet
// identified. Left as an open item for scripts/rb-calibrate.ts rather
// than guessed further.
export function operatingIncomeDrop(raw: RbFundamentalsRaw): number | null {
  const qoi = raw.qoi, assets = raw.assets;
  if (!qoi || qoi.length < 2 || !assets || assets[0] == null || assets[0] === 0) return null;
  let minDiff = Infinity;
  for (let i = 1; i < qoi.length; i++) {
    const diff = qoi[i] - qoi[i - 1];
    if (diff < minDiff) minDiff = diff;
  }
  if (!Number.isFinite(minDiff)) return null;
  return Math.max(0, -minDiff / assets[0]);
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

export function cashFlowAfterStockPayOverSales(raw: RbFundamentalsRaw): number | null {
  const cfo = raw.cfo, rev = raw.rev;
  if (!cfo || !rev || raw.sbc == null) return null;
  return safeDiv(cfo[0] - raw.sbc, rev[0]);
}

export function returnOnInvestedCapital(raw: RbFundamentalsRaw): number | null {
  if (raw.ebit == null || raw.tax == null) return null;
  return safeDiv(raw.ebit * (1 - raw.tax), raw.ic);
}

// ── cash (feeds "Cash earnings" weak_pillar sub-score) ──

// Confirmed formula uses the SAME cash-after-stock-pay figure as `prof`
// above, not a naive (ni-cfo)/assets -- (ni - (cfo[0]-sbc)) / assets[0].
export function accruals(raw: RbFundamentalsRaw): number | null {
  const cfo = raw.cfo, assets = raw.assets;
  if (!cfo || !assets || assets[0] == null || assets[0] === 0 || raw.ni == null || raw.sbc == null) return null;
  const cashFlowAfterStockPay = cfo[0] - raw.sbc;
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
