import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRED_API_KEY = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Gauge 7 — "Privilege Erosion". Composite of market-priced privilege
// signals, matching the existing gauge convention (higher z = more risk).
//
// GROUPED weighting per spec's own correction: the demand-side components
// (official share, custody, indirect bidder share) are all measuring foreign
// official demand from different angles and will co-move, so they collapse
// into one slot rather than three, alongside CY10, gold/real-yield
// correlation, and the term premium.
//
// CY Slope (30Y−2Y) is OMITTED from this build — no reachable 30Y SOFR swap
// source exists (checked both Chatham, blocked by Cloudflare at this
// project's edge-function egress IPs, and Pensford, whose feed tops out at
// 10YR for SOFR swaps). z_cy_slope is left null; the formula below averages
// the 4 remaining slots instead of 5. Revisit if a 30Y source turns up.
//
// Unlike gauges 1-6 (annual-frequency inputs, re-stamped daily into
// gauge_daily_snapshots from a once-a-year computation), every input here is
// genuinely daily/weekly/monthly, so this function computes a real "as of
// today" reading on every run — the dalio_gauge_readings row for the current
// year holds the latest such reading, consistent with how that table is
// otherwise used as a running snapshot rather than a true annual average.
const TERM_PREMIUM_SERIES = "THREEFYTP10";

type Pt = { date: string; value: number };

function mean(vals: number[]): number { return vals.reduce((s, v) => s + v, 0) / vals.length; }
function stdev(vals: number[]): number {
  const mu = mean(vals);
  return Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / vals.length) || 1;
}
function zScoreSeries(pts: Pt[]): Pt[] {
  if (pts.length < 5) return [];
  const vals = pts.map((p) => p.value);
  const mu = mean(vals), sd = stdev(vals);
  return pts.map((p) => ({ date: p.date, value: (p.value - mu) / sd }));
}
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
// Resamples a (date-sorted ascending) series to one value per calendar month
// (last observation in that month) — the common frequency used to align
// components that natively update at very different cadences (daily CY vs.
// monthly TIC share vs. per-auction indirect-bidder average) for the
// pairwise correlation diagnostic.
function monthlyResample(pts: Pt[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pts) out.set(p.date.slice(0, 7), p.value); // later points overwrite earlier -> last obs in month wins
  return out;
}

async function fetchFredSeries(seriesId: string): Promise<Pt[]> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&sort_order=asc&limit=100000&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const [cyRes, ticRes, custodyRes, auctionRes, goldCorrRes, termPremium] = await Promise.all([
      sb.from("convenience_yield_observations").select("obs_date, convenience_bp").eq("tenor_years", 10).order("obs_date"),
      sb.from("tic_foreign_official_holdings").select("as_of_month, grand_total_bn, foreign_official_bn").order("as_of_month"),
      sb.from("foreign_custody_holdings").select("obs_date, change_52w_bn").not("change_52w_bn", "is", null).order("obs_date"),
      sb.from("treasury_auction_results").select("auction_date, indirect_share_pct").eq("security_term", "10-Year").not("indirect_share_pct", "is", null).order("auction_date"),
      sb.from("gold_rate_correlation").select("obs_date, corr_90d").not("corr_90d", "is", null).order("obs_date"),
      fetchFredSeries(TERM_PREMIUM_SERIES),
    ]);

    const cySeries: Pt[] = (cyRes.data ?? []).map((r) => ({ date: r.obs_date, value: Number(r.convenience_bp) }));
    const officialShareSeries: Pt[] = (ticRes.data ?? []).map((r) => ({
      date: r.as_of_month, value: Number(r.foreign_official_bn) / Number(r.grand_total_bn) * 100,
    }));
    const custodySeries: Pt[] = (custodyRes.data ?? []).map((r) => ({ date: r.obs_date, value: Number(r.change_52w_bn) }));
    const auctionRows = auctionRes.data ?? [];
    const indirectSeries: Pt[] = [];
    for (let i = 5; i < auctionRows.length; i++) {
      const window = auctionRows.slice(i - 5, i + 1).map((r) => Number(r.indirect_share_pct));
      indirectSeries.push({ date: auctionRows[i].auction_date, value: mean(window) });
    }
    const goldCorrSeries: Pt[] = (goldCorrRes.data ?? []).map((r) => ({ date: r.obs_date, value: Number(r.corr_90d) }));

    const zCY = zScoreSeries(cySeries);
    const zOfficial = zScoreSeries(officialShareSeries);
    const zCustody = zScoreSeries(custodySeries);
    const zIndirect = zScoreSeries(indirectSeries);
    const zGoldCorr = zScoreSeries(goldCorrSeries);
    const zTermPrem = zScoreSeries(termPremium);

    const last = (arr: Pt[]) => (arr.length ? arr[arr.length - 1] : null);
    const lCY = last(zCY), lOfficial = last(zOfficial), lCustody = last(zCustody);
    const lIndirect = last(zIndirect), lGoldCorr = last(zGoldCorr), lTermPrem = last(zTermPrem);

    if (!lCY || !lGoldCorr || !lTermPrem) return json({ error: "insufficient data for required components (CY10, gold/real corr, or term premium)" }, 500);

    const negCY = -lCY.value;
    const demandParts = [lOfficial, lCustody, lIndirect].filter((x): x is Pt => x != null).map((x) => -x.value);
    const demandGroup = demandParts.length ? mean(demandParts) : null;
    const goldCorrZ = lGoldCorr.value; // not negated: rising correlation IS the risk direction
    const termPremZ = lTermPrem.value; // not negated: rising term premium IS the risk direction

    const slots = [negCY, demandGroup, goldCorrZ, termPremZ].filter((v): v is number => v != null);
    const gauge7 = Math.round(mean(slots) * 10000) / 10000;

    const year = new Date().getUTCFullYear();
    const { error: gaugeErr } = await sb.from("dalio_gauge_readings").upsert({
      year, gauge7,
      z_conv_yield: Math.round(lCY.value * 10000) / 10000,
      z_official_share: lOfficial ? Math.round(lOfficial.value * 10000) / 10000 : null,
      z_custody: lCustody ? Math.round(lCustody.value * 10000) / 10000 : null,
      z_indirect_bidder: lIndirect ? Math.round(lIndirect.value * 10000) / 10000 : null,
      z_gold_real_corr: Math.round(lGoldCorr.value * 10000) / 10000,
      z_term_premium: Math.round(lTermPrem.value * 10000) / 10000,
    }, { onConflict: "year" });
    if (gaugeErr) return json({ error: `dalio_gauge_readings upsert: ${gaugeErr.message}` }, 500);

    const today = new Date().toISOString().slice(0, 10);
    const { error: snapErr } = await sb.from("gauge_daily_snapshots").upsert(
      { snapshot_date: today, gauge_key: "gauge7", value: gauge7 },
      { onConflict: "snapshot_date,gauge_key" }
    );
    if (snapErr) return json({ error: `gauge_daily_snapshots upsert: ${snapErr.message}` }, 500);

    // Pairwise correlation diagnostic, monthly-resampled over the trailing 3
    // years, across the 6 raw (pre-negation) z-scored component series.
    const components: Record<string, Pt[]> = {
      cy10: zCY, official_share: zOfficial, custody: zCustody,
      indirect_bidder: zIndirect, gold_real_corr: zGoldCorr, term_premium: zTermPrem,
    };
    const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
    const cutoffMonth = cutoff.toISOString().slice(0, 7);
    const monthly: Record<string, Map<string, number>> = {};
    for (const [name, series] of Object.entries(components)) {
      const m = monthlyResample(series);
      for (const k of [...m.keys()]) if (k < cutoffMonth) m.delete(k);
      monthly[name] = m;
    }
    const names = Object.keys(components);
    const matrix: Record<string, Record<string, number | null>> = {};
    let maxAbsPair = 0;
    for (let i = 0; i < names.length; i++) {
      matrix[names[i]] = {};
      for (let j = 0; j < names.length; j++) {
        if (i === j) { matrix[names[i]][names[j]] = 1; continue; }
        const commonMonths = [...monthly[names[i]].keys()].filter((k) => monthly[names[j]].has(k));
        const xs = commonMonths.map((k) => monthly[names[i]].get(k)!);
        const ys = commonMonths.map((k) => monthly[names[j]].get(k)!);
        const c = pearson(xs, ys);
        matrix[names[i]][names[j]] = c != null ? Math.round(c * 1000) / 1000 : null;
        if (c != null && i < j) maxAbsPair = Math.max(maxAbsPair, Math.abs(c));
      }
    }
    await sb.from("gauge7_component_correlations").insert({
      matrix, max_abs_pair_corr: Math.round(maxAbsPair * 1000) / 1000, flagged: maxAbsPair > 0.85,
    });

    return json({
      gauge7, year,
      components: { negCY, demandGroup, goldCorrZ, termPremZ, demandParts: { official: lOfficial?.value ?? null, custody: lCustody?.value ?? null, indirect: lIndirect?.value ?? null } },
      maxAbsPairCorr: maxAbsPair, flagged: maxAbsPair > 0.85,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
