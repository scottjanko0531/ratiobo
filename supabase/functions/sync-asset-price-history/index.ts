import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// VAMS-equivalent Bottom-Up overlay spec: daily incremental companion to
// backfill-asset-price-history (which always re-pulls FULL history via
// period1=0 — fine for a one-time/manual backfill, wasteful and slow to run
// daily on a growing multi-thousand-row series). This uses a short range
// (range=5d, same style as sync-market-data's existing spot-price fallback)
// and upserts — idempotent on asset_price_history's (symbol,date) unique
// constraint, so re-running never duplicates.
//
// Symbol list defaults to every symbol in asset_resize_rule_config (the set
// this whole overlay actually needs price history for), not a hardcoded
// list — adding a new symbol to that config table is enough to pull it in
// here too, no redeploy needed.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Ratiobo's own holdings.symbol convention (e.g. "BTC") doesn't always match
// Yahoo's chart-endpoint ticker convention (e.g. "BTC-USD" for spot crypto —
// bare "BTC" silently resolves to an unrelated ~$35 equity on Yahoo, caught
// by hand when it landed in asset_price_history at a price nowhere near
// Bitcoin's). Rows are still stored under the ORIGINAL holdings symbol so
// asset_resize_rule_config/downstream joins stay keyed the way the rest of
// the app already keys holdings.
const YAHOO_SYMBOL_OVERRIDES: Record<string, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
};

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

type DailyRow = { symbol: string; date: string; close: number; source: string };

async function fetchYahooRecent(symbol: string): Promise<{ rows: DailyRow[]; error?: string }> {
  const yahooSymbol = YAHOO_SYMBOL_OVERRIDES[symbol] ?? symbol;
  const qs = `interval=1d&range=5d`;
  let json: Record<string, unknown> | null = null;
  let lastErr = "";
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${qs}`,
        { headers: YAHOO_HEADERS },
      );
      if (!res.ok) { lastErr = `${host} HTTP ${res.status}`; continue; }
      json = await res.json() as Record<string, unknown>;
      break;
    } catch (e) {
      lastErr = `${host} fetch error — ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!json) return { rows: [], error: `${symbol}: ${lastErr}` };

  const result = ((json.chart as Record<string, unknown>)?.result) as Record<string, unknown>[] | null;
  if (!Array.isArray(result) || !result[0]) {
    const errMsg = ((json.chart as Record<string, unknown>)?.error as Record<string, string>)?.description ?? "no result";
    return { rows: [], error: `${symbol}: ${errMsg}` };
  }
  const r0 = result[0];
  const timestamps = r0.timestamp as number[] | undefined;
  const indicators = r0.indicators as Record<string, unknown> | undefined;
  const quote = (indicators?.quote as Record<string, unknown>[] | undefined)?.[0];
  const rawClose = quote?.close as (number | null)[] | undefined;
  const adjcloseArr = (indicators?.adjclose as Record<string, unknown>[] | undefined)?.[0];
  const adjClose = adjcloseArr?.adjclose as (number | null)[] | undefined;
  if (!timestamps || !rawClose) return { rows: [], error: `${symbol}: no timestamp/close arrays in response` };

  const rows: DailyRow[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = (adjClose?.[i] ?? rawClose[i]) ?? null;
    if (c == null || c <= 0) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    rows.push({ symbol, date, close: Math.round(c * 10000) / 10000, source: "yahoo_finance" });
  }
  return { rows };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const symbolsParam = url.searchParams.get("symbols");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let symbols: string[];
    if (symbolsParam) {
      symbols = symbolsParam.split(",").map((s) => s.trim().toUpperCase());
    } else {
      const { data, error } = await supabase.from("asset_resize_rule_config").select("symbol");
      if (error) throw new Error(error.message);
      symbols = (data ?? []).map((r: Record<string, unknown>) => r.symbol as string);
    }

    const report: Record<string, unknown> = { symbols, results: {} as Record<string, unknown> };
    const results = report.results as Record<string, unknown>;

    for (const symbol of symbols) {
      const { rows, error } = await fetchYahooRecent(symbol);
      if (error || rows.length === 0) {
        results[symbol] = { ok: false, error: error ?? "no rows parsed" };
        continue;
      }
      const { error: upErr } = await supabase
        .from("asset_price_history")
        .upsert(rows, { onConflict: "symbol,date" });
      results[symbol] = upErr
        ? { ok: false, error: upErr.message }
        : { ok: true, rowCount: rows.length, latestDate: rows[rows.length - 1].date };
    }

    return new Response(JSON.stringify(report, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
