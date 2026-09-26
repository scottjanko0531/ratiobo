import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Standalone, temporary verification tool (same role as growth-axis-
// backtest) — answers a user question: "does the Near-Term forward-signal
// composite (lib/simulatorKeys.js NEARTERM_GROWTH_SIGNALS/NEARTERM_INFL_
// SIGNALS, mirrored in fetch-macro-data's NEARTERM_G/NEARTERM_I) actually
// predict what GDP/CPI do next?" Nothing in the repo had ever backtested
// this — every prior backtest (growth-axis-backtest) only scored the
// STRUCTURAL fast/slow crossover, a different model entirely.
//
// Scope: 2025-01 through whatever's actually resolvable today, since that's
// what the user asked for and it's also the only window where most inputs
// have real history.
//
// Two real data-availability walls, confirmed against the DB before writing
// this, both handled by DROPPING the affected signal and re-weighting the
// rest (rescale ÷ remaining weight, same convention already used elsewhere
// in this repo for the medium-term composite):
//   - ISM Manufacturing/Services "new_orders" (ism_history/ism_services_
//     history) is scraped and only goes back to 2025-12 (9/8 rows) — dropped
//     from the GROWTH composite for the ENTIRE window (not just pre-Dec-2025)
//     so the composite's composition doesn't silently change mid-test, which
//     would bias any month-to-month comparison. Combined weight 0.25 of 1.00.
//   - "Tariff Inflation Impact" has no historical table at all (data_source
//     "supabase", a live-only computed number) — dropped from the INFLATION
//     composite for the entire window. Weight 0.05 of 1.00.
// Every other input has real, exact point-in-time history: FRED for GDPNow/
// payrolls/jobless-claims/retail-sales/unemployment/HY-OAS/CPI/PPI/WTI/
// copper (formulas copied verbatim from fetch-macro-data's processors),
// consumer_expectations (umich_1yr, real history back to 1978) and
// liquidity_monthly (total_composite_yoy, back to 2017) for the two DB-
// sourced ones. DXY is substituted with FRED's DTWEXBGS (broad trade-
// weighted dollar index) since the real Yahoo DX-Y.NYB series isn't
// reachable from here — footnoted in the report, not silently substituted.
//
// Outcome scoring reuses the EXACT same dead-band actual-direction
// methodology as growth-axis-backtest (GROWTH_MIN_GAP=0.80/CPI_MIN_GAP=1.00,
// actual vs the fast trailing-average naive anchor, N periods ahead) so the
// Near-Term composite's accuracy is directly comparable to the Structural
// axis's own already-reported 56%/36.4% strict directional hit rates — same
// question, different model.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

interface Obs { date: string; value: number; }

async function fredSeries(seriesId: string, start = "2020-01-01"): Promise<Obs[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  const obs = (j.observations ?? []) as { date: string; value: string }[];
  return obs.map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((o) => !isNaN(o.value));
}

// Most recent observation on or before `asOf` — the point-in-time "known as
// of this date" read, never a future value (no lookahead).
function asOf(obs: Obs[], date: string): Obs | null {
  let best: Obs | null = null;
  for (const o of obs) { if (o.date <= date) { if (!best || o.date > best.date) best = o; } }
  return best;
}
function monthKey(d: string) { return d.slice(0, 7); }

function yoyMap(obs: Obs[]): Map<string, number> {
  const byDate = new Map(obs.map((o) => [o.date, o.value]));
  const m = new Map<string, number>();
  for (const o of obs) {
    const d = new Date(o.date);
    const yaKey = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const prev = byDate.get(yaKey);
    if (prev != null && prev !== 0) m.set(o.date, (o.value / prev - 1) * 100);
  }
  return m;
}

function dateNPeriodsAhead(date: string, n: number, unit: "month" | "quarter"): string {
  const d = new Date(date);
  const monthsAhead = unit === "quarter" ? n * 3 : n;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsAhead, 1)).toISOString().slice(0, 10);
}

type Vote = 1 | 0 | -1;
type Sig = { label: string; w: number; get: (asOfDate: string) => number | null; vote: (v: number) => Vote };

function scoreGroup(sigs: Sig[], asOfDate: string) {
  let weighted = 0, totalW = 0;
  const detail: { label: string; w: number; val: number | null; vote: Vote | null }[] = [];
  for (const s of sigs) {
    const val = s.get(asOfDate);
    if (val == null) { detail.push({ label: s.label, w: s.w, val: null, vote: null }); continue; }
    const v = s.vote(val);
    weighted += v * s.w; totalW += s.w;
    detail.push({ label: s.label, w: s.w, val, vote: v });
  }
  return { score: totalW > 0 ? weighted / totalW : null, totalW, detail };
}

// Weighted % of signals agreeing with the call direction — exact port of
// get-regime-analysis's own consensus() confidence formula, so this
// backtest's confidence-bucket analysis (see bucketByConfidence/
// thresholdSweep below) answers the real question: "if production's 60%
// floor had been applied historically, what hit rate would it actually
// have produced?" A 0-vote signal never agrees with either direction, so
// it drags confidence down same as a contradicting signal, just less.
function confidenceFor(detail: { w: number; vote: Vote | null }[], call: "up" | "down" | null): number | null {
  if (!call) return null;
  const target = call === "up" ? 1 : -1;
  let agreed = 0, total = 0;
  for (const s of detail) {
    if (s.vote == null) continue;
    total += s.w;
    if (s.vote === target) agreed += s.w;
  }
  return total > 0 ? Math.round((agreed / total) * 100) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const startMonth = url.searchParams.get("start") ?? "2025-01-01";
    const NEARTERM_THRESH = 0.15;
    const GROWTH_MIN_GAP = 0.80, CPI_MIN_GAP = 1.00;

    // ── Fetch every real-history source up front ──────────────────────────
    const [
      gdpnow, payems, icsa, rsafs, unrate, hyOas,
      cpiRaw, ppiRaw, wtiRaw, copperRaw, dxyRaw, gdpRaw,
    ] = await Promise.all([
      // Extended from 2024-06 (growth series only had ~6 quarters, too few
      // for a confidence-bucket analysis — see growthResultsLong) back to
      // 2010, before GDPNOW's own real FRED inception (~2011-07) — fetch
      // just returns whatever actually exists, same null-handling as before.
      fredSeries("GDPNOW", "2010-06-01"),
      fredSeries("PAYEMS", "2010-01-01"),
      fredSeries("ICSA", "2010-06-01"),
      fredSeries("RSAFS", "2010-06-01"),
      fredSeries("UNRATE", "2010-01-01"),
      fredSeries("BAMLH0A0HYM2", "2010-06-01"),
      fredSeries("CPIAUCSL", "1990-01-01"),
      fredSeries("PPIACO", "1990-01-01"),
      fredSeries("DCOILWTICO", "1990-01-01"),
      fredSeries("PCOPPUSDM", "1990-01-01"),
      fredSeries("DTWEXBGS", "2006-01-01"), // DTWEXBGS itself only starts Jan 2006 — earlier months just drop Dollar's weight and renormalize (scoreGroup already does this for any null signal)
      fredSeries("GDPC1", "2010-01-01"), // extended to cover growthResultsLong's warmup + earliest issue dates
    ]);

    const { data: ismMfg } = await supabase.from("ism_history").select("period_date, new_orders").order("period_date");
    const { data: ismSvc } = await supabase.from("ism_services_history").select("period_date, new_orders").order("period_date");
    const { data: umich } = await supabase.from("consumer_expectations").select("survey_date, michigan_inf_exp_1yr").not("michigan_inf_exp_1yr", "is", null).order("survey_date");
    const { data: liq } = await supabase.from("liquidity_monthly").select("month, total_composite_yoy").not("total_composite_yoy", "is", null).order("month");

    const ismMfgObs: Obs[] = (ismMfg ?? []).filter((r) => r.new_orders != null).map((r) => ({ date: r.period_date, value: Number(r.new_orders) }));
    const ismSvcObs: Obs[] = (ismSvc ?? []).filter((r) => r.new_orders != null).map((r) => ({ date: r.period_date, value: Number(r.new_orders) }));
    const umichObs: Obs[] = (umich ?? []).map((r) => ({ date: r.survey_date, value: Number(r.michigan_inf_exp_1yr) }));
    const liqObs: Obs[] = (liq ?? []).map((r) => ({ date: r.month, value: Number(r.total_composite_yoy) }));

    const cpiYoyMap = yoyMap(cpiRaw), ppiYoyMap = yoyMap(ppiRaw), rsafsYoyMap = yoyMap(rsafs);
    const cpiYoyByDate = new Map(cpiRaw.map((o) => [o.date, o.value])); // for change3m_pp we need YoY at obs[3]-months-ago too
    const gdpYoyMap = yoyMap(gdpRaw);

    // change3m_pp for a YoY-rate series (CPI/PPI): today's YoY minus the YoY
    // reading 3 months ago — exact port of yoy_monthly_with_3m.
    function pp3m(yoyByDate: Map<string, number>, asOfDate: string): number | null {
      const cur = asOf([...yoyByDate.entries()].map(([date, value]) => ({ date, value })), asOfDate);
      if (!cur) return null;
      const threeAgo = dateNPeriodsAhead(cur.date, -3, "month");
      const prior = yoyByDate.get(threeAgo);
      return prior != null ? cur.value - prior : null;
    }
    // change3m_pct for a price LEVEL series: latest monthly obs vs the obs 3
    // months before it, relative % change — exact port of level_with_3m.
    function pct3m(raw: Obs[], asOfDate: string): number | null {
      const cur = asOf(raw, asOfDate);
      if (!cur) return null;
      const threeAgoDate = dateNPeriodsAhead(cur.date, -3, "month");
      const prior = asOf(raw, threeAgoDate);
      return prior && prior.value !== 0 ? (cur.value / prior.value - 1) * 100 : null;
    }
    // payrolls_3m_avg: 3-month trailing average of monthly level changes.
    function payrolls3mAvg(asOfDate: string): number | null {
      const upto = payems.filter((o) => o.date <= asOfDate);
      if (upto.length < 4) return null;
      const last4 = upto.slice(-4);
      const changes = [1, 2, 3].map((i) => last4[i].value - last4[i - 1].value);
      return changes.reduce((a, b) => a + b, 0) / changes.length;
    }
    // unemployment_trend: current UNRATE minus its own trailing 6-month avg
    // (the 6 months strictly before current — matches production's obs.slice(1,7)).
    function unemploymentTrend(asOfDate: string): number | null {
      const upto = unrate.filter((o) => o.date <= asOfDate);
      if (upto.length < 7) return null;
      const cur = upto[upto.length - 1].value;
      const trail = upto.slice(-7, -1);
      const trailAvg = trail.reduce((a, b) => a + b.value, 0) / trail.length;
      return cur - trailAvg;
    }
    // jobless_claims_trend: % change latest-4wk avg vs prior-4wk avg (ICSA weekly).
    function joblessClaimsTrend(asOfDate: string): number | null {
      const upto = icsa.filter((o) => o.date <= asOfDate);
      if (upto.length < 8) return null;
      const last8 = upto.slice(-8);
      const latest4 = last8.slice(4, 8).reduce((a, b) => a + b.value, 0) / 4;
      const prior4 = last8.slice(0, 4).reduce((a, b) => a + b.value, 0) / 4;
      return prior4 > 0 ? (latest4 / prior4 - 1) * 100 : null;
    }
    function yoyAt(m: Map<string, number>, raw: Obs[], asOfDate: string): number | null {
      const cur = asOf(raw, asOfDate);
      return cur ? (m.get(cur.date) ?? null) : null;
    }
    function levelAt(raw: Obs[], asOfDate: string): number | null {
      const cur = asOf(raw, asOfDate);
      return cur ? cur.value : null;
    }

    // ── NEARTERM_G / NEARTERM_I, exact weights/votes from lib/simulatorKeys.js, ──
    // ISM new_orders and Tariff Inflation Impact DROPPED (see file-header note),
    // remaining weights re-normalized automatically by scoreGroup's totalW divide.
    const NEARTERM_G: Sig[] = [
      { label: "GDPNow", w: 0.20, get: (d) => levelAt(gdpnow, d), vote: (v) => v > 2.5 ? 1 : v >= 1.0 ? 0 : -1 },
      { label: "Jobless Claims", w: 0.15, get: joblessClaimsTrend, vote: (v) => v < 0 ? 1 : v <= 5 ? 0 : -1 },
      { label: "Payrolls (3M Avg)", w: 0.15, get: payrolls3mAvg, vote: (v) => v > 100 ? 1 : v >= 0 ? 0 : -1 },
      { label: "Retail Sales", w: 0.10, get: (d) => yoyAt(rsafsYoyMap, rsafs, d), vote: (v) => v >= 2 ? 1 : v >= 0 ? 0 : -1 },
      { label: "Unemployment Trend", w: 0.05, get: unemploymentTrend, vote: (v) => v < -0.05 ? 1 : v <= 0.05 ? 0 : -1 },
      { label: "HY Spread", w: 0.05, get: (d) => levelAt(hyOas, d), vote: (v) => v < 4 ? 1 : v <= 6 ? 0 : -1 },
      { label: "Liquidity", w: 0.05, get: (d) => levelAt(liqObs, d), vote: (v) => v > 0 ? 1 : v > -3 ? 0 : -1 },
    ];
    // Current production weights (WTI Shock and Tariff Impact dropped for
    // the whole tool, per the file-header note — this is what "current" has
    // meant in every prior run of this tool, kept as-is for a like-for-like
    // comparison against the reweighted version below).
    const NEARTERM_I: Sig[] = [
      { label: "CPI Momentum (3M pp)", w: 0.20, get: (d) => pp3m(cpiYoyMap, d), vote: (v) => v < -0.5 ? -1 : v > 0.5 ? 1 : 0 },
      { label: "PPI Trend (3M pp)", w: 0.20, get: (d) => pp3m(ppiYoyMap, d), vote: (v) => v < -1.0 ? -1 : v > 1.0 ? 1 : 0 },
      { label: "WTI 3M", w: 0.10, get: (d) => pct3m(wtiRaw, d), vote: (v) => v > 5 ? 1 : v >= -5 ? 0 : -1 },
      { label: "Copper 3M", w: 0.10, get: (d) => pct3m(copperRaw, d), vote: (v) => v > 5 ? 1 : v >= -5 ? 0 : -1 },
      { label: "Dollar (3M, DTWEXBGS proxy)", w: 0.10, get: (d) => pct3m(dxyRaw, d), vote: (v) => v > 5 ? -1 : v < -5 ? 1 : 0 },
      { label: "Short-Run Infl Expectations", w: 0.10, get: (d) => levelAt(umichObs, d), vote: (v) => v > 4 ? 1 : v >= 2.5 ? 0 : -1 },
    ];
    // Reweighted per the multiple-regression result from cpi-core-measures-
    // backtest (delta ~ cpi3m + ppi3m + wti3m + copper3m, n=261, standardized
    // coefficients PPI 0.499 / Copper 0.156 / CPI -0.074 / WTI -0.020):
    // only CPI Momentum/PPI/WTI/Copper are touched (proportional to
    // |standardized coefficient| among their combined 0.60 prior weight);
    // Dollar and Short-Run Infl Expectations are untouched — they weren't
    // part of that regression.
    const NEARTERM_I_REWEIGHTED: Sig[] = [
      { label: "CPI Momentum (3M pp)", w: 0.06, get: (d) => pp3m(cpiYoyMap, d), vote: (v) => v < -0.5 ? -1 : v > 0.5 ? 1 : 0 },
      { label: "PPI Trend (3M pp)", w: 0.40, get: (d) => pp3m(ppiYoyMap, d), vote: (v) => v < -1.0 ? -1 : v > 1.0 ? 1 : 0 },
      { label: "WTI 3M", w: 0.02, get: (d) => pct3m(wtiRaw, d), vote: (v) => v > 5 ? 1 : v >= -5 ? 0 : -1 },
      { label: "Copper 3M", w: 0.125, get: (d) => pct3m(copperRaw, d), vote: (v) => v > 5 ? 1 : v >= -5 ? 0 : -1 },
      { label: "Dollar (3M, DTWEXBGS proxy)", w: 0.10, get: (d) => pct3m(dxyRaw, d), vote: (v) => v > 5 ? -1 : v < -5 ? 1 : 0 },
      { label: "Short-Run Infl Expectations", w: 0.10, get: (d) => levelAt(umichObs, d), vote: (v) => v > 4 ? 1 : v >= 2.5 ? 0 : -1 },
    ];

    function callFor(score: number | null): "up" | "down" | null {
      if (score == null) return null;
      if (score > NEARTERM_THRESH) return "up";
      if (score < -NEARTERM_THRESH) return "down";
      return null; // Persistence — no directional claim
    }

    // ── Growth: quarterly issue dates, 1Q-ahead GDP outcome, same dead band ──
    // as the Structural axis (GROWTH_MIN_GAP=0.80 vs the fast 2Q-avg naive).
    const gdpFastByDate = new Map<string, number>();
    { // 2Q trailing avg YoY, date-keyed, mirrors growth-axis-backtest's trailingAvg
      const yoyArr = [...gdpYoyMap.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date < b.date ? -1 : 1);
      for (let i = 1; i < yoyArr.length; i++) gdpFastByDate.set(yoyArr[i].date, (yoyArr[i].value + yoyArr[i - 1].value) / 2);
    }
    function runGrowth(fromDate: string, toDate: string): any[] {
      const out: any[] = [];
      const [fy, fm] = fromDate.split("-").map(Number);
      let year = fy, q = Math.floor((fm - 1) / 3);
      for (;;) {
        const issueDate = `${year}-${String(q * 3 + 1).padStart(2, "0")}-01`;
        if (issueDate > toDate) break;
        const g = scoreGroup(NEARTERM_G, issueDate);
        const call = callFor(g.score);
        const confidence = confidenceFor(g.detail, call);
        const naive = asOf([...gdpFastByDate.entries()].map(([date, value]) => ({ date, value })), issueDate);
        const targetDate = dateNPeriodsAhead(issueDate, 1, "quarter");
        const actualObs = asOf(gdpRaw, targetDate);
        const actualYoy = actualObs ? gdpYoyMap.get(actualObs.date) : null;
        let actualDirection: "up" | "down" | "flat" | null = null;
        if (naive != null && actualYoy != null && actualObs?.date === targetDate) {
          const delta = actualYoy - naive.value;
          actualDirection = delta > GROWTH_MIN_GAP ? "up" : delta < -GROWTH_MIN_GAP ? "down" : "flat";
        }
        out.push({
          issueDate, score: g.score != null ? Math.round(g.score * 1000) / 1000 : null, call, confidence,
          naive: naive?.value ?? null, targetDate, actual: actualYoy, actualDirection,
          hit: call != null && actualDirection != null ? call === actualDirection : null,
          detail: g.detail,
        });
        q++; if (q > 3) { q = 0; year++; }
      }
      return out;
    }
    const growthResults = runGrowth(startMonth, "2026-07-01");
    // GDPNow's real FRED history starts ~2011-07 — the short window
    // (default 2025-01+) only ever produced ~6 quarterly calls, nowhere
    // near enough to bucket by confidence. This reruns the identical
    // model/logic from much further back so the confidence-bucket/
    // threshold-sweep analysis below has a real sample.
    const growthLongStart = url.searchParams.get("growthLongStart") ?? "2012-01-01";
    const growthResultsLong = runGrowth(growthLongStart, "2026-07-01");

    // ── Inflation: monthly issue dates, 3M-ahead CPI outcome, same dead band ──
    const cpiFastByDate = new Map<string, number>();
    {
      const yoyArr = [...cpiYoyMap.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date < b.date ? -1 : 1);
      for (let i = 2; i < yoyArr.length; i++) {
        const w = yoyArr.slice(i - 2, i + 1);
        cpiFastByDate.set(yoyArr[i].date, w.reduce((s, o) => s + o.value, 0) / 3);
      }
    }
    function wilsonCI(hits: number, n: number): { low: number; high: number } | null {
      if (n === 0) return null;
      const z = 1.96, phat = hits / n, denom = 1 + (z * z) / n;
      const center = phat + (z * z) / (2 * n);
      const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
      const r1 = (x: number) => Math.round(x * 1000) / 10;
      return { low: r1((center - margin) / denom), high: r1((center + margin) / denom) };
    }
    function round1(x: number): number { return Math.round(x * 10) / 10; }
    // Buckets real calls (call != null) by their own confidence score into
    // fixed bands — answers "does accuracy actually rise with confidence,
    // and if so where," rather than assuming the production 60% floor
    // (CONFIDENCE_FLOOR in update-regime-portfolio-targets) is correct.
    function bucketByConfidence(results: any[]) {
      const calls = results.filter((r) => r.call != null && r.hit !== null && r.confidence != null);
      const bins = [
        { label: "<50%", min: 0, max: 50 },
        { label: "50-60%", min: 50, max: 60 },
        { label: "60-70%", min: 60, max: 70 },
        { label: "70-80%", min: 70, max: 80 },
        { label: "80-90%", min: 80, max: 90 },
        { label: "90-100%", min: 90, max: 101 },
      ];
      return bins.map((b) => {
        const inBin = calls.filter((r) => r.confidence >= b.min && r.confidence < b.max);
        const hits = inBin.filter((r) => r.hit === true).length;
        return {
          bucket: b.label, n: inBin.length, nHits: hits,
          hitRatePct: inBin.length ? round1((hits / inBin.length) * 100) : null,
          hitRateCI: inBin.length ? wilsonCI(hits, inBin.length) : null,
        };
      });
    }
    // The actual "optimal trigger" question: for each candidate confidence
    // floor, what hit rate (and sample size) would REQUIRING that floor
    // have produced historically, cumulative (>= X, not a discrete band).
    // n shrinks monotonically as the floor rises — a floor only earns its
    // keep if hit rate rises enough to justify the smaller, noisier sample
    // (compare CIs, not just point estimates, especially past n<20 or so).
    function thresholdSweep(results: any[]) {
      const calls = results.filter((r) => r.call != null && r.hit !== null && r.confidence != null);
      const thresholds = [0, 40, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
      return thresholds.map((t) => {
        const atOrAbove = calls.filter((r) => r.confidence >= t);
        const hits = atOrAbove.filter((r) => r.hit === true).length;
        return {
          minConfidence: t, n: atOrAbove.length, nHits: hits,
          hitRatePct: atOrAbove.length ? round1((hits / atOrAbove.length) * 100) : null,
          hitRateCI: atOrAbove.length ? wilsonCI(hits, atOrAbove.length) : null,
        };
      });
    }
    function runInflation(sigs: Sig[], fromMonth: string): any[] {
      const out: any[] = [];
      for (let d = new Date(fromMonth); d <= new Date("2026-06-01"); d.setUTCMonth(d.getUTCMonth() + 1)) {
        const issueDate = d.toISOString().slice(0, 10);
        const i = scoreGroup(sigs, issueDate);
        const call = callFor(i.score);
        const confidence = confidenceFor(i.detail, call);
        const naive = asOf([...cpiFastByDate.entries()].map(([date, value]) => ({ date, value })), issueDate);
        const targetDate = dateNPeriodsAhead(issueDate, 3, "month");
        const actualObs = asOf(cpiRaw, targetDate);
        const actualYoy = actualObs ? cpiYoyMap.get(actualObs.date) : null;
        let actualDirection: "up" | "down" | "flat" | null = null;
        if (naive != null && actualYoy != null && actualObs?.date === targetDate) {
          const delta = actualYoy - naive.value;
          actualDirection = delta > CPI_MIN_GAP ? "up" : delta < -CPI_MIN_GAP ? "down" : "flat";
        }
        out.push({
          issueDate, score: i.score != null ? Math.round(i.score * 1000) / 1000 : null, call, confidence,
          naive: naive?.value ?? null, targetDate, actual: actualYoy, actualDirection,
          hit: call != null && actualDirection != null ? call === actualDirection : null,
        });
      }
      return out;
    }
    // Long window (real history back to 2000, same era as the Structural
    // CPI backtest's own 36.4%/n=44 baseline) so the current-vs-reweighted
    // comparison has a real sample, not just the 2025-2026 slice this tool
    // originally shipped with.
    const longWindowStart = url.searchParams.get("longStart") ?? "2000-01-01";
    const inflResultsCurrent = runInflation(NEARTERM_I, longWindowStart);
    const inflResultsReweighted = runInflation(NEARTERM_I_REWEIGHTED, longWindowStart);
    function summarizeHitRate(results: any[]) {
      const calls = results.filter((r) => r.call != null && r.hit !== null);
      const hits = calls.filter((r) => r.hit === true).length;
      const r1 = (x: number) => Math.round(x * 1000) / 10;
      return { n: calls.length, nHits: hits, hitRatePct: calls.length ? r1(hits / calls.length) : null, hitRateCI: calls.length ? wilsonCI(hits, calls.length) : null };
    }
    const inflCompare = {
      window: `${longWindowStart} to ~2026-06`,
      current: summarizeHitRate(inflResultsCurrent),
      reweighted: summarizeHitRate(inflResultsReweighted),
    };

    // Was a hand-duplicated copy of runInflation's body over a shorter
    // window — replaced with the real call now that confidence needs to
    // stay in sync in exactly one place.
    const inflResults = runInflation(NEARTERM_I, startMonth);

    function summarize(results: any[]) {
      const scored = results.filter((r) => r.hit !== null);
      const calls = scored.filter((r) => r.call != null);
      const hits = calls.filter((r) => r.hit === true).length;
      return {
        nEvaluated: results.length,
        nWithRealCall: calls.length,
        nHits: hits,
        hitRatePct: calls.length ? Math.round((hits / calls.length) * 1000) / 10 : null,
        nPersistenceCall: scored.length - calls.length,
      };
    }

    return new Response(JSON.stringify({
      note: "Research tool, not a shipped feature. ISM new-orders (growth, 0.25 wt) and Tariff Inflation Impact (inflation, 0.05 wt) dropped for the whole window — no usable point-in-time history in the DB. DXY approximated with FRED DTWEXBGS (broad trade-weighted dollar), not the real Yahoo DX-Y.NYB series.",
      growth: { summary: summarize(growthResults), results: growthResults },
      inflation: { summary: summarize(inflResults), results: inflResults },
      inflationCurrentVsReweighted_longWindow: inflCompare,
      // Answers "what confidence level is the optimal trigger for the
      // near-term signal": bucketed accuracy by confidence band, plus a
      // cumulative threshold sweep, for both axes independently (growth
      // vs GDP, inflation vs CPI). growthResultsLong/inflResultsCurrent are
      // the long-window runs — the short windows (growthResults/inflResults
      // above) don't have enough real calls to bucket meaningfully.
      confidenceAnalysis: {
        growth: {
          window: `${growthLongStart} to ~2026-07`,
          summary: summarize(growthResultsLong),
          confidenceBuckets: bucketByConfidence(growthResultsLong),
          thresholdSweep: thresholdSweep(growthResultsLong),
        },
        inflation: {
          window: inflCompare.window,
          current: {
            confidenceBuckets: bucketByConfidence(inflResultsCurrent),
            thresholdSweep: thresholdSweep(inflResultsCurrent),
          },
          reweighted: {
            confidenceBuckets: bucketByConfidence(inflResultsReweighted),
            thresholdSweep: thresholdSweep(inflResultsReweighted),
          },
        },
      },
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: (e as Error)?.stack }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
