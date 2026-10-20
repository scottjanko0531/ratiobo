import { describe, it, expect } from "vitest";
import { computeVwapZ, computeVwapState, computeAction, ActionInputs } from "../supabase/functions/_shared/ruleBreaker/vwap.ts";

describe("computeVwapZ", () => {
  it("= (close - vwap6_a) / vwap6_sigma, confirmed exact on multiple real cases", () => {
    expect(computeVwapZ(538.05, 587.06, 44.055)).toBeCloseTo(-1.11, 2);
    expect(computeVwapZ(147.96, 154.5, 7.6704)).toBeCloseTo(-0.85, 2);
  });
});

// Real 10-week (close, vwap6) sequences, ascending, straight from the
// baseline's own weekly-bar history -- `computeVwapState` needs the full
// history (not just the latest week or two) for its `won` backward scan.
function bars(pairs: Array<[close: number, vwap6: number]>) {
  return pairs.map(([close, vwap6]) => ({ close, vwap6 }));
}

describe("computeVwapState", () => {
  it("up && rising && won<=2 -> Entry signal -- confirmed real case (RDDT): on() turned true only 1 week before the latest", () => {
    const weeklyBars = bars([
      [153.29, 165.47], [153, 162.48], [154.46, 160.32], [157.77, 160.02], [150.85, 160.03],
      [149.84, 157.26], [147.86, 152.69], [159.91, 152.4], [156.14, 153.07], [155.14, 153.36],
    ]);
    expect(computeVwapState(weeklyBars)).toBe("Entry signal");
  });

  it("close below its own 6-wk VWAP -> Below VWAP, regardless of the rest of the history -- confirmed real case (SPCX)", () => {
    const weeklyBars = bars([
      [136.97, 127.03], [141.5, 127.39], [147.95, 130.37], [151.21, 134.68], [152.71, 144.28],
      [148.68, 146.46], [158.96, 148.55], [162.57, 153.04], [146.03, 153.93], [147.96, 154.5],
    ]);
    expect(computeVwapState(weeklyBars)).toBe("Below VWAP: exit / stay out");
  });

  it("up, rising, but won>2 (been on for a while) -> Uptrend: hold -- confirmed real case (NTRA)", () => {
    const weeklyBars = bars([
      [332.03, 290.78], [326.26, 299.49], [328.18, 306.12], [328.93, 314.52], [369.39, 331.81],
      [412.56, 347.65], [410.35, 366.48], [400.71, 378.17], [393.44, 386.16], [399.42, 391.17],
    ]);
    expect(computeVwapState(weeklyBars)).toBe("Uptrend: hold");
  });

  it("up but not rising (this week's 6-wk VWAP mean is below what it was two weeks ago) -> Above, VWAP falling: caution -- confirmed real case (ABNB); an earlier attempt compared against the stored `vwap12` field instead of recomputing `mp` from two weeks back and only matched 152/155 real rows, this exact formula matches 155/155", () => {
    const weeklyBars = bars([
      [187.3, 164.95], [189.43, 171.19], [181.94, 175.78], [170.19, 178.43], [166.22, 180.63],
      [157.47, 173.97], [162.43, 170.08], [165.87, 166.01], [173.7, 163.3], [175.46, 162.12],
    ]);
    expect(computeVwapState(weeklyBars)).toBe("Above, VWAP falling: caution");
  });

  it("throws when given fewer than 8 weeks of history", () => {
    expect(() => computeVwapState(bars([[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]))).toThrow();
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
