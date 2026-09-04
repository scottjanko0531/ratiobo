import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ── Dead-band-recalibration spec: forecast-accuracy verification tool ──────────
// No existing code in this repo implements a walk-forward MAE/RMSE/directional-
// hit-rate-vs-naive-baseline backtest of the Structural growth/inflation
// crossover (run-backtest/index.ts is a PORTFOLIO-RETURN backtest — annual-
// rebalanced regime-driven allocation performance — not a forecast-accuracy
// one). This is a standalone, temporary verification tool, deployed and
// curl-invoked for its JSON report rather than shipped as a page feature —
// same pattern as this repo's existing debug-cpi-history/debug-growth-
// composite/cpi-diagnostic functions.
//
// Methodology: at each historical point-in-time cutoff t (using only data
// knowable as of t — no lookahead), score two forecasts of the SAME quantity
// (the raw single-period YoY reading N periods later) against what actually
// happened:
//   naive  = fast(t)                              — "current smoothed level holds flat"
//   model  = fast(t) + N * (fast(t) - slow(t))     — if |fast-slow| > minGap (a real
//            fast(t)  [identical to naive]         — crossover); otherwise Persistence,
//                                                     which is BY DESIGN identical to naive
// Both forecasts share the same "current level" basis (the smoothed fast
// line, not the noisier raw spot reading) so the comparison isolates the
// crossover threshold's own value-add, not smoothing's. Directional hit-rate
// is scored only on periods where a real crossover fired (Persistence makes
// no directional claim, so it can't be scored as a directional hit or miss).
//
// 3-month-forward-forecast spec extensions (kept in the same tool since they
// share the identical walk-forward/point-in-time machinery above):
//   - summarizeStrict/windowedReport: Measure 2 (directional accuracy),
//     defined stricter than the original directionHit above — the actual
//     print must clear the SAME dead band the crossover itself uses to
//     count as a directional move at all, scored only against
//     Accelerating/Decelerating calls, with Persistence periods scored
//     separately as "continuation accuracy" (did the print stay flat).
//     Reported ALONGSIDE the original directionalHitRate, not replacing it,
//     so the two can be directly reconciled.
//   - biasCorrectionTest: should forecast error feed back into future
//     forecasts? Walk-forward expanding-mean and EWMA(a=0.3) bias
//     correction, estimated only from strictly-prior errors at each issue
//     date, scored out-of-sample against the flat naive anchor.
//   - stateConditionalBias: the naive anchor's own mean error by state — the
//     structural check for whether a single running bias term even could
//     work (it can't, if the bias flips sign by state).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;

interface Obs { date: string; value: number; }

async function fetchFredSeries(seriesId: string): Promise<Obs[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc&observation_start=1990-01-01`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  const obs = (j.observations ?? []) as { date: string; value: string }[];
  return obs.map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((o) => !isNaN(o.value));
}

// Date-matched (same calendar month, one year earlier) — identical pattern to
// run-backtest.ts's yoy(), avoids the off-by-one a positional offset would
// introduce across any gap in the source series.
function yoy(obs: Obs[]): Obs[] {
  const byDate = new Map(obs.map((o) => [o.date, o.value]));
  const out: Obs[] = [];
  for (const o of obs) {
    const d = new Date(o.date);
    const yaKey = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const prev = byDate.get(yaKey);
    if (prev != null && prev !== 0) out.push({ date: o.date, value: (o.value / prev - 1) * 100 });
  }
  return out;
}

function trailingAvg(series: Obs[], n: number): Obs[] {
  const out: Obs[] = [];
  for (let i = n - 1; i < series.length; i++) {
    const window = series.slice(i - n + 1, i + 1);
    out.push({ date: series[i].date, value: window.reduce((s, o) => s + o.value, 0) / window.length });
  }
  return out;
}

// N periods ahead by calendar arithmetic (not array-index offset), so a gap
// in the source series (e.g. CPIAUCSL's missing October 2025 print) can't
// silently misalign "N periods ahead" into an actual N±1 comparison.
function dateNPeriodsAhead(date: string, n: number, unit: "month" | "quarter"): string {
  const d = new Date(date);
  const monthsAhead = unit === "quarter" ? n * 3 : n;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsAhead, 1)).toISOString().slice(0, 10);
}

interface EvalPoint {
  date: string;
  isSignal: boolean; // true = a real crossover fired (Accelerating/Decelerating), false = Persistence
  state: "accelerating" | "decelerating" | "persistence";
  naive: number; // fast(t) — the level-anchored forecast basis for everything below
  model: number; // momentum-decay forecast — kept only for the original MAE/RMSE-vs-naive comparison
  actual: number;
  naiveAbsErr: number;
  modelAbsErr: number;
  naiveSqErr: number;
  modelSqErr: number;
  directionHit: boolean | null; // ORIGINAL definition: sign(model-naive) vs sign(actual-naive), any nonzero move counts
  actualDirection: "up" | "down" | "flat"; // dead-band-recalibration spec's Measure 2: actual vs level-at-issue, classified with the SAME dead band as the crossover itself
  strictDirectionalHit: boolean | null; // Measure 2: state's Accelerating/Decelerating call vs actualDirection — null for Persistence (no directional claim)
  continuationHit: boolean | null; // Persistence periods only: did the actual print stay inside the dead band as predicted
}

function walkForward(
  rawYoy: Obs[], fast: Obs[], slow: Obs[], minGap: number, horizonN: number, unit: "month" | "quarter"
): EvalPoint[] {
  const actualByDate = new Map(rawYoy.map((o) => [o.date, o.value]));
  const slowByDate = new Map(slow.map((o) => [o.date, o.value]));
  const points: EvalPoint[] = [];
  for (const f of fast) {
    const s = slowByDate.get(f.date);
    if (s == null) continue;
    const targetDate = dateNPeriodsAhead(f.date, horizonN, unit);
    const actual = actualByDate.get(targetDate);
    if (actual == null) continue; // future not yet realized, or a gap — skip, don't guess

    const gap = f.value - s;
    const isSignal = Math.abs(gap) > minGap;
    const state: EvalPoint["state"] = !isSignal ? "persistence" : gap > 0 ? "accelerating" : "decelerating";
    const naive = f.value;
    const model = isSignal ? f.value + horizonN * gap : f.value;

    const naiveAbsErr = Math.abs(actual - naive);
    const modelAbsErr = Math.abs(actual - model);
    const directionHit = isSignal
      ? Math.sign(model - naive) === Math.sign(actual - naive) || Math.abs(actual - naive) < 1e-9
      : null;

    // dead-band-recalibration spec, Measure 2: the actual print only counts
    // as having moved "Up"/"Down" if it clears the SAME dead band the
    // crossover itself uses — a nonzero wiggle inside the band is "Flat,"
    // not a directional move. This is stricter than directionHit above
    // (which counts any nonzero sign) and is scored only against the
    // state's own Accelerating/Decelerating call, never the momentum-decay
    // model's magnitude.
    const actualDelta = actual - naive;
    const actualDirection: EvalPoint["actualDirection"] = actualDelta > minGap ? "up" : actualDelta < -minGap ? "down" : "flat";
    const strictDirectionalHit = state === "accelerating" ? actualDirection === "up"
      : state === "decelerating" ? actualDirection === "down"
      : null;
    const continuationHit = state === "persistence" ? actualDirection === "flat" : null;

    points.push({
      date: f.date, isSignal, state, naive, model, actual,
      naiveAbsErr, modelAbsErr,
      naiveSqErr: naiveAbsErr ** 2, modelSqErr: modelAbsErr ** 2,
      directionHit, actualDirection, strictDirectionalHit, continuationHit,
    });
  }
  return points;
}

function summarize(points: EvalPoint[]) {
  if (points.length === 0) {
    return { n: 0, nSignal: 0, naiveMAE: null, modelMAE: null, naiveRMSE: null, modelRMSE: null, directionalHitRate: null, beatsNaiveMAE: null, beatsNaiveRMSE: null };
  }
  const n = points.length;
  const naiveMAE = points.reduce((s, p) => s + p.naiveAbsErr, 0) / n;
  const modelMAE = points.reduce((s, p) => s + p.modelAbsErr, 0) / n;
  const naiveRMSE = Math.sqrt(points.reduce((s, p) => s + p.naiveSqErr, 0) / n);
  const modelRMSE = Math.sqrt(points.reduce((s, p) => s + p.modelSqErr, 0) / n);
  const signalPoints = points.filter((p) => p.isSignal);
  const hits = signalPoints.filter((p) => p.directionHit === true).length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    n, nSignal: signalPoints.length,
    naiveMAE: r2(naiveMAE), modelMAE: r2(modelMAE),
    naiveRMSE: r2(naiveRMSE), modelRMSE: r2(modelRMSE),
    directionalHitRate: signalPoints.length ? r2((hits / signalPoints.length) * 100) : null,
    beatsNaiveMAE: modelMAE < naiveMAE,
    beatsNaiveRMSE: modelRMSE < naiveRMSE,
  };
}

// dead-band-recalibration spec, Measure 2: directional accuracy scored ONLY
// over real Accelerating/Decelerating calls (a Persistence period is a
// continuation claim, not a directional one, and must not dilute or inflate
// this rate — see continuationAccuracy below for its own separate score).
// This is deliberately reported ALONGSIDE the original directionalHitRate
// (Math.sign-based, no dead-band on the actual side) in summarize() above,
// not in place of it, so the two can be directly compared/reconciled.
function summarizeStrict(points: EvalPoint[]) {
  const callPoints = points.filter((p) => p.state !== "persistence");
  const persistPoints = points.filter((p) => p.state === "persistence");
  const hits = callPoints.filter((p) => p.strictDirectionalHit === true).length;
  const contHits = persistPoints.filter((p) => p.continuationHit === true).length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    nCalls: callPoints.length,
    strictDirectionalHitRate: callPoints.length ? r2((hits / callPoints.length) * 100) : null,
    nPersistence: persistPoints.length,
    continuationAccuracy: persistPoints.length ? r2((contHits / persistPoints.length) * 100) : null,
  };
}

function windowedReport(points: EvalPoint[], nowDate: string) {
  const cutoff3y = new Date(nowDate); cutoff3y.setUTCFullYear(cutoff3y.getUTCFullYear() - 3);
  const cutoff5y = new Date(nowDate); cutoff5y.setUTCFullYear(cutoff5y.getUTCFullYear() - 5);
  const c3 = cutoff3y.toISOString().slice(0, 10);
  const c5 = cutoff5y.toISOString().slice(0, 10);
  return {
    fullHistory: { ...summarize(points), ...summarizeStrict(points) },
    trailing5yr: { ...summarize(points.filter((p) => p.date >= c5)), ...summarizeStrict(points.filter((p) => p.date >= c5)) },
    trailing3yr: { ...summarize(points.filter((p) => p.date >= c3)), ...summarizeStrict(points.filter((p) => p.date >= c3)) },
  };
}

// Walk-forward bias-correction test (dead-band-recalibration spec's
// error-feedback question): at each issue date, estimate a bias correction
// using ONLY errors from periods strictly before it (an expanding mean, and
// separately an EWMA(alpha=0.3)) — nothing looks ahead. minHistory is a
// burn-in: too few prior points makes the bias estimate itself noise, not
// signal, so those early periods are excluded from the OOS comparison
// entirely rather than scored on a near-meaningless correction.
function biasCorrectionTest(points: EvalPoint[], minHistory = 8, alpha = 0.3) {
  const priorErrors: number[] = []; // signed: actual - naive
  let ewma: number | null = null;
  let sumNaiveAbs = 0, sumExpAbs = 0, sumEwmaAbs = 0, nOOS = 0;
  for (const p of points) {
    const signedErr = p.actual - p.naive;
    if (priorErrors.length >= minHistory) {
      const expBias = priorErrors.reduce((a, b) => a + b, 0) / priorErrors.length;
      const ewmaBias = ewma ?? 0;
      sumNaiveAbs += Math.abs(p.actual - p.naive);
      sumExpAbs += Math.abs(p.actual - (p.naive + expBias));
      sumEwmaAbs += Math.abs(p.actual - (p.naive + ewmaBias));
      nOOS++;
    }
    priorErrors.push(signedErr);
    ewma = ewma == null ? signedErr : alpha * signedErr + (1 - alpha) * ewma;
  }
  if (nOOS === 0) return null;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const naiveMAE = sumNaiveAbs / nOOS, expMAE = sumExpAbs / nOOS, ewmaMAE = sumEwmaAbs / nOOS;
  return {
    nOOS, minHistory, alpha,
    naiveMAE: r2(naiveMAE),
    expandingMeanMAE: r2(expMAE), expandingMeanImprovementPct: r2((1 - expMAE / naiveMAE) * 100),
    ewmaMAE: r2(ewmaMAE), ewmaImprovementPct: r2((1 - ewmaMAE / naiveMAE) * 100),
  };
}

// State-conditional mean error — the structural argument for why a single
// running bias term can/can't work: if the naive forecast's own error
// already flips sign by state (overshoots in one, undershoots in another),
// a single running correction is chasing three different targets at once.
function stateConditionalBias(points: EvalPoint[]) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const byState = (state: EvalPoint["state"]) => {
    const pts = points.filter((p) => p.state === state);
    if (pts.length === 0) return null;
    const errs = pts.map((p) => p.actual - p.naive);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const variance = errs.reduce((s, v) => s + (v - mean) ** 2, 0) / errs.length;
    return { n: pts.length, meanError: r2(mean), sd: r2(Math.sqrt(variance)) };
  };
  return {
    accelerating: byState("accelerating"),
    decelerating: byState("decelerating"),
    persistence: byState("persistence"),
  };
}

// Historical gap series' own volatility — a sanity cross-check for threshold
// calibration ("some multiple of its own historical standard deviation"),
// independent of the walk-forward MAE/RMSE/hit-rate sweep.
function gapStats(fast: Obs[], slow: Obs[]) {
  const slowByDate = new Map(slow.map((o) => [o.date, o.value]));
  const gaps: number[] = [];
  for (const f of fast) {
    const s = slowByDate.get(f.date);
    if (s != null) gaps.push(f.value - s);
  }
  if (gaps.length === 0) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / gaps.length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n: gaps.length, mean: r2(mean), stdev: r2(Math.sqrt(variance)) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    // Defaults match the current production GROWTH_MIN_GAP/CPI_MIN_GAP
    // (lib/simulatorKeys.js) so a no-param call reports on live behavior.
    const growthMinGap = Number(url.searchParams.get("growthMinGap") ?? "0.80");
    const cpiMinGap = Number(url.searchParams.get("cpiMinGap") ?? "1.00");
    const horizonQ = Number(url.searchParams.get("horizonQ") ?? "1"); // GDP horizon, in quarters
    const horizonM = Number(url.searchParams.get("horizonM") ?? "3"); // CPI horizon, in months (3mo = 1 "quarter-equivalent")

    const [gdpRaw, cpiRaw] = await Promise.all([fetchFredSeries("GDPC1"), fetchFredSeries("CPIAUCSL")]);
    const gdpYoy = yoy(gdpRaw);
    const cpiYoy = yoy(cpiRaw);
    const gdpFast = trailingAvg(gdpYoy, 2);
    const gdpSlow = trailingAvg(gdpYoy, 4);
    const cpiFast = trailingAvg(cpiYoy, 3);
    const cpiSlow = trailingAvg(cpiYoy, 9);

    const now = new Date().toISOString().slice(0, 10);

    const gdpPoints = walkForward(gdpYoy, gdpFast, gdpSlow, growthMinGap, horizonQ, "quarter");
    const cpiPoints = walkForward(cpiYoy, cpiFast, cpiSlow, cpiMinGap, horizonM, "month");

    const report = {
      params: { growthMinGap, cpiMinGap, horizonQ, horizonM },
      growth: {
        gapStats: gapStats(gdpFast, gdpSlow),
        ...windowedReport(gdpPoints, now),
        biasCorrection: biasCorrectionTest(gdpPoints),
        stateConditionalBias: stateConditionalBias(gdpPoints),
      },
      inflation: {
        gapStats: gapStats(cpiFast, cpiSlow),
        ...windowedReport(cpiPoints, now),
        biasCorrection: biasCorrectionTest(cpiPoints),
        // CPI's monthly cadence + 3-month horizon means consecutive points'
        // target windows overlap by 2 months — inflates apparent
        // significance vs a clean sample (flagged explicitly in the
        // dead-band-recalibration spec). GDP needs no equivalent: quarterly
        // cadence + 1-quarter horizon means consecutive points don't
        // overlap at all. Re-run on every 3rd point (non-overlapping
        // 3-month windows) as the spec's requested de-correlation check.
        biasCorrectionNonOverlapping: biasCorrectionTest(cpiPoints.filter((_, i) => i % 3 === 0), 3),
        stateConditionalBias: stateConditionalBias(cpiPoints),
      },
    };

    return new Response(JSON.stringify(report, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
