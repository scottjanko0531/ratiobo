import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeMarketConditionsHistory } from "../_shared/marketConditions/scoring.ts";
import { MC_CONFIG } from "../_shared/marketConditions/config.ts";
import { alignWithForwardFill, SeriesRowWithPublish } from "../_shared/marketConditions/normalize.ts";

// Market Conditions Overlay — compute (build spec Section 7/9.1).
// Reads SPY from asset_price_history and VIXCLS/^VIX3M/BAA10Y from
// mc_series_daily, runs the full walk-forward pipeline in
// _shared/marketConditions/, and upserts market_conditions_scores, plus a
// once-only append into mc_signal_log (ON CONFLICT DO NOTHING — that table
// is DB-trigger-enforced immutable, see 20260929_mc_signal_log.sql).
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

const MAX_CARRY_DAYS = 3; // forward-fill cap for daily series, see DECISIONS.md

type PriceRow = { date: string; close: number };

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

async function fetchAllSeries(supabase: ReturnType<typeof createClient>, seriesId: string): Promise<SeriesRowWithPublish[]> {
  let rows: SeriesRowWithPublish[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("mc_series_daily").select("date, value, published_at")
      .eq("series_id", seriesId).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`mc_series_daily read (${seriesId}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, value: Number(r.value), published_at: r.published_at as string })));
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
    const [spyRows, vixRows, vix3mRows, baa10yRows] = await Promise.all([
      fetchAllPrices(supabase, "SPY"),
      fetchAllSeries(supabase, "VIXCLS"),
      fetchAllSeries(supabase, "VIX3M"),
      fetchAllSeries(supabase, "BAA10Y"),
    ]);
    if (spyRows.length === 0) throw new Error("no SPY price history -- run market-conditions-ingest first");

    const spyFiltered = asOf ? spyRows.filter((r) => r.date <= asOf) : spyRows;
    const dates = spyFiltered.map((r) => r.date);
    const closes = spyFiltered.map((r) => r.close);

    // Forward-fill alignment to SPY's trading calendar, up to MAX_CARRY_DAYS
    // trading-day positions, respecting published_at (see
    // alignWithForwardFill's own doc comment). carriedDays>0 means a value
    // was reused from an earlier date -- tracked per series per day below
    // so it can be surfaced as flags.stale_inputs, distinct from a genuine
    // "never available" exclusion (which the per-indicator excludeReason
    // already covers).
    const vixFF = alignWithForwardFill(dates, vixRows, MAX_CARRY_DAYS);
    const vix3mFF = alignWithForwardFill(dates, vix3mRows, MAX_CARRY_DAYS);
    const baa10yFF = alignWithForwardFill(dates, baa10yRows, MAX_CARRY_DAYS);

    const vix = vixFF.map((r) => r.value);
    const vix3m = vix3mFF.map((r) => r.value);
    const creditSpread = baa10yFF.map((r) => r.value);

    const staleByDate = new Map<string, Record<string, number>>();
    const recordStale = (seriesId: string, ff: { carriedDays: number }[]) => {
      for (let i = 0; i < dates.length; i++) {
        if (ff[i].carriedDays > 0) {
          const rec = staleByDate.get(dates[i]) ?? {};
          rec[seriesId] = ff[i].carriedDays;
          staleByDate.set(dates[i], rec);
        }
      }
    };
    recordStale("VIXCLS", vixFF);
    recordStale("VIX3M", vix3mFF);
    recordStale("BAA10Y", baa10yFF);

    const rows = computeMarketConditionsHistory({ dates, closes, vix, vix3m, creditSpread }, MC_CONFIG);

    const dbRows = rows.map((r) => {
      const stale = staleByDate.get(r.date);
      const flags = stale ? { ...r.flags, stale_inputs: stale } : r.flags;
      return {
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
        flags,
        components: r.components,
        computed_at: new Date().toISOString(),
      };
    });

    const chunkSize = 500; // components/flags jsonb makes rows heavier than a plain numeric table
    for (let i = 0; i < dbRows.length; i += chunkSize) {
      const chunk = dbRows.slice(i, i + chunkSize);
      const { error } = await supabase.from("market_conditions_scores").upsert(chunk, { onConflict: "date" });
      if (error) throw new Error(`market_conditions_scores upsert: ${error.message}`);
    }

    // Append-only signal log: ON CONFLICT DO NOTHING means a date already
    // logged is never touched again, regardless of how many times compute
    // re-runs or what a later config change would recompute for that date.
    const signalLogRows = dbRows.map((r) => ({
      date: r.date, config_version: r.config_version, tier: r.tier, raw_tier: r.raw_tier,
      exposure_multiplier: r.exposure_multiplier, entry_signal: r.entry_signal, composite: r.composite,
      score_trend: r.score_trend, score_breadth: r.score_breadth, score_stress: r.score_stress,
      score_sentiment: r.score_sentiment, score_macro: r.score_macro, computed_at: r.computed_at,
    }));
    for (let i = 0; i < signalLogRows.length; i += chunkSize) {
      const chunk = signalLogRows.slice(i, i + chunkSize);
      const { error } = await supabase.from("mc_signal_log").upsert(chunk, { onConflict: "date", ignoreDuplicates: true });
      if (error) throw new Error(`mc_signal_log insert: ${error.message}`);
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
