import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PARADIGM_METRICS, LOW_COVERAGE_PARADIGMS, ParadigmMetricDef, Paradigm } from "../_shared/paradigmMetrics.ts";
import { bridgeQuarterlyByMarketChange, quarterEndDate } from "../_shared/z1Bridge.ts";
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

// Phase 4c (debt-metrics-integrity spec): real completion status, written
// to the same generic job-run log every other scheduled job already uses
// (rb_job_runs — not rb-specific despite the name; see
// update-inflation-regime/index.ts for the identical pattern). Before this,
// a chunked-upsert failure here only ever hit console.error and the run
// continued — including writing big_cycle_paradigm_scores (the composite,
// user-facing table) right after a metric_scores chunk had silently failed,
// which is the prime suspect for the Paradigm "stale" display bug Phase 0
// investigated (not reproducible at the time, but this is the fix for the
// failure mode that would cause it). Fire-and-forget: a logging failure
// must never affect this function's real response.
async function logJobRun(
  sb: ReturnType<typeof createClient>, startedAt: Date, status: "ok" | "error", detail: Record<string, unknown>,
): Promise<void> {
  try {
    await sb.from("rb_job_runs").insert({
      job_name: "update-big-cycle-paradigm-metrics", started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(), status, detail,
    });
  } catch {
    // never let logging break the real response
  }
}

interface FredObs { date: string; value: number; }

// Full-history fetch, never throws — mirrors update-big-cycle-metrics's own
// fredLatest "null on any failure" convention, extended to pull the whole
// series (needed for z-score trailing windows) instead of just the latest
// point. A discontinued/renamed series, a rate-limit response, or a
// network error all land here as an empty array, never a crash.
async function fetchFredHistory(seriesId: string, observationStart?: string): Promise<FredObs[]> {
  try {
    const startParam = observationStart ? `&observation_start=${observationStart}` : "";
    const res = await fetch(`${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc${startParam}`);
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
    if (def.formula === "bridged_ratio") {
      // valuation_proxy only (the real Buffett Indicator fix). fredSeriesId
      // is a quarterly, dollar-denominated series (Z.1); bridgeMarketSeriesId
      // is a daily market index used to scale the most recent real print
      // forward between releases (see _shared/z1Bridge.ts). Historical
      // points are each evaluated AT their own quarter's end (bridge factor
      // exactly 1 -- "the same methodology applied retroactively", not the
      // raw print re-labeled); exactly one extra point is appended for
      // TODAY, bridged by the market's real move since the latest print's
      // quarter end -- this is what makes the card update daily/live
      // between Z.1 releases without changing the trailing-window z-score's
      // sampling cadence (still one point per real quarterly release, plus
      // the one live point being scored against that history).
      // Backfill fix (Scott, 2026-11-20): bounded to 1952-01-01 -- where
      // BOGZ1LM893064105Q transitions from annual to real quarterly
      // cadence (confirmed live: 1945-1951 are October-dated annual
      // points, 1952-01-01 onward is genuinely quarterly), and GDP's own
      // quarterly history (starts 1947-01-01) already covers it. Bridging
      // an annual point with quarterEndDate's quarterly-cadence math
      // would misalign the pre-1952 years, so they're excluded rather
      // than silently mishandled.
      const z1Series = await fetchFredHistory(def.fredSeriesId!, "1952-01-01");
      const marketSeries = await fetchFredHistory(def.bridgeMarketSeriesId!);
      const denomSeries = await fetchFredHistory(def.denominatorSeriesId!);
      if (!z1Series.length) return { series: null, reason: `${def.fredSeriesId}: no observations returned` };
      if (!marketSeries.length) return { series: null, reason: `${def.bridgeMarketSeriesId}: no observations returned` };
      if (!denomSeries.length) return { series: null, reason: `${def.denominatorSeriesId}: no observations returned` };

      // BOGZ1LM893064105Q is in MILLIONS of dollars; GDP is in BILLIONS —
      // ×1000 converts GDP to millions so the ratio is dimensionless
      // (verified against the real numbers by hand before writing this:
      // 123,687,233 / (32,563.030 × 1000) = 3.798, matching a direct
      // independent calculation).
      const GDP_BILLIONS_TO_MILLIONS = 1000;
      const out: FredObs[] = [];
      for (const z1Obs of z1Series) {
        const qEnd = quarterEndDate(z1Obs.date);
        const bridged = bridgeQuarterlyByMarketChange(z1Obs.date, z1Obs.value, marketSeries, qEnd);
        const denom = latestOnOrBefore(denomSeries, qEnd);
        if (!bridged || !denom || denom.value === 0) continue;
        out.push({ date: z1Obs.date, value: bridged.bridgedValue / (denom.value * GDP_BILLIONS_TO_MILLIONS) });
      }
      const today = new Date().toISOString().slice(0, 10);
      const latestZ1 = z1Series[z1Series.length - 1];
      const liveBridged = bridgeQuarterlyByMarketChange(latestZ1.date, latestZ1.value, marketSeries, today);
      const liveDenom = latestOnOrBefore(denomSeries, today);
      if (liveBridged && liveDenom && liveDenom.value !== 0) {
        // Dated today (not the quarter-start convention the historical
        // points use) -- this is what lets this row refresh daily:
        // tomorrow's run upserts a DIFFERENT obs_date, not an overwrite.
        out.push({ date: today, value: liveBridged.bridgedValue / (liveDenom.value * GDP_BILLIONS_TO_MILLIONS) });
      }
      return out.length ? { series: out } : { series: null, reason: "bridged ratio produced no usable points" };
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

  const jobStartedAt = new Date();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  try {
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

      const fredSeriesLabel = def.formula === "bridged_ratio"
        ? [def.fredSeriesId, def.bridgeMarketSeriesId, def.denominatorSeriesId].filter(Boolean).join("+")
        : def.fredSeriesId
        ?? [...(def.numeratorSeriesIds ?? []), def.denominatorSeriesId].filter(Boolean).join("+");
      const rawRows = series.map((o) => ({
        metric_key: def.key, fred_series_id: fredSeriesLabel, obs_date: o.date, value: o.value,
      }));
      for (let i = 0; i < rawRows.length; i += 1000) {
        const { error } = await sb.from("big_cycle_paradigm_raw_series")
          .upsert(rawRows.slice(i, i + 1000), { onConflict: "metric_key,obs_date" });
        if (error) throw new Error(`raw_series upsert (${def.key}, chunk ${i}): ${error.message}`);
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

    // Phase 4c: this upsert must not proceed past a metric_scores failure —
    // the suspected root cause of the Paradigm "stale" display bug was
    // exactly this: a chunk failing silently here while paradigm_scores (the
    // composite, user-facing table) wrote unconditionally right after,
    // producing a recorded_at that exists in paradigm_scores but has
    // partial-or-zero matching rows in metric_scores.
    for (let i = 0; i < metricScoreRows.length; i += 500) {
      const { error } = await sb.from("big_cycle_paradigm_metric_scores")
        .upsert(metricScoreRows.slice(i, i + 500), { onConflict: "metric_key,paradigm,recorded_at" });
      if (error) throw new Error(`metric_scores upsert (chunk ${i}): ${error.message}`);
    }

    const paradigmScoreRows = paradigmComposites.map((p) => ({
      recorded_at: today, paradigm: p.paradigm, composite_score: p.score, label: p.label,
      coverage_pct: p.coveragePct, low_coverage: p.lowCoverage,
    }));
    const { error: paradigmWriteError } = await sb.from("big_cycle_paradigm_scores")
      .upsert(paradigmScoreRows, { onConflict: "paradigm,recorded_at" });
    if (paradigmWriteError) throw new Error(`paradigm_scores upsert: ${paradigmWriteError.message}`);

    await logJobRun(sb, jobStartedAt, "ok", {
      recordedAt: today, dominantParadigm, metricsAvailable: fetchSummary.filter((f) => f.ok).length, metricsTotal: fetchSummary.length,
    });
    return json({
      recordedAt: today,
      dominantParadigm,
      paradigmScores: paradigmComposites,
      metricFetchSummary: fetchSummary,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[update-big-cycle-paradigm-metrics]", msg);
    await logJobRun(sb, jobStartedAt, "error", { message: msg });
    return json({ error: msg }, 500);
  }
});
