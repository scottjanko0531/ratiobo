import { describe, it, expect } from "vitest";
import { REGIME_WEIGHT_SETS as SHARED_SETS, getWeightSet, LEGACY_WEIGHTS as SHARED_LEGACY, applyNbInterimTreatment } from "../supabase/functions/_shared/regimeWeights.ts";
import { REGIME_WEIGHT_SETS as LIB_SETS, getWeightSet as libGetWeightSet, LEGACY_WEIGHTS as LIB_LEGACY, applyNbInterimTreatment as libApplyNbInterimTreatment } from "../lib/simulatorKeys.js";
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

describe("LEGACY_WEIGHTS (frozen pre-Phase-2/3 baseline)", () => {
  it("lib and shared copies agree", () => {
    expect(Object.keys(SHARED_LEGACY).sort()).toEqual(Object.keys(LIB_LEGACY).sort());
    for (const key of Object.keys(SHARED_LEGACY)) {
      expect(SHARED_LEGACY[key], `mismatch for ${key}`).toEqual(LIB_LEGACY[key]);
    }
  });
  it("every set sums to 100", () => {
    for (const key of Object.keys(SHARED_LEGACY)) {
      const sum = Object.values(SHARED_LEGACY[key]).reduce((a, b) => a + b, 0);
      expect(sum, `${key} sums to ${sum}`).toBe(100);
    }
  });
  it("fg_ri's frozen base differs from the current (D-1-revised) shared base -- the whole point of freezing it", () => {
    expect(SHARED_LEGACY.fg_ri).not.toEqual(getWeightSet("fg_ri", "base"));
  });
  it("rg_fi/rg_ri/fg_fi happen to be unchanged by D-1, so they still match the shared base", () => {
    expect(SHARED_LEGACY.rg_fi).toEqual(getWeightSet("rg_fi", "base"));
    expect(SHARED_LEGACY.rg_ri).toEqual(getWeightSet("rg_ri", "base"));
    expect(SHARED_LEGACY.fg_fi).toEqual(getWeightSet("fg_fi", "base"));
  });
});

describe("applyNbInterimTreatment (fg_ri nb -> cash/tip until IEI is held, Scott's decision 2026-10-30)", () => {
  for (const variant of ["base", "high", "high_accel", "high_decel"] as const) {
    it(`fg_ri.${variant}: redistributes nb into cash/tip and still sums to 100 when IEI isn't held`, () => {
      const w = getWeightSet("fg_ri", variant)!;
      const treated = applyNbInterimTreatment("fg_ri", w, false);
      expect(treated.nb).toBe(0);
      const sum = Object.values(treated).reduce((a, b) => a + b, 0);
      expect(sum).toBe(100);
      // nb's full amount landed in cash+tip, split as evenly as rounding allows.
      expect((treated.cash - w.cash) + (treated.tip - w.tip)).toBe(w.nb);
    });
  }

  it("no-op once IEI is held, regardless of key", () => {
    const w = getWeightSet("fg_ri", "base")!;
    expect(applyNbInterimTreatment("fg_ri", w, true)).toEqual(w);
  });

  it("no-op for every non-fg_ri key, held or not (rg_fi/fg_fi's nb is unchanged by Phase 3, out of scope)", () => {
    for (const key of ["rg_fi", "rg_ri", "fg_fi"]) {
      const w = getWeightSet(key, "base")!;
      expect(applyNbInterimTreatment(key, w, false)).toEqual(w);
    }
  });

  it("no-op when nb is already 0 (e.g. rg_ri's fg_ri-shaped lookalike never happens, but guard anyway)", () => {
    const w = { eq: 50, nb: 0, cash: 50 };
    expect(applyNbInterimTreatment("fg_ri", w, false)).toEqual(w);
  });

  it("lib and shared copies agree", () => {
    for (const variant of ["base", "high", "high_accel", "high_decel"]) {
      const w = getWeightSet("fg_ri", variant)!;
      expect(applyNbInterimTreatment("fg_ri", w, false)).toEqual(libApplyNbInterimTreatment("fg_ri", w, false));
    }
  });
});
