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
}

interface Assessment {
  key: string;
  risk_score: number;
  status: "critical" | "watch" | "healthy";
  trend: "worsening" | "stable" | "improving";
  summary: string;
  concentration: string;
  primary_threat: string;
  alternatives: string;
  recent_signal: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function buildPrompt(items: Item[]): string {
  const roster = items.map((i) => `${i.key}: ${i.name} — ${i.category}`).join("\n");
  return `You are a supply-chain risk analyst updating a daily-tracked dashboard. Use web search to find CURRENT information (recent weeks/months, not stale memorized facts) for each of these ${items.length} tracked risk items.

Items to assess:
${roster}

For EACH item, research: how concentrated the supply is in a single country/company/chokepoint, the primary threat right now, viable alternatives, and any recent (last few weeks) news signal.

Return an object per item with these exact fields:
- "key": the exact key given above, unchanged
- "risk_score": integer 0-100 (0 = no risk, 100 = acute crisis). Critical >= 75, Watch 35-74, Healthy < 35.
- "status": "critical" | "watch" | "healthy" — must match the risk_score threshold above
- "trend": "worsening" | "stable" | "improving" — direction over the last 1-3 months
- "summary": one tight sentence, under 25 words, specific and current
- "concentration": one short phrase with a real number/percentage
- "primary_threat": one short phrase naming the specific risk
- "alternatives": one short phrase on what mitigates this, if anything
- "recent_signal": one short phrase citing a specific recent development

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

async function runClaude(items: Item[]): Promise<Assessment[] | null> {
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
        messages: [{ role: "user", content: buildPrompt(items) }],
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
      .select("id, key, name, category")
      .eq("is_active", true)
      .order("sort_order");
    if (itemsErr || !items || items.length === 0) {
      return json({ error: itemsErr?.message ?? "no active items" }, 500);
    }

    const assessments = await runClaude(items as Item[]);
    if (!assessments) return json({ error: "assessment generation failed" }, 500);

    const byKey = new Map((items as Item[]).map((i) => [i.key, i]));
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    let updated = 0;
    const skipped: string[] = [];
    for (const a of assessments) {
      const item = byKey.get(a.key);
      if (!item || a.risk_score == null || !a.status) { skipped.push(a.key ?? "unknown"); continue; }

      const { error: updErr } = await sb.from("supply_chain_items").update({
        current_score: a.risk_score, current_status: a.status, current_trend: a.trend ?? null,
        summary: a.summary ?? null, concentration: a.concentration ?? null,
        primary_threat: a.primary_threat ?? null, alternatives: a.alternatives ?? null,
        recent_signal: a.recent_signal ?? null, updated_at: now,
      }).eq("id", item.id);
      if (updErr) { console.error(`[supply-chain] update ${a.key}:`, updErr); skipped.push(a.key); continue; }

      const { error: snapErr } = await sb.from("supply_chain_snapshots").upsert({
        item_id: item.id, snapshot_date: today, score: a.risk_score, status: a.status, trend: a.trend ?? null,
        summary: a.summary ?? null, concentration: a.concentration ?? null,
        primary_threat: a.primary_threat ?? null, alternatives: a.alternatives ?? null,
        recent_signal: a.recent_signal ?? null,
      }, { onConflict: "item_id,snapshot_date" });
      if (snapErr) { console.error(`[supply-chain] snapshot ${a.key}:`, snapErr); continue; }

      updated++;
    }

    return json({ updated, skipped, total: items.length, timestamp: now });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
