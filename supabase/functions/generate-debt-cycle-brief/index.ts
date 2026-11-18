import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { convergenceGapStatus } from "../_shared/statusThresholds.ts";
import { buildBriefPrompt, BriefPromptParams } from "../_shared/debtCycleBriefPrompt.ts";
import { runDeterministicFactChecks } from "../_shared/briefFactCheck.ts";
import { filterSupersededFirings, FiringLike, StageNoteLike } from "../_shared/tripWireSupersession.ts";

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

const TRIP_WIRE_LABELS: Record<string, string> = {
  mp2_onset_watch: "MP2 onset watch",
  auction_demand_deterioration: "Auction demand deterioration",
  dollar_divergence_widening: "Dollar confidence divergence widening",
  stock_bond_corr_positive: "Positive stock-bond correlation regime",
  fiscal_dominance_confirmed: "Fiscal-dominance regime confirmed",
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

async function generateBrief(
  promptParams: BriefPromptParams,
): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const prompt = buildBriefPrompt(promptParams);
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
    const refinancingPressure = {
      rEff: rawInputs.rEff ?? null,
      convergenceGap: rawInputs.convergenceGap ?? null,
      dgs10: rawInputs.dgs10 ?? null,
      rEff12moAgo: rawInputs.rEff12moAgo ?? null,
    };
    const refinancingGapStatus = refinancingPressure.convergenceGap != null ? convergenceGapStatus(refinancingPressure.convergenceGap) : null;

    const conditions = audit.conditions as Conditions;
    const tripWires = (audit.trip_wires ?? {}) as Record<string, TripWireState>;
    const armedNow = Object.fromEntries(Object.entries(tripWires).map(([k, t]) => [k, t.armed]));

    const tripWiresArmed = Object.entries(tripWires)
      .filter(([, t]) => t.armed)
      .map(([key, t]) => ({ label: TRIP_WIRE_LABELS[key] ?? key, sinceDate: t.sinceDate }));

    // v3 Phase 3d: exclude firings superseded by a same-key recalibration
    // note dated on/after the firing, trip-wire disarmed since -- the exact
    // fix for the Nov 17 artifact (the "Auction demand deterioration"
    // firing that fired hours before that same day's recalibration note).
    // Fetches ALL notes, not just the latest, since supersession needs to
    // check every note for a match, not only the most recent one overall.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [{ data: firedRows }, { data: allNotes }] = await Promise.all([
      sb.from("notifications")
        .select("metadata, created_at")
        .eq("category", "debt_cycle")
        .eq("type", "trip_wire")
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false }),
      sb.from("big_cycle_stage_notes").select("note, created_at").order("created_at", { ascending: false }),
    ]);
    const firings: FiringLike[] = (firedRows ?? []).map((r: { metadata: { trip_wire_key?: string }; created_at: string }) => ({
      tripWireKey: r.metadata?.trip_wire_key ?? "",
      firedAt: r.created_at,
    }));
    const stageNotes: StageNoteLike[] = (allNotes ?? []).map((n: { note: string; created_at: string }) => ({
      note: n.note, createdAt: n.created_at,
    }));
    const { kept: keptFirings, superseded: supersededFirings } = filterSupersededFirings(firings, stageNotes, armedNow);
    const tripWiresFiredThisWeek = keptFirings.map((f) => ({
      label: TRIP_WIRE_LABELS[f.tripWireKey] ?? f.tripWireKey,
      firedAt: f.firedAt.slice(0, 10),
    }));
    const supersededLabelsForFactCheck = [...new Set(supersededFirings.map((f) => TRIP_WIRE_LABELS[f.tripWireKey] ?? f.tripWireKey))];

    // v3 Phase 3c: the feed's real newest 10Y/30Y auction date -- so both
    // the prompt (told explicitly not to call stale data "this week") and
    // the fact-check's stale-claim rule use the same ground truth. Takes
    // the more recent of the two auction-sourced cards' data_as_of.
    const { data: auctionCardRows } = await sb
      .from("macro_indicators")
      .select("metadata")
      .in("name", ["Indirect Bidder Share (10Y/30Y)", "Treasury Bid-to-Cover"]);
    const auctionDataAsOfCandidates = (auctionCardRows ?? [])
      .map((r: { metadata: { data_as_of?: string } | null }) => r.metadata?.data_as_of)
      .filter((d): d is string => !!d);
    const auctionDataAsOf = auctionDataAsOfCandidates.length ? auctionDataAsOfCandidates.sort().reverse()[0] : null;

    const { data: benchmarkMetricRows } = await sb
      .from("big_cycle_metrics")
      .select("key, value_display")
      .in("key", [...new Set(DALIO_BENCHMARKS_FOR_PROMPT.map((b) => b.metricKey))]);
    const metricDisplayByKey = new Map((benchmarkMetricRows ?? []).map((r: { key: string; value_display: string }) => [r.key, r.value_display]));
    const benchmarkLines = DALIO_BENCHMARKS_FOR_PROMPT.map((b) =>
      `${b.label}: live ${metricDisplayByKey.get(b.metricKey) ?? "n/a"} vs. Dalio's ~${b.value}${b.unit}`
    );

    // Latest note overall (any key) -- still used for the "stage changed
    // due to a methodology fix" framing, a separate concern from the
    // per-key supersession check above.
    const methodologyNote = stageNotes[0]?.note ?? null;

    const promptParams: BriefPromptParams = {
      stage: audit.stage as string,
      previousStage: (audit.previous_stage as string | null) ?? null,
      conditions,
      trendConfidence: audit.trend_confidence as string,
      benchmarkLines,
      tripWiresArmed,
      tripWiresFiredThisWeek,
      refinancingPressure,
      refinancingGapStatus,
      auctionDataAsOf,
      methodologyNote,
    };

    const narrativeFirstPass = await generateBrief(promptParams);
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
    const referenceBlock = [
      `Stage: ${promptParams.stage}`,
      `Conditions: ${JSON.stringify(conditions)}`,
      `Trip-wires armed: ${tripWiresArmed.map((t) => t.label).join(", ") || "none"}`,
      `r_eff: ${refinancingPressure.rEff != null ? refinancingPressure.rEff.toFixed(2) + "%" : "n/a"}`,
      `10Y Treasury yield: ${refinancingPressure.dgs10 != null ? refinancingPressure.dgs10.toFixed(2) + "%" : "n/a"}`,
      `Convergence gap (10Y - r_eff): ${refinancingPressure.convergenceGap != null ? refinancingPressure.convergenceGap.toFixed(2) + "pts" : "n/a"}${refinancingGapStatus ? ` (${refinancingGapStatus})` : ""}`,
      `r_eff 12 months ago: ${refinancingPressure.rEff12moAgo != null ? refinancingPressure.rEff12moAgo.toFixed(2) + "%" : "not enough history yet"}`,
      ...(promptParams.stage === "MP1" && refinancingGapStatus === "danger"
        ? [`FRAMING RULE IN EFFECT: stage is MP1 with a large (danger-band) convergence gap — the narrative must describe this as "no current strain, rising pressure," not as "healthy" or "no concern." Flag it as a contradiction if the narrative calls this combination healthy or expresses no concern about it.`]
        : []),
    ].join("\n");

    // v3 Phase 3c: deterministic regex rules (holdings reference,
    // rebalance instruction, superseded-firing claim, stale "this week"
    // claim) run alongside the existing LLM consistency check -- either
    // source of issues triggers the same regenerate-once-then-banner flow.
    async function factCheck(narrative: string): Promise<string[]> {
      const deterministic = runDeterministicFactChecks(narrative, {
        supersededLabels: supersededLabelsForFactCheck,
        auctionDataAsOf,
        now: new Date(),
      });
      const llm = await validateConsistency(narrative, referenceBlock);
      return [...deterministic, ...(llm.consistent ? [] : llm.issues)];
    }

    let narrative = narrativeFirstPass;
    let issues = await factCheck(narrative);
    let factCheckFlagged = false;

    if (issues.length > 0) {
      console.error("[debt-cycle-brief] fact-check flagged (pass 1):", issues);
      const retried = await generateBrief({ ...promptParams, correction: issues.map((i) => `- ${i}`).join("\n") });
      if (retried) {
        narrative = retried;
        issues = await factCheck(narrative);
        if (issues.length > 0) {
          console.error("[debt-cycle-brief] fact-check flagged (pass 2, after regenerate):", issues);
          factCheckFlagged = true;
        }
      } else {
        factCheckFlagged = true;
      }
    }

    const row = {
      brief_date: today,
      narrative,
      stage: promptParams.stage,
      stage_audit_id: audit.id,
      benchmarks_compared: benchmarkLines,
      trip_wires_fired: tripWiresFiredThisWeek,
      fact_check_flagged: factCheckFlagged,
      fact_check_issues: factCheckFlagged ? issues : [],
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
