import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeMarketConditionsHistory } from "../_shared/marketConditions/scoring.ts";
import { MC_CONFIG } from "../_shared/marketConditions/config.ts";

// Market Conditions Overlay, Phase 1 — compute (build spec Section 7/9.1).
// Reads SPY from asset_price_history and VIXCLS/^VIX3M/BAMLH0A0HYM2 from
// mc_series_daily, runs the full walk-forward pipeline in
// _shared/marketConditions/, and upserts market_conditions_scores.
//
// Doubles as both "nightly" and "backfill" (spec's jobs/nightly.ts +
// jobs/backfill.ts) — there's no meaningful difference between them here:
// scoring.ts always recomputes the full history from the earliest
// computable date through `asOf` (see its own header comment on why), so a
// backfill is just this same function called once, and the nightly cron is
// this same function called with no params (asOf defaults to the latest
// ingested date). Optional ?asOf=YYYY-MM-DD caps the computed range, mainly
// useful for reproducing a past run.
//
// pg_cron-scheduled a few minutes after market-conditions-ingest (see
// 20260928_schedule_market_conditions.sql).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type PriceRow = { date: string; close: number };
type SeriesRow = { date: string; value: number };

async function fetchAllPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<PriceRow[]> {
  let rows: PriceRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("asset_price_history").select("date, close")
      .eq("symbol", symbol).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`asset_price_history read (${symbol}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, close: Number(r.close) })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchAllSeries(supabase: ReturnType<typeof createClient>, seriesId: string): Promise<SeriesRow[]> {
  let rows: SeriesRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("mc_series_daily").select("date, value")
      .eq("series_id", seriesId).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`mc_series_daily read (${seriesId}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, value: Number(r.value) })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const asOf = url.searchParams.get("asOf");

  const { data: runRow } = await supabase.from("mc_job_runs").insert({ job_name: "market-conditions-compute" }).select("id").single();
  const runId = runRow?.id as number | undefined;

  try {
    const [spyRows, vixRows, vix3mRows, hyOasRows] = await Promise.all([
      fetchAllPrices(supabase, "SPY"),
      fetchAllSeries(supabase, "VIXCLS"),
      fetchAllSeries(supabase, "VIX3M"),
      fetchAllSeries(supabase, "BAMLH0A0HYM2"),
    ]);
    if (spyRows.length === 0) throw new Error("no SPY price history -- run market-conditions-ingest first");

    const spyFiltered = asOf ? spyRows.filter((r) => r.date <= asOf) : spyRows;
    const dates = spyFiltered.map((r) => r.date);
    const closes = spyFiltered.map((r) => r.close);

    // Exact-date alignment to SPY's trading calendar -- no forward-fill for
    // these daily series in Phase 1 (forward-fill-from-publish-date is a
    // Phase 4 concern for weekly inputs per spec Section 3). A date one
    // series is missing (rare -- e.g. a data-vendor gap) just becomes null
    // and that sub-indicator excludes itself for that day, same as any
    // other insufficient-history case.
    const align = (rows: SeriesRow[]): (number | null)[] => {
      const byDate = new Map(rows.map((r) => [r.date, r.value]));
      return dates.map((d) => byDate.get(d) ?? null);
    };
    const vix = align(vixRows);
    const vix3m = align(vix3mRows);
    const hyOas = align(hyOasRows);

    const rows = computeMarketConditionsHistory({ dates, closes, vix, vix3m, hyOas }, MC_CONFIG);

    const dbRows = rows.map((r) => ({
      date: r.date,
      config_version: r.configVersion,
      trend_state: r.trendState,
      score_trend: r.scoreTrend,
      score_breadth: r.scoreBreadth,
      score_stress: r.scoreStress,
      score_sentiment: r.scoreSentiment,
      score_macro: r.scoreMacro,
      composite: r.composite,
      raw_tier: r.rawTier,
      tier: r.tier,
      exposure_multiplier: r.exposureMultiplier,
      entry_signal: r.entrySignal,
      entry_reason: r.entryReason,
      veto_active: r.vetoActive,
      flags: r.flags,
      components: r.components,
      computed_at: new Date().toISOString(),
    }));

    const chunkSize = 500; // components/flags jsonb makes rows heavier than a plain numeric table
    let upserted = 0;
    for (let i = 0; i < dbRows.length; i += chunkSize) {
      const chunk = dbRows.slice(i, i + chunkSize);
      const { error } = await supabase.from("market_conditions_scores").upsert(chunk, { onConflict: "date" });
      if (error) throw new Error(`market_conditions_scores upsert: ${error.message}`);
      upserted += chunk.length;
    }

    const report = {
      rowsComputed: dbRows.length,
      from: dbRows[0]?.date ?? null,
      to: dbRows[dbRows.length - 1]?.date ?? null,
      latest: dbRows.length ? dbRows[dbRows.length - 1] : null,
    };

    if (runId != null) {
      await supabase.from("mc_job_runs").update({ finished_at: new Date().toISOString(), status: "ok", detail: { rowsComputed: report.rowsComputed, from: report.from, to: report.to } }).eq("id", runId);
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
