import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeBondLensHistory, BondLensHistoryInputs } from "../_shared/bondLens/scoring.ts";
import { alignForwardFill } from "../_shared/bondLens/normalize.ts";
import { BOND_LENS_CONFIG } from "../_shared/bondLens/config.ts";

// Bond Lens overlay — Phase B compute (docs/specs/bond-lens.md §4).
// Reads bond_raw_series + asset_price_history, walks the full aligned
// history through every §4 module (_shared/bondLens/scoring.ts), and
// full-rebuild-upserts bond_signals -- same "derived table, full rebuild
// avoids incremental bugs" choice as market-conditions-compute. Does NOT
// populate bond_lens_signal (the published composite) -- that's Phase C,
// which still needs to define how these six module scores combine into
// duration_stance/instrument_pref/maturity_pref.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchAllPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<{ date: string; value: number }[]> {
  let rows: { date: string; value: number }[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("asset_price_history").select("date, close")
      .eq("symbol", symbol).order("date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`asset_price_history read (${symbol}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, value: Number(r.close) })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchAllRaw(supabase: ReturnType<typeof createClient>, seriesId: string): Promise<{ date: string; value: number; target_quarter?: string | null }[]> {
  let rows: { date: string; value: number; target_quarter?: string | null }[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("bond_raw_series").select("obs_date, value, target_quarter")
      .eq("series_id", seriesId).order("obs_date", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`bond_raw_series read (${seriesId}): ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.obs_date as string, value: Number(r.value), target_quarter: r.target_quarter as string | null })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// alignForwardFill's `maxCarryDays` is now CALENDAR days (normalize.ts
// was rewritten after the original trading-day-position version silently
// broke on monthly/quarterly series whose dates don't land on actual
// trading days -- e.g. PCEPILFE's "2026-08-01" is a Saturday, never
// present in DGS10's calendar at any position, so it could never be
// found regardless of cap size -- the real cause of inflTrend/quadrant/
// breakeven_gap_bp going excluded on live dates despite a generous cap).
const DAILY_CAP = 7; // same-day FRED series, a bit over a week to bridge any holiday cluster
const MONTHLY_CAP = 60; // PCEPILFE/EXPINF1YR: ~4-week release lag + up to a month until the next print
const GDPNOW_CAP = 14; // irregular intra-quarter updates, rarely more than ~2 weeks apart
// bond-lens-decisions.md's explicit "more than 10 BUSINESS days old" ACM
// threshold, converted to calendar days (10 business days spans 2
// weekends) since this cap is now calendar-day based.
const ACM_STALE_CAP = 14;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = new Date().toISOString();

  try {
    // 22 series fetched fully concurrently hit WORKER_RESOURCE_LIMIT --
    // same class of issue as bond-lens-ingest's original all-20-FRED-
    // series-at-once version. Batched in groups of 5 for the same reason.
    const rawSeriesIds = [
      "DGS3MO", "DGS1", "DGS2", "DGS3", "DGS5", "DGS7", "DGS10", "DGS30",
      "DFII5", "DFII10", "T5YIE", "T10YIE", "T5YIFR", "DFF",
      "ACMTP10", "THREEFYTP10", "RSTAR_HLW_US", "PCEPILFE", "EXPINF1YR", "GDPNOW_ATL_NOWCAST",
      "SHILLER_SP500_TR_MONTHLY",
    ];
    const rawResults: Record<string, { date: string; value: number; target_quarter?: string | null }[]> = {};
    const BATCH = 3; // reduced from 5 -- WORKER_RESOURCE_LIMIT kept firing even after the algorithmic fixes above
    for (let i = 0; i < rawSeriesIds.length; i += BATCH) {
      const batch = rawSeriesIds.slice(i, i + BATCH);
      const batchData = await Promise.all(batch.map((id) => fetchAllRaw(supabase, id)));
      batch.forEach((id, j) => { rawResults[id] = batchData[j]; });
    }
    const [spyRaw, iefRaw] = await Promise.all([fetchAllPrices(supabase, "SPY"), fetchAllPrices(supabase, "IEF")]);

    const dgs3mo = rawResults.DGS3MO, dgs1 = rawResults.DGS1, dgs2 = rawResults.DGS2, dgs3 = rawResults.DGS3;
    const dgs5 = rawResults.DGS5, dgs7 = rawResults.DGS7, dgs10Raw = rawResults.DGS10, dgs30 = rawResults.DGS30;
    const dfii5 = rawResults.DFII5, dfii10 = rawResults.DFII10, t5yie = rawResults.T5YIE, t10yie = rawResults.T10YIE, t5yifr = rawResults.T5YIFR, dff = rawResults.DFF;
    const acmRaw = rawResults.ACMTP10, threefytp10Raw = rawResults.THREEFYTP10, rstarRaw = rawResults.RSTAR_HLW_US;
    const pceRaw = rawResults.PCEPILFE, expInf1yrRaw = rawResults.EXPINF1YR, gdpnowRaw = rawResults.GDPNOW_ATL_NOWCAST;
    const shillerRaw = rawResults.SHILLER_SP500_TR_MONTHLY;
    if (dgs10Raw.length === 0) throw new Error("no DGS10 history -- run bond-lens-ingest?source=fred first");

    // DGS10's own calendar is the backbone -- longest reliable daily
    // history among every series this module needs (since 1962).
    const dates = dgs10Raw.map((r) => r.date);

    const toValues = (rows: { date: string; value: number }[]) => rows.map((r) => ({ date: r.date, value: r.value }));
    const align = (rows: { date: string; value: number }[], cap: number) => alignForwardFill(dates, toValues(rows), cap);

    const acm = align(acmRaw, ACM_STALE_CAP);
    const gdpnow = align(gdpnowRaw, GDPNOW_CAP);
    // target_quarter has to ride along the SAME as-of lookup as the value
    // it describes -- sorted-rows binary search + calendar-day cap,
    // mirroring alignForwardFill exactly (that function only returns
    // numbers, not an arbitrary string field, so this is a parallel
    // implementation rather than a shared call). The old version walked
    // back through `dates[i - back]` by INDEX POSITION, the same bug
    // alignForwardFill itself had -- GDPNow's release dates are usually
    // actual business days so it rarely surfaced, but it's the same class
    // of bug and worth fixing alongside it rather than leaving it live.
    // gdpnowRaw already arrives sorted ascending (fetchAllRaw's own
    // "order by obs_date asc") -- no re-sort needed, same reasoning as
    // alignForwardFill's precondition.
    const gdpnowQuarter: (string | null)[] = dates.map((target) => {
      let lo = 0, hi = gdpnowRaw.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (gdpnowRaw[mid].date <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      if (ans < 0) return null;
      const row = gdpnowRaw[ans];
      const gapDays = Math.round((new Date(target + "T00:00:00Z").getTime() - new Date(row.date + "T00:00:00Z").getTime()) / 86400000);
      return gapDays <= GDPNOW_CAP ? (row.target_quarter ?? null) : null;
    });

    const inputs: BondLensHistoryInputs = {
      dates,
      dgs3mo: align(dgs3mo, DAILY_CAP), dgs1: align(dgs1, DAILY_CAP), dgs2: align(dgs2, DAILY_CAP), dgs3: align(dgs3, DAILY_CAP),
      dgs5: align(dgs5, DAILY_CAP), dgs7: align(dgs7, DAILY_CAP), dgs10: dgs10Raw.map((r) => r.value), dgs30: align(dgs30, DAILY_CAP),
      dfii5: align(dfii5, DAILY_CAP), dfii10: align(dfii10, DAILY_CAP),
      t5yie: align(t5yie, DAILY_CAP), t10yie: align(t10yie, DAILY_CAP), t5yifr: align(t5yifr, DAILY_CAP),
      dff: align(dff, DAILY_CAP),
      acm, threefytp10: align(threefytp10Raw, DAILY_CAP),
      rstar: toValues(rstarRaw),
      pceIndex: align(pceRaw, MONTHLY_CAP), expInf1yr: align(expInf1yrRaw, MONTHLY_CAP),
      gdpnow, gdpnowQuarter,
      spy: align(spyRaw, DAILY_CAP), ief: align(iefRaw, DAILY_CAP),
      // Raw monthly dates, NOT aligned onto the daily calendar -- §4.4's
      // pre-1993 hedge fallback works in monthly-return space directly
      // (see syntheticBond.ts / scoring.ts).
      shillerSp500MonthlyTr: toValues(shillerRaw),
    };

    const rows = computeBondLensHistory(inputs, BOND_LENS_CONFIG);
    // Mutate in place rather than rows.map(...) -- cloning all ~16k row
    // objects into a second parallel array just to add computed_at was
    // real, avoidable peak memory on top of an already resource-
    // constrained run.
    const computedAt = new Date().toISOString();
    for (const r of rows) (r as unknown as { computed_at: string }).computed_at = computedAt;
    const dbRows = rows;

    const chunkSize = 500;
    for (let i = 0; i < dbRows.length; i += chunkSize) {
      const chunk = dbRows.slice(i, i + chunkSize);
      const { error } = await supabase.from("bond_signals").upsert(chunk, { onConflict: "as_of_date" });
      if (error) throw new Error(`bond_signals upsert: ${error.message}`);
    }

    const last = rows[rows.length - 1];
    const report = {
      totalRows: rows.length, from: dates[0], to: dates[dates.length - 1],
      latest: last,
      configVersion: BOND_LENS_CONFIG.version,
    };

    await supabase.from("bond_lens_job_runs").insert({
      job_name: "bond-lens-compute", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "ok", detail: report,
    });

    return new Response(JSON.stringify(report, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    await supabase.from("bond_lens_job_runs").insert({
      job_name: "bond-lens-compute", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "error", detail: { error: String(e) },
    });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
