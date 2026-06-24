/**
 * lib/altAssets.js
 *
 * Constants, corrMatrix extension logic, and DB helpers for the five
 * user-configurable alternative asset categories in the Regime Simulator.
 *
 * Alt assets differ from market assets in three ways:
 *   1. No public return series — vol comes from user input, not DB stdev.
 *   2. Correlations vs market assets are profile-based, not Pearson-computed.
 *   3. Regime return estimates are user-supplied, not hardcoded research figures.
 */

import { supabase } from "./supabase.js";

// ── Alt asset definitions ────────────────────────────────────────────────────

export const ALT_META = [
  {
    key: "alt_crypto",
    name: "Crypto",
    color: "#E040A0",
    defaultVol: 75,
    defaultProfile: "diversifier",
    defaultReturns: { rg_ri: 25, rg_fi: 15, fg_ri: -30, fg_fi: -45 },
  },
  {
    key: "alt_re",
    name: "Real Estate",
    color: "#4DB76A",
    defaultVol: 15,
    defaultProfile: "inflation",
    defaultReturns: { rg_ri: 8, rg_fi: 5, fg_ri: 2, fg_fi: -10 },
  },
  {
    key: "alt_loan",
    name: "Notes / Loans",
    color: "#74AAEE",
    defaultVol: 8,
    defaultProfile: "bond",
    defaultReturns: { rg_ri: 3, rg_fi: 5, fg_ri: 1, fg_fi: 4 },
  },
  {
    key: "alt_pp",
    name: "Private Placements",
    color: "#B07FC4",
    defaultVol: 30,
    defaultProfile: "equity",
    defaultReturns: { rg_ri: 10, rg_fi: 14, fg_ri: -12, fg_fi: -20 },
  },
  {
    key: "alt_other",
    name: "Other",
    color: "#9BAAB8",
    defaultVol: 20,
    defaultProfile: "diversifier",
    defaultReturns: { rg_ri: 5, rg_fi: 5, fg_ri: -5, fg_fi: -10 },
  },
];

export const ALT_KEYS = new Set(ALT_META.map((a) => a.key));

// ── Correlation profiles ─────────────────────────────────────────────────────
// Each profile provides a correlation vector vs the 8 market assets.
// Users pick the profile that best describes how their alt holding behaves.

export const CORRELATION_PROFILES = {
  equity: {
    label: "Equity-like",
    description: "Moves with equities — private equity, growth ventures",
    corr: { eq: 0.75, intl: 0.65, em: 0.60, nb: -0.25, tip: -0.10, com: 0.20, gld: -0.05, cash: -0.05 },
  },
  bond: {
    label: "Bond-like",
    description: "Income-oriented, low vol — private credit, senior loans",
    corr: { eq: -0.15, intl: -0.10, em: -0.05, nb: 0.65, tip: 0.45, com: -0.10, gld: 0.10, cash: 0.20 },
  },
  inflation: {
    label: "Inflation-hedge",
    description: "Rises with prices — real assets, infrastructure, farmland",
    corr: { eq: -0.05, intl: 0.00, em: 0.10, nb: -0.25, tip: 0.45, com: 0.55, gld: 0.50, cash: 0.00 },
  },
  diversifier: {
    label: "Diversifier",
    description: "Low correlation to everything — crypto, global macro",
    corr: { eq: 0.10, intl: 0.10, em: 0.15, nb: 0.05, tip: 0.05, com: 0.20, gld: 0.15, cash: 0.00 },
  },
};

// Cross-profile correlation between two alt assets (keyed by sorted profile pair).
const CROSS_CORR = {
  "equity-equity":          0.65,
  "bond-equity":           -0.15,
  "equity-inflation":       0.10,
  "diversifier-equity":     0.15,
  "bond-bond":              0.60,
  "bond-inflation":        -0.05,
  "bond-diversifier":       0.05,
  "inflation-inflation":    0.50,
  "diversifier-inflation":  0.10,
  "diversifier-diversifier":0.25,
};

function crossCorr(pA, pB) {
  return CROSS_CORR[[pA, pB].sort().join("-")] ?? 0.10;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/**
 * Converts the raw DB assumptions map (key → DB row) into asset objects
 * ready for the simulator, falling back to per-category defaults.
 *
 * @param {{ [key: string]: { vol: number, correlation_profile: string, regime_returns: object } }} assumptionsMap
 * @returns {Array<{ key, name, color, vol, correlationProfile, regimeReturns }>}
 */
export function buildAltAssets(assumptionsMap) {
  return ALT_META.map((meta) => {
    const saved = assumptionsMap[meta.key];
    return {
      key: meta.key,
      name: meta.name,
      color: meta.color,
      vol: saved?.vol ?? meta.defaultVol,
      correlationProfile: saved?.correlation_profile ?? meta.defaultProfile,
      regimeReturns: saved?.regime_returns ?? meta.defaultReturns,
    };
  });
}

/**
 * Extends the market-only corrMatrix to include all five alt assets.
 * Alt vs market:  from the alt's correlation profile.
 * Alt vs alt:     from the cross-profile lookup table.
 * Alt self:       1.0.
 *
 * @param {Record<string, Record<string, number>>} corrMatrix  8×8 market matrix
 * @param {Array<{ key: string }>} marketAssets
 * @param {Array<{ key: string, correlationProfile: string }>} altAssets
 * @returns {Record<string, Record<string, number>>}  extended matrix
 */
export function extendCorrMatrix(corrMatrix, marketAssets, altAssets) {
  // Shallow-copy each row so we don't mutate the cached market matrix.
  const m = Object.fromEntries(
    Object.entries(corrMatrix).map(([k, v]) => [k, { ...v }])
  );

  // Initialise alt rows with self-correlation.
  altAssets.forEach((a) => { m[a.key] = { [a.key]: 1.0 }; });

  // Alt ↔ market correlations.
  altAssets.forEach((alt) => {
    const profileCorr = CORRELATION_PROFILES[alt.correlationProfile]?.corr ?? {};
    marketAssets.forEach((mkt) => {
      const c = profileCorr[mkt.key] ?? 0;
      m[alt.key][mkt.key] = c;
      m[mkt.key][alt.key] = c;
    });
  });

  // Alt ↔ alt correlations.
  altAssets.forEach((a) => {
    altAssets.forEach((b) => {
      if (a.key === b.key || m[a.key][b.key] !== undefined) return;
      const c = crossCorr(a.correlationProfile, b.correlationProfile);
      m[a.key][b.key] = c;
      m[b.key][a.key] = c;
    });
  });

  return m;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Fetches the user's saved alt assumptions. Returns a map of asset_key → DB row.
 * Returns an empty object on error or when no rows exist.
 */
export async function loadAltAssumptions(userId) {
  const { data, error } = await supabase
    .from("user_asset_assumptions")
    .select("asset_key, vol, correlation_profile, regime_returns")
    .eq("user_id", userId);
  if (error || !data) return {};
  return Object.fromEntries(data.map((row) => [row.asset_key, row]));
}

/**
 * Upserts one alt's assumptions for the logged-in user.
 *
 * @param {string} userId
 * @param {string} assetKey
 * @param {{ vol: number, correlationProfile: string, regimeReturns: object }} assumptions
 */
export async function saveAltAssumption(userId, assetKey, { vol, correlationProfile, regimeReturns }) {
  return supabase
    .from("user_asset_assumptions")
    .upsert(
      {
        user_id: userId,
        asset_key: assetKey,
        vol,
        correlation_profile: correlationProfile,
        regime_returns: regimeReturns,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,asset_key" }
    );
}
