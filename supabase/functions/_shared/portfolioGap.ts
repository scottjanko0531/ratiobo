// Pure, Deno-API-free bucket-level portfolio gap math for the Debt Cycle
// Position Check narrative. Deliberately NOT a full port of
// lib/simulatorKeys.js's computeAllocationDeltas() — the narrative only
// needs "US Equities: 32% actual vs 20% target" bucket summaries, not
// per-holding buy/sell rows, so this duplicates just the pieces needed:
// resolveSimulatorKey's asset_type fallback and BW Modified's weights.
// Must stay in sync with lib/simulatorKeys.js if either changes.

export interface HoldingLike {
  simulator_key?: string | null;
  asset_type?: string | null;
  current_value?: number | null;
}

export interface BucketGap {
  key: string;
  currentPct: number;
  targetPct: number;
  deltaPct: number;
}

const ASSET_TYPE_DEFAULT: Record<string, string> = {
  equity: "eq",
  etf: "eq",
  closed_end_fund: "eq",
  mutual_fund: "eq",
  bond: "nb",
  money_market: "cash",
  cash: "cash",
  crypto: "alt_crypto",
  metal: "gld",
};

export function resolveSimulatorKey(h: HoldingLike): string | null {
  return h.simulator_key ?? ASSET_TYPE_DEFAULT[h.asset_type ?? ""] ?? null;
}

// Bridgewater 2025-2026 structural base — must stay in sync with BW_ALLOC
// in lib/simulatorKeys.js.
export const BW_ALLOC: Record<string, number> = {
  eq: 20, intl: 8, em: 5, nb: 20, tip: 20, com: 12, gld: 12, cash: 3,
  alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0,
};

export function computeBucketGaps(
  holdings: HoldingLike[],
  suggestedPcts: Record<string, number> = BW_ALLOC,
): BucketGap[] {
  const totals: Record<string, number> = {};
  let grandTotal = 0;
  for (const h of holdings ?? []) {
    const val = Number(h.current_value ?? 0);
    if (val <= 0) continue;
    const key = resolveSimulatorKey(h);
    if (!key) continue;
    totals[key] = (totals[key] ?? 0) + val;
    grandTotal += val;
  }
  if (grandTotal <= 0) return [];

  const allKeys = new Set([...Object.keys(totals), ...Object.keys(suggestedPcts)]);
  return [...allKeys]
    .map((key) => {
      const currentPct = ((totals[key] ?? 0) / grandTotal) * 100;
      const targetPct = suggestedPcts[key] ?? 0;
      return { key, currentPct, targetPct, deltaPct: currentPct - targetPct };
    })
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
}
