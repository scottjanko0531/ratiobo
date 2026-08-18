import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRED_API_KEY = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Two rolling-correlation series that share all their machinery (fetch daily
// prices, difference them, compute rolling Pearson correlation, upsert one
// row per day) — merged into one function per the spec's own instruction.
//
// Gold / Real-Yield Correlation [1.4]: in a normal regime, gold and the 10Y
// TIPS real yield are strongly negatively correlated (real yield is gold's
// opportunity cost). A flip to positive means gold is trading as a long-bond
// substitute, not a rate-sensitive asset — the cleanest single discriminator
// between "cyclically high yields" and "reserve-asset regime change."
// Correlation of daily FIRST-DIFFERENCES (levels), per spec.
//
// Stock/Bond Correlation [1.3d]: the portfolio bridge — when SPY/TLT turn
// persistently positively correlated, Treasuries have stopped hedging
// equities and any allocation model assuming negative correlation
// understates portfolio risk. Correlation of daily % RETURNS, per spec
// ("daily returns" — standard finance usage, and not scale-equivalent to
// diffing raw levels given SPY (~$450s) and TLT (~$85s) trade at very
// different price levels).
async function fetchYahooTicker(ticker: string, range: string): Promise<{ date: string; value: number }[]> {
  const encoded = encodeURIComponent(ticker);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=${range}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" }, signal: controller.signal }
    );
  } finally { clearTimeout(tid); }
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker}: no result in response`);
  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  return timestamps
    .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), value: closes[i] ?? NaN }))
    .filter((o) => !isNaN(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchFredSeries(seriesId: string): Promise<{ date: string; value: number }[]> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&sort_order=asc&limit=100000&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value));
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Aligns two date->value maps to their common dates (ascending), diffs each
// series day-over-day, then computes trailing 30/90/180-obs rolling
// correlation of those diffs for every date with enough history.
function rollingCorrSeries(
  aVals: Map<string, number>, bVals: Map<string, number>, mode: "diff" | "pctReturn"
): { date: string; corr30: number | null; corr90: number | null; corr180: number | null }[] {
  const dates = [...aVals.keys()].filter((d) => bVals.has(d)).sort();
  const diffA: number[] = [], diffB: number[] = [], diffDates: string[] = [];
  for (let i = 1; i < dates.length; i++) {
    const a0 = aVals.get(dates[i - 1])!, a1 = aVals.get(dates[i])!;
    const b0 = bVals.get(dates[i - 1])!, b1 = bVals.get(dates[i])!;
    diffA.push(mode === "diff" ? a1 - a0 : (a1 - a0) / a0);
    diffB.push(mode === "diff" ? b1 - b0 : (b1 - b0) / b0);
    diffDates.push(dates[i]);
  }
  const out: { date: string; corr30: number | null; corr90: number | null; corr180: number | null }[] = [];
  for (let i = 0; i < diffDates.length; i++) {
    const w = (n: number) => (i + 1 >= n ? pearson(diffA.slice(i + 1 - n, i + 1), diffB.slice(i + 1 - n, i + 1)) : null);
    out.push({ date: diffDates[i], corr30: w(30), corr90: w(90), corr180: w(180) });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const errors: string[] = [];
    let goldRows = 0, sbRows = 0;

    // ---- Gold / Real-Yield Correlation ----
    try {
      const [{ data: goldData }, dfii10] = await Promise.all([
        sb.from("gold_daily_prices").select("date, close_price").order("date", { ascending: true }),
        fetchFredSeries("DFII10"),
      ]);
      const goldMap = new Map((goldData ?? []).map((r: { date: string; close_price: number }) => [r.date, Number(r.close_price)]));
      const realYieldMap = new Map(dfii10.map((o) => [o.date, o.value]));
      const series = rollingCorrSeries(goldMap, realYieldMap, "diff");
      const rows = series
        .filter((s) => s.corr30 != null || s.corr90 != null || s.corr180 != null)
        .map((s) => ({
          obs_date: s.date, corr_30d: s.corr30, corr_90d: s.corr90, corr_180d: s.corr180,
          real_yield_pct: realYieldMap.get(s.date) ?? null, gold_price: goldMap.get(s.date) ?? null,
        }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from("gold_rate_correlation").upsert(rows.slice(i, i + 500), { onConflict: "obs_date" });
        if (error) throw error;
      }
      goldRows = rows.length;
    } catch (e) { errors.push(`gold_rate_correlation: ${e instanceof Error ? e.message : String(e)}`); }

    // ---- Stock/Bond Correlation ----
    try {
      const [spy, tlt] = await Promise.all([fetchYahooTicker("SPY", "5y"), fetchYahooTicker("TLT", "5y")]);
      const spyMap = new Map(spy.map((o) => [o.date, o.value]));
      const tltMap = new Map(tlt.map((o) => [o.date, o.value]));
      const series = rollingCorrSeries(spyMap, tltMap, "pctReturn");
      const rows = series
        .filter((s) => s.corr30 != null || s.corr90 != null || s.corr180 != null)
        .map((s) => ({
          obs_date: s.date, corr_30d: s.corr30, corr_90d: s.corr90, corr_180d: s.corr180,
          equity_symbol: "SPY", bond_symbol: "TLT",
        }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from("stock_bond_correlation").upsert(rows.slice(i, i + 500), { onConflict: "obs_date" });
        if (error) throw error;
      }
      sbRows = rows.length;
    } catch (e) { errors.push(`stock_bond_correlation: ${e instanceof Error ? e.message : String(e)}`); }

    return json({ goldRowsUpserted: goldRows, stockBondRowsUpserted: sbRows, errors });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
