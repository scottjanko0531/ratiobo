import { describe, it, expect } from "vitest";
import {
  classifyBondSleeve, sleeveStats, solveDurationShiftWithinBucket, solveDurationShiftWithSubstitutes,
  computeBondLensSectorTargets, DEFAULT_ELIGIBLE_INSTRUMENTS,
} from "../lib/bondLensPortfolio.js";
import { computeAllocationDeltas } from "../lib/simulatorKeys";

// Fixture shaped like the real holdings this module will actually see
// (confirmed via a live query against bond_instrument_meta): SHY/TLT in
// the "nb" bucket, SCHP/VTIP in "tip", plus one credit-gated and one
// always-excluded holding for the classification tests.
function metaFor(opts: Record<string, unknown>) {
  return { is_bond: true, in_scope: true, exclusion_reason: null, maturity_bucket: null, inflation_linked: false, ...opts };
}

describe("classifyBondSleeve", () => {
  const holdings = [
    { id: "h1", symbol: "SHY", simulator_key: "nb", current_value: 1000 },
    { id: "h2", symbol: "TLT", simulator_key: "nb", current_value: 1000 },
    { id: "h3", symbol: "LQD", simulator_key: "nb", current_value: 500 }, // IG corporate -- credit-gated
    { id: "h4", symbol: "HYG", simulator_key: "nb", current_value: 500 }, // high yield -- always excluded
    { id: "h5", symbol: "ARCC", simulator_key: "nb", current_value: 300 }, // no meta row at all
    { id: "h6", symbol: "VTI", simulator_key: "eq", current_value: 2000 }, // not a bond bucket at all
  ];
  const metaByHoldingId = {
    h1: metaFor({ bond_type: "treasury_nominal", effective_duration: 1.84 }),
    h2: metaFor({ bond_type: "treasury_nominal", effective_duration: 14.63 }),
    h3: metaFor({ bond_type: "ig_corporate", effective_duration: 8.5 }),
    h4: metaFor({ bond_type: "high_yield", effective_duration: 4.0, exclusion_reason: "high_yield_risk_like" }),
  };

  it("puts always-in-scope treasury holdings in scope", () => {
    const { inScope } = classifyBondSleeve(holdings, metaByHoldingId, false);
    const symbols = inScope.map((e) => e.holding.symbol);
    expect(symbols).toContain("SHY");
    expect(symbols).toContain("TLT");
  });

  it("excludes credit-gated holdings when include_credit is false (v3 default)", () => {
    const { inScope, excluded } = classifyBondSleeve(holdings, metaByHoldingId, false);
    expect(inScope.map((e) => e.holding.symbol)).not.toContain("LQD");
    const lqd = excluded.find((e) => e.holding.symbol === "LQD");
    expect(lqd?.reason).toBe("credit_excluded_by_default");
  });

  it("includes credit-gated holdings when include_credit is explicitly true", () => {
    const { inScope } = classifyBondSleeve(holdings, metaByHoldingId, true);
    expect(inScope.map((e) => e.holding.symbol)).toContain("LQD");
  });

  it("always excludes high-yield regardless of include_credit", () => {
    const { inScope: withCredit } = classifyBondSleeve(holdings, metaByHoldingId, true);
    expect(withCredit.map((e) => e.holding.symbol)).not.toContain("HYG");
  });

  it("excludes and flags holdings with no bond_instrument_meta row", () => {
    const { excluded } = classifyBondSleeve(holdings, metaByHoldingId, false);
    const arcc = excluded.find((e) => e.holding.symbol === "ARCC");
    expect(arcc?.reason).toBe("unclassified");
  });

  it("silently skips holdings outside the nb/tip buckets entirely", () => {
    const { inScope, excluded } = classifyBondSleeve(holdings, metaByHoldingId, false);
    const all = [...inScope.map((e) => e.holding.symbol), ...excluded.map((e) => e.holding.symbol)];
    expect(all).not.toContain("VTI");
  });

  it("excludes and flags a bond_type holding missing effective_duration", () => {
    const h = [{ id: "h7", symbol: "XYZ", simulator_key: "nb", current_value: 100 }];
    const meta = { h7: metaFor({ bond_type: "treasury_nominal", effective_duration: null }) };
    const { excluded } = classifyBondSleeve(h, meta, false);
    expect(excluded[0]?.reason).toBe("missing_duration");
  });
});

describe("sleeveStats", () => {
  it("computes weight, weighted duration, and mix correctly", () => {
    const entries = [
      { holding: { current_value: 1000 }, meta: { bond_type: "treasury_nominal", effective_duration: 2 } },
      { holding: { current_value: 1000 }, meta: { bond_type: "tips", effective_duration: 6 } },
    ];
    const stats = sleeveStats(entries);
    expect(stats.weight).toBe(2000);
    expect(stats.weightedDuration).toBeCloseTo(4, 10); // (1000*2 + 1000*6) / 2000
    expect(stats.mix.nominal).toBe(1000);
    expect(stats.mix.tips).toBe(1000);
  });

  it("returns null weightedDuration for an empty sleeve", () => {
    expect(sleeveStats([]).weightedDuration).toBeNull();
  });
});

describe("solveDurationShiftWithinBucket", () => {
  const shy = { holding: { symbol: "SHY", current_value: 1000 }, meta: { effective_duration: 1.84 } };
  const tlt = { holding: { symbol: "TLT", current_value: 1000 }, meta: { effective_duration: 14.63 } };

  it("shifts weight from the shorter to the longer holding to raise duration", () => {
    // current weighted duration = (1000*1.84 + 1000*14.63)/2000 = 8.235
    const { weights, reachable } = solveDurationShiftWithinBucket([shy, tlt], 10);
    expect(reachable).toBe(true);
    expect(weights.SHY).toBeLessThan(1000);
    expect(weights.TLT).toBeGreaterThan(1000);
    const achieved = (weights.SHY * 1.84 + weights.TLT * 14.63) / (weights.SHY + weights.TLT);
    expect(achieved).toBeCloseTo(10, 4);
  });

  it("shifts weight from the longer to the shorter holding to lower duration", () => {
    const { weights, reachable } = solveDurationShiftWithinBucket([shy, tlt], 5);
    expect(reachable).toBe(true);
    expect(weights.TLT).toBeLessThan(1000);
    expect(weights.SHY).toBeGreaterThan(1000);
    const achieved = (weights.SHY * 1.84 + weights.TLT * 14.63) / (weights.SHY + weights.TLT);
    expect(achieved).toBeCloseTo(5, 4);
  });

  it("flags unreachable when the target is beyond what the bucket's own holdings can produce", () => {
    const { weights, reachable, gapNote } = solveDurationShiftWithinBucket([shy, tlt], 20); // beyond TLT's own 14.63
    expect(reachable).toBe(false);
    expect(gapNote).toMatch(/not fully reachable/);
    expect(weights.SHY).toBeCloseTo(0, 6); // fully shifted into TLT, still can't reach 20
    expect(weights.TLT).toBeCloseTo(2000, 6);
  });

  it("is a true no-op when the target equals the current weighted duration", () => {
    const current = (1000 * 1.84 + 1000 * 14.63) / 2000;
    const { weights } = solveDurationShiftWithinBucket([shy, tlt], current);
    expect(weights.SHY).toBeCloseTo(1000, 6);
    expect(weights.TLT).toBeCloseTo(1000, 6);
  });

  it("flags unreachable for a single-holding bucket whose duration doesn't match the target", () => {
    const { reachable, gapNote } = solveDurationShiftWithinBucket([tlt], 5);
    expect(reachable).toBe(false);
    expect(gapNote).toMatch(/Only one in-scope holding/);
  });

  it("snaps moves smaller than the no-trade band back to the original weight", () => {
    // A target only marginally different from current should produce a tiny
    // shift that the no-trade band suppresses entirely.
    const current = (1000 * 1.84 + 1000 * 14.63) / 2000;
    const { weights } = solveDurationShiftWithinBucket([shy, tlt], current + 0.0001, { minTradeThreshold: 0.05 });
    expect(weights.SHY).toBe(1000);
    expect(weights.TLT).toBe(1000);
  });
});

describe("computeBondLensSectorTargets", () => {
  const holdings = [
    { id: "h1", symbol: "SHY", simulator_key: "nb", current_value: 1000 },
    { id: "h2", symbol: "TLT", simulator_key: "nb", current_value: 1000 },
    { id: "h3", symbol: "SCHP", simulator_key: "tip", current_value: 500 },
    { id: "h4", symbol: "VTIP", simulator_key: "tip", current_value: 500 },
  ];
  const metaByHoldingId = {
    h1: metaFor({ bond_type: "treasury_nominal", effective_duration: 1.84 }),
    h2: metaFor({ bond_type: "treasury_nominal", effective_duration: 14.63 }),
    h3: metaFor({ bond_type: "tips", effective_duration: 6.4, inflation_linked: true }),
    h4: metaFor({ bond_type: "tips", effective_duration: 2.4, inflation_linked: true }),
  };

  it("is a no-op at Neutral stance (multiplier 1.0, benchmark = current duration)", () => {
    const signal = { duration_stance: "Neutral", duration_multiplier: 1.0 };
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false });
    expect(r.sectorTargets.SHY).toBeCloseTo(50, 3); // unchanged pro-rata share of its own bucket
    expect(r.sectorTargets.TLT).toBeCloseTo(50, 3);
    expect(r.targetReachable).toBe(true);
  });

  it("shifts toward longer duration within each bucket at Extend (1.3x)", () => {
    const signal = { duration_stance: "Extend", duration_multiplier: 1.3 };
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false });
    expect(r.sectorTargets.TLT).toBeGreaterThan(50); // nb bucket tilts toward TLT
    expect(r.sectorTargets.SCHP).toBeGreaterThan(50); // tip bucket tilts toward SCHP (longer of the two)
    expect(r.sleeveAfter.weightedDuration).toBeGreaterThan(r.sleeveBefore.weightedDuration as number);
  });

  it("shifts toward shorter duration within each bucket at Short (0.5x)", () => {
    const signal = { duration_stance: "Short", duration_multiplier: 0.5 };
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false });
    expect(r.sectorTargets.SHY).toBeGreaterThan(50);
    expect(r.sectorTargets.VTIP).toBeGreaterThan(50);
    expect(r.sleeveAfter.weightedDuration).toBeLessThan(r.sleeveBefore.weightedDuration as number);
  });

  it("returns an empty sectorTargets map with no signal row (Bond Lens effectively off)", () => {
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, null, { include_credit: false });
    expect(r.sectorTargets).toEqual({});
    expect(r.sleeveAfter).toEqual(r.sleeveBefore);
  });

  it("returns an empty sectorTargets map when nothing is in scope", () => {
    const equityOnly = [{ id: "h9", symbol: "VTI", simulator_key: "eq", current_value: 1000 }];
    const signal = { duration_stance: "Extend", duration_multiplier: 1.3 };
    const r = computeBondLensSectorTargets(equityOnly, {}, signal, {});
    expect(r.sectorTargets).toEqual({});
  });
});

// §6's Phase D acceptance test, made real and automated: a portfolio with
// Bond Lens off must produce byte-identical output to a build where Bond
// Lens's per-portfolio application code never runs at all -- not merely
// "a code path that happens to no-op." Proven here by calling
// computeAllocationDeltas (the SAME function every other overlay already
// uses) once with an empty sectorTargets (exactly what the page-level
// integration passes when `use_bond_lens_overlay` is false) and once
// with it omitted entirely (simulating a build where this module doesn't
// exist), and asserting the two calls produce identical actionRows.
describe("Phase D acceptance: Bond Lens off == identical to a build without it", () => {
  const holdings = [
    { symbol: "SHY", simulator_key: "nb", current_value: 1000 },
    { symbol: "TLT", simulator_key: "nb", current_value: 1000 },
    { symbol: "VTI", simulator_key: "eq", current_value: 3000 },
  ];
  const targets = { nb: 40, eq: 60 };

  it("an empty sectorTargets map produces identical actionRows to omitting the param", () => {
    const withBondLensOff = computeAllocationDeltas(holdings, targets, { sectorTargets: {} });
    const withoutBondLensAtAll = computeAllocationDeltas(holdings, targets);
    expect(withBondLensOff.actionRows).toEqual(withoutBondLensAtAll.actionRows);
  });

  it("computeBondLensSectorTargets's own output, fed back in when off, changes nothing", () => {
    const metaByHoldingId = {}; // no meta rows at all -- nothing classifies as in-scope
    const off = computeBondLensSectorTargets(holdings, metaByHoldingId, null, {});
    const withOff = computeAllocationDeltas(holdings, targets, { sectorTargets: off.sectorTargets });
    const withoutBondLensAtAll = computeAllocationDeltas(holdings, targets);
    expect(withOff.actionRows).toEqual(withoutBondLensAtAll.actionRows);
  });
});

// Solver invariants Scott asked to have confirmed before enabling Bond
// Lens on any real portfolio. Each one is a property of how this module
// composes with the EXISTING computeAllocationDeltas/combineAllOverlays
// machinery, not something bondLensPortfolio.js enforces by checking for
// it explicitly -- these tests prove the composition actually holds, not
// just that it was intended to.
describe("Solver invariants (Scott's pre-enable checklist)", () => {
  const holdings = [
    { id: "h1", symbol: "SHY", simulator_key: "nb", current_value: 1000 },
    { id: "h2", symbol: "TLT", simulator_key: "nb", current_value: 1000 },
    { id: "h3", symbol: "SCHP", simulator_key: "tip", current_value: 500 },
    { id: "h4", symbol: "VTIP", simulator_key: "tip", current_value: 500 },
    { id: "h5", symbol: "VTI", simulator_key: "eq", current_value: 3000 },
  ];
  const metaByHoldingId = {
    h1: metaFor({ bond_type: "treasury_nominal", effective_duration: 1.84 }),
    h2: metaFor({ bond_type: "treasury_nominal", effective_duration: 14.63 }),
    h3: metaFor({ bond_type: "tips", effective_duration: 6.4, inflation_linked: true }),
    h4: metaFor({ bond_type: "tips", effective_duration: 2.4, inflation_linked: true }),
  };
  const signal = { duration_stance: "Extend", duration_multiplier: 1.3 };
  const targets = { nb: 30, tip: 20, eq: 50 };

  it("(a) holds the nb/tip bucket split fixed -- only moves weight WITHIN each bucket", () => {
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false });
    // Each bucket's own sectorTargets sum to 100% of ITS OWN target, by
    // construction (solveDurationShiftWithinBucket only redistributes a
    // fixed total) -- but the real proof is one level up: the bucket-level
    // TOTAL percent of the whole portfolio assigned to "nb" and "tip" via
    // computeAllocationDeltas must be identical with and without Bond
    // Lens's sectorTargets, since sectorTargets only overrides the
    // WITHIN-bucket pro-rata split, never the bucket's own suggestedPcts.
    const without = computeAllocationDeltas(holdings, targets);
    const withBondLens = computeAllocationDeltas(holdings, targets, { sectorTargets: r.sectorTargets });
    const bucketTotal = (rows: typeof without.actionRows, key: string) =>
      rows.filter((row) => row.key === key).reduce((s, row) => s + row.newPct, 0);
    expect(bucketTotal(withBondLens.actionRows, "nb")).toBeCloseTo(bucketTotal(without.actionRows, "nb"), 6);
    expect(bucketTotal(withBondLens.actionRows, "tip")).toBeCloseTo(bucketTotal(without.actionRows, "tip"), 6);
    // But the WITHIN-bucket split did move -- TLT (longer duration) should
    // have gained share relative to pro-rata at an Extend stance.
    const withoutTlt = without.actionRows.find((row) => row.symbol === "TLT")!.newPct;
    const withTlt = withBondLens.actionRows.find((row) => row.symbol === "TLT")!.newPct;
    expect(withTlt).toBeGreaterThan(withoutTlt);
  });

  it("(b) composes with an existing exposureMultiplier (resize/capex/market) rather than overriding it", () => {
    // Hypothetical: TLT is under an active resize-style cut (0.5x) --
    // bond holdings aren't touched by resize/capex/market TODAY (they're
    // scoped to equity buckets), but the composition must still hold if
    // that ever changes, since computeAllocationDeltas multiplies
    // bucketTargetPct * holdingShare * exposureMultiplier -- Bond Lens
    // only ever supplies `holdingShare` (via sectorTargets), so a
    // multiplier applied elsewhere is never undone by this module.
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false });
    const exposureMultipliers = { TLT: 0.5 };
    const withCut = computeAllocationDeltas(holdings, targets, { sectorTargets: r.sectorTargets, exposureMultipliers });
    const withoutCut = computeAllocationDeltas(holdings, targets, { sectorTargets: r.sectorTargets });
    const tltWithCut = withCut.actionRows.find((row) => row.symbol === "TLT")!.newPct;
    const tltWithoutCut = withoutCut.actionRows.find((row) => row.symbol === "TLT")!.newPct;
    expect(tltWithCut).toBeCloseTo(tltWithoutCut * 0.5, 6);
  });

  it("(c) never touches cash or computes a freedPct -- sectorTargets has no cash entry, and cash's target is untouched", () => {
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false });
    expect(r.sectorTargets.cash).toBeUndefined();
    expect(r.sectorTargets.CASH).toBeUndefined();

    const withTargetsIncludingCash = { ...targets, cash: 10 };
    const without = computeAllocationDeltas(holdings, withTargetsIncludingCash);
    const withBondLens = computeAllocationDeltas(holdings, withTargetsIncludingCash, { sectorTargets: r.sectorTargets });
    // No cash holding exists in this fixture, so cash shows up as a
    // buyRow, not an actionRow -- confirm it's byte-identical either way,
    // proving Bond Lens's sectorTargets never reaches `applyOverlayToTargets`'s
    // freedPct-to-cash logic (this module doesn't call that function at all).
    expect(withBondLens.buyRows.find((b) => b.key === "cash"))
      .toEqual(without.buyRows.find((b) => b.key === "cash"));
  });
});

// §6.3 follow-up (2026-10-XX): eligible_instruments substitutes, for
// buckets the held-only solver can't reach a target in. Real published
// durations: BIL 0.10y, SHY 1.84y, IEF 6.87y, TLT 14.63y (nb);
// VTIP 2.40y, SCHP 6.40y (tip) -- see bond-lens-decisions.md for sources.
describe("solveDurationShiftWithSubstitutes", () => {
  const nbMeta = {
    BIL: { symbol: "BIL", effective_duration: 0.10 },
    SHY: { symbol: "SHY", effective_duration: 1.84 },
    IEF: { symbol: "IEF", effective_duration: 6.87 },
    TLT: { symbol: "TLT", effective_duration: 14.63 },
  };
  const tipMeta = {
    VTIP: { symbol: "VTIP", effective_duration: 2.40 },
    SCHP: { symbol: "SCHP", effective_duration: 6.40 },
  };
  const eligibleNb = Object.values(nbMeta);
  const eligibleTip = Object.values(tipMeta);

  it("single-instrument bucket: introduces the longest eligible substitute to RAISE duration", () => {
    const onlyShy = [{ holding: { symbol: "SHY", current_value: 1000 }, meta: nbMeta.SHY }];
    const r = solveDurationShiftWithSubstitutes(onlyShy, 5, eligibleNb);
    expect(r.reachable).toBe(true);
    expect(r.substitutesUsed).toEqual(["TLT"]); // longest available, not IEF -- most extreme wins
    expect(r.weights.TLT).toBeGreaterThan(0);
    expect(r.weights.SHY).toBeLessThan(1000);
    const achieved = (r.weights.SHY * 1.84 + r.weights.TLT * 14.63) / (r.weights.SHY + r.weights.TLT);
    expect(achieved).toBeCloseTo(5, 4);
  });

  it("single-instrument bucket: introduces the shortest eligible substitute to LOWER duration", () => {
    const onlyTlt = [{ holding: { symbol: "TLT", current_value: 1000 }, meta: nbMeta.TLT }];
    const r = solveDurationShiftWithSubstitutes(onlyTlt, 5, eligibleNb);
    expect(r.reachable).toBe(true);
    expect(r.substitutesUsed).toEqual(["BIL"]); // shortest available, not SHY -- most extreme wins
    expect(r.weights.BIL).toBeGreaterThan(0);
    const achieved = (r.weights.TLT * 14.63 + r.weights.BIL * 0.10) / (r.weights.TLT + r.weights.BIL);
    expect(achieved).toBeCloseTo(5, 4);
  });

  it("still flags unreachable when even the most extreme substitute can't get there, with the 'already at the long end' note", () => {
    const onlyTlt = [{ holding: { symbol: "TLT", current_value: 1000 }, meta: nbMeta.TLT }];
    const r = solveDurationShiftWithSubstitutes(onlyTlt, 20, eligibleNb); // beyond TLT, the longest instrument available at all
    expect(r.reachable).toBe(false);
    // TLT is itself the most extreme long instrument -- no substitute is longer, so none should be introduced uselessly.
    expect(r.substitutesUsed).toEqual([]);
    // Scott's wording (2026-10-02, Checkpoint 1 follow-up): this is a
    // permanent, expected state for the default list, not a generic gap.
    expect(r.gapNote).toBe("Already at the long end of eligible instruments; no further extension available. Shortening remains available if the stance turns defensive.");
  });

  it("gives the symmetric 'already at the short end' note when lowering past the shortest eligible instrument", () => {
    const onlyBil = [{ holding: { symbol: "BIL", current_value: 1000 }, meta: nbMeta.BIL }];
    const r = solveDurationShiftWithSubstitutes(onlyBil, -1, eligibleNb); // below BIL, the shortest instrument available at all
    expect(r.reachable).toBe(false);
    expect(r.substitutesUsed).toEqual([]);
    expect(r.gapNote).toBe("Already at the short end of eligible instruments; no further shortening available. Extending remains available if the stance turns more aggressive.");
  });

  it("EDV is opt-in only -- not reachable unless explicitly added to the eligible list", () => {
    const onlyTlt = [{ holding: { symbol: "TLT", current_value: 1000 }, meta: nbMeta.TLT }];
    // Without EDV in the candidate list (the default), beyond-TLT stays unreachable.
    const withoutEdv = solveDurationShiftWithSubstitutes(onlyTlt, 20, eligibleNb);
    expect(withoutEdv.reachable).toBe(false);
    // With EDV explicitly added (simulating a portfolio that opted in via its own eligible_instruments setting), it becomes reachable.
    const edvMeta = { symbol: "EDV", effective_duration: 23.9 };
    const withEdv = solveDurationShiftWithSubstitutes(onlyTlt, 20, [...eligibleNb, edvMeta]);
    expect(withEdv.reachable).toBe(true);
    expect(withEdv.substitutesUsed).toEqual(["EDV"]);
  });

  it("tip bucket: single VTIP holding raises toward SCHP (the only longer eligible instrument)", () => {
    const onlyVtip = [{ holding: { symbol: "VTIP", current_value: 500 }, meta: tipMeta.VTIP }];
    const r = solveDurationShiftWithSubstitutes(onlyVtip, 5, eligibleTip);
    expect(r.reachable).toBe(true);
    expect(r.substitutesUsed).toEqual(["SCHP"]);
  });

  it("does not introduce a substitute when the held-only solve already reaches the target", () => {
    const twoHeld = [
      { holding: { symbol: "SHY", current_value: 1000 }, meta: nbMeta.SHY },
      { holding: { symbol: "TLT", current_value: 1000 }, meta: nbMeta.TLT },
    ];
    const r = solveDurationShiftWithSubstitutes(twoHeld, 5, eligibleNb); // well within SHY..TLT's own range
    expect(r.reachable).toBe(true);
    expect(r.substitutesUsed).toEqual([]);
  });

  it("a portfolio already exactly at its target produces no trade and no substitute", () => {
    const onlyTlt = [{ holding: { symbol: "TLT", current_value: 1000 }, meta: nbMeta.TLT }];
    const r = solveDurationShiftWithSubstitutes(onlyTlt, 14.63, eligibleNb); // already there
    expect(r.reachable).toBe(true);
    expect(r.substitutesUsed).toEqual([]);
    expect(r.weights.TLT).toBeCloseTo(1000, 6);
  });

  it("introduces no substitute when eligibleMeta is empty (e.g. Bond Lens called without the symbol map)", () => {
    const onlyShy = [{ holding: { symbol: "SHY", current_value: 1000 }, meta: nbMeta.SHY }];
    const r = solveDurationShiftWithSubstitutes(onlyShy, 10, []);
    expect(r.reachable).toBe(false);
    expect(r.substitutesUsed).toEqual([]);
  });

  it("regression: a $0 existing holding is still eligible as a substitute, not blocked by its own stale row", () => {
    // Found via the real dry run: a portfolio had a $0 SCHP row (fully
    // sold down, row never deleted) in its tip bucket alongside a real
    // VTIP position. SCHP's own duration (6.4) is a valid, more-extreme
    // candidate for raising duration beyond VTIP's 2.4 -- it must not be
    // excluded just because a zero-value row for it already exists.
    const vtipPlusZeroSchp = [
      { holding: { symbol: "VTIP", current_value: 500 }, meta: tipMeta.VTIP },
      { holding: { symbol: "SCHP", current_value: 0 }, meta: tipMeta.SCHP },
    ];
    const r = solveDurationShiftWithSubstitutes(vtipPlusZeroSchp, 5, eligibleTip);
    expect(r.reachable).toBe(true);
    expect(r.substitutesUsed).toEqual(["SCHP"]);
    expect(r.weights.SCHP).toBeGreaterThan(0);
  });
});

describe("computeBondLensSectorTargets with substitutes (full integration)", () => {
  const bondInstrumentMetaBySymbol = {
    BIL: { symbol: "BIL", bond_type: "bills_cash_like", effective_duration: 0.10 },
    SHY: { symbol: "SHY", bond_type: "treasury_nominal", effective_duration: 1.84 },
    IEF: { symbol: "IEF", bond_type: "treasury_nominal", effective_duration: 6.87 },
    TLT: { symbol: "TLT", bond_type: "treasury_nominal", effective_duration: 14.63 },
    VTIP: { symbol: "VTIP", bond_type: "tips", effective_duration: 2.40, inflation_linked: true },
    SCHP: { symbol: "SCHP", bond_type: "tips", effective_duration: 6.40, inflation_linked: true },
  };

  // Shaped like the real single-instrument-per-bucket portfolios the dry
  // run flagged as unreachable (All Weather Alpha, All Weather With
  // Equity Tilting, Dalio All Weather): one nb holding, one tip holding.
  const holdings = [
    { id: "h1", symbol: "TLT", simulator_key: "nb", current_value: 30000 },
    { id: "h2", symbol: "VTIP", simulator_key: "tip", current_value: 9000 },
  ];
  const metaByHoldingId = {
    h1: metaFor({ bond_type: "treasury_nominal", effective_duration: 14.63 }),
    h2: metaFor({ bond_type: "tips", effective_duration: 2.40, inflation_linked: true }),
  };

  it("proposes a substitute (not applied until Confirm) when the sole holding can't reach the target", () => {
    const signal = { duration_stance: "Short", duration_multiplier: 0.5 }; // needs to LOWER duration below TLT's own 14.63
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false }, bondInstrumentMetaBySymbol);
    // The nb bucket (TLT only) IS reachable via BIL. The tip bucket (VTIP
    // only) is NOT -- VTIP is already the shortest default tip substitute,
    // so a "lower duration further" target has nowhere shorter to go; this
    // is a genuine, expected limitation of the default eligible_instruments
    // list (not a bug), so overall targetReachable is correctly false here.
    expect(r.targetReachable).toBe(false);
    const proposedNb = r.proposedNewHoldings.find((p) => p.key === "nb");
    expect(proposedNb?.symbol).toBe("BIL");
    expect(proposedNb?.targetVal).toBeGreaterThan(0);
    expect(r.proposedNewHoldings.find((p) => p.key === "tip")).toBeUndefined();
    // The real holding's weight shrinks to make room for the substitute,
    // but the BUCKET's own total is unchanged (invariant (a)).
    expect(r.sectorTargets.TLT).toBeLessThan(100);
  });

  it("labels the substitute distinctly from real holdings (symbol absent from the original holdings array)", () => {
    const signal = { duration_stance: "Short", duration_multiplier: 0.5 };
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, { include_credit: false }, bondInstrumentMetaBySymbol);
    const heldSymbols = new Set(holdings.map((h) => h.symbol));
    for (const p of r.proposedNewHoldings) expect(heldSymbols.has(p.symbol)).toBe(false);
  });

  it("uses a custom eligible_instruments list instead of the default when the portfolio sets one", () => {
    const signal = { duration_stance: "Short", duration_multiplier: 0.5 };
    const customOnlySHY = { include_credit: false, eligible_instruments: { nb: ["SHY"], tip: ["VTIP", "SCHP"] } };
    const r = computeBondLensSectorTargets(holdings, metaByHoldingId, signal, customOnlySHY, bondInstrumentMetaBySymbol);
    const proposedNb = r.proposedNewHoldings.find((p) => p.key === "nb");
    expect(proposedNb?.symbol).toBe("SHY"); // only eligible option, not BIL
  });

  it("DEFAULT_ELIGIBLE_INSTRUMENTS matches the spec's defaults", () => {
    expect(DEFAULT_ELIGIBLE_INSTRUMENTS.nb).toEqual(["BIL", "SHY", "IEF", "TLT"]);
    expect(DEFAULT_ELIGIBLE_INSTRUMENTS.tip).toEqual(["VTIP", "SCHP"]);
  });
});
