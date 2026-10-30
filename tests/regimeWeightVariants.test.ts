import { describe, it, expect } from "vitest";
import { REGIME_WEIGHT_SETS as SHARED_SETS, getWeightSet } from "../supabase/functions/_shared/regimeWeights.ts";
import { REGIME_WEIGHT_SETS as LIB_SETS, getWeightSet as libGetWeightSet } from "../lib/simulatorKeys.js";
import { deriveVariant } from "../supabase/functions/_shared/regimeShiftRules.ts";

describe("REGIME_WEIGHT_SETS sums to 100", () => {
  for (const [key, variants] of Object.entries(SHARED_SETS)) {
    for (const variant of Object.keys(variants)) {
      it(`${key}.${variant}`, () => {
        const sum = Object.values(variants[variant]).reduce((a, b) => a + b, 0);
        expect(sum).toBe(100);
      });
    }
  }
});

describe("getWeightSet fallback chain", () => {
  it("fg_ri has its own distinct high_accel and high_decel sets, not a fallback", () => {
    const high = getWeightSet("fg_ri", "high")!;
    const accel = getWeightSet("fg_ri", "high_accel")!;
    const decel = getWeightSet("fg_ri", "high_decel")!;
    expect(accel).not.toEqual(high);
    expect(decel).not.toEqual(high);
    expect(accel).not.toEqual(decel);
  });

  it("rg_ri has no distinct high_accel set -- falls back to plain high", () => {
    expect(getWeightSet("rg_ri", "high_accel")).toEqual(getWeightSet("rg_ri", "high"));
    // but high_decel IS distinct for rg_ri
    expect(getWeightSet("rg_ri", "high_decel")).not.toEqual(getWeightSet("rg_ri", "high"));
  });

  it("rg_fi/fg_fi never vary (D-8) -- any non-base variant falls back to base", () => {
    expect(getWeightSet("rg_fi", "high")).toEqual(getWeightSet("rg_fi", "base"));
    expect(getWeightSet("rg_fi", "high_accel")).toEqual(getWeightSet("rg_fi", "base"));
    expect(getWeightSet("fg_fi", "high_decel")).toEqual(getWeightSet("fg_fi", "base"));
  });

  it("an unknown key returns undefined, not a crash", () => {
    expect(getWeightSet("not_a_real_key", "base")).toBeUndefined();
  });
});

describe("getWeightSet drift (lib/simulatorKeys.js vs. _shared/regimeWeights.ts)", () => {
  it("both copies agree on every key, variant, and bucket", () => {
    expect(Object.keys(SHARED_SETS).sort()).toEqual(Object.keys(LIB_SETS).sort());
    for (const key of Object.keys(SHARED_SETS)) {
      expect(Object.keys(SHARED_SETS[key]).sort(), `variant set mismatch for ${key}`).toEqual(Object.keys(LIB_SETS[key]).sort());
      for (const variant of Object.keys(SHARED_SETS[key])) {
        expect(SHARED_SETS[key][variant], `mismatch for ${key}.${variant}`).toEqual(LIB_SETS[key][variant]);
      }
    }
  });
  it("both getWeightSet implementations resolve identically, including the fallback chain", () => {
    for (const [key, variant] of [["fg_ri", "high_accel"], ["rg_ri", "high_accel"], ["rg_fi", "high"], ["fg_fi", "base"]]) {
      expect(getWeightSet(key, variant)).toEqual(libGetWeightSet(key, variant));
    }
  });
});

describe("deriveVariant (§3.3)", () => {
  it("contained is always base, regardless of accel vote", () => {
    expect(deriveVariant("contained", "accelerating")).toBe("base");
    expect(deriveVariant("contained", null)).toBe("base");
  });
  it("overheating/stagflation with a mixed vote is plain high", () => {
    expect(deriveVariant("overheating", "mixed")).toBe("high");
    expect(deriveVariant("stagflation", null)).toBe("high");
  });
  it("overheating/stagflation with a clear vote gets the accel/decel suffix", () => {
    expect(deriveVariant("overheating", "accelerating")).toBe("high_accel");
    expect(deriveVariant("stagflation", "decelerating")).toBe("high_decel");
  });
});
