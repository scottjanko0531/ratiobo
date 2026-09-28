import { describe, it, expect } from "vitest";
import { evaluateEntrySignal } from "../supabase/functions/_shared/marketConditions/entrySignal.ts";
import { EntrySignalInput } from "../supabase/functions/_shared/marketConditions/types.ts";

// mc-1.4.0 entry-rule round: E-VETO/E-TOP/E-THRUST/E-CAPITULATION removed
// (E-VETO failed its own pre-registered validation in 4/4 markets; the
// other three depended on the rejected breadth pillar and were never
// reachable in production anyway -- see DECISIONS.md). Only E-DIP/E-HOT/
// E-DOWN/E-DEFAULT remain, and E-DIP/E-HOT now actually read O1 (RSI14)/O2
// (stretch50d), which mc-1.4.0's scoring.ts wires in for the first time.

const base: EntrySignalInput = { trendState: "MIXED" };

describe("evaluateEntrySignal — one fixture per surviving rule, priority order", () => {
  it("E-DIP (RSI branch)", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", rsi14: 35 });
    expect(r).toEqual({ signal: "ADD", reason: "E-DIP" });
  });

  it("E-DIP (stretch branch)", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", stretch50d: -2.0 });
    expect(r).toEqual({ signal: "ADD", reason: "E-DIP" });
  });

  it("E-DIP fires on RSI OR stretch -- either alone is sufficient", () => {
    const rsiOnly = evaluateEntrySignal({ ...base, trendState: "UP", rsi14: 39, stretch50d: 0 });
    const stretchOnly = evaluateEntrySignal({ ...base, trendState: "UP", rsi14: 60, stretch50d: -1.6 });
    expect(rsiOnly).toEqual({ signal: "ADD", reason: "E-DIP" });
    expect(stretchOnly).toEqual({ signal: "ADD", reason: "E-DIP" });
  });

  it("E-DIP requires trend=UP -- doesn't fire in DOWN or MIXED even with a qualifying RSI", () => {
    expect(evaluateEntrySignal({ trendState: "DOWN", rsi14: 20 })).not.toEqual({ signal: "ADD", reason: "E-DIP" });
    expect(evaluateEntrySignal({ trendState: "MIXED", rsi14: 20 })).not.toEqual({ signal: "ADD", reason: "E-DIP" });
  });

  it("E-HOT", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", rsi14: 80, stretch50d: 2.5 });
    expect(r).toEqual({ signal: "WAIT", reason: "E-HOT" });
  });

  it("E-HOT requires BOTH rsi14 and stretch50d over their thresholds, unlike E-DIP's OR", () => {
    const rsiOnly = evaluateEntrySignal({ ...base, trendState: "UP", rsi14: 80, stretch50d: 0.5 });
    expect(rsiOnly).not.toEqual({ signal: "WAIT", reason: "E-HOT" });
  });

  it("E-DOWN", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "DOWN" });
    expect(r).toEqual({ signal: "WAIT", reason: "E-DOWN" });
  });

  it("E-DOWN wins over DEFAULT regardless of RSI/stretch (E-DIP/E-HOT are UP-only)", () => {
    const r = evaluateEntrySignal({ trendState: "DOWN", rsi14: 20, stretch50d: -3 });
    expect(r).toEqual({ signal: "WAIT", reason: "E-DOWN" });
  });

  it("E-DEFAULT", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "MIXED" });
    expect(r).toEqual({ signal: "NEUTRAL", reason: "E-DEFAULT" });
  });
});

describe("evaluateEntrySignal — removed rules stay removed (mc-1.4.0)", () => {
  it("the only reachable reasons are E-DIP/E-HOT/E-DOWN/E-DEFAULT across a wide input sweep", () => {
    const trendStates: EntrySignalInput["trendState"][] = ["UP", "DOWN", "MIXED"];
    const rsiValues = [undefined, 10, 39, 40, 74, 75, 76, 90];
    const stretchValues = [undefined, -3, -1.5, -1.4, 0, 1.9, 2.0, 2.1];
    const seenReasons = new Set<string>();
    for (const trendState of trendStates) {
      for (const rsi14 of rsiValues) {
        for (const stretch50d of stretchValues) {
          seenReasons.add(evaluateEntrySignal({ trendState, rsi14, stretch50d }).reason);
        }
      }
    }
    expect(seenReasons).toEqual(new Set(["E-DIP", "E-HOT", "E-DOWN", "E-DEFAULT"]));
  });

  it("undefined rsi14/stretch50d (e.g. before either has 14/50 days of history) falls through to trend-only rules, never throws", () => {
    expect(evaluateEntrySignal({ trendState: "UP" })).toEqual({ signal: "NEUTRAL", reason: "E-DEFAULT" });
    expect(evaluateEntrySignal({ trendState: "DOWN" })).toEqual({ signal: "WAIT", reason: "E-DOWN" });
  });
});
