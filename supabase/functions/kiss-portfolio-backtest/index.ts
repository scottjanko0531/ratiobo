import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// VAMS-equivalent Bottom-Up overlay spec: the culminating backtest — does the
// calibrated resize overlay (asset_resize_rule_config) actually help when
// applied to Ratiobo's REAL "KISS" portfolio (portfolio_id
// c457d30b-1073-413c-8749-af30bab2a126), not a hypothetical? Real current
// holdings (portfolio_holdings joined to holdings_valued): VT $30.3k, GLDM
// $0 (currently fully de-risked — matches today's live vol-regime "Reduced"
// signal), FBTC $10.2k, USFR $60.0k (the real liquidity sleeve — KISS itself
// parks reduced-exposure cash in USFR, per the source deck's own page 10
// caption, so "reduced" periods here earn USFR's REAL historical return,
// not the flat 0% simplification used in equity-resize-backtest).
//
// Backtest window: 2018-06-26 (GLDM's inception, the binding constraint —
// VT/USFR/BTC-USD all have longer history) to today. FBTC itself only
// starts Jan-2024; BTC-USD is used as its proxy for the full window, same
// choice already established and validated in this session's other
// backtests.
//
// Three variants, all starting from KISS's own strategic weight (60% VT /
// 30% GLDM / 10% Bitcoin, page 8 of the source deck):
//   staticDrift            — buy and hold from inception, no rebalancing.
//   staticRebalancedMonthly — rebalanced back to 60/30/10 on the first
//                             trading day of each month, no resize overlay.
//   overlayRebalancedMonthly — same monthly rebalance, but each leg's target
//                             weight is scaled by that leg's OWN calibrated
//                             resize signal (walk-forward, no look-ahead,
//                             same rule functions as equity-resize-backtest)
//                             at rebalance time; the weight freed up by a
//                             reduced leg is redirected into USFR.
//
// Not wired into production — a standalone diagnostic report, same
// curl-invoked pattern as this repo's other *-backtest edge functions.

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

// Full walk-forward state arrays — ported verbatim from equity-resize-backtest
// (same formulas, same hysteresis, same no-look-ahead convention).
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

function drawdownRuleStates(closes: number[], dCut: number, dRestore: number): boolean[] {
  const n = closes.length;
  const states = new Array(n).fill(false);
  let peak = closes[0];
  let reduced = false;
  for (let t = 0; t < n; t++) {
    peak = Math.max(peak, closes[t]);
    const dd = closes[t] / peak - 1;
    if (!reduced && dd <= dCut) reduced = true;
    else if (reduced && dd >= dRestore) reduced = false;
    states[t] = reduced;
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const [vtRows, gldmRows, btcRows, usfrRows] = await Promise.all([
      fetchPrices(supabase, "VT"),
      fetchPrices(supabase, "GLDM"),
      fetchPrices(supabase, "BTC-USD"),
      fetchPrices(supabase, "USFR"),
    ]);

    const gldmByDate = new Map(gldmRows.map((r) => [r.date, r.close]));
    const btcByDate = new Map(btcRows.map((r) => [r.date, r.close]));
    const usfrByDate = new Map(usfrRows.map((r) => [r.date, r.close]));

    // Master calendar = VT's trading days (equity calendar), starting from
    // GLDM's inception (the binding constraint), with the most recent prior
    // close carried forward for BTC/USFR on any date they're individually
    // missing (BTC trades 7 days/wk so this is rare; USFR trades the same
    // equity calendar as VT so this should essentially never fire).
    const gldmStart = gldmRows[0]?.date;
    let lastGldm: number | null = null, lastBtc: number | null = null, lastUsfr: number | null = null;
    const aligned: { date: string; vt: number; gldm: number; btc: number; usfr: number }[] = [];
    for (const v of vtRows) {
      if (!gldmStart || v.date < gldmStart) continue;
      const g = gldmByDate.get(v.date) ?? lastGldm;
      const b = btcByDate.get(v.date) ?? lastBtc;
      const u = usfrByDate.get(v.date) ?? lastUsfr;
      if (g == null || b == null || u == null) continue;
      lastGldm = g; lastBtc = b; lastUsfr = u;
      aligned.push({ date: v.date, vt: v.close, gldm: g, btc: b, usfr: u });
    }

    const n = aligned.length;
    const vtCloses = aligned.map((r) => r.vt);
    const gldmCloses = aligned.map((r) => r.gldm);
    const btcCloses = aligned.map((r) => r.btc);
    const usfrCloses = aligned.map((r) => r.usfr);

    const dailyRet = (closes: number[]) => {
      const out: number[] = [NaN];
      for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
      return out;
    };
    const vtRet = dailyRet(vtCloses), gldmRet = dailyRet(gldmCloses), btcRet = dailyRet(btcCloses), usfrRet = dailyRet(usfrCloses);

    // Calibrated rules — must match asset_resize_rule_config exactly (kept
    // in sync by hand since this is a standalone backtest, not a live query
    // against that table, to keep this report reproducible independent of
    // future config edits).
    const vtReduced = drawdownRuleStates(vtCloses, -0.10, -0.05);
    const gldmReduced = volRuleStates(gldmRet, 90, 2.0, 1.1, 250);
    const btcReduced = trendRuleStates(btcCloses, 50);
    const VT_EXPOSURE_WHEN_REDUCED = 0.5;
    const GLDM_EXPOSURE_WHEN_REDUCED = 0;
    const BTC_EXPOSURE_WHEN_REDUCED = 0;

    const isFirstTradingDayOfMonth = (i: number) => i === 0 || aligned[i].date.slice(0, 7) !== aligned[i - 1].date.slice(0, 7);

    // Variant 1: static drift (buy and hold from inception, weights drift).
    function runStaticDrift() {
      let wVt = 0.6, wGldm = 0.3, wBtc = 0.1; // dollar-value weights, drift with price
      const rets: number[] = [];
      for (let t = 1; t < n; t++) {
        const total = wVt + wGldm + wBtc;
        const portRet = (wVt / total) * vtRet[t] + (wGldm / total) * gldmRet[t] + (wBtc / total) * btcRet[t];
        rets.push(portRet);
        wVt *= (1 + vtRet[t]); wGldm *= (1 + gldmRet[t]); wBtc *= (1 + btcRet[t]);
      }
      return rets;
    }

    // Variant 2 & 3 share a monthly-rebalance loop; variant 3 additionally
    // scales each leg's target weight by its resize state at each rebalance
    // and parks the freed weight in USFR (accruing USFR's real return until
    // the next rebalance re-evaluates state).
    function runRebalanced(useOverlay: boolean) {
      let wVt = 0.6, wGldm = 0.3, wBtc = 0.1, wUsfr = 0;
      const rets: number[] = [];
      for (let t = 1; t < n; t++) {
        const total = wVt + wGldm + wBtc + wUsfr;
        const portRet = (wVt / total) * vtRet[t] + (wGldm / total) * gldmRet[t]
          + (wBtc / total) * btcRet[t] + (wUsfr / total) * usfrRet[t];
        rets.push(portRet);
        wVt *= (1 + vtRet[t]); wGldm *= (1 + gldmRet[t]); wBtc *= (1 + btcRet[t]); wUsfr *= (1 + usfrRet[t]);

        if (isFirstTradingDayOfMonth(t)) {
          const newTotal = wVt + wGldm + wBtc + wUsfr;
          let tVt = 0.6, tGldm = 0.3, tBtc = 0.1, tUsfr = 0;
          if (useOverlay) {
            const vtMult = vtReduced[t] ? VT_EXPOSURE_WHEN_REDUCED : 1;
            const gldmMult = gldmReduced[t] ? GLDM_EXPOSURE_WHEN_REDUCED : 1;
            const btcMult = btcReduced[t] ? BTC_EXPOSURE_WHEN_REDUCED : 1;
            tVt = 0.6 * vtMult; tGldm = 0.3 * gldmMult; tBtc = 0.1 * btcMult;
            tUsfr = (0.6 - tVt) + (0.3 - tGldm) + (0.1 - tBtc);
          }
          wVt = tVt * newTotal; wGldm = tGldm * newTotal; wBtc = tBtc * newTotal; wUsfr = tUsfr * newTotal;
        }
      }
      return rets;
    }

    const staticDrift = computeStats(runStaticDrift());
    const staticRebalancedMonthly = computeStats(runRebalanced(false));
    const overlayRebalancedMonthly = computeStats(runRebalanced(true));

    return new Response(JSON.stringify({
      portfolio: "KISS (c457d30b-1073-413c-8749-af30bab2a126)",
      realHoldingsAsOf: { VT: 30252.96, GLDM: 0.00, FBTC: 10164.78, USFR: 60038.31 },
      backtestWindow: { from: aligned[0]?.date, to: aligned[n - 1]?.date, tradingDays: n },
      strategicWeight: "60% VT / 30% GLDM / 10% Bitcoin (BTC-USD proxy for FBTC)",
      variants: { staticDrift, staticRebalancedMonthly, overlayRebalancedMonthly },
    }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
