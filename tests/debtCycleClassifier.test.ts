import { describe, it, expect } from "vitest";
import {
  classifyDebtCycleStageV2,
  isSustainedRising,
  isSustainedPositive,
  type ClassifierInput,
  type WeeklyPoint,
} from "../supabase/functions/_shared/debtCycleClassifier.ts";

// indirectBidderShareAvg6 is precomputed by the caller (Phase 4a — see
// _shared/indirectBidder.ts) rather than a series the classifier averages
// itself, so these fixtures just supply the pre-averaged number directly.

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
      rateGrowthSpread: 2.548,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: 7.46,
      // Falling: 20.8 down to 20.0 over 8 prints.
      walclPctGdpSeries: series([20.8, 20.9, 21.0, 21.1, 21.2, 21.3, 21.4, 21.5]),
      indirectBidderShareAvg6: 57.25, // avg of [57.5, 56.0, 58.0, 55.0, 57.0, 60.0]
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
      rateGrowthSpread: -0.5,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: 6,
      // Rising 8-of-8: 20.0 up to 23.5.
      walclPctGdpSeries: series([23.5, 23.0, 22.5, 22.0, 21.5, 21.0, 20.5, 20.0]),
      indirectBidderShareAvg6: 70, // avg of [70, 71, 69, 72, 70, 68]
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
      rateGrowthSpread: 1.5,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: 8,
      walclPctGdpSeries: series([30.0, 29.5, 29.0, 28.5, 28.0, 27.5, 27.0, 26.5]),
      // Weak: well under 57.5.
      indirectBidderShareAvg6: 50.5, // avg of [50, 52, 48, 51, 49, 53]
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
      rateGrowthSpread: -0.7676,
      effectiveRateGrowthSpread: -2.491,
      debtToTaxRevenueX: 7.303,
      walclPctGdpSeries: series([20.475, 20.5, 20.55, 20.6, 20.65, 20.7, 20.75, 20.8]),
      // Live per-term-then-mean value as of 2026-11-17 (Phase 4a consolidation) —
      // just above the 57.5 "weak" boundary, confirmed mp3AuctionDemandWeak stays false.
      indirectBidderShareAvg6: 57.55,
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

  // Phase 4a: pinning the 57.5 boundary itself, not just a fixture that
  // happens to land on one side of it. The consolidated (per-term-then-mean)
  // calculation is the macro card's own method — see
  // _shared/indirectBidder.ts and the Phase 4 decisions log for why the old
  // pooled-across-both-terms average (59.3%) and the card's method (57.55%)
  // disagreed in the first place. 57.5 itself is unchanged; this just
  // confirms which side of it the corrected number falls on.
  describe("mp3AuctionDemandWeak / the 57.5 boundary", () => {
    const baseInput: Omit<ClassifierInput, "indirectBidderShareAvg6"> = {
      fedFundsMid: 0.1, interestExpenseRevenuePct: 15, rateGrowthSpread: -0.5,
      effectiveRateGrowthSpread: null, debtToTaxRevenueX: null,
      walclPctGdpSeries: series([20, 20, 20, 20, 20, 20, 20, 20]),
      bidToCoverSeries: series([2.6, 2.6, 2.6, 2.6, 2.6, 2.6]),
      somaLongDurationDeltaSeries: series([0, 0, 0, 0, 0, 0, 0, 0]),
    };

    it("just above 57.5 is NOT weak", () => {
      const result = classifyDebtCycleStageV2({ ...baseInput, indirectBidderShareAvg6: 57.55 });
      expect(result.conditions.mp3AuctionDemandWeak).toBe(false);
    });

    it("just below 57.5 IS weak", () => {
      const result = classifyDebtCycleStageV2({ ...baseInput, indirectBidderShareAvg6: 57.45 });
      expect(result.conditions.mp3AuctionDemandWeak).toBe(true);
    });

    it("exactly 57.5 is NOT weak (strict less-than)", () => {
      const result = classifyDebtCycleStageV2({ ...baseInput, indirectBidderShareAvg6: 57.5 });
      expect(result.conditions.mp3AuctionDemandWeak).toBe(false);
    });
  });

  it("thin data never silently promotes the stage", () => {
    const input: ClassifierInput = {
      fedFundsMid: 0.1,
      interestExpenseRevenuePct: 25,
      rateGrowthSpread: 1.5,
      effectiveRateGrowthSpread: null,
      debtToTaxRevenueX: null,
      walclPctGdpSeries: series([25.0]), // only 1 distinct print
      indirectBidderShareAvg6: null,
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
