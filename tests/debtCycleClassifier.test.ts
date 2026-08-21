import { describe, it, expect } from "vitest";
import {
  classifyDebtCycleStageV2,
  isSustainedRising,
  isSustainedPositive,
  type ClassifierInput,
  type WeeklyPoint,
} from "../supabase/functions/_shared/debtCycleClassifier.ts";

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
      debtToTaxRevenueX: 7.46,
      // Falling: 20.8 down to 20.0 over 8 prints.
      walclPctGdpSeries: series([20.8, 20.9, 21.0, 21.1, 21.2, 21.3, 21.4, 21.5]),
      indirectBidderShareSeries: series([57.5, 56.0, 58.0, 55.0, 57.0, 60.0]),
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
      debtToTaxRevenueX: 6,
      // Rising 8-of-8: 20.0 up to 23.5.
      walclPctGdpSeries: series([23.5, 23.0, 22.5, 22.0, 21.5, 21.0, 20.5, 20.0]),
      indirectBidderShareSeries: series([70, 71, 69, 72, 70, 68]),
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
      debtToTaxRevenueX: 8,
      walclPctGdpSeries: series([30.0, 29.5, 29.0, 28.5, 28.0, 27.5, 27.0, 26.5]),
      // Weak: trailing-6 average well under 57.5.
      indirectBidderShareSeries: series([50, 52, 48, 51, 49, 53]),
      bidToCoverSeries: series([1.8, 1.9, 1.7, 1.85, 1.75, 1.95]),
      // Sustained positive 7-of-8.
      somaLongDurationDeltaSeries: series([5, 3, 6, 2, 4, 7, 1, -1]),
    };
    const result = classifyDebtCycleStageV2(input);
    expect(result.stage).toBe("MP3");
    expect(result.conditions.mp3AuctionDemandWeak).toBe(true);
    expect(result.conditions.mp3SomaAbsorbing).toBe(true);
  });

  it("thin data never silently promotes the stage", () => {
    const input: ClassifierInput = {
      fedFundsMid: 0.1,
      interestExpenseRevenuePct: 25,
      rateGrowthSpread: 1.5,
      debtToTaxRevenueX: null,
      walclPctGdpSeries: series([25.0]), // only 1 distinct print
      indirectBidderShareSeries: [],
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
