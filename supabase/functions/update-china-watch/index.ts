import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Indicator {
  id: string;
  pillar_id: string;
  pillar_name: string;
  pillar_group: "ED" | "WC" | "PT" | "ER";
  name: string;
  description: string;
  score: number;
  confidence: string;
  note: string;
}

interface Change {
  id: string;
  changed: boolean;
  new_score?: number;
  new_confidence?: string;
  new_note?: string;
  sources?: string[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ── Scoring math (kept in lockstep with lib/chinaWatchScoring.js — the client
// recomputes the same formulas to preview composites before saving; this is
// the source-of-truth pass that gets archived into china_watch_snapshots). ──
function pillarAvg(scores: number[]): number {
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
function computeAll(indicators: { pillar_group: string; pillar_id: string; score: number }[]) {
  const byPillar = new Map<string, { group: string; scores: number[] }>();
  for (const ind of indicators) {
    if (!byPillar.has(ind.pillar_id)) byPillar.set(ind.pillar_id, { group: ind.pillar_group, scores: [] });
    byPillar.get(ind.pillar_id)!.scores.push(Number(ind.score));
  }
  const byGroup: Record<string, number[]> = { ED: [], WC: [], PT: [], ER: [] };
  for (const { group, scores } of byPillar.values()) byGroup[group].push(pillarAvg(scores));
  const avg = (arr: number[]) => (arr.length ? pillarAvg(arr) : 0);
  const ED = avg(byGroup.ED) * 10, WC = avg(byGroup.WC) * 10, PT = avg(byGroup.PT) * 10, ER = avg(byGroup.ER) * 10;
  const spi = 0.4 * ED + 0.35 * WC + 0.25 * PT;
  const t = Math.min(Math.max(spi / 100, 0), 1);
  const t0 = [70, 20, 8, 2], t1 = [10, 15, 35, 40];
  const base = t0.map((v, i) => v + (t1[i] - v) * t);
  let blockade = base[2] - ((ER - 50) / 50) * 15;
  let invasion = base[3] + ((ER - 50) / 50) * 15;
  if (blockade < 0) { invasion += blockade; blockade = 0; }
  if (invasion < 0) { blockade += invasion; invasion = 0; }
  const [grayzone, quarantine] = base;
  const total = grayzone + quarantine + blockade + invasion;
  return {
    ED, WC, PT, ER, spi,
    grayzone: (grayzone / total) * 100, quarantine: (quarantine / total) * 100,
    blockade: (blockade / total) * 100, invasion: (invasion / total) * 100,
  };
}

function buildPrompt(indicators: Indicator[]): string {
  const roster = indicators
    .map((i) => `- id: "${i.id}" | pillar: ${i.pillar_name} | indicator: ${i.name} — ${i.description} | current: ${i.score}/10, confidence ${i.confidence}, note: "${i.note}"`)
    .join("\n");
  return `You are updating a China structural-risk / Taiwan-scenario tracking model — ${indicators.length} indicators across four pillars (Economic Distress, Weaponizable Chokepoints, Political Timing, Escalation Readiness). This is a structured-judgment scaffold, not a statistical forecast; indicator notes must read like checkable claims (name the event or data point), not vague language.

Indicators:
${roster}

For EACH indicator, use web search to check for material news from roughly the last 35 days that would change its score, confidence, or note. Only move a score by more than ±2 if there is a clearly major development, and justify any large move explicitly in the new note.

Return ONLY a raw JSON array, one object per indicator above, in the same order, no markdown fences, no prose before or after:
- "id": the exact id given above, unchanged
- "changed": true or false
- If changed is true, also include: "new_score" (integer 0-10), "new_confidence" ("High" | "Medium" | "Low"), "new_note" (one checkable-claim sentence, under 30 words), "sources" (array of short strings naming what was checked)
- If changed is false, omit the other fields.`;
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

async function runClaude(indicators: Indicator[]): Promise<Change[] | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 12000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 40 }],
        messages: [{ role: "user", content: buildPrompt(indicators) }],
      }),
    });
    if (!res.ok) { console.error("anthropic error", res.status, await res.text()); return null; }
    const j = await res.json();
    const text = (j.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    const parsed = extractJsonArray(text);
    if (!parsed) { console.error("[china-watch] could not parse JSON:", text.slice(0, 500)); return null; }
    return parsed as Change[];
  } catch (e) { console.error("runClaude failed", e); return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: indicators, error: indErr } = await sb
      .from("china_watch_indicators")
      .select("id,pillar_id,pillar_name,pillar_group,name,description,score,confidence,note")
      .order("sort_order");
    if (indErr || !indicators || indicators.length === 0) {
      return json({ error: indErr?.message ?? "no indicators" }, 500);
    }

    // Archive the pre-change state first, so the history chart shows the
    // composite as it stood right before this month's update.
    const preChange = computeAll(indicators as Indicator[]);
    const today = new Date().toISOString().slice(0, 10);
    const { error: snapErr } = await sb.from("china_watch_snapshots").insert({
      snapshot_date: today,
      ed: preChange.ED, wc: preChange.WC, pt: preChange.PT, er: preChange.ER, spi: preChange.spi,
      grayzone: preChange.grayzone, quarantine: preChange.quarantine, blockade: preChange.blockade, invasion: preChange.invasion,
    });
    if (snapErr) console.error("[china-watch] snapshot insert:", snapErr);

    const changes = await runClaude(indicators as Indicator[]);
    if (!changes) {
      await sb.from("china_watch_refresh_log").insert({
        summary: "Refresh failed — could not generate or parse assessment.",
        changes_json: [],
        status: "error",
      });
      return json({ error: "refresh generation failed" }, 500);
    }

    const byId = new Map((indicators as Indicator[]).map((i) => [i.id, i]));
    const applied: { id: string; name: string; oldScore: number; newScore: number; reason: string; sources: string[] }[] = [];
    const now = new Date().toISOString();

    for (const c of changes) {
      if (!c.changed) continue;
      const ind = byId.get(c.id);
      if (!ind || c.new_score == null || !c.new_confidence) continue;
      const clamped = Math.max(0, Math.min(10, Math.round(c.new_score)));
      const { error: updErr } = await sb.from("china_watch_indicators").update({
        score: clamped, confidence: c.new_confidence, note: c.new_note ?? ind.note, updated_at: now,
      }).eq("id", c.id);
      if (updErr) { console.error(`[china-watch] update ${c.id}:`, updErr); continue; }
      applied.push({ id: c.id, name: ind.name, oldScore: ind.score, newScore: clamped, reason: c.new_note ?? "", sources: c.sources ?? [] });
    }

    const status = applied.length > 0 ? "applied" : "no_changes";
    const summary = applied.length > 0
      ? `${applied.length} of ${indicators.length} indicators updated: ${applied.map((a) => `${a.name} ${a.oldScore}→${a.newScore}`).join("; ")}`
      : `No material changes found across ${indicators.length} indicators.`;
    await sb.from("china_watch_refresh_log").insert({ summary, changes_json: applied, status });

    const { data: freshIndicators } = await sb
      .from("china_watch_indicators")
      .select("id,pillar_id,pillar_name,pillar_group,name,description,score,confidence,note");
    const postChange = computeAll((freshIndicators ?? indicators) as Indicator[]);

    return json({ status, applied_count: applied.length, total: indicators.length, spi_before: preChange.spi, spi_after: postChange.spi, changes: applied });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
