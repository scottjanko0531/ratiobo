import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Standalone, temporary verification tool — growth-inflation-indicator-
// gaps spec, Phase 4b. Resolves a real methodological gap found in Phase 0:
// none of this repo's four existing backtest harnesses test the MEDIUM-TERM
// forward-signal composite's (lib/simulatorKeys.js MEDTERM_I, mirrored in
// fetch-macro-data's MEDTERM_I, ~line 2552) own directional hit rate.
//   - growth-axis-backtest scores the STRUCTURAL fast/slow crossover — a
//     different model entirely, not the composite.
//   - run-backtest scores PORTFOLIO RETURNS — not forecast accuracy at all.
//   - cpi-core-measures-backtest is a named hypothesis test about specific
//     core-CPI measures, not this composite.
// Neither is adaptable without testing something other than what the spec
// actually asked for ("directional hit rate on the realized axis" for the
// medium-term candidates: 5y5y, Openings/Unemployed, Case-Shiller). This
// tool mirrors nearterm-signal-backtest's exact point-in-time/dead-band
// methodology (same asOf/scoreGroup/confidenceFor/wilsonCI shapes) but
// scores MEDTERM_I against a 12-month-ahead CPI YoY outcome — the midpoint
// of the spec's own "Medium-term (6-18mo)" framing, since the spec doesn't
// give a single exact horizon. Logged as a judgment call (rule 6).
//
// MEDTERM_G (growth side) is NOT built here — none of Phase 4a's candidates
// touch medium-term growth, so there's nothing to backtest on that side.
//
// Tariff Inflation Impact (0.11 of MEDTERM_I's weight) is dropped for the
// whole window, same treatment and same reason as nearterm-signal-
// backtest's own near-term composite: "Tariff Inflation Impact" is a
// data_source:"supabase" live-only computed number with no historical
// table at all. Remaining weights re-normalized by scoreGroup's own
// totalW divide, same convention used throughout this codebase.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

interface Obs { date: string; value: number; }

async function fredSeries(seriesId: string, start = "1998-01-01"): Promise<Obs[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  const obs = (j.observations ?? []) as { date: string; value: string }[];
  return obs.map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((o) => !isNaN(o.value));
}

function asOf(obs: Obs[], date: string): Obs | null {
  let best: Obs | null = null;
  for (const o of obs) { if (o.date <= date) { if (!best || o.date > best.date) best = o; } }
  return best;
}

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

function wilsonCI(hits: number, n: number): { low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.96, phat = hits / n, denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  return { low: r1((center - margin) / denom), high: r1((center + margin) / denom) };
}

// Scott's follow-up: monthly issue dates with an N-month-ahead outcome
// mean consecutive observations' target windows overlap by (N-1)/N of
// their span — classic overlapping-returns-style serial correlation
// (Hansen-Hodrick / Newey-West territory), NOT independent Bernoulli
// draws. wilsonCI above silently assumes independence, understating
// uncertainty. This computes a Newey-West HAC standard error for the
// hit-rate MEAN of a 0/1 series, Bartlett kernel, maxLag = the horizon
// minus one (the standard choice for a horizon-N overlapping design —
// it exactly spans the known-induced MA(N-1) structure from the
// overlap). Operates on the TEMPORALLY-ORDERED sequence of SCORED
// calls only (nulls/no-real-call periods filtered out first, in their
// original order) — a standard simplification, logged here rather than
// silently assumed: it loses exact calendar-adjacency for calls with a
// gap between them, but since real calls are frequent (most months
// produce one), it still captures the dominant overlap-driven
// autocorrelation the Wilson interval misses entirely.
function neweyWestHitRateCI(results: any[], maxLag: number): { mean: number; seHac: number; ciLow: number; ciHigh: number; n: number; naiveWilsonWidth: number; hacWidth: number; widthRatio: number } | null {
  const calls = results.filter((r) => r.call != null && r.hit !== null);
  const n = calls.length;
  if (n === 0) return null;
  const h = calls.map((r) => (r.hit ? 1 : 0));
  const mean = h.reduce((a, b) => a + b, 0) / n;
  const e = h.map((x) => x - mean);
  let gamma0 = 0;
  for (let t = 0; t < n; t++) gamma0 += e[t] * e[t];
  gamma0 /= n;
  let longRunVar = gamma0;
  const L = Math.min(maxLag, n - 1);
  for (let k = 1; k <= L; k++) {
    let gammaK = 0;
    for (let t = k; t < n; t++) gammaK += e[t] * e[t - k];
    gammaK /= n;
    const w = 1 - k / (L + 1); // Bartlett kernel
    longRunVar += 2 * w * gammaK;
  }
  const varMean = Math.max(longRunVar, 0) / n;
  const seHac = Math.sqrt(varMean);
  const z = 1.96;
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  const ciLow = r1(mean - z * seHac);
  const ciHigh = r1(mean + z * seHac);
  const naive = wilsonCI(h.reduce((a, b) => a + b, 0), n);
  const naiveWidth = naive ? naive.high - naive.low : 0;
  const hacWidth = ciHigh - ciLow;
  return {
    mean: r1(mean), seHac: Math.round(seHac * 1000) / 10, ciLow, ciHigh, n,
    naiveWilsonWidth: Math.round(naiveWidth * 10) / 10,
    hacWidth: Math.round(hacWidth * 10) / 10,
    widthRatio: naiveWidth > 0 ? Math.round((hacWidth / naiveWidth) * 100) / 100 : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const MEDTERM_THRESH = 0.10; // production's own threshold, reused directly
    const CPI_MIN_GAP = 1.00; // same dead band as nearterm-signal-backtest's CPI outcome
    // Scott's follow-up (robustness check): horizon and outcome-target series
    // are now query-parameterized so the SAME harness can run the 3-horizon
    // x 2-target grid, not hardcoded to the one combination already reported.
    const HORIZON_MONTHS = Number(url.searchParams.get("horizon") ?? "12"); // midpoint of the spec's "Medium-term (6-18mo)" framing — logged judgment call
    const TARGET = (url.searchParams.get("target") ?? "headline") as "headline" | "core";
    const FED_INFLATION_TARGET = 2.0; // same constant fetch-macro-data uses

    const [t10yie, expinf10yr, ulcRaw, m2Raw, tcuRaw, cpiHeadlineRaw, cpiCoreRaw, t5yifr, jtsjol, unemploy, csushpinsa] = await Promise.all([
      fredSeries("T10YIE", "1998-01-01"),
      fredSeries("EXPINF10YR", "1998-01-01"),
      fredSeries("ULCNFB", "1998-01-01"),
      fredSeries("M2SL", "1998-01-01"),
      fredSeries("TCU", "1998-01-01"),
      fredSeries("CPIAUCSL", "1990-01-01"),
      fredSeries("CPILFESL", "1990-01-01"), // core CPI (ex food/energy) — robustness-check target option
      fredSeries("T5YIFR", "1998-01-01"),   // Phase 4a candidate: 5y5y
      fredSeries("JTSJOL", "1998-01-01"),   // Phase 4a candidate: Openings/Unemployed (numerator)
      fredSeries("UNEMPLOY", "1998-01-01"), // Phase 4a candidate: Openings/Unemployed (denominator)
      fredSeries("CSUSHPINSA", "1998-01-01"), // Phase 4a candidate: Case-Shiller YoY
    ]);

    const cpiRaw = TARGET === "core" ? cpiCoreRaw : cpiHeadlineRaw;
    const ulcYoyMap = yoyMap(ulcRaw), m2YoyMap = yoyMap(m2Raw), cpiYoyMap = yoyMap(cpiRaw), caseShillerYoyMap = yoyMap(csushpinsa);

    function levelAt(raw: Obs[], asOfDate: string): number | null {
      const cur = asOf(raw, asOfDate);
      return cur ? cur.value : null;
    }
    function yoyAt(m: Map<string, number>, raw: Obs[], asOfDate: string): number | null {
      const cur = asOf(raw, asOfDate);
      return cur ? (m.get(cur.date) ?? null) : null;
    }
    // Openings per unemployed worker — date-matched by calendar month,
    // same pairing convention as _shared/ratioTwoSeries.ts (Phase 1).
    function openingsRatioAt(asOfDate: string): number | null {
      const num = asOf(jtsjol, asOfDate);
      if (!num) return null;
      const den = asOf(unemploy, num.date);
      if (!den || den.date.slice(0, 7) !== num.date.slice(0, 7) || den.value === 0) return null;
      return num.value / den.value;
    }

    // ── Baseline MEDTERM_I, exact weights/votes mirrored from fetch-macro-
    // data/index.ts (~line 2552) and lib/simulatorKeys.js. Tariff Inflation
    // Impact dropped (see file-header note).
    const MEDTERM_I: Sig[] = [
      { label: "10Y Breakeven Inflation", w: 0.26, get: (d) => levelAt(t10yie, d), vote: (v) => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "10-Year Expected Inflation", w: 0.16, get: (d) => levelAt(expinf10yr, d), vote: (v) => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "Unit Labor Costs (YoY)", w: 0.21, get: (d) => yoyAt(ulcYoyMap, ulcRaw, d), vote: (v) => v > 4 ? 1 : v >= 2 ? 0 : -1 },
      { label: "M2 Growth (YoY)", w: 0.10, get: (d) => yoyAt(m2YoyMap, m2Raw, d), vote: (v) => v > 8 ? 1 : v >= 3 ? 0 : -1 },
      { label: "Capacity Utilization", w: 0.16, get: (d) => levelAt(tcuRaw, d), vote: (v) => v > 80 ? 1 : v >= 74 ? 0 : -1 },
    ];
    // ── Phase 4a candidates ────────────────────────────────────────────────
    // 5y5y: add at 10%, from 10Y Breakeven (26→16). Vote mirrors 10Y
    // Breakeven's own exact vote shape — same instrument family (market-
    // implied forward inflation expectations), per "keep sign conventions
    // consistent with neighboring signals."
    const MEDTERM_I_CAND_5Y5Y: Sig[] = [
      { label: "10Y Breakeven Inflation", w: 0.16, get: (d) => levelAt(t10yie, d), vote: (v) => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "10-Year Expected Inflation", w: 0.16, get: (d) => levelAt(expinf10yr, d), vote: (v) => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "Unit Labor Costs (YoY)", w: 0.21, get: (d) => yoyAt(ulcYoyMap, ulcRaw, d), vote: (v) => v > 4 ? 1 : v >= 2 ? 0 : -1 },
      { label: "M2 Growth (YoY)", w: 0.10, get: (d) => yoyAt(m2YoyMap, m2Raw, d), vote: (v) => v > 8 ? 1 : v >= 3 ? 0 : -1 },
      { label: "Capacity Utilization", w: 0.16, get: (d) => levelAt(tcuRaw, d), vote: (v) => v > 80 ? 1 : v >= 74 ? 0 : -1 },
      { label: "5-Year, 5-Year Forward Inflation", w: 0.10, get: (d) => levelAt(t5yifr, d), vote: (v) => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
    ];
    // Openings/Unemployed: add at 10%, from Capacity Utilization (16→11)
    // and M2 (10→5). Vote: tight labor market (>1.2) is the leading path
    // to wage inflation per the spec's own framing — inflationary = +1.
    const MEDTERM_I_CAND_OPENINGS: Sig[] = [
      { label: "10Y Breakeven Inflation", w: 0.26, get: (d) => levelAt(t10yie, d), vote: (v) => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "10-Year Expected Inflation", w: 0.16, get: (d) => levelAt(expinf10yr, d), vote: (v) => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "Unit Labor Costs (YoY)", w: 0.21, get: (d) => yoyAt(ulcYoyMap, ulcRaw, d), vote: (v) => v > 4 ? 1 : v >= 2 ? 0 : -1 },
      { label: "M2 Growth (YoY)", w: 0.05, get: (d) => yoyAt(m2YoyMap, m2Raw, d), vote: (v) => v > 8 ? 1 : v >= 3 ? 0 : -1 },
      { label: "Capacity Utilization", w: 0.11, get: (d) => levelAt(tcuRaw, d), vote: (v) => v > 80 ? 1 : v >= 74 ? 0 : -1 },
      { label: "Job Openings / Unemployed", w: 0.10, get: openingsRatioAt, vote: (v) => v > 1.2 ? 1 : v >= 0.8 ? 0 : -1 },
    ];
    // Case-Shiller YoY: add at 5%, from Tariff Impact structural (11→6).
    // Tariff is already dropped from this tool's baseline entirely (no
    // historical table) rather than present-but-always-null, so there is
    // no live array weight to literally reduce from 11 to 6 — the
    // PROPOSED candidate (the one that would actually go to Phase 4d) is
    // 0.26+0.16+0.21+0.10+0.16+0.06(Tariff)+0.05(Case-Shiller) = 1.00
    // exactly; this backtest array is that proposal minus Tariff's row
    // entirely (0.94 raw sum here), renormalized to 1.00 by scoreGroup's
    // own totalW divide at every evaluation point — the same mechanism,
    // and the same "drop and renormalize" convention, nearterm-signal-
    // backtest already uses for its own Tariff/ISM gaps. Capacity
        // Utilization is UNCHANGED at 0.16 here — the spec's edit for this
    // candidate touches Tariff, not CapUtil.
    const MEDTERM_I_CAND_CASESHILLER: Sig[] = [
      { label: "10Y Breakeven Inflation", w: 0.26, get: (d) => levelAt(t10yie, d), vote: (v) => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "10-Year Expected Inflation", w: 0.16, get: (d) => levelAt(expinf10yr, d), vote: (v) => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "Unit Labor Costs (YoY)", w: 0.21, get: (d) => yoyAt(ulcYoyMap, ulcRaw, d), vote: (v) => v > 4 ? 1 : v >= 2 ? 0 : -1 },
      { label: "M2 Growth (YoY)", w: 0.10, get: (d) => yoyAt(m2YoyMap, m2Raw, d), vote: (v) => v > 8 ? 1 : v >= 3 ? 0 : -1 },
      { label: "Capacity Utilization", w: 0.16, get: (d) => levelAt(tcuRaw, d), vote: (v) => v > 80 ? 1 : v >= 74 ? 0 : -1 },
      { label: "Case-Shiller National HPI (YoY)", w: 0.05, get: (d) => yoyAt(caseShillerYoyMap, csushpinsa, d), vote: (v) => v > 5 ? 1 : v >= 0 ? 0 : -1 },
    ];
    // Combined: all three candidates together (5y5y + Openings + Case-
    // Shiller), each edit applied on top of the prior, same Tariff-
    // excluded-baseline adaptation as Case-Shiller alone above.
    const MEDTERM_I_CAND_COMBINED: Sig[] = [
      { label: "10Y Breakeven Inflation", w: 0.16, get: (d) => levelAt(t10yie, d), vote: (v) => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "10-Year Expected Inflation", w: 0.16, get: (d) => levelAt(expinf10yr, d), vote: (v) => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "Unit Labor Costs (YoY)", w: 0.21, get: (d) => yoyAt(ulcYoyMap, ulcRaw, d), vote: (v) => v > 4 ? 1 : v >= 2 ? 0 : -1 },
      { label: "M2 Growth (YoY)", w: 0.05, get: (d) => yoyAt(m2YoyMap, m2Raw, d), vote: (v) => v > 8 ? 1 : v >= 3 ? 0 : -1 },
      { label: "Capacity Utilization", w: 0.11, get: (d) => levelAt(tcuRaw, d), vote: (v) => v > 80 ? 1 : v >= 74 ? 0 : -1 },
      { label: "5-Year, 5-Year Forward Inflation", w: 0.10, get: (d) => levelAt(t5yifr, d), vote: (v) => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
      { label: "Job Openings / Unemployed", w: 0.10, get: openingsRatioAt, vote: (v) => v > 1.2 ? 1 : v >= 0.8 ? 0 : -1 },
      { label: "Case-Shiller National HPI (YoY)", w: 0.05, get: (d) => yoyAt(caseShillerYoyMap, csushpinsa, d), vote: (v) => v > 5 ? 1 : v >= 0 ? 0 : -1 },
    ];
    // CapUtil here is 0.11 (the Openings edit's own 16→11, NOT further
    // reduced for Case-Shiller — that edit's reduction target is Tariff,
    // which is already absent from this tool's arrays entirely).

    function weightSum(sigs: Sig[]): number { return Math.round(sigs.reduce((s, x) => s + x.w, 0) * 1000) / 1000; }

    function callFor(score: number | null): "up" | "down" | null {
      if (score == null) return null;
      if (score > MEDTERM_THRESH) return "up";
      if (score < -MEDTERM_THRESH) return "down";
      return null;
    }

    function run(sigs: Sig[], fromMonth: string, toMonth: string): any[] {
      const out: any[] = [];
      for (let d = new Date(fromMonth); d <= new Date(toMonth); d.setUTCMonth(d.getUTCMonth() + 1)) {
        const issueDate = d.toISOString().slice(0, 10);
        const s = scoreGroup(sigs, issueDate);
        const call = callFor(s.score);
        const confidence = confidenceFor(s.detail, call);
        const targetDate = dateNPeriodsAhead(issueDate, HORIZON_MONTHS, "month");
        const naiveObs = asOf(cpiRaw, issueDate); // "slow" anchor: current CPI YoY holds (12mo is long enough that current level IS the naive forecast, no separate smoothing needed)
        const naiveYoy = naiveObs ? cpiYoyMap.get(naiveObs.date) ?? null : null;
        const actualObs = asOf(cpiRaw, targetDate);
        const actualYoy = actualObs ? cpiYoyMap.get(actualObs.date) ?? null : null;
        let actualDirection: "up" | "down" | "flat" | null = null;
        if (naiveYoy != null && actualYoy != null && actualObs?.date === targetDate) {
          const delta = actualYoy - naiveYoy;
          actualDirection = delta > CPI_MIN_GAP ? "up" : delta < -CPI_MIN_GAP ? "down" : "flat";
        }
        out.push({
          issueDate, score: s.score != null ? Math.round(s.score * 1000) / 1000 : null, call, confidence,
          naive: naiveYoy, targetDate, actual: actualYoy, actualDirection,
          hit: call != null && actualDirection != null ? call === actualDirection : null,
        });
      }
      return out;
    }

    function summarizeHitRate(results: any[]) {
      const calls = results.filter((r) => r.call != null && r.hit !== null);
      const hits = calls.filter((r) => r.hit === true).length;
      const r1 = (x: number) => Math.round(x * 1000) / 10;
      return {
        n: calls.length, nHits: hits, hitRatePct: calls.length ? r1(hits / calls.length) : null,
        hitRateCI_naiveIID: calls.length ? wilsonCI(hits, calls.length) : null,
        hitRateCI_neweyWestHAC: neweyWestHitRateCI(results, Math.max(HORIZON_MONTHS - 1, 1)),
      };
    }
    function flipsPerYear(results: any[]): number | null {
      const calls = results.map((r) => r.call);
      if (calls.length < 2) return null;
      let flips = 0;
      for (let i = 1; i < calls.length; i++) if (calls[i] !== calls[i - 1]) flips++;
      const years = calls.length / 12;
      return years > 0 ? Math.round((flips / years) * 100) / 100 : null;
    }
    function regimeAgreement(baseline: any[], candidate: any[]) {
      const byDate = new Map(baseline.map((r) => [r.issueDate, r.call]));
      let n = 0, agree = 0;
      for (const c of candidate) {
        if (!byDate.has(c.issueDate)) continue;
        n++;
        if (byDate.get(c.issueDate) === c.call) agree++;
      }
      return { n, agree, agreePct: n ? Math.round((agree / n) * 1000) / 10 : null };
    }

    const startMonth = url.searchParams.get("start") ?? "2000-01-01";
    // Leaves a full HORIZON_MONTHS resolvable against real CPI data through
    // ~2026-06 (the latest CPI print this tool can reliably expect).
    const latestResolvable = new Date(Date.UTC(2026, 5, 1));
    latestResolvable.setUTCMonth(latestResolvable.getUTCMonth() - HORIZON_MONTHS);
    const endMonth = latestResolvable.toISOString().slice(0, 10);

    const baseline = run(MEDTERM_I, startMonth, endMonth);
    const cand5y5y = run(MEDTERM_I_CAND_5Y5Y, startMonth, endMonth);
    const candOpenings = run(MEDTERM_I_CAND_OPENINGS, startMonth, endMonth);
    const candCaseShiller = run(MEDTERM_I_CAND_CASESHILLER, startMonth, endMonth);
    const candCombined = run(MEDTERM_I_CAND_COMBINED, startMonth, endMonth);

    // arrayWeightSum is this tool's literal array (Tariff omitted, since
    // it can't be backtested — no historical table). proposedFullWeightSum
    // is the basket as it would actually be proposed for Phase 4d
    // (Tariff included at its stated weight) — this is the number that
    // must equal 1.00 per the spec's own rule; the array sum is always
    // (proposedFullWeightSum − Tariff's weight in that basket), renormalized
    // automatically by scoreGroup's totalW divide during scoring.
    function candidateReport(label: string, sigs: Sig[], results: any[], proposedFullWeightSum: number) {
      return {
        label,
        arrayWeightSum_TariffExcluded: weightSum(sigs),
        proposedFullWeightSum_withTariff: proposedFullWeightSum,
        hitRate: summarizeHitRate(results),
        flipsPerYear: flipsPerYear(results),
        regimeAgreementWithBaseline: regimeAgreement(baseline, results),
      };
    }

    return new Response(JSON.stringify({
      note: `Research tool, not a shipped feature. NEW for Phase 4b (the near-term composite already had nearterm-signal-backtest; this medium-term one didn't exist — see file header for why growth-axis-backtest/run-backtest/cpi-core-measures-backtest aren't adaptable). Tariff Inflation Impact (0.11 of MEDTERM_I) dropped for the whole window — no historical table — so every array below sums to less than 1.00 by exactly Tariff's weight in that basket; scoreGroup's totalW divide renormalizes this automatically during scoring, same convention nearterm-signal-backtest already uses for its own data gaps. See proposedFullWeightSum_withTariff per candidate for the number that actually must equal 1.00. MEDTERM_G (growth side) not built — no Phase 4a candidates touch it. hitRateCI_naiveIID assumes independent draws -- WRONG for an overlapping-window design (consecutive monthly issue dates share (horizon-1)/horizon of their target window). hitRateCI_neweyWestHAC is the autocorrelation-robust correction (Newey-West, Bartlett kernel, maxLag=horizon-1) -- use that one, not the naive Wilson interval, per Scott's follow-up.`,
      horizonMonths: HORIZON_MONTHS, target: TARGET,
      window: `${startMonth} to ${endMonth}, ${HORIZON_MONTHS}mo-ahead ${TARGET === "core" ? "core" : "headline"} CPI YoY outcome`,
      baseline: { arrayWeightSum_TariffExcluded: weightSum(MEDTERM_I), proposedFullWeightSum_withTariff: 1.00, hitRate: summarizeHitRate(baseline), flipsPerYear: flipsPerYear(baseline) },
      candidates: {
        cand_5y5y: candidateReport("Add 5y5y (10%, -10 from 10Y Breakeven)", MEDTERM_I_CAND_5Y5Y, cand5y5y, 1.00),
        cand_openings: candidateReport("Add Openings/Unemployed (10%, -5 CapUtil, -5 M2)", MEDTERM_I_CAND_OPENINGS, candOpenings, 1.00),
        cand_caseShiller: candidateReport("Add Case-Shiller YoY (5%, -5 Tariff)", MEDTERM_I_CAND_CASESHILLER, candCaseShiller, 1.00),
        cand_combined: candidateReport("All three combined", MEDTERM_I_CAND_COMBINED, candCombined, 1.00),
      },
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: (e as Error)?.stack }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
