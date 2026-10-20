import { describe, it, expect } from "vitest";
import { computeVwapZ, computeVwapState, computeAction, ActionInputs } from "../supabase/functions/_shared/ruleBreaker/vwap.ts";

describe("computeVwapZ", () => {
  it("= (close - vwap6_a) / vwap6_sigma, confirmed exact on multiple real cases", () => {
    expect(computeVwapZ(538.05, 587.06, 44.055)).toBeCloseTo(-1.11, 2);
    expect(computeVwapZ(147.96, 154.5, 7.6704)).toBeCloseTo(-0.85, 2);
  });
});

describe("computeVwapState", () => {
  it("a fresh 'u' signal this week wins outright, regardless of z", () => {
    expect(computeVwapState(0.04, "u", 259.59, 252.55)).toBe("Entry signal");
    expect(computeVwapState(2.42, "u", 43.719, 43.53)).toBe("Entry signal");
  });

  it("z<0 with no fresh signal -> Below VWAP", () => {
    expect(computeVwapState(-0.2, null, 25.262, 25.212)).toBe("Below VWAP: exit / stay out");
  });

  it("z>=0, vwap6 rising week-over-week, no fresh signal -> Uptrend: hold", () => {
    expect(computeVwapState(1.16, null, 152.3, 148.16)).toBe("Uptrend: hold");
  });

  it("z>=0, vwap6 falling week-over-week, no fresh signal -> Above, VWAP falling: caution", () => {
    expect(computeVwapState(2.01, null, 162.12, 163.3)).toBe("Above, VWAP falling: caution");
  });
});

describe("computeAction", () => {
  const base: ActionInputs = {
    symbol: "TESTCO",
    score: 90,
    safety: 80,
    met: 6,
    owned: false,
    vwapState: "Uptrend: hold",
    vwapZ: 0.5,
    closedOn: null,
    priorWeekScore: 90,
    vwap6a: 100,
    vwap6sigma: 10,
  };

  it("closed recommendation always wins -> nonew, regardless of everything else", () => {
    const r = computeAction({ ...base, closedOn: "2026-09-30", score: 99, safety: 99 });
    expect(r.actionKey).toBe("nonew");
    expect(r.actionWhy).toContain("closed this recommendation on 2026-09-30");
  });

  it("safety < 20 vetoes even a high score/good vwap position", () => {
    const r = computeAction({ ...base, safety: 13, score: 95 });
    expect(r.actionKey).toBe("nonew");
    expect(r.actionWhy).toBe("Safety veto: debt or volatility too high (13).");
  });

  it("score < 50 -> nonew, confirmed clean boundary (49 fails, 50 does not hit this branch)", () => {
    const r = computeAction({ ...base, score: 49 });
    expect(r.actionKey).toBe("nonew");
    expect(r.actionWhy).toBe("Score 49 is under 50.");
  });

  it("newly qualified (last week <50, this week >=50) -> wait, regardless of vwap_state", () => {
    const r = computeAction({ ...base, score: 60, priorWeekScore: 48, vwapState: "Below VWAP: exit / stay out" });
    expect(r.actionKey).toBe("wait");
    expect(r.actionWhy).toBe("Newly qualified (last week 48): confirm next week.");
  });

  it("owned=true always holds once qualifying, regardless of vwap_state/vwap_z", () => {
    expect(computeAction({ ...base, owned: true, vwapState: "Below VWAP: exit / stay out", vwapZ: -2.3 }).actionKey).toBe("hold");
    expect(computeAction({ ...base, owned: true, vwapState: "Uptrend: hold", vwapZ: 0.37 }).actionKey).toBe("hold");
    expect(computeAction({ ...base, owned: true, vwapState: "Uptrend: hold", vwapZ: 2.06 }).actionKey).toBe("hold");
  });

  it("not owned, below VWAP -> wait", () => {
    const r = computeAction({ ...base, vwapState: "Below VWAP: exit / stay out", vwapZ: -1.75 });
    expect(r.actionKey).toBe("wait");
    expect(r.actionWhy).toContain("below its VWAP");
  });

  it("not owned, VWAP falling -> wait", () => {
    const r = computeAction({ ...base, vwapState: "Above, VWAP falling: caution", vwapZ: 2.01 });
    expect(r.actionKey).toBe("wait");
    expect(r.actionWhy).toBe("Qualifies, but VWAP is falling (risk control).");
  });

  it("not owned, Uptrend/Entry, z in [0,1) -> half size, with 'not a Rule Breaker' wording when met<6", () => {
    const r = computeAction({ ...base, vwapState: "Entry signal", vwapZ: 0.37, met: 4 });
    expect(r.actionKey).toBe("half");
    expect(r.actionWhy).toContain("not a Rule Breaker");
  });

  it("not owned, Uptrend/Entry, z in [1,2) -> buy on pullback, with the confirmed exact zone formula [vwap6a, vwap6a+sigma]", () => {
    const r = computeAction({ ...base, vwapState: "Entry signal", vwapZ: 1.7, met: 5, vwap6a: 15.472, vwap6sigma: 2.3463 });
    expect(r.actionKey).toBe("pull");
    expect(r.actionWhy).toContain("15.47");
    expect(r.actionWhy).toContain("17.82");
  });

  it("not owned, met=6, z>=2 -> full buy (the one confirmed real example's exact condition)", () => {
    const r = computeAction({ ...base, vwapState: "Entry signal", vwapZ: 2.42, met: 6, vwap6a: 43.719 });
    expect(r.actionKey).toBe("buy");
    expect(r.actionWhy).not.toContain("not a Rule Breaker");
  });
});
