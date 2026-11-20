import { describe, it, expect } from "vitest";
import { percentileRank, percentileStatus } from "../supabase/functions/_shared/percentileStatus.ts";

describe("percentileRank", () => {
  it("returns 100 for the maximum value in its own history", () => {
    expect(percentileRank(10, [1, 2, 3, 10])).toBe(100);
  });

  it("returns a low percentile for the minimum value", () => {
    expect(percentileRank(1, [1, 2, 3, 10])).toBe(25);
  });

  it("computes the inclusive percentage at-or-below", () => {
    // 3 of 5 values are <= 5 (1, 3, 5)
    expect(percentileRank(5, [1, 3, 5, 7, 9])).toBe(60);
  });

  it("returns null for an empty history", () => {
    expect(percentileRank(5, [])).toBeNull();
  });

  it("handles ties by counting every tied value in the numerator", () => {
    expect(percentileRank(5, [5, 5, 5, 10])).toBe(75);
  });
});

describe("percentileStatus", () => {
  it("below 50th percentile is healthy", () => {
    expect(percentileStatus(0)).toBe("healthy");
    expect(percentileStatus(49.9)).toBe("healthy");
  });

  it("50th up to (not including) 85th percentile is watch", () => {
    expect(percentileStatus(50)).toBe("watch");
    expect(percentileStatus(84.9)).toBe("watch");
  });

  it("85th percentile and above is danger", () => {
    expect(percentileStatus(85)).toBe("danger");
    expect(percentileStatus(100)).toBe("danger");
  });
});
