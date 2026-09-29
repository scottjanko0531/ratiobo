import { describe, it, expect } from "vitest";
import {
  marketOverlayMultipliersBySymbol,
  combineWithCapexOverlay,
  combineAllOverlays,
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

// ── combineAllOverlays (resize x [market MIN capex]) ───────────────────────
// Regression coverage for the KISS bug: a live resize cut on a NON-equity
// symbol (GLDM, vol_regime) must still show up in the combined multiplier
// map even when the market overlay and capex are both no-ops, so the
// freed-weight-to-cash computation downstream doesn't forget about it.
describe("combineAllOverlays", () => {
  it("carries a non-equity resize cut through even with market/capex both inert", () => {
    const resize = { VT: 1, GLDM: 0, FBTC: 1 }; // GLDM fully reduced, matches KISS's live vol-regime signal
    const market = { VT: 1 }; // FULL tier, market overlay is a no-op right now
    const { multipliers } = combineAllOverlays(resize, {}, market, false);
    expect(multipliers.GLDM).toBe(0);
    expect(multipliers.VT).toBe(1);
    expect(multipliers.FBTC).toBe(1);
  });

  it("multiplies resize on top of the market x capex MIN for an equity symbol", () => {
    const resize = { VTI: 0.5 }; // e.g. VTI's own trend rule already cutting it in half
    const capex = { VTI: 0.8 };
    const market = { VTI: 0.6 }; // tighter than capex -> MIN picks market (0.6)
    const { multipliers, binding } = combineAllOverlays(resize, capex, market, true);
    expect(binding.VTI).toBe("market");
    expect(multipliers.VTI).toBeCloseTo(0.5 * 0.6); // resize x MIN(market, capex)
  });

  it("capex-only cut on a non-equity symbol still applies when capexApplied is true", () => {
    const resize = {};
    const capex = { GLD: 0.7 }; // capex cuts gold, but gold isn't market-classified equity
    const market = { VTI: 0.9 };
    const { multipliers } = combineAllOverlays(resize, capex, market, true);
    expect(multipliers.GLD).toBeCloseTo(0.7);
  });

  it("no active signals anywhere: every symbol defaults to 1", () => {
    const { multipliers } = combineAllOverlays({}, {}, {}, false);
    expect(multipliers).toEqual({});
  });
});

// ── applyOverlayToTargets ───────────────────────────────────────────────────
describe("applyOverlayToTargets", () => {
  it("adds the freed equity weight to cash and leaves other buckets untouched", () => {
    const multipliers = marketOverlayMultipliersBySymbol(HOLDINGS, 0.7, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, HOLDINGS, multipliers);
    expect(freedPct).toBeCloseTo(60 * 0.3); // 18
    expect(effectiveTargets.eq).toBe(60);   // bucket target itself unchanged
    expect(effectiveTargets.nb).toBe(30);
    expect(effectiveTargets.cash).toBeCloseTo(10 + 18);
  });

  it("is a no-op when the multiplier is 1 (flag-off equivalent)", () => {
    const multipliers = marketOverlayMultipliersBySymbol(HOLDINGS, 1, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, HOLDINGS, multipliers);
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
    const { freedPct } = applyOverlayToTargets(targets, holdings, multipliers);
    // Value-weighted avg multiplier for "eq" bucket: (8000*0.5 + 2000*0.8) / 10000 = 0.56
    const expectedAvgMult = (8000 * 0.5 + 2000 * 0.8) / 10000;
    expect(freedPct).toBeCloseTo(50 * (1 - expectedAvgMult));
  });

  // Regression test for the KISS bug: a resize/capex cut on a NON-equity
  // bucket (gld) must still free weight into cash. Previously this function
  // only scanned equity buckets, so a portfolio with no equity cut active
  // (market tier FULL) but an active non-equity resize cut showed cash's
  // target as its raw (often absent -> 0) value instead of crediting the
  // freed gold weight -- recommending selling cash that was correctly
  // parked there.
  it("frees weight from a non-equity bucket under an active resize cut (KISS/GLDM shape)", () => {
    const holdings = [
      { symbol: "VT",   asset_type: "etf", simulator_key: null,  current_value: 120000 },
      { symbol: "GLDM", asset_type: "etf", simulator_key: "gld", current_value: 0 },
      { symbol: "FBTC", asset_type: "etf", simulator_key: "alt_crypto", current_value: 20000 },
      { symbol: "USFR", asset_type: "etf", simulator_key: "cash", current_value: 60000 },
    ];
    const targets = { eq: 60, gld: 30, alt_crypto: 10 }; // KISS's real config -- no explicit cash entry
    const resizeMultipliers = { VT: 1, GLDM: 0, FBTC: 1 }; // GLDM fully reduced (vol_regime), rest untouched
    const { effectiveTargets, freedPct } = applyOverlayToTargets(targets, holdings, resizeMultipliers);
    expect(freedPct).toBeCloseTo(30); // all of gld's 30% target, since GLDM's multiplier is 0
    expect(effectiveTargets.cash).toBeCloseTo(30); // absent (0) baseline + the freed 30
    expect(effectiveTargets.eq).toBe(60); // untouched -- VT's own multiplier is 1
  });
});

// ── End-to-end scaling math through computeAllocationDeltas ───────────────
describe("overlay scaling through computeAllocationDeltas", () => {
  it("weights sum to 100% and cash absorbs exactly the cut", () => {
    const multiplier = 0.7;
    const exposureMultipliers = marketOverlayMultipliersBySymbol(HOLDINGS, multiplier, EQUITY_KEYS);
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, HOLDINGS, exposureMultipliers);

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
    const { effectiveTargets } = applyOverlayToTargets(targets, holdings, multipliers);

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
    const { effectiveTargets, freedPct } = applyOverlayToTargets(RAW_TARGETS, noCashHoldings, exposureMultipliers);

    const { buyRows } = computeAllocationDeltas(noCashHoldings, effectiveTargets, {
      exposureMultipliers,
      includeZeroValueHoldings: true,
    });

    const cashRow = buyRows.find((r) => r.key === "cash");
    expect(cashRow?.targetPct).toBeCloseTo(RAW_TARGETS.cash + freedPct);
  });

  // End-to-end regression for the KISS bug, matching real live data: VT not
  // reduced, GLDM fully reduced (vol_regime), FBTC not reduced, market tier
  // FULL (no-op). USFR (cash) should come out to a HOLD, not "sell all".
  it("KISS shape end-to-end: GLDM reduced, market at FULL (no-op) -- cash holds, not sold to zero", () => {
    const holdings = [
      { symbol: "VT",   asset_type: "etf", simulator_key: null,  current_value: 118981.44 },
      { symbol: "GLDM", asset_type: "etf", simulator_key: "gld", current_value: 0 },
      { symbol: "FBTC", asset_type: "etf", simulator_key: "alt_crypto", current_value: 21760.50 },
      { symbol: "USFR", asset_type: "etf", simulator_key: "cash", current_value: 59908.95 },
    ];
    const targets = { eq: 60, gld: 30, alt_crypto: 10 };
    const resizeMultipliers = { VT: 1, GLDM: 0, FBTC: 1 };
    const marketMultipliers = marketOverlayMultipliersBySymbol(holdings, 1, EQUITY_KEYS); // FULL tier, mult 1

    const { multipliers: combined } = combineAllOverlays(resizeMultipliers, {}, marketMultipliers, false);
    const { effectiveTargets } = applyOverlayToTargets(targets, holdings, combined);
    const { actionRows } = computeAllocationDeltas(holdings, effectiveTargets, {
      exposureMultipliers: combined,
      includeZeroValueHoldings: true,
    });

    const usfrRow = actionRows.find((r) => r.symbol === "USFR");
    // Target should be ~30% (GLDM's freed weight), essentially matching
    // USFR's actual current ~29.9% -- a hold, nowhere near a sell-to-zero.
    expect(usfrRow?.newPct).toBeCloseTo(30, 0);
    expect(Math.abs(usfrRow.deltaVal)).toBeLessThan(usfrRow.currentVal * 0.05);
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
