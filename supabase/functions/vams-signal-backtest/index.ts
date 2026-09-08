import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// VAMS-equivalent backtest spec, Phase 1: does a volatility-adjusted
// momentum signal predict anything, standalone, before it's ever combined
// with the regime overlay or trusted to size real allocations?
//
// Not a port of 42 Macro's VAMS — their exact formula/thresholds are never
// published in the KISS deck (only colored output bands), so this is an
// original definition sharing the same concept (momentum normalized by the
// asset's own recent volatility), swept across candidate parameters and
// scored against real daily price history rather than assumed to work.
//
// Signal: for lookback L (trading days) and vol-lookback V, using daily log
// returns r[t] = ln(close[t] / close[t-1]):
//   momentum(t, L) = sum of r over the L days ending at t  (= ln(close[t]/close[t-L]))
//   dailyVol(t, V) = stdev of r over the V days ending at t
//   z(t) = momentum(t, L) / (dailyVol(t, V) * sqrt(L))
// z is a rolling t-stat-like quantity: how many standard deviations (under a
// random-walk null) has the asset moved over the last L days, given its own
// recent daily volatility. State = Bullish (z > +threshold), Bearish
// (z < -threshold), Neutral otherwise — same dead-band-classification
// pattern as GROWTH_MIN_GAP/CPI_MIN_GAP.
//
// Walk-forward, no look-ahead: state(t) uses only data through day t; it is
// then scored against the REALIZED return from t to t+N (N = forward
// horizon, tested at several candidates). z(t) itself never looks past t —
// only the scoring step looks forward, exactly like every other backtest
// this session (growth-axis-backtest, cpi-core-measures-backtest).
//
// This is a standalone diagnostic tool (curl-invoked for its JSON report),
// same pattern as the repo's other *-backtest edge functions — not wired
// into any page yet. Nothing here should be read as "the signal that ships"
// until the swept results are reviewed.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// L extended to 180/252 trading days (~9mo/12mo) after the first VT sweep
// found the 20-120 day window to be consistently mean-reverting, not
// momentum, for equities — classic momentum literature (Jegadeesh-Titman)
// finds the crossover from reversal to momentum happens around 6-12mo for
// stocks, past what was originally tested here.
const L_CANDIDATES = [20, 60, 90, 120, 180, 252]; // trading days (~1mo, 3mo, 4.5mo, 6mo, 9mo, 12mo)
const THRESHOLD_CANDIDATES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5];
// 60 (~3mo) added alongside the original 5/10/20 so a longer formation
// period (L=180/252) can be scored against a forward window on the same
// order of magnitude — scoring a 12mo-formation signal only 1-4 weeks
// forward would barely give the effect (if real) room to show up.
const FORWARD_HORIZONS = [5, 10, 20, 60]; // trading days (~1wk, 2wk, 1mo, 3mo)

type PriceRow = { date: string; close: number };

function dailyLogReturns(rows: PriceRow[]): number[] {
  const out: number[] = [NaN];
  for (let i = 1; i < rows.length; i++) {
    out.push(Math.log(rows[i].close / rows[i - 1].close));
  }
  return out;
}

function stdev(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return NaN;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

function classify(z: number, threshold: number): "bullish" | "neutral" | "bearish" {
  if (z > threshold) return "bullish";
  if (z < -threshold) return "bearish";
  return "neutral";
}

// For one (L, threshold) pair: walk forward over the whole series, compute
// z(t)/state(t) at every valid t, then for each forward horizon N compute
// the realized close[t+N]/close[t] - 1 return. Returns per-state buckets of
// forward returns per horizon, keyed by horizon.
function runSweep(rows: PriceRow[], L: number, threshold: number, V: number) {
  const logRet = dailyLogReturns(rows);
  const n = rows.length;
  const minStart = Math.max(L, V);
  const buckets: Record<number, Record<string, number[]>> = {};
  for (const N of FORWARD_HORIZONS) buckets[N] = { bullish: [], neutral: [], bearish: [] };
  let scored = 0;

  for (let t = minStart; t < n; t++) {
    const momWindow = logRet.slice(t - L + 1, t + 1);
    const volWindow = logRet.slice(t - V + 1, t + 1);
    if (momWindow.some((x) => Number.isNaN(x)) || volWindow.some((x) => Number.isNaN(x))) continue;
    const momentum = momWindow.reduce((a, b) => a + b, 0);
    const dailyVol = stdev(volWindow);
    if (!dailyVol || dailyVol === 0) continue;
    const z = momentum / (dailyVol * Math.sqrt(L));
    const state = classify(z, threshold);
    scored++;

    for (const N of FORWARD_HORIZONS) {
      if (t + N >= n) continue;
      const fwdReturn = rows[t + N].close / rows[t].close - 1;
      buckets[N][state].push(fwdReturn);
    }
  }

  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const hitRateUp = (arr: number[]) => (arr.length ? arr.filter((x) => x > 0).length / arr.length : null);
  const hitRateDown = (arr: number[]) => (arr.length ? arr.filter((x) => x < 0).length / arr.length : null);

  const byHorizon: Record<string, unknown> = {};
  for (const N of FORWARD_HORIZONS) {
    const b = buckets[N];
    const allFwd = [...b.bullish, ...b.neutral, ...b.bearish];
    const bullMean = mean(b.bullish), bearMean = mean(b.bearish);
    byHorizon[`N${N}`] = {
      n: { bullish: b.bullish.length, neutral: b.neutral.length, bearish: b.bearish.length },
      meanForwardReturnPct: {
        bullish: bullMean != null ? Math.round(bullMean * 10000) / 100 : null,
        neutral: mean(b.neutral) != null ? Math.round(mean(b.neutral)! * 10000) / 100 : null,
        bearish: bearMean != null ? Math.round(bearMean * 10000) / 100 : null,
        unconditional: mean(allFwd) != null ? Math.round(mean(allFwd)! * 10000) / 100 : null,
      },
      hitRatePct: {
        bullishUp: hitRateUp(b.bullish) != null ? Math.round(hitRateUp(b.bullish)! * 1000) / 10 : null,
        bearishDown: hitRateDown(b.bearish) != null ? Math.round(hitRateDown(b.bearish)! * 1000) / 10 : null,
      },
      // Spread = the whole point of the signal: does Bullish forward-outperform
      // Bearish. This is the single number to scan across the parameter grid
      // looking for a plateau (same discipline as GROWTH_MIN_GAP's sweep) —
      // a spread that's only positive for one lucky (L, threshold) combo is
      // noise, not signal.
      spreadPct: (bullMean != null && bearMean != null) ? Math.round((bullMean - bearMean) * 10000) / 100 : null,
    };
  }

  return { L, V, threshold, scoredDays: scored, byHorizon };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const symbolsParam = url.searchParams.get("symbols");
    const symbols = symbolsParam ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()) : ["VT", "GLDM", "FBTC", "BTC-USD"];

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const report: Record<string, unknown> = { symbols, methodology: {
      formula: "z(t) = momentum(t,L) / (dailyVol(t,V) * sqrt(L)), momentum = sum of daily log returns over L days, dailyVol = stdev of daily log returns over V days (V=L in this sweep)",
      classification: "bullish: z > threshold; bearish: z < -threshold; neutral: otherwise",
      L_candidates: L_CANDIDATES, threshold_candidates: THRESHOLD_CANDIDATES, forward_horizons_tradingDays: FORWARD_HORIZONS,
      note: "walk-forward, no look-ahead: state(t) uses only data through day t; scored against realized close[t+N]/close[t]-1",
    }, results: {} as Record<string, unknown> };
    const results = report.results as Record<string, unknown>;

    for (const symbol of symbols) {
      // Paginate: PostgREST default cap can silently truncate a long daily
      // series (VT alone is 4500+ rows) well below what walk-forward needs.
      let rows: PriceRow[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("asset_price_history")
          .select("date, close")
          .eq("symbol", symbol)
          .order("date", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) { results[symbol] = { ok: false, error: error.message }; break; }
        if (!data || data.length === 0) break;
        rows = rows.concat(data.map((r) => ({ date: r.date as string, close: Number(r.close) })));
        if (data.length < pageSize) break;
        from += pageSize;
      }
      if (results[symbol]) continue; // error already recorded
      if (rows.length < Math.max(...L_CANDIDATES) + Math.max(...FORWARD_HORIZONS) + 10) {
        results[symbol] = { ok: false, error: `not enough history (${rows.length} rows) for the largest lookback/horizon combo` };
        continue;
      }

      const sweep: Record<string, unknown> = {};
      for (const L of L_CANDIDATES) {
        for (const threshold of THRESHOLD_CANDIDATES) {
          const key = `L${L}_thr${threshold}`;
          sweep[key] = runSweep(rows, L, threshold, L);
        }
      }
      results[symbol] = {
        ok: true, rowCount: rows.length, from: rows[0].date, to: rows[rows.length - 1].date,
        sweep,
      };
    }

    return new Response(JSON.stringify(report, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
