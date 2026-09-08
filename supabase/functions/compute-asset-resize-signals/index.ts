import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// VAMS-equivalent Bottom-Up overlay spec: daily production computation of
// each held symbol's resize state, per its calibrated rule in
// asset_resize_rule_config (seeded from supabase/functions/equity-resize-
// backtest's real results — see that migration's comments/confidence_notes
// for the backtest evidence behind each symbol's rule choice).
//
// Rule math (trendRuleStates/drawdownRuleStates/volRuleStates) is ported
// VERBATIM from equity-resize-backtest — same formulas, same no-look-ahead
// convention — not redesigned for production. Each rule is replayed over
// the symbol's FULL available asset_price_history every run (cheap at this
// data volume, a few thousand rows per symbol) rather than trying to persist
// and incrementally update hysteresis state — self-healing if a day's run
// is ever missed, and guarantees today's computed state always matches what
// the backtest itself would have produced up to today, not a subtly
// diverged incremental approximation.
//
// Writes one row per symbol into asset_resize_signals for today's date,
// upserting (idempotent — safe to re-run same-day).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type PriceRow = { date: string; close: number };
type RuleConfig = { symbol: string; rule_type: string; params: Record<string, number> };

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

// Each returns { reduced, indicatorValue } for the LAST day only (index n-1)
// — production only needs "today's" state, unlike the backtest which needed
// the full walk-forward array to score forward returns.

function trendMaLatest(closes: number[], N: number): { reduced: boolean; indicatorValue: number | null } {
  const t = closes.length - 1;
  const ma = sma(closes, t, N);
  if (ma == null) return { reduced: false, indicatorValue: null };
  return { reduced: closes[t] < ma, indicatorValue: Math.round(ma * 10000) / 10000 };
}

function trailingDrawdownLatest(closes: number[], dCut: number, dRestore: number): { reduced: boolean; indicatorValue: number } {
  let peak = closes[0];
  let reduced = false;
  let dd = 0;
  for (let t = 0; t < closes.length; t++) {
    peak = Math.max(peak, closes[t]);
    dd = closes[t] / peak - 1;
    if (!reduced && dd <= dCut) reduced = true;
    else if (reduced && dd >= dRestore) reduced = false;
  }
  return { reduced, indicatorValue: Math.round(dd * 10000) / 100 }; // pp
}

function volRegimeLatest(dailyReturns: number[], V: number, triggerMult: number, restoreMult: number, warmup: number): { reduced: boolean; indicatorValue: number | null } {
  const n = dailyReturns.length;
  const rollingVol: (number | null)[] = new Array(n).fill(null);
  for (let t = V; t < n; t++) rollingVol[t] = stdev(dailyReturns.slice(t - V + 1, t + 1));
  let reduced = false;
  let sumVol = 0, countVol = 0;
  let lastRatio: number | null = null;
  for (let t = 0; t < n; t++) {
    const v = rollingVol[t];
    if (v == null) continue;
    if (countVol >= warmup) {
      const baseline = sumVol / countVol;
      lastRatio = baseline > 0 ? v / baseline : null;
      if (!reduced && v > baseline * triggerMult) reduced = true;
      else if (reduced && v < baseline * restoreMult) reduced = false;
    }
    sumVol += v; countVol++;
  }
  return { reduced, indicatorValue: lastRatio != null ? Math.round(lastRatio * 1000) / 1000 : null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: configs, error: cfgErr } = await supabase
      .from("asset_resize_rule_config")
      .select("symbol, rule_type, params");
    if (cfgErr) throw new Error(cfgErr.message);

    const today = new Date().toISOString().slice(0, 10);
    const results: Record<string, unknown> = {};

    for (const cfg of (configs ?? []) as RuleConfig[]) {
      const rows = await fetchPrices(supabase, cfg.symbol);
      if (rows.length < 30) {
        results[cfg.symbol] = { ok: false, error: `not enough price history (${rows.length} rows)` };
        continue;
      }
      const closes = rows.map((r) => r.close);
      const p = cfg.params;
      const exposureWhenReduced = Number(p.exposureWhenReduced ?? 0);

      let reduced: boolean;
      let indicatorValue: number | null;
      if (cfg.rule_type === "trend_ma") {
        ({ reduced, indicatorValue } = trendMaLatest(closes, Number(p.N)));
      } else if (cfg.rule_type === "trailing_drawdown") {
        ({ reduced, indicatorValue } = trailingDrawdownLatest(closes, Number(p.dCut), Number(p.dRestore)));
      } else if (cfg.rule_type === "vol_regime") {
        const dailyReturns: number[] = [NaN];
        for (let i = 1; i < closes.length; i++) dailyReturns.push(closes[i] / closes[i - 1] - 1);
        ({ reduced, indicatorValue } = volRegimeLatest(dailyReturns, Number(p.V), Number(p.triggerMult), Number(p.restoreMult), Number(p.warmup)));
      } else {
        results[cfg.symbol] = { ok: false, error: `unknown rule_type ${cfg.rule_type}` };
        continue;
      }

      const exposureMultiplier = reduced ? exposureWhenReduced : 1;
      const { error: upErr } = await supabase.from("asset_resize_signals").upsert({
        symbol: cfg.symbol, date: today, rule_type: cfg.rule_type,
        reduced, exposure_multiplier: exposureMultiplier, indicator_value: indicatorValue,
      }, { onConflict: "symbol,date" });

      results[cfg.symbol] = upErr
        ? { ok: false, error: upErr.message }
        : { ok: true, reduced, exposureMultiplier, indicatorValue, priceLatestDate: rows[rows.length - 1].date };
    }

    return new Response(JSON.stringify({ date: today, results }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
