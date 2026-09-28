import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeMarketConditionsHistory } from "../_shared/marketConditions/scoring.ts";
import { MC_CONFIG } from "../_shared/marketConditions/config.ts";
import { alignWithForwardFill, SeriesRowWithPublish } from "../_shared/marketConditions/normalize.ts";

// Market Conditions Overlay — entry-signal validation (Phase 3 prerequisite,
// 2026-09-30). Validates the entry-signal RULES (entrySignal.ts) against
// forward returns before any UI ever shows them, per explicit instruction.
// Does NOT change any rule -- report only. mc-1.3.0 config, NO breadth
// (rejected earlier this round, never wired into computeMarketConditions
// History unless breadthScore is explicitly passed -- it isn't here).
//
// One market per invocation (?market=SPY|QQQ|IWM|EFA), same
// WORKER_RESOURCE_LIMIT-avoidance pattern as the last two rounds' backtest
// functions -- a single computeMarketConditionsHistory call per invocation
// is the safe unit of work already proven in this repo.
//
// Methodology:
// - Episodes: a maximal run of CONSECUTIVE rows (by the emitted row
//   sequence, which is a contiguous date suffix once any pillar becomes
//   available -- see scoring.ts's own loop) sharing the same entryReason
//   (rule ID). One rule maps to exactly one signal value by construction
//   (entrySignal.ts's rules are mutually exclusive, first-match-wins), so
//   grouping by rule IS grouping by signal.
// - Forward returns: close[t+h]/close[t] - 1 for h in {5,21,63} trading
//   days, using the SAME market's own close series. Days within h of the
//   series' end are excluded from that horizon (no lookahead available),
//   not zero-filled or dropped from other horizons.
// - Unconditional baseline: every row in the report window.
// - Conditional baseline: every row in the report window whose trend_state
//   is IN THE SET of trend_state values actually observed on the rule's
//   own firing days -- for rules gated to a single trend_state (E-DIP/
//   E-HOT/E-TOP -> UP; E-CAPITULATION/E-DOWN -> DOWN) this is exactly "all
//   trend=UP days" / "all trend=DOWN days" as explicitly specified. For
//   rules not gated to one trend_state (E-VETO fires regardless; E-DEFAULT
//   is whatever's left), the observed set may span multiple trend_states --
//   pooled rather than picking one arbitrarily.
// - Pass rule (informational only, no rule is changed by this function):
//   ADD/ADD_SMALL must beat their conditional baseline's MEAN forward
//   return at BOTH 21d and 63d; WAIT/TRIM must underperform theirs at BOTH.
//   NEUTRAL (E-DEFAULT) has no directional criterion, reported only.
//   <10 episodes -> flagged inconclusive regardless of the pass/fail read.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_CARRY_DAYS = 3;
const HORIZONS = [5, 21, 63];
const MIN_EPISODES_CONCLUSIVE = 10;

const MARKET_START: Record<string, string> = {
  SPY: "1996-02-23",
  QQQ: "1999-03-10",
  IWM: "2000-05-26",
  EFA: "2001-08-27",
};

// entrySignal.ts's own rule -> signal mapping, duplicated here only for
// the report's pass/fail directionality -- not used to compute anything,
// just to know which direction "beats baseline" means per rule.
// mc-1.4.0: E-VETO/E-TOP/E-THRUST/E-CAPITULATION removed from
// entrySignal.ts entirely (not "unreachable in this phase" -- gone). Only
// the 4 surviving rules are re-validated against the new O1/O2-wired
// E-DIP/E-HOT. E-VETO's own validation result from the PRIOR round (fails
// in 4/4 markets) is why it was removed -- not re-tested here since the
// rule no longer exists to test; its replacement, the veto-day
// INFORMATIONAL stats block below, answers the question the UI actually
// needs now ("how should high-stress days be labeled") without implying
// a pass/fail rule verdict.
const RULE_DIRECTION: Record<string, "ADD" | "WAIT_TRIM" | "NEUTRAL"> = {
  "E-DIP": "ADD",
  "E-HOT": "WAIT_TRIM",
  "E-DOWN": "WAIT_TRIM",
  "E-DEFAULT": "NEUTRAL",
};

type PriceRow = { date: string; close: number };

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

function mean(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function pctPositive(arr: number[]): number { return arr.length ? (arr.filter((v) => v > 0).length / arr.length) * 100 : NaN; }
// Linear-interpolation percentile, same convention as a typical
// numpy-style "percentile" -- p in [0,100].
function percentile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function horizonStats(fwdRets: Record<number, number[]>) {
  const out: Record<string, { n: number; meanPct: number | null; medianPct: number | null; pctPositive: number | null }> = {};
  for (const h of HORIZONS) {
    const arr = fwdRets[h] ?? [];
    out[String(h)] = arr.length
      ? { n: arr.length, meanPct: Math.round(mean(arr) * 10000) / 100, medianPct: Math.round(median(arr) * 10000) / 100, pctPositive: Math.round(pctPositive(arr) * 10) / 10 }
      : { n: 0, meanPct: null, medianPct: null, pctPositive: null };
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const market = (url.searchParams.get("market") ?? "SPY").toUpperCase();
    if (!MARKET_START[market]) throw new Error(`unknown market ${market}, expected one of ${Object.keys(MARKET_START).join(",")}`);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const [priceRows, vixRows, vix3mRows, baa10yRows] = await Promise.all([
      fetchAllPrices(supabase, market),
      fetchAllSeries(supabase, "VIXCLS"),
      fetchAllSeries(supabase, "VIX3M"),
      fetchAllSeries(supabase, "BAA10Y"),
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

    // NO breadthScore -- rejected this round, mc-1.3.0 stays trend+stress.
    const rows = computeMarketConditionsHistory({ dates, closes, vix, vix3m, creditSpread }, MC_CONFIG);

    const dateToIdx = new Map(dates.map((d, i) => [d, i]));
    const startDate = MARKET_START[market];
    const reportRows = rows.filter((r) => r.date >= startDate);

    function fwdRetAt(idx: number, h: number): number | null {
      return idx + h < n ? closes[idx + h] / closes[idx] - 1 : null;
    }

    // Per-row: close index + forward returns at each horizon, precomputed once.
    const enriched = reportRows.map((r) => {
      const idx = dateToIdx.get(r.date)!;
      const fwd: Record<number, number | null> = {};
      for (const h of HORIZONS) fwd[h] = fwdRetAt(idx, h);
      return { row: r, idx, fwd };
    });

    // Unconditional baseline: every reportRow.
    const unconditionalFwd: Record<number, number[]> = {};
    for (const h of HORIZONS) unconditionalFwd[h] = enriched.map((e) => e.fwd[h]).filter((v): v is number => v != null);

    // Group by trend_state for conditional-baseline pooling.
    const byTrendState = new Map<string, typeof enriched>();
    for (const e of enriched) {
      const arr = byTrendState.get(e.row.trendState) ?? [];
      arr.push(e);
      byTrendState.set(e.row.trendState, arr);
    }

    // Group by rule (entryReason). Episodes = consecutive runs in
    // `enriched`'s own order (== chronological, contiguous date suffix).
    const byRule = new Map<string, typeof enriched>();
    for (const e of enriched) {
      const arr = byRule.get(e.row.entryReason) ?? [];
      arr.push(e);
      byRule.set(e.row.entryReason, arr);
    }

    function countEpisodes(rule: string): number {
      let episodes = 0;
      let inRun = false;
      for (const e of enriched) {
        const match = e.row.entryReason === rule;
        if (match && !inRun) { episodes++; inRun = true; }
        else if (!match) { inRun = false; }
      }
      return episodes;
    }

    const rulesSeen = new Set<string>([...byRule.keys(), ...Object.keys(RULE_DIRECTION)]);
    const results = [...rulesSeen].sort().map((rule) => {
      const group = byRule.get(rule) ?? [];
      const signal = group[0]?.row.entrySignal ?? null;
      const episodes = countEpisodes(rule);

      const ruleFwd: Record<number, number[]> = {};
      for (const h of HORIZONS) ruleFwd[h] = group.map((e) => e.fwd[h]).filter((v): v is number => v != null);

      const trendStatesObserved = [...new Set(group.map((e) => e.row.trendState))];
      const conditionalPool = trendStatesObserved.length
        ? trendStatesObserved.flatMap((ts) => byTrendState.get(ts) ?? [])
        : [];
      const conditionalFwd: Record<number, number[]> = {};
      for (const h of HORIZONS) conditionalFwd[h] = conditionalPool.map((e) => e.fwd[h]).filter((v): v is number => v != null);

      const ruleStats = horizonStats(ruleFwd);
      const conditionalStats = horizonStats(conditionalFwd);
      const unconditionalStats = horizonStats(unconditionalFwd);

      const direction = RULE_DIRECTION[rule] ?? "NEUTRAL";
      let passFail: { horizon21: string; horizon63: string; overall: string } | null = null;
      if (direction !== "NEUTRAL" && group.length > 0) {
        const m21 = ruleStats["21"].meanPct, b21 = conditionalStats["21"].meanPct;
        const m63 = ruleStats["63"].meanPct, b63 = conditionalStats["63"].meanPct;
        const check = (m: number | null, b: number | null) => {
          if (m == null || b == null) return "no_data";
          if (direction === "ADD") return m > b ? "pass" : "fail";
          return m < b ? "pass" : "fail"; // WAIT_TRIM
        };
        const h21 = check(m21, b21);
        const h63 = check(m63, b63);
        const inconclusive = episodes < MIN_EPISODES_CONCLUSIVE;
        const overall = inconclusive ? "inconclusive" : (h21 === "pass" && h63 === "pass" ? "pass" : "fail");
        passFail = { horizon21: h21, horizon63: h63, overall };
      }

      return {
        rule,
        signal,
        days: group.length,
        episodes,
        inconclusive: episodes < MIN_EPISODES_CONCLUSIVE,
        trendStatesObserved,
        ruleStats,
        conditionalBaseline: { trendStates: trendStatesObserved, stats: conditionalStats },
        unconditionalBaseline: { stats: unconditionalStats },
        passFail,
      };
    });

    // Veto-day INFORMATIONAL stats (item 3, mc-1.4.0): the tier-level
    // stress veto (row.vetoActive/flags.veto -- separate from the removed
    // E-VETO entry-signal rule) still exists and caps exposure; the UI
    // needs a label for it, not a pass/fail verdict. Same conditional-
    // baseline pooling (by trend_state) as the rule table above, but keyed
    // on vetoActive rather than entryReason since veto days aren't grouped
    // by rule at all now that E-VETO is gone.
    const vetoDayGroup = enriched.filter((e) => e.row.vetoActive);
    const vetoTrendStates = [...new Set(vetoDayGroup.map((e) => e.row.trendState))];
    const vetoConditionalPool = vetoTrendStates.length ? vetoTrendStates.flatMap((ts) => byTrendState.get(ts) ?? []) : [];
    function vetoHorizonStats(pool: typeof enriched) {
      const out: Record<string, { n: number; medianPct: number | null; pctPositive: number | null; p10Pct: number | null }> = {};
      for (const h of HORIZONS) {
        const arr = pool.map((e) => e.fwd[h]).filter((v): v is number => v != null);
        out[String(h)] = arr.length
          ? { n: arr.length, medianPct: Math.round(median(arr) * 10000) / 100, pctPositive: Math.round(pctPositive(arr) * 10) / 10, p10Pct: Math.round(percentile(arr, 10) * 10000) / 100 }
          : { n: 0, medianPct: null, pctPositive: null, p10Pct: null };
      }
      return out;
    }
    const vetoDayStats = {
      days: vetoDayGroup.length,
      trendStatesObserved: vetoTrendStates,
      note: "INFORMATIONAL ONLY, no pass/fail -- E-VETO (the entry-signal rule) was removed this round for failing its own criterion; the UI's 'high stress' label is meant to convey the median/typical-downside read here, not a directional bet like the rule table above.",
      stats: vetoHorizonStats(vetoDayGroup),
      conditionalBaseline: { trendStates: vetoTrendStates, stats: vetoHorizonStats(vetoConditionalPool) },
    };

    return new Response(JSON.stringify({
      note: "Entry-signal validation, REPORT ONLY -- no rule changed. mc-1.4.0 config (E-DIP/E-HOT now wired to O1/O2 oscillators; E-VETO/E-TOP/E-THRUST/E-CAPITULATION removed). No breadth (rejected last round). Pass rule: ADD must beat conditional baseline mean fwd return at BOTH 21d and 63d; WAIT must underperform at BOTH; E-DEFAULT (NEUTRAL) has no directional criterion. <10 episodes flagged inconclusive regardless of the pass/fail read.",
      market,
      window: { from: reportRows[0]?.date ?? null, to: reportRows[reportRows.length - 1]?.date ?? null },
      totalDays: reportRows.length,
      results,
      vetoDayStats,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
