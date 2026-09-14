import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PARADIGM_METRICS, LOW_COVERAGE_PARADIGMS, ParadigmMetricDef, Paradigm } from "../_shared/paradigmMetrics.ts";
import {
  zScore, orientedZ, renormalizeWeights, compositeScore,
  classify, classifyParadigmA, selectDominant,
} from "../_shared/paradigmScoring.ts";

// Fiscal Policy Paradigm scorecard daily refresh (42 Macro's Paradigm A-E
// framework — see the build spec). For each of the 13 metrics in
// PARADIGM_METRICS: fetch full FRED history, compute the metric's raw
// value series (direct / YoY / ratio / ratio-then-YoY per its formula
// type), store it, take the trailing-10yr z-score of the latest reading,
// orient it, and roll up into a per-paradigm composite score. Every step
// is deterministic and re-derived fresh on every run — no cached weights,
// no manual overrides anywhere (see paradigmScoring.ts, the one place the
// actual math lives).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

interface FredObs { date: string; value: number; }

// Full-history fetch, never throws — mirrors update-big-cycle-metrics's own
// fredLatest "null on any failure" convention, extended to pull the whole
// series (needed for z-score trailing windows) instead of just the latest
// point. A discontinued/renamed series, a rate-limit response, or a
// network error all land here as an empty array, never a crash.
async function fetchFredHistory(seriesId: string): Promise<FredObs[]> {
  try {
    const res = await fetch(`${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc`);
    if (!res.ok) return [];
    const j = await res.json();
    const obs = (j.observations ?? []) as { date: string; value: string }[];
    return obs.map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((o) => !isNaN(o.value));
  } catch {
    return [];
  }
}

// Most recent observation on or before `cutoff`. Assumes `series` is sorted
// ascending (fetchFredHistory's own order) — walks forward, keeps the last
// match, stops at the first date past cutoff.
function latestOnOrBefore(series: FredObs[], cutoff: string): FredObs | null {
  let result: FredObs | null = null;
  for (const o of series) {
    if (o.date <= cutoff) result = o;
    else break;
  }
  return result;
}

// Date-matched YoY (same calendar date one year earlier, nearest prior
// observation if that exact date doesn't exist in the series) — not a
// fixed positional offset, which would silently misalign on any gap in the
// source series. Same reasoning already established in run-backtest.ts /
// fetch-macro-data.ts's own yoy() helpers.
function yoySeries(obs: FredObs[]): FredObs[] {
  const out: FredObs[] = [];
  for (const o of obs) {
    const d = new Date(o.date);
    const yaKey = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
    const prior = latestOnOrBefore(obs, yaKey);
    if (prior != null && prior.value !== 0) out.push({ date: o.date, value: (o.value / prior.value - 1) * 100 });
  }
  return out;
}

// Aligns one or more numerator series (summed — only trade_gdp needs more
// than one, EXPGS+IMPGS) against a denominator series, walking the
// DENOMINATOR's own dates as the output cadence (the coarser/natural
// reporting frequency for every ratio metric here, e.g. GDP's quarterly
// calendar for a TREAST-weekly/GFDEBTN-quarterly or SP500-daily/GDP-
// quarterly ratio) and pulling each numerator's most recent value as of
// that date. A date with no numerator observation yet (or a zero
// denominator) is skipped, not fabricated.
function ratioSeries(numerators: FredObs[][], denominator: FredObs[]): FredObs[] {
  const out: FredObs[] = [];
  for (const d of denominator) {
    if (d.value === 0) continue;
    let sum = 0;
    let missing = false;
    for (const numSeries of numerators) {
      const match = latestOnOrBefore(numSeries, d.date);
      if (match == null) { missing = true; break; }
      sum += match.value;
    }
    if (missing) continue;
    out.push({ date: d.date, value: sum / d.value });
  }
  return out;
}

async function computeMetricRawSeries(def: ParadigmMetricDef): Promise<{ series: FredObs[] | null; reason?: string }> {
  try {
    if (def.formula === "direct") {
      const series = await fetchFredHistory(def.fredSeriesId!);
      return series.length ? { series } : { series: null, reason: `${def.fredSeriesId}: no observations returned` };
    }
    if (def.formula === "yoy") {
      const series = await fetchFredHistory(def.fredSeriesId!);
      if (!series.length) return { series: null, reason: `${def.fredSeriesId}: no observations returned` };
      const yoy = yoySeries(series);
      return yoy.length ? { series: yoy } : { series: null, reason: `${def.fredSeriesId}: insufficient history for YoY` };
    }
    if (def.formula === "ratio" || def.formula === "ratio_yoy") {
      const numSeries = await Promise.all(def.numeratorSeriesIds!.map((id) => fetchFredHistory(id)));
      const denomSeries = await fetchFredHistory(def.denominatorSeriesId!);
      const failedIdx = numSeries.findIndex((s) => s.length === 0);
      if (failedIdx !== -1) return { series: null, reason: `${def.numeratorSeriesIds![failedIdx]}: no observations returned` };
      if (!denomSeries.length) return { series: null, reason: `${def.denominatorSeriesId}: no observations returned` };
      const ratio = ratioSeries(numSeries, denomSeries);
      if (!ratio.length) return { series: null, reason: "no overlapping dates between numerator and denominator series" };
      if (def.formula === "ratio") return { series: ratio };
      const yoy = yoySeries(ratio);
      return yoy.length ? { series: yoy } : { series: null, reason: "insufficient ratio history for YoY" };
    }
    return { series: null, reason: "unknown formula type" };
  } catch (e) {
    return { series: null, reason: String(e) };
  }
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const ALL_PARADIGMS: Paradigm[] = ["A", "B", "C", "D", "E"];
const TRAILING_WINDOW_YEARS = 10;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const today = new Date().toISOString().slice(0, 10);
    const windowCutoff = new Date();
    windowCutoff.setUTCFullYear(windowCutoff.getUTCFullYear() - TRAILING_WINDOW_YEARS);
    const windowCutoffStr = windowCutoff.toISOString().slice(0, 10);

    type MetricResult = { rawValue: number; zScore: number; available: boolean; reason?: string };
    const metricResults = new Map<string, MetricResult>();
    const fetchSummary: { key: string; ok: boolean; reason?: string; points?: number }[] = [];

    for (const def of PARADIGM_METRICS) {
      const { series, reason } = await computeMetricRawSeries(def);
      if (!series || series.length === 0) {
        metricResults.set(def.key, { rawValue: NaN, zScore: NaN, available: false, reason: reason ?? "unavailable" });
        fetchSummary.push({ key: def.key, ok: false, reason });
        continue;
      }

      const fredSeriesLabel = def.fredSeriesId
        ?? [...(def.numeratorSeriesIds ?? []), def.denominatorSeriesId].filter(Boolean).join("+");
      const rawRows = series.map((o) => ({
        metric_key: def.key, fred_series_id: fredSeriesLabel, obs_date: o.date, value: o.value,
      }));
      for (let i = 0; i < rawRows.length; i += 1000) {
        const { error } = await sb.from("big_cycle_paradigm_raw_series")
          .upsert(rawRows.slice(i, i + 1000), { onConflict: "metric_key,obs_date" });
        if (error) console.error(`[paradigm] raw_series upsert ${def.key}:`, error.message);
      }

      const latest = series[series.length - 1];
      const window = series.filter((o) => o.date >= windowCutoffStr);
      const trailingValues = (window.length >= 2 ? window : series).map((o) => o.value);
      const z = zScore(trailingValues, latest.value);
      metricResults.set(def.key, { rawValue: latest.value, zScore: z, available: true });
      fetchSummary.push({ key: def.key, ok: true, points: series.length });
    }

    const paradigmComposites: {
      paradigm: Paradigm; score: number; label: string; coveragePct: number; lowCoverage: boolean;
    }[] = [];
    const metricScoreRows: Record<string, unknown>[] = [];

    for (const paradigm of ALL_PARADIGMS) {
      const defsForParadigm = PARADIGM_METRICS.filter((d) => d.paradigms.includes(paradigm));
      const availableDefs = defsForParadigm.filter((d) => metricResults.get(d.key)?.available);
      const weights = renormalizeWeights(availableDefs.map((d) => d.key));

      const orientedZs: number[] = [];
      const weightArr: number[] = [];
      for (const d of defsForParadigm) {
        const mr = metricResults.get(d.key)!;
        const w = weights[d.key] ?? 0;
        const oz = mr.available ? orientedZ(mr.zScore, d.orientationSign) : null;
        if (mr.available && oz != null) { orientedZs.push(oz); weightArr.push(w); }
        metricScoreRows.push({
          recorded_at: today, metric_key: d.key, paradigm,
          raw_value: mr.available ? r4(mr.rawValue) : null,
          z_score: mr.available ? r4(mr.zScore) : null,
          oriented_z: mr.available && oz != null ? r4(oz) : null,
          weight: r4(w),
          available: mr.available,
          unavailable_reason: mr.available ? null : (mr.reason ?? "unavailable"),
        });
      }

      const score = r4(compositeScore(orientedZs, weightArr));
      const coveragePct = defsForParadigm.length > 0
        ? r4((availableDefs.length / defsForParadigm.length) * 100) : 0;
      const label = paradigm === "A" ? classifyParadigmA(score) : classify(score);
      const lowCoverage = LOW_COVERAGE_PARADIGMS.includes(paradigm) || coveragePct < 100;
      paradigmComposites.push({ paradigm, score, label, coveragePct, lowCoverage });
    }

    const dominantParadigm = selectDominant(
      paradigmComposites.filter((p) => p.paradigm === "B" || p.paradigm === "C" || p.paradigm === "D")
        .map((p) => ({ paradigm: p.paradigm, score: p.score }))
    );

    for (let i = 0; i < metricScoreRows.length; i += 500) {
      const { error } = await sb.from("big_cycle_paradigm_metric_scores")
        .upsert(metricScoreRows.slice(i, i + 500), { onConflict: "metric_key,paradigm,recorded_at" });
      if (error) console.error("[paradigm] metric_scores upsert:", error.message);
    }

    const paradigmScoreRows = paradigmComposites.map((p) => ({
      recorded_at: today, paradigm: p.paradigm, composite_score: p.score, label: p.label,
      coverage_pct: p.coveragePct, low_coverage: p.lowCoverage,
    }));
    const { error: paradigmWriteError } = await sb.from("big_cycle_paradigm_scores")
      .upsert(paradigmScoreRows, { onConflict: "paradigm,recorded_at" });
    if (paradigmWriteError) console.error("[paradigm] paradigm_scores upsert:", paradigmWriteError.message);

    return json({
      recordedAt: today,
      dominantParadigm,
      paradigmScores: paradigmComposites,
      metricFetchSummary: fetchSummary,
    });
  } catch (e) {
    console.error("[update-big-cycle-paradigm-metrics]", e);
    return json({ error: String(e) }, 500);
  }
});
