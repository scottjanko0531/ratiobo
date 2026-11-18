// Pure, Deno-API-free prompt-text builder for generate-debt-cycle-brief,
// split out specifically so the prompt-builder unit test (v3 Phase 3,
// "no portfolioGapLines and no holdings data reach the prompt") can
// assert on the actual prompt STRING without a network call -- the edge
// function's module-scope Deno.env.get(...)! calls would throw if this
// logic lived there and Vitest tried to import it, same split rationale
// as every other _shared/ module in this spec.
//
// v3 Phase 3a: this is a MACRO-only brief. "Concrete moves" (a bulleted
// rebalancing-instruction section grounded in the user's own portfolio
// gap vs. BW Modified) and its portfolioGapLines input are gone --
// confirmed live in v3 Phase 0 that this panel had been telling Scott to
// zero out a 42%-weighted bucket (Notes/Loans, which includes an
// illiquid $5.2M holding) based on a stage-check panel that was never
// supposed to be giving household allocation orders. Replaced with
// "Implications": general, asset-class-level commentary (duration, real
// assets, cash yields) with NO numbers tied to the user's own holdings.

export interface Conditions {
  debtServiceStrained: boolean;
  rGreaterG: boolean;
  fedPrintingRising: boolean;
  mp2Gate: boolean;
  mp3AuctionDemandWeak: boolean;
  mp3SomaAbsorbing: boolean;
}

export interface RefinancingPressure {
  rEff: number | null;
  convergenceGap: number | null;
  dgs10: number | null;
  rEff12moAgo: number | null;
}

// `gapStatus` is passed in (not recomputed here) so this module never
// needs to import convergenceGapStatus from statusThresholds.ts -- keeps
// this file's only dependency surface at zero, matching every other pure
// _shared/ prompt/math module in this codebase.
export interface BriefPromptParams {
  stage: string;
  previousStage: string | null;
  conditions: Conditions;
  trendConfidence: string;
  benchmarkLines: string[];
  tripWiresArmed: { label: string; sinceDate: string | null }[];
  tripWiresFiredThisWeek: { label: string; firedAt: string }[];
  refinancingPressure: RefinancingPressure;
  refinancingGapStatus: "healthy" | "watch" | "danger" | null;
  auctionDataAsOf: string | null;
  correction?: string;
  methodologyNote?: string | null;
}

export function buildBriefPrompt(params: BriefPromptParams): string {
  const {
    stage, previousStage, conditions, trendConfidence,
    benchmarkLines, tripWiresArmed, tripWiresFiredThisWeek,
    refinancingPressure, refinancingGapStatus, auctionDataAsOf,
    correction, methodologyNote,
  } = params;

  let refinancingPressureBlock = "REFINANCING PRESSURE AHEAD (forward signal, not a stage gate): not enough data yet.";
  let largeGapMp1Instruction = "";
  if (refinancingPressure.rEff != null && refinancingPressure.convergenceGap != null) {
    const trendLine = refinancingPressure.rEff12moAgo != null
      ? `r_eff 12 months ago: ${refinancingPressure.rEff12moAgo.toFixed(2)}% (${(refinancingPressure.rEff - refinancingPressure.rEff12moAgo) >= 0 ? "up" : "down"} ${Math.abs(refinancingPressure.rEff - refinancingPressure.rEff12moAgo).toFixed(2)}pts over the trailing 12 months)`
      : "12-month trend: not enough history yet";
    refinancingPressureBlock = `REFINANCING PRESSURE AHEAD (forward signal, not a stage gate):
  r_eff (blended effective rate on all outstanding federal debt): ${refinancingPressure.rEff.toFixed(2)}%
  10Y Treasury yield: ${refinancingPressure.dgs10 != null ? refinancingPressure.dgs10.toFixed(2) : "n/a"}%
  Convergence gap (10Y - r_eff): ${refinancingPressure.convergenceGap.toFixed(2)}pts (${refinancingGapStatus ?? "n/a"})
  ${trendLine}
  As maturing debt refinances at today's higher rate, r_eff converges upward toward the 10Y over time -- this gap is the amount of future repricing still ahead, not a current-period cost.`;
    if (stage === "MP1" && refinancingGapStatus === "danger") {
      largeGapMp1Instruction = `\nIMPORTANT FRAMING RULE: the stage is MP1 (no current gate is tripped) AND the convergence gap above is large (${refinancingGapStatus}). Describe this combination explicitly as "no current strain, rising pressure" -- NOT as "healthy" or "no concern." A large gap means a lot of outstanding debt is still priced well below today's rate and has yet to reprice as it matures; that is a real forward risk even though no stage condition is triggered today. Do not let the calm stage label imply the forward picture is calm too.\n`;
    }
  }

  const conditionLines = [
    `Debt service strained (interest expense > 20% of federal revenue): ${conditions.debtServiceStrained ? "TRUE" : "false"}`,
    `r > g (10Y yield exceeds nominal GDP growth): ${conditions.rGreaterG ? "TRUE" : "false"}`,
    `Fed printing rising (Fed Balance Sheet % GDP in a sustained uptrend): ${conditions.fedPrintingRising ? "TRUE" : "false"}`,
    `MP2 gate (near-zero rates AND Fed printing rising): ${conditions.mp2Gate ? "TRUE" : "false"}`,
    `MP3 auction demand weak (indirect bidder share or bid-to-cover trailing average weak): ${conditions.mp3AuctionDemandWeak ? "TRUE" : "false"}`,
    `MP3 SOMA absorbing (sustained positive long-duration absorption): ${conditions.mp3SomaAbsorbing ? "TRUE" : "false"}`,
  ].join("\n  ");

  const auctionFreshnessLine = auctionDataAsOf
    ? `Newest 10Y/30Y Treasury auction the feed actually has: ${auctionDataAsOf} (data_as_of). Do NOT describe any auction as happening "this week," "recently," or "the latest" unless that date is within the last 7 days of today -- if it is older, say so plainly (e.g. "the most recent auction on file is from ${auctionDataAsOf}") rather than implying it is current.`
    : `No auction data is currently available (data_as_of is null). Do not make any claim about "this week's" or "recent" auction activity.`;

  return `You are Clio, macro analyst at RatioBo, writing the "Debt Cycle Position Check" — a sibling panel to your existing Clio Musings regime analysis, but scoped specifically to Ray Dalio's Big Debt Cycle framework (MP1 / MP1 (strained) / MP2 / MP3). Write direct, sharp analysis — no hedging language, no fluff, under 350 words total. No markdown headers, no bold, no title line.
${correction ? `\nCORRECTION REQUIRED — your previous draft was flagged for these factual/consistency problems; fix all of them in this rewrite:\n${correction}\n` : ""}
HARD CONSTRAINT: the stage below is a computed, auditable classification, not your own judgment call. State it exactly as given and never contradict it or hedge it into a different stage. If trendConfidence is "low" or "unknown", say so explicitly rather than presenting the read with unwarranted certainty.
HARD CONSTRAINT: this is a MACRO-ONLY brief. Do not reference the user's holdings, balances, or allocation percentages. Do not issue rebalancing instructions (no "buy," "sell," "reduce," "redeploy," or any bucket-specific move). This panel assesses the debt cycle itself, not what any individual should do about it.
${methodologyNote ? `\nMETHODOLOGY NOTE (mention this plainly if the stage changed from the prior run — this is a definition correction, not evidence that fundamentals improved): ${methodologyNote}\n` : ""}${largeGapMp1Instruction}
CURRENT STAGE: ${stage}${previousStage && previousStage !== stage ? ` (changed from ${previousStage} this run)` : ""}
Trend confidence: ${trendConfidence}
Conditions driving this classification:
  ${conditionLines}

DALIO'S PUBLISHED BENCHMARKS vs. LIVE READINGS (his own cited figures, not our model):
${benchmarkLines.map((l) => `  ${l}`).join("\n")}

${refinancingPressureBlock}

${auctionFreshnessLine}

TRIP-WIRES — currently armed (early-warning signals, distinct from the stage classification above):
${tripWiresArmed.length ? tripWiresArmed.map((t) => `  - ${t.label}${t.sinceDate ? ` (since ${t.sinceDate})` : ""}`).join("\n") : "  None currently armed."}

TRIP-WIRES fired in the last 7 days:
${tripWiresFiredThisWeek.length ? tripWiresFiredThisWeek.map((t) => `  - ${t.label} (${t.firedAt})`).join("\n") : "  None fired this week."}

Structure your answer in five parts, separated by blank lines:
(1) A paragraph stating the current stage, which conditions drove it, and how that compares to the prior stage if it changed.
(2) A paragraph comparing the live readings above to Dalio's own cited benchmarks — where do we stand relative to his stated checkpoints?
(3) A short paragraph on REFINANCING PRESSURE AHEAD above — mention r_eff, the 10Y, the convergence gap, and the 12-month trend if available. This is a forward signal, not part of today's stage classification; say so explicitly. If the IMPORTANT FRAMING RULE above applies, follow it exactly.
(4) A paragraph on trip-wires: what's currently armed, what fired this week, and what a viewer should actually watch for next.
(5) "Implications" — 2-4 sentences on what the current stage, trip-wires, and refinancing pressure mean for asset classes GENERALLY (e.g. duration, real assets, cash yields). Speak about asset classes and market conditions, never about "your portfolio" or any specific dollar/percentage allocation — that is out of scope for this panel.

All five parts must be plain prose — no bullets, no bold, no headers, no "Concrete moves" section.`;
}
