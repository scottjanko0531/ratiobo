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

const KEY_LABEL = Object.fromEntries(SIMULATOR_KEYS.map((s) => [s.key, s.label]));

// Buckets treated as illiquid for rebalancing purposes: action rows never
// recommend selling out of these even when over-target. Shared policy, not
// page-specific — used by both QuadrantCard and the Debt Cycle portfolio gap.
export const ILLIQUID_KEYS = new Set(["alt_re", "alt_loan", "alt_pp", "alt_other"]);

// ── BW Modified allocation ─────────────────────────────────────────────────────
// Bridgewater 2025–2026 structural base — resilient across all regimes.
// Reduces US equity concentration, adds TIPS + international, holds structural
// gold and commodity exposure regardless of the cyclical quadrant.
export const BW_ALLOC = {
  eq: 20, intl: 8, em: 5, nb: 20, tip: 20, com: 12, gld: 12, cash: 3,
  alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0,
};

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

// ── Suggested funds per asset class ──────────────────────────────────────────
// Representative low-cost ETFs or funds for each simulator bucket.
// Used as "buy" suggestions when a category has no current holdings.
export const SUGGESTED_FUNDS = {
  eq:         ["VTI", "VOO", "SCHB"],
  intl:       ["VXUS", "EFA", "VEA"],
  em:         ["VWO", "IEMG", "EEM"],
  nb:         ["TLT", "EDV", "VGLT"],
  tip:        ["VTIP", "SCHP", "TIP"],
  com:        ["PDBC", "DJP", "GSG"],
  gld:        ["GLD", "IAU", "GLDM"],
  cash:       ["SGOV", "BIL", "VMFXX"],
  alt_crypto: ["IBIT", "FBTC"],
  alt_re:     ["VNQ", "SCHH"],
  alt_loan:   [],
  alt_pp:     [],
  alt_other:  [],
};

// ── Regime return estimates ───────────────────────────────────────────────────
// Expected annual returns (%) per asset key, per regime.
// Same values used by RegimeSimulator's REGIMES constant.
export const REGIME_RETURNS = {
  rg_ri: { eq: 9,   intl: 7,   em: 12,  nb: -3,  tip: 4,  com: 14,  gld: 5,  cash: 1 },
  rg_fi: { eq: 13,  intl: 11,  em: 8,   nb: 7,   tip: 2,  com: -2,  gld: -3, cash: 1 },
  fg_ri: { eq: -8,  intl: -6,  em: -4,  nb: -6,  tip: 3,  com: 10,  gld: 12, cash: 1 },
  fg_fi: { eq: -18, intl: -15, em: -22, nb: 11,  tip: 5,  com: -12, gld: 3,  cash: 1 },
};

// ── Sector tilts within the equity sleeve, per regime ─────────────────────────
// The 11 SPDR Select Sector ETFs. Same methodology as REGIME_RETURNS above —
// domain-knowledge based (Fidelity/State Street business-cycle sector rotation
// framework), not backtested against RatioBo's own historical regime
// classifications. Weights sum to 100 within each regime; apply on top of
// REGIME_DEFAULT_WEIGHTS' equity allocation (eq/intl/em), not in place of it —
// this tilts WITHIN the equity sleeve, it doesn't change how much of the
// portfolio is in equities overall.
export const SECTOR_KEYS = [
  { key: "xlk",  label: "Technology",             ticker: "XLK" },
  { key: "xly",  label: "Consumer Discretionary",  ticker: "XLY" },
  { key: "xlp",  label: "Consumer Staples",        ticker: "XLP" },
  { key: "xle",  label: "Energy",                  ticker: "XLE" },
  { key: "xlf",  label: "Financials",              ticker: "XLF" },
  { key: "xlv",  label: "Health Care",             ticker: "XLV" },
  { key: "xli",  label: "Industrials",             ticker: "XLI" },
  { key: "xlb",  label: "Materials",                ticker: "XLB" },
  { key: "xlre", label: "Real Estate",              ticker: "XLRE" },
  { key: "xlu",  label: "Utilities",                ticker: "XLU" },
  { key: "xlc",  label: "Communication Services",   ticker: "XLC" },
];

export const REGIME_SECTOR_WEIGHTS = {
  // Recovery: growth accelerating off-trend, inflation still benign — cyclicals
  // and rate-sensitive growth sectors lead; defensives lag
  rg_fi: { xlk: 18, xly: 16, xli: 13, xlf: 12, xlc: 10, xlv: 8, xlb: 7, xle: 6, xlp: 4, xlre: 4, xlu: 2 },
  // Overheat: growth strong but inflation now rising too — commodity/rate-beneficiary
  // cyclicals (energy, materials, financials) lead; long-duration growth (tech) lags
  rg_ri: { xle: 18, xlb: 15, xli: 13, xlf: 12, xlc: 8, xlk: 8, xly: 8, xlv: 6, xlp: 5, xlre: 4, xlu: 3 },
  // Stagflation: growth falling, inflation still rising — the worst regime for most
  // sectors; only inflation-linked (energy) and defensive (staples, health care) hold up
  fg_ri: { xle: 16, xlp: 15, xlv: 14, xlu: 12, xlf: 8, xlb: 8, xlc: 7, xli: 6, xlk: 6, xly: 4, xlre: 4 },
  // Deflationary Bust: growth and inflation both falling — classic recession
  // defensives (utilities, staples, health care) lead; cyclicals/credit-sensitive lag
  fg_fi: { xlu: 17, xlp: 16, xlv: 15, xlre: 8, xlc: 8, xlk: 8, xlf: 6, xli: 6, xlb: 5, xly: 4, xle: 3 },
};

// All 11 sectors for a regime, ranked by weight and split into two halves for
// a two-column display — top half in "overweight", bottom half in
// "underweight". Deliberately shows every sector (no top-N cutoff): a partial
// list hides the middle-ranked sectors entirely, which is misleading when
// comparing two regimes (a sector can be "middling" in one and a top/bottom
// mover in another).
export function getSectorTilts(regimeKey) {
  const w = REGIME_SECTOR_WEIGHTS[regimeKey] ?? {};
  const sorted = Object.entries(w).sort((a, b) => b[1] - a[1]);
  const mid = Math.ceil(sorted.length / 2);
  return {
    overweight: sorted.slice(0, mid).map(([k, v]) => ({ ...SECTOR_KEYS.find(s => s.key === k), weight: v })),
    underweight: sorted.slice(mid).map(([k, v]) => ({ ...SECTOR_KEYS.find(s => s.key === k), weight: v })),
  };
}

// ── Regime metadata ────────────────────────────────────────────────────────────
export const REGIME_META = {
  rg_fi: { label: "Disinflationary Boom", desc: "Growth ↑ · Inflation ↓", color: "text-gain" },
  rg_ri: { label: "Reflation",            desc: "Growth ↑ · Inflation ↑", color: "text-brass-soft" },
  fg_fi: { label: "Deflationary Bust",    desc: "Growth ↓ · Inflation ↓", color: "text-paper-dim" },
  fg_ri: { label: "Stagflation",          desc: "Growth ↓ · Inflation ↑", color: "text-loss" },
};

// CBO's rough current estimate of potential real GDP growth (~1.8–2.0%);
// update periodically as CBO revises its own estimate. Kept in sync with the
// identical constants in fetch-macro-data/get-regime-analysis/run-backtest.
export const POTENTIAL_GDP_GROWTH = 1.9;
export const GROWTH_MIN_GAP = 0.15; // pp — fast line must clear the slow line by more than this
export const POTENTIAL_FLOOR_FRACTION = 0.85; // fast line must be at least this fraction of potential

// Dead band for the inflation crossover's Accelerating/Decelerating read
// (see rateOfChangeLabel below) — wider than GDP's GROWTH_MIN_GAP since
// inflation prints are noisier month to month than GDP's quarterly cadence.
export const CPI_MIN_GAP = 0.20; // pp

// The Fed's actual inflation mandate, not an arbitrary round number. The
// market-expectations lens used to call a 2.31% breakeven "Below threshold"
// against a hardcoded 2.5% cutoff — benchmarked against the Fed's real 2%
// target, that same reading is "still above target," which materially
// changes which quadrant the lens produces. No padding above the target.
export const FED_INFLATION_TARGET = 2.0;

// Shared growth test: requires BOTH a real crossover margin (not just barely
// positive) AND running at least POTENTIAL_FLOOR_FRACTION of potential GDP
// growth — a marginal, decelerating-but-technically-positive crossover no
// longer registers as "Expanding" on its own. Exported so every inline
// growthUp/growing check across fetch-macro-data, get-regime-analysis,
// run-backtest, and page.jsx uses the identical formula.
export function isGrowthExpanding(fast, slow) {
  return (fast - slow > GROWTH_MIN_GAP) && (fast > POTENTIAL_GDP_GROWTH * POTENTIAL_FLOOR_FRACTION);
}

// GDP/Inflation Regime Metrics spec, G2/I2 "Rate of Change": a pure
// fast-vs-slow crossover-gap test, symmetric in both directions — distinct
// from isGrowthExpanding (which also requires clearing the potential-GDP
// floor) and from page.jsx's growthStateLabel (which conflates level and
// crossover for the Regime Signal Comparison table). Labels purely off
// whether the fast line has cleared the slow line by more than minGap,
// in either direction; the zone in between is "Stable," not a guess.
export function rateOfChangeLabel(fast, slow, minGap) {
  const gap = fast - slow;
  if (gap > minGap) return "Accelerating";
  if (gap < -minGap) return "Decelerating";
  return "Stable";
}

// Labor veto for the growth axis: a GDP crossover that would otherwise read
// "Expanding" gets pulled down to "not expanding" when the labor market is
// actively cracking, on a 2-of-3 majority of the same three indicators/
// thresholds already used for their own status badges elsewhere on the
// dashboard (payrolls_3m_avg < 0, unemployment_trend > 0.1pp,
// jobless_claims_trend > 0%) — no new arbitrary numbers. Labor strength
// never manufactures an "Expanding" read GDP itself doesn't support; this
// only ever pulls the growth read down, never up. Any signal that's null
// (missing/not yet loaded) simply doesn't vote; with fewer than 2 signals
// present the veto is skipped (returns false) rather than guessing.
export function isLaborDeteriorating(payrolls3mAvg, unemploymentTrend, joblessClaimsTrend) {
  const votes = [
    payrolls3mAvg      != null ? payrolls3mAvg < 0        : null,
    unemploymentTrend  != null ? unemploymentTrend > 0.1  : null,
    joblessClaimsTrend != null ? joblessClaimsTrend > 0   : null,
  ].filter((v) => v !== null);
  if (votes.length < 2) return false;
  return votes.filter(Boolean).length >= 2;
}

// Map GDP growth and CPI readings → regime key.
// breakeven: market-implied 10Y inflation expectation (T10YIE); default is
//   the Fed's own 2% target (FED_INFLATION_TARGET), not an arbitrary round number
// gdp3yAvg:  3-year trailing avg GDP growth as trend baseline; default 0%
// payrolls3mAvg/unemploymentTrend/joblessClaimsTrend: optional labor veto
//   inputs (see isLaborDeteriorating) — default null, which skips the veto
//   so existing callers that don't pass labor data are unaffected.
export function detectRegimeKey(
  gdpGrowth,
  cpiYoy,
  {
    breakeven = FED_INFLATION_TARGET,
    gdp3yAvg = 0,
    payrolls3mAvg = null,
    unemploymentTrend = null,
    joblessClaimsTrend = null,
  } = {}
) {
  const growing = isGrowthExpanding(gdpGrowth, gdp3yAvg)
    && !isLaborDeteriorating(payrolls3mAvg, unemploymentTrend, joblessClaimsTrend);
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

// ── Portfolio gap: actual vs. suggested allocation ───────────────────────────
// Per-holding delta math extracted from app/macro/page.jsx's QuadrantCard, so
// both QuadrantCard and the Debt Cycle Position Check panel call the same
// logic instead of maintaining two copies. Returns:
//   - byKey/grandTotal: holdings grouped by resolved simulator key
//   - actionRows: per-holding { symbol, name, currentVal, currentPct, newPct,
//       newVal, deltaVal, isIlliquid, key }, sorted by |deltaVal| descending.
//       A bucket's target % is distributed across its holdings proportionally
//       to each holding's current share of that bucket. Illiquid buckets
//       never get a negative newVal (never recommend selling them down).
//   - buyRows: buckets with a nonzero target and no current holdings.
export function computeAllocationDeltas(holdings, suggestedPcts, { illiquidKeys = new Set() } = {}) {
  const byKey = {};
  let grandTotal = 0;
  for (const h of holdings ?? []) {
    const val = Number(h.current_value ?? 0);
    if (val <= 0) continue;
    const key = resolveSimulatorKey(h);
    if (!key) continue;
    if (!byKey[key]) byKey[key] = { holdings: [], total: 0 };
    byKey[key].holdings.push(h);
    byKey[key].total += val;
    grandTotal += val;
  }

  const hasPortfolio = Boolean(holdings && holdings.length > 0);
  // suggestedPcts may be passed as {} (not null) when no regime is selected
  // yet — treat an empty target map the same as "no targets."
  const hasTargets = Boolean(suggestedPcts) && Object.keys(suggestedPcts).length > 0 && grandTotal > 0;

  const actionRows = hasPortfolio && hasTargets
    ? (holdings ?? []).flatMap((h) => {
        const key = resolveSimulatorKey(h);
        if (!key) return [];
        const currentVal = Number(h.current_value ?? 0);
        if (currentVal <= 0) return [];
        const currentPct = (currentVal / grandTotal) * 100;
        const bucketTargetPct = suggestedPcts[key] ?? 0;
        const bucketTotal = byKey[key]?.total ?? 0;
        const holdingShare = bucketTotal > 0 ? currentVal / bucketTotal : 1;
        const holdingTargetPct = bucketTargetPct * holdingShare;
        const targetVal = (holdingTargetPct / 100) * grandTotal;
        const deltaVal = targetVal - currentVal;
        const isIlliquid = illiquidKeys.has(key);
        return [{
          symbol: h.symbol ?? h.name ?? "—",
          name: h.name,
          currentVal,
          currentPct,
          newPct: holdingTargetPct,
          newVal: isIlliquid && deltaVal < 0 ? currentVal : targetVal,
          deltaVal,
          isIlliquid,
          key,
        }];
      }).sort((a, b) => Math.abs(b.deltaVal) - Math.abs(a.deltaVal))
    : [];

  const buyRows = hasPortfolio && hasTargets
    ? Object.entries(suggestedPcts)
        .filter(([k, p]) => p > 0 && !byKey[k])
        .map(([k, p]) => ({
          key: k,
          label: KEY_LABEL[k] ?? k,
          targetPct: p,
          targetVal: (p / 100) * grandTotal,
        }))
        .sort((a, b) => b.targetPct - a.targetPct)
    : [];

  return { byKey, grandTotal, actionRows, buyRows };
}
