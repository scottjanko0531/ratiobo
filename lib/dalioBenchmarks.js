// Hardcoded reference points from Ray Dalio's published commentary on the
// debt cycle ("How Countries Go Broke," 2025-2026) — NOT live data. Each
// entry pairs a citation/date so staleness is visible in the UI rather than
// silently drifting; if Dalio publishes updated figures, update these
// values and citedDate together, don't just bump the number.
//
// compareToMetricKey maps to a big_cycle_metrics.key for a live-vs-benchmark
// comparison row. Also duplicated (numeric values only) as a small inline
// constant in supabase/functions/generate-debt-cycle-brief/index.ts — keep
// both in sync if these change.
export const DALIO_BENCHMARKS = [
  {
    key: "interest_expense_pct_revenue",
    label: "Interest Expense — Danger Threshold",
    value: 20,
    unit: "%",
    compareToMetricKey: "interest_expense_revenue_pct",
    citation: "Ray Dalio, \"How Countries Go Broke\" (2025)",
    citedDate: "2025",
    note: "Dalio's rule of thumb: interest expense above ~20% of government revenue signals debt service materially crowding out other spending.",
  },
  {
    key: "debt_to_revenue_now",
    label: "Debt / Revenue — Current Reference",
    value: 6,
    unit: "x",
    compareToMetricKey: "debt_tax_revenue_multiple",
    citation: "Dalio, \"How Countries Go Broke\" (2025)",
    citedDate: "2025",
    note: "Roughly where Dalio places US federal debt relative to tax revenue as of his most recent public commentary.",
  },
  {
    key: "debt_to_revenue_10yr",
    label: "Debt / Revenue — 10-Year Trajectory",
    value: 7,
    unit: "x",
    compareToMetricKey: "debt_tax_revenue_multiple",
    citation: "Dalio, \"How Countries Go Broke\" (2025)",
    citedDate: "2025",
    note: "Dalio's projected debt/revenue multiple in 10 years absent a course correction.",
  },
  {
    key: "deficit_soft_landing",
    label: "Deficit — Soft-Landing Target",
    value: 3,
    unit: "% of GDP",
    compareToMetricKey: "deficit_pct_gdp",
    citation: "Dalio, \"The 3% 3-Part Solution\"",
    citedDate: "2025",
    note: "The \"3% 3-part solution\": ~5% spending cuts + ~5% revenue increases + ~1–1.5% decline in average interest rates, together bringing the deficit to ~3% of GDP.",
  },
];
