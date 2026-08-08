import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CACHE_HOURS = 24;              // company deep-dive + synthesis
const SECTOR_CACHE_DAYS = 30;        // sector dossier — structural, slow-moving
const ATLAS_CACHE_DAYS = 21;         // competitor atlas — moves a bit faster than sector structure

interface WatchItem {
  id: string;
  symbol: string;
  name: string | null;
  asset_type: string;
  sector: string | null;
  region: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function label(item: { symbol: string; name: string | null }): string {
  return item.name ? `${item.name} (${item.symbol})` : item.symbol;
}

function cleanupMarkdown(text: string): string {
  const headingIdx = text.indexOf("##");
  const body = headingIdx > 0 ? text.slice(headingIdx) : text;
  return body
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(-|\d+\.)\s*\n+\s*/gm, "$1 ")
    .trim();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function runClaude(
  prompt: string,
  maxTokens: number,
  opts: { webSearch: boolean; maxSearches?: number } = { webSearch: true },
): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const body: Record<string, unknown> = {
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts.webSearch) {
      body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxSearches ?? 12 }];
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
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

// ── Stage 0: classify sector + region (fast, no web search) ────────────────────
async function classify(item: WatchItem): Promise<{ sector: string; region: string } | null> {
  if (!ANTHROPIC_KEY) return null;
  const prompt = `Classify this security for research-organization purposes.

Security: ${label(item)}, asset type: "${item.asset_type}"

Respond with ONLY a raw JSON object, no markdown fences, no prose: {"sector": "...", "region": "..."}

"sector" — a specific, recognizable industry/category appropriate to the asset type (e.g. "Semiconductors", "Precious metals", "Cryptocurrency — Layer 1 blockchains", "Diversified US large-cap ETFs", "Integrated oil & gas").
"region" — the primary geographic market this security is exposed to (e.g. "United States", "Global", "China", "Emerging markets").`;
  const text = await runClaude(prompt, 200, { webSearch: false });
  if (!text) return null;
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed.sector !== "string" || typeof parsed.region !== "string") return null;
  return { sector: parsed.sector, region: parsed.region };
}

// ── Stage 1: sector dossier (shared across all items in the same sector+region) ─
function sectorDossierPrompt(sector: string, region: string): string {
  return `You are a research analyst producing an industry dossier.

INPUT
Sector: ${sector}
Region focus: ${region}

OBJECTIVE
Take a reader from zero to competent on ${sector}: its revenue model, growth drivers, cost structure and margins, constraints, regulation, peer benchmarks, and risks.

SOURCE PRIORITY
Filings and investor relations. Regulators and statistical bodies. Trade associations. Tier-one research with disclosed data. Never use SEO blogs or unsourced market-size estimates.

OUTPUT
Produce a one-page executive summary (as a "## Executive summary" section) followed by a full industry dossier (as a "## ${sector} — Industry Dossier" section with subsections) with compact comparison tables where useful. Cover: how the industry makes money, growth and margin drivers, regulation and constraints, true peer benchmarks, and main risks and tailwinds.

Be direct and specific with numbers — no vague qualifiers. Do not include any preamble before the note — begin directly with the first "##" header.`;
}

// ── Stage 2: competitor atlas (shared across all items in the same sector+region) ─
function playerAtlasPrompt(sector: string, region: string): string {
  return `You are a research analyst mapping competitive structure.

INPUT
Sector: ${sector}
Region focus: ${region}

OBJECTIVE
Identify the public and private players in ${sector}. Define the real competition lanes first — companies that actually compete for the same customers — then map the true peers within each lane. Flag companies that appear comparable but do not compete for the same customers.

OUTPUT
A) A 300-word executive overview (as "## Executive overview").
B) A "## Player Atlas" section with a subsection per major player covering: scope, products and services, customer types, why customers choose them, pricing model, moats and switching costs, vulnerabilities.
C) A "## Peer comparison" section with a normalized-KPI table per competition lane.
D) A "## Customer-choice narratives" section.
E) A "## Catalysts and regulatory changes to watch" section.

Be direct and specific with numbers — no vague qualifiers. Do not include any preamble before the note — begin directly with the first "##" header.`;
}

// ── Stage 3: company deep-dive ──────────────────────────────────────────────────
function companyDeepDivePrompt(item: WatchItem): string {
  return `You are preparing a full business-model analysis as if acquiring 100% of ${label(item)} (asset type: "${item.asset_type}"). Use web search for current, verifiable data — recent quarterly/earnings results, filings, investor presentations, peer filings, regulator data, high-signal industry research. Do not rely on memorized figures.

Adapt content sensibly if this isn't a traditional earnings-driven equity — e.g. for a cryptocurrency use market cap/supply/tokenomics instead of P/E, for a metal or physical commodity use supply-demand fundamentals instead of financials, for an ETF/fund use holdings/expense ratio/AUM instead of a balance sheet.

Cover, as numbered "##" sections:
1. Business understanding
2. Market and competitive position
3. Financial engine
4. Management and strategy
5. Peer comparison
6. Acquisition lens

For each important point, show the causal chain: Driver → Business impact → P&L or FCF effect (or the equivalent for non-equities). Include both a "## Bull case" and a "## Bear case" reading. No valuation. No price target.

Produce a structured investor memo of approximately 1,000 words, supported by compact tables. Be direct and specific with numbers. Do not include any preamble before the note — begin directly with the first "##" header.`;
}

// ── Stage 4: synthesis (closed-book — no web search, only the three saved docs) ─
function synthesisPrompt(item: WatchItem, sectorContent: string, atlasContent: string, companyContent: string): string {
  return `You are a senior equity analyst writing for long-term investors.

SOURCES — STRICT
Use only the three documents below. Do not search the web. Do not add outside knowledge. If a fact is not contained in these documents, write "Unclear." Synthesize across the documents rather than copying from them.

--- DOCUMENT 1: SECTOR DOSSIER ---
${sectorContent}

--- DOCUMENT 2: COMPETITOR ATLAS ---
${atlasContent}

--- DOCUMENT 3: COMPANY DEEP-DIVE (${label(item)}) ---
${companyContent}

OBJECTIVE
Write one qualitative investment report on ${label(item)} that connects the three documents, cross-checks their conclusions, and explicitly flags any contradictions between them.

STYLE
Use direct causal chains: Driver → Mechanism → Financial consequence. Make the report skimmable and evidence-based. Zero fluff. No DCF. No price targets.

OUTPUT — 600-900 words total, as "##" sections in this order:
## ${label(item)}
One or two sentence positioning line.
## Bull case
## Bear case
## Contradiction check
Where the sector, competitive, and company-level evidence disagree or create tension — or state "No material contradictions found."
## Bottom line
Synthesis and the single most important thing to watch next.

Do not include any preamble before the note — begin directly with the first "##" header.`;
}

async function getFreshRow(
  sb: ReturnType<typeof createClient>,
  table: string,
  match: Record<string, string>,
  maxAgeMs: number,
): Promise<{ content: string; generated_at: string } | null> {
  let q = sb.from(table).select("content,generated_at");
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const { data } = await q.order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const age = Date.now() - new Date(data.generated_at as string).getTime();
  return age < maxAgeMs ? (data as { content: string; generated_at: string }) : null;
}

// ── Group scope (unchanged) ─────────────────────────────────────────────────────
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { scope, watch_list_id, watch_list_item_id, force } = await req.json();
    if (scope !== "group" && scope !== "item") return json({ error: "scope must be 'group' or 'item'" }, 400);
    if (!watch_list_id) return json({ error: "watch_list_id required" }, 400);
    if (scope === "item" && !watch_list_item_id) return json({ error: "watch_list_item_id required for item scope" }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Group scope: single-shot, unchanged behavior ──────────────────────────
    if (scope === "group") {
      if (!force) {
        const { data: cached } = await sb
          .from("watch_analysis").select("*")
          .eq("watch_list_id", watch_list_id).eq("scope", "group")
          .is("watch_list_item_id", null)
          .order("generated_at", { ascending: false }).limit(1).maybeSingle();
        if (cached) {
          const ageHours = (Date.now() - new Date(cached.generated_at).getTime()) / 3_600_000;
          if (ageHours < CACHE_HOURS) return json(cached);
        }
      }
      const { data: wl } = await sb.from("watch_lists").select("name").eq("id", watch_list_id).maybeSingle();
      if (!wl) return json({ error: "watch list not found" }, 404);
      const { data: items } = await sb
        .from("watch_list_items").select("id,symbol,name,asset_type,sector,region")
        .eq("watch_list_id", watch_list_id).order("added_at");
      if (!items || items.length === 0) return json({ error: "watch list has no items" }, 400);
      const maxTokens = Math.min(2000 + items.length * 1200, 8000);
      const content = await runClaude(groupPrompt(wl.name, items as WatchItem[]), maxTokens, { webSearch: true });
      if (!content) return json({ error: "analysis generation failed" }, 500);
      const row = { watch_list_id, watch_list_item_id: null, scope: "group", content, generated_at: new Date().toISOString() };
      const { data: inserted, error } = await sb.from("watch_analysis").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json(inserted);
    }

    // ── Item scope: 4-stage pipeline, one stage generated per request ─────────
    const { data: itemRow } = await sb
      .from("watch_list_items").select("id,symbol,name,asset_type,sector,region")
      .eq("id", watch_list_item_id).maybeSingle();
    if (!itemRow) return json({ error: "item not found" }, 404);
    let item = itemRow as WatchItem;

    // Stage 0 — classify sector/region once, persist on the item.
    if (!item.sector || !item.region) {
      const cls = await classify(item);
      if (!cls) return json({ error: "sector classification failed" }, 500);
      await sb.from("watch_list_items").update({ sector: cls.sector, region: cls.region }).eq("id", item.id);
      item = { ...item, sector: cls.sector, region: cls.region };
    }
    const sector = item.sector as string;
    const region = item.region as string;

    // Stage 1 — sector dossier (shared cache).
    let sectorRow = await getFreshRow(sb, "sector_dossiers", { sector, region }, SECTOR_CACHE_DAYS * 86_400_000);
    if (!sectorRow) {
      const content = await runClaude(sectorDossierPrompt(sector, region), 3000, { webSearch: true });
      if (!content) return json({ error: "sector research failed" }, 500);
      const generated_at = new Date().toISOString();
      await sb.from("sector_dossiers").insert({ sector, region, content, generated_at });
      return json({ stage: "sector", label: `Researched the ${sector} sector`, done: false });
    }

    // Stage 2 — competitor atlas (shared cache).
    let atlasRow = await getFreshRow(sb, "sector_player_atlases", { sector, region }, ATLAS_CACHE_DAYS * 86_400_000);
    if (!atlasRow) {
      const content = await runClaude(playerAtlasPrompt(sector, region), 3000, { webSearch: true });
      if (!content) return json({ error: "competitor mapping failed" }, 500);
      const generated_at = new Date().toISOString();
      await sb.from("sector_player_atlases").insert({ sector, region, content, generated_at });
      return json({ stage: "atlas", label: `Mapped ${sector} competitors`, done: false });
    }

    // Stage 3 — company deep-dive (per item, force-able).
    let companyRow = force ? null : await getFreshRow(sb, "watch_item_deep_dives", { watch_list_item_id }, CACHE_HOURS * 3_600_000);
    if (!companyRow) {
      const content = await runClaude(companyDeepDivePrompt(item), 3000, { webSearch: true });
      if (!content) return json({ error: "company research failed" }, 500);
      const generated_at = new Date().toISOString();
      await sb.from("watch_item_deep_dives").insert({ watch_list_item_id, content, generated_at });
      return json({ stage: "company", label: `Analyzed ${label(item)}`, done: false });
    }

    // Stage 4 — synthesis (closed-book). Regenerate if forced, stale, or any input stage is newer.
    const newestInput = Math.max(
      new Date(sectorRow.generated_at).getTime(),
      new Date(atlasRow.generated_at).getTime(),
      new Date(companyRow.generated_at).getTime(),
    );
    if (!force) {
      const { data: cached } = await sb
        .from("watch_analysis").select("*")
        .eq("watch_list_id", watch_list_id).eq("scope", "item").eq("watch_list_item_id", watch_list_item_id)
        .order("generated_at", { ascending: false }).limit(1).maybeSingle();
      if (cached) {
        const ageMs = Date.now() - new Date(cached.generated_at).getTime();
        const cacheTime = new Date(cached.generated_at).getTime();
        if (ageMs < CACHE_HOURS * 3_600_000 && cacheTime >= newestInput) {
          return json({ ...cached, stage: "synthesis", done: true });
        }
      }
    }
    const content = await runClaude(
      synthesisPrompt(item, sectorRow.content, atlasRow.content, companyRow.content),
      2000,
      { webSearch: false },
    );
    if (!content) return json({ error: "synthesis failed" }, 500);
    const row = { watch_list_id, watch_list_item_id, scope: "item", content, generated_at: new Date().toISOString() };
    const { data: inserted, error } = await sb.from("watch_analysis").insert(row).select().single();
    if (error) return json({ error: error.message }, 500);
    return json({ ...inserted, stage: "synthesis", done: true });

  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
