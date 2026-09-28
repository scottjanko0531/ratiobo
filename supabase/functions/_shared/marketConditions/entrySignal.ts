// Market Conditions Overlay — entry signal rules (build spec Section 7.4).
// Pure, Deno-API-free. First matching rule wins.
//
// Rules referencing breadth/oscillator fields (E-THRUST, E-DIP, E-HOT,
// E-TOP, E-CAPITULATION) aren't special-cased for "Phase 1 vs Phase 2" —
// their guard conditions simply can't be satisfied while those
// EntrySignalInput fields are `undefined` (Phase 1 never sets them), so
// they fall through to the next rule automatically. This is the mechanism,
// not a Phase 1 stub: the same function works unchanged once Phase 2/3
// start populating those fields.

import { EntrySignalInput, EntrySignalResult } from "./types.ts";
import { MC_CONFIG } from "./config.ts";

export function evaluateEntrySignal(inp: EntrySignalInput, cfg = MC_CONFIG): EntrySignalResult {
  if (inp.vetoActive) return { signal: "WAIT", reason: "E-VETO" };

  if (inp.breadthThrustNew === true) return { signal: "ADD", reason: "E-THRUST" };

  if (
    inp.trendState === "UP" && inp.breadthScore != null && inp.breadthScore >= 0 &&
    ((inp.rsi14 != null && inp.rsi14 < cfg.entry.dipRsi) ||
      (inp.stretch50d != null && inp.stretch50d <= cfg.entry.dipStretch) ||
      (inp.pctOversold != null && inp.pctOversold > cfg.entry.dipOversoldPct))
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

  if (
    inp.trendState === "UP" && inp.breadthDivergence === true &&
    inp.rsi14 != null && inp.rsi14 > cfg.entry.topRsi
  ) {
    return { signal: "TRIM", reason: "E-TOP" };
  }

  if (
    inp.trendState === "DOWN" &&
    inp.pctOversold != null && inp.pctOversold > cfg.entry.capitulationOversoldPct &&
    inp.vixTermStructureRecentlyAbove1 === true && inp.vixTermStructureNowBelow1 === true
  ) {
    return { signal: "ADD_SMALL", reason: "E-CAPITULATION" };
  }

  if (inp.trendState === "DOWN") return { signal: "WAIT", reason: "E-DOWN" };

  return { signal: "NEUTRAL", reason: "E-DEFAULT" };
}
