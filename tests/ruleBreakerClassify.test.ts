import { describe, it, expect } from "vitest";
import {
  computeScreen,
  computeQgroup,
  computeWeakPillar,
  computeRiskType,
} from "../supabase/functions/_shared/ruleBreaker/classify.ts";
import { DriverEntry } from "../supabase/functions/_shared/ruleBreaker/types.ts";

describe("computeScreen", () => {
  it("met=6 -> Rule Breaker, always", () => {
    expect(computeScreen(6, 1)).toBe("Rule Breaker");
    expect(computeScreen(6, 100)).toBe("Rule Breaker");
  });

  it("met=5 -> Watchlist, always, regardless of score (confirmed real case: score=100 still Watchlist)", () => {
    expect(computeScreen(5, 100)).toBe("Watchlist");
    expect(computeScreen(5, 1)).toBe("Watchlist");
  });

  it("met<=1 -> Doesn't fit, always, regardless of score (confirmed real case: score=26 still Doesn't fit)", () => {
    expect(computeScreen(1, 26)).toBe("Doesn't fit");
    expect(computeScreen(0, 90)).toBe("Doesn't fit");
  });

  it("met in [2,4]: score>=40 -> Watchlist, score<40 -> Doesn't fit (confirmed exact boundary)", () => {
    expect(computeScreen(3, 40)).toBe("Watchlist");
    expect(computeScreen(3, 39)).toBe("Doesn't fit");
    expect(computeScreen(2, 40)).toBe("Watchlist");
    expect(computeScreen(4, 39)).toBe("Doesn't fit");
  });
});

describe("computeQgroup", () => {
  it("only populated for met=6 rows -- null otherwise regardless of quality", () => {
    expect(computeQgroup(5, 90)).toBeNull();
    expect(computeQgroup(3, 90)).toBeNull();
  });

  it("met=6 and quality>=50 -> comp, else spec (confirmed zero violations across all 25 Rule Breaker baseline rows)", () => {
    expect(computeQgroup(6, 51)).toBe("comp");
    expect(computeQgroup(6, 47)).toBe("spec");
  });

  it("met=6 but quality null -> null", () => {
    expect(computeQgroup(6, null)).toBeNull();
  });
});

describe("computeWeakPillar", () => {
  it("reports the lowest of the 4 named sub-scores -- confirmed real case: cash pcts meaning ~10.2 is the weakest", () => {
    const cashDrivers: DriverEntry[] = [
      { name: "Accruals (lower is better)", value: 0.04, pct: 9.15 },
      { name: "Stock pay / sales (lower is better)", value: 0.21, pct: 11.26 },
    ];
    const trendDrivers: DriverEntry[] = [{ name: "Change in cash flow margin (1 yr)", value: 0.21, pct: 94.77 }];
    const profDrivers: DriverEntry[] = [
      { name: "a", value: 1, pct: 75 },
      { name: "b", value: 1, pct: 69.93 },
      { name: "c", value: 1, pct: 38.56 },
      { name: "d", value: 1, pct: 50 },
    ];
    const result = computeWeakPillar({ cashDrivers, trendDrivers, profDrivers, safety: 46 });
    expect(result).toBe("Cash earnings 10");
  });

  it("populated for every row, not just Rule Breaker tier (confirmed: non-null on all 155 baseline rows, unlike qgroup)", () => {
    const cashDrivers: DriverEntry[] = [{ name: "a", value: 1, pct: 80 }];
    const trendDrivers: DriverEntry[] = [{ name: "b", value: 1, pct: 70 }];
    const profDrivers: DriverEntry[] = [{ name: "c", value: 1, pct: 60 }];
    expect(computeWeakPillar({ cashDrivers, trendDrivers, profDrivers, safety: 90 })).toBe("Profitability 60");
  });

  it("returns null when every input is null", () => {
    expect(computeWeakPillar({ cashDrivers: [], trendDrivers: [], profDrivers: [], safety: null })).toBeNull();
  });
});

describe("computeRiskType", () => {
  it("sigma defaults to 0.5 when raw.rv is missing, mapping to 'Moderate'", () => {
    expect(computeRiskType(null)).toBe("Moderate");
  });
  it("sigma -> mdd via the lookup table -> banded into Cautious/Moderate/Aggressive -- confirmed exact against the real baseline", () => {
    expect(computeRiskType(0.1)).toBe("Cautious"); // mdd interpolates to ~0.0945, < 0.3
    expect(computeRiskType(0.4)).toBe("Moderate"); // mdd = 0.365, in [0.3, 0.5)
    expect(computeRiskType(1.2)).toBe("Aggressive"); // mdd = 0.777, >= 0.5
  });
  it("clamps sigma above 3 to the table's final point (0.99) rather than extrapolating", () => {
    expect(computeRiskType(10)).toBe("Aggressive");
  });
});
