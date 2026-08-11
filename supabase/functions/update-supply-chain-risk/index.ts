import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Item {
  id: string;
  key: string;
  name: string;
  category: string;
  china_exposed: boolean;
}

interface ChinaWatchRead {
  spi: number;
  blockade: number;
  invasion: number;
  bandLabel: string;
  adjustment: number; // 0-15, derived from blockade+invasion probability
}

// Mirrors lib/chinaWatchScoring.js — kept in lockstep with update-china-watch's
// own copy of this math. Computed live here (not read from the last monthly
// snapshot) so a manual indicator edit in the China Watch UI propagates to
// today's supply-chain scores immediately, not just after the next monthly run.
function computeChinaWatch(indicators: { pillar_group: string; pillar_id: string; score: number }[]): ChinaWatchRead | null {
  if (!indicators.length) return null;
  const pillarAvg = (scores: number[]) => scores.reduce((a, b) => a + b, 0) / scores.length;
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
  const total = base[0] + base[1] + blockade + invasion;
  const blockadePct = (blockade / total) * 100, invasionPct = (invasion / total) * 100;
  const bandLabel = spi < 35 ? "Low pressure" : spi < 60 ? "Moderate pressure" : spi < 80 ? "Elevated pressure" : "Severe pressure";
  const adjustment = Math.min(15, Math.round((blockadePct + invasionPct) / 5));
  return { spi: Math.round(spi * 10) / 10, blockade: Math.round(blockadePct * 10) / 10, invasion: Math.round(invasionPct * 10) / 10, bandLabel, adjustment };
}

interface Assessment {
  key: string;
  risk_score: number;
  status: "critical" | "watch" | "healthy";
  trend: "worsening" | "stable" | "improving";
  risk_type: "active" | "structural";
  summary: string;
  concentration: string;
  primary_threat: string;
  alternatives: string;
  recent_signal: string;
  source_note: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function buildPrompt(items: Item[], chinaWatch: ChinaWatchRead | null): string {
  const roster = items
    .map((i) => `${i.key}: ${i.name} — ${i.category}${i.china_exposed ? " [CHINA-EXPOSED]" : ""}`)
    .join("\n");
  const chinaWatchNote = chinaWatch && items.some((i) => i.china_exposed)
    ? `\n\nItems marked [CHINA-EXPOSED] are also tracked against RatioBo's China Watch model, currently reading: Structural Pressure Index ${chinaWatch.spi}/100 (${chinaWatch.bandLabel}), Taiwan scenario odds — blockade ${chinaWatch.blockade}%, invasion ${chinaWatch.invasion}%. For these items only, explicitly weigh this China/Taiwan structural-risk backdrop in your assessment (concentration/primary_threat/summary should reference it where relevant) — a China-Taiwan crisis would directly disrupt these specific chokepoints. Do not mention China Watch for items not marked [CHINA-EXPOSED].`
    : "";
  return `You are a supply-chain risk analyst updating a daily-tracked dashboard. Use web search to find CURRENT information (recent weeks/months, not stale memorized facts) for each of these ${items.length} tracked risk items.

Items to assess:
${roster}${chinaWatchNote}

For EACH item, research: how concentrated the supply is in a single country/company/chokepoint, the primary threat right now, viable alternatives, and any recent (last few weeks) news signal.

Also classify each item's "risk_type":
- "active": there is a confirmed, currently-in-progress disruption (e.g. a closed strait, an enforced export ban, a live blockade) — something you can point to specific recent evidence for, happening right now, not merely plausible.
- "structural": the concentration/vulnerability is real and elevated but there is no active triggering event in progress right now — it's a standing, thesis-driven tail risk, not a live crisis.
Do not default to "active" just because a risk is severe — a severe risk with no live triggering event is still "structural."

Return an object per item with these exact fields:
- "key": the exact key given above, unchanged
- "risk_score": integer 0-100 (0 = no risk, 100 = acute crisis). Critical >= 75, Watch 35-74, Healthy < 35.
- "status": "critical" | "watch" | "healthy" — must match the risk_score threshold above
- "trend": "worsening" | "stable" | "improving" — direction over the last 1-3 months
- "risk_type": "active" | "structural" — per the definitions above
- "summary": one tight sentence, under 25 words, specific and current
- "concentration": one short phrase with a real number/percentage
- "primary_threat": one short phrase naming the specific risk
- "alternatives": one short phrase on what mitigates this, if anything
- "recent_signal": one short phrase citing a specific recent development
- "source_note": one short phrase naming what kind of source grounds this assessment (e.g. "Reuters shipping-transit reporting", "IMF/WTO export-control filings", "company earnings + trade press") — be specific about source type, not just "web search"

Respond with ONLY a raw JSON array of ${items.length} objects, one per item above, in the same order given. No markdown code fences, no prose before or after, no trailing commas.`;
}

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function runClaude(items: Item[], chinaWatch: ChinaWatchRead | null): Promise<Assessment[] | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 24 }],
        messages: [{ role: "user", content: buildPrompt(items, chinaWatch) }],
      }),
    });
    if (!res.ok) {
      console.error("anthropic error", res.status, await res.text());
      return null;
    }
    const j = await res.json();
    const text = (j.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    const parsed = extractJsonArray(text);
    if (!parsed) {
      console.error("[supply-chain] could not parse JSON from response:", text.slice(0, 500));
      return null;
    }
    return parsed as Assessment[];
  } catch (e) {
    console.error("runClaude failed", e);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: items, error: itemsErr } = await sb
      .from("supply_chain_items")
      .select("id, key, name, category, china_exposed")
      .eq("is_active", true)
      .order("sort_order");
    if (itemsErr || !items || items.length === 0) {
      return json({ error: itemsErr?.message ?? "no active items" }, 500);
    }

    const { data: chinaWatchIndicators } = await sb
      .from("china_watch_indicators")
      .select("pillar_id,pillar_group,score");
    const chinaWatch = computeChinaWatch((chinaWatchIndicators ?? []) as { pillar_group: string; pillar_id: string; score: number }[]);

    const assessments = await runClaude(items as Item[], chinaWatch);
    if (!assessments) return json({ error: "assessment generation failed" }, 500);

    const byKey = new Map((items as Item[]).map((i) => [i.key, i]));
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const STATUS_THRESHOLDS = (score: number): Assessment["status"] =>
      score >= 75 ? "critical" : score >= 35 ? "watch" : "healthy";

    let updated = 0;
    const skipped: string[] = [];
    for (const a of assessments) {
      const item = byKey.get(a.key);
      if (!item || a.risk_score == null || !a.status) { skipped.push(a.key ?? "unknown"); continue; }

      // China-exposed items get a bounded score bump tied to China Watch's current
      // Taiwan blockade+invasion probability, then status is re-derived so it stays
      // consistent with the displayed (adjusted) score rather than Claude's base one.
      const applyAdjustment = item.china_exposed && chinaWatch;
      const finalScore = applyAdjustment ? Math.max(0, Math.min(100, a.risk_score + chinaWatch!.adjustment)) : a.risk_score;
      const finalStatus = applyAdjustment ? STATUS_THRESHOLDS(finalScore) : a.status;
      const cwAdjustment = applyAdjustment ? chinaWatch!.adjustment : null;
      const cwSpi = applyAdjustment ? chinaWatch!.spi : null;

      const { error: updErr } = await sb.from("supply_chain_items").update({
        current_score: finalScore, current_status: finalStatus, current_trend: a.trend ?? null,
        summary: a.summary ?? null, concentration: a.concentration ?? null,
        primary_threat: a.primary_threat ?? null, alternatives: a.alternatives ?? null,
        recent_signal: a.recent_signal ?? null, updated_at: now,
        china_watch_adjustment: cwAdjustment, china_watch_spi: cwSpi,
        risk_type: a.risk_type ?? null, source_note: a.source_note ?? null,
      }).eq("id", item.id);
      if (updErr) { console.error(`[supply-chain] update ${a.key}:`, updErr); skipped.push(a.key); continue; }

      const { error: snapErr } = await sb.from("supply_chain_snapshots").upsert({
        item_id: item.id, snapshot_date: today, score: finalScore, status: finalStatus, trend: a.trend ?? null,
        summary: a.summary ?? null, concentration: a.concentration ?? null,
        primary_threat: a.primary_threat ?? null, alternatives: a.alternatives ?? null,
        recent_signal: a.recent_signal ?? null,
        china_watch_adjustment: cwAdjustment, china_watch_spi: cwSpi,
        risk_type: a.risk_type ?? null, source_note: a.source_note ?? null,
      }, { onConflict: "item_id,snapshot_date" });
      if (snapErr) { console.error(`[supply-chain] snapshot ${a.key}:`, snapErr); continue; }

      updated++;
    }

    return json({ updated, skipped, total: items.length, timestamp: now });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
