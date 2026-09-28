// Market Conditions Overlay — entry signal rules (build spec Section 7.4).
// Pure, Deno-API-free. First matching rule wins.
//
// mc-1.4.0 entry-rule round (2026-09-30), following the entry-signal
// validation report (DECISIONS.md): five of the original eight rules are
// gone.
//   - E-TOP, E-THRUST, E-CAPITULATION removed outright, no replacements --
//     all three depended on the breadth pillar, which was rejected on its
//     own pre-registered criteria this same round (fails Calmar/maxDD/
//     whipsaw on every market tested). They were never reachable in
//     production anyway (Phase 1 never populated the breadth/thrust
//     fields they read), so this removes dead branches, not live behavior.
//   - E-VETO removed: validated against forward SPY/QQQ/IWM/EFA returns
//     and FAILED its own pre-registered criterion (WAIT should
//     underperform its conditional baseline at 21d/63d) in all 4 markets
//     -- veto days showed ABOVE-average, not below-average, forward
//     returns (e.g. SPY 21d +1.85% vs +0.91% baseline; QQQ 21d +3.20% vs
//     +0.85%). The underlying tier-level stress veto (which caps exposure,
//     a separate mechanism from this entry-signal rule) is UNCHANGED by
//     this -- only the ENTRY-SIGNAL label is removed. Veto days now fall
//     through to whichever of E-DIP/E-HOT/E-DOWN/E-DEFAULT their
//     trend_state matches; DayScoreRow.vetoActive/flags.veto still report
//     the tier veto's own state for the UI to show as an informational
//     "high stress, historically above-average but volatile" note (see
//     DECISIONS.md for the accompanying median/%positive/p10 stats).
//   - E-DIP rewired: the breadthScore>=0 guard and pctOversold condition
//     are gone (breadth not scored, pctOversold never computed) -- now
//     triggers on trend=UP AND (RSI14 < dipRsi OR stretch50d <=
//     dipStretch), using the newly-wired O1/O2 oscillators
//     (indicators/oscillators.ts). E-HOT is unchanged in logic (already
//     only read rsi14/stretch50d), but was previously unreachable since
//     those fields were never populated -- now live.
// Validated post-rewiring (same pre-registered pass/fail rule) against
// SPY/QQQ/IWM/EFA -- results in DECISIONS.md.

import { EntrySignalInput, EntrySignalResult } from "./types.ts";
import { MC_CONFIG } from "./config.ts";

export function evaluateEntrySignal(inp: EntrySignalInput, cfg = MC_CONFIG): EntrySignalResult {
  if (
    inp.trendState === "UP" &&
    ((inp.rsi14 != null && inp.rsi14 < cfg.entry.dipRsi) ||
      (inp.stretch50d != null && inp.stretch50d <= cfg.entry.dipStretch))
  ) {
    return { signal: "ADD", reason: "E-DIP" };
  }

  if (
    inp.trendState === "UP" &&
    inp.rsi14 != null && inp.rsi14 > cfg.entry.hotRsi &&
    inp.stretch50d != null && inp.stretch50d >= cfg.entry.hotStretch
  ) {
    return { signal: "WAIT", reason: "E-HOT" };
  }

  if (inp.trendState === "DOWN") return { signal: "WAIT", reason: "E-DOWN" };

  return { signal: "NEUTRAL", reason: "E-DEFAULT" };
}
