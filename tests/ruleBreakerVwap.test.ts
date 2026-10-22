import { describe, it, expect } from "vitest";
import { computeVwapZ, computeVwapState, computeAction, ActionInputs, NO_VWAP_DATA } from "../supabase/functions/_shared/ruleBreaker/vwap.ts";

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

  it("returns NO_VWAP_DATA rather than throwing when given fewer than 8 weeks of history -- a per-symbol data gap must never abort scoring the rest of the universe", () => {
    expect(computeVwapState(bars([[1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]))).toBe(NO_VWAP_DATA);
  });

  it("returns NO_VWAP_DATA for a brand-new symbol with zero weeks of history", () => {
    expect(computeVwapState([])).toBe(NO_VWAP_DATA);
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
    price: 101,
    riskType: "Moderate",
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

  it("newly-qualified threshold rises to 60 when THIS week's score is >=60 -- confirmed real case (BRZE, 2026-10-20): last week 49, this week 62 -> Wait, even though 49 already cleared the flat 50 bar", () => {
    const r = computeAction({ ...base, score: 62, priorWeekScore: 49, vwapState: "Entry signal", vwapZ: 0.5 });
    expect(r.actionKey).toBe("wait");
    expect(r.actionWhy).toBe("Newly qualified (last week 49): confirm next week.");
  });

  it("newly-qualified threshold stays at 50 when THIS week's score is <60 -- confirmed real case (EXEL, 2026-10-20): last week 44, this week 52 -> Wait (52<60 so the bar stays 50, and 44<50)", () => {
    const r = computeAction({ ...base, score: 52, priorWeekScore: 44, vwapState: "Entry signal", vwapZ: 0.5 });
    expect(r.actionKey).toBe("wait");
    expect(r.actionWhy).toBe("Newly qualified (last week 44): confirm next week.");
  });

  it("score>=60 raising the threshold to 60 can flag a symbol that already cleared the flat 50 bar last week -- last week 55 (>=50, qualified under the old flat rule) but this week's score 62 raises the bar to 60, so 55<60 -> still Wait", () => {
    const r = computeAction({ ...base, score: 62, priorWeekScore: 55, vwapState: "Entry signal", vwapZ: 0.5 });
    expect(r.actionKey).toBe("wait");
  });

  it("score<60 keeps the threshold at 50 -- last week 55 clears the flat 50 bar and this week's score 58 doesn't raise it to 60, so no newly-qualified wait", () => {
    const r = computeAction({ ...base, score: 58, priorWeekScore: 55, vwapState: "Entry signal", vwapZ: 0.5, met: 4 });
    expect(r.actionKey).not.toBe("wait");
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
    const r = computeAction({ ...base, vwapState: "Entry signal", vwapZ: 1.7, met: 5, vwap6a: 15.472, vwap6sigma: 2.3463, price: 16.1 });
    expect(r.actionKey).toBe("pull");
    expect(r.actionWhy).toContain("15.47");
    expect(r.actionWhy).toContain("17.82");
  });

  it("not owned, met=6, z>=2 -> full buy (the one confirmed real example's exact condition)", () => {
    const r = computeAction({ ...base, vwapState: "Entry signal", vwapZ: 2.42, met: 6, vwap6a: 43.719, price: 47.04 });
    expect(r.actionKey).toBe("buy");
    expect(r.actionWhy).not.toContain("not a Rule Breaker");
    expect(r.actionWhy).toContain("47.04");
  });

  it("not owned, met!=6, z>=2 -> half size, not buy on pullback -- confirmed real case (DOCS, 2026-10-20): met=3, z=2.41 resolved to 'Half size', not 'Buy on pullback'", () => {
    const r = computeAction({ ...base, vwapState: "Uptrend: hold", vwapZ: 2.41, met: 3, vwap6a: 30, vwap6sigma: 1.4, price: 33.35 });
    expect(r.actionKey).toBe("half");
    expect(r.actionWhy).toBe(
      "Stretched above +2σ (33.35). In the backtest these kept rising more often than not; consider a smaller starter position. Half size (score 90).",
    );
  });

  it("not owned, pull/half bands append an Aggressive risk caveat when riskType is Aggressive, never when Moderate/Cautious -- confirmed via real IOT/FIGS/RDDT/WRBY (Aggressive, caveat present) vs ONON/UI/TSLA/SHOP/ATRC/ISRG (Moderate, absent) on 2026-10-20", () => {
    const aggressive = computeAction({ ...base, vwapState: "Entry signal", vwapZ: 0.4, met: 4, riskType: "Aggressive" });
    expect(aggressive.actionWhy).toContain("Aggressive: keep it small.");
    const moderate = computeAction({ ...base, vwapState: "Entry signal", vwapZ: 0.4, met: 4, riskType: "Moderate" });
    expect(moderate.actionWhy).not.toContain("keep it small");
  });

  it("owned Hold branches never append the Aggressive risk caveat, even when riskType is Aggressive -- confirmed via 7 real owned+Aggressive rows on 2026-10-20, none carry it", () => {
    const r = computeAction({ ...base, owned: true, vwapState: "Below VWAP: exit / stay out", riskType: "Aggressive" });
    expect(r.actionWhy).not.toContain("keep it small");
  });

  it("NO_VWAP_DATA -> neutral wait, regardless of owned, with null vwapZ/vwap6a/vwap6sigma/price (no weekly-bar history to band on)", () => {
    const notOwned = computeAction({ ...base, vwapState: NO_VWAP_DATA, vwapZ: null, vwap6a: null, vwap6sigma: null, price: null });
    expect(notOwned.actionKey).toBe("wait");
    expect(notOwned.actionWhy).toBe("No VWAP data yet for this symbol.");
    const owned = computeAction({ ...base, owned: true, vwapState: NO_VWAP_DATA, vwapZ: null, vwap6a: null, vwap6sigma: null, price: null });
    expect(owned.actionKey).toBe("wait");
  });

  it("gates above NO_VWAP_DATA still win outright even with no weekly-bar history", () => {
    const closed = computeAction({ ...base, vwapState: NO_VWAP_DATA, vwapZ: null, vwap6a: null, vwap6sigma: null, price: null, closedOn: "2026-09-30" });
    expect(closed.actionKey).toBe("nonew");
    const vetoed = computeAction({ ...base, vwapState: NO_VWAP_DATA, vwapZ: null, vwap6a: null, vwap6sigma: null, price: null, safety: 10 });
    expect(vetoed.actionKey).toBe("nonew");
  });
});
