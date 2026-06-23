/**
 * lib/riskParity.js
 *
 * Pure math for risk-parity portfolio construction.
 * No DOM, no React, no Supabase — safe to import anywhere.
 *
 * Nomenclature used throughout:
 *   assets      – Array<{ key: string, vol: number, ... }>
 *   corrMatrix  – { [key]: { [key]: number } }  (symmetric, diagonal = 1)
 *   weightsObj  – { [key]: number }  (any positive scale; functions normalize internally)
 */

/** Arithmetic mean of a numeric array. */
export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Sample standard deviation (n-1 denominator). */
export function stdev(arr) {
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/** Pearson correlation coefficient between two equal-length arrays. */
export function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

/**
 * Covariance between asset i and asset j.
 * @param {string} i
 * @param {string} j
 * @param {{ [key: string]: { [key: string]: number } }} corrMatrix
 * @param {{ [key: string]: number }} volMap  key → annualised volatility (%)
 */
export function cov(i, j, corrMatrix, volMap) {
  return corrMatrix[i][j] * volMap[i] * volMap[j];
}

/**
 * Compute each asset's marginal contribution to total portfolio variance,
 * expressed as a percentage of total risk.
 *
 * @param {{ [key: string]: number }} weightsObj  dollar weights (any scale)
 * @param {Array<{ key: string, vol: number }>} assets
 * @param {{ [key: string]: { [key: string]: number } }} corrMatrix
 * @returns {{ portfolioVol: number, contributions: { [key: string]: number } }}
 *   portfolioVol in same units as asset vols; contributions sum to ~100.
 */
export function computeRiskContributions(weightsObj, assets, corrMatrix) {
  const volMap = Object.fromEntries(assets.map((a) => [a.key, a.vol]));
  const total = Object.values(weightsObj).reduce((a, b) => a + b, 0) || 1;
  const w = Object.fromEntries(assets.map((a) => [a.key, weightsObj[a.key] / total]));

  // Marginal contribution to risk: (Cov · w)_i = Σ_j cov(i,j) · w_j
  const mctr = {};
  assets.forEach((a) => {
    let sum = 0;
    assets.forEach((b) => { sum += cov(a.key, b.key, corrMatrix, volMap) * w[b.key]; });
    mctr[a.key] = sum;
  });

  // Portfolio variance = Σ_i w_i · mctr_i
  let portVar = 0;
  assets.forEach((a) => { portVar += w[a.key] * mctr[a.key]; });
  const portfolioVol = Math.sqrt(Math.max(portVar, 0));

  // Risk contribution_i = w_i · mctr_i / portVar (normalised to %)
  const contributions = {};
  assets.forEach((a) => {
    const rc = w[a.key] * mctr[a.key];
    contributions[a.key] = portVar > 0 ? (rc / portVar) * 100 : 0;
  });

  return { portfolioVol, contributions };
}

/**
 * Iterative solver: find weights where every asset's risk contribution is equal,
 * accounting for the full correlation structure (true risk parity).
 *
 * Uses the multiplicative update rule:
 *   w_i ← w_i · √(avgRC / RC_i),  then renormalise.
 *
 * Converges in <200 iterations for well-conditioned correlation matrices.
 *
 * @param {Array<{ key: string, vol: number }>} assets
 * @param {{ [key: string]: { [key: string]: number } }} corrMatrix
 * @returns {{ [key: string]: number }}  fractional weights summing to 1
 */
export function solveTrueRiskParity(assets, corrMatrix) {
  const volMap = Object.fromEntries(assets.map((a) => [a.key, a.vol]));
  const w = Object.fromEntries(assets.map((a) => [a.key, 1 / assets.length]));

  for (let iter = 0; iter < 500; iter++) {
    const mctr = {};
    assets.forEach((a) => {
      let sum = 0;
      assets.forEach((b) => { sum += cov(a.key, b.key, corrMatrix, volMap) * w[b.key]; });
      mctr[a.key] = sum;
    });

    let portVar = 0;
    assets.forEach((a) => { portVar += w[a.key] * mctr[a.key]; });
    if (portVar <= 0) portVar = 1e-6;

    const rc = Object.fromEntries(assets.map((a) => [a.key, w[a.key] * mctr[a.key]]));
    const avgRC = portVar / assets.length;

    // Damped fractional-power step: clamp ratio to [0.5, 2] then raise to 0.15.
    // Slower per iteration than sqrt but stable across 500 iterations — avoids
    // the oscillation that sqrt can produce with a high-dimensional corr matrix.
    assets.forEach((a) => {
      let ratio = rc[a.key] > 0 ? (avgRC / rc[a.key]) : 1.6;
      ratio = Math.max(0.5, Math.min(ratio, 2));
      w[a.key] = Math.max(w[a.key] * Math.pow(ratio, 0.15), 0.001);
    });

    const sumW = Object.values(w).reduce((a, b) => a + b, 0);
    assets.forEach((a) => { w[a.key] = w[a.key] / sumW; });
  }

  return w; // caller formats to % or rounds as needed
}

/**
 * Naive risk parity: weight_i ∝ 1/vol_i.
 * Ignores correlation — each asset weighted inversely to its own volatility.
 *
 * @param {Array<{ key: string, vol: number }>} assets
 * @returns {{ [key: string]: number }}  fractional weights summing to 1
 */
export function applyNaiveRiskParity(assets) {
  const invVols = Object.fromEntries(assets.map((a) => [a.key, 1 / a.vol]));
  const sumInv = Object.values(invVols).reduce((a, b) => a + b, 0);
  return Object.fromEntries(assets.map((a) => [a.key, invVols[a.key] / sumInv]));
}

/**
 * Leverage multiplier required to reach a target portfolio volatility.
 * Capped to avoid runaway leverage.
 *
 * @param {number} unleveredVol  current portfolio volatility (same units as targetVol)
 * @param {number} targetVol     desired volatility
 * @param {number} [cap=4]       maximum allowed multiplier
 * @returns {number}
 */
export function getLeverageMultiplier(unleveredVol, targetVol, cap = 4) {
  if (unleveredVol <= 0) return 1;
  return Math.max(0.1, Math.min(targetVol / unleveredVol, cap));
}
