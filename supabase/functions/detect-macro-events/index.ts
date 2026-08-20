import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Same debt-cycle row id used by update-big-cycle-metrics's threshold classifier.
const DEBT_CYCLE_ID = "da204e3f-ae22-47dd-95bb-2844d4f75685";

// Fixed watch-list so search stays scoped to events that actually matter for
// the debt cycle's stage call, instead of free-associating on any Fed news.
const EVENT_TYPES = [
  "yield_curve_control",
  "qe_announcement",
  "qt_announcement",
  "debt_monetization",
  "debt_ceiling_action",
  "major_fiscal_package",
  "capital_controls",
  "sovereign_credit_action",
  "emergency_rate_action",
  "other",
];

const VALID_STAGES = ["MP1", "MP1 (strained)", "MP2", "MP3"];

interface DetectedEvent {
  event_type: string;
  headline: string;
  date?: string;
  source_url: string;
  source_name?: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  suggested_stage?: string | null;
  stage_rationale?: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function buildPrompt(currentStage: { label: string; description: string } | null, seenUrls: string[]): string {
  const stageLine = currentStage
    ? `The debt cycle's current stage is assessed as "${currentStage.label}": ${currentStage.description}`
    : `The debt cycle's current stage is not currently set.`;
  const seenLine = seenUrls.length
    ? `\nAlready-reported events (do NOT re-report these URLs, even if you find follow-up coverage of the same event):\n${seenUrls.map((u) => `- ${u}`).join("\n")}`
    : "";
  return `You are scanning for discrete US federal policy events that materially bear on the debt cycle stage in Dalio's "Principles for Navigating Big Debt Crises" framework (stages: MP1 — rate policy; "MP1 (strained)" — fiscal dominance building; MP2 — QE / zero-rate balance-sheet expansion; MP3 — monetary-fiscal coordination / debt monetization).

${stageLine}
${seenLine}

Use web search to check for genuinely new, material Federal Reserve or US Treasury policy news from roughly the last 10 days — for example: yield curve control, a new QE or QT program, direct debt monetization, debt ceiling action, a major fiscal package, capital controls, a sovereign credit rating action, or an emergency rate move. Ignore routine commentary, forecasts, or speculation about what the Fed "might" do — only report events that have actually happened or been formally announced.

Return ONLY a raw JSON array, no markdown fences, no prose before or after. One object per genuinely new event found (empty array [] if none):
- "event_type": one of ${JSON.stringify(EVENT_TYPES)}
- "headline": the event, stated plainly
- "date": YYYY-MM-DD if known
- "source_url": a real, checkable URL
- "source_name": the publication or agency
- "summary": one checkable-claim sentence, under 30 words
- "confidence": "high" | "medium" | "low"
- "suggested_stage": one of ${JSON.stringify(VALID_STAGES)} if this event should change the debt-cycle stage call, otherwise null
- "stage_rationale": one sentence justifying the suggested_stage, or null if suggested_stage is null

Only set suggested_stage when the event itself is strong enough evidence to justify that stage on its own — do not suggest a stage change for routine or ambiguous news.`;
}

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

async function runClaude(prompt: string): Promise<DetectedEvent[] | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 20 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) { console.error("anthropic error", res.status, await res.text()); return null; }
    const j = await res.json();
    const text = (j.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    const parsed = extractJsonArray(text);
    if (!parsed) { console.error("[detect-macro-events] could not parse JSON:", text.slice(0, 500)); return null; }
    return parsed as DetectedEvent[];
  } catch (e) { console.error("runClaude failed", e); return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: stageRow } = await sb
      .from("big_cycle_stages")
      .select("label, description")
      .eq("cycle_id", DEBT_CYCLE_ID)
      .eq("is_current", true)
      .maybeSingle();

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: seen } = await sb
      .from("big_cycle_events")
      .select("source_url")
      .gte("detected_at", since)
      .not("source_url", "is", null);
    const seenUrls = new Set((seen ?? []).map((r: { source_url: string }) => r.source_url));

    const prompt = buildPrompt(stageRow as { label: string; description: string } | null, [...seenUrls]);
    const found = await runClaude(prompt);

    if (found === null) {
      await sb.from("big_cycle_event_scans").insert({ status: "error", events_found: 0, summary: "Scan failed — could not generate or parse assessment." });
      return json({ error: "scan generation failed" }, 500);
    }

    const rows = found
      .filter((e) => e.headline && e.summary && e.source_url && !seenUrls.has(e.source_url))
      .map((e) => ({
        event_type: EVENT_TYPES.includes(e.event_type) ? e.event_type : "other",
        headline: e.headline,
        source_url: e.source_url,
        source_name: e.source_name ?? null,
        summary: e.summary,
        confidence: ["high", "medium", "low"].includes(e.confidence) ? e.confidence : "medium",
        suggested_stage: VALID_STAGES.includes(e.suggested_stage ?? "") ? e.suggested_stage : null,
        stage_rationale: e.stage_rationale ?? null,
        status: "pending",
      }));

    if (rows.length) {
      const { error: insErr } = await sb.from("big_cycle_events").insert(rows);
      if (insErr) console.error("[detect-macro-events] insert:", insErr);
    }

    const summary = rows.length
      ? `${rows.length} new event(s): ${rows.map((r) => r.headline).join("; ")}`
      : "No material new events found.";
    await sb.from("big_cycle_event_scans").insert({ status: "ok", events_found: rows.length, summary });

    return json({ status: "ok", events_found: rows.length, events: rows });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
