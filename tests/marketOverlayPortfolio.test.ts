import { describe, it, expect } from "vitest";
import {
  marketOverlayMultipliersBySymbol,
  combineWithCapexOverlay,
  applyOverlayToTargets,
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

// ── combineWithCapexOverlay (market x capex stacking = MIN, not product) ──
describe("combineWithCapexOverlay", () => {
  it("both on, market binds: market's cut is tighter than capex's", () => {
    const market = { VTI: 0.6, VXUS: 0.6 };
    const capex = { VTI: 0.85 }; // capex cuts less than market for VTI
    const { multipliers, binding } = combineWithCapexOverlay(market, capex);
    expect(multipliers.VTI).toBe(0.6);
    expect(binding.VTI).toBe("market");
    // VXUS has no capex row at all — market alone applies.
    expect(multipliers.VXUS).toBe(0.6);
    expect(binding.VXUS).toBe("market");
  });

  it("both on, capex binds: capex's cut is tighter than market's", () => {
    const market = { VTI: 0.9 };
    const capex = { VTI: 0.7 }; // capex cuts more than market for VTI
    const { multipliers, binding } = combineWithCapexOverlay(market, capex);
    expect(multipliers.VTI).toBe(0.7);
    expect(binding.VTI).toBe("capex");
  });

  it("capex off (no rows / not applied): behaves exactly like market alone", () => {
    const market = { VTI: 0.6, VXUS: 0.8 };
    const { multipliers, binding } = combineWithCapexOverlay(market, {});
    expect(multipliers).toEqual(market);
    expect(binding.VTI).toBe("market");
    expect(binding.VXUS).toBe("market");
  });

  it("does not touch symbols outside the market overlay's scope (non-equity, capex-only)", () => {
    const market = { VTI: 0.6 };
    const capex = { VTI: 0.9, GLD: 0.8 }; // GLD is capex-cut but not market-classified equity
    const { multipliers, binding } = combineWithCapexOverlay(market, capex);
    expect(multipliers).toEqual({ VTI: 0.6 });
    expect(binding.GLD).toBeUndefined();
  });

  it("ties: equal cuts report a tie and use the shared value", () => {
    const { multipliers, binding } = combineWithCapexOverlay({ VTI: 0.75 }, { VTI: 0.75 });
    expect(multipliers.VTI).toBe(0.75);
    expect(binding.VTI).toBe("tie");
  });
});

// ── applyOverlayToTargets ───────────────────────────────────────────────────
describe("applyOverlayToTargets", () => {
  it("adds the freed equity weight to cash and leaves other buckets untouched", () => {
    const multipliers = marketOverlayMultipliersBySymbol(HOLDINGS, 0.7, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, HOLDINGS, multipliers, EQUITY_KEYS);
    expect(freedPct).toBeCloseTo(60 * 0.3); // 18
    expect(effectiveTargets.eq).toBe(60);   // bucket target itself unchanged
    expect(effectiveTargets.nb).toBe(30);
    expect(effectiveTargets.cash).toBeCloseTo(10 + 18);
  });

  it("is a no-op when the multiplier is 1 (flag-off equivalent)", () => {
    const multipliers = marketOverlayMultipliersBySymbol(HOLDINGS, 1, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, HOLDINGS, multipliers, EQUITY_KEYS);
    expect(freedPct).toBe(0);
    expect(effectiveTargets).toBe(RAW_TARGETS);
  });

  it("value-weights correctly when capex binds for only one of two holdings in the same bucket", () => {
    const holdings = [
      { symbol: "VTI", asset_type: "etf", current_value: 8000 },
      { symbol: "VXUS", asset_type: "etf", current_value: 2000 },
    ];
    const targets = { eq: 50, intl: 0, cash: 50 }; // VTI/VXUS both resolve to "eq" via asset_type default
    // Market cuts both to 0.8; capex cuts only VTI further, to 0.5.
    const market = marketOverlayMultipliersBySymbol(holdings, 0.8, EQUITY_KEYS);
    const { multipliers } = combineWithCapexOverlay(market, { VTI: 0.5 });
    const { freedPct } = applyOverlayToTargets(targets, holdings, multipliers, EQUITY_KEYS);
    // Value-weighted avg multiplier for "eq" bucket: (8000*0.5 + 2000*0.8) / 10000 = 0.56
    const expectedAvgMult = (8000 * 0.5 + 2000 * 0.8) / 10000;
    expect(freedPct).toBeCloseTo(50 * (1 - expectedAvgMult));
  });
});

// ── End-to-end scaling math through computeAllocationDeltas ───────────────
describe("overlay scaling through computeAllocationDeltas", () => {
  it("weights sum to 100% and cash absorbs exactly the cut", () => {
    const multiplier = 0.7;
    const exposureMultipliers = marketOverlayMultipliersBySymbol(HOLDINGS, multiplier, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, HOLDINGS, exposureMultipliers, EQUITY_KEYS);

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

  it("weights still sum to 100% when capex binds tighter than market for one equity holding", () => {
    const holdings = [
      { symbol: "VTI", asset_type: "etf", current_value: 8000 },
      { symbol: "VXUS", asset_type: "etf", current_value: 2000 },
      { symbol: "SPAXX", asset_type: "money_market", current_value: 1000 },
    ];
    const targets = { eq: 50, cash: 10, nb: 40 };
    const market = marketOverlayMultipliersBySymbol(holdings, 0.9, EQUITY_KEYS); // both VTI/VXUS -> 0.9
    const { multipliers } = combineWithCapexOverlay(market, { VTI: 0.6 }); // capex binds only for VTI
    const { effectiveTargets } = applyOverlayToTargets(targets, holdings, multipliers, EQUITY_KEYS);

    const { actionRows, buyRows } = computeAllocationDeltas(holdings, effectiveTargets, {
      exposureMultipliers: multipliers,
      includeZeroValueHoldings: true,
    });
    const totalNewPct = actionRows.reduce((s, r) => s + r.newPct, 0)
      + buyRows.reduce((s, r) => s + r.targetPct, 0);
    expect(totalNewPct).toBeCloseTo(100);
  });

  it("surfaces cash as a buyRow (portfolio-actions-level 'create a cash sleeve') when the portfolio holds none", () => {
    const noCashHoldings = [{ symbol: "VTI", asset_type: "etf", current_value: 6000 }];
    const multiplier = 0.7;
    const exposureMultipliers = marketOverlayMultipliersBySymbol(noCashHoldings, multiplier, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, noCashHoldings, exposureMultipliers, EQUITY_KEYS);

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

  it("keeps firing on a day the tier didn't change, after a missed tier-change day", () => {
    // Day 1: tier flips NORMAL -> DEFENSIVE, portfolio not yet rebalanced.
    expect(shouldProposeRebalance("DEFENSIVE", "NORMAL")).toBe(true);
    // Day 2 (skipped — user didn't act): tier holds at DEFENSIVE (no NEW
    // change today), last_rebalanced_tier is still the stale "NORMAL" since
    // nothing wrote to it. The gate is a pure state comparison, not
    // "did the tier change today", so it must still fire.
    expect(shouldProposeRebalance("DEFENSIVE", "NORMAL")).toBe(true);
    // Day 3, still skipped, tier unchanged again — still fires.
    expect(shouldProposeRebalance("DEFENSIVE", "NORMAL")).toBe(true);
    // Only once the user acts (last_rebalanced_tier is written to DEFENSIVE)
    // does it stop.
    expect(shouldProposeRebalance("DEFENSIVE", "DEFENSIVE")).toBe(false);
  });
});
