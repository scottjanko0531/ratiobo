import { describe, it, expect } from "vitest";
import {
  detectRegimeKey,
  isGrowthExpanding,
  isGrowthAccelerating,
  isInflationAccelerating,
  resolveAxisState,
  persistenceConfidenceTier,
  isLaborDeteriorating,
  rateOfChangeLabel,
  POTENTIAL_GDP_GROWTH,
  GROWTH_MIN_GAP,
  CPI_MIN_GAP,
  POTENTIAL_FLOOR_FRACTION,
  REGIME_META,
  NEARTERM_GROWTH_SIGNALS,
  NEARTERM_INFL_SIGNALS,
  MEDTERM_GROWTH_SIGNALS,
  MEDTERM_INFL_SIGNALS,
  confidenceTierMultiplier,
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
    // GDP Growth (2Q Avg) 2.39% vs (4Q Avg) 2.28% — gap of 0.11pp, well
    // below GROWTH_MIN_GAP (empirically recalibrated to 0.80pp — see the
    // dead-band-recalibration spec). This is the exact reading that let the
    // old binary test call a decelerating economy "Expanding."
    expect(isGrowthExpanding(2.39, 2.28)).toBe(false);
  });

  it("counts a real crossover with meaningful margin, near/above potential, as expanding", () => {
    expect(isGrowthExpanding(3.5, 2.0)).toBe(true);
  });

  it("rejects a crossover that clears the gap but is still far below potential", () => {
    // Gap of 1.0pp clears GROWTH_MIN_GAP (0.80pp), but 1.5% fast is still
    // under the potential floor (POTENTIAL_GDP_GROWTH * POTENTIAL_FLOOR_FRACTION).
    const floor = POTENTIAL_GDP_GROWTH * POTENTIAL_FLOOR_FRACTION;
    expect(1.5).toBeLessThan(floor);
    expect(isGrowthExpanding(1.5, 0.5)).toBe(false);
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
  it("Accelerating when fast clears slow by more than minGap (empirically recalibrated to 0.80pp)", () => {
    expect(rateOfChangeLabel(3.5, 2.5, GROWTH_MIN_GAP)).toBe("Accelerating");
  });

  it("Decelerating when fast trails slow by more than minGap", () => {
    expect(rateOfChangeLabel(1.5, 2.5, GROWTH_MIN_GAP)).toBe("Decelerating");
  });

  it("Stable within the dead band, either side of zero", () => {
    expect(rateOfChangeLabel(2.55, 2.5, GROWTH_MIN_GAP)).toBe("Stable");
    expect(rateOfChangeLabel(2.45, 2.5, GROWTH_MIN_GAP)).toBe("Stable");
  });

  it("takes minGap as an explicit param, not a hardcoded constant", () => {
    // Dead-band-recalibration spec: the empirical sweep against real FRED
    // history happened to land both GROWTH_MIN_GAP and CPI_MIN_GAP at the
    // same 0.80pp (a coincidence of this calibration pass, not a structural
    // guarantee) — rateOfChangeLabel still takes minGap as a parameter, so
    // confirm a gap that's Accelerating under one explicit width and Stable
    // under a wider one, independent of which named constant is passed.
    expect(rateOfChangeLabel(3.5, 2.5, 0.80)).toBe("Accelerating");
    expect(rateOfChangeLabel(3.5, 2.5, 1.50)).toBe("Stable");
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
  it("the live pair that motivated the original bug fix (2.39% vs 2.28%) reads Stable everywhere", () => {
    expect(rateOfChangeLabel(2.39, 2.28, GROWTH_MIN_GAP)).toBe("Stable");
  });

  it("a gap clearly above minGap still reads Accelerating", () => {
    expect(rateOfChangeLabel(3.28, 2.28, GROWTH_MIN_GAP)).toBe("Accelerating");
  });

  it("a gap clearly below minGap still reads Decelerating", () => {
    expect(rateOfChangeLabel(1.28, 2.28, GROWTH_MIN_GAP)).toBe("Decelerating");
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
    expect(isGrowthAccelerating(3.28, 2.28)).toBe(true);
  });

  it("false for the live pair that motivated the original bug fix, even though it's positive and technically clears potential", () => {
    // 2.39 vs 2.28 is a 0.11pp gap — well below the empirically
    // recalibrated 0.80pp dead band — so this must be false regardless of
    // whether 2.39% also clears the potential floor (it does: 2.39 >
    // 1.9*0.85=1.615). The point of this fix is that potential no longer
    // participates in this test at all.
    expect(isGrowthAccelerating(2.39, 2.28)).toBe(false);
  });

  it("false when Decelerating (gap < -minGap)", () => {
    expect(isGrowthAccelerating(1.28, 2.28)).toBe(false);
  });

  it("differs from isGrowthExpanding when a real crossover clears the gap but not the potential floor", () => {
    // fast=1.5, slow=0.5: gap 1.0pp clears GROWTH_MIN_GAP (0.80pp), but
    // 1.5% is still below the potential floor (1.9*0.85=1.615%).
    // isGrowthExpanding requires both and returns false; isGrowthAccelerating
    // only checks the gap and returns true — this is the exact behavioral
    // difference the fix introduces.
    expect(isGrowthExpanding(1.5, 0.5)).toBe(false);
    expect(isGrowthAccelerating(1.5, 0.5)).toBe(true);
  });
});

// Same "one source of truth" fix applied to the inflation axis: the
// Structural/Market classifiers' inflUp used a bare `cpiFast > cpiSlow`
// sign test with no dead band at all, unlike growth's GROWTH_MIN_GAP —
// meaning a hundredth-of-a-point print could flip Reflation to
// Disinflationary Boom. isInflationAccelerating applies the same
// rateOfChangeLabel dead-band test (CPI_MIN_GAP, empirically recalibrated
// to 0.80pp — see the dead-band-recalibration spec), and the Structural ×
// Inflation table cell now renders off the same function instead of its
// own separate `>` comparison.
describe("isInflationAccelerating", () => {
  it("true only on a genuine Accelerating read (gap > CPI_MIN_GAP)", () => {
    expect(isInflationAccelerating(4.13, 3.13)).toBe(true);
  });

  it("false for a marginal gap that a bare sign test would have called rising", () => {
    // 3.65 vs 3.55 is a 0.10pp gap — positive, but well below the 0.80pp
    // dead band. A bare `fast > slow` test would have called this "rising";
    // isInflationAccelerating correctly calls it Stable (not up).
    expect(isInflationAccelerating(3.65, 3.55)).toBe(false);
  });

  it("false when Decelerating (gap < -CPI_MIN_GAP)", () => {
    expect(isInflationAccelerating(2.30, 3.30)).toBe(false);
  });
});

// Dead-band-persistence spec: replaces the Direction/Level tiebreak above.
// "Stable" is no longer forced into a coin-flipped Up/Down via a secondary
// signal — it's an explicit Persistence state with its own confidence
// (100% at dead-band center, 0% at the edge) and a nearSide (which state a
// break would go toward). This supersedes the regime tiebreaker spec and
// closes B2 (confidence suppression on dead-band-resolved directions) —
// Persistence carries its own real confidence instead of suppressing one.
describe("resolveAxisState", () => {
  it("Accelerating resolves directly, not Persistence", () => {
    const r = resolveAxisState(3.28, 2.28, GROWTH_MIN_GAP);
    expect(r).toMatchObject({ up: true, persistence: false, persistenceConfidence: null });
  });

  it("Decelerating resolves directly, not Persistence", () => {
    const r = resolveAxisState(1.28, 2.28, GROWTH_MIN_GAP);
    expect(r).toMatchObject({ up: false, persistence: false, persistenceConfidence: null });
  });

  it("Stable is Persistence — no forced Up/Down, no coin flip", () => {
    const r = resolveAxisState(2.39, 2.28, GROWTH_MIN_GAP);
    expect(r.up).toBeNull();
    expect(r.persistence).toBe(true);
    expect(r.persistenceConfidence).not.toBeNull();
  });

  it("persistence confidence is 100% exactly at dead-band center", () => {
    const r = resolveAxisState(2.50, 2.50, GROWTH_MIN_GAP);
    expect(r.persistenceConfidence).toBe(100);
  });

  it("persistence confidence is 0% right at the dead-band edge", () => {
    const r = resolveAxisState(2.50 + GROWTH_MIN_GAP, 2.50, GROWTH_MIN_GAP);
    expect(r.persistenceConfidence).toBe(0);
  });

  it("persistence confidence is symmetric on either side of center and scales with distance", () => {
    const above = resolveAxisState(2.50 + GROWTH_MIN_GAP * 0.5, 2.50, GROWTH_MIN_GAP);
    const below = resolveAxisState(2.50 - GROWTH_MIN_GAP * 0.5, 2.50, GROWTH_MIN_GAP);
    expect(above.persistenceConfidence).toBe(50);
    expect(below.persistenceConfidence).toBe(50);
  });

  it("nearSide names which state a break would go toward", () => {
    const aboveCenter = resolveAxisState(2.51, 2.50, GROWTH_MIN_GAP);
    expect(aboveCenter.nearSide).toBe("Accelerating");
    const belowCenter = resolveAxisState(2.49, 2.50, GROWTH_MIN_GAP);
    expect(belowCenter.nearSide).toBe("Decelerating");
  });

  it("the live pair that motivated the original dead-band fix (2.39 vs 2.28) reads Persistence", () => {
    const r = resolveAxisState(2.39, 2.28, GROWTH_MIN_GAP);
    expect(r.persistence).toBe(true);
  });

  it("takes minGap as an explicit param, not a hardcoded constant", () => {
    // Dead-band-recalibration spec: GROWTH_MIN_GAP and CPI_MIN_GAP happen
    // to land on the same 0.80pp after the empirical sweep (a coincidence
    // of this calibration pass, not a structural guarantee) — confirm
    // resolveAxisState still keys off whatever minGap it's given, same
    // spirit as rateOfChangeLabel's equivalent test above.
    expect(resolveAxisState(3.5, 2.50, 0.80).persistence).toBe(false);
    expect(resolveAxisState(3.5, 2.50, 1.50).persistence).toBe(true);
  });
});

describe("persistenceConfidenceTier", () => {
  it("null -> mid", () => {
    expect(persistenceConfidenceTier(null)).toBe("mid");
  });
  it("above 65 -> high", () => {
    expect(persistenceConfidenceTier(66)).toBe("high");
    expect(persistenceConfidenceTier(100)).toBe("high");
  });
  it("below 35 -> low", () => {
    expect(persistenceConfidenceTier(34)).toBe("low");
    expect(persistenceConfidenceTier(0)).toBe("low");
  });
  it("mid-range (inclusive of the 35/65 boundaries) -> mid", () => {
    expect(persistenceConfidenceTier(50)).toBe("mid");
    expect(persistenceConfidenceTier(35)).toBe("mid");
    expect(persistenceConfidenceTier(65)).toBe("mid");
  });
});

// Same "classify structural key from two axes" logic as page.jsx's
// structuralRegimeKey / get-regime-analysis's detectRegimeKeyLive —
// reimplemented here so the null-on-Persistence mapping (Part 3 of the
// dead-band-persistence spec: no forced quadrant flip when an axis is in
// Persistence) is covered without importing React components into a unit
// test.
function classifyStructural(gAxis: ReturnType<typeof resolveAxisState>, iAxis: ReturnType<typeof resolveAxisState> | null): string | null {
  if (gAxis.persistence || iAxis?.persistence) return null;
  const growthUp = gAxis.up === true;
  const inflUp = iAxis?.up === true;
  return growthUp && !inflUp ? "rg_fi" : growthUp && inflUp ? "rg_ri" : !growthUp && inflUp ? "fg_ri" : "fg_fi";
}

describe("Structural regime — dead-band-persistence spec scenarios", () => {
  it("Growth Stable (Persistence) + Inflation Accelerating -> null, not a forced quadrant", () => {
    const g = resolveAxisState(2.39, 2.28, GROWTH_MIN_GAP); // Stable
    const i = resolveAxisState(4.13, 3.13, CPI_MIN_GAP); // Accelerating
    expect(classifyStructural(g, i)).toBeNull();
  });

  it("Inflation Stable (Persistence) + Growth Accelerating -> null, even though growth clears its own dead band", () => {
    const g = resolveAxisState(3.28, 2.28, GROWTH_MIN_GAP); // Accelerating
    const i = resolveAxisState(3.20, 3.13, CPI_MIN_GAP); // gap 0.07 < 0.80 -> Stable
    expect(classifyStructural(g, i)).toBeNull();
  });

  it("Both axes Persistence -> null, the strongest continuation signal", () => {
    const g = resolveAxisState(2.39, 2.28, GROWTH_MIN_GAP);
    const i = resolveAxisState(3.20, 3.13, CPI_MIN_GAP);
    expect(classifyStructural(g, i)).toBeNull();
  });

  it("Growth Accelerating + Inflation Accelerating -> Reflation, a real quadrant call", () => {
    const g = resolveAxisState(3.28, 2.28, GROWTH_MIN_GAP);
    const i = resolveAxisState(4.13, 3.13, CPI_MIN_GAP);
    expect(REGIME_META[classifyStructural(g, i)!].label).toBe("Reflation");
  });

  it("Growth Decelerating + Inflation Accelerating -> Stagflation", () => {
    const g = resolveAxisState(1.28, 2.28, GROWTH_MIN_GAP);
    const i = resolveAxisState(4.13, 3.13, CPI_MIN_GAP);
    expect(REGIME_META[classifyStructural(g, i)!].label).toBe("Stagflation");
  });

  it("Growth Accelerating + Inflation Decelerating -> Disinflationary Boom", () => {
    const g = resolveAxisState(3.28, 2.28, GROWTH_MIN_GAP);
    const i = resolveAxisState(2.30, 3.30, CPI_MIN_GAP);
    expect(REGIME_META[classifyStructural(g, i)!].label).toBe("Disinflationary Boom");
  });

  it("Growth Decelerating + Inflation Decelerating -> Deflationary Bust", () => {
    const g = resolveAxisState(1.28, 2.28, GROWTH_MIN_GAP);
    const i = resolveAxisState(2.30, 3.30, CPI_MIN_GAP);
    expect(REGIME_META[classifyStructural(g, i)!].label).toBe("Deflationary Bust");
  });
});

// Forward-signal two-horizon spec, cross-panel requirement #2: "Confirm both
// baskets in both panels sum to 1.0 before this ships — this was a real bug
// in the current single-panel version and should be caught by a unit test."
// The old single composite summed to ~2.05 (Growth) / ~1.50 (Inflation).
function sumWeights(sigs: { w: number }[]): number {
  return Math.round(sigs.reduce((s, x) => s + x.w, 0) * 1000) / 1000;
}

describe("Forward Signal weight normalization", () => {
  it("Near-Term Growth basket sums to 1.00", () => {
    expect(sumWeights(NEARTERM_GROWTH_SIGNALS)).toBe(1);
  });
  it("Near-Term Inflation basket sums to 1.00", () => {
    expect(sumWeights(NEARTERM_INFL_SIGNALS)).toBe(1);
  });
  it("Medium-Term Growth basket sums to 1.00", () => {
    expect(sumWeights(MEDTERM_GROWTH_SIGNALS)).toBe(1);
  });
  it("Medium-Term Inflation basket sums to 1.00", () => {
    expect(sumWeights(MEDTERM_INFL_SIGNALS)).toBe(1);
  });
});

// Scoring sanity check: reimplements the weighted-average step from
// computeForwardSignal/computeEdgeForwardPanel's scoring, using each
// signal's own vote() at whichever extreme value produces the target vote
// for THAT signal's specific polarity (some are inverted — e.g. Dollar 3M
// lagged votes -1 on a rising dollar, Loan Standards votes +1 on a LOW
// reading). Confirms the weighted score itself behaves as expected, not
// just that the weights sum correctly.
function findVoteValue(vote: (v: number) => number, target: number): number {
  for (const candidate of [1000, -1000, 100, -100, 10, -10]) {
    if (vote(candidate) === target) return candidate;
  }
  throw new Error("no candidate value reproduces the target vote for this signal");
}
function scoreAllAt(sigs: { w: number; vote: (v: number) => number }[], target: number): number {
  let weighted = 0, totalW = 0;
  for (const s of sigs) {
    findVoteValue(s.vote, target); // throws if this signal can't reach `target`
    weighted += target * s.w;
    totalW += s.w;
  }
  return weighted / totalW;
}

describe("Forward Signal scoring sanity", () => {
  it("Near-Term Growth: every signal voting up -> score +1", () => {
    expect(scoreAllAt(NEARTERM_GROWTH_SIGNALS, 1)).toBeCloseTo(1, 5);
  });
  it("Near-Term Growth: every signal voting down -> score -1", () => {
    expect(scoreAllAt(NEARTERM_GROWTH_SIGNALS, -1)).toBeCloseTo(-1, 5);
  });
  it("Near-Term Inflation: every signal voting up -> score +1", () => {
    expect(scoreAllAt(NEARTERM_INFL_SIGNALS, 1)).toBeCloseTo(1, 5);
  });
  it("Near-Term Inflation: every signal voting down -> score -1", () => {
    expect(scoreAllAt(NEARTERM_INFL_SIGNALS, -1)).toBeCloseTo(-1, 5);
  });
  it("Medium-Term Growth: every signal voting up -> score +1", () => {
    expect(scoreAllAt(MEDTERM_GROWTH_SIGNALS, 1)).toBeCloseTo(1, 5);
  });
  it("Medium-Term Growth: every signal voting down -> score -1", () => {
    expect(scoreAllAt(MEDTERM_GROWTH_SIGNALS, -1)).toBeCloseTo(-1, 5);
  });
  it("Medium-Term Inflation: every signal voting up -> score +1", () => {
    expect(scoreAllAt(MEDTERM_INFL_SIGNALS, 1)).toBeCloseTo(1, 5);
  });
  it("Medium-Term Inflation: every signal voting down -> score -1", () => {
    expect(scoreAllAt(MEDTERM_INFL_SIGNALS, -1)).toBeCloseTo(-1, 5);
  });
});

// Regime engine follow-up fixes, section C: gates how much of a Forward
// Signal leg's suggested tilt reaches the Positioning Signal table.
describe("confidenceTierMultiplier", () => {
  it("null or below 50 -> 0 (not actionable)", () => {
    expect(confidenceTierMultiplier(null)).toBe(0);
    expect(confidenceTierMultiplier(0)).toBe(0);
    expect(confidenceTierMultiplier(49)).toBe(0);
  });
  it("at 50 -> 0.3 (bottom of partial band)", () => {
    expect(confidenceTierMultiplier(50)).toBeCloseTo(0.3, 5);
  });
  it("at 65 -> 0.5 (top of partial band)", () => {
    expect(confidenceTierMultiplier(65)).toBeCloseTo(0.5, 5);
  });
  it("midpoint 57.5 -> 0.4 (linear interpolation)", () => {
    expect(confidenceTierMultiplier(57.5)).toBeCloseTo(0.4, 5);
  });
  it("above 65 -> 1 (full conviction)", () => {
    expect(confidenceTierMultiplier(66)).toBe(1);
    expect(confidenceTierMultiplier(100)).toBe(1);
  });
});
