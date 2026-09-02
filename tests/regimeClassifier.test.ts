import { describe, it, expect } from "vitest";
import {
  detectRegimeKey,
  isGrowthExpanding,
  isGrowthAccelerating,
  isLaborDeteriorating,
  rateOfChangeLabel,
  POTENTIAL_GDP_GROWTH,
  GROWTH_MIN_GAP,
  CPI_MIN_GAP,
  POTENTIAL_FLOOR_FRACTION,
} from "../lib/simulatorKeys";

// Regression coverage for the "regime calc improvements" work order: before
// this, growth only needed to clear a bare `fast > slow` test to count as
// "up," which meant Stagflation and Deflationary Bust were only reachable in
// a hard landing (GDP outright negative or the trend line itself inverting).
// These tests assert all 4 quadrants are actually reachable, and pin the
// live scenario that motivated the fix (GDP fast 2.39% vs slow 2.28%, a
// 0.11pp gap — technically positive but not a real crossover).

describe("isGrowthExpanding", () => {
  it("does NOT count a marginal crossover as expanding (the live regression case)", () => {
    // GDP Growth (2Q Avg) 2.39% vs (4Q Avg) 2.28% — gap of 0.11pp, below
    // GROWTH_MIN_GAP (0.15pp). This is the exact reading that let the old
    // binary test call a decelerating economy "Expanding."
    expect(isGrowthExpanding(2.39, 2.28)).toBe(false);
  });

  it("counts a real crossover with meaningful margin, near/above potential, as expanding", () => {
    expect(isGrowthExpanding(3.0, 2.0)).toBe(true);
  });

  it("rejects a crossover that clears the gap but is still far below potential", () => {
    // Gap of 0.5pp clears GROWTH_MIN_GAP, but 1.0% fast is well under the
    // potential floor (POTENTIAL_GDP_GROWTH * POTENTIAL_FLOOR_FRACTION).
    const floor = POTENTIAL_GDP_GROWTH * POTENTIAL_FLOOR_FRACTION;
    expect(1.0).toBeLessThan(floor);
    expect(isGrowthExpanding(1.0, 0.5)).toBe(false);
  });

  it("rejects when fast is below slow at all", () => {
    expect(isGrowthExpanding(1.5, 2.0)).toBe(false);
  });
});

describe("detectRegimeKey — all 4 quadrants are reachable", () => {
  it("rg_fi (Disinflationary Boom): growing + inflation below breakeven", () => {
    const key = detectRegimeKey(3.0, 1.5, { breakeven: 2.5, gdp3yAvg: 2.0 });
    expect(key).toBe("rg_fi");
  });

  it("rg_ri (Reflation): growing + inflation above breakeven", () => {
    const key = detectRegimeKey(3.0, 3.5, { breakeven: 2.5, gdp3yAvg: 2.0 });
    expect(key).toBe("rg_ri");
  });

  it("fg_ri (Stagflation) IS reachable: negative-payrolls-style below-potential growth + rising CPI", () => {
    // Synthetic scenario from the work order: GDP running below potential
    // (1.0% vs a 1.9% potential floor of ~1.615%) with inflation printing
    // above the market's breakeven — this used to be unreachable because
    // `growing` only checked fast > slow, and a soft-but-still-positive
    // GDP print with a soft trend line would still clear that bar.
    const key = detectRegimeKey(1.0, 3.5, { breakeven: 2.5, gdp3yAvg: 0.9 });
    expect(key).toBe("fg_ri");
  });

  it("fg_ri (Stagflation) is reached by the exact live regression case", () => {
    // GDP fast 2.39 vs slow 2.28 (real numbers from the panel that motivated
    // this work order) combined with inflation above breakeven.
    const key = detectRegimeKey(2.39, 3.65, { breakeven: 2.5, gdp3yAvg: 2.28 });
    expect(key).toBe("fg_ri");
  });

  it("fg_fi (Deflationary Bust): contracting + inflation below breakeven", () => {
    const key = detectRegimeKey(-1.0, 1.0, { breakeven: 2.5, gdp3yAvg: -0.5 });
    expect(key).toBe("fg_fi");
  });

  it("all 4 regime keys are produced across a scenario sweep (no silent dead state)", () => {
    const scenarios: Array<{ gdp: number; cpi: number; breakeven: number; gdp3yAvg: number }> = [
      { gdp: 3.0, cpi: 1.5, breakeven: 2.5, gdp3yAvg: 2.0 },   // rg_fi
      { gdp: 3.0, cpi: 3.5, breakeven: 2.5, gdp3yAvg: 2.0 },   // rg_ri
      { gdp: 1.0, cpi: 3.5, breakeven: 2.5, gdp3yAvg: 0.9 },   // fg_ri
      { gdp: -1.0, cpi: 1.0, breakeven: 2.5, gdp3yAvg: -0.5 }, // fg_fi
    ];
    const seen = new Set(
      scenarios.map((s) => detectRegimeKey(s.gdp, s.cpi, { breakeven: s.breakeven, gdp3yAvg: s.gdp3yAvg }))
    );
    expect(seen).toEqual(new Set(["rg_fi", "rg_ri", "fg_ri", "fg_fi"]));
  });
});

// Regression coverage for the follow-up pass: labor data (payrolls,
// unemployment trend, jobless claims trend) previously only fed the Forward
// Signal's composite score — the Structural/Market classifiers ran on GDP
// alone, so payrolls deterioration couldn't move the headline regime word
// directly. isLaborDeteriorating + detectRegimeKey's optional labor veto
// close that gap.
describe("isLaborDeteriorating", () => {
  it("is false with no signals present", () => {
    expect(isLaborDeteriorating(null, null, null)).toBe(false);
  });

  it("is false with only one signal present (below the 2-vote minimum)", () => {
    expect(isLaborDeteriorating(-50, null, null)).toBe(false);
  });

  it("is true on a 2-of-3 majority (payrolls negative + unemployment rising)", () => {
    expect(isLaborDeteriorating(-50, 0.2, null)).toBe(true);
  });

  it("is false when only 1-of-3 present signals point to deterioration", () => {
    expect(isLaborDeteriorating(-50, 0.0, -1.0)).toBe(false);
  });

  it("is true on a clean 3-of-3", () => {
    expect(isLaborDeteriorating(-80, 0.3, 2.0)).toBe(true);
  });
});

describe("detectRegimeKey — labor veto on the growth axis", () => {
  it("a marginal GDP crossover that would read Expanding gets pulled down by labor deterioration", () => {
    // Same GDP/CPI inputs as the rg_ri (Reflation) case above (3.0 vs 2.0,
    // clears GROWTH_MIN_GAP and the potential floor) — without labor data
    // this reads rg_ri; with 2-of-3 labor signals deteriorating, it flips to
    // the growth-down side (fg_ri, Stagflation) instead.
    const withoutLabor = detectRegimeKey(3.0, 3.5, { breakeven: 2.5, gdp3yAvg: 2.0 });
    expect(withoutLabor).toBe("rg_ri");

    const withLaborVeto = detectRegimeKey(3.0, 3.5, {
      breakeven: 2.5, gdp3yAvg: 2.0,
      payrolls3mAvg: -60, unemploymentTrend: 0.2, joblessClaimsTrend: null,
    });
    expect(withLaborVeto).toBe("fg_ri");
  });

  it("labor strength never manufactures an Expanding read GDP itself doesn't support", () => {
    // GDP crossover already fails on its own (contracting) — strong labor
    // data must not flip this to a growth-up quadrant.
    const key = detectRegimeKey(-1.0, 1.0, {
      breakeven: 2.5, gdp3yAvg: -0.5,
      payrolls3mAvg: 200, unemploymentTrend: -0.3, joblessClaimsTrend: -5,
    });
    expect(key).toBe("fg_fi");
  });
});

// GDP & Inflation Regime Metrics spec, G2/I2 "Rate of Change": a pure,
// symmetric fast-vs-slow gap test with a dead band — distinct from
// isGrowthExpanding (which also requires clearing the potential-GDP floor).
describe("rateOfChangeLabel", () => {
  it("Accelerating when fast clears slow by more than minGap (GDP's 0.15pp)", () => {
    expect(rateOfChangeLabel(3.0, 2.5, GROWTH_MIN_GAP)).toBe("Accelerating");
  });

  it("Decelerating when fast trails slow by more than minGap", () => {
    expect(rateOfChangeLabel(2.0, 2.5, GROWTH_MIN_GAP)).toBe("Decelerating");
  });

  it("Stable within the dead band, either side of zero", () => {
    expect(rateOfChangeLabel(2.55, 2.5, GROWTH_MIN_GAP)).toBe("Stable");
    expect(rateOfChangeLabel(2.45, 2.5, GROWTH_MIN_GAP)).toBe("Stable");
  });

  it("uses inflation's wider 0.20pp dead band when passed CPI_MIN_GAP", () => {
    // A 0.18pp gap clears GDP's 0.15pp band (would be Accelerating there)
    // but stays inside inflation's wider 0.20pp band (Stable here) — the
    // two axes deliberately use different thresholds.
    expect(rateOfChangeLabel(2.68, 2.5, GROWTH_MIN_GAP)).toBe("Accelerating");
    expect(rateOfChangeLabel(2.68, 2.5, CPI_MIN_GAP)).toBe("Stable");
  });

  // Regression coverage for the regime-table dead-band bug fix: the "Real
  // GDP Growth — Fast vs Slow" drawer and the Regime Signal Comparison
  // table's Structural/Market Expectations Growth cells previously called
  // two DIFFERENT functions on the identical live fast/slow pair (2.39%
  // vs 2.28%) and disagreed — the drawer's rateOfChangeLabel correctly
  // said "Stable" while the table's old growthStateLabel (removed; see
  // page.jsx's rateOfChangeDisplay/stateDisplay) blended in the
  // potential-floor test and said "Decelerating." Both surfaces now call
  // rateOfChangeLabel directly (page.jsx's rateOfChangeDisplay is a thin
  // presentational wrapper with no separate classification logic), so
  // this single test structurally covers every call site — there is no
  // longer a second function that could drift out of sync.
  it("the live pair that motivated the bug fix (2.39% vs 2.28%) reads Stable everywhere", () => {
    expect(rateOfChangeLabel(2.39, 2.28, GROWTH_MIN_GAP)).toBe("Stable");
  });

  it("a gap clearly above minGap still reads Accelerating", () => {
    expect(rateOfChangeLabel(2.60, 2.28, GROWTH_MIN_GAP)).toBe("Accelerating");
  });

  it("a gap clearly below minGap still reads Decelerating", () => {
    expect(rateOfChangeLabel(2.00, 2.28, GROWTH_MIN_GAP)).toBe("Decelerating");
  });
});

// Follow-up to the dead-band bug fix: the Structural/Market classifiers'
// growth axis must use the exact same read as the Structural Growth
// panel's label — no separate, independently-computed test. isGrowthExpanding
// (still used by detectRegimeKey/run-backtest/the Regime Simulator) also
// requires clearing the potential-GDP floor; isGrowthAccelerating
// deliberately does not, since the panel's own label never checked it either.
describe("isGrowthAccelerating", () => {
  it("true only on a genuine Accelerating read (gap > minGap)", () => {
    expect(isGrowthAccelerating(2.60, 2.28)).toBe(true);
  });

  it("false for the live pair that motivated the bug fix, even though it's positive and technically clears potential", () => {
    // 2.39 vs 2.28 is a 0.11pp gap — below the 0.15pp dead band — so this
    // must be false regardless of whether 2.39% also clears the potential
    // floor (it does: 2.39 > 1.9*0.85=1.615). The point of this fix is
    // that potential no longer participates in this test at all.
    expect(isGrowthAccelerating(2.39, 2.28)).toBe(false);
  });

  it("false when Decelerating (gap < -minGap)", () => {
    expect(isGrowthAccelerating(2.00, 2.28)).toBe(false);
  });

  it("differs from isGrowthExpanding when a real crossover clears the gap but not the potential floor", () => {
    // fast=1.0, slow=0.5: gap 0.5pp clears GROWTH_MIN_GAP (0.15pp), but
    // 1.0% is well below the potential floor (1.9*0.85=1.615%).
    // isGrowthExpanding requires both and returns false; isGrowthAccelerating
    // only checks the gap and returns true — this is the exact behavioral
    // difference the fix introduces.
    expect(isGrowthExpanding(1.0, 0.5)).toBe(false);
    expect(isGrowthAccelerating(1.0, 0.5)).toBe(true);
  });
});
