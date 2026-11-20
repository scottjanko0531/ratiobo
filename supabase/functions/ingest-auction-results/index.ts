import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchAllPages } from "../_shared/fiscalDataPagination.ts";
import { mapSecurityTermToTenor } from "../_shared/auctionTenor.ts";
import { assertAuctionFeedFresh, AuctionFeedStaleError } from "../_shared/auctionFreshness.ts";
import { mapTreasuryDirectRecord, TreasuryDirectRecord } from "../_shared/treasuryDirectAuctions.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Auction internals — who actually shows up at auction. Indirect bidders are
// the standard proxy for foreign official / central-bank demand; a falling
// indirect share means primary dealers are absorbing more, the price-
// insensitive-to-price-sensitive substitution this whole panel tracks.
//
// Source: Treasury Fiscal Data API, free, no key. Free-text fields (verified
// live 2026-08-18): indirect_bidder_accepted, direct_bidder_accepted,
// primary_dealer_accepted, total_accepted, total_tendered, bid_to_cover_ratio,
// high_yield, avg_med_yield.
//
// dispersion_bp = high_yield − avg_med_yield is a bid-DISPERSION proxy, NOT
// the auction tail (a true tail needs the when-issued yield at bid deadline,
// which this API does not carry) — never relabel it as "tail" without that
// qualification, per the spec.
//
// v3 Phase 1 (debt-metrics-integrity-v3 spec) rewrite. The old version made
// one page[size]=10000, sort=auction_date (ASCENDING) request from
// 2010-01-01 forever -- confirmed live in Phase 0 that this endpoint's
// unfiltered total-count is already past 11000 and climbing, a real latent
// truncation bug even though it isn't today's active cause of staleness.
// Default mode now does an incremental, paginated, DESCENDING-sorted fetch
// from (newest stored auction_date - 30 days); pass ?full=true for a full
// 2010+ backfill (used for the initial original_tenor backfill and for
// disaster recovery). Every row gets original_tenor populated via the one
// shared mapSecurityTermToTenor() function -- this is what lets consumers
// match reopenings ("9-Year 10-Month" etc.), not just new-issue labels.
const BASE_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";
// TIPS-contamination fix (Scott, 2026-11-20): inflation_index_security is
// a real, reliable field Fiscal Data has always returned -- confirmed
// live for CUSIP 91282CRE3 ("Yes"). It was simply never requested here.
// TIPS share security_type "Note"/"Bond" with nominal securities and use
// the SAME reopening term shapes ("9-Year 8/10-Month" is used by both
// nominal and TIPS 10Y reopenings in different years) -- the term string
// alone cannot distinguish them; this field can.
const FIELDS = [
  "auction_date", "cusip", "security_type", "security_term",
  "total_tendered", "total_accepted", "indirect_bidder_accepted",
  "direct_bidder_accepted", "primary_dealer_accepted", "bid_to_cover_ratio",
  "high_yield", "avg_med_yield", "inflation_index_security",
].join(",");
const FULL_BACKFILL_START = "2010-01-01";
const INCREMENTAL_LOOKBACK_DAYS = 30;
const STALENESS_MAX_DAYS = 35;

interface AuctionRow {
  auction_date: string; cusip: string; security_type: string; security_term: string;
  total_tendered: string; total_accepted: string; indirect_bidder_accepted: string;
  direct_bidder_accepted: string; primary_dealer_accepted: string; bid_to_cover_ratio: string;
  high_yield: string; avg_med_yield: string; inflation_index_security: string;
}

function num(v: string): number | null {
  if (v == null || v === "null" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function daysAgo(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function logJobRun(
  sb: ReturnType<typeof createClient>,
  status: "ok" | "error",
  detail: Record<string, unknown>,
  startedAt: string,
) {
  await sb.from("rb_job_runs").insert({
    job_name: "ingest-auction-results",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    detail,
  });
}

// Live-site issue fallback (Scott, 2026-11-20): TreasuryDirect's TA_WS
// /auctioned endpoint ignores a cusip filter and just returns its most
// recent ~250 auctioned securities across every type (confirmed live --
// spans well over a year of history, no pagination needed), already
// carrying full results (bid-to-cover, yields, bidder breakdown), not
// just calendar info. Used ONLY when Fiscal Data's own feed is stale
// (the exact condition the 35-day guard already detects) -- this is a
// fallback for a confirmed real gap in Fiscal Data specifically, not a
// second primary source running every day. Never throws: a fallback
// failing should not mask the original staleness error, just mean the
// guard still fires.
async function fetchTreasuryDirectFallback10y30y(): Promise<ReturnType<typeof mapTreasuryDirectRecord>[]> {
  const res = await fetch("https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json", {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`TreasuryDirect TA_WS: HTTP ${res.status}`);
  const records = (await res.json()) as TreasuryDirectRecord[];
  return records
    .filter((r) => r.securityType === "Note" || r.securityType === "Bond")
    .map((r) => mapTreasuryDirectRecord(r, mapSecurityTermToTenor))
    .filter((r) => r.original_tenor === "10Y" || r.original_tenor === "30Y");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const startedAt = new Date().toISOString();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const full = new URL(req.url).searchParams.get("full") === "true";

  try {
    let windowStart = FULL_BACKFILL_START;
    if (!full) {
      const { data: maxRow, error: maxErr } = await sb
        .from("treasury_auction_results")
        .select("auction_date")
        .order("auction_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (maxErr) throw new Error(`reading max(auction_date): ${maxErr.message}`);
      if (maxRow?.auction_date) {
        windowStart = daysAgo(maxRow.auction_date as string, INCREMENTAL_LOOKBACK_DAYS);
      }
      // else: table is empty, fall back to the full backfill start above.
    }

    const url = `${BASE_URL}?filter=auction_date:gte:${windowStart}&sort=-auction_date&fields=${FIELDS}`;
    const { rows: data, pagesFetched, totalCount } = await fetchAllPages<AuctionRow>(url, 1000);
    if (!data.length) {
      await logJobRun(sb, "ok", { mode: full ? "full" : "incremental", windowStart, rowsFetched: 0, rowsUpserted: 0, pagesFetched, totalCount }, startedAt);
      return json({ rowsUpserted: 0, pagesFetched, totalCount, windowStart });
    }

    const rows = data.map((a) => {
      const totalTenderedBn = num(a.total_tendered) != null ? num(a.total_tendered)! / 1e9 : null;
      const totalAcceptedBn = num(a.total_accepted) != null ? num(a.total_accepted)! / 1e9 : null;
      const indirectBn = num(a.indirect_bidder_accepted) != null ? num(a.indirect_bidder_accepted)! / 1e9 : null;
      const directBn = num(a.direct_bidder_accepted) != null ? num(a.direct_bidder_accepted)! / 1e9 : null;
      const dealerBn = num(a.primary_dealer_accepted) != null ? num(a.primary_dealer_accepted)! / 1e9 : null;
      const highYield = num(a.high_yield);
      const avgMedYield = num(a.avg_med_yield);
      // Share-denominator fix (Scott, 2026-11-20): indirect/dealer share
      // must divide by the sum of the three COMPETITIVE bidder categories
      // (indirect + direct + primary dealer), not total_accepted -- which
      // includes SOMA add-ons and noncompetitive bids that were never
      // competed for and inflate the denominator, understating every
      // competitive category's share. Validated live against Scott's
      // published-result checks (2026-11-10 10Y ~61.4%, 2026-10-07 10Y
      // ~80.4%) before trusting this.
      const competitiveTotalBn = (indirectBn ?? 0) + (directBn ?? 0) + (dealerBn ?? 0);
      return {
        auction_date: a.auction_date,
        cusip: a.cusip,
        security_type: a.security_type,
        security_term: a.security_term,
        original_tenor: mapSecurityTermToTenor(a.security_term),
        total_tendered_bn: totalTenderedBn,
        total_accepted_bn: totalAcceptedBn,
        indirect_accepted_bn: indirectBn,
        direct_accepted_bn: directBn,
        primary_dealer_accepted_bn: dealerBn,
        indirect_share_pct: indirectBn != null && competitiveTotalBn > 0 ? Math.round((indirectBn / competitiveTotalBn) * 10000) / 100 : null,
        dealer_share_pct: dealerBn != null && competitiveTotalBn > 0 ? Math.round((dealerBn / competitiveTotalBn) * 10000) / 100 : null,
        bid_to_cover_ratio: num(a.bid_to_cover_ratio),
        high_yield_pct: highYield,
        avg_med_yield_pct: avgMedYield,
        dispersion_bp: highYield != null && avgMedYield != null ? Math.round((highYield - avgMedYield) * 10000) / 100 : null,
        source: "fiscal_data",
        inflation_indexed: a.inflation_index_security === "Yes",
      };
    });

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("treasury_auction_results").upsert(rows.slice(i, i + 500), { onConflict: "auction_date,cusip" });
      if (error) throw new Error(`upsert: ${error.message}`);
    }

    async function newest10y30yAuctionDate(): Promise<string | null> {
      const { data, error } = await sb
        .from("treasury_auction_results")
        .select("auction_date")
        .in("original_tenor", ["10Y", "30Y"])
        .in("security_type", ["Note", "Bond"])
        // TIPS-contamination fix (Scott, 2026-11-20): without this, a TIPS
        // reopening's later auction_date would make the staleness guard
        // (and every other "newest 10Y/30Y" read) think the NOMINAL feed
        // was current when it wasn't -- confirmed live, this exact bug is
        // why CUSIP 91282CRE3's 2026-11-19 TIPS reopening looked like the
        // newest 10Y result.
        .eq("inflation_indexed", false)
        .order("auction_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`reading newest 10Y/30Y auction_date: ${error.message}`);
      return (data?.auction_date as string | undefined) ?? null;
    }

    let newest10y30yDate = await newest10y30yAuctionDate();

    // Fallback: only attempted when Fiscal Data's own 10Y/30Y feed is
    // ALREADY past the staleness guard -- not a second primary source
    // queried every day.
    let treasuryDirectFallback: { attempted: boolean; rowsUpserted: number; error?: string } = { attempted: false, rowsUpserted: 0 };
    const preCheckIsStale = (() => {
      try { assertAuctionFeedFresh(newest10y30yDate, new Date(), STALENESS_MAX_DAYS); return false; }
      catch { return true; }
    })();
    if (preCheckIsStale) {
      treasuryDirectFallback.attempted = true;
      try {
        const tdRows = await fetchTreasuryDirectFallback10y30y();
        if (tdRows.length) {
          for (let i = 0; i < tdRows.length; i += 500) {
            const { error } = await sb.from("treasury_auction_results").upsert(tdRows.slice(i, i + 500), { onConflict: "auction_date,cusip" });
            if (error) throw new Error(`TreasuryDirect upsert: ${error.message}`);
          }
          treasuryDirectFallback.rowsUpserted = tdRows.length;
          newest10y30yDate = await newest10y30yAuctionDate();
        }
      } catch (e) {
        // Never let the fallback's own failure mask the original
        // staleness error -- just means the guard still fires below.
        treasuryDirectFallback.error = e instanceof Error ? e.message : String(e);
      }
    }

    const detail = {
      mode: full ? "full" : "incremental",
      windowStart,
      rowsFetched: rows.length,
      rowsUpserted: rows.length,
      pagesFetched,
      totalCount,
      newestAuctionDate: rows[0]?.auction_date ?? null,
      newest10y30yAuctionDate: newest10y30yDate,
      treasuryDirectFallback,
    };

    try {
      assertAuctionFeedFresh(newest10y30yDate, new Date(), STALENESS_MAX_DAYS);
    } catch (e) {
      if (e instanceof AuctionFeedStaleError) {
        await logJobRun(sb, "error", { ...detail, staleError: e.message, ageDays: e.ageDays, maxDays: e.maxDays }, startedAt);
        return json({ ...detail, error: e.message }, 500);
      }
      throw e;
    }

    await logJobRun(sb, "ok", detail, startedAt);
    return json(detail);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logJobRun(sb, "error", { mode: full ? "full" : "incremental", error: message }, startedAt);
    return json({ error: message }, 500);
  }
});
