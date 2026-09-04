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
// Empirically recalibrated (dead-band-recalibration spec) via a new
// walk-forward backtest tool (supabase/functions/growth-axis-backtest),
// swept against real FRED GDPC1 history back to 1991 — the prior 0.15pp
// was picked by inspection off one live case and fired a "real" crossover
// on 78% of quarters (108/138), barely better than a coin flip (57%
// directional hit-rate on 1Q-ahead moves). 0.80pp — close to the gap
// series' own historical stdev (0.88pp) — is where 1Q-ahead directional
// hit-rate plateaus (~72%) with a still-reasonable signal frequency
// (25/138 quarters, roughly one real crossover every 1.4 years).
export const GROWTH_MIN_GAP = 0.80; // pp — fast line must clear the slow line by more than this
export const POTENTIAL_FLOOR_FRACTION = 0.85; // fast line must be at least this fraction of potential

// Dead band for the inflation crossover's Accelerating/Decelerating read
// (see rateOfChangeLabel below). Empirically recalibrated the same way as
// GROWTH_MIN_GAP above — the prior 0.20pp fired on 56% of months (233/414)
// at barely-better-than-coinflip 55% hit-rate. Unlike growth, a finer sweep
// (0.80-1.10pp in 0.05 steps) found NO plateau for inflation — hit-rate
// climbed steadily and roughly monotonically the whole way (68% at 0.80pp
// -> 75% at 1.00pp -> 81% at 1.10pp -> 85% at 1.20pp), so there's no
// natural stopping point the way growth's flat 70-73% band across
// 0.75-0.90pp gave one. 1.00pp is a deliberate, not-fully-optimized
// compromise: meaningfully past the still-rising early part of the curve
// (75% hit-rate, 44/414 months) while keeping a larger sample than the
// thinner 1.20pp+ region (27 signals over ~35 years) where hit-rate keeps
// climbing but each additional point is easier to overfit to. A user
// wanting CPI's own empirical ceiling rather than this compromise could
// reasonably push this higher; see supabase/functions/growth-axis-backtest.
export const CPI_MIN_GAP = 1.00; // pp

// The Fed's actual inflation mandate, not an arbitrary round number. The
// market-expectations lens used to call a 2.31% breakeven "Below threshold"
// against a hardcoded 2.5% cutoff — benchmarked against the Fed's real 2%
// target, that same reading is "still above target," which materially
// changes which quadrant the lens produces. No padding above the target.
export const FED_INFLATION_TARGET = 2.0;

// ── Forward Signal: Near-Term (2-3mo) & Medium-Term (6-18mo) panels ────────
// Split per the forward-signal two-horizon spec: the old single composite
// blended indicators whose real lead times differ by an order of magnitude
// (Jobless Claims: days; Yield Curve 2/10: 12-18mo) into one score that
// didn't clearly mean anything at a specific horizon. Its two weight
// baskets also didn't sum to the same total (Growth ~2.05, Inflation ~1.50)
// despite the scoring's renormalize-by-available-weight already bounding
// each score to [-1,+1] on its own — the two panels weren't comparable to
// each other even though each was individually well-formed. Every basket
// below sums to 1.00 (see the weight-sum tests in
// tests/regimeClassifier.test.ts) and each panel keeps its own dead band
// (NEARTERM_THRESH/MEDTERM_THRESH) rather than sharing one threshold. Used
// by app/macro/page.jsx (live UI) and mirrored manually in
// fetch-macro-data/get-regime-analysis (Deno, can't import this module).

// GDPNow (FRED GDPNOW) and ISM Manufacturing/Services New Orders (read from
// the ISM PMI indicators' own new_orders metadata, stamped by
// fetch-macro-data's supabase_ism/supabase_ism_services processors) are new
// data pulls added alongside this composite rewrite.
export const NEARTERM_GROWTH_SIGNALS = [
  { label: "GDPNow", name: "GDPNow", w: 0.20, isNowcast: true, vote: v => v > 2.5 ? 1 : v >= 1.0 ? 0 : -1 },
  // new_orders is already stamped as metadata on the ISM PMI indicators
  // themselves (by fetch-macro-data's supabase_ism/supabase_ism_services
  // processors) — no standalone "ISM * New Orders" indicator needed.
  { label: "ISM Mfg New Orders", name: "ISM Manufacturing PMI", w: 0.15, useMetaField: "new_orders", vote: v => v > 55 ? 1 : v >= 50 ? 0 : -1 },
  { label: "ISM Services New Orders", name: "ISM Services PMI", w: 0.10, useMetaField: "new_orders", vote: v => v > 55 ? 1 : v >= 50 ? 0 : -1 },
  { label: "Jobless Claims", name: "Initial Jobless Claims Trend", w: 0.15, vote: v => v < 0 ? 1 : v <= 5 ? 0 : -1 },
  { label: "Payrolls (3M Avg)", name: "Payrolls (3M Avg)", w: 0.15, vote: v => v > 100 ? 1 : v >= 0 ? 0 : -1 },
  { label: "Retail Sales", name: "Retail Sales (YoY)", w: 0.10, vote: v => v >= 2 ? 1 : v >= 0 ? 0 : -1 },
  { label: "Unemployment Trend", name: "Unemployment Rate Trend", w: 0.05, vote: v => v < -0.05 ? 1 : v <= 0.05 ? 0 : -1 },
  { label: "HY Spread", name: "HY Credit Spread (OAS)", w: 0.05, vote: v => v < 4 ? 1 : v <= 6 ? 0 : -1 },
  { label: "Liquidity", name: "US Total Liquidity Composite", w: 0.05, vote: v => v > 0 ? 1 : v > -3 ? 0 : -1 },
];
export const NEARTERM_INFL_SIGNALS = [
  // Labeled "CPI Momentum (3M Δ)", not "CPI Trend" — deliberately distinct
  // from the Structural lens's "CPI Trend (3M/9M Avg)" crossover. This is
  // headline CPI (YoY)'s own 3-month POINT change (change3m_pp: current YoY
  // rate minus the YoY rate 3 months ago) — a momentum/derivative measure.
  // Structural's is a LEVEL comparison (is the 3-month average running above
  // the 9-month average). The two can and do genuinely diverge on the same
  // underlying series (e.g. +0.52pp 3M/9M gap = "Increasing" structurally,
  // while the same period's raw 3-month point change is -0.48pp = "neutral"
  // here) — sharing the name "CPI Trend" made that look like a bug instead
  // of two different, legitimate questions about the same data.
  { label: "CPI Momentum (3M Δ)", name: "CPI (YoY)", w: 0.20, getPP3m: true, vote: v => v < -0.5 ? -1 : v > 0.5 ? 1 : 0 },
  { label: "PPI Trend", name: "PPI (YoY)", w: 0.20, getPP3m: true, vote: v => v < -1.0 ? -1 : v > 1.0 ? 1 : 0 },
  { label: "WTI 3M", name: "WTI Crude Oil", w: 0.10, getPct3m: true, vote: v => v > 5 ? 1 : v >= -5 ? 0 : -1 },
  { label: "WTI Shock", name: "WTI Crude Oil (Shock)", sourceName: "WTI Crude Oil", w: 0.15, useShortPct: true, shockGate: true, vote: v => v > 10 ? 1 : v < -10 ? -1 : 0 },
  { label: "Copper 3M", name: "Copper Price", w: 0.10, getPct3m: true, vote: v => v > 5 ? 1 : v >= -5 ? 0 : -1 },
  { label: "Dollar (3M, lagged)", name: "DXY", w: 0.10, getPct3m: true, vote: v => v > 5 ? -1 : v < -5 ? 1 : 0 },
  // umich_1yr — already stamped on "Consumer Inflation Expectations"'s own
  // metadata by the I4 attribution work, distinct from the blended
  // composite value the raw indicator reading itself represents.
  { label: "Short-Run Infl Expectations", name: "Consumer Inflation Expectations", w: 0.10, useMetaField: "umich_1yr", vote: v => v > 4 ? 1 : v >= 2.5 ? 0 : -1 },
  { label: "Tariff Impact (near-term)", name: "Tariff Inflation Impact", w: 0.05, vote: v => v > 0.30 ? 1 : v > 0.10 ? 0 : -1 },
];
export const NEARTERM_THRESH = 0.15; // wider dead band — higher-frequency inputs are noisier

// Close to the old single composite, with near-term-only indicators (Jobless
// Claims, Payrolls, Retail Sales, Unemployment Trend, WTI Shock) removed and
// classic long-leading indicators added. LEI is deliberately NOT included
// alongside its own sub-components (Building Permits, New Orders, Jobless
// Claims, Yield Curve) — that would double-count them; use one or the other,
// and the sub-components are more informative individually.
export const MEDTERM_GROWTH_SIGNALS = [
  { label: "Yield Curve 2/10", name: "2yr/10yr Yield Spread", w: 0.20, vote: v => v > 0.5 ? 1 : v >= 0 ? 0 : -1 },
  // NY Fed's own preferred spread for their 12mo recession model, weighted
  // down given collinearity with 2/10 — confirmation, not a second vote.
  { label: "Yield Curve 3m/10", name: "3mo/10yr Yield Spread", w: 0.10, vote: v => v > 1 ? 1 : v >= 0 ? 0 : -1 },
  { label: "Loan Standards", name: "Sr Loan Officer Survey", w: 0.15, vote: v => v < 15 ? 1 : v <= 35 ? 0 : -1 },
  { label: "Building Permits", name: "Building Permits", w: 0.15, getPct3m: true, vote: v => v > 3 ? 1 : v >= -3 ? 0 : -1 },
  // Consumer Sentiment (UMich, FRED UMCSENT) substitutes for NFIB Small
  // Business Optimism / Conference Board Consumer Confidence — neither has
  // a free machine-readable feed, unlike everything else on this page.
  { label: "Consumer Sentiment", name: "UMich Consumer Sentiment", w: 0.15, vote: v => v > 80 ? 1 : v >= 60 ? 0 : -1 },
  { label: "Output Gap", name: "Output Gap", w: 0.10, vote: v => v > 0.5 ? 1 : v >= -0.5 ? 0 : -1 },
  { label: "C&I Loans", name: "C&I Loan Growth (YoY)", w: 0.10, vote: v => v > 5 ? 1 : v >= 0 ? 0 : -1 },
  // The SPF's own forward quarters (spf_consensus_gdp_fwd, horizons 2-5
  // average only, never blended with the horizon-1 nowcast) — Panel A's
  // GDPNow already covers the current-quarter nowcast role, so this is the
  // genuinely multi-quarter-ahead consensus comparison.
  { label: "GDP vs SPF (fwd)", name: "Real GDP Growth", w: 0.05, useSpfSpread: "spf_consensus_gdp_fwd", vote: v => v > 0.2 ? 1 : v >= -0.2 ? 0 : -1 },
];
// Post oil-futures-curve-removal weights (no free source for the actual
// futures term structure — FRED only carries spot WTI, already covered by
// Panel A). The spec's stated weights for the remaining 6 items summed to
// 0.95; proportionally rescaled (÷0.95) rather than dumping the dropped
// 0.05 onto one line.
export const MEDTERM_INFL_SIGNALS = [
  // Shared input, not a coincidence of naming: this reads the exact same
  // "10Y Breakeven Inflation" indicator the Market Expectations lens uses
  // (binary vs FED_INFLATION_TARGET there; a 3-way test here) — flagged per
  // the two-horizon spec's independence caveat rather than left unstated,
  // so a user doesn't mistake this and Market Expectations for two
  // independent confirmations of the same read.
  { label: "10Y Breakeven (shared with Market Expectations)", name: "10Y Breakeven Inflation", w: 0.26, vote: v => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
  // Cleveland Fed's model-based 10yr expected-inflation estimate — substitutes
  // for UMich's raw 5-10yr survey question, which has no standalone free
  // FRED series (it's part of UMich's paid Surveys of Consumers microdata).
  { label: "Long-Run Infl Expectations", name: "10-Year Expected Inflation", w: 0.16, vote: v => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
  { label: "Wage Growth / ULC", name: "Unit Labor Costs (YoY)", w: 0.21, vote: v => v > 4 ? 1 : v >= 2 ? 0 : -1 },
  { label: "M2 Growth", name: "M2 Growth (YoY)", w: 0.10, vote: v => v > 8 ? 1 : v >= 3 ? 0 : -1 },
  { label: "Capacity Utilization", name: "Capacity Utilization", w: 0.16, vote: v => v > 80 ? 1 : v >= 74 ? 0 : -1 },
  { label: "Tariff Impact (structural)", name: "Tariff Inflation Impact", w: 0.11, vote: v => v > 0.30 ? 1 : v > 0.10 ? 0 : -1 },
];
export const MEDTERM_THRESH = 0.10; // smoother, lower-frequency inputs — tighter dead band

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

// Growth axis for the Structural/Market regime classifiers: the SAME read
// shown in the Structural Growth panel (rateOfChangeLabel), not a
// separately-computed test. Previously structuralRegimeKey/marketRegimeKey
// used isGrowthExpanding (gap test + potential-floor gate) while the panel
// displayed rateOfChangeLabel (gap test only) — two independent reads of
// the same fast/slow pair that could, and did, disagree. Only a genuine
// Accelerating read counts as "growth up" for classification purposes;
// Stable and Decelerating both fall on the growth-down side, same as
// isGrowthExpanding's old behavior for a failed gap test. See the
// regime-table dead-band bug fix and the follow-up request to stop having
// an independent GDP-state read. Scoped to the live Structural/Market
// classifiers only — detectRegimeKey/isGrowthExpanding are unchanged and
// still drive run-backtest's historical reconstruction and the Regime
// Simulator, which are different use cases with different data.
export function isGrowthAccelerating(fast, slow) {
  return rateOfChangeLabel(fast, slow, GROWTH_MIN_GAP) === "Accelerating";
}

// Inflation axis for the Structural/Market regime classifiers, mirroring
// isGrowthAccelerating: the SAME dead-band gap test as CPI_MIN_GAP, not a
// bare fast > slow sign comparison. Previously structuralRegimeKey/
// marketRegimeKey's inflation leg used `cpiFast > cpiSlow` with zero dead
// band, so a print separated by a hundredth of a point could flip the
// regime read — the same class of noise the growth axis's dead band exists
// to filter out. Only a genuine Accelerating read counts as "inflation up";
// Stable and Decelerating both fall on the inflation-down side.
export function isInflationAccelerating(fast, slow) {
  return rateOfChangeLabel(fast, slow, CPI_MIN_GAP) === "Accelerating";
}

// Replaces the old Direction/Level tiebreaker (resolveAxisDirection) per
// the dead-band-persistence spec: when Rate of Change reads "Stable" (the
// fast/slow gap didn't clear minGap in either direction), do NOT force a
// coin-flipped Up/Down via a secondary signal — a score near the center of
// the dead band and a score one hair from the edge are both "no real
// signal," but they don't carry equal risk of an imminent break. Instead
// return an explicit Persistence state carrying its own confidence (how
// solidly centered the read is, 100% at dead-band center → 0% at the
// edge) and which side a break would go toward (nearSide), so the caller
// can build a level-anchored "expect no material change" forecast instead
// of a directional claim the data doesn't support. See the regime
// tiebreaker spec (superseded) and its follow-up dead-band-persistence spec.
export function resolveAxisState(fast, slow, minGap) {
  const rateLabel = rateOfChangeLabel(fast, slow, minGap);
  if (rateLabel !== "Stable") {
    return { up: rateLabel === "Accelerating", persistence: false, persistenceConfidence: null, nearSide: null, rateLabel };
  }
  const distanceFromCenter = Math.min(Math.abs(fast - slow) / minGap, 1);
  return {
    up: null,
    persistence: true,
    persistenceConfidence: Math.round((1 - distanceFromCenter) * 100),
    nearSide: fast >= slow ? "Accelerating" : "Decelerating",
    rateLabel: "Stable",
  };
}

// Tiered language for a persistence confidence number — same vocabulary as
// the Forward Signal panels' actionability tiers (>65% high / <35% low /
// mid-range plain), so a user sees one consistent scale for "how much
// should I trust this number" rather than a new one invented per state.
export function persistenceConfidenceTier(conf) {
  if (conf == null) return "mid";
  if (conf > 65) return "high";
  if (conf < 35) return "low";
  return "mid";
}

// 3-month-forward-forecast spec: the real-signal mirror of
// persistenceConfidence — how far PAST the dead-band edge the gap sits, as
// a percentage of one more dead-band-width beyond the threshold, capped at
// 100. A real Accelerating/Decelerating call on the Structural axis has no
// existing confidence score to reuse (only the Forward Signal panels'
// consensus() scores do); this fills that gap with the same kind of
// distance-from-boundary math already used for Persistence, just measured
// on the other side of the line. Mirrors the identical helper in
// supabase/functions/fetch-macro-data/index.ts — kept in sync manually.
export function axisConviction(gap, minGap) {
  return Math.max(0, Math.min(100, Math.round(((Math.abs(gap) - minGap) / minGap) * 100)));
}

// Horizon-matched historical MAE from supabase/functions/growth-axis-
// backtest's real, large-sample backtest (GDP fullHistory naiveMAE, CPI
// fullHistory naiveMAE, at the current GROWTH_MIN_GAP/CPI_MIN_GAP
// calibration) — the error band shown next to the Ratiobo Forecast point
// number. A static reference, not live-computed on every page load; kept
// in sync manually with the identical constants in fetch-macro-data.
export const GDP_FORECAST_ERROR_BAND_PP = 0.93;
export const CPI_FORECAST_ERROR_BAND_PP = 0.64;

// Confidence tiers for gating how much of a Forward Signal leg's suggested
// tilt actually reaches the Positioning Signal table — a 29%-confidence
// read shouldn't drive the same conviction-looking allocation a
// 90%-confidence read would. Below 50%: not actionable (0 — hold
// baseline). 50-65%: partial signal, linearly scaled 0.3→0.5 across the
// band (the regime engine follow-up spec's own "roughly 30-50%" range,
// not a single arbitrary midpoint). Above 65%: full conviction (1.0). See
// the regime engine follow-up fixes, section C.
export function confidenceTierMultiplier(conf) {
  if (conf == null || conf < 50) return 0;
  if (conf <= 65) return 0.3 + (conf - 50) / 15 * 0.2;
  return 1;
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
