// AI Capex Cycle Overlay — frontend helpers.
//
// The overlay itself is computed server-side by supabase/functions/compute-capex-cycle
// (daily, 06:20 UTC) into capex_cycle_readings; capex_overlay_symbol_multipliers exposes
// the latest per-symbol bucket multiplier. These helpers only decide how that multiplier
// combines with the existing per-symbol resize overlay (asset_resize_signals).
//
// Design choices:
//  - Downside-only in portfolios: the capex overlay can cut a target (multiplier < 1) but
//    never raise one. Upside tilts (e.g. ai_semis 1.03) would push a portfolio's targets
//    above 100% and aren't what this overlay is for; they are shown on /ai-capex only.
//  - Shadow mode (capex_model_config.shadow_mode, echoed on every reading) means "compute
//    and display, never apply" — portfolios see what it WOULD do but targets are unchanged.
//  - Combination with the resize overlay is multiplicative (same two-stage Target x
//    multiplier design as KISS/VAMS): a VTI already Reduced to 0.5 by its trend rule and
//    cut to 0.85 by the capex overlay ends at 0.425 of its bucket target.

export const CAPEX_REGIME_META = {
  boom: { label: "Boom", tone: "text-gain", border: "border-gain/30", bg: "bg-gain/10", desc: "Capex growing, stress near its 10-year norm." },
  blowoff: { label: "Blow-off", tone: "text-brass-soft", border: "border-brass/30", bg: "bg-brass/10", desc: "Stress well above normal, no confirmed triggers — late-cycle frenzy, historically still rewarding." },
  correction: { label: "Correction", tone: "text-brass-soft", border: "border-brass/30", bg: "bg-brass/10", desc: "Price/credit stress while hyperscaler capex is still growing. Every such cluster 2012–26 was followed by strong returns — no regime de-risking." },
  turn: { label: "Turn", tone: "text-loss", border: "border-loss/30", bg: "bg-loss/10", desc: "Stress + triggers AND capex growth has stalled — the capex-bust signature." },
  bust: { label: "Bust", tone: "text-loss", border: "border-loss/40", bg: "bg-loss/15", desc: "Deep semis drawdown, 3+ triggers, capex stalled." },
  deployment: { label: "Deployment", tone: "text-gain", border: "border-gain/30", bg: "bg-gain/10", desc: "Post-bust: low intensity, capex rebuilding." },
};

export const CAPEX_SCENARIO_META = [
  { code: "H1_BLOWOFF_THEN_BEAR", label: "Blow-off, then secular bear", bar: "bg-brass" },
  { code: "H2_PRODUCTIVITY_BULL", label: "Durable productivity bull", bar: "bg-gain" },
  { code: "H3_EARLY_BUST", label: "Early bust (2026–27)", bar: "bg-loss" },
  { code: "H4_RATE_SHOCK", label: "Rate shock / multiple compression", bar: "bg-[#818CF8]" },
];

export const CAPEX_PILLARS = [
  { key: "intensity", label: "Intensity", col: "pillar_intensity" },
  { key: "financing", label: "Financing", col: "pillar_financing" },
  { key: "returns", label: "Returns", col: "pillar_returns" },
  { key: "overcapacity", label: "Overcapacity", col: "pillar_overcapacity" },
  { key: "market", label: "Market", col: "pillar_market" },
];

// rows: capex_overlay_symbol_multipliers rows ({ symbol, exposure_multiplier, shadow_mode, ... })
// Returns { applied, bySymbol } where bySymbol holds downside-only (<= 1) multipliers.
export function capexMultipliersBySymbol(rows) {
  const bySymbol = {};
  let shadow = true;
  for (const r of rows ?? []) {
    const m = Number(r.exposure_multiplier);
    if (!isFinite(m)) continue;
    bySymbol[r.symbol] = Math.min(1, Math.max(0, m));
    if (r.shadow_mode === false) shadow = false;
  }
  return { applied: !shadow && Object.keys(bySymbol).length > 0, bySymbol };
}

// Multiply two symbol->multiplier maps; a symbol missing from either side counts as 1.
export function mergeExposureMultipliers(base = {}, capex = {}) {
  const out = { ...base };
  for (const [sym, m] of Object.entries(capex)) out[sym] = (out[sym] ?? 1) * m;
  return out;
}

// For the "would do" status line: the bucket-level cuts the overlay currently implies.
export function describeCapexCuts(rows) {
  const byBucket = new Map();
  for (const r of rows ?? []) {
    const m = Number(r.exposure_multiplier);
    if (isFinite(m) && m < 0.995 && !byBucket.has(r.bucket)) byBucket.set(r.bucket, m);
  }
  return [...byBucket.entries()].map(([bucket, m]) => ({ bucket, multiplier: m }));
}
