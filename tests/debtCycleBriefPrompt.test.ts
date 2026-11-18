import { describe, it, expect } from "vitest";
import { buildBriefPrompt, BriefPromptParams } from "../supabase/functions/_shared/debtCycleBriefPrompt.ts";

// v3 Phase 3a: no portfolioGapLines field exists on BriefPromptParams at
// all anymore -- TypeScript itself refuses to compile a params object
// that tries to pass holdings/portfolio data in, which is the real proof
// "no holdings data reaches the prompt," not just that the rendered text
// happens to look clean. This params object is deliberately built with
// NOTHING holdings-related in scope.
const BASE_PARAMS: BriefPromptParams = {
  stage: "MP1",
  previousStage: null,
  conditions: {
    debtServiceStrained: false,
    rGreaterG: false,
    fedPrintingRising: false,
    mp2Gate: false,
    mp3AuctionDemandWeak: false,
    mp3SomaAbsorbing: false,
  },
  trendConfidence: "normal",
  benchmarkLines: ["Interest Expense — Danger Threshold: live 19.8% vs. Dalio's ~20%"],
  tripWiresArmed: [],
  tripWiresFiredThisWeek: [],
  refinancingPressure: { rEff: 3.38, convergenceGap: 1.74, dgs10: 5.12, rEff12moAgo: 3.36 },
  refinancingGapStatus: "watch",
  auctionDataAsOf: "2026-10-07",
  methodologyNote: null,
};

describe("buildBriefPrompt (v3 Phase 3a)", () => {
  it("never mentions portfolio gap, dollar amounts, or a 'Concrete moves' SECTION (the explicit negative instruction telling the model not to produce one is fine and expected)", () => {
    const prompt = buildBriefPrompt(BASE_PARAMS);
    expect(prompt).not.toMatch(/portfolio gap/i);
    expect(prompt).not.toMatch(/\(5\)\s*"?concrete moves/i); // the OLD item-5 header/structure is gone
    expect(prompt).not.toMatch(/\$[\d,]/);
    expect(prompt.toLowerCase()).not.toContain("bw modified");
  });

  it("includes the explicit 'do not reference holdings / no rebalancing instructions' hard constraint", () => {
    const prompt = buildBriefPrompt(BASE_PARAMS);
    expect(prompt).toMatch(/do not reference the user's holdings, balances, or allocation percentages/i);
    expect(prompt).toMatch(/do not issue rebalancing instructions/i);
  });

  it("replaces item (5) with 'Implications' (asset-class-general), not a bulleted move list", () => {
    const prompt = buildBriefPrompt(BASE_PARAMS);
    expect(prompt).toMatch(/\(5\)\s*"?Implications"?/i);
    expect(prompt.toLowerCase()).toContain("asset classes generally");
    expect(prompt.toLowerCase()).not.toContain("bullet points");
  });

  it("tells the model the real auction data_as_of and warns against false 'this week' claims", () => {
    const prompt = buildBriefPrompt(BASE_PARAMS);
    expect(prompt).toContain("2026-10-07");
    expect(prompt.toLowerCase()).toContain('do not describe any auction as happening "this week,"');
  });

  it("warns explicitly when there is no auction data at all", () => {
    const prompt = buildBriefPrompt({ ...BASE_PARAMS, auctionDataAsOf: null });
    expect(prompt.toLowerCase()).toContain("no auction data is currently available");
  });

  it("still carries the stage, conditions, and trip-wire sections unchanged", () => {
    const prompt = buildBriefPrompt(BASE_PARAMS);
    expect(prompt).toContain("CURRENT STAGE: MP1");
    expect(prompt).toContain("None currently armed.");
    expect(prompt).toContain("None fired this week.");
  });
});
