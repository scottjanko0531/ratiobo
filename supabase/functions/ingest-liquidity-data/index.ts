import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// US Total Liquidity Composite — a public-data approximation of Michael Howell / GL
// Indexes' "Global Liquidity" framework for the US, combining:
//   Fed Net Liquidity      = Fed balance sheet (WALCL) − Treasury General Account (WTREGEN) − reverse repo (WLRRAL)
//   Private Liquidity Proxy = tri-party repo volume (OFR) + commercial paper outstanding (COMPOUT) + M2 (M2SL)
// into a Total Liquidity Composite expressed as YoY momentum, plus a full-sample z-score.
// All sources are free, no API key required. Backfills from 2017-01-01 on first run.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BACKFILL_START = "2017-01-01";

const FRED_SERIES = ["WALCL", "WTREGEN", "WLRRAL", "COMPOUT", "M2SL"] as const;
type FredSeriesId = typeof FRED_SERIES[number];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchFredCsv(seriesId: FredSeriesId, cosd: string): Promise<{ date: string; value: number }[]> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}`);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n").slice(1); // skip header
  const out: { date: string; value: number }[] = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    if (!date || raw === "." || raw === undefined || raw === "") continue;
    const value = parseFloat(raw);
    if (!isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

async function fetchOfrRepo(startDate: string): Promise<{ date: string; value: number }[]> {
  const res = await fetch(
    `https://data.financialresearch.gov/v1/series/timeseries?mnemonic=REPO-TRI_TV_TOT-P&start_date=${startDate}`,
  );
  if (!res.ok) throw new Error(`OFR repo: HTTP ${res.status}`);
  const arr = await res.json() as [string, number][];
  return arr
    .filter((pair) => Array.isArray(pair) && pair.length === 2 && isFinite(pair[1]))
    .map(([date, value]) => ({ date, value }));
}

// Monthly calendar helpers — all months from BACKFILL_START through the current month.
function monthKey(date: string): string { return date.slice(0, 7); } // "YYYY-MM"
function firstOfMonth(monthStr: string): string { return `${monthStr}-01`; }

function allMonthsThrough(latest: string): string[] {
  const months: string[] = [];
  let y = 2017, m = 1;
  const [ly, lm] = [parseInt(latest.slice(0, 4)), parseInt(latest.slice(5, 7))];
  while (y < ly || (y === ly && m <= lm)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

// Last observation on or before the given month's end, from a date-sorted-ascending series.
function lastObsBeforeMonthEnd(obs: { date: string; value: number }[], monthStr: string): number | null {
  const [y, m] = monthStr.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month
  let result: number | null = null;
  for (const o of obs) {
    if (o.date <= monthEnd) result = o.value;
    else break;
  }
  return result;
}

function monthAverage(obs: { date: string; value: number }[], monthStr: string): number | null {
  const vals = obs.filter((o) => monthKey(o.date) === monthStr).map((o) => o.value);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function monthValue(obs: { date: string; value: number }[], monthStr: string): number | null {
  const hit = obs.find((o) => monthKey(o.date) === monthStr);
  return hit ? hit.value : null;
}

function yoyPct(curr: number | null, yearAgo: number | null): number | null {
  if (curr == null || yearAgo == null || yearAgo === 0) return null;
  return (curr / yearAgo - 1) * 100;
}

function mean(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const upserted: Record<string, number> = {};
    const errors: Record<string, string> = {};

    const { count } = await sb.from("liquidity_raw_observations").select("*", { count: "exact", head: true });
    const isFirstRun = !count || count === 0;

    // 1. FRED series — rolling 120-day refetch window (picks up revisions automatically),
    //    or full backfill from 2017-01-01 on first run.
    for (const seriesId of FRED_SERIES) {
      try {
        const cosd = isFirstRun ? BACKFILL_START : daysAgo(120);
        const obs = await fetchFredCsv(seriesId, cosd);
        if (!obs.length) { errors[seriesId] = "no observations returned"; continue; }
        const rows = obs.map((o) => ({ series_id: seriesId, obs_date: o.date, value: o.value }));
        const { error } = await sb.from("liquidity_raw_observations").upsert(rows, { onConflict: "series_id,obs_date" });
        if (error) { errors[seriesId] = error.message; continue; }
        upserted[seriesId] = rows.length;
      } catch (e) { errors[seriesId] = e instanceof Error ? e.message : String(e); }
    }

    // 2. OFR tri-party repo — rolling 45-day window, or full backfill on first run.
    try {
      const startDate = isFirstRun ? BACKFILL_START : daysAgo(45);
      const obs = await fetchOfrRepo(startDate);
      if (obs.length) {
        const rows = obs.map((o) => ({ series_id: "REPO_TRI", obs_date: o.date, value: o.value }));
        const { error } = await sb.from("liquidity_raw_observations").upsert(rows, { onConflict: "series_id,obs_date" });
        if (error) errors["REPO_TRI"] = error.message;
        else upserted["REPO_TRI"] = rows.length;
      } else errors["REPO_TRI"] = "no observations returned";
    } catch (e) { errors["REPO_TRI"] = e instanceof Error ? e.message : String(e); }

    // 3. Recompute liquidity_monthly from scratch — derived data, full rebuild avoids
    //    incremental bugs. Pull each series once, sorted ascending, into memory.
    // PostgREST caps unpaginated selects at 1000 rows — REPO_TRI's ~9 years of daily
    // data exceeds that, so this pages through with .range() until a short page ends.
    async function fetchAllObs(seriesId: string): Promise<{ date: string; value: number }[]> {
      const out: { date: string; value: number }[] = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await sb
          .from("liquidity_raw_observations")
          .select("obs_date, value")
          .eq("series_id", seriesId)
          .order("obs_date", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error || !data) break;
        out.push(...data.map((r) => ({ date: r.obs_date as string, value: Number(r.value) })));
        if (data.length < pageSize) break;
      }
      return out;
    }

    const bySeries: Record<string, { date: string; value: number }[]> = {};
    for (const seriesId of [...FRED_SERIES, "REPO_TRI"]) {
      bySeries[seriesId] = await fetchAllObs(seriesId);
    }

    const allObsDates = Object.values(bySeries).flat().map((o) => o.date);
    if (!allObsDates.length) return json({ upserted, errors, monthsComputed: 0 }, errors && Object.keys(upserted).length === 0 ? 500 : 200);
    const latestDate = allObsDates.sort().at(-1)!;
    const months = allMonthsThrough(latestDate);
    const currentMonth = new Date().toISOString().slice(0, 7);

    type MonthRow = {
      month: string; fed_bs_tn: number | null; tga_tn: number | null; rrp_tn: number | null;
      net_liquidity_tn: number | null; repo_avg_bn: number | null; cp_avg_bn: number | null; m2_bn: number | null;
      net_liq_yoy: number | null; repo_yoy: number | null; cp_yoy: number | null; m2_yoy: number | null;
      private_composite_yoy: number | null; total_composite_yoy: number | null;
      total_stock_tn: number | null; stock_yoy: number | null; is_partial: boolean;
    };

    const rows: MonthRow[] = months.map((m) => {
      const fed_bs_tn = lastObsBeforeMonthEnd(bySeries.WALCL, m);
      const tga_raw = lastObsBeforeMonthEnd(bySeries.WTREGEN, m);
      const rrp_raw = lastObsBeforeMonthEnd(bySeries.WLRRAL, m);
      const fed_bs = fed_bs_tn != null ? fed_bs_tn / 1e6 : null;
      const tga_tn = tga_raw != null ? tga_raw / 1e6 : null;
      const rrp_tn = rrp_raw != null ? rrp_raw / 1e6 : null;
      const net_liquidity_tn = fed_bs != null && tga_tn != null && rrp_tn != null ? fed_bs - tga_tn - rrp_tn : null;

      const repo_avg_raw = monthAverage(bySeries.REPO_TRI, m);
      const repo_avg_bn = repo_avg_raw != null ? repo_avg_raw / 1e9 : null;
      const cp_avg_bn = monthAverage(bySeries.COMPOUT, m); // already $B
      const m2_bn = monthValue(bySeries.M2SL, m); // already $B, published for month start

      return {
        month: m, fed_bs_tn: fed_bs, tga_tn, rrp_tn, net_liquidity_tn,
        repo_avg_bn, cp_avg_bn, m2_bn,
        net_liq_yoy: null, repo_yoy: null, cp_yoy: null, m2_yoy: null,
        private_composite_yoy: null, total_composite_yoy: null,
        total_stock_tn: null, stock_yoy: null,
        is_partial: m === currentMonth,
      };
    });

    const byMonth = new Map(rows.map((r) => [r.month, r]));
    for (const r of rows) {
      const idx = months.indexOf(r.month);
      const yearAgoMonth = idx >= 12 ? months[idx - 12] : null;
      const ya = yearAgoMonth ? byMonth.get(yearAgoMonth) : null;

      r.net_liq_yoy = yoyPct(r.net_liquidity_tn, ya?.net_liquidity_tn ?? null);
      r.repo_yoy = yoyPct(r.repo_avg_bn, ya?.repo_avg_bn ?? null);
      r.cp_yoy = yoyPct(r.cp_avg_bn, ya?.cp_avg_bn ?? null);
      r.m2_yoy = yoyPct(r.m2_bn, ya?.m2_bn ?? null);

      const privateParts = [r.repo_yoy, r.cp_yoy, r.m2_yoy].filter((v): v is number => v != null);
      r.private_composite_yoy = privateParts.length ? mean(privateParts) : null;

      r.total_composite_yoy = r.net_liq_yoy != null && r.private_composite_yoy != null
        ? mean([r.net_liq_yoy, r.private_composite_yoy])
        : null;

      r.total_stock_tn = r.net_liquidity_tn != null && r.repo_avg_bn != null && r.cp_avg_bn != null && r.m2_bn != null
        ? r.net_liquidity_tn + (r.repo_avg_bn + r.cp_avg_bn + r.m2_bn) / 1000
        : null;
    }
    for (const r of rows) {
      const idx = months.indexOf(r.month);
      const yearAgoMonth = idx >= 12 ? months[idx - 12] : null;
      const ya = yearAgoMonth ? byMonth.get(yearAgoMonth) : null;
      r.stock_yoy = yoyPct(r.total_stock_tn, ya?.total_stock_tn ?? null);
    }

    // Full-sample z-score of total_composite_yoy across all non-null months.
    const compositeVals = rows.map((r) => r.total_composite_yoy).filter((v): v is number => v != null);
    const compMean = mean(compositeVals);
    const compStd = compositeVals.length > 1
      ? Math.sqrt(compositeVals.reduce((s, v) => s + (v - (compMean ?? 0)) ** 2, 0) / (compositeVals.length - 1))
      : null;
    const zscores = new Map<string, number | null>();
    for (const r of rows) {
      zscores.set(r.month, r.total_composite_yoy != null && compMean != null && compStd && compStd > 0
        ? (r.total_composite_yoy - compMean) / compStd
        : null);
    }

    const round = (n: number | null) => n == null ? null : Math.round(n * 10000) / 10000;
    const upsertRows = rows.map((r) => ({
      month: firstOfMonth(r.month),
      fed_bs_tn: round(r.fed_bs_tn), tga_tn: round(r.tga_tn), rrp_tn: round(r.rrp_tn),
      net_liquidity_tn: round(r.net_liquidity_tn),
      repo_avg_bn: round(r.repo_avg_bn), cp_avg_bn: round(r.cp_avg_bn), m2_bn: round(r.m2_bn),
      net_liq_yoy: round(r.net_liq_yoy), repo_yoy: round(r.repo_yoy), cp_yoy: round(r.cp_yoy), m2_yoy: round(r.m2_yoy),
      private_composite_yoy: round(r.private_composite_yoy), total_composite_yoy: round(r.total_composite_yoy),
      total_stock_tn: round(r.total_stock_tn), stock_yoy: round(r.stock_yoy),
      composite_zscore: round(zscores.get(r.month) ?? null),
      is_partial: r.is_partial,
      computed_at: new Date().toISOString(),
    }));

    // Full rebuild: clear and reinsert in one pass (derived table, no history to preserve
    // beyond what's recomputed here).
    const { error: delErr } = await sb.from("liquidity_monthly").delete().neq("month", "1900-01-01");
    if (delErr) errors["liquidity_monthly_delete"] = delErr.message;
    const { error: insErr } = await sb.from("liquidity_monthly").insert(upsertRows);
    if (insErr) errors["liquidity_monthly_insert"] = insErr.message;

    const latestRow = upsertRows.filter((r) => r.total_composite_yoy != null).at(-1);

    return json({
      isFirstRun, upserted, errors,
      monthsComputed: upsertRows.length,
      latestMonth: latestRow?.month ?? null,
      latestTotalCompositeYoy: latestRow?.total_composite_yoy ?? null,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
