import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Fed SOMA holdings, bucketed by remaining maturity — a composition signal
// distinct from WALCL's pure balance-sheet SIZE. The Fed can quietly absorb
// long-duration Treasury supply (a precursor to formal QE / yield-curve
// control) while the total balance sheet stays roughly flat; WALCL alone
// can't see that. Free, public, no auth: NY Fed's own Markets Data API.
//
// Methodology note (verified by reproducing a third-party chart's published
// numbers exactly): the per-CUSIP "changeFromPriorWeek" field in the detail
// endpoint is NOT usable directly for bills — bill CUSIPs roll over into
// brand-new CUSIPs on every auction, so per-CUSIP diffing silently misses
// that churn. Instead: bucket each week's FULL snapshot by remaining
// maturity as of that snapshot's own date, sum par value per bucket, then
// diff the bucket TOTALS across two full snapshots.
const BUCKETS = ["≤15D", "16-90D", "91D-1Y", "1-5Y", "5-10Y", ">10Y"] as const;
type Bucket = typeof BUCKETS[number];

function bucketFor(maturityDate: string, asOfDate: string): Bucket {
  const mat = new Date(maturityDate + "T00:00:00Z").getTime();
  const asOf = new Date(asOfDate + "T00:00:00Z").getTime();
  const days = Math.round((mat - asOf) / 86_400_000);
  if (days <= 15) return "≤15D";
  if (days <= 90) return "16-90D";
  if (days <= 365) return "91D-1Y";
  if (days <= 365 * 5) return "1-5Y";
  if (days <= 365 * 10) return "5-10Y";
  return ">10Y";
}

interface SomaHolding {
  asOfDate: string; maturityDate: string; parValue: string; securityType: string;
}

// Weeks of history to (re)fetch on a normal run — bounded API load, self-healing
// against any late revisions, enough for a short trend plus current/previous.
const WEEKS_TO_SYNC = 8;
// One-time deeper backfill so the drawer's chart/table has real history instead
// of starting from 8 weeks — ~1 year, matching how the Liquidity Composite's
// first run backfilled deep before settling into a smaller rolling resync.
const BACKFILL_WEEKS = 52;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { count } = await sb.from("soma_holdings_by_maturity").select("*", { count: "exact", head: true });
    const isFirstRun = !count || count === 0;
    const weeksToSync = isFirstRun ? BACKFILL_WEEKS : WEEKS_TO_SYNC;

    // The summary endpoint lists every historical as-of-date (weekly since
    // 2003) — used only to discover which dates are available, since
    // Wednesday/holiday scheduling makes "the last N Wednesdays" unreliable
    // to compute by hand.
    const summaryRes = await fetch("https://markets.newyorkfed.org/api/soma/summary.json");
    if (!summaryRes.ok) return json({ error: `summary endpoint: HTTP ${summaryRes.status}` }, 500);
    const summaryJson = await summaryRes.json();
    const allDates: string[] = (summaryJson?.soma?.summary ?? [])
      .map((r: { asOfDate: string }) => r.asOfDate)
      .sort();
    const recentDates = allDates.slice(-weeksToSync);
    if (!recentDates.length) return json({ error: "no as-of dates found" }, 500);

    const errors: Record<string, string> = {};
    let weeksSynced = 0;

    for (const asOfDate of recentDates) {
      try {
        const res = await fetch(`https://markets.newyorkfed.org/api/soma/tsy/get/all/asof/${asOfDate}.json`);
        if (!res.ok) { errors[asOfDate] = `HTTP ${res.status}`; continue; }
        const j = await res.json();
        const holdings = (j?.soma?.holdings ?? []) as SomaHolding[];
        if (!holdings.length) { errors[asOfDate] = "no holdings"; continue; }

        const bucketSums = new Map<Bucket, number>();
        for (const h of holdings) {
          if (!h.maturityDate || !h.parValue) continue;
          const b = bucketFor(h.maturityDate, h.asOfDate || asOfDate);
          bucketSums.set(b, (bucketSums.get(b) ?? 0) + Number(h.parValue));
        }

        const rows = BUCKETS.map((b) => ({
          as_of_date: asOfDate,
          bucket: b,
          par_value_bn: Math.round(((bucketSums.get(b) ?? 0) / 1e9) * 1000) / 1000,
        }));
        const { error: upErr } = await sb.from("soma_holdings_by_maturity").upsert(rows, { onConflict: "as_of_date,bucket" });
        if (upErr) { errors[asOfDate] = upErr.message; continue; }
        weeksSynced++;
      } catch (e) { errors[asOfDate] = e instanceof Error ? e.message : String(e); }
    }

    return json({ isFirstRun, weeksSynced, totalDatesTried: recentDates.length, errors });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
