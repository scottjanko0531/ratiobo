import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  fetchMtsNetInterestTrailing12,
  fetchMtsTable1Trailing12,
  fetchTrailingNominalGdp4Q,
  assertPeriodAligned,
} from "../_shared/mtsFiscalData.ts";

// v2 Phase 5 (debt-metrics-integrity-v2 spec): one-time (re-runnable)
// backfill of "Interest Expense % of Federal Revenue" and "Interest
// Expense % GDP" into macro_snapshots, under the MTS net-interest basis
// v1 Phase 2b switched the LIVE card to. Before this, macro_snapshots only
// carried the old NIPA-basis values for every date before the 2026-11-16
// cutover (confirmed in the v2 Phase 3 decisions log) -- the
// debtServiceStrained hysteresis gate (_shared/hysteresisGate.ts) had only
// 1 distinct MTS-basis reading to evaluate persistence against
// (monthsAvailable: 1, insufficientHistory: true, bootstrap fallback).
//
// Found and fixed two real bugs in _shared/mtsFiscalData.ts while building
// this (both the exact "sort by -record_date, take the latest N" pattern,
// silently wrong for any `asOf` more than ~1-1.5 years in the past, since
// the needed historical rows simply aren't in "the latest N" fetched from
// TODAY): fetchMtsNetInterestTrailing12 fetched the newest 24 Table 9 rows
// unconditionally; fetchTrailingNominalGdp4Q fetched the newest 6 FRED GDP
// quarters unconditionally. Both now filter the FETCH itself by the target
// window (record_date:in:(...) / observation_end=), confirmed bit-identical
// for asOf=now against the pre-fix implementation before being relied on
// here for historical months.
//
// Vintage logic (rule: "each historical month uses only data available
// then, or log the limitation"): the Fiscal Data API's mts_table_1/
// mts_table_9 endpoints return exactly one value per historical
// record_date -- there is no vintage/as-of parameter, so there is no way
// to ask "what did this report say about June 2023 AS PUBLISHED then,
// before any later revision." This backfill therefore uses the LATEST
// REVISED figures for every historical month, not true point-in-time
// vintages -- logged explicitly here and in the decisions log, per the
// spec's instruction not to silently simplify this. In practice Treasury
// rarely revises MTS figures materially after publication, but this is a
// real limitation of the data source, not a design choice.
//
// macro_snapshots has no metadata column (confirmed via schema read) --
// unlike the live macro_indicators card, there's nowhere to carry
// metadata.nipa_pct_* on a historical snapshot row even if we wanted to;
// the live card's NIPA context (v1 Phase 2) is untouched by this backfill.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REVENUE_PCT_INDICATOR = "Interest Expense % of Federal Revenue";
const GDP_PCT_INDICATOR = "Interest Expense % GDP";

function revenuePctStatus(v: number): "healthy" | "watch" | "danger" {
  return v < 10 ? "healthy" : v < 20 ? "watch" : "danger";
}
function gdpPctStatus(v: number): "healthy" | "watch" | "danger" {
  return v < 2 ? "healthy" : v < 4 ? "watch" : "danger";
}

// `windowEndMonth` is "YYYY-MM" for the desired trailing-12 window's END
// month. fetchMts*Trailing12(asOf)'s own findLatestPublishedMonthEnd reads
// "last calendar month relative to asOf" -- the same relationship that
// makes "today" (any day in November) resolve to an October windowEnd for
// the live cards -- so asOf is the 16th of the month AFTER windowEndMonth.
function asOfForWindowEndMonth(windowEndMonth: string): Date {
  const [y, m] = windowEndMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + 1; // +1 month
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return new Date(Date.UTC(ny, nm - 1, 16));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const months = Math.max(1, Math.min(200, Number(url.searchParams.get("months") ?? "48")));
    const dryRun = url.searchParams.get("dryRun") === "true";
    const fredApiKey = Deno.env.get("FRED_API_KEY")!;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Anchor to the live card's own current windowEnd (today's asOf),
    // then step back one calendar month at a time.
    const liveNetInterest = await fetchMtsNetInterestTrailing12();
    const latestWindowEndMonth = liveNetInterest.windowEnd.slice(0, 7); // "YYYY-MM"

    const targetMonths: string[] = [];
    {
      let [y, m] = latestWindowEndMonth.split("-").map(Number);
      for (let i = 0; i < months; i++) {
        targetMonths.push(`${y}-${String(m).padStart(2, "0")}`);
        m -= 1;
        if (m === 0) { m = 12; y -= 1; }
      }
    }

    const results: Record<string, unknown> = {};
    const revenueRows: { indicator_name: string; snapshot_date: string; value: number; status: string }[] = [];
    const gdpRows: { indicator_name: string; snapshot_date: string; value: number; status: string }[] = [];

    for (const windowEndMonth of targetMonths) {
      const asOf = asOfForWindowEndMonth(windowEndMonth);
      try {
        const [netInt, receipts] = await Promise.all([
          fetchMtsNetInterestTrailing12(asOf),
          fetchMtsTable1Trailing12(asOf),
        ]);
        assertPeriodAligned([
          { label: "net interest", windowStart: netInt.windowStart, windowEnd: netInt.windowEnd },
          { label: "receipts", windowStart: receipts.windowStart, windowEnd: receipts.windowEnd },
        ]);
        const pctRevenue = (netInt.netInterestB / receipts.receiptsB) * 100;
        revenueRows.push({
          indicator_name: REVENUE_PCT_INDICATOR, snapshot_date: netInt.windowEnd,
          value: Math.round(pctRevenue * 1000) / 1000, status: revenuePctStatus(pctRevenue),
        });

        let pctGdp: number | null = null;
        let gdpError: string | null = null;
        try {
          const gdp4q = await fetchTrailingNominalGdp4Q(fredApiKey, asOf);
          pctGdp = (netInt.netInterestB / gdp4q.gdpB) * 100;
          gdpRows.push({
            indicator_name: GDP_PCT_INDICATOR, snapshot_date: netInt.windowEnd,
            value: Math.round(pctGdp * 1000) / 1000, status: gdpPctStatus(pctGdp),
          });
        } catch (e) {
          gdpError = String(e);
        }

        results[netInt.windowEnd] = {
          ok: true, netInterestB: Math.round(netInt.netInterestB * 100) / 100,
          receiptsB: Math.round(receipts.receiptsB * 100) / 100,
          pctRevenue: Math.round(pctRevenue * 1000) / 1000,
          pctGdp: pctGdp != null ? Math.round(pctGdp * 1000) / 1000 : null,
          gdpError,
        };
      } catch (e) {
        results[windowEndMonth] = { ok: false, error: String(e) };
      }
    }

    let written = { revenue: 0, gdp: 0 };
    if (!dryRun) {
      const chunk = 500;
      for (let i = 0; i < revenueRows.length; i += chunk) {
        const { error } = await supabase.from("macro_snapshots")
          .upsert(revenueRows.slice(i, i + chunk), { onConflict: "indicator_name,snapshot_date" });
        if (error) throw new Error(`revenue upsert failed: ${error.message}`);
        written.revenue += revenueRows.slice(i, i + chunk).length;
      }
      for (let i = 0; i < gdpRows.length; i += chunk) {
        const { error } = await supabase.from("macro_snapshots")
          .upsert(gdpRows.slice(i, i + chunk), { onConflict: "indicator_name,snapshot_date" });
        if (error) throw new Error(`gdp upsert failed: ${error.message}`);
        written.gdp += gdpRows.slice(i, i + chunk).length;
      }
    }

    return new Response(JSON.stringify({
      dryRun, monthsRequested: months,
      monthsSucceeded: Object.values(results).filter((r) => (r as { ok: boolean }).ok).length,
      monthsFailed: Object.values(results).filter((r) => !(r as { ok: boolean }).ok).length,
      written,
      results,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
