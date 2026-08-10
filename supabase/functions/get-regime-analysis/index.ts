import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REGIME_LABELS: Record<string, string> = {
  rg_fi: "Disinflationary Boom",
  rg_ri: "Reflation",
  fg_ri: "Stagflation",
  fg_fi: "Deflationary Bust",
};

interface MarketTick { name: string; price: number; changePct: number; }
interface NewsItem { headline: string; source: string; publishedAt: number; }
interface SupplyChainRisk {
  name: string; category: string; score: number; status: string; trend: string;
  primaryThreat: string | null; concentration: string | null;
}

// ── News helpers (same RSS approach as get-macro-news) ────────────────────────
function getText(block: string, tag: string): string {
  const open = "<" + tag;
  const close = "</" + tag + ">";
  const start = block.indexOf(open);
  if (start === -1) return "";
  const gt = block.indexOf(">", start);
  if (gt === -1) return "";
  const end = block.indexOf(close, gt);
  if (end === -1) return "";
  return block.slice(gt + 1, end).trim();
}
function getSource(block: string): string {
  const start = block.indexOf("<source");
  if (start === -1) return "";
  const gt = block.indexOf(">", start);
  if (gt === -1) return "";
  const end = block.indexOf("</source>", gt);
  if (end === -1) return "";
  return block.slice(gt + 1, end).trim();
}
function cleanTitle(title: string, source: string): string {
  const suffix = " - " + source;
  return source && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}
function stripMarkdown(text: string, opts: { allowBullets?: boolean } = {}): string {
  let out = text
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1");
  if (!opts.allowBullets) out = out.replace(/^[-*]\s+/gm, "");
  else out = out.replace(/^\*\s+/gm, "- "); // normalize "* " bullets to "- "
  return out.trim();
}

async function fetchMacroVoices(): Promise<NewsItem | null> {
  const urls = [
    "https://www.macrovoices.com/feed/podcast",
    "https://www.macrovoices.com/feed",
  ];
  for (const feedUrl of urls) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const s = xml.indexOf("<item>");
      if (s === -1) continue;
      const e = xml.indexOf("</item>", s);
      if (e === -1) continue;
      const block = xml.slice(s + 6, e);
      const title = getText(block, "title");
      if (!title) continue;
      const pubDate = getText(block, "pubDate");
      let sub = getText(block, "itunes:subtitle") || getText(block, "description") || "";
      sub = sub.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").slice(0, 140).trim();
      const headline = sub ? `${title} — ${sub}` : title;
      const ts = pubDate ? new Date(pubDate).getTime() : 0;
      return { headline, source: "MacroVoices", publishedAt: isNaN(ts) ? 0 : Math.floor(ts / 1000) };
    } catch { continue; }
  }
  return null;
}

async function fetchTopNews(limit = 5): Promise<NewsItem[]> {
  const queries = [
    "Federal Reserve inflation interest rates",
    "GDP economic growth recession",
    "CPI inflation consumer prices",
    "gold oil commodities macro economy",
    "Treasury bonds yield curve",
  ];
  try {
    const results = await Promise.all(queries.map(async (q) => {
      const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)" } });
      if (!res.ok) return [] as NewsItem[];
      const xml = await res.text();
      const items: NewsItem[] = [];
      let pos = 0;
      while (true) {
        const s = xml.indexOf("<item>", pos);
        if (s === -1) break;
        const e = xml.indexOf("</item>", s);
        if (e === -1) break;
        const block = xml.slice(s + 6, e);
        pos = e + 7;
        const raw = getText(block, "title");
        const pubDate = getText(block, "pubDate");
        const source = getSource(block);
        if (!raw) continue;
        const ts = pubDate ? new Date(pubDate).getTime() : 0;
        items.push({ headline: cleanTitle(raw, source), source, publishedAt: isNaN(ts) ? 0 : Math.floor(ts / 1000) });
      }
      return items;
    }));
    const seen = new Set<string>();
    const all: NewsItem[] = [];
    for (const items of results) {
      for (const item of items) {
        if (!seen.has(item.headline)) { seen.add(item.headline); all.push(item); }
      }
    }
    return all.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, limit);
  } catch { return []; }
}

// ── Market snapshot ───────────────────────────────────────────────────────────
async function getMarketSnapshot(): Promise<MarketTick[]> {
  const tickers = [
    { key: "SPY",    name: "S&P 500"       },
    { key: "QQQ",    name: "Nasdaq 100"    },
    { key: "IWM",    name: "Russell 2000"  },
    { key: "GLD",    name: "Gold"          },
    { key: "CL%3DF", name: "WTI Oil"       },
    { key: "TLT",    name: "20Y Treasuries"},
    { key: "%5EVIX", name: "VIX"           },
    { key: "DX-Y.NYB", name: "DXY"        },
  ];
  const results = await Promise.all(tickers.map(async ({ key, name }) => {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${key}?interval=1d&range=5d`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" } }
      );
      if (!res.ok) return null;
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
      const valid = closes.filter((v): v is number => v != null);
      if (valid.length < 2) return null;
      const price = valid[valid.length - 1];
      const prev  = valid[valid.length - 2];
      return { name, price, changePct: ((price - prev) / prev) * 100 } satisfies MarketTick;
    } catch { return null; }
  }));
  return results.filter((r): r is MarketTick => r !== null);
}

// ── Supply chain risk snapshot ──────────────────────────────────────────────────
async function getSupplyChainRisks(sb: ReturnType<typeof createClient>): Promise<SupplyChainRisk[]> {
  const { data } = await sb
    .from("supply_chain_items")
    .select("name,category,current_score,current_status,current_trend,primary_threat,concentration")
    .eq("is_active", true)
    .order("current_score", { ascending: false });
  return (data ?? [])
    .filter((r: { current_score: number | null }) => r.current_score != null)
    .map((r: {
      name: string; category: string; current_score: number; current_status: string;
      current_trend: string | null; primary_threat: string | null; concentration: string | null;
    }) => ({
      name: r.name, category: r.category, score: r.current_score,
      status: r.current_status, trend: r.current_trend ?? "stable",
      primaryThreat: r.primary_threat, concentration: r.concentration,
    }));
}

// ── Main regime analysis ──────────────────────────────────────────────────────
async function generateAnalysis(params: {
  regimeLabel: string; marketLabel: string | null; fwdLabel: string | null;
  fwdConf: number | null; divergence: boolean;
  gdp: number | null; cpi: number | null; ppi: number | null; t10y2y: number | null;
  lei: number | null; breakeven: number | null;
  prevGdp: number | null; prevCpi: number | null; prevPpi: number | null;
  prevLei: number | null; prevBe: number | null;
  marketSnapshot: MarketTick[];
  supplyChain: SupplyChainRisk[];
}): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const {
      regimeLabel, marketLabel, fwdLabel, fwdConf, divergence,
      gdp, cpi, ppi, t10y2y, lei, breakeven,
      prevGdp, prevCpi, prevPpi, prevLei, prevBe,
      marketSnapshot, supplyChain,
    } = params;

    const mktLines = marketSnapshot
      .map(m => `${m.name}: ${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(1)}%`)
      .join(" | ");
    const scLines = supplyChain
      .filter(s => s.status === "critical" || s.trend === "worsening")
      .slice(0, 6)
      .map(s => `  ${s.score} ${s.status.toUpperCase()}/${s.trend} — ${s.name} (${s.category})${s.primaryThreat ? `: ${s.primaryThreat}` : ""}`)
      .join("\n");
    const n = (v: number | null, d = 1, plus = false) =>
      v != null ? `${plus && v >= 0 ? "+" : ""}${v.toFixed(d)}%` : "n/a";
    const delta = (curr: number | null, prev: number | null) => {
      if (curr == null || prev == null) return "";
      const d = curr - prev;
      return ` (${d >= 0 ? "+" : ""}${d.toFixed(2)} vs prior)`;
    };
    const arrow = (curr: number | null, prev: number | null, threshold = 0.05) => {
      if (curr == null || prev == null) return "→";
      return curr > prev + threshold ? "↑" : curr < prev - threshold ? "↓" : "→";
    };

    const gdpUp  = gdp != null && prevGdp != null && gdp > prevGdp + 0.05;
    const inflUp = cpi != null && prevCpi != null && cpi > prevCpi + 0.05;
    const momentumRegime =
       gdpUp && inflUp  ? "Reflation" :
       gdpUp && !inflUp ? "Disinflationary Boom" :
      !gdpUp && inflUp  ? "Stagflation" : "Deflationary Bust";
    const momentumDiverges = momentumRegime !== regimeLabel;

    const prompt = `You are Clio, macro analyst at RatioBo, using the Dalio/Bridgewater four-quadrant framework. Write direct, sharp analysis — no hedging language, no fluff, under 400 words total. No markdown headers, no bold, no title line.

PORTFOLIO FRAMEWORK — BW Modified (structural base, always held):
  US Equities 20% · International 8% · EM 5% · Nominal Bonds 20% · TIPS 20% · Commodities 12% · Gold 12% · Cash 3%
  Rationale: Bridgewater's 2025–2026 thesis holds that the old paradigm (US-heavy, equity-heavy, long nominal bonds) is broken. Modern mercantilism, AI-driven commodity demand, and CB gold accumulation create structural bids for real assets regardless of the cyclical quadrant. BW Modified is the resilient base. Regime-specific tilts are overlays on top of it, only when the signal is unambiguous.

You have four signals that may conflict. Reconcile all four explicitly.

SIGNAL 1 — Structural regime (level-based, 3Y trailing averages):
  ${regimeLabel}

SIGNAL 2 — Structural momentum (direction of hard data, 15–60 day lag):
  GDP:      ${n(gdp, 2, true)}${delta(gdp, prevGdp)} ${arrow(gdp, prevGdp)}
  CPI:      ${n(cpi, 2)}${delta(cpi, prevCpi)} ${arrow(cpi, prevCpi)}
  PPI:      ${n(ppi, 2, true)}${delta(ppi, prevPpi)} ${arrow(ppi, prevPpi)}
  10Y BE:   ${n(breakeven, 2)}${delta(breakeven, prevBe)} ${arrow(breakeven, prevBe, 0.02)}
  LEI:      ${n(lei, 2, true)}${delta(lei, prevLei)} ${arrow(lei, prevLei)}
  2/10 spread: ${n(t10y2y, 2, true)}
  Momentum-implied regime: ${momentumRegime}${momentumDiverges ? ` ⚑ diverges from structural ${regimeLabel}` : " ✓ aligns"}

SIGNAL 3 — Market pricing (yesterday's action, forward-looking):
  Market-implied regime: ${marketLabel ?? "unknown"}
  ${divergence ? `⚑ Market diverges from structural regime` : "✓ Market aligns with structural regime"}
  Forward signal: ${fwdLabel ?? "none"}${fwdConf != null ? ` (${fwdConf}% confidence)` : ""}
  ${mktLines}

SIGNAL 4 — Supply chain / structural tail risk (12 tracked chokepoints, daily AI+web-search scored, 0–100):
${scLines || "  No critical or worsening chokepoints currently flagged."}

Structure your answer in four parts, separated by blank lines:
(1) A paragraph: what is the hard data momentum telling us — is the structural regime transitioning, and how confident should we be?
(2) A paragraph: is yesterday's market action consistent with that momentum signal, or pricing a different scenario?
(3) A paragraph: what does the supply chain signal confirm or complicate — does it corroborate the BW Modified real-assets sleeve (gold/commodities/TIPS), and is any specific chokepoint above a live tail risk for a sector or asset class in the portfolio?
(4) A "Concrete moves:" section: one short lead-in sentence, then 3-6 bullet points (each on its own line, starting with "- "), each one specific, actionable sentence naming a real instrument or asset class and what to do with it — not just "hold the base." Split opportunities and hedges across the bullets as the analysis warrants, rather than writing separate paragraphs for each.

Parts 1-3 must be plain prose — no bullets, no bold, no headers. Part 4 must be lead-in sentence + bullets only, no bold, no headers.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1100,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.content?.[0]?.text as string | undefined) ?? null;
    return raw ? stripMarkdown(raw, { allowBullets: true }) : null;
  } catch { return null; }
}

// ── News musing ───────────────────────────────────────────────────────────────
async function generateNewsMusing(params: {
  headlines: NewsItem[];
  regimeLabel: string;
  momentumRegime: string;
  marketLabel: string | null;
}): Promise<string | null> {
  if (!ANTHROPIC_KEY || params.headlines.length === 0) return null;
  try {
    const { headlines, regimeLabel, momentumRegime, marketLabel } = params;
    const mvEpisode = headlines.find(h => h.source === "MacroVoices");
    const newsLines = headlines
      .map((h, i) => `${i + 1}. "${h.headline}"${h.source ? ` — ${h.source}` : ""}`)
      .join("\n");

    const mvInstruction = mvEpisode
      ? `\nThe first item is the most recent MacroVoices podcast episode. Briefly note what it covers and how it informs the macro picture.`
      : "";

    const prompt = `You are Clio, macro analyst at RatioBo. Write 2 sharp paragraphs (under 180 words total), plain prose only. Do not use any markdown syntax: no #, no **, no bullet or numbered lists, no title line.

Current regime signals:
  Structural: ${regimeLabel}
  Momentum-implied: ${momentumRegime}
  Market-implied: ${marketLabel ?? "unknown"}

Top macro headlines (last 24–48 hours):
${newsLines}
${mvInstruction}
Assess: (1) What macro narrative are these headlines collectively signaling — growth, inflation, credit stress, risk-on, or risk-off? (2) Does that narrative align with or diverge from the regime signals above, and what (if anything) should a BW Modified portfolio holder do differently in response?`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.content?.[0]?.text as string | undefined) ?? null;
    return raw ? stripMarkdown(raw) : null;
  } catch { return null; }
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get("refresh") === "true";
    const today = new Date().toISOString().slice(0, 10);

    if (!forceRefresh) {
      const { data: cached } = await sb
        .from("dalio_regime_analysis")
        .select("*")
        .eq("analysis_date", today)
        .maybeSingle();
      if (cached) {
        return new Response(JSON.stringify(cached), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
    }

    const [{ data: regimeRow }, { data: macroRows }, marketSnapshot, topNews, mvItem, supplyChain] = await Promise.all([
      sb.from("macro_regime_history")
        .select("structural_key,market_key,forward_key,forward_confidence")
        .order("period_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb.from("macro_indicators").select("name,current_value,previous_value"),
      getMarketSnapshot(),
      fetchTopNews(5),
      fetchMacroVoices(),
      getSupplyChainRisks(sb),
    ]);
    const headlines: NewsItem[] = mvItem ? [mvItem, ...topNews] : topNews;

    const get = (name: string) => {
      const i = (macroRows ?? []).find((x: { name: string; current_value: number | null }) => x.name === name);
      return i?.current_value != null ? Number(i.current_value) : null;
    };
    const getPrev = (name: string) => {
      const i = (macroRows ?? []).find((x: { name: string; previous_value: number | null }) => x.name === name);
      return i?.previous_value != null ? Number(i.previous_value) : null;
    };

    const structuralKey = regimeRow?.structural_key ?? null;
    const marketKey = regimeRow?.market_key ?? null;
    const fwdKey = regimeRow?.forward_key ?? null;
    const regimeLabel = structuralKey ? (REGIME_LABELS[structuralKey] ?? structuralKey) : "Unknown";
    const marketLabel = marketKey ? (REGIME_LABELS[marketKey] ?? marketKey) : null;
    const fwdLabel = fwdKey ? (REGIME_LABELS[fwdKey] ?? fwdKey) : null;
    const divergence = !!(structuralKey && marketKey && structuralKey !== marketKey);

    const gdp     = get("Real GDP Growth");
    const prevGdp = getPrev("Real GDP Growth");
    const cpi     = get("CPI (YoY)");
    const prevCpi = getPrev("CPI (YoY)");

    const gdpUp  = gdp != null && prevGdp != null && gdp > prevGdp + 0.05;
    const inflUp = cpi != null && prevCpi != null && cpi > prevCpi + 0.05;
    const momentumRegime =
       gdpUp && inflUp  ? "Reflation" :
       gdpUp && !inflUp ? "Disinflationary Boom" :
      !gdpUp && inflUp  ? "Stagflation" : "Deflationary Bust";

    const [analysis, newsMusing] = await Promise.all([
      generateAnalysis({
        regimeLabel, marketLabel, fwdLabel,
        fwdConf: regimeRow?.forward_confidence ?? null,
        divergence,
        gdp,
        cpi,
        ppi:       get("PPI (YoY)"),
        t10y2y:    get("2yr/10yr Yield Spread"),
        lei:       get("Conference Board LEI"),
        breakeven: get("10Y Breakeven Inflation"),
        prevGdp,
        prevCpi,
        prevPpi:   getPrev("PPI (YoY)"),
        prevLei:   getPrev("Conference Board LEI"),
        prevBe:    getPrev("10Y Breakeven Inflation"),
        marketSnapshot,
        supplyChain,
      }),
      generateNewsMusing({ headlines, regimeLabel, momentumRegime, marketLabel }),
    ]);

    if (!analysis) {
      return new Response(JSON.stringify({ error: "Analysis generation failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const row = {
      analysis_date: today,
      analysis,
      news_musing: newsMusing ?? null,
      news_headlines: headlines.length > 0 ? headlines : null,
      alignment: divergence ? "divergent" : "aligned",
      structural_regime: regimeLabel,
      market_regime: marketLabel,
      market_snapshot: marketSnapshot,
      generated_at: new Date().toISOString(),
    };

    await sb.from("dalio_regime_analysis").upsert(row, { onConflict: "analysis_date" });

    return new Response(JSON.stringify(row), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
