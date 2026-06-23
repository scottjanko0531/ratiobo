/**
 * lib/__tests__/riskParity.test.js
 *
 * Run with Vitest:
 *   npm install -D vitest
 *   add "test": "vitest" to package.json scripts
 *   npm test
 */
import { describe, it, expect } from "vitest";
import {
  mean,
  stdev,
  pearson,
  cov,
  computeRiskContributions,
  solveTrueRiskParity,
  applyNaiveRiskParity,
  getLeverageMultiplier,
} from "../riskParity.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Three-asset subset drawn from the simulator's real historical data.
const ASSETS = [
  { key: "eq",  vol: 18.3 },
  { key: "nb",  vol: 7.7  },
  { key: "gld", vol: 15.0 },
];

// Pearson correlations computed from the simulator's 2001-2024 return series.
const CORR = {
  eq:  { eq: 1,     nb: -0.34, gld: -0.02 },
  nb:  { eq: -0.34, nb: 1,     gld:  0.18 },
  gld: { eq: -0.02, nb: 0.18,  gld:  1    },
};

// ── mean ─────────────────────────────────────────────────────────────────────
describe("mean", () => {
  it("returns arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBeCloseTo(3);
  });
  it("handles a single element", () => {
    expect(mean([42])).toBe(42);
  });
});

// ── stdev ────────────────────────────────────────────────────────────────────
describe("stdev", () => {
  it("matches known sample stdev", () => {
    // stdev([2,4,4,4,5,5,7,9]) = 2 exactly (sample)
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 5);
  });
  it("returns 0 for a constant array", () => {
    expect(stdev([5, 5, 5, 5])).toBeCloseTo(0);
  });
});

// ── pearson ──────────────────────────────────────────────────────────────────
describe("pearson", () => {
  it("returns 1 for identical series", () => {
    const x = [1, 2, 3, 4, 5];
    expect(pearson(x, x)).toBeCloseTo(1);
  });
  it("returns -1 for perfectly anticorrelated series", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [5, 4, 3, 2, 1];
    expect(pearson(x, y)).toBeCloseTo(-1);
  });
  it("returns ~0 for orthogonal series", () => {
    const x = [1, -1, 1, -1];
    const y = [1,  1, -1, -1];
    expect(Math.abs(pearson(x, y))).toBeCloseTo(0, 10);
  });
});

// ── cov ──────────────────────────────────────────────────────────────────────
describe("cov", () => {
  const volMap = { eq: 18.3, nb: 7.7, gld: 15.0 };
  it("returns vol² on the diagonal", () => {
    expect(cov("eq", "eq", CORR, volMap)).toBeCloseTo(18.3 * 18.3);
  });
  it("is symmetric", () => {
    const ij = cov("eq", "nb", CORR, volMap);
    const ji = cov("nb", "eq", CORR, volMap);
    expect(ij).toBeCloseTo(ji);
  });
});

// ── computeRiskContributions ─────────────────────────────────────────────────
describe("computeRiskContributions", () => {
  it("contributions sum to ~100%", () => {
    const weights = { eq: 40, nb: 40, gld: 20 };
    const { contributions } = computeRiskContributions(weights, ASSETS, CORR);
    const total = Object.values(contributions).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 3);
  });

  it("all contributions are non-negative", () => {
    const weights = { eq: 60, nb: 20, gld: 20 };
    const { contributions } = computeRiskContributions(weights, ASSETS, CORR);
    for (const v of Object.values(contributions)) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("portfolioVol is positive for non-trivial weights", () => {
    const weights = { eq: 1, nb: 1, gld: 1 };
    const { portfolioVol } = computeRiskContributions(weights, ASSETS, CORR);
    expect(portfolioVol).toBeGreaterThan(0);
  });

  it("concentrating in highest-vol asset pushes its risk contribution toward 100%", () => {
    const weights = { eq: 99, nb: 0.5, gld: 0.5 };
    const { contributions } = computeRiskContributions(weights, ASSETS, CORR);
    expect(contributions.eq).toBeGreaterThan(90);
  });
});

// ── solveTrueRiskParity ───────────────────────────────────────────────────────
describe("solveTrueRiskParity", () => {
  it("weights sum to ~1", () => {
    const w = solveTrueRiskParity(ASSETS, CORR);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("all weights are positive", () => {
    const w = solveTrueRiskParity(ASSETS, CORR);
    for (const v of Object.values(w)) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it("risk contributions are approximately equal after solving", () => {
    const w = solveTrueRiskParity(ASSETS, CORR);
    const scaledWeights = Object.fromEntries(
      Object.entries(w).map(([k, v]) => [k, v * 100])
    );
    const { contributions } = computeRiskContributions(scaledWeights, ASSETS, CORR);
    const targetPct = 100 / ASSETS.length;
    for (const v of Object.values(contributions)) {
      expect(Math.abs(v - targetPct)).toBeLessThan(1.5); // within 1.5pp of equal share
    }
  });
});

// ── applyNaiveRiskParity ──────────────────────────────────────────────────────
describe("applyNaiveRiskParity", () => {
  it("weights sum to 1", () => {
    const w = applyNaiveRiskParity(ASSETS);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("lower-vol assets receive higher weight", () => {
    const w = applyNaiveRiskParity(ASSETS);
    // nb (vol 7.7) > gld (vol 15.0) > eq (vol 18.3)
    expect(w.nb).toBeGreaterThan(w.gld);
    expect(w.gld).toBeGreaterThan(w.eq);
  });

  it("all weights are positive", () => {
    const w = applyNaiveRiskParity(ASSETS);
    for (const v of Object.values(w)) {
      expect(v).toBeGreaterThan(0);
    }
  });
});

// ── getLeverageMultiplier ─────────────────────────────────────────────────────
describe("getLeverageMultiplier", () => {
  it("doubles exposure when target is twice the current vol", () => {
    expect(getLeverageMultiplier(5, 10)).toBeCloseTo(2);
  });

  it("is capped at the specified maximum", () => {
    expect(getLeverageMultiplier(1, 100, 4)).toBe(4);
  });

  it("uses cap=4 by default", () => {
    expect(getLeverageMultiplier(1, 100)).toBe(4);
  });

  it("returns 1 when unleveredVol is 0", () => {
    expect(getLeverageMultiplier(0, 10)).toBe(1);
  });

  it("returns minimum of 0.1 when target < current vol", () => {
    expect(getLeverageMultiplier(20, 1)).toBeCloseTo(0.1);
  });
});
