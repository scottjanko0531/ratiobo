import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Market Conditions Overlay — robustness round (mc-1.3.0 frozen baseline).
// IN-SAMPLE, preliminary, same disclaimers as market-conditions-backtest-
// preliminary. Adds: (1) a vol-matched static SPX/T-bill benchmark
// (monthly-rebalanced, equity weight found by bisection to match
// mc-1.3.0's own realized vol over the full window), (2) the same metrics
// table split into two sub-periods (1996-02-23..2008-12-31,
// 2009-01-01..present), (3) max drawdown per named bear episode, using the
// CONTINUOUS running peak from the start of the full backtest (not reset
// at each episode's window start) so a portfolio that peaked slightly
// before an episode's labeled start still gets credited with the real
// peak-to-trough decline.
//
// Standalone, curl-invoked, not wired into production.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const START_DATE = "1996-02-23";
const SUB_PERIOD_SPLIT = "2008-12-31"; // period 1 ends here, period 2 starts 2009-01-01
const TURNOVER_COST = 0.0005;

const BEAR_EPISODES: { label: string; from: string; to: string }[] = [
  { label: "2000-02 (dot-com)", from: "2000-03-24", to: "2002-10-09" },
  { label: "2007-09 (GFC)", from: "2007-10-09", to: "2009-03-09" },
  { label: "2020 (COVID)", from: "2020-02-19", to: "2020-03-23" },
  { label: "2022", from: "2022-01-03", to: "2022-10-12" },
];

type PriceRow = { date: string; close: number };
type ExposureRow = { date: string; exposure_multiplier: number };
type RateRow = { date: string; value: number };

async function fetchAllPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<PriceRow[]> {
  let rows: PriceRow[] = []; let from = 0; const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from("asset_price_history").select("date, close")
      .eq("symbol", symbol).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`asset_price_history read: ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, close: Number(r.close) })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchExposure(supabase: ReturnType<typeof createClient>, table: string): Promise<Map<string, number>> {
  let from = 0; const pageSize = 1000; const map = new Map<string, number>();
  while (true) {
    const { data, error } = await supabase.from(table).select("date, exposure_multiplier")
      .order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} read: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as ExposureRow[]) map.set(r.date, Number(r.exposure_multiplier));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

async function fetchSeries(supabase: ReturnType<typeof createClient>, seriesId: string): Promise<RateRow[]> {
  let from = 0; const pageSize = 1000; let rows: RateRow[] = [];
  while (true) {
    const { data, error } = await supabase.from("mc_series_daily").select("date, value")
      .eq("series_id", seriesId).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`${seriesId} read: ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, value: Number(r.value) })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function sma(values: number[], t: number, n: number): number | null {
  if (t - n + 1 < 0) return null;
  let s = 0;
  for (let i = t - n + 1; i <= t; i++) s += values[i];
  return s / n;
}

// Per-day return series -> stats, PLUS the full drawdown series (so bear-
// episode drawdowns can be sliced from the same continuous running peak
// rather than resetting to 1 at an arbitrary window start).
function computeStatsWithDrawdownSeries(dates: string[], rets: number[], exposures: number[]) {
  const n = rets.length;
  let value = 1, peak = 1;
  const ddSeries: number[] = [];
  for (const r of rets) {
    value *= (1 + r);
    peak = Math.max(peak, value);
    ddSeries.push(value / peak - 1);
  }
  const maxDD = Math.min(...ddSeries);
  const years = n / 252;
  const cagr = Math.pow(value, 1 / years) - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  const sharpe = vol !== 0 ? cagr / vol : NaN;
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : NaN;
  let totalTurnover = 0;
  for (let i = 1; i < exposures.length; i++) totalTurnover += Math.abs(exposures[i] - exposures[i - 1]);
  return {
    stats: {
      cagrPct: Math.round(cagr * 10000) / 100, volPct: Math.round(vol * 10000) / 100,
      sharpe: Math.round(sharpe * 100) / 100, maxDrawdownPct: Math.round(maxDD * 10000) / 100,
      calmar: Math.round(calmar * 100) / 100, annualTurnover: Math.round((totalTurnover / years) * 100) / 100,
      finalMultiple: Math.round(value * 100) / 100, tradingDays: n,
    },
    ddByDate: new Map(dates.map((d, i) => [d, ddSeries[i]])),
  };
}

function statsForSlice(dates: string[], rets: number[], exposures: number[], from: string, to: string) {
  const idxs: number[] = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= from && dates[i] <= to) idxs.push(i);
  if (idxs.length === 0) return null;
  const slicedDates = idxs.map((i) => dates[i]);
  const slicedRets = idxs.map((i) => rets[i]);
  const slicedExp = idxs.map((i) => exposures[i]);
  return computeStatsWithDrawdownSeries(slicedDates, slicedRets, slicedExp).stats;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const [spyRows, dtb3Rows, expOverlay] = await Promise.all([
      fetchAllPrices(supabase, "SPY"),
      fetchSeries(supabase, "DTB3"),
      fetchExposure(supabase, "market_conditions_scores"), // live = mc-1.3.0
    ]);

    const dates = spyRows.map((r) => r.date);
    const closes = spyRows.map((r) => r.close);
    const n = dates.length;
    const sma200: (number | null)[] = dates.map((_, t) => sma(closes, t, 200));

    const dtb3ByDate = new Map(dtb3Rows.map((r) => [r.date, r.value]));
    let lastRate: number | null = null;
    const rateAt = (t: number): number => {
      const v = dtb3ByDate.get(dates[t]);
      if (v != null) lastRate = v;
      return lastRate ?? 0;
    };

    const dailyRet: number[] = [NaN];
    for (let i = 1; i < n; i++) dailyRet.push(closes[i] / closes[i - 1] - 1);

    const startIdx = dates.findIndex((d) => d >= START_DATE);
    if (startIdx < 1) throw new Error("START_DATE not found with enough history");

    // Month-start indices, for the vol-matched benchmark's monthly rebalance.
    const isFirstTradingDayOfMonth = (t: number) => t === 0 || dates[t].slice(0, 7) !== dates[t - 1].slice(0, 7);

    function runFixedExposure(expSeries: (number | null)[]) {
      const rets: number[] = []; const exposuresUsed: number[] = []; const usedDates: string[] = [];
      let prevExposure = 0;
      for (let t = startIdx; t < n - 1; t++) {
        const exposure = expSeries[t] ?? prevExposure;
        const cost = Math.abs(exposure - prevExposure) * TURNOVER_COST;
        const rate = rateAt(t);
        const ret = exposure * dailyRet[t + 1] + (1 - exposure) * (rate / 100 / 252) - cost;
        rets.push(ret); exposuresUsed.push(exposure); usedDates.push(dates[t + 1]);
        prevExposure = exposure;
      }
      return { rets, exposuresUsed, usedDates };
    }

    // Static w/(1-w) SPY/cash, rebalanced to w at the first trading day of
    // each month (drifts between rebalances, same convention as the KISS
    // backtest's monthly-rebalance variant elsewhere in this repo).
    function runStaticMix(w: number) {
      const rets: number[] = []; const exposuresUsed: number[] = []; const usedDates: string[] = [];
      let equityW = w, cashW = 1 - w; // dollar weights, drift with price
      for (let t = startIdx; t < n - 1; t++) {
        const rate = rateAt(t);
        const total = equityW + cashW;
        const ret = (equityW / total) * dailyRet[t + 1] + (cashW / total) * (rate / 100 / 252);
        rets.push(ret); exposuresUsed.push(equityW / total); usedDates.push(dates[t + 1]);
        equityW *= (1 + dailyRet[t + 1]); cashW *= (1 + rate / 100 / 252);
        if (isFirstTradingDayOfMonth(t + 1)) {
          const newTotal = equityW + cashW;
          equityW = w * newTotal; cashW = (1 - w) * newTotal;
        }
      }
      return { rets, exposuresUsed, usedDates };
    }

    const overlaySeries: (number | null)[] = dates.map((d) => expOverlay.get(d) ?? null);
    const overlayRun = runFixedExposure(overlaySeries);
    const overlayResult = computeStatsWithDrawdownSeries(overlayRun.usedDates, overlayRun.rets, overlayRun.exposuresUsed);
    const targetVol = overlayResult.stats.volPct / 100;

    // Bisection on equity weight w in [0,1] to match targetVol.
    let lo = 0, hi = 1, bestW = 0.5;
    for (let iter = 0; iter < 30; iter++) {
      const mid = (lo + hi) / 2;
      const midRun = runStaticMix(mid);
      const midVol = computeStatsWithDrawdownSeries(midRun.usedDates, midRun.rets, midRun.exposuresUsed).stats.volPct / 100;
      bestW = mid;
      if (midVol < targetVol) lo = mid; else hi = mid;
    }
    const volMatchedRun = runStaticMix(bestW);
    const volMatchedResult = computeStatsWithDrawdownSeries(volMatchedRun.usedDates, volMatchedRun.rets, volMatchedRun.exposuresUsed);

    const rule200Series: (number | null)[] = dates.map((_, t) => (sma200[t] == null ? null : (closes[t] > sma200[t]! ? 1.0 : 0.25)));
    const rule200Run = runFixedExposure(rule200Series);
    const rule200Result = computeStatsWithDrawdownSeries(rule200Run.usedDates, rule200Run.rets, rule200Run.exposuresUsed);

    const buyHoldSeries: (number | null)[] = dates.map(() => 1.0);
    const buyHoldRun = runFixedExposure(buyHoldSeries);
    const buyHoldResult = computeStatsWithDrawdownSeries(buyHoldRun.usedDates, buyHoldRun.rets, buyHoldRun.exposuresUsed);

    const portfolios: { name: string; run: { rets: number[]; exposuresUsed: number[]; usedDates: string[] }; ddByDate: Map<string, number> }[] = [
      { name: "overlay_mc130", run: overlayRun, ddByDate: overlayResult.ddByDate },
      { name: "volMatchedStatic", run: volMatchedRun, ddByDate: volMatchedResult.ddByDate },
      { name: "rule200Day", run: rule200Run, ddByDate: rule200Result.ddByDate },
      { name: "buyAndHoldSPY", run: buyHoldRun, ddByDate: buyHoldResult.ddByDate },
    ];

    const subPeriods = {
      "1996-02-23_to_2008-12-31": portfolios.reduce((acc, p) => {
        acc[p.name] = statsForSlice(p.run.usedDates, p.run.rets, p.run.exposuresUsed, START_DATE, SUB_PERIOD_SPLIT);
        return acc;
      }, {} as Record<string, unknown>),
      "2009-01-01_to_present": portfolios.reduce((acc, p) => {
        acc[p.name] = statsForSlice(p.run.usedDates, p.run.rets, p.run.exposuresUsed, "2009-01-01", dates[n - 1]);
        return acc;
      }, {} as Record<string, unknown>),
    };

    const bearEpisodes = BEAR_EPISODES.map((ep) => {
      const row: Record<string, unknown> = { episode: ep.label, from: ep.from, to: ep.to };
      for (const p of portfolios) {
        let minDD = 0;
        for (const [d, dd] of p.ddByDate) { if (d >= ep.from && d <= ep.to && dd < minDD) minDD = dd; }
        row[p.name] = Math.round(minDD * 10000) / 100;
      }
      return row;
    });

    return new Response(JSON.stringify({
      note: "PRELIMINARY / IN-SAMPLE. mc-1.3.0 frozen baseline (live market_conditions_scores). Vol-matched static mix weight found by bisection against mc-1.3.0's own realized vol, then held fixed across sub-periods/episodes.",
      window: { from: dates[startIdx], to: dates[n - 1] },
      volMatchedEquityWeightPct: Math.round(bestW * 1000) / 10,
      fullPeriod: {
        overlay_mc130: overlayResult.stats,
        volMatchedStatic: volMatchedResult.stats,
        rule200Day: rule200Result.stats,
        buyAndHoldSPY: buyHoldResult.stats,
      },
      subPeriods,
      bearEpisodeMaxDrawdownPct: bearEpisodes,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
