import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Market Conditions Overlay, Phase 1 — data ingest (build spec Section 3/9.1).
// Fetches SPY (equity proxy, into the EXISTING asset_price_history table —
// see docs/market-conditions/DECISIONS.md, no new price table) and
// VIXCLS/^VIX3M/BAMLH0A0HYM2 (into the new mc_series_daily). Always
// refetches full available history on every run and upserts by primary
// key — simplest idempotent design (spec Section 9.1) at this data volume
// (a few thousand rows per series), same choice already made for this
// session's other one-shot fetchers, avoiding a "first run vs incremental"
// branch entirely.
//
// pg_cron-scheduled (see 20260928_schedule_market_conditions.sql), same
// net.http_post pattern as every other scheduled job in this repo.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

type DateValue = { date: string; value: number };

// Same Yahoo v8 chart endpoint + query1/query2 fallback as
// backfill-asset-price-history's fetchYahooDailyHistory, trimmed to just
// what this function needs (date + adjusted close).
async function fetchYahooDaily(symbol: string): Promise<{ rows: DateValue[]; error?: string }> {
  const period2 = Math.floor(Date.now() / 1000);
  const qs = `interval=1d&period1=0&period2=${period2}`;
  let json: Record<string, unknown> | null = null;
  let lastErr = "";
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, { headers: YAHOO_HEADERS });
      if (!res.ok) { lastErr = `${host} HTTP ${res.status}`; continue; }
      json = await res.json() as Record<string, unknown>;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
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

  const rows: DateValue[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = (adjClose?.[i] ?? rawClose[i]) ?? null;
    if (c == null || c <= 0) continue;
    rows.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), value: Math.round(c * 10000) / 10000 });
  }
  return { rows };
}

async function fetchFredCsv(seriesId: string, cosd: string): Promise<{ rows: DateValue[]; error?: string }> {
  try {
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}`);
    if (!res.ok) return { rows: [], error: `${seriesId}: HTTP ${res.status}` };
    const text = await res.text();
    const lines = text.trim().split("\n").slice(1);
    const rows: DateValue[] = [];
    for (const line of lines) {
      const [date, raw] = line.split(",");
      if (!date || raw === "." || raw === undefined || raw === "") continue;
      const value = parseFloat(raw);
      if (!isFinite(value)) continue;
      rows.push({ date, value });
    }
    return { rows };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: runRow } = await supabase.from("mc_job_runs").insert({ job_name: "market-conditions-ingest" }).select("id").single();
  const runId = runRow?.id as number | undefined;

  try {
    const report: Record<string, unknown> = {};

    // SPY -> asset_price_history (existing table, existing convention).
    const spy = await fetchYahooDaily("SPY");
    if (spy.error || spy.rows.length === 0) {
      report.spy = { ok: false, error: spy.error ?? "no rows" };
    } else {
      const chunkSize = 1000;
      let upserted = 0;
      for (let i = 0; i < spy.rows.length; i += chunkSize) {
        const chunk = spy.rows.slice(i, i + chunkSize).map((r) => ({ symbol: "SPY", date: r.date, close: r.value, source: "yahoo_finance" }));
        const { error } = await supabase.from("asset_price_history").upsert(chunk, { onConflict: "symbol,date" });
        if (error) throw new Error(`asset_price_history upsert (SPY): ${error.message}`);
        upserted += chunk.length;
      }
      report.spy = { ok: true, rowCount: upserted, from: spy.rows[0].date, to: spy.rows[spy.rows.length - 1].date };
    }

    // ^VIX3M -> mc_series_daily (Yahoo; not a FRED series -- see DECISIONS.md).
    const vix3m = await fetchYahooDaily("^VIX3M");
    await upsertSeries(supabase, "VIX3M", vix3m, "yahoo_finance", report, "vix3m");

    // VIXCLS, BAMLH0A0HYM2 -> mc_series_daily (FRED).
    const vix = await fetchFredCsv("VIXCLS", "1990-01-01");
    await upsertSeries(supabase, "VIXCLS", vix, "fred", report, "vixcls");

    const hyOas = await fetchFredCsv("BAMLH0A0HYM2", "1990-01-01");
    await upsertSeries(supabase, "BAMLH0A0HYM2", hyOas, "fred", report, "hyOas");

    if (runId != null) {
      await supabase.from("mc_job_runs").update({ finished_at: new Date().toISOString(), status: "ok", detail: report }).eq("id", runId);
    }

    return new Response(JSON.stringify(report, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (runId != null) {
      await supabase.from("mc_job_runs").update({ finished_at: new Date().toISOString(), status: "error", detail: { error: errMsg } }).eq("id", runId);
    }
    return new Response(JSON.stringify({ error: errMsg }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

async function upsertSeries(
  supabase: ReturnType<typeof createClient>, seriesId: string, fetched: { rows: DateValue[]; error?: string },
  source: string, report: Record<string, unknown>, reportKey: string,
) {
  if (fetched.error || fetched.rows.length === 0) {
    report[reportKey] = { ok: false, error: fetched.error ?? "no rows" };
    return;
  }
  const chunkSize = 1000;
  let upserted = 0;
  for (let i = 0; i < fetched.rows.length; i += chunkSize) {
    const chunk = fetched.rows.slice(i, i + chunkSize).map((r) => ({
      series_id: seriesId, date: r.date, published_at: r.date, value: r.value, source,
    }));
    const { error } = await supabase.from("mc_series_daily").upsert(chunk, { onConflict: "series_id,date" });
    if (error) throw new Error(`mc_series_daily upsert (${seriesId}): ${error.message}`);
    upserted += chunk.length;
  }
  report[reportKey] = { ok: true, rowCount: upserted, from: fetched.rows[0].date, to: fetched.rows[fetched.rows.length - 1].date };
}
