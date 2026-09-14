// Display-only mirror of supabase/functions/_shared/paradigmMetrics.ts —
// same metric definitions, kept in sync by hand (a Deno edge function and
// this Next.js frontend can't literally share a module; same convention
// already used for REGIME_DEFAULT_WEIGHTS_PCT vs. lib/simulatorKeys.js).
// Only the fields the drill-down UI needs to render "transparent math" —
// no fetch/compute logic lives here, the edge function is the sole source
// of truth for actual scores.

export const PARADIGM_METRICS = [
  // ── Paradigm A: Origin — Fiscal Dominance ──────────────────────────────
  {
    key: "fiscal_balance_gdp", label: "Federal Surplus/Deficit (% GDP)",
    paradigms: ["A"],
    orientationDescription: "more negative (larger deficit) confirms Paradigm A",
    formulaDescription: "FYFSGDA188S, annual, direct",
  },
  {
    key: "debt_gdp", label: "Federal Debt (% GDP)",
    paradigms: ["A"],
    orientationDescription: "rising confirms Paradigm A",
    formulaDescription: "GFDEGDQ188S, quarterly, direct",
  },
  {
    key: "fed_treasury_share", label: "Fed Treasury Holdings Share",
    paradigms: ["A"],
    orientationDescription: "falling Fed share (inverse proxy for rising private-nonbank share) confirms Paradigm A — documented inversion, not a raw reading",
    formulaDescription: "TREAST / GFDEBTN, weekly vs. quarterly (most recent of each)",
  },

  // ── Paradigm B: Cut ─────────────────────────────────────────────────────
  {
    key: "gov_expenditures_gdp", label: "Federal Expenditures (% GDP)",
    paradigms: ["B"],
    orientationDescription: "falling confirms Paradigm B",
    formulaDescription: "FGEXPND / GDP, quarterly",
  },
  {
    key: "trade_gdp", label: "Trade / GDP Ratio",
    paradigms: ["B", "E"],
    orientationDescription: "falling (narrowing deficit) confirms Paradigm B; sustained decline also confirms Paradigm E",
    formulaDescription: "(EXPGS + IMPGS) / GDP, quarterly",
  },

  // ── Paradigm C: Grow ────────────────────────────────────────────────────
  {
    key: "gdp_yoy", label: "Nominal GDP (YoY)",
    paradigms: ["C"],
    orientationDescription: "rising (outrunning debt growth) confirms Paradigm C",
    formulaDescription: "GDP, YoY % change, quarterly",
  },
  {
    key: "corp_profits_gdi", label: "Corporate Profits / GDI",
    paradigms: ["C"],
    orientationDescription: "rising confirms Paradigm C",
    formulaDescription: "CP / GDI (both nominal), quarterly",
  },
  {
    key: "valuation_proxy", label: "S&P 500 / GDP (\"Buffett Indicator\" proxy)",
    paradigms: ["C"],
    orientationDescription: "elevated relative to its own trailing history confirms Paradigm C",
    formulaDescription: "SP500 / GDP — substituted for the original Wilshire 5000 proxy, discontinued by FRED June 2024; narrower breadth (500 large-caps vs. total market), same spirit",
  },

  // ── Paradigm D: Print ───────────────────────────────────────────────────
  {
    key: "real_10y_yield", label: "Real 10-Year Yield",
    paradigms: ["D"],
    orientationDescription: "falling/negative confirms Paradigm D",
    formulaDescription: "DFII10, daily, direct",
  },
  {
    key: "m2_yoy", label: "M2 Money Supply (YoY)",
    paradigms: ["D"],
    orientationDescription: "accelerating confirms Paradigm D",
    formulaDescription: "M2SL, YoY % change, monthly",
  },
  {
    key: "dollar_yoy", label: "Broad Dollar Index (YoY)",
    paradigms: ["D"],
    orientationDescription: "falling (dollar weakness, inverse proxy for gold — no FRED gold series exists) confirms Paradigm D",
    formulaDescription: "DTWEXBGS, YoY % change, daily",
  },

  // ── Paradigm E: Total War (structurally low-coverage) ──────────────────
  {
    key: "defense_spending_gdp_yoy", label: "National Defense Spending (% GDP, YoY)",
    paradigms: ["E"],
    orientationDescription: "accelerating (fiscal mobilization posture) confirms Paradigm E",
    formulaDescription: "YoY % change of (A997RC1Q027SBEA / GDP), quarterly",
  },
];

// Global War Deaths and Immigration YoY (Paradigm E's other two original
// signals) were dropped entirely — no FRED equivalent exists. Paradigm E
// always shows "Low Coverage" regardless of whether its 2 real metrics
// fetched successfully today; the gap is structural, not a fetch failure.
export const LOW_COVERAGE_PARADIGMS = ["E"];

export const PARADIGM_NAMES = {
  A: "Origin — Fiscal Dominance",
  B: "Cut",
  C: "Grow",
  D: "Print",
  E: "Total War",
};

export function metricsForParadigm(paradigm) {
  return PARADIGM_METRICS.filter((m) => m.paradigms.includes(paradigm));
}
