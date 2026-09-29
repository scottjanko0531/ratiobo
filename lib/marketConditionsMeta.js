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
export const SUB_INDICATOR_META = {
  T1: { pillar: "trend", label: "Price vs 200-day average", unit: "%", staleSeries: [] },
  T2: { pillar: "trend", label: "200-day average slope (20d)", unit: "±1", staleSeries: [] },
  T3: { pillar: "trend", label: "12-1 month momentum (vol-adjusted)", unit: "ratio", staleSeries: [] },
  T4: { pillar: "trend", label: "10-month rule (month-end vs 10mo avg)", unit: "±1", staleSeries: [] },
  S1: { pillar: "stress", label: "VIX / VIX3M term structure", unit: "ratio", staleSeries: ["VIXCLS", "VIX3M"] },
  S2: { pillar: "stress", label: "Credit spread level (BAA10Y)", unit: "%", staleSeries: ["BAA10Y"] },
  S3: { pillar: "stress", label: "Credit spread 20d change", unit: "bp", staleSeries: ["BAA10Y"] },
  S4: { pillar: "stress", label: "20-day realized volatility (SPY)", unit: "annualized", staleSeries: [] },
  S5: { pillar: "stress", label: "VIX level", unit: "", staleSeries: ["VIXCLS"] },
  S6: { pillar: "stress", label: "VIX 20d change", unit: "pts", staleSeries: ["VIXCLS"] },
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
