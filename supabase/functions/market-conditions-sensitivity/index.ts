import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { stepTierState } from "../_shared/marketConditions/scoring.ts";
import { MC_CONFIG, TIER_ORDER } from "../_shared/marketConditions/config.ts";
import { alignWithForwardFill, SeriesRowWithPublish, clip } from "../_shared/marketConditions/normalize.ts";
import { computeTrendRawSeries, scoreTrendAtIndex, resolveTrendState } from "../_shared/marketConditions/indicators/trend.ts";
import { computeStressRawSeries, scoreStressAtIndex, vetoConditionsAtIndex } from "../_shared/marketConditions/indicators/stress.ts";
import { HysteresisState, TrendState } from "../_shared/marketConditions/types.ts";

// Market Conditions Overlay — parameter sensitivity sweep (mc-1.3.0 frozen
// baseline, robustness round task 3). IN-SAMPLE, preliminary, same
// disclaimers as market-conditions-backtest-preliminary /
// market-conditions-robustness.
//
// Varies six parameters +/-25% one at a time (all others held at the
// mc-1.3.0 baseline) against an overridden cfg object (not the deployed/
// live config), and the same fixed-exposure backtest engine used by
// market-conditions-robustness, reporting CAGR and Calmar for each of the
// 12 variants plus the baseline. The point is to see a plateau around the
// chosen values, not a spike -- a single-point optimum on any one of these
// six would mean mc-1.3.0 curve-fit rather than found a real regime signal.
//
// NOT a call to computeMarketConditionsHistory once per variant -- that
// recomputes stress pillar scoring (percentile-rank over up to a 2520-day
// window, 5 sub-indicators) from scratch for all 13 variants even though
// none of the six swept parameters affect it, which blew the edge
// function's compute budget (WORKER_RESOURCE_LIMIT). Instead, trend/stress
// raw series and the stress pillar score are computed ONCE and reused; only
// the genuinely cfg-dependent, O(1)-per-day steps (T1 scoring, trend-state
// resolution, hysteresis/veto/floor/fast-path state machine) re-run per
// variant. See the precompute block below for the full accounting.
//
// Rounding convention where +/-25% doesn't land on an integer day-count
// (upgradeDays, downgradeDays): floor for the "-25%" direction, ceil for
// "+25%", so the perturbation is at least 1 day in the intended direction
// rather than rounding back to baseline.
//
// Standalone, curl-invoked, not wired into production. Depends on two
// mc-1.3.0-round infrastructure fixes in _shared/marketConditions/: (1)
// tierForComposite/stepTierState actually honoring a passed-in cfg.tiers
// (previously silently ignored), (2) t1BoundPct promoted from a hardcoded
// trend.ts constant into MC_CONFIG.trend -- both are prerequisites for the
// tier-threshold and T1-scale variants below to do anything at all.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_CARRY_DAYS = 3;
const START_DATE = "1996-02-23";
const TURNOVER_COST = 0.0005;

type PriceRow = { date: string; close: number };
type RateRow = { date: string; value: number };

async function fetchAllPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<PriceRow[]> {
  let rows: PriceRow[] = []; let from = 0; const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from("asset_price_history").select("date, close")
      .eq("symbol", symbol).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`asset_price_history read: ${error.message}`);
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
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : NaN;
  return {
    cagrPct: Math.round(cagr * 10000) / 100,
    volPct: Math.round(vol * 10000) / 100,
    maxDrawdownPct: Math.round(maxDD * 10000) / 100,
    calmar: Math.round(calmar * 100) / 100,
  };
}

// deno-lint-ignore no-explicit-any
type Cfg = any;

// Same variant of MC_CONFIG used for every variant here, deep-copied and
// overridden per-run so one variant's edits can never bleed into another's
// (computeMarketConditionsHistory doesn't mutate cfg, but this keeps the
// sweep loop trivially safe to reorder/parallelize later).
//
// NOT a JSON.parse(JSON.stringify(...)) clone -- RISK_OFF's tiers[4].min is
// -Infinity, which JSON.stringify silently turns into null, corrupting the
// baseline's own fallback tier. Cloned by hand instead, field by field.
function baseCfg(): Cfg {
  return {
    ...MC_CONFIG,
    trend: { ...MC_CONFIG.trend },
    breadth: { ...MC_CONFIG.breadth },
    sentiment: { ...MC_CONFIG.sentiment },
    tiers: MC_CONFIG.tiers.map((t) => ({ ...t })),
    hysteresis: { ...MC_CONFIG.hysteresis },
    veto: { ...MC_CONFIG.veto },
    recovery: { ...MC_CONFIG.recovery },
    entry: { ...MC_CONFIG.entry },
    pillarWeights: { ...MC_CONFIG.pillarWeights },
  };
}

function shiftedTiers(deltaAbs: number) {
  return MC_CONFIG.tiers.map((t) => ({ ...t, min: t.min === -Infinity ? t.min : Math.round((t.min + deltaAbs) * 10000) / 10000 }));
}

interface Variant { name: string; cfg: Cfg }

function buildVariants(): Variant[] {
  const variants: Variant[] = [{ name: "baseline_mc130", cfg: baseCfg() }];

  const trendBandLo = baseCfg(); trendBandLo.trend.trendBand = 0.015;
  variants.push({ name: "trendBand_-25%_0.015", cfg: trendBandLo });
  const trendBandHi = baseCfg(); trendBandHi.trend.trendBand = 0.025;
  variants.push({ name: "trendBand_+25%_0.025", cfg: trendBandHi });

  const t1Lo = baseCfg(); t1Lo.trend.t1BoundPct = 0.0375;
  variants.push({ name: "t1BoundPct_-25%_0.0375", cfg: t1Lo });
  const t1Hi = baseCfg(); t1Hi.trend.t1BoundPct = 0.0625;
  variants.push({ name: "t1BoundPct_+25%_0.0625", cfg: t1Hi });

  const upLo = baseCfg(); upLo.hysteresis.upgradeDays = 2; // floor(3 * 0.75) = 2
  variants.push({ name: "upgradeDays_-25%_2", cfg: upLo });
  const upHi = baseCfg(); upHi.hysteresis.upgradeDays = 4; // ceil(3 * 1.25) = 4
  variants.push({ name: "upgradeDays_+25%_4", cfg: upHi });

  const downLo = baseCfg(); downLo.hysteresis.downgradeDays = 1; // floor(2 * 0.75) = 1
  variants.push({ name: "downgradeDays_-25%_1", cfg: downLo });
  const downHi = baseCfg(); downHi.hysteresis.downgradeDays = 3; // ceil(2 * 1.25) = 3
  variants.push({ name: "downgradeDays_+25%_3", cfg: downHi });

  const tiersLo = baseCfg(); tiersLo.tiers = shiftedTiers(-0.05);
  variants.push({ name: "tierThresholds_-0.05", cfg: tiersLo });
  const tiersHi = baseCfg(); tiersHi.tiers = shiftedTiers(0.05);
  variants.push({ name: "tierThresholds_+0.05", cfg: tiersHi });

  const creditLo = baseCfg(); creditLo.veto.creditWideningBp = 34; // round(45 * 0.75)
  variants.push({ name: "creditWideningBp_-25%_34", cfg: creditLo });
  const creditHi = baseCfg(); creditHi.veto.creditWideningBp = 56; // round(45 * 1.25)
  variants.push({ name: "creditWideningBp_+25%_56", cfg: creditHi });

  return variants;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const [spyRows, vixRows, vix3mRows, baa10yRows, dtb3Rows] = await Promise.all([
      fetchAllPrices(supabase, "SPY"),
      fetchAllSeries(supabase, "VIXCLS"),
      fetchAllSeries(supabase, "VIX3M"),
      fetchAllSeries(supabase, "BAA10Y"),
      fetchRateSeries(supabase, "DTB3"),
    ]);
    if (spyRows.length === 0) throw new Error("no SPY price history");

    const dates = spyRows.map((r) => r.date);
    const closes = spyRows.map((r) => r.close);
    const n = dates.length;

    const vixFF = alignWithForwardFill(dates, vixRows, MAX_CARRY_DAYS);
    const vix3mFF = alignWithForwardFill(dates, vix3mRows, MAX_CARRY_DAYS);
    const baa10yFF = alignWithForwardFill(dates, baa10yRows, MAX_CARRY_DAYS);
    const vix = vixFF.map((r) => r.value);
    const vix3m = vix3mFF.map((r) => r.value);
    const creditSpread = baa10yFF.map((r) => r.value);

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
    if (startIdx < 1) throw new Error("START_DATE not found with enough history");

    function runFixedExposure(expByDate: Map<string, number>) {
      const rets: number[] = [];
      let prevExposure = 0;
      for (let t = startIdx; t < n - 1; t++) {
        const exposure = expByDate.get(dates[t]) ?? prevExposure;
        const cost = Math.abs(exposure - prevExposure) * TURNOVER_COST;
        const rate = rateAt(t);
        const ret = exposure * dailyRet[t + 1] + (1 - exposure) * (rate / 100 / 252) - cost;
        rets.push(ret);
        prevExposure = exposure;
      }
      return rets;
    }

    // Precompute the parts of the pipeline that NONE of the six swept
    // parameters affect, once, and reuse across all 13 variants -- this is
    // the whole point of this rewrite. In particular, stress pillar scoring
    // (scoreStressAtIndex -> collectPriorNonNull + percentileRank) is
    // O(window) per day per sub-indicator, window up to normWindow=2520,
    // for 5 percentile-based sub-indicators: ~n*5*2520 ~ 97M ops PER
    // VARIANT if recomputed inside the loop, which is what
    // computeMarketConditionsHistory does when called once per variant --
    // 13x that blew the edge function's compute budget
    // (WORKER_RESOURCE_LIMIT). None of trendBand/t1BoundPct/upgradeDays/
    // downgradeDays/tierThresholds/creditWideningBp affect
    // computeStressRawSeries or scoreStressAtIndex's normWindow/minHistory,
    // so the stress pillar score series is identical across every variant
    // and belongs outside the loop. Trend raw series is likewise
    // param-independent (slopeLookback/tenMonthRuleMonths aren't swept);
    // only T1's own score (clip(raw/t1BoundPct)) and trend-state resolution
    // (trendBand) vary, and both are O(1) per day, so scoreTrendAtIndex/
    // resolveTrendState stay inside the per-variant loop cheaply.
    const trendRaw = computeTrendRawSeries(closes, dates, MC_CONFIG);
    const stressRaw = computeStressRawSeries(closes, vix, vix3m, creditSpread);
    const stressPillarScore: (number | null)[] = new Array(n).fill(null);
    for (let t = 0; t < n; t++) stressPillarScore[t] = scoreStressAtIndex(stressRaw, t, MC_CONFIG).pillarScore;

    const initialState = (): HysteresisState => ({
      tierIndex: TIER_ORDER.indexOf("NORMAL"),
      upStreak: 0, downStreak: 0,
      trendState: "MIXED" as TrendState,
      aboveBandStreak: 0,
      fastPathLatched: false,
      vetoActive: false, vetoTermStructureStreak: 0, vetoClearStreak: 0,
    });

    function runVariant(cfg: Cfg): Map<string, number> {
      const expByDate = new Map<string, number>();
      let state = initialState();
      for (let t = 0; t < n; t++) {
        const trendResult = scoreTrendAtIndex(trendRaw, t, closes, cfg);
        const stressScore = stressPillarScore[t];
        const pillars: { name: "trend" | "stress"; score: number | null }[] = [
          { name: "trend", score: trendResult.pillarScore },
          { name: "stress", score: stressScore },
        ];
        const available = pillars.filter((p) => p.score != null);
        if (available.length === 0) continue;

        const { state: trendStateFinal, aboveBandStreak } = resolveTrendState(
          trendRaw.t1raw[t], trendRaw.t2raw[t], state.trendState, state.aboveBandStreak, cfg.trend.trendBand,
        );

        const totalWeight = available.reduce((s, p) => s + cfg.pillarWeights[p.name], 0);
        const composite = clip(available.reduce((s, p) => s + (cfg.pillarWeights[p.name] / totalWeight) * (p.score as number), 0));

        const vetoConds = vetoConditionsAtIndex(stressRaw, t, cfg);

        const hasVix3m = stressRaw.s1raw[t] != null;
        const termStructureFavorable = hasVix3m
          ? stressRaw.s1raw[t]! < cfg.recovery.vixTermStructureMax
          : (stressRaw.vixSma50[t] != null && vix[t] != null && vix[t]! < stressRaw.vixSma50[t]!
              && stressRaw.s6raw[t] != null && stressRaw.s6raw[t]! < 0);
        const creditFavorable = stressRaw.s3raw[t] != null && stressRaw.s3raw[t]! < cfg.recovery.baa10yChangeMaxBp;
        const closeAboveSma50 = trendRaw.sma50[t] != null && closes[t] > trendRaw.sma50[t]!;
        const fastPathTriggerNow = cfg.recovery.enabled && termStructureFavorable && creditFavorable && closeAboveSma50;

        const closeBelowSma50 = trendRaw.sma50[t] != null && closes[t] < trendRaw.sma50[t]!;
        const vixInverted = hasVix3m && stressRaw.s1raw[t]! > cfg.recovery.vixTermStructureInvalidate;
        const fastPathInvalidated = closeBelowSma50 || vixInverted;

        const { finalTierIndex, nextState } = stepTierState(
          {
            composite, trendState: trendStateFinal, aboveBandStreak,
            termStructureTriggered: vetoConds.termStructureTriggered, creditWideningTriggered: vetoConds.creditWideningTriggered,
            fastPathTriggerNow, fastPathInvalidated,
          },
          state, cfg,
        );

        expByDate.set(dates[t], cfg.tiers[finalTierIndex].mult);
        state = nextState;
      }
      return expByDate;
    }

    const variants = buildVariants();
    const results = variants.map((v) => {
      const expByDate = runVariant(v.cfg);
      const rets = runFixedExposure(expByDate);
      return { variant: v.name, ...statsFromReturns(rets) };
    });

    return new Response(JSON.stringify({
      note: "PRELIMINARY / IN-SAMPLE. mc-1.3.0 baseline config re-run with one parameter shifted +/-25% at a time (tier thresholds shifted +/-0.05 absolute per instruction), all others held fixed. Each variant re-runs the full walk-forward pipeline in-process (not the deployed config) against the same SPY/VIX/VIX3M/BAA10Y/DTB3 history used by market-conditions-robustness. Looking for a plateau, not a spike, around the shipped mc-1.3.0 values.",
      window: { from: dates[startIdx], to: dates[n - 1] },
      results,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
