import { describe, it, expect } from "vitest";
import {
  checkHoldingsReference,
  checkRebalanceInstruction,
  checkSupersededFiringClaim,
  checkStaleThisWeekClaim,
  runDeterministicFactChecks,
} from "../supabase/functions/_shared/briefFactCheck.ts";

const CLEAN_NARRATIVE = `The debt cycle is currently in MP1, with no gates tripped this run.
Relative to Dalio's own published benchmarks, interest expense sits comfortably below his 20% danger threshold.
Refinancing pressure ahead: r_eff sits below the 10Y, a gap that will narrow as debt matures and refinances -- a forward signal, not a current-period strain.
No trip-wires are currently armed, and none fired this week.
Implications: a prolonged low-rate refinancing wave would keep duration risk contained and real assets relatively unattractive versus cash yields for now.`;

describe("checkHoldingsReference (v3 Phase 3c rule 1)", () => {
  it("flags a deliberately-injected holdings/balance reference", () => {
    const bad = CLEAN_NARRATIVE + "\n\nGiven your portfolio currently holds $42,000 in Notes/Loans, this bucket is overweight.";
    expect(checkHoldingsReference(bad).length).toBeGreaterThan(0);
  });

  it("does not flag the clean macro-only narrative", () => {
    expect(checkHoldingsReference(CLEAN_NARRATIVE)).toEqual([]);
  });
});

describe("checkRebalanceInstruction (v3 Phase 3c rule 2)", () => {
  it("flags a deliberately-injected buy/sell instruction", () => {
    const bad = CLEAN_NARRATIVE + "\n\nConcrete moves:\n- Reduce Notes/Loans to 0% and redeploy into equities.";
    expect(checkRebalanceInstruction(bad).length).toBeGreaterThan(0);
  });

  it("does not flag the clean macro-only narrative", () => {
    expect(checkRebalanceInstruction(CLEAN_NARRATIVE)).toEqual([]);
  });
});

describe("checkSupersededFiringClaim (v3 Phase 3c rule 3)", () => {
  it("flags a deliberately-injected claim that a superseded trip-wire fired/deteriorated", () => {
    const bad = CLEAN_NARRATIVE + "\n\nAuction demand deterioration fired this week, signaling weakening Treasury demand.";
    expect(checkSupersededFiringClaim(bad, ["Auction demand deterioration"]).length).toBeGreaterThan(0);
  });

  it("does not flag when the label isn't mentioned at all", () => {
    expect(checkSupersededFiringClaim(CLEAN_NARRATIVE, ["Auction demand deterioration"])).toEqual([]);
  });

  it("does not flag mentioning a superseded wire's name without a fired/deteriorating claim", () => {
    const ok = CLEAN_NARRATIVE + "\n\nAuction demand deterioration is not currently armed.";
    expect(checkSupersededFiringClaim(ok, ["Auction demand deterioration"])).toEqual([]);
  });
});

describe("checkStaleThisWeekClaim (v3 Phase 3c rule 4)", () => {
  const now = new Date("2026-11-18T00:00:00Z");

  it("flags a deliberately-injected 'this week' auction claim when the feed is stale (the real live v3 Phase 1 condition: 41+ days old)", () => {
    const bad = CLEAN_NARRATIVE + "\n\nThis week's 10Y auction showed renewed strength in indirect bidder demand.";
    const issues = checkStaleThisWeekClaim(bad, "2026-10-07", now); // 42 days old
    expect(issues.length).toBeGreaterThan(0);
  });

  it("does NOT flag when the auction really is within the last 7 days", () => {
    const ok = CLEAN_NARRATIVE + "\n\nThis week's 10Y auction showed renewed strength in indirect bidder demand.";
    const issues = checkStaleThisWeekClaim(ok, "2026-11-13", now); // 5 days old
    expect(issues).toEqual([]);
  });

  it("flags when there is no auction data at all (null data_as_of) rather than silently passing", () => {
    const bad = CLEAN_NARRATIVE + "\n\nThe latest auction confirmed steady demand.";
    expect(checkStaleThisWeekClaim(bad, null, now).length).toBeGreaterThan(0);
  });

  it("does not flag the clean narrative, which makes no recency claim about an auction", () => {
    expect(checkStaleThisWeekClaim(CLEAN_NARRATIVE, "2026-10-07", now)).toEqual([]);
  });
});

describe("runDeterministicFactChecks", () => {
  it("returns no issues for the clean narrative under today's real (stale) live conditions", () => {
    const issues = runDeterministicFactChecks(CLEAN_NARRATIVE, {
      supersededLabels: ["Auction demand deterioration"],
      auctionDataAsOf: "2026-10-07",
      now: new Date("2026-11-18T00:00:00Z"),
    });
    expect(issues).toEqual([]);
  });

  it("catches a narrative injected with all four bad categories at once", () => {
    const bad = [
      CLEAN_NARRATIVE,
      "Given your portfolio's $42,000 Notes/Loans balance, reduce this to 0% and redeploy into equities.",
      "Auction demand deterioration fired this week, reflecting real deterioration in demand.",
    ].join("\n\n");
    const issues = runDeterministicFactChecks(bad, {
      supersededLabels: ["Auction demand deterioration"],
      auctionDataAsOf: "2026-10-07",
      now: new Date("2026-11-18T00:00:00Z"),
    });
    // holdings + rebalance + superseded-firing + stale-this-week, at minimum one each
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});
