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

// Freed weight from scaling every equity bucket's target by exposureMultiplier,
// added onto the cash target. Only the cash entry changes; the equity buckets'
// own target values are left as-is because computeAllocationDeltas applies the
// per-symbol multiplier itself when it turns bucket targets into holding targets.
export function applyMarketOverlayToTargets(rawTargets, exposureMultiplier, equityKeys = EQUITY_KEYS) {
  const targets = rawTargets ?? {};
  let freedPct = 0;
  for (const [key, pct] of Object.entries(targets)) {
    if (!equityKeys.has(key)) continue;
    freedPct += Number(pct ?? 0) * (1 - exposureMultiplier);
  }
  if (freedPct <= 0) return { effectiveTargets: targets, freedPct: 0 };
  return {
    effectiveTargets: { ...targets, cash: (targets.cash ?? 0) + freedPct },
    freedPct,
  };
}

// Only propose an overlay rebalance when the tier has actually changed since
// the portfolio was last rebalanced under it — not on every daily score move.
export function shouldProposeRebalance(currentTier, lastRebalancedTier) {
  if (!currentTier) return false;
  return currentTier !== lastRebalancedTier;
}
