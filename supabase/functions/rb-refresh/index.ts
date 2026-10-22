import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  createYahooSession,
  fetchQuoteBatch,
  fetchFxRate,
  fetchQuoteSummary,
  fetchFundamentalsTimeseries,
  fetchChart1y,
  fetchChart2y,
  sleep,
} from "../_shared/ruleBreaker/yahooFetch.ts";
import type { RbFundamentalsRaw } from "../_shared/ruleBreaker/types.ts";

// Rule Breaker Screener — Phase 3 daily refresh. Pulls today's
// fundamentals/price data from Yahoo Finance for a SLICE of the active
// `rb_companies` universe (not all ~155 at once -- ~2 symbols/sec x 4
// Yahoo calls/symbol is minutes long, past a single invocation's
// wall-clock budget, same class of problem bond-lens-ingest already
// solved by splitting one job into several `?source=` invocations). The
// scheduler calls this several times with different `?offset=&limit=`
// windows a few minutes apart; `rb-compute` runs once, after every slice
// has landed.
//
// Field mapping is a direct translation of the artifact's own live
// collector (supplied verbatim by the user) -- see yahooFetch.ts's
// header comment and each fetch function for the exact source mapping.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const THROTTLE_MS = 500; // ~2 symbols/sec per the source's own rate-limit note

interface CompanyRow {
  symbol: string;
  yahoo_symbol: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = new Date().toISOString();
  const url = new URL(req.url);
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "1000");
  // Manual/ad-hoc override for testing a specific handful of symbols
  // regardless of their position in the alphabetical offset/limit
  // pagination the daily cron slices use -- not used by the schedule.
  const symbolsParam = url.searchParams.get("symbols");
  const today = new Date().toISOString().slice(0, 10);
  // A manual `?symbols=` test run must NEVER be mistaken for slice
  // coverage by rb-compute's completeness check (which only trusts rows
  // with numeric offset+limit) -- so it gets its own detail shape with no
  // offset/limit keys at all, rather than the defaulted 0/1000.
  const sliceDetail: Record<string, unknown> = symbolsParam ? { symbols: symbolsParam } : { offset, limit };

  const failures: Array<{ symbol: string; error: string }> = [];
  let ok = 0;
  let companies: CompanyRow[] = [];

  try {
    const base = supabase.from("rb_companies").select("symbol, yahoo_symbol").eq("active", true);
    const { data, error } = symbolsParam
      ? await base.in("symbol", symbolsParam.split(",").map((s) => s.trim()).filter(Boolean))
      : await base.order("symbol").range(offset, offset + limit - 1);
    if (error) throw new Error(`rb_companies query: ${error.message}`);
    companies = data ?? [];

    if (companies.length === 0) {
      await supabase.from("rb_job_runs").insert({
        job_name: "rb-refresh", started_at: startedAt, finished_at: new Date().toISOString(),
        status: "ok", detail: { ...sliceDetail, total: 0, ok: 0, failures: [] },
      });
      return new Response(JSON.stringify({ ...sliceDetail, total: 0, ok: 0, failures: [] }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const session = await createYahooSession();
    const fxCache = new Map<string, number | null>();
    const yahooSymbols = companies.map((c) => c.yahoo_symbol ?? c.symbol);
    const quotes = await fetchQuoteBatch(session, yahooSymbols);

    for (const company of companies) {
      const yahooSymbol = company.yahoo_symbol ?? company.symbol;
      try {
        const quote = quotes.get(yahooSymbol) ?? null;
        const quoteFx = await fetchFxRate(session, quote?.currency, fxCache);
        const mcapUsd = quote?.marketCap != null ? quote.marketCap * (quoteFx ?? 1) : null;

        const qs = await fetchQuoteSummary(session, yahooSymbol);
        const ts = await fetchFundamentalsTimeseries(session, yahooSymbol, quote?.currency ?? null);
        const fxToUsd = await fetchFxRate(session, ts.fcur ?? quote?.currency, fxCache);
        const chart1y = await fetchChart1y(yahooSymbol);
        const chart2y = await fetchChart2y(yahooSymbol);

        const raw: RbFundamentalsRaw = {
          mcapUSD: mcapUsd,
          ins: qs.ins,
          inst: qs.inst,
          fpe: qs.fpe,
          ps: qs.ps,
          evRev: qs.evRev,
          evEbitda: qs.evEbitda,
          rgQ: qs.rgQ,
          gmTTM: qs.gmTTM,
          insNet6m: qs.insNet6m,
          insBuyN: qs.insBuyN,
          insSellN: qs.insSellN,
          fcur: ts.fcur,
          fy: ts.fy,
          fxF: fxToUsd,
          rev: ts.rev as unknown as [number, number, number],
          gp: ts.gp as unknown as [number, number],
          cfo: ts.cfo as unknown as [number, number],
          ni: ts.ni,
          assets: ts.assets as unknown as [number, number],
          ebitda: ts.ebitda,
          ebit: ts.ebit,
          debt: ts.debt,
          cash: ts.cash,
          eq: ts.eq,
          rd: ts.rd,
          sbc: ts.sbc,
          rep: ts.rep,
          div: ts.div,
          tax: ts.tax,
          ic: ts.ic,
          qni: ts.qni,
          qrev: ts.qrev,
          qgp: ts.qgp,
          qoi: ts.qoi,
          n: chart1y.n,
          ret1y: chart1y.ret1y,
          mom12_1: chart1y.mom12_1,
          mom6: chart1y.mom6,
          mom3: chart1y.mom3,
          rv: chart1y.rv,
          mdd1y: chart1y.mdd1y,
          liqTrend: chart1y.liqTrend,
          liqCV: chart1y.liqCV,
        };

        const { error: fErr } = await supabase.from("rb_fundamentals").upsert(
          { symbol: company.symbol, asof: today, raw, fcur: ts.fcur, fx_to_usd: fxToUsd, mcap_usd: mcapUsd },
          { onConflict: "symbol,asof" },
        );
        if (fErr) throw new Error(`rb_fundamentals upsert: ${fErr.message}`);

        if (chart2y.weeklyBars.length > 0) {
          const { error: wErr } = await supabase.from("rb_weekly_bars").upsert(
            chart2y.weeklyBars.map((b) => ({ symbol: company.symbol, ...b })),
            { onConflict: "symbol,week_start" },
          );
          if (wErr) throw new Error(`rb_weekly_bars upsert: ${wErr.message}`);
        }

        if (chart2y.dailyCloses.length > 0) {
          const priceRows = chart2y.dailyCloses.map((d) => ({
            symbol: company.symbol, date: d.date, close: d.close, source: "yahoo_finance",
          }));
          const chunkSize = 1000;
          for (let i = 0; i < priceRows.length; i += chunkSize) {
            const { error: pErr } = await supabase
              .from("asset_price_history")
              .upsert(priceRows.slice(i, i + chunkSize), { onConflict: "symbol,date" });
            if (pErr) throw new Error(`asset_price_history upsert: ${pErr.message}`);
          }
        }

        ok++;
      } catch (e) {
        failures.push({ symbol: company.symbol, error: e instanceof Error ? e.message : String(e) });
      }
      await sleep(THROTTLE_MS);
    }

    const status = ok === 0 && companies.length > 0 ? "error" : "ok";
    await supabase.from("rb_job_runs").insert({
      job_name: "rb-refresh", started_at: startedAt, finished_at: new Date().toISOString(),
      status, detail: { ...sliceDetail, total: companies.length, ok, failures },
    });

    return new Response(JSON.stringify({ ...sliceDetail, total: companies.length, ok, failures }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    await supabase.from("rb_job_runs").insert({
      job_name: "rb-refresh", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "error", detail: { ...sliceDetail, error: String(e), ok, failures },
    });
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
