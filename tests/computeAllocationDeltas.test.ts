import { describe, it, expect } from "vitest";
import { computeAllocationDeltas } from "../lib/simulatorKeys";

describe("computeAllocationDeltas", () => {
  it("splits a bucket's target pro-rata by current value when no sectorTargets given", () => {
    const holdings = [
      { symbol: "A", simulator_key: "eq", current_value: 6000 },
      { symbol: "B", simulator_key: "eq", current_value: 2000 },
    ];
    const { actionRows } = computeAllocationDeltas(holdings, { eq: 40 });
    const byKey = Object.fromEntries(actionRows.map((r) => [r.symbol, r]));
    // A is 75% of the eq bucket's current value, B is 25% — target split follows the same ratio.
    expect(byKey.A.newPct).toBeCloseTo(30, 5); // 40 * 0.75
    expect(byKey.B.newPct).toBeCloseTo(10, 5); // 40 * 0.25
  });

  it("overrides the within-bucket split for symbols present in sectorTargets", () => {
    const holdings = [
      { symbol: "A", simulator_key: "eq", current_value: 6000 },
      { symbol: "B", simulator_key: "eq", current_value: 2000 },
    ];
    // A should get 90% of the eq target regardless of its current-value share, B falls back to pro-rata.
    const { actionRows } = computeAllocationDeltas(holdings, { eq: 40 }, { sectorTargets: { A: 90 } });
    const byKey = Object.fromEntries(actionRows.map((r) => [r.symbol, r]));
    expect(byKey.A.newPct).toBeCloseTo(36, 5); // 40 * 0.90
  });

  it("mixes sector-tilted and untilted symbols in the same bucket safely", () => {
    const holdings = [
      { symbol: "XLE", simulator_key: "eq", current_value: 1000 },
      { symbol: "VTI", simulator_key: "eq", current_value: 9000 }, // not in sectorTargets
    ];
    const { actionRows } = computeAllocationDeltas(
      holdings,
      { eq: 100 },
      { sectorTargets: { XLE: 4 } }, // only XLE is sector-tilted
    );
    const byKey = Object.fromEntries(actionRows.map((r) => [r.symbol, r]));
    expect(byKey.XLE.newPct).toBeCloseTo(4, 5); // 100 * 0.04, ignores its 10% current-value share
    expect(byKey.VTI.newPct).toBeCloseTo(90, 5); // falls back to pro-rata: 100 * (9000/10000)
  });
});
