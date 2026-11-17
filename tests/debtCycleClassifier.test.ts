import { describe, it, expect } from "vitest";
import {
  classifyDebtCycleStageV2,
  isSustainedRising,
  isSustainedPositive,
  type ClassifierInput,
  type WeeklyPoint,
} from "../supabase/functions/_shared/debtCycleClassifier.ts";
import type { HysteresisGateResult } from "../supabase/functions/_shared/hysteresisGate.ts";

// indirectBidderShareAvg6 is precomputed by the caller (Phase 4a — see
// _shared/indirectBidder.ts) rather than a series the classifier averages
// itself, so these fixtures just supply the pre-averaged number directly.

// v2 Phase 3: debtServiceStrainedGate is also precomputed by the caller
// (_shared/hysteresisGate.ts) rather than derived by the classifier itself
// — this helper builds a confirmed (non-bootstrap) gate result consistent
// with whatever raw interestExpenseRevenuePct the fixture also supplies,
// since the classifier only reads gate.armed, not the raw value, for its
// own debtServiceStrained condition. Dedicated hysteresis-mechanics tests
// (persistence, dead band, disarm, insufficient history) live in
// tests/hysteresisGate.test.ts, not duplicated here.
function gate(armed: boolean, overrides: Partial<HysteresisGateResult> = {}): HysteresisGateResult {
  return { armed, insufficientHistory: false, monthsAvailable: 3, latest: armed ? 21 : 19, ...overrides };
}

// Builds a most-recent-first WeeklyPoint series from a plain array of values,
// spaced one week apart ending today.
function series(values: number[]): WeeklyPoint[] {
  const now = new Date("2026-08-21T00:00:00Z");
  return values.map((value, i) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i * 7);
    return { date: d.toISOString().slice(0, 10), value };
  });
}

describe("classifyDebtCycleStageV2", () => {
  it("golden fixture (2026-08-21) resolves to MP1 (strained)", () => {
    const input: ClassifierInput = {
      fedFundsMid: 3.625,
      interestExpenseRevenuePct: 23.8,
      debtServiceStrainedGate: gate(true, { latest: 23.8 }),
      rateGrowthSpread: 2.548,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: 7.46,
      // Falling: 20.8 down to 20.0 over 8 prints.
      walclPctGdpSeries: series([20.8, 20.9, 21.0, 21.1, 21.2, 21.3, 21.4, 21.5]),
      indirectBidderShareAvg6: 57.25, // avg of [57.5, 56.0, 58.0, 55.0, 57.0, 60.0]
      indirectBidderShareZ: null, // not MP2/MP3, so the auction gate is never reached either way
      bidToCoverSeries: series([2.53, 2.4, 2.6, 2.5, 2.45, 2.55]),
      somaLongDurationDeltaSeries: series([-11.05, -5, 3, -2, -8, 1, -4, -3]),
    };
    const result = classifyDebtCycleStageV2(input);
    expect(result.stage).toBe("MP1 (strained)");
    expect(result.conditions.debtServiceStrained).toBe(true);
    expect(result.conditions.rGreaterG).toBe(true);
    expect(result.conditions.fedPrintingRising).toBe(false);
    expect(result.conditions.mp2Gate).toBe(false);
  });

  it("MP2 when fed funds near zero and WALCL sustained rising", () => {
    const input: ClassifierInput = {
      fedFundsMid: 0.1,
      interestExpenseRevenuePct: 15,
      debtServiceStrainedGate: gate(false, { latest: 15 }),
      rateGrowthSpread: -0.5,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: 6,
      // Rising 8-of-8: 20.0 up to 23.5.
      walclPctGdpSeries: series([23.5, 23.0, 22.5, 22.0, 21.5, 21.0, 20.5, 20.0]),
      indirectBidderShareAvg6: 70, // avg of [70, 71, 69, 72, 70, 68]
      indirectBidderShareZ: 1.8, // strong demand, well above the classifier's weak boundary
      bidToCoverSeries: series([2.6, 2.7, 2.5, 2.6, 2.65, 2.55]),
      somaLongDurationDeltaSeries: series([-2, 1, -3, 2, -1, 4, -2, 1]),
    };
    const result = classifyDebtCycleStageV2(input);
    expect(result.stage).toBe("MP2");
    expect(result.conditions.mp2Gate).toBe(true);
    expect(result.conditions.mp3AuctionDemandWeak).toBe(false);
  });

  it("MP3 when MP2 conditions hold plus weak auction demand and sustained SOMA absorption", () => {
    const input: ClassifierInput = {
      fedFundsMid: 0.1,
      interestExpenseRevenuePct: 25,
      debtServiceStrainedGate: gate(true, { latest: 25 }),
      rateGrowthSpread: 1.5,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: 8,
      walclPctGdpSeries: series([30.0, 29.5, 29.0, 28.5, 28.0, 27.5, 27.0, 26.5]),
      // Weak: well under 57.5. bidToCoverAvg6 (1.825) alone already trips
      // mp3AuctionDemandWeak < 2.0, so z is set consistently weak too rather
      // than tested in isolation here (see the dedicated z-boundary describe
      // block below for that).
      indirectBidderShareAvg6: 50.5, // avg of [50, 52, 48, 51, 49, 53]
      indirectBidderShareZ: -2.1,
      bidToCoverSeries: series([1.8, 1.9, 1.7, 1.85, 1.75, 1.95]),
      // Sustained positive 7-of-8.
      somaLongDurationDeltaSeries: series([5, 3, 6, 2, 4, 7, 1, -1]),
    };
    const result = classifyDebtCycleStageV2(input);
    expect(result.stage).toBe("MP3");
    expect(result.conditions.mp3AuctionDemandWeak).toBe(true);
    expect(result.conditions.mp3SomaAbsorbing).toBe(true);
  });

  // Phase 1 of docs/specs/debt-metrics-integrity.md: rateGrowthSpread is now
  // DGS10 minus NOMINAL GDP YoY (was real GDP YoY). Live reads as of
  // 2026-11-16 (see tests/fixtures/debt-metrics-2026-11-16.json and
  // docs/specs/debt-metrics-integrity-decisions.md Phase 1): under the OLD
  // definition rateGrowthSpread was +3.034 (rGreaterG true, strainedCount 2,
  // "MP1 (strained)"); under the CORRECTED definition it's -0.7676
  // (DGS10 5.10 minus nominal GDP YoY 5.8676), which flips rGreaterG to
  // false and strainedCount to 1. debtServiceStrained, fedPrintingRising,
  // mp2Gate, mp3AuctionDemandWeak and mp3SomaAbsorbing are all untouched by
  // Phase 1 and confirmed unchanged live (false/false/false/false except
  // debtServiceStrained=true) — walcl/auction/SOMA series below are
  // representative placeholders consistent with those live false reads,
  // not a literal historical pull (Phase 1a/1b only touch rateGrowthSpread
  // and the new informational effectiveRateGrowthSpread).
  it("2026-11-16 fixture resolves to MP1 (not strained) under the corrected r-g definition", () => {
    const input: ClassifierInput = {
      fedFundsMid: 3.875,
      interestExpenseRevenuePct: 24.593,
      debtServiceStrainedGate: gate(true, { latest: 24.593 }),
      rateGrowthSpread: -0.7676,
      effectiveRateGrowthSpread: -2.491,
      debtToTaxRevenueX: 7.303,
      walclPctGdpSeries: series([20.475, 20.5, 20.55, 20.6, 20.65, 20.7, 20.75, 20.8]),
      // Live per-term-then-mean value as of 2026-11-17 — now informational
      // only (Phase 4a consolidation); the gate reads indirectBidderShareZ.
      indirectBidderShareAvg6: 57.55,
      // Live full-history z as of 2026-11-17 (v2 Phase 1 verification:
      // docs/specs/debt-metrics-integrity-decisions.md v2 Phase 1) — well
      // above the classifier's -1.5 weak boundary, confirmed mp3AuctionDemandWeak stays false.
      indirectBidderShareZ: 1.16,
      bidToCoverSeries: series([2.53, 2.4, 2.6, 2.5, 2.45, 2.55]),
      somaLongDurationDeltaSeries: series([-11.05, -5, 3, -2, -8, 1, -4, -3]),
    };
    const result = classifyDebtCycleStageV2(input);
    expect(result.conditions.debtServiceStrained).toBe(true);
    expect(result.conditions.rGreaterG).toBe(false);
    expect(result.conditions.fedPrintingRising).toBe(false);
    expect(result.conditions.mp2Gate).toBe(false);
    expect(result.conditions.mp3AuctionDemandWeak).toBe(false);
    expect(result.stage).toBe("MP1");
    expect(result.rawInputs.effectiveRateGrowthSpread).toBe(-2.491);
  });

  // v2 Phase 1 (debt-metrics-integrity-v2 spec): the fixed 57.5 raw-value
  // threshold is retired — it could never reflect that the metric's own
  // typical range has structurally shifted over time (see the v2 Phase 0
  // distribution: full-history mean 49.34, stdev 7.05). mp3AuctionDemandWeak
  // now gates on indirectBidderShareZ <= -1.5 (INDIRECT_BIDDER_THRESHOLDS.
  // classifierWeakZ in _shared/statusThresholds.ts — the ONE threshold
  // source also used by indirectBidderIsWeak()). bidToCoverSeries is held
  // flat at a non-weak average (2.6) in every case below so only the z gate
  // is under test.
  describe("mp3AuctionDemandWeak / the z <= -1.5 boundary (v2 Phase 1)", () => {
    const baseInput: Omit<ClassifierInput, "indirectBidderShareZ"> = {
      fedFundsMid: 0.1, interestExpenseRevenuePct: 15, debtServiceStrainedGate: gate(false, { latest: 15 }),
      rateGrowthSpread: -0.5,
      effectiveRateGrowthSpread: null, debtToTaxRevenueX: null,
      walclPctGdpSeries: series([20, 20, 20, 20, 20, 20, 20, 20]),
      indirectBidderShareAvg6: 50, // informational only now; not part of the gate
      bidToCoverSeries: series([2.6, 2.6, 2.6, 2.6, 2.6, 2.6]),
      somaLongDurationDeltaSeries: series([0, 0, 0, 0, 0, 0, 0, 0]),
    };

    it("z = -1.4 (just above the boundary) is NOT weak", () => {
      const result = classifyDebtCycleStageV2({ ...baseInput, indirectBidderShareZ: -1.4 });
      expect(result.conditions.mp3AuctionDemandWeak).toBe(false);
    });

    it("z = -1.5 (exactly at the boundary) IS weak (<=, not strict <)", () => {
      const result = classifyDebtCycleStageV2({ ...baseInput, indirectBidderShareZ: -1.5 });
      expect(result.conditions.mp3AuctionDemandWeak).toBe(true);
    });

    it("z = -1.6 (below the boundary) IS weak", () => {
      const result = classifyDebtCycleStageV2({ ...baseInput, indirectBidderShareZ: -1.6 });
      expect(result.conditions.mp3AuctionDemandWeak).toBe(true);
    });

    it("null z (no history yet) is NOT weak by itself — falls through to the bidToCover gate only", () => {
      const result = classifyDebtCycleStageV2({ ...baseInput, indirectBidderShareZ: null });
      expect(result.conditions.mp3AuctionDemandWeak).toBe(false);
    });
  });

  // v2 Phase 3b: debtServiceStrained reads the caller-supplied hysteresis
  // gate's armed state directly, not a fresh raw interestExpenseRevenuePct
  // > 20 check — and rawInputs must carry both the raw value and the gate's
  // insufficientHistory/monthsAvailable so the Position Check can explain
  // "why" (3d), not just "what."
  describe("debtServiceStrained reads the gate, not a fresh raw check (v2 Phase 3b)", () => {
    const baseInput: Omit<ClassifierInput, "debtServiceStrainedGate" | "interestExpenseRevenuePct"> = {
      fedFundsMid: 0.1, rateGrowthSpread: -0.5,
      effectiveRateGrowthSpread: null, debtToTaxRevenueX: null,
      walclPctGdpSeries: series([20, 20, 20, 20, 20, 20, 20, 20]),
      indirectBidderShareAvg6: 50, indirectBidderShareZ: 0,
      bidToCoverSeries: series([2.6, 2.6, 2.6, 2.6, 2.6, 2.6]),
      somaLongDurationDeltaSeries: series([0, 0, 0, 0, 0, 0, 0, 0]),
    };

    it("a raw value above 20 with the gate OFF (not yet persistent) reads debtServiceStrained=false", () => {
      // The exact kind of case the whole gate exists to prevent: 20.7% is
      // above the old bare >20 threshold, but the gate says it hasn't held
      // for persistMonths yet.
      const result = classifyDebtCycleStageV2({
        ...baseInput, interestExpenseRevenuePct: 20.7,
        debtServiceStrainedGate: { armed: false, insufficientHistory: false, monthsAvailable: 3, latest: 20.7 },
      });
      expect(result.conditions.debtServiceStrained).toBe(false);
    });

    it("a raw value below 20 with the gate ON (persisted from an earlier high read) reads debtServiceStrained=true", () => {
      const result = classifyDebtCycleStageV2({
        ...baseInput, interestExpenseRevenuePct: 19.8,
        debtServiceStrainedGate: { armed: true, insufficientHistory: false, monthsAvailable: 3, latest: 19.8 },
      });
      expect(result.conditions.debtServiceStrained).toBe(true);
    });

    it("rawInputs carries both the raw value and the gate's insufficientHistory/monthsAvailable", () => {
      const result = classifyDebtCycleStageV2({
        ...baseInput, interestExpenseRevenuePct: 19.821,
        debtServiceStrainedGate: { armed: false, insufficientHistory: true, monthsAvailable: 1, latest: 19.821 },
      });
      expect(result.rawInputs.interestExpenseRevenuePct).toBe(19.821);
      expect(result.rawInputs.debtServiceStrainedGateInsufficientHistory).toBe(1);
      expect(result.rawInputs.debtServiceStrainedGateMonthsAvailable).toBe(1);
      expect(result.conditions.debtServiceStrained).toBe(false);
    });
  });

  it("thin data never silently promotes the stage", () => {
    const input: ClassifierInput = {
      fedFundsMid: 0.1,
      interestExpenseRevenuePct: 25,
      // Thematically consistent with this test's "thin data" point: the
      // gate itself hasn't seen enough history yet either.
      debtServiceStrainedGate: { armed: false, insufficientHistory: true, monthsAvailable: 0, latest: null },
      rateGrowthSpread: 1.5,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: null,
      walclPctGdpSeries: series([25.0]), // only 1 distinct print
      indirectBidderShareAvg6: null,
      indirectBidderShareZ: null,
      bidToCoverSeries: [],
      somaLongDurationDeltaSeries: [],
    };
    const result = classifyDebtCycleStageV2(input);
    expect(result.conditions.fedPrintingRising).toBe(false);
    expect(result.conditions.mp2Gate).toBe(false);
    expect(result.trendConfidence).toBe("unknown");
    expect(result.stage).not.toBe("MP2");
    expect(result.stage).not.toBe("MP3");
  });
});

describe("isSustainedRising", () => {
  it("requires at most one non-rising delta at the full window", () => {
    const rising = isSustainedRising(series([23.5, 23.0, 22.5, 22.0, 21.5, 21.0, 20.5, 20.0]));
    expect(rising.rising).toBe(true);
    expect(rising.confidence).toBe("normal");
  });

  it("fails when the total move is below epsilon even with mostly-up deltas", () => {
    const flat = isSustainedRising(series([20.05, 20.04, 20.03, 20.02, 20.01, 20.0, 19.99, 19.98]));
    expect(flat.rising).toBe(false);
  });
});

describe("isSustainedPositive", () => {
  it("requires at least 6 of 8 positive readings", () => {
    const positive = isSustainedPositive(series([5, 3, 6, 2, 4, 7, 1, -1]));
    expect(positive.positive).toBe(true);
  });

  it("fails when too many readings are negative", () => {
    const negative = isSustainedPositive(series([5, -3, -6, 2, -4, -7, 1, -1]));
    expect(negative.positive).toBe(false);
  });
});
