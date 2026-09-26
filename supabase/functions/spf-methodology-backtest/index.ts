import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Standalone, temporary verification tool (same role as growth-axis-
// backtest / cpi-core-measures-backtest) — implements the user's SPF-
// methodology spec's Test 1 (unit-matched consensus benchmark) and Test 3
// (forecast-revision lead-lag). Test 2 (dispersion as an uncertainty
// signal) is NOT built here — see the CONFIRMED FINDINGS note in the
// report below; it needs data this project has never ingested.
//
// CONFIRMED LIVE BUG, found while building this (not hypothetical): every
// value in `spf_forecasts` is the quarterly-path ANNUALIZED q/q rate (BEA
// convention) — verified directly against the DB (2026-Q3 vintage, CPI
// horizon 1 = 6.1%, horizon 2 = 2.28% — the exact one-quarter-hot-then-
// normal shape a quarterly-annualized print makes on a tariff-driven price
// LEVEL jump, not a real one-quarter doubling of trend inflation). There is
// no Q4/Q4 or long-run-average data anywhere in this table — only this one
// risky format. And it's already being compared to YoY, unit-mismatched,
// in two places:
//   - fetch-macro-data's MEDTERM_G "GDP vs SPF (fwd)" signal
//     (useSpfSpread: "spf_consensus_gdp_fwd") computes actual YoY GDP minus
//     a raw quarterly-annualized SPF average — a real, live apples-to-
//     oranges spread feeding a production regime signal.
//   - app/macro/page.jsx's "Forward Consensus (SPF)" drawer block plots
//     spf_forecasts.value directly "alongside the historical actuals"
//     (its own comment) — i.e. alongside YoY chart lines, no conversion.
// Not fixed here — flagged for a separate, explicit decision, since fixing
// it changes what a shipped signal/display has been showing.
//
// Unit-matching approach used below (the spec's own suggested fallback,
// since no Q4/Q4 column was ever ingested): chain SPF's own sequential
// quarterly-annualized rate forecasts forward from a REAL, known FRED
// anchor level, then compute YoY from the resulting implied level path —
// the same de-annualization identity BEA itself uses (level_q =
// level_(q-1) * (1 + rate/100)^(1/4)), just applied forward instead of
// backward. CPI anchors one quarter before the survey's own quarter (the
// survey file provides a real horizon-1 rate, so no approximation needed).
// RGDP's ingestion never stored a horizon-1 rate (see update-spf-forecasts'
// own comment on why), so RGDP anchors on this project's own real,
// now-known FRED level AT the survey's quarter itself, then chains via
// horizons 2-6 — a deliberate approximation (isolates the forecast panel's
// path-forecasting skill from their own contemporaneous nowcast error),
// documented, not hidden.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

interface Obs { date: string; value: number; }
async function fredSeries(seriesId: string, start = "1975-01-01"): Promise<Obs[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  const obs = (j.observations ?? []) as { date: string; value: string }[];
  return obs.map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((o) => !isNaN(o.value));
}
function quarterStart(y: number, q: number) { return `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`; }
function addQ(y: number, q: number, n: number) { const t = (q - 1) + n; return { y: y + Math.floor(t / 4), q: (((t % 4) + 4) % 4) + 1 }; }
function parseVintage(v: string) { const [y, q] = v.split("-Q").map(Number); return { y, q }; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // PostgREST enforces a hard server-side max-rows cap (~1000) that a
    // client-side .limit() ABOVE that cap does NOT override — confirmed by
    // testing (a .limit(5000) request still silently truncated at the
    // server's own ceiling, cutting off the most recent ~14 vintages on an
    // ascending sort). Already known and worked around elsewhere in this
    // project (page.jsx's SPF drawer fetch, via two narrower queries) —
    // the general fix is pagination via .range(), used here instead.
    async function fetchAllSpf(code: string) {
      const out: { vintage_label: string; horizon_quarters: number; value: number }[] = [];
      const PAGE = 900;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase.from("spf_forecasts").select("vintage_label, horizon_quarters, value")
          .eq("variable_code", code).order("vintage_label").range(offset, offset + PAGE - 1);
        if (error) throw new Error(`spf_forecasts ${code} page @${offset}: ${error.message}`);
        if (!data || data.length === 0) break;
        out.push(...data);
        if (data.length < PAGE) break;
      }
      return out;
    }
    const [cpiRows, rgdpRows, cpiFred, gdpFred] = await Promise.all([
      fetchAllSpf("CPI"),
      fetchAllSpf("RGDP"),
      fredSeries("CPIAUCSL"),
      fredSeries("GDPC1"),
    ]);

    // Real FRED level lookups, keyed by calendar quarter-start date.
    const cpiLevelByQ = new Map<string, number>();
    for (const o of cpiFred as Obs[]) if (o.date.slice(5, 7).match(/^(01|04|07|10)$/)) cpiLevelByQ.set(o.date.slice(0, 7), o.value);
    const gdpLevelByQ = new Map<string, number>();
    for (const o of gdpFred as Obs[]) gdpLevelByQ.set(o.date.slice(0, 7), o.value); // GDPC1 is already quarterly

    function levelAtQ(map: Map<string, number>, y: number, q: number): number | null {
      return map.get(quarterStart(y, q).slice(0, 7)) ?? null;
    }

    type Vintage = { vintage: string; y: number; q: number; rates: Map<number, number> };
    function groupByVintage(rows: { vintage_label: string; horizon_quarters: number; value: number }[]): Vintage[] {
      const m = new Map<string, Vintage>();
      for (const r of rows) {
        if (!m.has(r.vintage_label)) { const { y, q } = parseVintage(r.vintage_label); m.set(r.vintage_label, { vintage: r.vintage_label, y, q, rates: new Map() }); }
        m.get(r.vintage_label)!.rates.set(r.horizon_quarters, Number(r.value));
      }
      return [...m.values()].sort((a, b) => a.vintage < b.vintage ? -1 : 1);
    }
    const cpiVintages = groupByVintage(cpiRows ?? []);
    const rgdpVintages = groupByVintage(rgdpRows ?? []);

    // Chain-YoY: returns {targetQuarterKey -> yoyPct} for each implied quarter this vintage's rates reach.
    function chainCpi(v: Vintage): Map<string, number> {
      const anchor = levelAtQ(cpiLevelByQ, ...(() => { const p = addQ(v.y, v.q, -1); return [p.y, p.q] as [number, number]; })());
      const out = new Map<string, number>();
      if (anchor == null) return out;
      const implied: (number | null)[] = [];
      let level = anchor;
      for (let h = 1; h <= 6; h++) {
        const r = v.rates.get(h);
        if (r == null) { implied.push(null); continue; }
        level = level * Math.pow(1 + r / 100, 0.25);
        implied.push(level);
      }
      for (let k = 0; k < 6; k++) {
        if (implied[k] == null) continue;
        const target = addQ(v.y, v.q, k);
        const baseQ = addQ(v.y, v.q, k - 4);
        const baseLevel = k >= 4 ? implied[k - 4] : levelAtQ(cpiLevelByQ, baseQ.y, baseQ.q);
        if (baseLevel == null) continue;
        out.set(quarterStart(target.y, target.q), (implied[k]! / baseLevel - 1) * 100);
      }
      return out;
    }
    function chainRgdp(v: Vintage): Map<string, number> {
      const anchor = levelAtQ(gdpLevelByQ, v.y, v.q); // real, now-known level AT the survey's own quarter (see header note)
      const out = new Map<string, number>();
      if (anchor == null) return out;
      // index 0 = the survey's own quarter (v.quarter+0) — IS the anchor
      // itself (no h=1 row to derive it from; RGDP's ingestion never
      // stored one — see header note), not left null. Fixed after an
      // initial version of this left index 0 null, which silently broke
      // every k>=4 YoY lookup below (they all need index k-4, and the
      // smallest of those, index 0, was never populated).
      const implied: (number | null)[] = [anchor];
      let level = anchor;
      for (let h = 2; h <= 6; h++) {
        const r = v.rates.get(h);
        if (r == null) { implied.push(null); continue; }
        level = level * Math.pow(1 + r / 100, 0.25);
        implied.push(level); // implied[h-1] = level at survey_quarter + (h-1)
      }
      for (let k = 1; k < 6; k++) {
        if (implied[k] == null) continue;
        const target = addQ(v.y, v.q, k);
        const baseQ = addQ(v.y, v.q, k - 4);
        const baseLevel = k >= 4 ? implied[k - 4] : levelAtQ(gdpLevelByQ, baseQ.y, baseQ.q);
        if (baseLevel == null) continue;
        out.set(quarterStart(target.y, target.q), (implied[k]! / baseLevel - 1) * 100);
      }
      return out;
    }

    // ── Test 1: unit-matched consensus benchmark, most recent 8 vintages ──
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const recentCpi = cpiVintages.slice(-8).map((v) => {
      const chained = chainCpi(v);
      const rawH1 = v.rates.get(1) ?? null; // the raw, unit-MISmatched figure currently shown live
      const fourQOut = addQ(v.y, v.q, 4);
      const chainedYoy4Q = chained.get(quarterStart(fourQOut.y, fourQOut.q)) ?? null;
      return { vintage: v.vintage, rawQuarterlyAnnualizedH1: rawH1, chainedYoY_4QOut: chainedYoy4Q != null ? r2(chainedYoy4Q) : null, targetQuarter: quarterStart(fourQOut.y, fourQOut.q) };
    });
    const recentRgdp = rgdpVintages.slice(-8).map((v) => {
      const chained = chainRgdp(v);
      const rawH2 = v.rates.get(2) ?? null;
      const fourQOut = addQ(v.y, v.q, 4);
      const chainedYoy4Q = chained.get(quarterStart(fourQOut.y, fourQOut.q)) ?? null;
      return { vintage: v.vintage, rawQuarterlyAnnualizedH2: rawH2, chainedYoY_4QOut: chainedYoy4Q != null ? r2(chainedYoy4Q) : null, targetQuarter: quarterStart(fourQOut.y, fourQOut.q) };
    });

    // ── Test 3: revision lead-lag around the 2021 Stagflation miss ──
    // A "revision" = how much the SAME target quarter's forecast changed
    // between two consecutive vintages (raw quarterly-annualized rate,
    // horizon-shifted by 1 each vintage since the target quarter is fixed
    // while horizon counts down) — no chain/unit-matching needed for a
    // revision SIZE, since it's rate-vs-rate for the identical quarter.
    function revisionSeries(vintages: Vintage[]): { vintage: string; targetQuarter: string; thisH: number; prevH: number | null; revision: number | null }[] {
      const out: { vintage: string; targetQuarter: string; thisH: number; prevH: number | null; revision: number | null }[] = [];
      for (let i = 1; i < vintages.length; i++) {
        const cur = vintages[i], prev = vintages[i - 1];
        // Compare cur's horizon-1 (this vintage's own current-quarter read) against
        // prev's horizon-2 (prev vintage's forecast for what is now cur's current quarter) — same target quarter, one vintage apart.
        const thisH = cur.rates.get(1);
        const prevH = prev.rates.get(2);
        if (thisH == null) continue;
        out.push({ vintage: cur.vintage, targetQuarter: quarterStart(cur.y, cur.q), thisH, prevH: prevH ?? null, revision: prevH != null ? r2(thisH - prevH) : null });
      }
      return out;
    }
    const cpiRevisions = revisionSeries(cpiVintages).filter((r) => r.vintage >= "2020-Q1" && r.vintage <= "2022-Q4");

    return new Response(JSON.stringify({
      confirmedLiveUnitMismatch: {
        summary: "spf_forecasts stores ONLY quarterly-path-annualized rates. No Q4/Q4 or long-run column exists. This is already compared directly to YoY in production in two places (MEDTERM_G 'GDP vs SPF (fwd)' signal, and the 'Forward Consensus (SPF)' drawer plot) — not fixed in this tool, flagged for a separate decision.",
        example: { vintage: "2026-Q3", cpi_h1_rawQuarterlyAnnualized: cpiVintages.at(-1)?.rates.get(1) ?? null },
      },
      test1_unitMatchedConsensusBenchmark: {
        note: "rawQuarterlyAnnualized is what's currently shown live (or would be, unconverted) — chainedYoY_4QOut is the unit-correct comparison to Ratiobo's own YoY reads, computed by chaining SPF's own quarterly path forward from a real FRED anchor.",
        cpi: recentCpi,
        rgdp: recentRgdp,
      },
      test3_revisionLeadLag_2021: {
        note: "revision = this vintage's read for a target quarter minus the PRIOR vintage's read for the same target quarter (raw quarterly-annualized rate, no chaining needed for a same-quarter revision). Ratiobo's own Structural regime caught the Stagflation shift by Jul-21/Oct-21 (per the already-established regime backtest) — did a large SPF revision predate that?",
        cpiRevisions,
      },
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: (e as Error)?.stack }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
