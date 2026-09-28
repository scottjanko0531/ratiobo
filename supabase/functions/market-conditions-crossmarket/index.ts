import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeMarketConditionsHistory } from "../_shared/marketConditions/scoring.ts";
import { MC_CONFIG } from "../_shared/marketConditions/config.ts";
import { alignWithForwardFill, SeriesRowWithPublish } from "../_shared/marketConditions/normalize.ts";

// Market Conditions Overlay — cross-market test (mc-1.3.0 frozen baseline,
// robustness round task 4). NOT in-sample in the same sense as the other
// robustness-round outputs: mc-1.3.0's config was tuned entirely against
// SPX/SPY history, then applied UNCHANGED here to three other equity
// markets (QQQ, IWM, EFA) for their Trend pillar, while the Stress pillar
// keeps using the SAME US VIX/VIX3M/BAA10Y series (the point being to test
// whether a US-regime stress read still adds value when timing entries into
// a different market, not to build a QQQ-specific or EFA-specific stress
// pillar). Genuinely out-of-sample in the sense that matters here: nothing
// about mc-1.3.0's thresholds/weights/state machine was fit to these three
// tickers' price history.
//
// Each market's own close series drives Trend (SMA200/slope/momentum/
// 10-month rule) and its own SMA50 (recovery fast-path). Composite/tier/
// hysteresis/veto/floor/fast-path logic is bit-for-bit the same code path
// as market-conditions-compute, just with `dates`/`closes` swapped to the
// target ticker (dates re-aligned to that ticker's OWN trading calendar,
// not forced onto SPY's -- QQQ/IWM/EFA don't all share SPY's exact holiday/
// listing calendar, and computeTrendRawSeries's month-end logic depends on
// `dates` being the series' own calendar).
//
// Standalone, curl-invoked, not wired into production.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_CARRY_DAYS = 3;
const TURNOVER_COST = 0.0005;

const MARKETS: { symbol: string; startDate: string }[] = [
  { symbol: "QQQ", startDate: "1999-03-10" },
  { symbol: "IWM", startDate: "2000-05-26" },
  { symbol: "EFA", startDate: "2001-08-27" },
];

type PriceRow = { date: string; close: number };
type RateRow = { date: string; value: number };

async function fetchAllPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<PriceRow[]> {
  let rows: PriceRow[] = []; let from = 0; const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from("asset_price_history").select("date, close")
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
  let rows: SeriesRowWithPublish[] = []; let from = 0; const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from("mc_series_daily").select("date, value, published_at")
      .eq("series_id", seriesId).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`mc_series_daily read (${seriesId}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, value: Number(r.value), published_at: r.published_at as string })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchRateSeries(supabase: ReturnType<typeof createClient>, seriesId: string): Promise<RateRow[]> {
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

function statsFromReturns(rets: number[]) {
  const n = rets.length;
  let value = 1, peak = 1, maxDD = 0;
  for (const r of rets) {
    value *= (1 + r);
    peak = Math.max(peak, value);
    maxDD = Math.min(maxDD, value / peak - 1);
  }
  const years = n / 252;
  const cagr = Math.pow(value, 1 / years) - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  const sharpe = vol !== 0 ? cagr / vol : NaN;
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : NaN;
  return {
    cagrPct: Math.round(cagr * 10000) / 100, volPct: Math.round(vol * 10000) / 100,
    sharpe: Math.round(sharpe * 100) / 100, maxDrawdownPct: Math.round(maxDD * 10000) / 100,
    calmar: Math.round(calmar * 100) / 100, finalMultiple: Math.round(value * 100) / 100, tradingDays: n,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Running all three markets in one invocation hit WORKER_RESOURCE_LIMIT
    // (same class of issue as market-conditions-sensitivity, just from
    // cumulative work across markets rather than variants) -- ?symbol=
    // restricts a single invocation to one market, called three times from
    // the client side instead.
    const url = new URL(req.url);
    const onlySymbol = url.searchParams.get("symbol")?.toUpperCase();
    const markets = onlySymbol ? MARKETS.filter((m) => m.symbol === onlySymbol) : MARKETS;
    if (onlySymbol && markets.length === 0) throw new Error(`unknown symbol ${onlySymbol}, expected one of ${MARKETS.map((m) => m.symbol).join(",")}`);

    const [vixRows, vix3mRows, baa10yRows, dtb3Rows] = await Promise.all([
      fetchAllSeries(supabase, "VIXCLS"),
      fetchAllSeries(supabase, "VIX3M"),
      fetchAllSeries(supabase, "BAA10Y"),
      fetchRateSeries(supabase, "DTB3"),
    ]);
    const dtb3ByDate = new Map(dtb3Rows.map((r) => [r.date, r.value]));

    const marketResults: Record<string, unknown> = {};
    const dataGaps: Record<string, unknown> = {};

    for (const market of markets) {
      const priceRows = await fetchAllPrices(supabase, market.symbol);
      if (priceRows.length === 0) {
        marketResults[market.symbol] = { error: "no price history" };
        continue;
      }

      const dates = priceRows.map((r) => r.date);
      const closes = priceRows.map((r) => r.close);
      const n = dates.length;

      // Yahoo data-gap check: flag any run of >5 consecutive calendar days
      // with no trading-day row (a genuine gap, not an ordinary weekend or
      // single holiday).
      const gaps: { from: string; to: string; calendarDays: number }[] = [];
      for (let i = 1; i < n; i++) {
        const prev = new Date(dates[i - 1] + "T00:00:00Z").getTime();
        const cur = new Date(dates[i] + "T00:00:00Z").getTime();
        const calendarDays = Math.round((cur - prev) / 86400000);
        if (calendarDays > 5) gaps.push({ from: dates[i - 1], to: dates[i], calendarDays });
      }
      dataGaps[market.symbol] = gaps.length ? gaps : "none";

      const vixFF = alignWithForwardFill(dates, vixRows, MAX_CARRY_DAYS);
      const vix3mFF = alignWithForwardFill(dates, vix3mRows, MAX_CARRY_DAYS);
      const baa10yFF = alignWithForwardFill(dates, baa10yRows, MAX_CARRY_DAYS);
      const vix = vixFF.map((r) => r.value);
      const vix3m = vix3mFF.map((r) => r.value);
      const creditSpread = baa10yFF.map((r) => r.value);

      const rows = computeMarketConditionsHistory({ dates, closes, vix, vix3m, creditSpread }, MC_CONFIG);
      const expByDate = new Map(rows.map((r) => [r.date, r.exposureMultiplier]));

      const sma200: (number | null)[] = dates.map((_, t) => sma(closes, t, 200));
      const dailyRet: number[] = [NaN];
      for (let i = 1; i < n; i++) dailyRet.push(closes[i] / closes[i - 1] - 1);

      let lastRate: number | null = null;
      const rateAt = (t: number): number => {
        const v = dtb3ByDate.get(dates[t]);
        if (v != null) lastRate = v;
        return lastRate ?? 0;
      };

      // Unlike market-conditions-robustness (whose START_DATE sits well
      // after SPY's own earliest row), each market's startDate here IS its
      // earliest available row -- so startIdx legitimately lands on 0, not
      // just >=1. Only a genuine "not found at all" (-1) is an error.
      const startIdx = dates.findIndex((d) => d >= market.startDate);
      if (startIdx < 0) { marketResults[market.symbol] = { error: "startDate not found with enough history" }; continue; }

      function runFixedExposure(expSeries: (number | null)[]) {
        const rets: number[] = [];
        let prevExposure = 0;
        for (let t = startIdx; t < n - 1; t++) {
          const exposure = expSeries[t] ?? prevExposure;
          const cost = Math.abs(exposure - prevExposure) * TURNOVER_COST;
          const rate = rateAt(t);
          const ret = exposure * dailyRet[t + 1] + (1 - exposure) * (rate / 100 / 252) - cost;
          rets.push(ret);
          prevExposure = exposure;
        }
        return rets;
      }

      const overlaySeries: (number | null)[] = dates.map((d) => expByDate.get(d) ?? null);
      const overlayStats = statsFromReturns(runFixedExposure(overlaySeries));

      const rule200Series: (number | null)[] = dates.map((_, t) => (sma200[t] == null ? null : (closes[t] > sma200[t]! ? 1.0 : 0.25)));
      const rule200Stats = statsFromReturns(runFixedExposure(rule200Series));

      const buyHoldSeries: (number | null)[] = dates.map(() => 1.0);
      const buyHoldStats = statsFromReturns(runFixedExposure(buyHoldSeries));

      marketResults[market.symbol] = {
        window: { from: dates[startIdx], to: dates[n - 1] },
        overlay_mc130: overlayStats,
        rule200Day: rule200Stats,
        buyAndHold: buyHoldStats,
      };
    }

    return new Response(JSON.stringify({
      note: "Cross-market test, mc-1.3.0 config UNCHANGED from its SPX-tuned baseline -- only the Trend pillar's price series is swapped (each market's own close/SMA200/SMA50/momentum); Stress pillar stays on the same US VIX/VIX3M/BAA10Y series. Not in-sample in the sense the rest of this robustness round is -- nothing here was fit to QQQ/IWM/EFA. Turnover cost 5bp, DTB3 cash residual, same conventions as market-conditions-robustness.",
      results: marketResults,
      dataGaps,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
