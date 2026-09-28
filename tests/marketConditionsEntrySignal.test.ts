import { describe, it, expect } from "vitest";
import { evaluateEntrySignal } from "../supabase/functions/_shared/marketConditions/entrySignal.ts";
import { EntrySignalInput } from "../supabase/functions/_shared/marketConditions/types.ts";

const base: EntrySignalInput = { trendState: "MIXED", vetoActive: false };

describe("evaluateEntrySignal — one fixture per rule, priority order (spec Section 7.4)", () => {
  it("E-VETO wins over everything else", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", vetoActive: true, breadthThrustNew: true });
    expect(r).toEqual({ signal: "WAIT", reason: "E-VETO" });
  });

  it("E-THRUST", () => {
    const r = evaluateEntrySignal({ ...base, breadthThrustNew: true });
    expect(r).toEqual({ signal: "ADD", reason: "E-THRUST" });
  });

  it("E-DIP (RSI branch)", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", breadthScore: 0.1, rsi14: 35 });
    expect(r).toEqual({ signal: "ADD", reason: "E-DIP" });
  });

  it("E-DIP (stretch branch)", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", breadthScore: 0, stretch50d: -2.0 });
    expect(r).toEqual({ signal: "ADD", reason: "E-DIP" });
  });

  it("E-DIP (oversold-pct branch)", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", breadthScore: 0, pctOversold: 25 });
    expect(r).toEqual({ signal: "ADD", reason: "E-DIP" });
  });

  it("E-HOT", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", rsi14: 80, stretch50d: 2.5 });
    expect(r).toEqual({ signal: "WAIT", reason: "E-HOT" });
  });

  it("E-TOP", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "UP", breadthDivergence: true, rsi14: 75 });
    expect(r).toEqual({ signal: "TRIM", reason: "E-TOP" });
  });

  it("E-CAPITULATION", () => {
    const r = evaluateEntrySignal({
      ...base, trendState: "DOWN", pctOversold: 45,
      vixTermStructureRecentlyAbove1: true, vixTermStructureNowBelow1: true,
    });
    expect(r).toEqual({ signal: "ADD_SMALL", reason: "E-CAPITULATION" });
  });

  it("E-DOWN (falls through when capitulation conditions aren't fully met)", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "DOWN", pctOversold: 45 }); // missing the VIX crossing
    expect(r).toEqual({ signal: "WAIT", reason: "E-DOWN" });
  });

  it("E-DEFAULT", () => {
    const r = evaluateEntrySignal({ ...base, trendState: "MIXED" });
    expect(r).toEqual({ signal: "NEUTRAL", reason: "E-DEFAULT" });
  });
});

describe("evaluateEntrySignal — Phase 1 (breadth/oscillator fields undefined)", () => {
  it("reduces to VETO/DOWN/DEFAULT only, since breadth-dependent rules can never match", () => {
    expect(evaluateEntrySignal({ trendState: "UP", vetoActive: false })).toEqual({ signal: "NEUTRAL", reason: "E-DEFAULT" });
    expect(evaluateEntrySignal({ trendState: "DOWN", vetoActive: false })).toEqual({ signal: "WAIT", reason: "E-DOWN" });
    expect(evaluateEntrySignal({ trendState: "MIXED", vetoActive: true })).toEqual({ signal: "WAIT", reason: "E-VETO" });
  });
});
