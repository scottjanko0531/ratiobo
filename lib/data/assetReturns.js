/**
 * lib/data/assetReturns.js
 *
 * Fetches historical return data and estimated correlations from Supabase,
 * computes volatilities and the full correlation matrix, and returns a
 * ready-to-use { assets, corrMatrix, returnsByKey } object for the risk-parity
 * simulator.
 *
 * Caching: module-level singleton promise — one fetch+compute per browser
 * session. The source data changes at most annually, so re-fetching on every
 * page load is wasteful. If server components are adopted later, replace
 * _promise with React.cache() or next/cache unstable_cache.
 */

import { supabase } from "../supabase.js";
import { stdev, pearson } from "../riskParity.js";

// Display metadata — only name and color change between assets, not vol.
// Vol is computed from DB data so the UI stays current without a code deploy.
const ASSET_META = {
  eq:   { name: "US Equities",   color: "#4fb6a8" },
  intl: { name: "International", color: "#4E9ED4" },
  em:   { name: "EM Equities",   color: "#F28E2B" },
  nb:   { name: "Nominal Bonds", color: "#8b7fc7" },
  tip:  { name: "TIPS",          color: "#d9a441" },
  com:  { name: "Commodities",   color: "#c1685f" },
  gld:  { name: "Gold",          color: "#cfae6a" },
  cash: { name: "Cash",          color: "#6b7686" },
};

// Canonical display order for sliders / tables.
const ASSET_ORDER = ["eq", "intl", "em", "nb", "tip", "com", "gld", "cash"];

// TIPS lacks a long-run public total-return series; vol remains a fixed estimate.
// Its correlations come from asset_correlation_overrides with is_estimated = true.
const TIPS_ESTIMATED_VOL = 5;

// ── Singleton cache ────────────────────────────────────────────────────────
let _promise = null;

/**
 * Returns { assets, corrMatrix, returnsByKey }.
 *
 * assets      – Array<{ key, name, color, vol }> in ASSET_ORDER
 * corrMatrix  – { [key]: { [key]: number } } — full 6×6 matrix
 * returnsByKey – { [key]: number[] } — raw annual returns for data-backed assets
 *
 * Subsequent calls within the same browser session return the cached result
 * instantly. The cache is cleared on error so the next call can retry.
 */
export async function getAssetData() {
  if (_promise) return _promise;
  _promise = _load().catch((err) => {
    _promise = null; // allow retry after transient failure
    throw err;
  });
  return _promise;
}

/** Force a fresh fetch on the next getAssetData() call (e.g. after an admin update). */
export function invalidateAssetCache() {
  _promise = null;
}

// ── Internal loader ────────────────────────────────────────────────────────
async function _load() {
  const [
    { data: rows,      error: rowsErr },
    { data: overrides, error: ovErr   },
  ] = await Promise.all([
    supabase
      .from("asset_return_history")
      .select("asset_key, annual_return_pct")
      .order("year", { ascending: true }),
    supabase
      .from("asset_correlation_overrides")
      .select("asset_key_a, asset_key_b, correlation")
      .eq("is_estimated", true),
  ]);

  if (rowsErr) throw new Error(`asset_return_history: ${rowsErr.message}`);
  if (ovErr)   throw new Error(`asset_correlation_overrides: ${ovErr.message}`);

  // Group returns by key → { eq: [number, ...], nb: [...], ... }
  const returnsByKey = {};
  for (const row of rows ?? []) {
    (returnsByKey[row.asset_key] ??= []).push(Number(row.annual_return_pct));
  }

  const dataKeys = Object.keys(returnsByKey); // the 5 data-backed keys

  // Compute annualised volatility (sample stdev) for each data-backed asset.
  const volMap = Object.fromEntries(
    dataKeys.map((k) => [k, stdev(returnsByKey[k])])
  );
  volMap["tip"] = TIPS_ESTIMATED_VOL;

  // Build full correlation matrix — initialise all cells to 0.
  const corrMatrix = Object.fromEntries(
    ASSET_ORDER.map((k) => [k, Object.fromEntries(ASSET_ORDER.map((j) => [j, 0]))])
  );

  // Fill data-backed pairs with real Pearson correlations.
  for (const ki of dataKeys) {
    for (const kj of dataKeys) {
      corrMatrix[ki][kj] = ki === kj
        ? 1
        : pearson(returnsByKey[ki], returnsByKey[kj]);
    }
  }

  // Diagonal is always 1 (self-correlation).
  corrMatrix["tip"]["tip"] = 1;

  // Merge estimated TIPS correlations from DB, overwriting any placeholder 0s.
  for (const ov of overrides ?? []) {
    corrMatrix[ov.asset_key_a][ov.asset_key_b] = Number(ov.correlation);
  }

  // Build the assets array the riskParity functions consume.
  const assets = ASSET_ORDER.map((key) => ({
    key,
    ...ASSET_META[key],
    // Round to 1 dp so UI labels match the source HTML's display convention.
    vol: Math.round(volMap[key] * 10) / 10,
  }));

  return { assets, corrMatrix, returnsByKey };
}
