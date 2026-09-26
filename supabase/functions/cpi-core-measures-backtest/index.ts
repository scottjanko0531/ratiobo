import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Standalone, temporary verification tool (same role as growth-axis-
// backtest / nearterm-signal-backtest) — tests a specific, named hypothesis:
// does adding Cleveland Fed trimmed-mean/median CPI improve on headline
// CPI's weak real-call directional accuracy (36.4%, n=44), particularly at
// trend inflections (the 2021-22 surge peak, the 2023 disinflation
// plateau)? See the user's own backtest-instructions spec for full
// rationale — this is a direct implementation of that spec's three tests.
//
// FRED series verified against FRED's own series pages before use (per the
// spec's explicit instruction not to assume the ticker) — Cleveland Fed
// publishes several suffix variants per measure; these two are the
// year-over-year ones, already YoY (no transform needed), NOT the
// annualized-monthly-rate variants (...158..., a different series):
//   TRMMEANCPIM159SFRBCLE — 16% Trimmed-Mean CPI, % change from year ago, SA
//   MEDCPIM159SFRBCLE      — Median CPI, % change from year ago, SA
// Both have real history back to Dec 1983 — well before this project's
// usual 1990+/2000+ windows, so no data-availability wall here (unlike the
// ISM-new-orders/Tariff-Impact gaps found in nearterm-signal-backtest).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

interface Obs { date: string; value: number; }

async function fredSeries(seriesId: string, start = "1985-01-01"): Promise<Obs[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  const obs = (j.observations ?? []) as { date: string; value: string }[];
  return obs.map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((o) => !isNaN(o.value));
}

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

function dateNPeriodsAhead(date: string, n: number, unit: "month"): string {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
}

function wilsonCI(hits: number, n: number): { low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.96;
  const phat = hits / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  return { low: r1((center - margin) / denom), high: r1((center + margin) / denom) };
}

interface GapPoint { date: string; fast: number; slow: number; gap: number; }
function buildGap(series: Obs[], fastN: number, slowN: number): GapPoint[] {
  const fast = trailingAvg(series, fastN);
  const slow = trailingAvg(series, slowN);
  const slowByDate = new Map(slow.map((o) => [o.date, o.value]));
  const out: GapPoint[] = [];
  for (const f of fast) {
    const s = slowByDate.get(f.date);
    if (s == null) continue;
    out.push({ date: f.date, fast: f.value, slow: s, gap: f.value - s });
  }
  return out;
}

// ── Test 1: lead-lag at the two known failure points ──────────────────────
function firstZeroCross(gaps: GapPoint[], windowStart: string, windowEnd: string, direction: "up" | "down"): string | null {
  const w = gaps.filter((g) => g.date >= windowStart && g.date <= windowEnd);
  for (let i = 1; i < w.length; i++) {
    const prevSign = Math.sign(w[i - 1].gap);
    const curSign = Math.sign(w[i].gap);
    if (direction === "up" && prevSign <= 0 && curSign > 0) return w[i].date;
    if (direction === "down" && prevSign >= 0 && curSign < 0) return w[i].date;
  }
  return null;
}
function firstThresholdCross(gaps: GapPoint[], windowStart: string, windowEnd: string, threshold: number, direction: "up" | "down"): string | null {
  const w = gaps.filter((g) => g.date >= windowStart && g.date <= windowEnd);
  for (const g of w) {
    if (direction === "up" && g.gap > threshold) return g.date;
    if (direction === "down" && g.gap < -threshold) return g.date;
  }
  return null;
}
// Momentum trough: first month where the (negative, decelerating) gap's own
// month-over-month change turns less-negative and STAYS less-negative for
// 2 more months — a real bottoming of disinflation momentum, not a 1-month wiggle.
function momentumTrough(gaps: GapPoint[], windowStart: string, windowEnd: string): string | null {
  const w = gaps.filter((g) => g.date >= windowStart && g.date <= windowEnd);
  for (let i = 1; i < w.length - 2; i++) {
    const delta1 = w[i].gap - w[i - 1].gap;
    const delta2 = w[i + 1].gap - w[i].gap;
    const delta3 = w[i + 2].gap - w[i + 1].gap;
    if (delta1 > 0 && delta2 > 0 && delta3 > 0) return w[i - 1].date; // momentum stopped getting more negative starting here
  }
  return null;
}

// Small OLS solver (normal equations + Gaussian elimination) — used to get
// each predictor's PARTIAL contribution controlling for the others, since
// PPI/WTI/Copper are all commodity/producer-price-linked and likely share
// variance; a univariate r alone could overstate PPI if it's partly just
// proxying for WTI or Copper's own, already-weighted signal.
function ols(rows: number[][], y: number[]): number[] | null {
  const n = rows.length, k = rows[0].length; // k includes the intercept column (all 1s)
  if (n <= k) return null;
  const XtX: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const XtY: number[] = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      XtY[a] += rows[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += rows[i][a] * rows[i][b];
    }
  }
  // Gaussian elimination with partial pivoting
  const M = XtX.map((row, i) => [...row, XtY[i]]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= k; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[k] / row[i]);
}
function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

function pearsonR(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}
// 3-month relative % change in a price LEVEL series — same convention as
// fetch-macro-data's level_with_3m processor / NEARTERM_INFL_SIGNALS' WTI/
// Copper/DXY inputs.
function pct3m(raw: Obs[], date: string): number | null {
  const byDate = new Map(raw.map((o) => [o.date, o.value]));
  const cur = byDate.get(date);
  if (cur == null) return null;
  const threeAgoDate = dateNPeriodsAhead(date, -3, "month");
  let prior: number | null = null;
  for (const o of raw) if (o.date <= threeAgoDate) prior = o.value; else break;
  return prior != null && prior !== 0 ? (cur / prior - 1) * 100 : null;
}
// 3-month percentage-POINT change in a YoY rate — same convention as
// yoy_monthly_with_3m / NEARTERM_INFL_SIGNALS' PPI input.
function pp3m(yoySeries: Obs[], date: string): number | null {
  const byDate = new Map(yoySeries.map((o) => [o.date, o.value]));
  const cur = byDate.get(date);
  if (cur == null) return null;
  const prior = byDate.get(dateNPeriodsAhead(date, -3, "month"));
  return prior != null ? cur - prior : null;
}

// ── Test 5: calibrate PPI's OWN dead band from scratch (its volatility
// profile is very different from headline's — PPI YoY hit 12.3% in the
// live 2025-26 episode vs headline's 4.2% peak — reusing the 1.00pp
// headline threshold here would be exactly the mistake the trimmed-mean/
// median spec warned against), then test PPI's own crossover as a
// STANDALONE predictor of headline CPI's actual 3-month-ahead move (not a
// confirmation filter on headline's own call — Test 2 already showed that
// framing has almost no statistical power for PPI, since it agrees with
// headline's sign 94% of the time). Same strict Measure 2 scoring
// throughout: actual vs naive classified against HEADLINE's own 1.00pp
// dead band (the established ground-truth definition of "did CPI move"),
// scored only where PPI itself makes a real call.
function standalonePpiAccuracy(ppiGap: GapPoint[], headlineActualByDate: Map<string, number>, headlineFastByDate: Map<string, number>, threshold: number) {
  let n = 0, hits = 0;
  const errs: number[] = [];
  for (const g of ppiGap) {
    if (Math.abs(g.gap) <= threshold) continue;
    const state: "accelerating" | "decelerating" = g.gap > 0 ? "accelerating" : "decelerating";
    const targetDate = dateNPeriodsAhead(g.date, 3, "month");
    const actual = headlineActualByDate.get(targetDate);
    const naive = headlineFastByDate.get(g.date); // headline's OWN naive anchor at the same issue date — same forecast basis as everywhere else
    if (actual == null || naive == null) continue;
    const delta = actual - naive;
    const actualDirection = delta > 1.00 ? "up" : delta < -1.00 ? "down" : "flat";
    const hit = state === "accelerating" ? actualDirection === "up" : actualDirection === "down";
    n++; if (hit) hits++;
    errs.push(Math.abs(actual - naive));
  }
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  return { threshold, n, nHits: hits, hitRatePct: n ? r1(hits / n) : null, hitRateCI: n ? wilsonCI(hits, n) : null };
}
// Early-trigger / blended use case: months where HEADLINE is in Persistence
// (no call of its own) but PPI's gap clears ITS OWN threshold — does PPI
// catch a real move headline is currently silent on? This is the direct
// operationalization of "blended signal," and the one most relevant to the
// original spec's own framing (misses cluster at trend inflections, i.e.
// exactly when headline is still in Persistence right before/at a turn).
function ppiEarlyTrigger(ppiGap: GapPoint[], headlineGapByDate: Map<string, number>, headlineActualByDate: Map<string, number>, headlineFastByDate: Map<string, number>, ppiThreshold: number) {
  let n = 0, hits = 0;
  const detail: { date: string; ppiGap: number; predicted: string; actualDirection: string; hit: boolean }[] = [];
  for (const g of ppiGap) {
    const hGap = headlineGapByDate.get(g.date);
    if (hGap == null || Math.abs(hGap) > 1.00) continue; // only score where headline itself is silent (Persistence)
    if (Math.abs(g.gap) <= ppiThreshold) continue; // PPI itself has no real call either
    const state: "accelerating" | "decelerating" = g.gap > 0 ? "accelerating" : "decelerating";
    const targetDate = dateNPeriodsAhead(g.date, 3, "month");
    const actual = headlineActualByDate.get(targetDate);
    const naive = headlineFastByDate.get(g.date);
    if (actual == null || naive == null) continue;
    const delta = actual - naive;
    const actualDirection = delta > 1.00 ? "up" : delta < -1.00 ? "down" : "flat";
    const hit = state === "accelerating" ? actualDirection === "up" : actualDirection === "down";
    n++; if (hit) hits++;
    detail.push({ date: g.date, ppiGap: Math.round(g.gap * 100) / 100, predicted: state, actualDirection, hit });
  }
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  return { ppiThreshold, n, nHits: hits, hitRatePct: n ? r1(hits / n) : null, hitRateCI: n ? wilsonCI(hits, n) : null, detail };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cpiMinGap = 1.00; // headline's calibrated threshold — reused ONLY as a same-threshold comparator in Test 1, per the spec's caution not to assume it fits trimmed-mean/median

    const [cpiRaw, trimmedRaw, medianRaw, ppiRaw, wtiRaw, copperRaw, dxyRaw, umichRows] = await Promise.all([
      fredSeries("CPIAUCSL"),
      fredSeries("TRMMEANCPIM159SFRBCLE"),
      fredSeries("MEDCPIM159SFRBCLE"),
      fredSeries("PPIACO"),
      fredSeries("DCOILWTICO"),
      fredSeries("PCOPPUSDM"),
      fredSeries("DTWEXBGS"), // proxy for the real Yahoo DXY, same substitution already used/footnoted in nearterm-signal-backtest
      supabase.from("consumer_expectations").select("survey_date, michigan_inf_exp_1yr").not("michigan_inf_exp_1yr", "is", null).order("survey_date"),
    ]);

    const headlineYoy = yoy(cpiRaw); // CPIAUCSL is an index level — needs YoY transform
    const trimmedYoy = trimmedRaw;   // already % change from year ago
    const medianYoy = medianRaw;     // already % change from year ago
    const ppiYoy = yoy(ppiRaw);      // PPIACO is an index level — needs YoY transform

    const headlineGap = buildGap(headlineYoy, 3, 9);
    const trimmedGap = buildGap(trimmedYoy, 3, 9);
    const medianGap = buildGap(medianYoy, 3, 9);
    const ppiGap = buildGap(ppiYoy, 3, 9); // same fast/slow structure as headline, on PPI YoY — PPI's own dead band is NOT calibrated, 1.00pp reused only as a same-threshold Test 1 comparator, per the same caution as trimmed-mean/median

    // ── Test 1 ──
    const test1 = {
      note: "Dates are the first month each series' fast/slow gap crosses zero (threshold-free) or the headline's own calibrated 1.00pp dead band (same-threshold comparator), inside a window around each known episode. Earlier date = earlier warning.",
      jul2021Episode: {
        window: "2020-10-01 to 2021-12-31",
        headline: {
          zeroCrossUp: firstZeroCross(headlineGap, "2020-10-01", "2021-12-31", "up"),
          thresholdCrossUp_1pp: firstThresholdCross(headlineGap, "2020-10-01", "2021-12-31", cpiMinGap, "up"),
        },
        trimmedMean: {
          zeroCrossUp: firstZeroCross(trimmedGap, "2020-10-01", "2021-12-31", "up"),
          thresholdCrossUp_1pp: firstThresholdCross(trimmedGap, "2020-10-01", "2021-12-31", cpiMinGap, "up"),
        },
        median: {
          zeroCrossUp: firstZeroCross(medianGap, "2020-10-01", "2021-12-31", "up"),
          thresholdCrossUp_1pp: firstThresholdCross(medianGap, "2020-10-01", "2021-12-31", cpiMinGap, "up"),
        },
        ppi: {
          zeroCrossUp: firstZeroCross(ppiGap, "2020-10-01", "2021-12-31", "up"),
          thresholdCrossUp_1pp: firstThresholdCross(ppiGap, "2020-10-01", "2021-12-31", cpiMinGap, "up"),
        },
      },
      aug2023Episode: {
        window: "2022-10-01 to 2023-12-31",
        note2: "momentumTrough = first month the series' own (negative) gap stops getting more negative and stays that way for 2+ more months — a real bottoming of disinflation momentum.",
        headline: {
          momentumTrough: momentumTrough(headlineGap, "2022-10-01", "2023-12-31"),
          thresholdExitDown_1pp: (() => {
            const w = headlineGap.filter((g) => g.date >= "2022-10-01" && g.date <= "2023-12-31");
            for (const g of w) if (g.gap > -cpiMinGap) return g.date; // first month it stops clearing the real "Decelerating" threshold
            return null;
          })(),
        },
        trimmedMean: { momentumTrough: momentumTrough(trimmedGap, "2022-10-01", "2023-12-31") },
        median: { momentumTrough: momentumTrough(medianGap, "2022-10-01", "2023-12-31") },
        ppi: { momentumTrough: momentumTrough(ppiGap, "2022-10-01", "2023-12-31") },
      },
    };

    // ── Test 2: walk-forward directional + value accuracy, with trimmed-mean/median as a confirmation filter ──
    // Reuses headline's own real calls (state != persistence at 1.00pp) and
    // classifies actual direction against the SAME dead band already
    // established project-wide — identical Measure 2 definition. "Agrees"
    // means the confirming series' gap has the SAME SIGN as headline's gap
    // at that issue date (sign-agreement, not a second independent
    // threshold — deliberately, since trimmed-mean/median's own dead band
    // hasn't been calibrated and the spec warns against assuming one).
    const headlineActualByDate = new Map(headlineYoy.map((o) => [o.date, o.value]));
    const trimmedGapByDate = new Map(trimmedGap.map((g) => [g.date, g.gap]));
    const medianGapByDate = new Map(medianGap.map((g) => [g.date, g.gap]));
    const ppiGapByDate = new Map(ppiGap.map((g) => [g.date, g.gap]));

    type CallRow = {
      date: string; headlineGap: number; state: "accelerating" | "decelerating";
      naive: number; actual: number | null; actualDirection: "up" | "down" | "flat" | null;
      hit: boolean | null; absErr: number | null;
      trimmedAgrees: boolean | null; medianAgrees: boolean | null; ppiAgrees: boolean | null;
    };
    const calls: CallRow[] = [];
    for (const g of headlineGap) {
      if (Math.abs(g.gap) <= cpiMinGap) continue; // persistence — not a real call, out of scope for Measure 2
      const state: "accelerating" | "decelerating" = g.gap > 0 ? "accelerating" : "decelerating";
      const targetDate = dateNPeriodsAhead(g.date, 3, "month");
      const actual = headlineActualByDate.get(targetDate) ?? null;
      const naive = g.fast;
      let actualDirection: CallRow["actualDirection"] = null, hit: boolean | null = null, absErr: number | null = null;
      if (actual != null) {
        const delta = actual - naive;
        actualDirection = delta > cpiMinGap ? "up" : delta < -cpiMinGap ? "down" : "flat";
        hit = state === "accelerating" ? actualDirection === "up" : actualDirection === "down";
        absErr = Math.abs(actual - naive);
      }
      const tGap = trimmedGapByDate.get(g.date);
      const mGap = medianGapByDate.get(g.date);
      const pGap = ppiGapByDate.get(g.date);
      calls.push({
        date: g.date, headlineGap: Math.round(g.gap * 100) / 100, state, naive, actual, actualDirection, hit, absErr,
        trimmedAgrees: tGap != null ? Math.sign(tGap) === Math.sign(g.gap) : null,
        medianAgrees: mGap != null ? Math.sign(mGap) === Math.sign(g.gap) : null,
        ppiAgrees: pGap != null ? Math.sign(pGap) === Math.sign(g.gap) : null,
      });
    }
    function summarizeSubset(rows: CallRow[]) {
      const scored = rows.filter((r) => r.hit !== null);
      const hits = scored.filter((r) => r.hit === true).length;
      const errs = scored.filter((r) => r.absErr != null).map((r) => r.absErr!);
      const r1 = (x: number) => Math.round(x * 1000) / 10;
      const r2 = (x: number) => Math.round(x * 100) / 100;
      return {
        n: scored.length, nHits: hits,
        hitRatePct: scored.length ? r1(hits / scored.length) : null,
        hitRateCI: scored.length ? wilsonCI(hits, scored.length) : null,
        naiveMAE: errs.length ? r2(errs.reduce((a, b) => a + b, 0) / errs.length) : null,
      };
    }
    const test2 = {
      baselineAllRealCalls: summarizeSubset(calls),
      trimmedMean: {
        agrees: summarizeSubset(calls.filter((r) => r.trimmedAgrees === true)),
        disagrees: summarizeSubset(calls.filter((r) => r.trimmedAgrees === false)),
        noData: calls.filter((r) => r.trimmedAgrees === null).length,
      },
      median: {
        agrees: summarizeSubset(calls.filter((r) => r.medianAgrees === true)),
        disagrees: summarizeSubset(calls.filter((r) => r.medianAgrees === false)),
        noData: calls.filter((r) => r.medianAgrees === null).length,
      },
      ppi: {
        agrees: summarizeSubset(calls.filter((r) => r.ppiAgrees === true)),
        disagrees: summarizeSubset(calls.filter((r) => r.ppiAgrees === false)),
        noData: calls.filter((r) => r.ppiAgrees === null).length,
      },
      callDetail: calls,
    };

    // ── Test 3: understatement check over the live 2025-2026 tariff episode ──
    const headlineByDate = new Map(headlineYoy.map((o) => [o.date, o.value]));
    const trimmedByDate = new Map(trimmedYoy.map((o) => [o.date, o.value]));
    const medianByDate = new Map(medianYoy.map((o) => [o.date, o.value]));
    const ppiByDate = new Map(ppiYoy.map((o) => [o.date, o.value]));
    const tariffWindowDates = [...headlineByDate.keys()].filter((d) => d >= "2025-01-01").sort();
    const test3 = tariffWindowDates.map((d) => {
      const h = headlineByDate.get(d)!;
      const t = trimmedByDate.get(d) ?? null;
      const m = medianByDate.get(d) ?? null;
      const p = ppiByDate.get(d) ?? null;
      const r2 = (x: number) => Math.round(x * 100) / 100;
      return {
        date: d, headline: r2(h),
        trimmedMean: t != null ? r2(t) : null, trimmedMeanGapVsHeadline: t != null ? r2(h - t) : null,
        median: m != null ? r2(m) : null, medianGapVsHeadline: m != null ? r2(h - m) : null,
        ppi: p != null ? r2(p) : null, ppiGapVsHeadline: p != null ? r2(h - p) : null,
      };
    });

    // ── Test 4 (new — correlation coefficients): does any candidate CPI-
    // forecasting component correlate with the actual 3-month-ahead move
    // (actual - naive, the SAME quantity Measure 1/2 already score) more
    // strongly than headline CPI's own existing momentum (fast-slow gap)
    // does? If nothing beats the baseline by a real margin, there's no
    // correlation-based case for reweighting. Uses the FULL sample (every
    // month, persistence included), not just real-call periods — a
    // correlation coefficient needs the full range of the predictor and
    // outcome, not a pre-filtered subset. No look-ahead: every predictor is
    // read at issue date t, the outcome is the actual print at t+3mo.
    const umichObs: Obs[] = ((umichRows as { data: { survey_date: string; michigan_inf_exp_1yr: number }[] | null }).data ?? [])
      .map((r) => ({ date: r.survey_date, value: Number(r.michigan_inf_exp_1yr) }));
    const umichByDate = new Map(umichObs.map((o) => [o.date, o.value]));
    function umichAt(date: string): number | null {
      let v: number | null = null;
      for (const o of umichObs) if (o.date <= date) v = o.value; else break;
      return v;
    }
    const trimmedGapByDate2 = new Map(trimmedGap.map((g) => [g.date, g.gap]));
    const medianGapByDate2 = new Map(medianGap.map((g) => [g.date, g.gap]));

    const fullSample: { date: string; delta: number; headlineGap: number; cpi3m: number | null; trimmedGap: number | null; medianGap: number | null; ppi3m: number | null; wti3m: number | null; copper3m: number | null; dxy3m: number | null; umich: number | null }[] = [];
    for (const g of headlineGap) {
      const targetDate = dateNPeriodsAhead(g.date, 3, "month");
      const actual = headlineActualByDate.get(targetDate);
      if (actual == null) continue;
      fullSample.push({
        date: g.date, delta: actual - g.fast, headlineGap: g.gap,
        cpi3m: pp3m(headlineYoy, g.date), // "CPI Momentum (3M Δ)" — the exact same quantity NEARTERM_INFL_SIGNALS already scores CPI on, for a fair like-for-like comparison against PPI's own pp3m
        trimmedGap: trimmedGapByDate2.get(g.date) ?? null, medianGap: medianGapByDate2.get(g.date) ?? null,
        ppi3m: pp3m(ppiYoy, g.date), wti3m: pct3m(wtiRaw, g.date), copper3m: pct3m(copperRaw, g.date),
        dxy3m: pct3m(dxyRaw, g.date), umich: umichAt(g.date),
      });
    }
    // Multiple regression: delta ~ intercept + cpi3m + ppi3m + wti3m + copper3m,
    // complete-case rows only. DXY/UMich excluded here (both had ~zero
    // univariate correlation already, and DXY's shorter history would
    // shrink the joint sample a lot for little expected gain).
    const regRows = fullSample.filter((r) => r.cpi3m != null && r.ppi3m != null && r.wti3m != null && r.copper3m != null);
    const X = regRows.map((r) => [1, r.cpi3m!, r.ppi3m!, r.wti3m!, r.copper3m!]);
    const Y = regRows.map((r) => r.delta);
    const beta = ols(X, Y);
    const sdY = Y.length ? stdev(Y) : 0;
    const predictorNames = ["intercept", "cpi3mChange", "ppi3mChange", "wti3mChange", "copper3mChange"];
    const multipleRegression = beta ? {
      n: regRows.length,
      coefficients: Object.fromEntries(predictorNames.map((name, i) => [name, Math.round(beta[i] * 1000) / 1000])),
      // Standardized coefficient = raw coefficient * (predictor's own stdev / outcome's stdev) —
      // puts every predictor's PARTIAL effect on the same, comparable scale regardless of its native units (pp vs %).
      standardizedCoefficients: Object.fromEntries(predictorNames.slice(1).map((name, i) => {
        const xs = regRows.map((r) => [r.cpi3m, r.ppi3m, r.wti3m, r.copper3m][i]!);
        const sdX = stdev(xs);
        return [name, sdY > 0 ? Math.round((beta![i + 1] * sdX / sdY) * 1000) / 1000 : null];
      })),
    } : { n: regRows.length, error: "regression failed (collinear or insufficient rows)" };

    function corrFor(key: keyof typeof fullSample[0]): { r: number | null; n: number } {
      const pairs = fullSample.filter((r) => r[key] != null).map((r) => [r[key] as number, r.delta] as [number, number]);
      return { r: pairs.length >= 3 ? pearsonR(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null, n: pairs.length };
    }
    // ── Test 5: PPI's own dead-band calibration + standalone/early-trigger accuracy ──
    const headlineFastByDate = new Map(headlineGap.map((g) => [g.date, g.fast]));
    const headlineGapByDate = new Map(headlineGap.map((g) => [g.date, g.gap]));
    const ppiThresholds = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
    const ppiGapMean = ppiGap.reduce((s, g) => s + g.gap, 0) / ppiGap.length;
    const ppiGapVariance = ppiGap.reduce((s, g) => s + (g.gap - ppiGapMean) ** 2, 0) / ppiGap.length;
    const test5 = {
      ppiGapStats: { n: ppiGap.length, mean: Math.round(ppiGapMean * 100) / 100, stdev: Math.round(Math.sqrt(ppiGapVariance) * 100) / 100 },
      standaloneSweep: ppiThresholds.map((t) => standalonePpiAccuracy(ppiGap, headlineActualByDate, headlineFastByDate, t)),
      earlyTriggerSweep: ppiThresholds.map((t) => {
        const r = ppiEarlyTrigger(ppiGap, headlineGapByDate, headlineActualByDate, headlineFastByDate, t);
        return { ppiThreshold: r.ppiThreshold, n: r.n, nHits: r.nHits, hitRatePct: r.hitRatePct, hitRateCI: r.hitRateCI };
      }),
      earlyTriggerDetailAtBestGuessThreshold: ppiEarlyTrigger(ppiGap, headlineGapByDate, headlineActualByDate, headlineFastByDate, 2.0).detail,
    };

    const r2b = (x: number | null) => x == null ? null : Math.round(x * 1000) / 1000;
    const test4 = {
      note: "Pearson r between each candidate's reading at issue date t and the actual CPI move (actual - naive) at t+3mo. 'headlineGap' is CPI's own existing momentum signal — the baseline every candidate needs to beat to justify a reweighting.",
      headlineGap_baseline: { r: r2b(corrFor("headlineGap").r), n: corrFor("headlineGap").n },
      cpi3mChange: { r: r2b(corrFor("cpi3m").r), n: corrFor("cpi3m").n },
      trimmedMeanGap: { r: r2b(corrFor("trimmedGap").r), n: corrFor("trimmedGap").n },
      medianGap: { r: r2b(corrFor("medianGap").r), n: corrFor("medianGap").n },
      ppi3mChange: { r: r2b(corrFor("ppi3m").r), n: corrFor("ppi3m").n },
      wti3mChange: { r: r2b(corrFor("wti3m").r), n: corrFor("wti3m").n },
      copper3mChange: { r: r2b(corrFor("copper3m").r), n: corrFor("copper3m").n },
      dxy3mChange: { r: r2b(corrFor("dxy3m").r), n: corrFor("dxy3m").n },
      umichInflExpectations: { r: r2b(corrFor("umich").r), n: corrFor("umich").n },
      multipleRegression_deltaOn_cpi_ppi_wti_copper: multipleRegression,
    };

    return new Response(JSON.stringify({
      params: { fastN: 3, slowN: 9, headlineCpiMinGap: cpiMinGap },
      seriesUsed: {
        headline: "CPIAUCSL (index, YoY computed here)",
        trimmedMean: "TRMMEANCPIM159SFRBCLE (already % change from year ago, SA)",
        median: "MEDCPIM159SFRBCLE (already % change from year ago, SA)",
      },
      test1_leadLag: test1,
      test2_directionalAndValueAccuracy: test2,
      test3_understatementCheck2025_2026: test3,
      test4_correlationCoefficients: test4,
      test5_ppiOwnCalibrationAndStandaloneAccuracy: test5,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: (e as Error)?.stack }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
