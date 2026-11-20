// Fiscal Policy Paradigm metric mapping (42 Macro's Paradigm A-E framework,
// build spec Section 3) — the ONE place these 13 metric definitions live,
// consumed by update-big-cycle-paradigm-metrics for fetching/computing and
// mirrored (display fields only, no fetch logic) in lib/paradigmMetrics.js
// for the frontend drill-down. Kept in sync by hand — same convention
// already used for REGIME_DEFAULT_WEIGHTS_PCT (run-backtest/index.ts vs.
// lib/simulatorKeys.js), since a Deno edge function and a Next.js frontend
// can't literally share a module.
//
// Two FRED-ID corrections vs. the original build spec's own "candidate"
// mnemonics (verified against live FRED series pages before use):
//   - Federal expenditures: spec's W068RCQ027SBEA is ALL-government
//     (federal+state+local); FGEXPND is the actual federal-only series.
//   - Corporate Profits/GDI: spec's A261RX1Q020SBEA is REAL (chained-
//     dollar) GDI, a nominal/real mismatch against nominal CP; GDI
//     (nominal) is correct.
// One substitution:
//   - CAPE proxy: WILL5000PRFC (Wilshire 5000) was discontinued by FRED in
//     June 2024, no direct replacement exists there. Substituted with
//     SP500/GDP — same "market cap relative to economy" spirit as the
//     Buffett Indicator, narrower breadth (500 large-caps vs. total
//     market), full 3-metric coverage kept for Paradigm C.

export type Paradigm = "A" | "B" | "C" | "D" | "E";
export type FormulaType = "direct" | "yoy" | "ratio" | "ratio_yoy" | "bridged_ratio";

export interface ParadigmMetricDef {
  key: string;
  label: string;
  // Which paradigm composite(s) this metric's score feeds into. Almost
  // always one paradigm — trade_gdp is the sole exception, reused
  // unmodified in both B (Cut) and E (Total War), per the spec.
  paradigms: Paradigm[];
  formula: FormulaType;
  // direct / yoy:
  fredSeriesId?: string;
  // ratio / ratio_yoy: numerator series are SUMMED before dividing (the
  // only metric needing more than one numerator is trade_gdp: EXPGS+IMPGS).
  numeratorSeriesIds?: string[];
  denominatorSeriesId?: string;
  // bridged_ratio only (valuation_proxy): a quarterly dollar-denominated
  // numerator (fredSeriesId) scaled forward between its own releases by
  // a daily market index's (bridgeMarketSeriesId) own % change since that
  // quarter's end — see _shared/z1Bridge.ts. denominatorSeriesId is still
  // GDP, read at whatever's most recently known as of each date (same
  // "latest known as of" convention every other ratio here already uses).
  bridgeMarketSeriesId?: string;
  // Fixed in code, never adjustable at runtime (spec 2 "no hand-picked
  // weights" / "fixed thresholds") — +1 if a rising oriented_z means more
  // evidence for the paradigm as-is, -1 if the raw metric's natural
  // direction has to be inverted to mean that.
  orientationSign: 1 | -1;
  orientationDescription: string;
  formulaDescription: string;
}

export const PARADIGM_METRICS: ParadigmMetricDef[] = [
  // ── Paradigm A: Origin — Fiscal Dominance ──────────────────────────────
  {
    key: "fiscal_balance_gdp", label: "Federal Surplus/Deficit (% GDP)",
    paradigms: ["A"], formula: "direct", fredSeriesId: "FYFSGDA188S",
    orientationSign: -1, orientationDescription: "more negative (larger deficit) confirms Paradigm A",
    formulaDescription: "FYFSGDA188S, annual, direct",
  },
  {
    key: "debt_gdp", label: "Federal Debt (% GDP)",
    paradigms: ["A"], formula: "direct", fredSeriesId: "GFDEGDQ188S",
    orientationSign: 1, orientationDescription: "rising confirms Paradigm A",
    formulaDescription: "GFDEGDQ188S, quarterly, direct",
  },
  {
    key: "fed_treasury_share", label: "Fed Treasury Holdings Share",
    paradigms: ["A"], formula: "ratio",
    numeratorSeriesIds: ["TREAST"], denominatorSeriesId: "GFDEBTN",
    orientationSign: -1,
    orientationDescription: "falling Fed share (inverse proxy for rising private-nonbank share) confirms Paradigm A — documented inversion, not a raw reading",
    formulaDescription: "TREAST / GFDEBTN, weekly vs. quarterly (most recent of each)",
  },

  // ── Paradigm B: Cut ─────────────────────────────────────────────────────
  {
    key: "gov_expenditures_gdp", label: "Federal Expenditures (% GDP)",
    paradigms: ["B"], formula: "ratio",
    numeratorSeriesIds: ["FGEXPND"], denominatorSeriesId: "GDP",
    orientationSign: -1, orientationDescription: "falling confirms Paradigm B",
    formulaDescription: "FGEXPND / GDP, quarterly",
  },
  {
    key: "trade_gdp", label: "Trade / GDP Ratio",
    paradigms: ["B", "E"], formula: "ratio",
    numeratorSeriesIds: ["EXPGS", "IMPGS"], denominatorSeriesId: "GDP",
    orientationSign: -1,
    orientationDescription: "falling (narrowing deficit) confirms Paradigm B; sustained decline also confirms Paradigm E",
    formulaDescription: "(EXPGS + IMPGS) / GDP, quarterly",
  },

  // ── Paradigm C: Grow ────────────────────────────────────────────────────
  {
    key: "gdp_yoy", label: "Nominal GDP (YoY)",
    paradigms: ["C"], formula: "yoy", fredSeriesId: "GDP",
    orientationSign: 1, orientationDescription: "rising (outrunning debt growth) confirms Paradigm C",
    formulaDescription: "GDP, YoY % change, quarterly",
  },
  {
    key: "corp_profits_gdi", label: "Corporate Profits / GDI",
    paradigms: ["C"], formula: "ratio",
    numeratorSeriesIds: ["CP"], denominatorSeriesId: "GDI",
    orientationSign: 1, orientationDescription: "rising confirms Paradigm C",
    formulaDescription: "CP / GDI (both nominal), quarterly",
  },
  {
    // Live-site issue (Scott, 2026-11-20): the original SP500/GDP
    // substitution read ~0.23, roughly 10x off the real Buffett
    // Indicator's normal range -- confirmed NOT a units bug (GDP is
    // correctly in $bn; scaling it to $tn would make the ratio WORSE,
    // not better). The real problem: SP500 is a dimensionless INDEX
    // LEVEL, not a dollar figure, so dividing it by GDP can never be
    // comparable to the real indicator (total market cap / GDP, both in
    // $) regardless of units. Fixed by switching the numerator to
    // BOGZ1LM893064105Q (Fed Z.1, "All Sectors; Corporate Equities;
    // Asset, Market Value Levels" -- confirmed to exist and be
    // dollar-denominated via a direct FRED call before using it,
    // $123.69tn as of Q2 2026), bridged forward between its quarterly
    // releases by SP500's own % change since that quarter's end (see
    // _shared/z1Bridge.ts) so the card still updates daily/live. This
    // is the standard practitioner substitute for the Buffett
    // Indicator's original Wilshire 5000 total-market numerator
    // (WILL5000PRFC, discontinued by FRED June 2024) when Wilshire data
    // is unavailable -- genuinely comparable to the real indicator now,
    // not a renamed same-mismatch.
    key: "valuation_proxy", label: "Z.1 all-equity / GDP",
    paradigms: ["C"], formula: "bridged_ratio",
    fredSeriesId: "BOGZ1LM893064105Q", bridgeMarketSeriesId: "SP500", denominatorSeriesId: "GDP",
    orientationSign: 1,
    orientationDescription: "elevated relative to its own trailing history confirms Paradigm C",
    formulaDescription: "BOGZ1LM893064105Q (all-sectors corporate equities, market value) / GDP, bridged forward between quarterly Z.1 releases by SP500's own % change since that quarter's end",
  },

  // ── Paradigm D: Print ───────────────────────────────────────────────────
  {
    key: "real_10y_yield", label: "Real 10-Year Yield",
    paradigms: ["D"], formula: "direct", fredSeriesId: "DFII10",
    orientationSign: -1, orientationDescription: "falling/negative confirms Paradigm D",
    formulaDescription: "DFII10, daily, direct",
  },
  {
    key: "m2_yoy", label: "M2 Money Supply (YoY)",
    paradigms: ["D"], formula: "yoy", fredSeriesId: "M2SL",
    orientationSign: 1, orientationDescription: "accelerating confirms Paradigm D",
    formulaDescription: "M2SL, YoY % change, monthly",
  },
  {
    key: "dollar_yoy", label: "Broad Dollar Index (YoY)",
    paradigms: ["D"], formula: "yoy", fredSeriesId: "DTWEXBGS",
    orientationSign: -1,
    orientationDescription: "falling (dollar weakness, inverse proxy for gold — no FRED gold series exists) confirms Paradigm D",
    formulaDescription: "DTWEXBGS, YoY % change, daily",
  },

  // ── Paradigm E: Total War (structurally low-coverage — see build spec) ──
  {
    key: "defense_spending_gdp_yoy", label: "National Defense Spending (% GDP, YoY)",
    paradigms: ["E"], formula: "ratio_yoy",
    numeratorSeriesIds: ["A997RC1Q027SBEA"], denominatorSeriesId: "GDP",
    orientationSign: 1,
    orientationDescription: "accelerating (fiscal mobilization posture) confirms Paradigm E",
    formulaDescription: "YoY % change of (A997RC1Q027SBEA / GDP), quarterly",
  },
];

// Global War Deaths and Immigration YoY (Paradigm E's other two original
// signals) are DROPPED, not degraded-and-flagged — there is no FRED
// equivalent for either, so they were never wired in at all. Paradigm E
// runs on 2 of its original 3 signals, one of them reused from B — always
// shown with a "Low Coverage" badge in the UI regardless of whether both
// of its 2 real metrics fetch successfully on a given day, since the gap
// is structural, not a fetch failure.
export const LOW_COVERAGE_PARADIGMS: Paradigm[] = ["E"];
