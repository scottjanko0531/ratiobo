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
// Backfills all auctions since 2010 on every run (idempotent upsert;
// ~5,700 rows fits in a single API page, no pagination needed in practice).
const BASE_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";
const FIELDS = [
  "auction_date", "cusip", "security_type", "security_term",
  "total_tendered", "total_accepted", "indirect_bidder_accepted",
  "direct_bidder_accepted", "primary_dealer_accepted", "bid_to_cover_ratio",
  "high_yield", "avg_med_yield",
].join(",");

interface AuctionRow {
  auction_date: string; cusip: string; security_type: string; security_term: string;
  total_tendered: string; total_accepted: string; indirect_bidder_accepted: string;
  direct_bidder_accepted: string; primary_dealer_accepted: string; bid_to_cover_ratio: string;
  high_yield: string; avg_med_yield: string;
}

function num(v: string): number | null {
  if (v == null || v === "null" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const url = `${BASE_URL}?filter=auction_date:gte:2010-01-01&sort=auction_date&page%5Bnumber%5D=1&page%5Bsize%5D=10000&fields=${FIELDS}`;
    const res = await fetch(url);
    if (!res.ok) return json({ error: `Fiscal Data API: HTTP ${res.status}` }, 500);
    const j = await res.json();
    const data = j.data as AuctionRow[];
    if (!data?.length) return json({ error: "no auction rows returned" }, 500);

    const rows = data.map((a) => {
      const totalTenderedBn = num(a.total_tendered) != null ? num(a.total_tendered)! / 1e9 : null;
      const totalAcceptedBn = num(a.total_accepted) != null ? num(a.total_accepted)! / 1e9 : null;
      const indirectBn = num(a.indirect_bidder_accepted) != null ? num(a.indirect_bidder_accepted)! / 1e9 : null;
      const directBn = num(a.direct_bidder_accepted) != null ? num(a.direct_bidder_accepted)! / 1e9 : null;
      const dealerBn = num(a.primary_dealer_accepted) != null ? num(a.primary_dealer_accepted)! / 1e9 : null;
      const highYield = num(a.high_yield);
      const avgMedYield = num(a.avg_med_yield);
      const totalAccepted = num(a.total_accepted);
      return {
        auction_date: a.auction_date,
        cusip: a.cusip,
        security_type: a.security_type,
        security_term: a.security_term,
        total_tendered_bn: totalTenderedBn,
        total_accepted_bn: totalAcceptedBn,
        indirect_accepted_bn: indirectBn,
        direct_accepted_bn: directBn,
        primary_dealer_accepted_bn: dealerBn,
        indirect_share_pct: indirectBn != null && totalAccepted ? Math.round((num(a.indirect_bidder_accepted)! / totalAccepted) * 10000) / 100 : null,
        dealer_share_pct: dealerBn != null && totalAccepted ? Math.round((num(a.primary_dealer_accepted)! / totalAccepted) * 10000) / 100 : null,
        bid_to_cover_ratio: num(a.bid_to_cover_ratio),
        high_yield_pct: highYield,
        avg_med_yield_pct: avgMedYield,
        dispersion_bp: highYield != null && avgMedYield != null ? Math.round((highYield - avgMedYield) * 10000) / 100 : null,
      };
    });

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("treasury_auction_results").upsert(rows.slice(i, i + 500), { onConflict: "auction_date,cusip" });
      if (error) return json({ error: error.message }, 500);
    }

    const latest10y = rows.filter((r) => r.security_term === "10-Year").sort((a, b) => b.auction_date.localeCompare(a.auction_date))[0];
    return json({ rowsUpserted: rows.length, latest10yAuction: latest10y ?? null });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
