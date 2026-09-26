import { describe, it, expect } from "vitest";
import { capexMultipliersBySymbol, mergeExposureMultipliers, describeCapexCuts } from "../lib/capexOverlay";
import { computeAllocationDeltas } from "../lib/simulatorKeys";

const rows = (shadow: boolean) => [
  { symbol: "VT", bucket: "equity", exposure_multiplier: 0.85, shadow_mode: shadow },
  { symbol: "SMH", bucket: "ai_semis", exposure_multiplier: 1.03, shadow_mode: shadow },
  { symbol: "HYG", bucket: "credit", exposure_multiplier: 0.8505, shadow_mode: shadow },
];

describe("capexMultipliersBySymbol", () => {
  it("is not applied while shadow_mode is on", () => {
    expect(capexMultipliersBySymbol(rows(true)).applied).toBe(false);
  });
  it("is applied once shadow_mode is off", () => {
    expect(capexMultipliersBySymbol(rows(false)).applied).toBe(true);
  });
  it("caps multipliers at 1 (downside-only)", () => {
    const { bySymbol } = capexMultipliersBySymbol(rows(false));
    expect(bySymbol.SMH).toBe(1);
    expect(bySymbol.VT).toBeCloseTo(0.85, 6);
  });
  it("handles empty/missing input", () => {
    expect(capexMultipliersBySymbol(undefined)).toEqual({ applied: false, bySymbol: {} });
  });
});

describe("mergeExposureMultipliers", () => {
  it("multiplies with the resize overlay and treats missing symbols as 1", () => {
    const merged = mergeExposureMultipliers({ VT: 0.5, GLDM: 0 }, { VT: 0.85, HYG: 0.8 });
    expect(merged.VT).toBeCloseTo(0.425, 6);
    expect(merged.GLDM).toBe(0);
    expect(merged.HYG).toBeCloseTo(0.8, 6);
  });
});

describe("describeCapexCuts", () => {
  it("lists only buckets being cut", () => {
    const cuts = describeCapexCuts(rows(true));
    expect(cuts.map((c) => c.bucket).sort()).toEqual(["credit", "equity"]);
  });
});

describe("integration with computeAllocationDeltas", () => {
  it("scales a holding's target by the merged multiplier", () => {
    const holdings = [
      { symbol: "VT", simulator_key: "eq", current_value: 6000 },
      { symbol: "USFR", simulator_key: "cash", current_value: 4000 },
    ];
    const { bySymbol } = capexMultipliersBySymbol(rows(false));
    const exposureMultipliers = mergeExposureMultipliers({}, bySymbol);
    const { actionRows } = computeAllocationDeltas(holdings, { eq: 60, cash: 40 }, { exposureMultipliers });
    const vt = actionRows.find((r) => r.symbol === "VT");
    expect(vt.newPct).toBeCloseTo(51, 5); // 60 * 0.85
    expect(vt.exposureMultiplier).toBeCloseTo(0.85, 6);
  });
});
