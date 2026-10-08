// Market Conditions Overlay — frontend helpers and frozen reference data.
//
// The overlay is computed server-side by supabase/functions/market-conditions-compute
// (nightly, weekdays 22:40 UTC) into market_conditions_scores (full-rebuild, current
// state) and mc_signal_log (append-only audit trail). mc_signal_log_live filters that
// log to rows written near their own signal date -- the true out-of-sample record,
// distinct from the one-shot historical backfill (see docs/market-conditions/DECISIONS.md).
//
// VALIDATION_SUMMARY below is FROZEN reference data from the 2026-09-29/30 robustness
// and entry-rule validation rounds (docs/market-conditions/DECISIONS.md) -- not
// recomputed live on every page load. mc-1.3.0's tier/exposure logic and the entry
// rules are both frozen as of mc-1.4.0; this summary should only be updated by hand
// after a genuine new validation round, same discipline as CAPEX_REGIME_META etc.
// in lib/capexOverlay.js.

export const TIER_META = {
  FULL:      { label: "Full",      tone: "text-gain",       border: "border-gain/30",       bg: "bg-gain/10" },
  NORMAL:    { label: "Normal",    tone: "text-paper",       border: "border-ink-line",      bg: "bg-ink-soft" },
  CAUTIOUS:  { label: "Cautious",  tone: "text-brass-soft",  border: "border-brass/30",      bg: "bg-brass/10" },
  DEFENSIVE: { label: "Defensive", tone: "text-brass",       border: "border-brass/40",      bg: "bg-brass/15" },
  RISK_OFF:  { label: "Risk-off",  tone: "text-loss",        border: "border-loss/40",       bg: "bg-loss/15" },
};

export const TREND_STATE_META = {
  UP:    { label: "Up",    tone: "text-gain" },
  MIXED: { label: "Mixed", tone: "text-paper-dim" },
  DOWN:  { label: "Down",  tone: "text-loss" },
};

// Plain-language entry-signal text (Phase 3 spec). E-DOWN's directional
// claim FAILED its own re-test (mixed: passes SPY/QQQ, fails IWM/EFA
// against the unconditional baseline -- see DECISIONS.md) so it displays
// as NEUTRAL with context only, not as a validated WAIT recommendation.
export const ENTRY_SIGNAL_TEXT = {
  "E-DIP": { signal: "ADD", tone: "text-gain", text: "Pullback within an uptrend. Historically a favorable time to add." },
  "E-HOT": { signal: "WAIT", tone: "text-brass-soft", text: "Stretched. Historically a poor time to chase. Hold, don't add." },
  "E-DOWN": { signal: "NEUTRAL", tone: "text-paper-dim", text: "Downtrend. No validated timing edge for this signal." },
  "E-DEFAULT": { signal: "NEUTRAL", tone: "text-paper-dim", text: "No timing edge." },
};

export function entrySignalDisplay(entryReason) {
  return ENTRY_SIGNAL_TEXT[entryReason] ?? { signal: "NEUTRAL", tone: "text-paper-dim", text: "No timing edge." };
}

// Sub-indicator metadata for the drill-down table, and which raw series
// (flags.stale_inputs keys) each depends on -- T1-T4 are SPY-close-only
// (never forward-filled, never stale); S4 is realized vol of SPY's own
// returns (also never stale); S1/S2/S3/S5/S6 depend on VIXCLS/VIX3M/BAA10Y.
//
// what/how/why power the per-row help icon on /market-conditions (see
// SubIndicatorRow in app/market-conditions/page.jsx). "how" mirrors the
// mapping formulas in docs/market-conditions/SPEC.md §5.2/5.3 -- keep the
// two in sync if a mapping ever changes.
export const SUB_INDICATOR_META = {
  T1: {
    pillar: "trend", label: "Price vs 200-day average", unit: "%", staleSeries: [],
    what: "How far SPY is trading above or below its 200-day moving average.",
    how: "close / SMA200 − 1, mapped linearly: +5% or more scores a full +1, −5% or more scores a full −1.",
    why: "The 200-day average is the most widely-watched long-term trend line in markets. Price durably above it has historically coincided with healthy bull markets; sustained trade below it is the classic technical definition of a bear market.",
  },
  T2: {
    pillar: "trend", label: "200-day average slope (20d)", unit: "±1", staleSeries: [],
    what: "Whether the 200-day moving average itself is rising or falling.",
    how: "Compares today's SMA200 to its value 20 trading days ago: +1 if rising, −1 if falling.",
    why: "A rising average means the long-term trend is still gaining altitude, not just that price happens to sit above a flat or falling line — it distinguishes a genuine uptrend from a bounce above a still-declining average.",
  },
  T3: {
    pillar: "trend", label: "12-1 month momentum (vol-adjusted)", unit: "ratio", staleSeries: [],
    what: "Price momentum over the past year, excluding the most recent month, scaled by how volatile the market has been.",
    how: "(12-month return − most recent month's return) ÷ 252-day annualized volatility, clipped to [−1, +1].",
    why: "This is the classic academic momentum factor: markets that have trended well over the past year (excluding short-term noise from the last month) tend to keep trending. Scaling by volatility stops a wild, choppy rally from scoring the same as a calm, steady one.",
  },
  T4: {
    pillar: "trend", label: "10-month rule (month-end vs 10mo avg)", unit: "±1", staleSeries: [],
    what: "A slower, monthly version of the 200-day check — is the latest month-end close above or below its 10-month moving average.",
    how: "+1 if the latest month-end close is above the 10-month SMA, −1 if below.",
    why: "A well-known, long-validated monthly trend-following rule. It moves slower than the daily T1/T2 checks, which helps confirm a trend change is real rather than daily noise.",
  },
  S1: {
    pillar: "stress", label: "VIX / VIX3M term structure", unit: "ratio", staleSeries: ["VIXCLS", "VIX3M"],
    what: "The ratio of near-term implied volatility (VIX) to 3-month implied volatility (VIX3M).",
    how: "Absolute mapping: ratio ≤ 0.85 scores a full +1, ≥ 1.05 scores a full −1, linear in between.",
    why: "When near-term VIX trades well below the 3-month VIX (\"contango\"), markets are calm and complacent. When it flips above (\"backwardation\"), traders are paying up for near-term protection right now — a classic early warning of acute stress, like at the onset of a selloff.",
  },
  S2: {
    pillar: "stress", label: "Credit spread level (BAA10Y)", unit: "%", staleSeries: ["BAA10Y"],
    what: "The gap between Baa-rated corporate bond yields and the 10-year Treasury yield — how much extra yield bond investors demand to hold lower investment-grade corporate debt.",
    how: "Rolling percentile of the current level vs. its own history (2,520-day window), inverted so a historically wide spread scores negatively.",
    why: "Credit markets often sense economic trouble before equities do. Widening spreads mean bond investors are pricing in more default risk and tighter financial conditions — a reliable leading indicator of broader market stress.",
  },
  S3: {
    pillar: "stress", label: "Credit spread 20d change", unit: "bp", staleSeries: ["BAA10Y"],
    what: "How much the Baa-10Y spread has moved over the last 20 trading days, rather than its absolute level.",
    how: "Rolling percentile of the 20-day change, inverted so a sharp recent widening scores negatively.",
    why: "A spread that's merely elevated but stable is a different risk than one blowing out right now. This isolates the rate of deterioration, which is often what actually triggers de-risking and forced selling.",
  },
  S4: {
    pillar: "stress", label: "20-day realized volatility (SPY)", unit: "annualized", staleSeries: [],
    what: "How much SPY has actually been moving day-to-day over the past month, annualized.",
    how: "Rolling percentile vs. history, inverted so unusually high realized volatility scores negatively.",
    why: "Rising realized volatility is both a symptom of stress (uncertainty driving bigger daily swings) and a cause of further selling (many institutional strategies cut equity exposure mechanically as realized vol rises) — a self-reinforcing signal worth tracking directly, not just inferring from options pricing.",
  },
  S5: {
    pillar: "stress", label: "VIX level", unit: "", staleSeries: ["VIXCLS"],
    what: "The market's current level of expected (implied) 30-day S&P 500 volatility.",
    how: "Rolling percentile vs. history, inverted so a historically elevated VIX scores negatively.",
    why: "VIX is the market's own \"fear gauge\" — what options traders are actually paying to hedge, in real time, rather than a backward-looking model of risk.",
  },
  S6: {
    pillar: "stress", label: "VIX 20d change", unit: "pts", staleSeries: ["VIXCLS"],
    what: "How much the VIX itself has risen or fallen over the past 20 trading days.",
    how: "Rolling percentile of the 20-day change, inverted so a sharp recent VIX spike scores negatively.",
    why: "Like S3 for credit, this isolates the speed of the fear gauge rather than its absolute level. A VIX that's elevated but stable behaves very differently than one spiking right now — spikes are what tend to coincide with forced selling.",
  },
};

export const fmtDate = (d) =>
  d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

export const fmtPct = (v, digits = 1) => (v == null ? "—" : `${(Number(v) * 100).toFixed(digits)}%`);
export const fmtNum = (v, digits = 2) => (v == null ? "—" : Number(v).toFixed(digits));

// ---- Frozen validation reference data (docs/market-conditions/DECISIONS.md) ----

export const VALIDATION_SUMMARY = {
  asOf: "2026-09-30",
  backtest: {
    label: "Backtest comparison — IN-SAMPLE",
    window: "1996-02-23 to 2026-09-28",
    note: "mc-1.3.0 tier/exposure logic, frozen. Entry-rule changes (mc-1.4.0) don't affect exposure_multiplier, only the entry_signal label -- this table is unaffected by the entry-rule round.",
    rows: [
      { name: "Overlay (this system)", cagrPct: 9.51, volPct: 12.51, sharpe: 0.76, maxDDPct: -22.65, calmar: 0.42 },
      { name: "200-day rule", cagrPct: 9.02, volPct: 12.88, sharpe: 0.70, maxDDPct: -26.97, calmar: 0.33 },
      { name: "Vol-matched static (66/34 SPY/T-bill)", cagrPct: 7.82, volPct: 12.51, sharpe: 0.63, maxDDPct: -39.75, calmar: 0.20 },
      { name: "Buy and hold SPY", cagrPct: 10.25, volPct: 19.20, sharpe: 0.53, maxDDPct: -55.19, calmar: 0.19 },
    ],
  },
  crossMarket: {
    label: "Cross-market Calmar — OUT-OF-SAMPLE",
    note: "mc config held completely unchanged (SPX-tuned) and applied to QQQ/IWM/EFA/EEM's own price series; Stress pillar stays on the same US VIX/BAA10Y series. Nothing here was fit to these four tickers. EEM added 2026-09-29 (Phase 6 portfolio-overlay review) to check the \"em\" bucket's own inclusion in EQUITY_KEYS specifically -- overlay Calmar (0.19) beats both the 200-day rule (0.15) and buy-and-hold (0.15) on EEM too, so em stays in EQUITY_KEYS.",
    rows: [
      { market: "QQQ", overlay: 0.22, rule200: 0.15, buyHold: 0.13 },
      { market: "IWM", overlay: 0.21, rule200: 0.21, buyHold: 0.15 },
      { market: "EFA", overlay: 0.22, rule200: 0.23, buyHold: 0.11 },
      { market: "EEM", overlay: 0.19, rule200: 0.15, buyHold: 0.15 },
    ],
  },
  entryRules: {
    label: "Entry-rule validation — pass/fail per market (mc-1.4.0 wiring)",
    note: "Pass = ADD beats its conditional (same trend-state) baseline mean forward return at both 21d and 63d, or WAIT underperforms it, both horizons. E-DOWN shown against BOTH its conditional baseline (a tautology once E-VETO was removed -- always ties, not a real test) and the unconditional (all-days) baseline, which is the genuine re-test.",
    rows: [
      { rule: "E-DIP (ADD)", spy: "pass", qqq: "pass", iwm: "pass", efa: "pass" },
      { rule: "E-HOT (WAIT)", spy: "pass", qqq: "pass", iwm: "fail (63d only, 18 episodes)", efa: "pass" },
      { rule: "E-DOWN vs conditional baseline", spy: "tie (artifact)", qqq: "tie (artifact)", iwm: "tie (artifact)", efa: "tie (artifact)" },
      { rule: "E-DOWN vs unconditional baseline", spy: "pass", qqq: "pass", iwm: "fail", efa: "fail" },
    ],
  },
};
