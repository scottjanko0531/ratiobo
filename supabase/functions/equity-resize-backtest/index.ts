import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// VAMS-equivalent spec, reframed: Phase 1's momentum z-score answered "will
// price keep moving the same direction" (a return-forecasting question) —
// and found VT mean-reverts, not trends, at every lookback tested. That's
// the wrong question for "when do we resize the equity sleeve." Resizing is
// a RISK-STATE question (is this currently a worse regime to hold full size
// in, regardless of expected forward return) — mean-reversion in average
// forward return doesn't contradict a fatter left tail while in that state.
//
// This tool backtests three genuine risk-state detectors against VT's real
// daily history (asset_price_history), each swept across parameters, and
// compares the resulting EQUITY CURVE (not just forward-return spread) to
// buy-and-hold on CAGR/vol/max-drawdown/Sharpe/Calmar — the same metrics
// the KISS deck itself reports (pp. 12-15), not Phase 1's spread metric.
//
// No look-ahead: each rule's state at close of day t is computed only from
// data through day t, then applied to day t+1's return — mirrors KISS's own
// explicit "pivots lagged a full day" convention.
//
// Cash/reduced-exposure return is modeled as flat 0% (KISS itself parks
// idle cash in short-term T-bills, USFR — not modeled here; this is a
// simplification flagged, not hidden, and makes the resize rules' apparent
// benefit conservative, not inflated, since real cash would earn a bit more
// than 0%).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type PriceRow = { date: string; close: number };
type Stats = {
  cagrPct: number; volPct: number; maxDrawdownPct: number; sharpe: number; calmar: number;
  transitions: number; pctTimeReduced: number;
};

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

function sma(prices: number[], t: number, N: number): number | null {
  if (t - N + 1 < 0) return null;
  let s = 0;
  for (let i = t - N + 1; i <= t; i++) s += prices[i];
  return s / N;
}

function stdev(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return NaN;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

// state[t] = true means "reduced" as of close of day t (known at end of day
// t, applied to day t+1's return in simulate()).

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

// Baseline vol = expanding historical mean of the same rolling-vol series up
// to t (point-in-time, no look-ahead) — avoids needing a second arbitrary
// "long window" parameter to define "normal."
function volRuleStates(dailyReturns: number[], V: number, triggerMult: number, restoreMult: number, warmup: number): boolean[] {
  const n = dailyReturns.length;
  const states = new Array(n).fill(false);
  const rollingVol: (number | null)[] = new Array(n).fill(null);
  for (let t = V; t < n; t++) {
    rollingVol[t] = stdev(dailyReturns.slice(t - V + 1, t + 1));
  }
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
    sumVol += v; countVol++;
  }
  return states;
}

function simulate(closes: number[], reducedStates: boolean[], reducedExposure: number) {
  const n = closes.length;
  const portfolioReturns: number[] = [];
  let transitions = 0;
  let reducedDays = 0;
  for (let t = 1; t < n; t++) {
    const dailyReturn = closes[t] / closes[t - 1] - 1;
    // Signal known as of close of day t-1, applied to day t's return —
    // the "lagged a full day" rule.
    const isReduced = reducedStates[t - 1];
    const exposure = isReduced ? reducedExposure : 1;
    portfolioReturns.push(exposure * dailyReturn);
    if (isReduced) reducedDays++;
    if (t > 1 && reducedStates[t - 1] !== reducedStates[t - 2]) transitions++;
  }
  return { portfolioReturns, transitions, pctTimeReduced: Math.round((reducedDays / (n - 1)) * 1000) / 10 };
}

function computeStats(portfolioReturns: number[], transitions: number, pctTimeReduced: number): Stats {
  const n = portfolioReturns.length;
  let value = 1;
  let peak = 1;
  let maxDD = 0;
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
    transitions, pctTimeReduced,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get("symbol") ?? "VT").toUpperCase();
    const reducedExposureLevels = [0, 0.5];

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const rows = await fetchPrices(supabase, symbol);
    if (rows.length < 400) {
      return new Response(JSON.stringify({ error: `not enough history for ${symbol} (${rows.length} rows)` }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const closes = rows.map((r) => r.close);
    const dailyReturns: number[] = [NaN];
    for (let i = 1; i < closes.length; i++) dailyReturns.push(closes[i] / closes[i - 1] - 1);

    const baseline = computeStats(dailyReturns.slice(1), 0, 0);

    const report: Record<string, unknown> = {
      symbol, rowCount: rows.length, from: rows[0].date, to: rows[rows.length - 1].date,
      methodology: {
        note: "state known at close of day t applied to day t+1's return (1-day lag, matching KISS's own convention). Reduced-exposure cash return modeled as flat 0%.",
        reducedExposureLevelsTested: reducedExposureLevels,
      },
      buyAndHoldBaseline: baseline,
      rules: {} as Record<string, unknown>,
    };
    const rules = report.rules as Record<string, unknown>;

    // Rule 1: trend/MA state
    const trendResults: Record<string, unknown> = {};
    for (const N of [50, 100, 150, 200, 252]) {
      const states = trendRuleStates(closes, N);
      for (const exp of reducedExposureLevels) {
        const { portfolioReturns, transitions, pctTimeReduced } = simulate(closes, states, exp);
        trendResults[`MA${N}_exp${exp}`] = computeStats(portfolioReturns, transitions, pctTimeReduced);
      }
    }
    rules.trendMA = trendResults;

    // Rule 2: trailing drawdown-from-peak threshold
    const ddResults: Record<string, unknown> = {};
    for (const dCut of [-0.10, -0.15, -0.20, -0.25]) {
      for (const dRestore of [-0.05, -0.10]) {
        if (dRestore <= dCut) continue; // restore threshold must be less severe than cut
        const states = drawdownRuleStates(closes, dCut, dRestore);
        for (const exp of reducedExposureLevels) {
          const { portfolioReturns, transitions, pctTimeReduced } = simulate(closes, states, exp);
          ddResults[`cut${dCut}_restore${dRestore}_exp${exp}`] = computeStats(portfolioReturns, transitions, pctTimeReduced);
        }
      }
    }
    rules.trailingDrawdown = ddResults;

    // Rule 3: realized volatility regime (vs. its own expanding historical mean)
    const volResults: Record<string, unknown> = {};
    for (const V of [20, 60, 90]) {
      for (const triggerMult of [1.25, 1.5, 2.0]) {
        const states = volRuleStates(dailyReturns, V, triggerMult, 1.1, 250);
        for (const exp of reducedExposureLevels) {
          const { portfolioReturns, transitions, pctTimeReduced } = simulate(closes, states, exp);
          volResults[`V${V}_trigger${triggerMult}_exp${exp}`] = computeStats(portfolioReturns, transitions, pctTimeReduced);
        }
      }
    }
    rules.volRegime = volResults;

    // Rule 4: combined OR-trigger — trend/MA and trailing-drawdown catch
    // different crash shapes (VT's GFC/COVID-style fast crashes barely
    // moved the MA rule's needle; VTI's dot-com-style slow grind is where
    // MA won decisively) — reduced whenever EITHER individual rule says
    // reduced, same parameter grids as rules 1 and 2, full sweep rather
    // than hand-picking each rule's individual "best" params together
    // (that would be cherry-picking two winners chosen with hindsight on
    // the very data being tested, not a real combined-rule backtest).
    const comboResults: Record<string, unknown> = {};
    for (const N of [50, 100, 150, 200, 252]) {
      const trendStates = trendRuleStates(closes, N);
      for (const dCut of [-0.10, -0.15, -0.20, -0.25]) {
        for (const dRestore of [-0.05, -0.10]) {
          if (dRestore <= dCut) continue;
          const ddStates = drawdownRuleStates(closes, dCut, dRestore);
          const combinedStates = trendStates.map((t, i) => t || ddStates[i]);
          for (const exp of reducedExposureLevels) {
            const { portfolioReturns, transitions, pctTimeReduced } = simulate(closes, combinedStates, exp);
            comboResults[`MA${N}_cut${dCut}_restore${dRestore}_exp${exp}`] = computeStats(portfolioReturns, transitions, pctTimeReduced);
          }
        }
      }
    }
    rules.trendOrDrawdown = comboResults;

    return new Response(JSON.stringify(report, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
