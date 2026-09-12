import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Same pattern as kiss-portfolio-backtest, generalized to All Weather
// Alpha's 7-symbol/8-bucket portfolio (target_allocations: em 5/eq 20/nb
// 20/com 12/gld 12/tip 20/cash 3/intl 8 -- identical to the real "Dalio All
// Weather" portfolio's own target_allocations, so that portfolio's backtest
// IS this function's staticRebalancedMonthly variant; no separate build
// needed). Answers the user's question: does layering this session's newly
// backtested per-symbol resize overlay (asset_resize_rule_config, now
// populated for all 7 holdings) actually help vs. the static All Weather
// baseline and vs. KISS's own already-validated overlay result?
//
// Backtest window: PDBC's inception (2014-11-07, the binding constraint --
// VTI/VXUS/VWO/TLT/VTIP/GLD all have longer history) to today.
//
// Cash's return (both the baseline 3% allocation and any weight freed by
// the overlay) is modeled on USFR's real historical return -- same
// cash-parking asset KISS's own backtest uses -- not the flat 0%
// simplification the first pass of this tool used, which was a real,
// fixable drag unrelated to whether the resize rules themselves work.
//
// Rule params hardcoded to match asset_resize_rule_config exactly, same
// "kept in sync by hand" convention as kiss-portfolio-backtest, for a
// reproducible report independent of future config edits.
//
// Not wired into production -- a standalone diagnostic, same pattern as
// this repo's other *-backtest edge functions.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type PriceRow = { date: string; close: number };

async function fetchPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<PriceRow[]> {
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
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, close: Number(r.close) })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function stdev(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return NaN;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

function sma(prices: number[], t: number, N: number): number | null {
  if (t - N + 1 < 0) return null;
  let s = 0;
  for (let i = t - N + 1; i <= t; i++) s += prices[i];
  return s / N;
}

function trendRuleStates(closes: number[], N: number): boolean[] {
  const n = closes.length;
  const states = new Array(n).fill(false);
  for (let t = 0; t < n; t++) {
    const ma = sma(closes, t, N);
    if (ma == null) continue;
    states[t] = closes[t] < ma;
  }
  return states;
}

function volRuleStates(dailyReturns: number[], V: number, triggerMult: number, restoreMult: number, warmup: number): boolean[] {
  const n = dailyReturns.length;
  const states = new Array(n).fill(false);
  const rollingVol: (number | null)[] = new Array(n).fill(null);
  for (let t = V; t < n; t++) rollingVol[t] = stdev(dailyReturns.slice(t - V + 1, t + 1));
  let reduced = false;
  let sumVol = 0, countVol = 0;
  for (let t = 0; t < n; t++) {
    const v = rollingVol[t];
    if (v == null) continue;
    if (countVol >= warmup) {
      const baseline = sumVol / countVol;
      if (!reduced && v > baseline * triggerMult) reduced = true;
      else if (reduced && v < baseline * restoreMult) reduced = false;
    }
    states[t] = reduced;
  }
  return states;
}

function computeStats(portfolioReturns: number[]) {
  const n = portfolioReturns.length;
  let value = 1, peak = 1, maxDD = 0;
  for (const r of portfolioReturns) {
    value *= (1 + r);
    peak = Math.max(peak, value);
    maxDD = Math.min(maxDD, value / peak - 1);
  }
  const years = n / 252;
  const cagr = Math.pow(value, 1 / years) - 1;
  const vol = stdev(portfolioReturns) * Math.sqrt(252);
  const sharpe = vol !== 0 ? cagr / vol : NaN;
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : NaN;
  return {
    cagrPct: Math.round(cagr * 10000) / 100,
    volPct: Math.round(vol * 10000) / 100,
    maxDrawdownPct: Math.round(maxDD * 10000) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    calmar: Math.round(calmar * 100) / 100,
    finalMultiple: Math.round(value * 100) / 100,
  };
}

const BUCKETS = ["eq", "intl", "em", "nb", "tip", "com", "gld", "cash"] as const;
type Bucket = typeof BUCKETS[number];
const SYMBOL: Record<Exclude<Bucket, "cash">, string> = {
  eq: "VTI", intl: "VXUS", em: "VWO", nb: "TLT", tip: "VTIP", com: "PDBC", gld: "GLD",
};
const TARGET: Record<Bucket, number> = { eq: 0.20, intl: 0.08, em: 0.05, nb: 0.20, tip: 0.20, com: 0.12, gld: 0.12, cash: 0.03 };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // USFR fetched separately from the 7 bucket symbols -- it's not one of
    // target_allocations' own buckets, it's the REAL asset the "cash"
    // bucket's dollars are held in (both the baseline 3% allocation and any
    // weight freed by the overlay), replacing the flat-0%-return
    // simplification from the first pass. USFR's own history (from
    // 2014-02) predates PDBC's inception, so it's never the binding
    // constraint and needs the same forward-fill treatment as the others.
    const symbols = [...Object.values(SYMBOL), "USFR"];
    const priceRows = await Promise.all(symbols.map((s) => fetchPrices(supabase, s)));
    const byDate: Record<string, Map<string, number>> = {};
    symbols.forEach((s, i) => { byDate[s] = new Map(priceRows[i].map((r) => [r.date, r.close])); });

    // PDBC is the binding constraint (2014-11-07 inception).
    const pdbcRows = priceRows[symbols.indexOf("PDBC")];
    const startDate = pdbcRows[0]?.date;

    // Master calendar = VTI's trading days from startDate, carrying the most
    // recent prior close forward for any symbol individually missing a date.
    const vtiRows = priceRows[symbols.indexOf("VTI")];
    const last: Record<string, number | null> = Object.fromEntries(symbols.map((s) => [s, null]));
    const aligned: { date: string; closes: Record<string, number> }[] = [];
    for (const v of vtiRows) {
      if (!startDate || v.date < startDate) continue;
      const closes: Record<string, number> = {};
      let ok = true;
      for (const s of symbols) {
        const c = byDate[s].get(v.date) ?? last[s];
        if (c == null) { ok = false; break; }
        last[s] = c;
        closes[s] = c;
      }
      if (!ok) continue;
      aligned.push({ date: v.date, closes });
    }

    const n = aligned.length;
    const dailyRet: Record<string, number[]> = {};
    for (const s of symbols) {
      const arr: number[] = [NaN];
      for (let i = 1; i < n; i++) arr.push(aligned[i].closes[s] / aligned[i - 1].closes[s] - 1);
      dailyRet[s] = arr;
    }

    // Rule params hardcoded to match asset_resize_rule_config exactly (see
    // this session's backtests: PDBC/VXUS/VWO -> trend_ma; GLD/TLT/VTIP ->
    // vol_regime; VTI -> trend_ma N=252, the original KISS-derived rule).
    const reduced: Record<string, boolean[]> = {
      VTI: trendRuleStates(aligned.map((r) => r.closes.VTI), 252),
      VXUS: trendRuleStates(aligned.map((r) => r.closes.VXUS), 100),
      VWO: trendRuleStates(aligned.map((r) => r.closes.VWO), 100),
      PDBC: trendRuleStates(aligned.map((r) => r.closes.PDBC), 50),
      GLD: volRuleStates(dailyRet.GLD, 90, 2.0, 1.1, 250),
      TLT: volRuleStates(dailyRet.TLT, 90, 1.25, 1.1, 250),
      VTIP: volRuleStates(dailyRet.VTIP, 60, 2.0, 1.1, 250),
    };

    const isFirstTradingDayOfMonth = (i: number) => i === 0 || aligned[i].date.slice(0, 7) !== aligned[i - 1].date.slice(0, 7);

    function runStaticDrift() {
      const w: Record<Bucket, number> = { ...TARGET };
      const rets: number[] = [];
      for (let t = 1; t < n; t++) {
        const total = Object.values(w).reduce((a, b) => a + b, 0);
        let portRet = 0;
        for (const b of BUCKETS) {
          const r = b === "cash" ? dailyRet.USFR[t] : dailyRet[SYMBOL[b]][t];
          portRet += (w[b] / total) * r;
        }
        rets.push(portRet);
        for (const b of BUCKETS) {
          const r = b === "cash" ? dailyRet.USFR[t] : dailyRet[SYMBOL[b]][t];
          w[b] *= (1 + r);
        }
      }
      return rets;
    }

    // Also tracks the daily value curve (downsampled to one point per month,
    // last trading day) so run-backtest can consume this variant as a real
    // portfolio series, same reasoning as kiss-portfolio-backtest's identical
    // addition.
    function runRebalanced(useOverlay: boolean) {
      const w: Record<Bucket, number> = { ...TARGET };
      const rets: number[] = [];
      let value = 1;
      const monthlyCurve: { date: string; value: number }[] = [];
      for (let t = 1; t < n; t++) {
        const total = Object.values(w).reduce((a, b) => a + b, 0);
        let portRet = 0;
        for (const b of BUCKETS) {
          const r = b === "cash" ? dailyRet.USFR[t] : dailyRet[SYMBOL[b]][t];
          portRet += (w[b] / total) * r;
        }
        rets.push(portRet);
        value *= (1 + portRet);
        for (const b of BUCKETS) {
          const r = b === "cash" ? dailyRet.USFR[t] : dailyRet[SYMBOL[b]][t];
          w[b] *= (1 + r);
        }

        if (isFirstTradingDayOfMonth(t)) {
          const newTotal = Object.values(w).reduce((a, b) => a + b, 0);
          const t2: Record<Bucket, number> = { ...TARGET };
          if (useOverlay) {
            let freed = 0;
            for (const b of BUCKETS) {
              if (b === "cash") continue;
              const sym = SYMBOL[b];
              const isReduced = reduced[sym][t];
              const mult = isReduced ? 0 : 1;
              const target = TARGET[b] * mult;
              freed += TARGET[b] - target;
              t2[b] = target;
            }
            t2.cash = TARGET.cash + freed;
          }
          for (const b of BUCKETS) w[b] = t2[b] * newTotal;
        }
        const isLastOfMonth = t === n - 1 || aligned[t + 1].date.slice(0, 7) !== aligned[t].date.slice(0, 7);
        if (isLastOfMonth) monthlyCurve.push({ date: aligned[t].date.slice(0, 7) + "-01", value });
      }
      return { rets, monthlyCurve };
    }

    const staticDrift = computeStats(runStaticDrift());
    const staticRebalancedRun = runRebalanced(false);
    const overlayRebalancedRun = runRebalanced(true);
    const staticRebalancedMonthly = computeStats(staticRebalancedRun.rets);
    const overlayRebalancedMonthly = computeStats(overlayRebalancedRun.rets);

    return new Response(JSON.stringify({
      portfolio: "All Weather Alpha (95fc88e6-2ddf-484a-8092-93126055e989)",
      note: "staticRebalancedMonthly is identical in construction to the real 'Dalio All Weather' portfolio (df51db17-...) -- same target_allocations, no overlay -- so no separate backtest is needed for that comparison.",
      backtestWindow: { from: aligned[0]?.date, to: aligned[n - 1]?.date, tradingDays: n },
      targetAllocations: TARGET,
      symbols: SYMBOL,
      variants: { staticDrift, staticRebalancedMonthly, overlayRebalancedMonthly },
      overlayMonthlyCurve: overlayRebalancedRun.monthlyCurve,
      staticMonthlyCurve: staticRebalancedRun.monthlyCurve,
    }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
