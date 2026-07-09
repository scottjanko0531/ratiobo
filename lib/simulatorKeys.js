// All 13 simulator bucket keys with display labels
export const SIMULATOR_KEYS = [
  { key: "eq",        label: "US Equities" },
  { key: "intl",      label: "International" },
  { key: "em",        label: "EM Equities" },
  { key: "nb",        label: "Nominal Bonds" },
  { key: "tip",       label: "TIPS" },
  { key: "com",       label: "Commodities" },
  { key: "gld",       label: "Gold" },
  { key: "cash",      label: "Cash" },
  { key: "alt_crypto", label: "Crypto" },
  { key: "alt_re",    label: "Real Estate" },
  { key: "alt_loan",  label: "Notes / Loans" },
  { key: "alt_pp",    label: "Private Placements" },
  { key: "alt_other", label: "Other" },
];

// ── Regime defaults ────────────────────────────────────────────────────────────
// Single source of truth for recommended allocations per regime.
// Used by both the Regime Simulator (slider defaults) and the Macro page
// (positioning signal). Derived from the simulator's regime return estimates —
// overweight assets with strong positive expected returns, zero out those with
// negative expected returns. Alts always start at 0.
export const REGIME_DEFAULT_WEIGHTS = {
  rg_fi: { eq: 35, intl: 15, em: 10, nb: 20, tip:  5, com:  5, gld:  5, cash:  5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  rg_ri: { eq: 20, intl: 10, em: 20, nb:  0, tip: 15, com: 20, gld: 10, cash:  5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_ri: { eq:  5, intl:  5, em:  0, nb:  0, tip: 20, com: 30, gld: 30, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_fi: { eq:  5, intl:  5, em:  0, nb: 65, tip:  0, com:  0, gld: 15, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
};

// Return the market-asset keys that are meaningfully favored for a regime.
// "Favored" = weight ≥ threshold in the regime defaults (excludes alt_ buckets).
// Sorted by weight descending so the most-favored appear first.
export function getSignalKeys(regimeKey, threshold = 10) {
  const w = REGIME_DEFAULT_WEIGHTS[regimeKey] ?? {};
  return Object.entries(w)
    .filter(([k, v]) => v >= threshold && !k.startsWith("alt_"))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

// ── Regime metadata ────────────────────────────────────────────────────────────
export const REGIME_META = {
  rg_fi: { label: "Disinflationary Boom", desc: "Growth ↑ · Inflation ↓", color: "text-gain" },
  rg_ri: { label: "Reflation",            desc: "Growth ↑ · Inflation ↑", color: "text-brass-soft" },
  fg_fi: { label: "Deflationary Bust",    desc: "Growth ↓ · Inflation ↓", color: "text-paper-dim" },
  fg_ri: { label: "Stagflation",          desc: "Growth ↓ · Inflation ↑", color: "text-loss" },
};

// Map GDP growth and CPI readings → regime key.
// breakeven: market-implied 10Y inflation expectation (T10YIE); default 2.5%
// gdp3yAvg:  3-year trailing avg GDP growth as trend baseline; default 0%
export function detectRegimeKey(gdpGrowth, cpiYoy, { breakeven = 2.5, gdp3yAvg = 0 } = {}) {
  const growing = gdpGrowth > gdp3yAvg;       // above trend → positive surprise
  const risingInflation = cpiYoy > breakeven;  // above market expectation → inflation surprise
  if (growing && !risingInflation) return "rg_fi";
  if (growing && risingInflation)  return "rg_ri";
  if (!growing && risingInflation) return "fg_ri";
  return "fg_fi";
}

// ── Holding → simulator key resolution ───────────────────────────────────────

// Coarse default: asset_type → simulator key (used when simulator_key is null)
const ASSET_TYPE_DEFAULT = {
  equity:          "eq",
  etf:             "eq",
  closed_end_fund: "eq",
  mutual_fund:     "eq",
  bond:            "nb",
  money_market:    "cash",
  cash:            "cash",
  crypto:          "alt_crypto",
  metal:           "gld",
};

export function defaultSimulatorKey(asset_type) {
  return ASSET_TYPE_DEFAULT[asset_type] ?? null;
}

// Use the holding's explicit override if set, else fall back to type default
export function resolveSimulatorKey(holding) {
  return holding.simulator_key ?? defaultSimulatorKey(holding.asset_type);
}

// ── Fractional → integer weights ─────────────────────────────────────────────
// Convert a { key: fraction } map to integer % weights summing to budget.
// Largest bucket absorbs rounding drift (same logic as the simulator).
export function toIntWeights(fractional, budget = 100) {
  const pct = Object.fromEntries(
    Object.entries(fractional).map(([k, v]) => [k, Math.round(v * budget)])
  );
  const drift = budget - Object.values(pct).reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    const top = Object.entries(pct).sort((a, b) => b[1] - a[1])[0];
    if (top) pct[top[0]] += drift;
  }
  return pct;
}

// ── Portfolio → integer weights ───────────────────────────────────────────────
// Convert a holdings array to integer % weights per simulator key (summing to 100).
export function holdingsToWeights(holdings) {
  const totals = {};
  let grand = 0;
  for (const h of holdings) {
    const val = Number(h.current_value ?? 0);
    if (val <= 0) continue;
    const key = resolveSimulatorKey(h);
    if (!key) continue;
    totals[key] = (totals[key] ?? 0) + val;
    grand += val;
  }
  if (grand === 0) return null;

  const fracs = Object.entries(totals).map(([k, v]) => ({ k, raw: (v / grand) * 100 }));
  const floored = Object.fromEntries(fracs.map(({ k, raw }) => [k, Math.floor(raw)]));
  const remainder = 100 - Object.values(floored).reduce((a, b) => a + b, 0);
  fracs
    .map(({ k, raw }) => ({ k, frac: raw - Math.floor(raw) }))
    .sort((a, b) => b.frac - a.frac)
    .slice(0, remainder)
    .forEach(({ k }) => { floored[k] += 1; });

  return floored;
}
