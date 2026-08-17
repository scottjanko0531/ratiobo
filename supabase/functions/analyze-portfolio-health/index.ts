import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^\*\s+/gm, "- ")
    .trim();
}

interface Portfolio {
  id: string; portfolio_name: string; description: string | null;
  strategy_detail: string | null; target_allocations: Record<string, number> | null;
  rebalance_band_pct: number | null;
  strategy_framework: "static" | "tactical" | "regime_driven" | null;
  current_regime_key: string | null; regime_confirmed_since: string | null;
}

const REGIME_LABELS: Record<string, string> = {
  rg_fi: "Disinflationary Boom", rg_ri: "Reflation", fg_ri: "Stagflation", fg_fi: "Deflationary Bust",
};
interface HoldingValued {
  id: string; symbol: string; name: string | null; asset_type: string; current_value: number | null;
  cost_basis: number | null; net_gain: number | null; total_dividends: number | null;
  total_interest: number | null; total_fees: number | null; simulator_key: string | null;
}

// Mirrors lib/simulatorKeys.js exactly (SIMULATOR_KEYS labels, ASSET_TYPE_DEFAULT
// fallback) — duplicated here since that file is written for the Next.js bundler,
// not portable to a Deno edge function via URL import.
const BUCKET_LABELS: Record<string, string> = {
  eq: "US Equities", intl: "International", em: "EM Equities", nb: "Nominal Bonds",
  tip: "TIPS", com: "Commodities", gld: "Gold", cash: "Cash",
  alt_crypto: "Crypto", alt_re: "Real Estate", alt_loan: "Notes / Loans",
  alt_pp: "Private Placements", alt_other: "Other",
};
const ASSET_TYPE_DEFAULT: Record<string, string> = {
  equity: "eq", etf: "eq", closed_end_fund: "eq", mutual_fund: "eq",
  bond: "nb", money_market: "cash", cash: "cash", crypto: "alt_crypto", metal: "gld",
};
function resolveSimulatorKey(h: { simulator_key: string | null; asset_type: string }): string {
  return h.simulator_key ?? ASSET_TYPE_DEFAULT[h.asset_type] ?? "unassigned";
}

// Standard institutional/practitioner rebalancing convention (Vanguard, robo-advisors):
// a bucket is "out of band" only once its drift exceeds the GREATER of an absolute
// band (user-set, default 5pt) or a relative band (25% of its own target weight) —
// the relative leg keeps small target weights from triggering on tiny absolute moves,
// the absolute leg keeps large target weights from being allowed to drift freely.
function bandStatus(pct: number, target: number | null, bandPct: number): { effectiveBand: number | null; drift: number | null; outOfBand: boolean } {
  if (target == null) return { effectiveBand: null, drift: null, outOfBand: false };
  const effectiveBand = Math.max(bandPct, 0.25 * target);
  const drift = pct - target;
  return { effectiveBand, drift, outOfBand: Math.abs(drift) > effectiveBand };
}

function computePortfolioSummary(holdings: HoldingValued[], targets: Record<string, number> | null, bandPct: number) {
  const totalValue = holdings.reduce((s, h) => s + Number(h.current_value ?? 0), 0);
  const costBasis = holdings.reduce((s, h) => s + Number(h.cost_basis ?? 0), 0);
  const totalGain = holdings.reduce((s, h) =>
    s + Number(h.net_gain ?? 0) + Number(h.total_dividends ?? 0) + Number(h.total_interest ?? 0) - Number(h.total_fees ?? 0), 0);
  const returnPct = costBasis > 0 ? (totalGain / costBasis) * 100 : null;

  const byBucket = new Map<string, number>();
  const holdingsByBucket = new Map<string, HoldingValued[]>();
  for (const h of holdings) {
    const key = resolveSimulatorKey(h);
    byBucket.set(key, (byBucket.get(key) ?? 0) + Number(h.current_value ?? 0));
    if (!holdingsByBucket.has(key)) holdingsByBucket.set(key, []);
    holdingsByBucket.get(key)!.push(h);
  }
  const allocation = [...byBucket.entries()].map(([key, value]) => {
    const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
    const target = targets?.[key] ?? null;
    const holdingsHere = (holdingsByBucket.get(key) ?? [])
      .filter(h => Number(h.current_value ?? 0) > 0)
      .sort((a, b) => Number(b.current_value ?? 0) - Number(a.current_value ?? 0));
    const band = bandStatus(pct, target, bandPct);
    return { key, label: BUCKET_LABELS[key] ?? key, pct, target, holdings: holdingsHere, ...band };
  }).sort((a, b) => b.pct - a.pct);

  return { totalValue, costBasis, totalGain, returnPct, count: holdings.length, allocation };
}

async function generatePortfolioAnalysis(params: {
  portfolio: Portfolio;
  summary: ReturnType<typeof computePortfolioSummary>;
  dayChg: number | null;
  structuralRegime: string | null; marketRegime: string | null; forwardConfidence: number | null;
  clioAnalysis: string | null; clioMusing: string | null;
  macroStatusCounts: { healthy: number; watch: number; danger: number };
}): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const { portfolio, summary, dayChg, structuralRegime, marketRegime, forwardConfidence, clioAnalysis, clioMusing, macroStatusCounts } = params;

    const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
    const bandPct = portfolio.rebalance_band_pct ?? 5;
    const allocLines = summary.allocation
      .map(a => {
        const driftTxt = a.target != null ? `${a.drift! >= 0 ? "+" : ""}${a.drift!.toFixed(1)}pt` : "";
        const bandTxt = a.target != null
          ? a.outOfBand
            ? `OUT OF BAND (±${a.effectiveBand!.toFixed(1)}pt tolerance) — rebalancing this bucket is warranted`
            : `within ±${a.effectiveBand!.toFixed(1)}pt band — no rebalancing action needed here`
          : "";
        const header = `  ${a.label}: ${a.pct.toFixed(1)}%${a.target != null ? ` (target ${a.target}%, ${driftTxt}, ${bandTxt})` : ""}`;
        const holdingsList = a.holdings.map(h => `${h.symbol}${h.name ? ` (${h.name})` : ""}`).join(", ");
        return `${header}\n    Holdings: ${holdingsList || "none"}`;
      })
      .join("\n") || "  No holdings assigned.";
    const anyOutOfBand = summary.allocation.some(a => a.outOfBand);

    const STATIC_TEXT = `This portfolio is explicitly configured as a STATIC, regime-agnostic framework (e.g. risk parity, All Weather) — it does NOT need to predict which macro regime is active, because diversification comes from the mix of asset classes itself. Your recommendations must stay within rebalancing back to the target allocations shown above — do NOT recommend new sector, style, or duration tilts driven by today's regime call (e.g. "shift into small-cap/value," "avoid mega-cap"), since that contradicts this framework's own design philosophy. Judge holding composition on its own terms from what's actually listed above (e.g. a broad total-market fund like VTI or ITOT is not a "mega-cap" or "duration" bet — it's simply unstyled market-cap-weighted exposure) rather than speculating about what a bucket might contain.`;
    const TACTICAL_TEXT = `This portfolio is explicitly configured as a TACTICAL, regime-responsive framework — it is meant to rotate or tilt exposure based on the macro cycle. Regime-driven tilts, including within a single sleeve and beyond simple rebalancing to target, are appropriate and expected.`;
    const regimeDrivenLabel = portfolio.current_regime_key ? (REGIME_LABELS[portfolio.current_regime_key] ?? portfolio.current_regime_key) : null;
    const REGIME_DRIVEN_TEXT = `This portfolio is explicitly configured as REGIME-DRIVEN: its target allocations shown above are set AUTOMATICALLY by a daily job that tracks Dalio's four-quadrant structural regime and only shifts targets once a new regime has held for 30 consecutive days (avoiding whipsaw on noise) — currently targeting ${regimeDrivenLabel ?? "an unset regime"}${portfolio.regime_confirmed_since ? `, confirmed since ${portfolio.regime_confirmed_since}` : ""}. The regime tilt has ALREADY happened at the target-allocation level — treat this exactly like a static framework for recommendation purposes: stay within rebalancing back to the CURRENT target shown above, do NOT layer additional freelance tactical tilts on top of what the automated target already encodes. If you believe the live regime differs from what's targeted, note that as context only — do not recommend the portfolio manually front-run the confirmation window.`;
    const UNSET_TEXT = `Determine from the stated strategy and actual holdings above whether this portfolio is a static, regime-agnostic asset-allocation framework (e.g. risk parity, All Weather — explicitly designed so the investor does NOT need to predict which macro regime is active) or a tactical, regime-responsive framework (e.g. explicitly built to rotate or tilt exposure based on the macro cycle, such as BW Modified). If static/regime-agnostic, recommendations must stay within rebalancing back to the target allocations shown above — do NOT recommend new sector, style, or duration tilts driven by today's regime call. Judge holding composition on its own terms (e.g. a broad total-market fund like VTI or ITOT is not a "mega-cap" bet) rather than speculating about what a bucket might contain. If tactical/regime-responsive, regime-driven tilts are appropriate and expected.`;
    const frameworkConstraint = "FRAMEWORK CONSTRAINT: " + (
      portfolio.strategy_framework === "static" ? STATIC_TEXT
      : portfolio.strategy_framework === "tactical" ? TACTICAL_TEXT
      : portfolio.strategy_framework === "regime_driven" ? REGIME_DRIVEN_TEXT
      : UNSET_TEXT
    );

    const prompt = `You are Clio, macro analyst at RatioBo. You already wrote today's regime analysis and news musing (both below). Now assess this ONE portfolio specifically against that backdrop. Write direct, sharp analysis — no hedging language, no fluff, under 350 words total. No markdown headers, no bold, no title line.

PORTFOLIO: ${portfolio.portfolio_name}
${portfolio.description ? `Description: ${portfolio.description}` : ""}
${portfolio.strategy_detail ? `Stated strategy: ${portfolio.strategy_detail}` : "No stated strategy on record."}

Holdings: ${summary.count}, Total value: ${usd(summary.totalValue)}, Cost basis: ${usd(summary.costBasis)}
Total gain: ${summary.totalGain >= 0 ? "+" : ""}${usd(summary.totalGain)} (${summary.returnPct != null ? `${summary.returnPct >= 0 ? "+" : ""}${summary.returnPct.toFixed(1)}%` : "n/a"})
${dayChg != null ? `Day change: ${dayChg >= 0 ? "+" : ""}${usd(dayChg)}` : ""}

Current allocation by bucket (rebalancing tolerance band already computed per bucket —
this portfolio's absolute band is ±${bandPct}pt, widened to 25% of a bucket's own target
weight when that's larger, which is standard institutional/robo-advisor practice — do
not compute or judge drift tolerance yourself, use the OUT OF BAND / within band verdict
already given for each bucket):
${allocLines}
${anyOutOfBand ? "" : "REBALANCING CONSTRAINT: every bucket above is within its band. Do not recommend rebalancing any bucket today — state plainly that the portfolio is within tolerance and no trades are needed on that front, even if a bucket has nonzero drift."}

TODAY'S MACRO BACKDROP:
Structural regime: ${structuralRegime ?? "unknown"}
Market-implied regime: ${marketRegime ?? "unknown"}
Forward signal confidence: ${forwardConfidence != null ? `${forwardConfidence}%` : "n/a"}
Indicator status counts: ${macroStatusCounts.healthy} healthy, ${macroStatusCounts.watch} watch, ${macroStatusCounts.danger} danger

CLIO'S REGIME ANALYSIS (already published today):
${clioAnalysis ?? "Not yet generated today."}

CLIO'S NEWS MUSING (already published today):
${clioMusing ?? "Not yet generated today."}

${frameworkConstraint}

Structure your answer in two parts, separated by a blank line:
(1) A paragraph assessing this portfolio's health: is its current allocation appropriate given its stated strategy AND the macro backdrop above? Where is it well-positioned, and where is it exposed? If it has no stated strategy, note that explicitly and assess purely against the macro backdrop.
(2) A "Recommendations:" section: one short lead-in sentence, then 3-5 bullet points (each on its own line, starting with "- "), each a specific, actionable instruction naming a real bucket, asset class, or holding in this portfolio and what to do with it. Any rebalancing trade must be justified by a bucket marked OUT OF BAND above — never recommend trimming or adding to a bucket that's within its band purely because it has nonzero drift or because of the macro regime call (for static/regime-agnostic frameworks per the constraint above). Bullets not about rebalancing (e.g. macro-driven tactical calls for a tactical framework) don't need a band justification, just the macro regime tie-in.

Part 1 must be plain prose — no bullets, no bold, no headers. Part 2 must be lead-in sentence + bullets only.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.content?.[0]?.text as string | undefined) ?? null;
    return raw ? stripMarkdown(raw) : null;
  } catch { return null; }
}

async function analyzeOnePortfolio(
  sb: ReturnType<typeof createClient>,
  portfolio: Portfolio,
  macroCtx: {
    structuralRegime: string | null; marketRegime: string | null; forwardConfidence: number | null;
    clioAnalysis: string | null; clioMusing: string | null;
    macroStatusCounts: { healthy: number; watch: number; danger: number };
  },
): Promise<{ portfolioId: string; ok: boolean; error?: string }> {
  try {
    const { data: phRows } = await sb.from("portfolio_holdings").select("holding_id").eq("portfolio_id", portfolio.id);
    const holdingIds = (phRows ?? []).map((r: { holding_id: string }) => r.holding_id);
    if (!holdingIds.length) return { portfolioId: portfolio.id, ok: false, error: "no holdings" };

    const { data: holdings } = await sb
      .from("holdings_valued")
      .select("id,symbol,name,asset_type,current_value,cost_basis,net_gain,total_dividends,total_interest,total_fees,simulator_key")
      .in("id", holdingIds);
    if (!holdings?.length) return { portfolioId: portfolio.id, ok: false, error: "no valued holdings" };

    const bandPct = portfolio.rebalance_band_pct ?? 5;
    const summary = computePortfolioSummary(holdings as HoldingValued[], portfolio.target_allocations, bandPct);

    // Day change: today's opening snapshot (written by the nightly-portfolio-snapshot
    // cron) vs. current live value — same convention the frontend drawer already uses.
    const today = new Date().toISOString().slice(0, 10);
    const { data: snapRows } = await sb
      .from("portfolio_snapshots")
      .select("holding_id, market_value")
      .eq("snapshot_date", today)
      .in("holding_id", holdingIds);
    let dayChg: number | null = null;
    if (snapRows?.length) {
      const prevTotal = snapRows.reduce((s: number, r: { market_value: number }) => s + Number(r.market_value ?? 0), 0);
      dayChg = summary.totalValue - prevTotal;
    }

    const analysis = await generatePortfolioAnalysis({
      portfolio, summary, dayChg,
      structuralRegime: macroCtx.structuralRegime, marketRegime: macroCtx.marketRegime,
      forwardConfidence: macroCtx.forwardConfidence,
      clioAnalysis: macroCtx.clioAnalysis, clioMusing: macroCtx.clioMusing,
      macroStatusCounts: macroCtx.macroStatusCounts,
    });
    if (!analysis) return { portfolioId: portfolio.id, ok: false, error: "generation failed" };

    const { error: upErr } = await sb.from("portfolio_daily_analysis").upsert({
      portfolio_id: portfolio.id,
      analysis_date: today,
      analysis,
      structural_regime: macroCtx.structuralRegime,
      market_regime: macroCtx.marketRegime,
      forward_confidence: macroCtx.forwardConfidence,
      rebalance_band_pct: bandPct,
      generated_at: new Date().toISOString(),
    }, { onConflict: "portfolio_id,analysis_date" });
    if (upErr) return { portfolioId: portfolio.id, ok: false, error: upErr.message };

    return { portfolioId: portfolio.id, ok: true };
  } catch (e) {
    return { portfolioId: portfolio.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    let body: { portfolio_id?: string } = {};
    try { body = await req.json(); } catch { /* no body — batch/cron mode */ }

    const today = new Date().toISOString().slice(0, 10);

    // This runs unattended on a daily cron — it can't assume a human already
    // visited /macro today to lazily generate Clio's regime analysis (that page
    // only calls get-regime-analysis on visit or explicit refresh, with no cron
    // of its own). Ensure today's row exists before building on it.
    const { data: todayRegime } = await sb.from("dalio_regime_analysis").select("analysis_date").eq("analysis_date", today).maybeSingle();
    if (!todayRegime) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/get-regime-analysis`, {
          method: "GET",
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        });
      } catch (e) { console.error("[portfolio-health] triggering get-regime-analysis:", e); }
    }

    // Shared macro context — fetched once, reused across all portfolios in this run.
    const [{ data: regimeRow }, { data: macroRows }] = await Promise.all([
      sb.from("dalio_regime_analysis").select("analysis,news_musing,structural_regime,market_regime").order("analysis_date", { ascending: false }).limit(1).maybeSingle(),
      sb.from("macro_indicators").select("status"),
    ]);
    const { data: regimeHistRow } = await sb
      .from("macro_regime_history").select("forward_confidence").order("period_date", { ascending: false }).limit(1).maybeSingle();

    const macroStatusCounts = { healthy: 0, watch: 0, danger: 0 };
    for (const r of (macroRows ?? []) as { status: string | null }[]) {
      if (r.status === "healthy") macroStatusCounts.healthy++;
      else if (r.status === "watch") macroStatusCounts.watch++;
      else if (r.status === "danger") macroStatusCounts.danger++;
    }
    const macroCtx = {
      structuralRegime: regimeRow?.structural_regime ?? null,
      marketRegime: regimeRow?.market_regime ?? null,
      forwardConfidence: regimeHistRow?.forward_confidence != null ? Number(regimeHistRow.forward_confidence) : null,
      clioAnalysis: regimeRow?.analysis ?? null,
      clioMusing: regimeRow?.news_musing ?? null,
      macroStatusCounts,
    };

    if (body.portfolio_id) {
      // Manual on-demand run for one portfolio — always regenerates.
      const { data: pf, error: pfErr } = await sb.from("portfolios").select("*").eq("id", body.portfolio_id).single();
      if (pfErr || !pf) return json({ error: "portfolio not found" }, 404);
      const result = await analyzeOnePortfolio(sb, pf as Portfolio, macroCtx);
      if (!result.ok) return json({ error: result.error ?? "analysis failed" }, 500);
      const { data: row } = await sb.from("portfolio_daily_analysis").select("*").eq("portfolio_id", body.portfolio_id).eq("analysis_date", today).single();
      return json(row);
    }

    // Batch/cron mode — one per portfolio, skipping any that already have today's row.
    const { data: portfolios } = await sb.from("portfolios").select("*");
    const { data: existingRows } = await sb.from("portfolio_daily_analysis").select("portfolio_id").eq("analysis_date", today);
    const already = new Set((existingRows ?? []).map((r: { portfolio_id: string }) => r.portfolio_id));
    const pending = (portfolios ?? []).filter((p: Portfolio) => !already.has(p.id));

    const results = [];
    for (const pf of pending as Portfolio[]) {
      results.push(await analyzeOnePortfolio(sb, pf, macroCtx));
    }

    return json({
      total: (portfolios ?? []).length,
      alreadyDone: already.size,
      processed: results.length,
      succeeded: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
