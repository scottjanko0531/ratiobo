import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Market Conditions Overlay — PRELIMINARY, IN-SAMPLE backtest, requested to
// compare mc-1.1.0/mc-1.2.0/mc-1.3.0 side by side against buy-and-hold and
// the spec's own 200-day-rule baseline (100% SPX above SMA200, 25% below).
// Explicitly preliminary: single-path (not walk-forward-tuned against an
// out-of-sample split), 1996-02-23 to present, no claim of forward
// validity. Standalone, curl-invoked, not wired into production -- same
// pattern as this repo's other *-backtest functions.
//
// Mechanics: overlay exposure_multiplier for date t is applied to the
// t -> t+1 return (spec's own "signal at close t, applied t+1" rule,
// Section 10). 5bp cost per unit of turnover (|Δexposure|), charged on the
// day the new position takes effect. Residual (1 - exposure) earns DTB3's
// daily-equivalent yield. 200-day-rule uses the exact same mechanics
// (t+1 lag, 5bp turnover cost, DTB3 residual) so the comparison isolates
// the SIGNAL, not different cost/lag treatment.
//
// exposure_multiplier per date, per version, is read from THREE different
// places since market_conditions_scores is a full-rebuild table that no
// longer holds mc-1.1.0/mc-1.2.0's history: mc_signal_log (append-only,
// frozen at mc-1.1.0 forever), mc_scores_snapshot_mc120 (a one-off manual
// snapshot taken before the mc-1.3.0 recompute), and market_conditions_scores
// itself (live, currently mc-1.3.0).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const START_DATE = "1996-02-23";
const TURNOVER_COST = 0.0005; // 5bp per unit of turnover

type PriceRow = { date: string; close: number };
type ExposureRow = { date: string; exposure_multiplier: number };
type RateRow = { date: string; value: number };

async function fetchAllPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<PriceRow[]> {
  let rows: PriceRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("asset_price_history").select("date, close")
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
  let from = 0;
  const pageSize = 1000;
  const map = new Map<string, number>();
  while (true) {
    const { data, error } = await supabase
      .from(table).select("date, exposure_multiplier")
      .order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} read: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as ExposureRow[]) map.set(r.date, Number(r.exposure_multiplier));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

async function fetchDtb3(supabase: ReturnType<typeof createClient>): Promise<RateRow[]> {
  let from = 0;
  const pageSize = 1000;
  let rows: RateRow[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("mc_series_daily").select("date, value")
      .eq("series_id", "DTB3").order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`DTB3 read: ${error.message}`);
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

function computeStats(rets: number[], exposures: number[]) {
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
  let totalTurnover = 0;
  for (let i = 1; i < exposures.length; i++) totalTurnover += Math.abs(exposures[i] - exposures[i - 1]);
  const annualTurnover = totalTurnover / years;
  return {
    cagrPct: Math.round(cagr * 10000) / 100,
    volPct: Math.round(vol * 10000) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 10000) / 100,
    calmar: Math.round(calmar * 100) / 100,
    annualTurnover: Math.round(annualTurnover * 100) / 100,
    finalMultiple: Math.round(value * 100) / 100,
    tradingDays: n,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const [spyRows, dtb3Rows, exp110, exp120, exp130] = await Promise.all([
      fetchAllPrices(supabase, "SPY"),
      fetchDtb3(supabase),
      fetchExposure(supabase, "mc_signal_log"),
      fetchExposure(supabase, "mc_scores_snapshot_mc120"),
      fetchExposure(supabase, "market_conditions_scores"),
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
    if (startIdx < 1) throw new Error("START_DATE not found in SPY calendar with enough history");

    // Exposure series, indexed by t (the day the exposure was DECIDED,
    // applied to day t+1's return per the spec's own t+1 lag rule).
    function overlayExposure(expMap: Map<string, number>): (number | null)[] {
      return dates.map((d) => expMap.get(d) ?? null);
    }
    const exp110Series = overlayExposure(exp110);
    const exp120Series = overlayExposure(exp120);
    const exp130Series = overlayExposure(exp130);
    const rule200Series: (number | null)[] = dates.map((_, t) => (sma200[t] == null ? null : (closes[t] > sma200[t]! ? 1.0 : 0.25)));
    const buyHoldSeries: (number | null)[] = dates.map(() => 1.0);

    function runPortfolio(expSeries: (number | null)[]) {
      const rets: number[] = [];
      const exposuresUsed: number[] = [];
      let prevExposure = 0;
      for (let t = startIdx; t < n - 1; t++) {
        const exposure = expSeries[t] ?? prevExposure; // hold prior exposure through any gap rather than assume 0
        const turnover = Math.abs(exposure - prevExposure);
        const cost = turnover * TURNOVER_COST;
        const rate = rateAt(t);
        const ret = exposure * dailyRet[t + 1] + (1 - exposure) * (rate / 100 / 252) - cost;
        rets.push(ret);
        exposuresUsed.push(exposure);
        prevExposure = exposure;
      }
      return computeStats(rets, exposuresUsed);
    }

    const result = {
      window: { from: dates[startIdx], to: dates[n - 1] },
      note: "PRELIMINARY / IN-SAMPLE. Signal at close(t) applied t+1, 5bp turnover cost, residual in DTB3. Not walk-forward-tuned, no out-of-sample claim.",
      buyAndHoldSPY: runPortfolio(buyHoldSeries),
      rule200Day: runPortfolio(rule200Series),
      overlay_mc110: runPortfolio(exp110Series),
      overlay_mc120: runPortfolio(exp120Series),
      overlay_mc130: runPortfolio(exp130Series),
    };

    return new Response(JSON.stringify(result, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
