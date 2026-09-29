import { resolveSimulatorKey, EQUITY_KEYS } from "./simulatorKeys";

// Symbol -> multiplier map applying the Market Conditions overlay's single
// global exposure_multiplier to every equity-classified holding, and leaving
// everything else unscaled (absent from the map = 1 under mergeExposureMultipliers).
export function marketOverlayMultipliersBySymbol(holdings, exposureMultiplier, equityKeys = EQUITY_KEYS) {
  const out = {};
  for (const h of holdings ?? []) {
    if (!h?.symbol) continue;
    const key = resolveSimulatorKey(h);
    if (key && equityKeys.has(key)) out[h.symbol] = exposureMultiplier;
  }
  return out;
}

// Combine the market overlay's per-symbol multiplier map with the AI Capex
// Cycle overlay's per-symbol map using MIN (the tighter cut wins) rather
// than the product used elsewhere (resize x capex, see mergeExposureMultipliers
// in lib/capexOverlay.js). Those two are genuinely independent, multiplicative
// signals (a symbol-specific trend/vol rule x a top-down capex-cycle cut);
// market-conditions and capex are instead two different reads of overlapping
// broad-drawdown risk, so multiplying them would double-count the same risk.
// MIN says "the worse of the two reads governs" instead.
//
// Only touches symbols already in marketMultipliers (equity-classified
// holdings the market overlay applies to) — a capex-only cut on a
// non-equity symbol is untouched here and picked up separately in
// combineAllOverlays below.
//
// Returns { multipliers, binding } where binding[symbol] is "market",
// "capex", or "tie" (equal, market wins ties for display purposes).
export function combineWithCapexOverlay(marketMultipliers, capexMultipliers = {}) {
  const multipliers = {};
  const binding = {};
  for (const [sym, m] of Object.entries(marketMultipliers ?? {})) {
    const c = capexMultipliers[sym];
    if (c == null) { multipliers[sym] = m; binding[sym] = "market"; continue; }
    if (m < c) { multipliers[sym] = m; binding[sym] = "market"; }
    else if (c < m) { multipliers[sym] = c; binding[sym] = "capex"; }
    else { multipliers[sym] = m; binding[sym] = "tie"; }
  }
  return { multipliers, binding };
}

// Full combination of all three exposure-cutting mechanisms a portfolio can
// carry at once: the existing per-symbol resize overlay (asset_resize_signals
// -- idiosyncratic, symbol-specific technical rules: VT's trailing drawdown,
// GLDM's vol regime, FBTC's trend MA), the AI Capex Cycle overlay, and the
// Market Conditions overlay (broad SPY-based tier). Resize is orthogonal to
// the other two (a different KIND of signal, calibrated per-symbol) so it
// always multiplies on top -- same independent-signal relationship resize
// already has with capex elsewhere (mergeExposureMultipliers in
// lib/capexOverlay.js). Capex and market overlap (both broad-drawdown reads)
// so, where both apply to the same equity symbol, MIN governs instead of
// multiplying (combineWithCapexOverlay above) -- a capex cut on a
// non-equity symbol (outside the market overlay's scope) still applies on
// its own, undiluted.
//
// Returns { multipliers, binding }, binding only set for symbols the
// market/capex MIN comparison actually touched.
export function combineAllOverlays(resizeMultipliers = {}, capexMultipliers = {}, marketMultipliers = {}, capexApplied = false) {
  const { multipliers: topDown, binding } = capexApplied
    ? combineWithCapexOverlay(marketMultipliers, capexMultipliers)
    : { multipliers: marketMultipliers, binding: {} };

  const symbols = new Set([
    ...Object.keys(resizeMultipliers),
    ...(capexApplied ? Object.keys(capexMultipliers) : []),
    ...Object.keys(marketMultipliers),
  ]);
  const multipliers = {};
  for (const sym of symbols) {
    const resizeMult = resizeMultipliers[sym] ?? 1;
    const topDownMult = topDown[sym] ?? (capexApplied ? (capexMultipliers[sym] ?? 1) : 1);
    multipliers[sym] = resizeMult * topDownMult;
  }
  return { multipliers, binding };
}

// Value-weighted average multiplier for a set of holdings sharing a bucket —
// same convention as the existing resize-overlay freed-weight block in
// app/portfolios/page.jsx (avgMultFor). Needed once per-symbol multipliers
// can differ within a bucket (e.g. capex binding for one equity holding but
// not another, or a resize signal that only covers some symbols in a bucket).
function avgMultiplierForBucket(holdingsInBucket, multipliersBySymbol) {
  let total = 0, weighted = 0;
  for (const h of holdingsInBucket) {
    const val = Number(h.current_value ?? 0);
    const m = multipliersBySymbol[h.symbol] ?? 1;
    total += val;
    weighted += val * m;
  }
  if (total > 0) return weighted / total;
  if (holdingsInBucket.length === 0) return 1;
  return holdingsInBucket.reduce((s, h) => s + (multipliersBySymbol[h.symbol] ?? 1), 0) / holdingsInBucket.length;
}

// Freed weight from scaling EVERY bucket's target by its holdings'
// value-weighted average multiplier, added onto the cash target — not
// equity-only. A resize/capex cut can hit any bucket (e.g. KISS's GLDM, a
// "gld" holding under a live vol-regime cut), and cash needs to reflect that
// regardless of whether the market-conditions overlay is touching equity at
// all; restricting this to equity buckets was the bug that made a portfolio
// with an active non-equity resize cut (all freed weight parked in cash
// already) look like it wanted its whole cash sleeve sold back into equity,
// because the baseline computed here never credited that non-equity cut.
// Only the cash entry changes; the other buckets' own target values are
// left as-is because computeAllocationDeltas applies the per-symbol
// multiplier itself when it turns bucket targets into holding targets.
export function applyOverlayToTargets(rawTargets, holdings, multipliersBySymbol) {
  const targets = rawTargets ?? {};
  const byBucket = {};
  for (const h of holdings ?? []) {
    const key = resolveSimulatorKey(h);
    if (!key) continue;
    (byBucket[key] ??= []).push(h);
  }
  let freedPct = 0;
  for (const [key, pct] of Object.entries(targets)) {
    if (key === "cash") continue;
    const avgMult = avgMultiplierForBucket(byBucket[key] ?? [], multipliersBySymbol);
    freedPct += Number(pct ?? 0) * (1 - avgMult);
  }
  if (freedPct <= 0) return { effectiveTargets: targets, freedPct: 0 };
  return {
    effectiveTargets: { ...targets, cash: (targets.cash ?? 0) + freedPct },
    freedPct,
  };
}

// Only propose an overlay rebalance when the tier has actually changed since
// the portfolio was last rebalanced under it — not on every daily
// composite/score move. This is a pure state comparison (current tier vs.
// the stored last-rebalanced tier), not "did the tier change today", so it
// keeps firing on any later day too — day 2, day 3, etc. after a missed
// tier change — until the portfolio is actually marked rebalanced.
export function shouldProposeRebalance(currentTier, lastRebalancedTier) {
  if (!currentTier) return false;
  return currentTier !== lastRebalancedTier;
}
