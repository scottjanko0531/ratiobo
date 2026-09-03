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
  naiveAbsErr: number;
  modelAbsErr: number;
  naiveSqErr: number;
  modelSqErr: number;
  directionHit: boolean | null; // null when isSignal is false (no directional claim to score)
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
    const naive = f.value;
    const model = isSignal ? f.value + horizonN * gap : f.value;

    const naiveAbsErr = Math.abs(actual - naive);
    const modelAbsErr = Math.abs(actual - model);
    const directionHit = isSignal
      ? Math.sign(model - naive) === Math.sign(actual - naive) || Math.abs(actual - naive) < 1e-9
      : null;

    points.push({
      date: f.date, isSignal,
      naiveAbsErr, modelAbsErr,
      naiveSqErr: naiveAbsErr ** 2, modelSqErr: modelAbsErr ** 2,
      directionHit,
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

function windowedReport(points: EvalPoint[], nowDate: string) {
  const cutoff3y = new Date(nowDate); cutoff3y.setUTCFullYear(cutoff3y.getUTCFullYear() - 3);
  const cutoff5y = new Date(nowDate); cutoff5y.setUTCFullYear(cutoff5y.getUTCFullYear() - 5);
  const c3 = cutoff3y.toISOString().slice(0, 10);
  const c5 = cutoff5y.toISOString().slice(0, 10);
  return {
    fullHistory: summarize(points),
    trailing5yr: summarize(points.filter((p) => p.date >= c5)),
    trailing3yr: summarize(points.filter((p) => p.date >= c3)),
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
      },
      inflation: {
        gapStats: gapStats(cpiFast, cpiSlow),
        ...windowedReport(cpiPoints, now),
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
