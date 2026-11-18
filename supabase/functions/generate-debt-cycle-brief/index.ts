import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeBucketGaps, BW_ALLOC, HoldingLike } from "../_shared/portfolioGap.ts";
import { convergenceGapStatus } from "../_shared/statusThresholds.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEBT_CYCLE_ID = "da204e3f-ae22-47dd-95bb-2844d4f75685";

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
}

// Must stay in sync with lib/dalioBenchmarks.js — inert data, not logic, so a
// duplicate-with-comment is fine here (same convention as the gauge-assessment
// functions in this file's sibling, update-big-cycle-metrics/index.ts).
const DALIO_BENCHMARKS_FOR_PROMPT = [
  { label: "Interest Expense — Danger Threshold", value: 20, unit: "%", metricKey: "interest_expense_revenue_pct" },
  { label: "Debt / Revenue — Current Reference", value: 6, unit: "x", metricKey: "debt_tax_revenue_multiple" },
  { label: "Debt / Revenue — 10-Year Trajectory", value: 7, unit: "x", metricKey: "debt_tax_revenue_multiple" },
  { label: "Deficit — Soft-Landing Target", value: 3, unit: "% of GDP", metricKey: "deficit_pct_gdp" },
];

const KEY_LABEL: Record<string, string> = {
  eq: "US Equities", intl: "International", em: "EM Equities", nb: "Nominal Bonds",
  tip: "TIPS", com: "Commodities", gld: "Gold", cash: "Cash",
  alt_crypto: "Crypto", alt_re: "Real Estate", alt_loan: "Notes / Loans",
  alt_pp: "Private Placements", alt_other: "Other",
};

interface Conditions {
  debtServiceStrained: boolean;
  rGreaterG: boolean;
  fedPrintingRising: boolean;
  mp2Gate: boolean;
  mp3AuctionDemandWeak: boolean;
  mp3SomaAbsorbing: boolean;
}

interface TripWireState { armed: boolean; sinceDate: string | null; values: Record<string, number | null> }

// v2 Phase 6c: the forward-looking "refinancing pressure ahead" signal
// (Phase 6a/6b) -- informational, not a stage gate, same as the condition
// lines above. null fields mean the underlying card hasn't got enough
// data yet (e.g. rEff12moAgo before a year of history exists).
interface RefinancingPressure {
  rEff: number | null;
  convergenceGap: number | null;
  dgs10: number | null;
  rEff12moAgo: number | null;
}

async function generateBrief(params: {
  stage: string;
  previousStage: string | null;
  conditions: Conditions;
  trendConfidence: string;
  benchmarkLines: string[];
  tripWiresArmed: { label: string; sinceDate: string | null }[];
  tripWiresFiredThisWeek: { label: string; firedAt: string }[];
  portfolioGapLines: string[];
  refinancingPressure: RefinancingPressure;
  correction?: string;
  methodologyNote?: string | null;
}): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const {
      stage, previousStage, conditions, trendConfidence,
      benchmarkLines, tripWiresArmed, tripWiresFiredThisWeek, portfolioGapLines, refinancingPressure, correction, methodologyNote,
    } = params;

    // v2 Phase 6c: built once here (not inline in the template literal)
    // since the MP1-framing instruction below needs to branch on whether
    // the gap is actually in the "danger" (large) band.
    let refinancingPressureBlock = "REFINANCING PRESSURE AHEAD (forward signal, not a stage gate): not enough data yet.";
    let largeGapMp1Instruction = "";
    if (refinancingPressure.rEff != null && refinancingPressure.convergenceGap != null) {
      const gapStatus = convergenceGapStatus(refinancingPressure.convergenceGap);
      const trendLine = refinancingPressure.rEff12moAgo != null
        ? `r_eff 12 months ago: ${refinancingPressure.rEff12moAgo.toFixed(2)}% (${(refinancingPressure.rEff - refinancingPressure.rEff12moAgo) >= 0 ? "up" : "down"} ${Math.abs(refinancingPressure.rEff - refinancingPressure.rEff12moAgo).toFixed(2)}pts over the trailing 12 months)`
        : "12-month trend: not enough history yet";
      refinancingPressureBlock = `REFINANCING PRESSURE AHEAD (forward signal, not a stage gate):
  r_eff (blended effective rate on all outstanding federal debt): ${refinancingPressure.rEff.toFixed(2)}%
  10Y Treasury yield: ${refinancingPressure.dgs10 != null ? refinancingPressure.dgs10.toFixed(2) : "n/a"}%
  Convergence gap (10Y - r_eff): ${refinancingPressure.convergenceGap.toFixed(2)}pts (${gapStatus})
  ${trendLine}
  As maturing debt refinances at today's higher rate, r_eff converges upward toward the 10Y over time -- this gap is the amount of future repricing still ahead, not a current-period cost.`;
      if (stage === "MP1" && gapStatus === "danger") {
        largeGapMp1Instruction = `\nIMPORTANT FRAMING RULE: the stage is MP1 (no current gate is tripped) AND the convergence gap above is large (${gapStatus}). Describe this combination explicitly as "no current strain, rising pressure" -- NOT as "healthy" or "no concern." A large gap means a lot of outstanding debt is still priced well below today's rate and has yet to reprice as it matures; that is a real forward risk even though no stage condition is triggered today. Do not let the calm stage label imply the forward picture is calm too.\n`;
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

    const prompt = `You are Clio, macro analyst at RatioBo, writing the "Debt Cycle Position Check" — a sibling panel to your existing Clio Musings regime analysis, but scoped specifically to Ray Dalio's Big Debt Cycle framework (MP1 / MP1 (strained) / MP2 / MP3). Write direct, sharp analysis — no hedging language, no fluff, under 350 words total. No markdown headers, no bold, no title line.
${correction ? `\nCORRECTION REQUIRED — your previous draft was flagged for these factual/consistency problems; fix all of them in this rewrite:\n${correction}\n` : ""}
HARD CONSTRAINT: the stage below is a computed, auditable classification, not your own judgment call. State it exactly as given and never contradict it or hedge it into a different stage. If trendConfidence is "low" or "unknown", say so explicitly rather than presenting the read with unwarranted certainty.
${methodologyNote ? `\nMETHODOLOGY NOTE (mention this plainly if the stage changed from the prior run — this is a definition correction, not evidence that fundamentals improved): ${methodologyNote}\n` : ""}${largeGapMp1Instruction}
CURRENT STAGE: ${stage}${previousStage && previousStage !== stage ? ` (changed from ${previousStage} this run)` : ""}
Trend confidence: ${trendConfidence}
Conditions driving this classification:
  ${conditionLines}

DALIO'S PUBLISHED BENCHMARKS vs. LIVE READINGS (his own cited figures, not our model):
${benchmarkLines.map((l) => `  ${l}`).join("\n")}

${refinancingPressureBlock}

TRIP-WIRES — currently armed (early-warning signals, distinct from the stage classification above):
${tripWiresArmed.length ? tripWiresArmed.map((t) => `  - ${t.label}${t.sinceDate ? ` (since ${t.sinceDate})` : ""}`).join("\n") : "  None currently armed."}

TRIP-WIRES fired in the last 7 days:
${tripWiresFiredThisWeek.length ? tripWiresFiredThisWeek.map((t) => `  - ${t.label} (${t.firedAt})`).join("\n") : "  None fired this week."}

PORTFOLIO GAP vs. BW Modified (bucket-level, largest deltas first):
${portfolioGapLines.length ? portfolioGapLines.map((l) => `  ${l}`).join("\n") : "  No portfolio data available."}

Structure your answer in five parts, separated by blank lines:
(1) A paragraph stating the current stage, which conditions drove it, and how that compares to the prior stage if it changed.
(2) A paragraph comparing the live readings above to Dalio's own cited benchmarks — where do we stand relative to his stated checkpoints?
(3) A short paragraph on REFINANCING PRESSURE AHEAD above — mention r_eff, the 10Y, the convergence gap, and the 12-month trend if available. This is a forward signal, not part of today's stage classification; say so explicitly. If the IMPORTANT FRAMING RULE above applies, follow it exactly.
(4) A paragraph on trip-wires: what's currently armed, what fired this week, and what a viewer should actually watch for next.
(5) A "Concrete moves:" section: one short lead-in sentence, then 2-5 bullet points (each on its own line, starting with "- "), each a specific, actionable rebalancing suggestion grounded in the portfolio gap data above — name the actual bucket and direction, not vague advice.

Parts 1-4 must be plain prose — no bullets, no bold, no headers. Part 5 must be lead-in sentence + bullets only.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.content?.[0]?.text as string | undefined) ?? null;
    return raw ? stripMarkdown(raw) : null;
  } catch { return null; }
}

// Cheap cross-check pass, same shape as get-regime-analysis's
// validateConsistency() — catches the narrative contradicting its own
// structured inputs (e.g. describing MP2 as active when the stage is MP1).
async function validateConsistency(narrative: string, reference: string): Promise<{ consistent: boolean; issues: string[] }> {
  if (!ANTHROPIC_KEY) return { consistent: true, issues: [] };
  try {
    const prompt = `You are a fact-checker. Compare the NARRATIVE below against the REFERENCE DATA it must be consistent with. Flag ONLY clear, checkable contradictions with the stage, conditions, trip-wire state, OR the refinancing-pressure numbers (r_eff, the 10Y, the convergence gap, the 12-month trend, and — when the reference data flags it — whether a large gap under an MP1 stage was framed as "no current strain, rising pressure" rather than as "healthy") — not stylistic quibbles.

REFERENCE DATA:
${reference}

NARRATIVE:
${narrative}

Respond with ONLY raw JSON, no markdown fences: {"consistent": true|false, "issues": ["short description of each contradiction found, empty array if none"]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return { consistent: true, issues: [] };
    const j = await res.json();
    const text = (j.content?.[0]?.text as string | undefined) ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return { consistent: true, issues: [] };
    const parsed = JSON.parse(text.slice(start, end + 1));
    return { consistent: parsed.consistent !== false, issues: Array.isArray(parsed.issues) ? parsed.issues : [] };
  } catch { return { consistent: true, issues: [] }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get("refresh") === "true";
    const today = new Date().toISOString().slice(0, 10);

    if (!forceRefresh) {
      const { data: cached } = await sb.from("dalio_debt_cycle_brief").select("*").eq("brief_date", today).maybeSingle();
      if (cached) {
        return new Response(JSON.stringify(cached), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    // Defensive self-trigger: this can be visited before anyone has clicked
    // "Refresh Now" today, same pattern analyze-portfolio-health uses for
    // get-regime-analysis (Clio has no cron of its own either).
    const { data: latestAuditCheck } = await sb
      .from("big_cycle_stage_audit_log")
      .select("run_at")
      .eq("cycle_id", DEBT_CYCLE_ID)
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const latestAuditIsToday = latestAuditCheck?.run_at?.slice(0, 10) === today;
    if (!latestAuditIsToday) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/update-big-cycle-metrics`, {
          method: "POST",
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        });
      } catch (e) { console.error("[debt-cycle-brief] triggering update-big-cycle-metrics:", e); }
    }

    const { data: audit } = await sb
      .from("big_cycle_stage_audit_log")
      .select("*")
      .eq("cycle_id", DEBT_CYCLE_ID)
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!audit) {
      return new Response(JSON.stringify({ error: "no stage audit data available yet" }), {
        status: 503, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // v2 Phase 6c: refinancing-pressure inputs, read from the classifier's
    // own rawInputs (Phase 6a) — already on this same audit row, no extra
    // query needed.
    const rawInputs = (audit.raw_inputs ?? {}) as Record<string, number | null>;
    const refinancingPressure: RefinancingPressure = {
      rEff: rawInputs.rEff ?? null,
      convergenceGap: rawInputs.convergenceGap ?? null,
      dgs10: rawInputs.dgs10 ?? null,
      rEff12moAgo: rawInputs.rEff12moAgo ?? null,
    };

    const conditions = audit.conditions as Conditions;
    const tripWires = (audit.trip_wires ?? {}) as Record<string, TripWireState>;
    const TRIP_WIRE_LABELS: Record<string, string> = {
      mp2_onset_watch: "MP2 onset watch",
      auction_demand_deterioration: "Auction demand deterioration",
      dollar_divergence_widening: "Dollar confidence divergence widening",
      stock_bond_corr_positive: "Positive stock-bond correlation regime",
      fiscal_dominance_confirmed: "Fiscal-dominance regime confirmed",
    };
    const tripWiresArmed = Object.entries(tripWires)
      .filter(([, t]) => t.armed)
      .map(([key, t]) => ({ label: TRIP_WIRE_LABELS[key] ?? key, sinceDate: t.sinceDate }));

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: firedRows } = await sb
      .from("notifications")
      .select("metadata, created_at")
      .eq("category", "debt_cycle")
      .eq("type", "trip_wire")
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false });
    const tripWiresFiredThisWeek = (firedRows ?? []).map((r: { metadata: { trip_wire_key?: string }; created_at: string }) => ({
      label: TRIP_WIRE_LABELS[r.metadata?.trip_wire_key ?? ""] ?? r.metadata?.trip_wire_key ?? "unknown",
      firedAt: r.created_at.slice(0, 10),
    }));

    const { data: benchmarkMetricRows } = await sb
      .from("big_cycle_metrics")
      .select("key, value_display")
      .in("key", [...new Set(DALIO_BENCHMARKS_FOR_PROMPT.map((b) => b.metricKey))]);
    const metricDisplayByKey = new Map((benchmarkMetricRows ?? []).map((r: { key: string; value_display: string }) => [r.key, r.value_display]));
    const benchmarkLines = DALIO_BENCHMARKS_FOR_PROMPT.map((b) =>
      `${b.label}: live ${metricDisplayByKey.get(b.metricKey) ?? "n/a"} vs. Dalio's ~${b.value}${b.unit}`
    );

    const { data: stageNoteRow } = await sb
      .from("big_cycle_stage_notes")
      .select("note")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: holdingsRows } = await sb
      .from("holdings_valued")
      .select("simulator_key, asset_type, current_value");
    const bucketGaps = computeBucketGaps((holdingsRows ?? []) as HoldingLike[], BW_ALLOC);
    const portfolioGapLines = bucketGaps
      .filter((g) => Math.abs(g.deltaPct) >= 1)
      .slice(0, 8)
      .map((g) => `${KEY_LABEL[g.key] ?? g.key}: ${g.currentPct.toFixed(1)}% actual vs ${g.targetPct.toFixed(1)}% target (${g.deltaPct >= 0 ? "+" : ""}${g.deltaPct.toFixed(1)}pt)`);

    const briefParams = {
      stage: audit.stage as string,
      previousStage: (audit.previous_stage as string | null) ?? null,
      conditions,
      trendConfidence: audit.trend_confidence as string,
      benchmarkLines,
      tripWiresArmed,
      tripWiresFiredThisWeek,
      portfolioGapLines,
      refinancingPressure,
      methodologyNote: stageNoteRow?.note ?? null,
    };

    const narrativeFirstPass = await generateBrief(briefParams);
    if (!narrativeFirstPass) {
      return new Response(JSON.stringify({ error: "brief generation failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // v2 Phase 6c: the fact-check pass must verify the refinancing-pressure
    // sentence's numbers too, not just the stage label — these three lines
    // give it something concrete to check the narrative's r_eff/10Y/gap
    // claims against, plus the exact MP1-large-gap framing rule so it can
    // catch "healthy"/"no concern" language if the narrative used it when
    // it shouldn't have.
    const gapStatusForCheck = refinancingPressure.convergenceGap != null ? convergenceGapStatus(refinancingPressure.convergenceGap) : null;
    const referenceBlock = [
      `Stage: ${briefParams.stage}`,
      `Conditions: ${JSON.stringify(conditions)}`,
      `Trip-wires armed: ${tripWiresArmed.map((t) => t.label).join(", ") || "none"}`,
      `r_eff: ${refinancingPressure.rEff != null ? refinancingPressure.rEff.toFixed(2) + "%" : "n/a"}`,
      `10Y Treasury yield: ${refinancingPressure.dgs10 != null ? refinancingPressure.dgs10.toFixed(2) + "%" : "n/a"}`,
      `Convergence gap (10Y - r_eff): ${refinancingPressure.convergenceGap != null ? refinancingPressure.convergenceGap.toFixed(2) + "pts" : "n/a"}${gapStatusForCheck ? ` (${gapStatusForCheck})` : ""}`,
      `r_eff 12 months ago: ${refinancingPressure.rEff12moAgo != null ? refinancingPressure.rEff12moAgo.toFixed(2) + "%" : "not enough history yet"}`,
      ...(briefParams.stage === "MP1" && gapStatusForCheck === "danger"
        ? [`FRAMING RULE IN EFFECT: stage is MP1 with a large (danger-band) convergence gap — the narrative must describe this as "no current strain, rising pressure," not as "healthy" or "no concern." Flag it as a contradiction if the narrative calls this combination healthy or expresses no concern about it.`]
        : []),
    ].join("\n");
    const check = await validateConsistency(narrativeFirstPass, referenceBlock);

    let narrative = narrativeFirstPass;
    if (!check.consistent && check.issues.length > 0) {
      console.error("[debt-cycle-brief] consistency check flagged:", check.issues);
      const retried = await generateBrief({ ...briefParams, correction: check.issues.map((i) => `- ${i}`).join("\n") });
      if (retried) narrative = retried;
    }

    const row = {
      brief_date: today,
      narrative,
      stage: briefParams.stage,
      stage_audit_id: audit.id,
      benchmarks_compared: benchmarkLines,
      trip_wires_fired: tripWiresFiredThisWeek,
      portfolio_gap: bucketGaps,
      generated_at: new Date().toISOString(),
    };
    await sb.from("dalio_debt_cycle_brief").upsert(row, { onConflict: "brief_date" });

    return new Response(JSON.stringify(row), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
