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

async function getMarketSnapshot(): Promise<MarketTick[]> {
  const tickers = [
    { key: "SPY",    name: "S&P 500"       },
    { key: "QQQ",    name: "Nasdaq 100"    },
    { key: "IWM",    name: "Russell 2000"  },
    { key: "GLD",    name: "Gold"          },
    { key: "CL%3DF", name: "WTI Oil"       },
    { key: "TLT",    name: "20Y Treasuries"},
    { key: "%5EVIX", name: "VIX"           },
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

async function generateAnalysis(params: {
  regimeLabel: string; marketLabel: string | null; fwdLabel: string | null;
  fwdConf: number | null; divergence: boolean;
  gdp: number | null; cpi: number | null; ppi: number | null; t10y2y: number | null;
  marketSnapshot: MarketTick[];
}): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const { regimeLabel, marketLabel, fwdLabel, fwdConf, divergence, gdp, cpi, ppi, t10y2y, marketSnapshot } = params;
    const mktLines = marketSnapshot
      .map(m => `${m.name}: ${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(1)}%`)
      .join(" | ");
    const n = (v: number | null, d = 1, plus = false) =>
      v != null ? `${plus && v >= 0 ? "+" : ""}${v.toFixed(d)}%` : "n/a";

    const prompt = `You are a macro analyst at RatioBo using the Dalio/Bridgewater four-quadrant framework. Write direct, sharp analysis — no hedging, no fluff, no headers, no bullet points. Plain prose, 3–4 paragraphs, under 230 words.

Framework reading:
  Structural regime: ${regimeLabel}
  Market-implied regime: ${marketLabel ?? "unknown"}
  Forward signal: ${fwdLabel ?? "none"}${fwdConf != null ? ` (${fwdConf}% confidence)` : ""}
  ${divergence ? `⚑ Divergence: structural (${regimeLabel}) vs market-implied (${marketLabel})` : `Regimes aligned: ${regimeLabel}`}

Macro data: GDP ${n(gdp, 1, true)} | CPI ${n(cpi)} | PPI ${n(ppi, 1, true)} | 2/10 spread ${n(t10y2y, 2, true)}

Yesterday's market: ${mktLines}

Assess in 3–4 paragraphs: Is yesterday's market action consistent with ${regimeLabel}, or does it signal regime stress? What might the market be pricing that this structural framework doesn't yet reflect? What does this mean for an investor positioned for ${regimeLabel}?`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.content?.[0]?.text as string | undefined) ?? null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get("refresh") === "true";
    const today = new Date().toISOString().slice(0, 10);

    // Return cached analysis if available and not forcing refresh
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

    // Generate fresh analysis
    const [{ data: regimeRow }, { data: macroRows }, marketSnapshot] = await Promise.all([
      sb.from("macro_regime_history")
        .select("structural_key,market_key,forward_key,forward_confidence")
        .order("period_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb.from("macro_indicators").select("name,current_value"),
      getMarketSnapshot(),
    ]);

    const get = (name: string) => {
      const i = (macroRows ?? []).find((x: { name: string; current_value: number | null }) => x.name === name);
      return i?.current_value != null ? Number(i.current_value) : null;
    };

    const structuralKey = regimeRow?.structural_key ?? null;
    const marketKey = regimeRow?.market_key ?? null;
    const fwdKey = regimeRow?.forward_key ?? null;
    const regimeLabel = structuralKey ? (REGIME_LABELS[structuralKey] ?? structuralKey) : "Unknown";
    const marketLabel = marketKey ? (REGIME_LABELS[marketKey] ?? marketKey) : null;
    const fwdLabel = fwdKey ? (REGIME_LABELS[fwdKey] ?? fwdKey) : null;
    const divergence = !!(structuralKey && marketKey && structuralKey !== marketKey);

    const analysis = await generateAnalysis({
      regimeLabel, marketLabel, fwdLabel,
      fwdConf: regimeRow?.forward_confidence ?? null,
      divergence,
      gdp: get("Real GDP Growth"),
      cpi: get("CPI (YoY)"),
      ppi: get("PPI (YoY)"),
      t10y2y: get("2yr/10yr Yield Spread"),
      marketSnapshot,
    });

    if (!analysis) {
      return new Response(JSON.stringify({ error: "Analysis generation failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const row = {
      analysis_date: today,
      analysis,
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
