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

// Use override if set, fall back to type default
export function resolveSimulatorKey(holding) {
  return holding.simulator_key ?? defaultSimulatorKey(holding.asset_type);
}

// Quadrant asset label → simulator keys (for macro page exposure)
export const LABEL_TO_KEYS = {
  "Equities":        ["eq", "intl", "em"],
  "EM Equities":     ["em"],
  "Corporate Bonds": ["nb"],
  "Real Estate":     ["alt_re"],
  "Commodities":     ["com"],
  "TIPS":            ["tip"],
  "Energy":          ["com"],
  "Nominal Bonds":   ["nb"],
  "USD":             ["cash"],
  "Cash":            ["cash"],
  "Gold":            ["gld"],
  "Hard Assets":     ["com", "gld"],
  "Short Duration":  ["cash", "nb"],
};

// Convert holdings array → integer weights (summing to 100) by simulator key
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

  // Floor all, then distribute remainder to largest fractional parts
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
