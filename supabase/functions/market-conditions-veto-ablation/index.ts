import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeMarketConditionsHistory } from "../_shared/marketConditions/scoring.ts";
import { MC_CONFIG } from "../_shared/marketConditions/config.ts";
import { alignWithForwardFill, SeriesRowWithPublish } from "../_shared/marketConditions/normalize.ts";

// Market Conditions Overlay — TIER veto ablation (mc-1.4.0 entry-rule
// round, 2026-09-30). DIAGNOSTIC, not tuning: tests whether the tier-level
// stress veto (stepTierState capping exposure at DEFENSIVE-or-worse when
// vetoActive -- a SEPARATE mechanism from the entry-signal E-VETO rule
// removed this same round for failing its own validation) is itself
// pulling its weight, using cfg.veto.disabled (scoring.ts, default false,
// zero effect on every other caller in this repo).
//
// Pre-registered rule (from the request, not chosen after seeing a
// result): remove the tier veto ONLY IF disabling it improves Calmar on
// SPY full period AND on 3+ of the other 3 markets AND doesn't worsen max
// DD in any bear episode by more than 2 points. Otherwise keep it. This
// function reports the numbers; the keep/remove decision itself, and any
// resulting config change, happens in DECISIONS.md/config.ts, not here.
//
// One market + one variant (veto on/off) per invocation -- same
// WORKER_RESOURCE_LIMIT-avoidance pattern as every backtest function this
// round.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_CARRY_DAYS = 3;
const TURNOVER_COST = 0.0005;
const SUB_PERIOD_SPLIT = "2008-12-31";

const MARKET_START: Record<string, string> = {
  SPY: "1996-02-23",
  QQQ: "1999-03-10",
  IWM: "2000-05-26",
  EFA: "2001-08-27",
};

const BEAR_EPISODES: { label: string; from: string; to: string }[] = [
  { label: "2000-02 (dot-com)", from: "2000-03-24", to: "2002-10-09" },
  { label: "2007-09 (GFC)", from: "2007-10-09", to: "2009-03-09" },
  { label: "2020 (COVID)", from: "2020-02-19", to: "2020-03-23" },
  { label: "2022", from: "2022-01-03", to: "2022-10-12" },
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

function statsFromReturns(rets: number[]) {
  const n = rets.length;
  let value = 1, peak = 1, maxDD = 0;
  const ddSeries: number[] = [];
  for (const r of rets) {
    value *= (1 + r);
    peak = Math.max(peak, value);
    const dd = value / peak - 1;
    ddSeries.push(dd);
    maxDD = Math.min(maxDD, dd);
  }
  const years = n / 252;
  const cagr = Math.pow(value, 1 / years) - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : NaN;
  return {
    stats: {
      cagrPct: Math.round(cagr * 10000) / 100, volPct: Math.round(vol * 10000) / 100,
      maxDrawdownPct: Math.round(maxDD * 10000) / 100, calmar: Math.round(calmar * 100) / 100, tradingDays: n,
    },
    ddSeries,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const market = (url.searchParams.get("market") ?? "SPY").toUpperCase();
    const vetoOff = (url.searchParams.get("veto") ?? "on").toLowerCase() === "off";
    if (!MARKET_START[market]) throw new Error(`unknown market ${market}, expected one of ${Object.keys(MARKET_START).join(",")}`);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const [priceRows, vixRows, vix3mRows, baa10yRows, dtb3Rows] = await Promise.all([
      fetchAllPrices(supabase, market),
      fetchAllSeries(supabase, "VIXCLS"),
      fetchAllSeries(supabase, "VIX3M"),
      fetchAllSeries(supabase, "BAA10Y"),
      fetchRateSeries(supabase, "DTB3"),
    ]);
    if (priceRows.length === 0) throw new Error(`no price history for ${market}`);

    const dates = priceRows.map((r) => r.date);
    const closes = priceRows.map((r) => r.close);
    const n = dates.length;

    const vixFF = alignWithForwardFill(dates, vixRows, MAX_CARRY_DAYS);
    const vix3mFF = alignWithForwardFill(dates, vix3mRows, MAX_CARRY_DAYS);
    const baa10yFF = alignWithForwardFill(dates, baa10yRows, MAX_CARRY_DAYS);
    const vix = vixFF.map((r) => r.value);
    const vix3m = vix3mFF.map((r) => r.value);
    const creditSpread = baa10yFF.map((r) => r.value);

    const cfg = vetoOff ? { ...MC_CONFIG, veto: { ...MC_CONFIG.veto, disabled: true } } : MC_CONFIG;
    const rows = computeMarketConditionsHistory({ dates, closes, vix, vix3m, creditSpread }, cfg);
    const expByDate = new Map(rows.map((r) => [r.date, r.exposureMultiplier]));

    const dtb3ByDate = new Map(dtb3Rows.map((r) => [r.date, r.value]));
    let lastRate: number | null = null;
    const rateAt = (t: number): number => {
      const v = dtb3ByDate.get(dates[t]);
      if (v != null) lastRate = v;
      return lastRate ?? 0;
    };

    const dailyRet: number[] = [NaN];
    for (let i = 1; i < n; i++) dailyRet.push(closes[i] / closes[i - 1] - 1);

    const startDate = MARKET_START[market];
    const startIdx = dates.findIndex((d) => d >= startDate);
    if (startIdx < 0) throw new Error("startDate not found with enough history");

    function runFixedExposure(from: number, to: number) {
      const rets: number[] = []; const usedDates: string[] = [];
      let prevExposure = 0;
      for (let t = from; t < to; t++) {
        const exposure = expByDate.get(dates[t]) ?? prevExposure;
        const cost = Math.abs(exposure - prevExposure) * TURNOVER_COST;
        const rate = rateAt(t);
        const ret = exposure * dailyRet[t + 1] + (1 - exposure) * (rate / 100 / 252) - cost;
        rets.push(ret); usedDates.push(dates[t + 1]);
        prevExposure = exposure;
      }
      return { rets, usedDates };
    }

    const fullRun = runFixedExposure(startIdx, n - 1);
    const fullResult = statsFromReturns(fullRun.rets);
    const ddByDate = new Map(fullRun.usedDates.map((d, i) => [d, fullResult.ddSeries[i]]));

    let subPeriods: Record<string, unknown> | null = null;
    if (market === "SPY") {
      const sliceStats = (from: string, to: string) => {
        const idxs: number[] = [];
        for (let i = 0; i < fullRun.usedDates.length; i++) if (fullRun.usedDates[i] >= from && fullRun.usedDates[i] <= to) idxs.push(i);
        if (idxs.length === 0) return null;
        return statsFromReturns(idxs.map((i) => fullRun.rets[i])).stats;
      };
      subPeriods = {
        "1996-02-23_to_2008-12-31": sliceStats("1996-02-23", SUB_PERIOD_SPLIT),
        "2009-01-01_to_present": sliceStats("2009-01-01", dates[n - 1]),
      };
    }

    const bearEpisodes = BEAR_EPISODES.map((ep) => {
      let minDD = 0;
      for (const [d, dd] of ddByDate) { if (d >= ep.from && d <= ep.to && dd < minDD) minDD = dd; }
      return { episode: ep.label, from: ep.from, to: ep.to, maxDrawdownPct: Math.round(minDD * 10000) / 100 };
    });

    return new Response(JSON.stringify({
      note: "DIAGNOSTIC, not tuning. mc-1.4.0 config, tier veto toggled via cfg.veto.disabled -- everything else (trend cap, floor, fast-path, hysteresis, entry signals) identical between the two variants. Pre-registered keep/remove rule: remove the tier veto only if disabling it improves SPY full-period Calmar AND 3+ of the other 3 markets' Calmar AND doesn't worsen any bear-episode max DD by more than 2 points.",
      market, vetoOff,
      window: { from: dates[startIdx], to: dates[n - 1] },
      fullPeriod: fullResult.stats,
      subPeriods,
      bearEpisodeMaxDrawdownPct: bearEpisodes,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
