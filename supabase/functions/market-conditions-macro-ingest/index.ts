import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Market Conditions Overlay — "Macro context" display-only layer ingest.
// NOT scored (composite/tier/exposure_multiplier are untouched by anything
// here) -- these series exist purely for the /market-conditions "Macro
// context" panel (current value, 1-year percentile, direction) and for the
// MOVE-index Stress-pillar keep-or-drop test (docs/market-conditions/
// DECISIONS.md). Same upsert-by-primary-key, always-refetch-full-history
// idempotent design as market-conditions-ingest -- see that file's header
// comment for the rationale; this is a sibling, not a replacement.
//
// published_at vs date: every OTHER series this repo ingests into
// mc_series_daily (VIXCLS, VIX3M, BAA10Y, BAMLH0A0HYM2, DTB3) is daily with
// no real reporting lag, so market-conditions-ingest hardcodes
// published_at = date for all of them (confirmed by reading that file).
// Three of these NEW series genuinely do lag their own `date` column by a
// predictable amount, and get a nonzero LAG_DAYS entry below so
// alignWithForwardFill's no-lookahead guard (published_at <= t) means
// anything pending release is correctly excluded, not leaked early:
//   - ICSA (initial jobless claims): FRED dates each row to the
//     Saturday the reporting week ends; the actual release is the
//     following Thursday, 8:30am ET -> +5 calendar days.
//   - NFCI (Chicago Fed National Financial Conditions Index): FRED dates
//     each row to the Friday the reporting week ends; released the
//     FOLLOWING Friday -> +7 calendar days.
//   - DRTSCILM (Senior Loan Officer Opinion Survey, net % tightening C&I
//     loan standards, large/mid firms): FRED dates each row to the
//     calendar quarter's first day; results are released ~6 weeks after
//     quarter end -> +45 calendar days (approximate; SLOOS's exact
//     release date moves around the Fed's survey calendar).
// All other series below (daily FRED series, and every Yahoo series) use
// published_at = date, same convention as the existing ingest function.

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

function addDays(dateStr: string, days: number): string {
  if (!days) return dateStr;
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function upsertSeries(
  supabase: ReturnType<typeof createClient>, seriesId: string, fetched: { rows: DateValue[]; error?: string },
  source: string, lagDays: number, report: Record<string, unknown>, reportKey: string,
) {
  if (fetched.error || fetched.rows.length === 0) {
    report[reportKey] = { ok: false, error: fetched.error ?? "no rows" };
    return;
  }
  const chunkSize = 1000;
  let upserted = 0;
  for (let i = 0; i < fetched.rows.length; i += chunkSize) {
    const chunk = fetched.rows.slice(i, i + chunkSize).map((r) => ({
      series_id: seriesId, date: r.date, published_at: addDays(r.date, lagDays), value: r.value, source,
    }));
    const { error } = await supabase.from("mc_series_daily").upsert(chunk, { onConflict: "series_id,date" });
    if (error) throw new Error(`mc_series_daily upsert (${seriesId}): ${error.message}`);
    upserted += chunk.length;
  }
  report[reportKey] = { ok: true, rowCount: upserted, from: fetched.rows[0].date, to: fetched.rows[fetched.rows.length - 1].date, lagDays };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: runRow } = await supabase.from("mc_job_runs").insert({ job_name: "market-conditions-macro-ingest" }).select("id").single();
  const runId = runRow?.id as number | undefined;

  try {
    const report: Record<string, unknown> = {};

    // FRED, daily, no reporting lag (published_at = date).
    await upsertSeries(supabase, "T10Y3M", await fetchFredCsv("T10Y3M", "1980-01-01"), "fred", 0, report, "t10y3m");
    await upsertSeries(supabase, "T10Y2Y", await fetchFredCsv("T10Y2Y", "1975-01-01"), "fred", 0, report, "t10y2y");
    await upsertSeries(supabase, "T10YIE", await fetchFredCsv("T10YIE", "2002-01-01"), "fred", 0, report, "t10yie");
    await upsertSeries(supabase, "T5YIFR", await fetchFredCsv("T5YIFR", "2002-01-01"), "fred", 0, report, "t5yifr");
    await upsertSeries(supabase, "DTWEXBGS", await fetchFredCsv("DTWEXBGS", "2005-01-01"), "fred", 0, report, "dtwexbgs");

    // FRED, weekly/quarterly, real reporting lag -- see header comment.
    await upsertSeries(supabase, "ICSA", await fetchFredCsv("ICSA", "1966-01-01"), "fred", 5, report, "icsa");
    await upsertSeries(supabase, "NFCI", await fetchFredCsv("NFCI", "1970-01-01"), "fred", 7, report, "nfci");
    await upsertSeries(supabase, "DRTSCILM", await fetchFredCsv("DRTSCILM", "1990-01-01"), "fred", 45, report, "drtscilm");

    // Yahoo, daily, no reporting lag.
    await upsertSeries(supabase, "VVIX", await fetchYahooDaily("^VVIX"), "yahoo_finance", 0, report, "vvix");
    await upsertSeries(supabase, "VIX9D", await fetchYahooDaily("^VIX9D"), "yahoo_finance", 0, report, "vix9d");
    await upsertSeries(supabase, "MOVE", await fetchYahooDaily("^MOVE"), "yahoo_finance", 0, report, "move");
    await upsertSeries(supabase, "HGF", await fetchYahooDaily("HG=F"), "yahoo_finance", 0, report, "hgf");
    await upsertSeries(supabase, "GCF", await fetchYahooDaily("GC=F"), "yahoo_finance", 0, report, "gcf");

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
