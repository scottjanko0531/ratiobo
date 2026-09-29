import { describe, it, expect } from "vitest";
import {
  marketOverlayMultipliersBySymbol,
  applyMarketOverlayToTargets,
  shouldProposeRebalance,
} from "../lib/marketOverlayPortfolio";
import { computeAllocationDeltas, EQUITY_KEYS } from "../lib/simulatorKeys";

// Three-holding fixture: one equity, one bond, one cash-equivalent.
const HOLDINGS = [
  { symbol: "VTI", asset_type: "etf", current_value: 6000 },
  { symbol: "BND", asset_type: "bond", current_value: 3000 },
  { symbol: "SPAXX", asset_type: "money_market", current_value: 1000 },
];

const RAW_TARGETS = { eq: 60, nb: 30, cash: 10 };

// ── marketOverlayMultipliersBySymbol ───────────────────────────────────────
describe("marketOverlayMultipliersBySymbol", () => {
  it("applies the multiplier only to equity-classified holdings", () => {
    const out = marketOverlayMultipliersBySymbol(HOLDINGS, 0.7, EQUITY_KEYS);
    expect(out).toEqual({ VTI: 0.7 });
  });

  it("returns 1 for the equity holding when the multiplier is 1 (no-op)", () => {
    const out = marketOverlayMultipliersBySymbol(HOLDINGS, 1, EQUITY_KEYS);
    expect(out).toEqual({ VTI: 1 });
  });
});

// ── applyMarketOverlayToTargets ────────────────────────────────────────────
describe("applyMarketOverlayToTargets", () => {
  it("adds the freed equity weight to cash and leaves other buckets untouched", () => {
    const { effectiveTargets, freedPct } = applyMarketOverlayToTargets(RAW_TARGETS, 0.7, EQUITY_KEYS);
    expect(freedPct).toBeCloseTo(60 * 0.3); // 18
    expect(effectiveTargets.eq).toBe(60);   // bucket target itself unchanged
    expect(effectiveTargets.nb).toBe(30);
    expect(effectiveTargets.cash).toBeCloseTo(10 + 18);
  });

  it("is a no-op when exposureMultiplier is 1 (flag-off equivalent)", () => {
    const { effectiveTargets, freedPct } = applyMarketOverlayToTargets(RAW_TARGETS, 1, EQUITY_KEYS);
    expect(freedPct).toBe(0);
    expect(effectiveTargets).toBe(RAW_TARGETS);
  });
});

// ── End-to-end scaling math through computeAllocationDeltas ───────────────
describe("overlay scaling through computeAllocationDeltas", () => {
  it("weights sum to 100% and cash absorbs exactly the cut", () => {
    const multiplier = 0.7;
    const exposureMultipliers = marketOverlayMultipliersBySymbol(HOLDINGS, multiplier, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyMarketOverlayToTargets(RAW_TARGETS, multiplier, EQUITY_KEYS);

    const { actionRows, buyRows } = computeAllocationDeltas(HOLDINGS, effectiveTargets, {
      exposureMultipliers,
      includeZeroValueHoldings: true,
    });

    const totalNewPct = actionRows.reduce((s, r) => s + r.newPct, 0)
      + buyRows.reduce((s, r) => s + r.targetPct, 0);
    expect(totalNewPct).toBeCloseTo(100);

    // SPAXX (money_market) is the sole holding linked to the cash bucket, so
    // the freed cut shows up on its actionRow rather than as a buyRow — its
    // new target is exactly the untouched base cash target plus the freed cut.
    const cashRow = actionRows.find((r) => r.symbol === "SPAXX");
    expect(cashRow?.newPct).toBeCloseTo(RAW_TARGETS.cash + freedPct);
    expect(buyRows.find((r) => r.key === "cash")).toBeUndefined();

    // The equity holding's new target is scaled down by exactly the multiplier.
    const vtiRow = actionRows.find((r) => r.symbol === "VTI");
    expect(vtiRow?.newPct).toBeCloseTo(RAW_TARGETS.eq * multiplier);
  });

  it("surfaces cash as a buyRow (portfolio-actions-level 'create a cash sleeve') when the portfolio holds none", () => {
    const noCashHoldings = [{ symbol: "VTI", asset_type: "etf", current_value: 6000 }];
    const multiplier = 0.7;
    const exposureMultipliers = marketOverlayMultipliersBySymbol(noCashHoldings, multiplier, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyMarketOverlayToTargets(RAW_TARGETS, multiplier, EQUITY_KEYS);

    const { buyRows } = computeAllocationDeltas(noCashHoldings, effectiveTargets, {
      exposureMultipliers,
      includeZeroValueHoldings: true,
    });

    const cashRow = buyRows.find((r) => r.key === "cash");
    expect(cashRow?.targetPct).toBeCloseTo(RAW_TARGETS.cash + freedPct);
  });

  it("flag off (no market-overlay multipliers merged in) matches the current non-overlay output exactly", () => {
    const withoutOverlay = computeAllocationDeltas(HOLDINGS, RAW_TARGETS, { includeZeroValueHoldings: true });

    const flagOff = computeAllocationDeltas(HOLDINGS, RAW_TARGETS, {
      exposureMultipliers: {},
      includeZeroValueHoldings: true,
    });

    expect(flagOff.actionRows).toEqual(withoutOverlay.actionRows);
    expect(flagOff.buyRows).toEqual(withoutOverlay.buyRows);
  });
});

// ── shouldProposeRebalance ─────────────────────────────────────────────────
describe("shouldProposeRebalance", () => {
  it("fires when the current tier differs from the last-rebalanced tier", () => {
    expect(shouldProposeRebalance("DEFENSIVE", "NORMAL")).toBe(true);
  });

  it("does not fire when the tier is unchanged", () => {
    expect(shouldProposeRebalance("NORMAL", "NORMAL")).toBe(false);
  });

  it("fires the first time, when the portfolio has never been rebalanced under the overlay", () => {
    expect(shouldProposeRebalance("NORMAL", null)).toBe(true);
  });

  it("does not fire with no current tier available", () => {
    expect(shouldProposeRebalance(null, "NORMAL")).toBe(false);
  });
});
