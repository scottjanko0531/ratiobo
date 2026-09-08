import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// VAMS-equivalent backtest spec, Phase 1: one-time (re-runnable) backfill of
// daily close history into asset_price_history. Ratiobo had no daily price
// series anywhere before this — sync-market-data only ever overwrites a spot
// price, and asset_return_history holds annual strategic-asset returns for
// the simulator, not a daily series a momentum/volatility signal can be
// computed from.
//
// Reuses the SAME Yahoo Finance v8 chart endpoint + query1/query2 fallback
// already proven in sync-market-data's fetchYahooChartPrice (used there for
// the equity spot-price fallback and mutual-fund pricing), just widened from
// range=5d to range=max and parsing the full timestamp/close arrays instead
// of only the latest point. No new vendor, no new API key.
//
// Target universe: VT/GLDM/FBTC (42 Macro's KISS defaults, per the user's
// explicit scope choice) plus BTC-USD as a pre-FBTC bitcoin proxy — FBTC
// only launched Jan-2024, far too short a history on its own for a
// walk-forward parameter sweep.
const DEFAULT_SYMBOLS = ["VT", "GLDM", "FBTC", "BTC-USD"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Ratiobo's holdings.symbol convention (e.g. "BTC") doesn't always match
// Yahoo's chart-endpoint ticker (e.g. "BTC-USD") — bare "BTC" silently
// resolves to an unrelated ~$35 equity on Yahoo (caught by hand in
// sync-asset-price-history). Kept here too even though DEFAULT_SYMBOLS
// already uses "BTC-USD" directly, so an explicit ?symbols=BTC call is safe.
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

async function fetchYahooDailyHistory(symbol: string): Promise<{ rows: DailyRow[]; error?: string }> {
  const yahooSymbol = YAHOO_SYMBOL_OVERRIDES[symbol] ?? symbol;
  // `range=max` silently downgrades to monthly (or weekly) bars for
  // long-lived symbols regardless of the requested `interval` — confirmed
  // by hand (VT returned 220 monthly rows with range=max&interval=1d vs.
  // 4578 true daily rows below). Explicit period1=0 (epoch) / period2=now
  // is the only combination that forces true daily granularity across the
  // full available history.
  const period2 = Math.floor(Date.now() / 1000);
  const qs = `interval=1d&period1=0&period2=${period2}`;
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
    const symbols = symbolsParam ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()) : DEFAULT_SYMBOLS;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const report: Record<string, unknown> = { symbols, results: {} as Record<string, unknown> };
    const results = report.results as Record<string, unknown>;

    for (const symbol of symbols) {
      const { rows, error } = await fetchYahooDailyHistory(symbol);
      if (error || rows.length === 0) {
        results[symbol] = { ok: false, error: error ?? "no rows parsed" };
        continue;
      }
      // Upsert in chunks — a "max" range for a long-lived ETF like VT can
      // return 4000+ daily rows, past a single insert's comfortable size.
      const chunkSize = 1000;
      let upserted = 0;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error: upErr } = await supabase
          .from("asset_price_history")
          .upsert(chunk, { onConflict: "symbol,date" });
        if (upErr) { results[symbol] = { ok: false, error: upErr.message, upsertedBeforeError: upserted }; break; }
        upserted += chunk.length;
      }
      if (!results[symbol]) {
        results[symbol] = {
          ok: true, rowCount: rows.length,
          from: rows[0].date, to: rows[rows.length - 1].date,
        };
      }
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
