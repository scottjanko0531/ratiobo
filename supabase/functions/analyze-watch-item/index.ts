import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CACHE_HOURS = 24;

interface WatchItem {
  symbol: string;
  name: string | null;
  asset_type: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function label(item: WatchItem): string {
  return item.name ? `${item.name} (${item.symbol})` : item.symbol;
}

function itemPrompt(item: WatchItem): string {
  return `You are a financial analyst producing a research note on a single security for an investor's watch list. Use web search to find current, verifiable data — recent quarterly/earnings results, current price, market cap, analyst targets. Do not rely on memorized figures; this must reflect the latest available information.

Security: ${label(item)}, asset type: "${item.asset_type}"

Write a structured markdown research note with these sections. Adapt section content sensibly if this isn't a traditional earnings-driven equity — e.g. for a cryptocurrency use market cap/supply/tokenomics instead of P/E, for a metal or physical commodity use supply-demand fundamentals instead of financials, for an ETF/fund use holdings/expense ratio/AUM instead of a balance sheet. Keep the section headers below even when adapting the content.

## ${label(item)}
One or two sentence positioning line — what it is and why it matters right now.

### Financials
Most recent quarter results, trailing-twelve-month figures, P/E or equivalent valuation metric, next earnings/catalyst date. Bullet points with specific numbers.

### Balance sheet
Cash, debt, net cash position (or the equivalent — reserves/collateral/AUM for non-equities). Bullet points.

### Business model / path to revenue
Current operations, strategy, roadmap, near-term catalysts. Bullet points.

### Price action & valuation
Current price, market cap, 52-week range, analyst consensus target if available, valuation commentary. Bullet points.

### Bottom line
One tight paragraph: synthesis and the single most important risk or thing to watch next.

### Sources
Numbered list of the actual sources you used (publication name and what it covered).

Be direct and specific with numbers — no vague qualifiers. Flag explicitly if a figure looks unusual or worth independent verification (e.g., a large one-time or non-cash item skewing a loss figure). Keep the whole note under 500 words excluding the Sources list. Do not include any preamble or meta-commentary before the note — your response must begin directly with the first "##" header.`;
}

function groupPrompt(listName: string, items: WatchItem[]): string {
  const roster = items.map((i) => `${i.symbol} (${label(i)}, ${i.asset_type})`).join(", ");
  return `You are a financial analyst producing a comparative research note across every security in an investor's watch list, for direct side-by-side comparison. Use web search to find current, verifiable data for EACH security — recent quarterly/earnings results, current price, market cap, analyst targets. Do not rely on memorized figures.

Watch list: "${listName}"
Securities (${items.length}): ${roster}

For each security, write a compact subsection: a "## {Name} ({SYMBOL})" header, a one-line positioning sentence, then brief Financials / Balance sheet (or equivalent for non-equities) / Business model / Price action bullets — tighter than a full deep dive, roughly 80-120 words per security.

Then add a "## Side by side" section with a markdown comparison table across the securities, using whichever dimensions are actually comparable given the asset types involved (e.g. market cap, TTM revenue, cash position, revenue/production stage, 52-week range, analyst coverage).

Then a "## Bottom line" section: one paragraph comparing relative risk/reward across the group and what to watch next for each.

Then a "## Sources" numbered list of the actual sources used across all securities.

Be direct and specific with numbers — no vague qualifiers. Flag explicitly if a figure looks unusual or worth independent verification. Keep each security's subsection tight; total length should scale with the number of securities but not balloon per-security. Do not include any preamble or meta-commentary before the note — your response must begin directly with the first "##" header.`;
}

function cleanupMarkdown(text: string): string {
  const headingIdx = text.indexOf("##");
  const body = headingIdx > 0 ? text.slice(headingIdx) : text;
  return body
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(-|\d+\.)\s*\n+\s*/gm, "$1 ")
    .trim();
}

async function runClaude(prompt: string, maxTokens: number): Promise<string | null> {
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
        max_tokens: maxTokens,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error("anthropic error", res.status, await res.text());
      return null;
    }
    const j = await res.json();
    const parts = (j.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text);
    const text = cleanupMarkdown(parts.join(""));
    return text || null;
  } catch (e) {
    console.error("runClaude failed", e);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { scope, watch_list_id, watch_list_item_id, force } = await req.json();
    if (scope !== "group" && scope !== "item") return json({ error: "scope must be 'group' or 'item'" }, 400);
    if (!watch_list_id) return json({ error: "watch_list_id required" }, 400);
    if (scope === "item" && !watch_list_item_id) return json({ error: "watch_list_item_id required for item scope" }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (!force) {
      let q = sb.from("watch_analysis").select("*").eq("watch_list_id", watch_list_id).eq("scope", scope);
      q = scope === "item" ? q.eq("watch_list_item_id", watch_list_item_id) : q.is("watch_list_item_id", null);
      const { data: cached } = await q.order("generated_at", { ascending: false }).limit(1).maybeSingle();
      if (cached) {
        const ageHours = (Date.now() - new Date(cached.generated_at).getTime()) / 3_600_000;
        if (ageHours < CACHE_HOURS) return json(cached);
      }
    }

    const { data: wl } = await sb.from("watch_lists").select("name").eq("id", watch_list_id).maybeSingle();
    if (!wl) return json({ error: "watch list not found" }, 404);

    let content: string | null;
    if (scope === "item") {
      const { data: item } = await sb
        .from("watch_list_items")
        .select("symbol,name,asset_type")
        .eq("id", watch_list_item_id)
        .maybeSingle();
      if (!item) return json({ error: "item not found" }, 404);
      content = await runClaude(itemPrompt(item as WatchItem), 3000);
    } else {
      const { data: items } = await sb
        .from("watch_list_items")
        .select("symbol,name,asset_type")
        .eq("watch_list_id", watch_list_id)
        .order("added_at");
      if (!items || items.length === 0) return json({ error: "watch list has no items" }, 400);
      const maxTokens = Math.min(2000 + items.length * 1200, 8000);
      content = await runClaude(groupPrompt(wl.name, items as WatchItem[]), maxTokens);
    }

    if (!content) return json({ error: "analysis generation failed" }, 500);

    const row = {
      watch_list_id,
      watch_list_item_id: scope === "item" ? watch_list_item_id : null,
      scope,
      content,
      generated_at: new Date().toISOString(),
    };
    const { data: inserted, error } = await sb.from("watch_analysis").insert(row).select().single();
    if (error) return json({ error: error.message }, 500);
    return json(inserted);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
