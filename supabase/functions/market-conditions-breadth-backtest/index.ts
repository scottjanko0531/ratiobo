import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeMarketConditionsHistory } from "../_shared/marketConditions/scoring.ts";
import { MC_CONFIG, TIER_ORDER, NORMAL_IDX, CAUTIOUS_IDX } from "../_shared/marketConditions/config.ts";
import { alignWithForwardFill, SeriesRowWithPublish } from "../_shared/marketConditions/normalize.ts";
import { computeProxyBreadthRawSeries, scoreProxyBreadthAtIndex } from "../_shared/marketConditions/indicators/breadth.ts";

// Market Conditions Overlay — breadth with/without-comparison backtest
// (Phase 2, "proxy pillar" round, 2026-09-30). One market + one variant
// (breadth on/off) per invocation -- running more in a single invocation
// hit WORKER_RESOURCE_LIMIT in the prior robustness/cross-market rounds,
// same cumulative-CPU-budget issue, same fix (query-param scoped to one
// unit of work).
//
// The proxy breadth pillar (indicators/breadth.ts: PB1/PB2/PB3 +
// divergence, built from the 9 original sector SPDRs + RSP/SPY) is
// computed on SPY's own calendar (divergence is explicitly an SPY-vs-its-
// own-252d-high condition) and then aligned onto the TARGET market's
// calendar via the same forward-fill mechanism already used for VIXCLS/
// VIX3M/BAA10Y -- so a QQQ/IWM/EFA run reuses the identical US-market
// breadth read, exactly parallel to how the Stress pillar stayed on the
// same US VIX/BAA10Y series in the earlier cross-market test.
//
// mc-1.3.0's own config (frozen baseline) is used unchanged except for
// whether `breadthScore` is populated -- pillarWeights.breadth is already
// 0.25 in MC_CONFIG, so passing it in is the only difference between the
// "with" and "without" variant; the composite's cross-pillar
// redistribution (scoring.ts) does the renormalization automatically.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_CARRY_DAYS = 3;
const TURNOVER_COST = 0.0005;
const SUB_PERIOD_SPLIT = "2008-12-31";

const SPDR_SYMBOLS = ["XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY"];

const MARKET_START: Record<string, string> = {
  SPY: "1996-02-23", // matches market-conditions-robustness's own START_DATE
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

// Simplified recovery-lag anchors: first date tier reaches NORMAL-or-
// better on/after each bottom, with vs without breadth -- a single
// comparable number rather than the mc-1.2.0/1.3.0 round's full 5-
// constraint diagnostic (out of scope for a keep-or-drop decision that
// only needs Calmar/maxDD, not the full mechanism breakdown).
const RECOVERY_ANCHORS: { label: string; bottom: string }[] = [
  { label: "2002-10-09 bottom", bottom: "2002-10-09" },
  { label: "2009-03-09 bottom", bottom: "2009-03-09" },
  { label: "2020-03-23 bottom", bottom: "2020-03-23" },
  { label: "2022-10-12 bottom", bottom: "2022-10-12" },
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
  const sharpe = vol !== 0 ? cagr / vol : NaN;
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : NaN;
  return {
    stats: {
      cagrPct: Math.round(cagr * 10000) / 100, volPct: Math.round(vol * 10000) / 100,
      sharpe: Math.round(sharpe * 100) / 100, maxDrawdownPct: Math.round(maxDD * 10000) / 100,
      calmar: Math.round(calmar * 100) / 100, tradingDays: n,
    },
    ddSeries,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const market = (url.searchParams.get("market") ?? "SPY").toUpperCase();
    const breadthOn = (url.searchParams.get("breadth") ?? "without").toLowerCase() === "with";
    if (!MARKET_START[market]) throw new Error(`unknown market ${market}, expected one of ${Object.keys(MARKET_START).join(",")}`);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const fetches: Promise<unknown>[] = [
      fetchAllPrices(supabase, market),
      fetchAllSeries(supabase, "VIXCLS"),
      fetchAllSeries(supabase, "VIX3M"),
      fetchAllSeries(supabase, "BAA10Y"),
      fetchRateSeries(supabase, "DTB3"),
    ];
    if (breadthOn) {
      fetches.push(fetchAllPrices(supabase, "SPY"));
      fetches.push(fetchAllPrices(supabase, "RSP"));
      for (const sym of SPDR_SYMBOLS) fetches.push(fetchAllPrices(supabase, sym));
    }
    const results = await Promise.all(fetches);
    const marketRows = results[0] as PriceRow[];
    const vixRows = results[1] as SeriesRowWithPublish[];
    const vix3mRows = results[2] as SeriesRowWithPublish[];
    const baa10yRows = results[3] as SeriesRowWithPublish[];
    const dtb3Rows = results[4] as RateRow[];

    const dates = marketRows.map((r) => r.date);
    const closes = marketRows.map((r) => r.close);
    const n = dates.length;

    const vixFF = alignWithForwardFill(dates, vixRows, MAX_CARRY_DAYS);
    const vix3mFF = alignWithForwardFill(dates, vix3mRows, MAX_CARRY_DAYS);
    const baa10yFF = alignWithForwardFill(dates, baa10yRows, MAX_CARRY_DAYS);
    const vix = vixFF.map((r) => r.value);
    const vix3m = vix3mFF.map((r) => r.value);
    const creditSpread = baa10yFF.map((r) => r.value);

    let breadthScore: (number | null)[] | undefined = undefined;
    if (breadthOn) {
      const spyRows = results[5] as PriceRow[];
      const rspRows = results[6] as PriceRow[];
      const spdrRowsList = results.slice(7) as PriceRow[][];

      const spyDates = spyRows.map((r) => r.date);
      const spyCloses = spyRows.map((r) => r.close);

      const rspByDate = new Map(rspRows.map((r) => [r.date, r.close]));
      const rspAligned: (number | null)[] = spyDates.map((d) => rspByDate.get(d) ?? null);

      const spdrAligned: (number | null)[][] = spdrRowsList.map((rows) => {
        const byDate = new Map(rows.map((r) => [r.date, r.close]));
        return spyDates.map((d) => byDate.get(d) ?? null);
      });

      const breadthRaw = computeProxyBreadthRawSeries(spyDates, spyCloses, spdrAligned, rspAligned);
      const breadthScoreBySpyDate = new Map<string, number>();
      for (let t = 0; t < spyDates.length; t++) {
        const s = scoreProxyBreadthAtIndex(breadthRaw, t, MC_CONFIG).pillarScore;
        if (s != null) breadthScoreBySpyDate.set(spyDates[t], s);
      }

      // Align the SPY-native breadth score onto the target market's
      // calendar, same forward-fill mechanism as the daily FRED series
      // (breadth is a "how's the US market breadth today" read, published
      // same-day as SPY's own close -- no genuine publish lag, just a
      // calendar-alignment convenience, same as VIXCLS/BAA10Y already get).
      const breadthAsSeriesRows: SeriesRowWithPublish[] = spyDates
        .filter((d) => breadthScoreBySpyDate.has(d))
        .map((d) => ({ date: d, value: breadthScoreBySpyDate.get(d)!, published_at: d }));
      const breadthFF = alignWithForwardFill(dates, breadthAsSeriesRows, MAX_CARRY_DAYS);
      breadthScore = breadthFF.map((r) => r.value);
    }

    const rows = computeMarketConditionsHistory({ dates, closes, vix, vix3m, creditSpread, breadthScore }, MC_CONFIG);
    const expByDate = new Map(rows.map((r) => [r.date, r.exposureMultiplier]));
    const tierByDate = new Map(rows.map((r) => [r.date, r.tier]));

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

    // Whipsaw: an upgrade to NORMAL-or-better that reverts to CAUTIOUS-or-
    // worse within 30 trading days -- same definition used in the mc-1.3.0
    // round's own report.
    let whipsawCount = 0;
    let wasNormalPlus = false;
    let normalPlusSinceIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const tierIdx = TIER_ORDER.indexOf(rows[i].tier);
      const isNormalPlus = tierIdx <= NORMAL_IDX;
      const isCautiousMinus = tierIdx >= CAUTIOUS_IDX;
      if (!wasNormalPlus && isNormalPlus) { normalPlusSinceIdx = i; }
      if (wasNormalPlus && isCautiousMinus && normalPlusSinceIdx >= 0 && (i - normalPlusSinceIdx) <= 30) whipsawCount++;
      wasNormalPlus = isNormalPlus;
    }

    const recoveryLag = RECOVERY_ANCHORS.map((a) => {
      const bottomIdx = dates.findIndex((d) => d >= a.bottom);
      if (bottomIdx < 0) return { anchor: a.label, note: "out of range for this market" };
      let normalDate: string | null = null;
      for (let i = bottomIdx; i < dates.length; i++) {
        const tierIdx = TIER_ORDER.indexOf(tierByDate.get(dates[i]) ?? "RISK_OFF");
        if (tierIdx <= NORMAL_IDX) { normalDate = dates[i]; break; }
      }
      return { anchor: a.label, tierReachedNormalOn: normalDate };
    });

    return new Response(JSON.stringify({
      note: "PRELIMINARY / IN-SAMPLE. mc-1.3.0 config, breadth pillar (proxy: PB1/PB2/PB3+divergence, 9 sector SPDRs + RSP/SPY) toggled on/off via pillarWeights.breadth (already 0.25 in MC_CONFIG). Recovery-lag simplified to a single 'tier reached NORMAL' date per bottom, not the full multi-constraint diagnostic from the mc-1.2.0/1.3.0 rounds.",
      market, breadthOn,
      window: { from: dates[startIdx], to: dates[n - 1] },
      fullPeriod: fullResult.stats,
      subPeriods,
      bearEpisodeMaxDrawdownPct: bearEpisodes,
      whipsawCount,
      recoveryLag,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
