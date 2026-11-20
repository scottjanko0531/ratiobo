// Live-site issue follow-up (Scott, 2026-11-20): TreasuryDirect's TA_WS
// API as a fallback source for ingest-auction-results, used specifically
// when Fiscal Data's own auctions_query feed goes stale (confirmed live:
// Fiscal Data had nothing past 2026-10-22 at all, while TreasuryDirect
// already had real Nov 10 (10Y) and Nov 12 (30Y) auction results -- this
// is a real gap in Fiscal Data's own feed, not a Treasury-wide pause).
//
// Field names below are the exact raw keys confirmed live via a direct
// TA_WS call for CUSIP 91282CRX1 (the real Nov 10, 2026 10-Year Note),
// not guessed from documentation. TreasuryDirect's "competitive auction
// close date" is the actual auction date (when bidding closed) --
// confirmed to match the known calendar date for that CUSIP.
export interface TreasuryDirectRecord {
  cusip: string;
  securityType: string;
  securityTerm: string;
  competitiveAuctionCloseDate: string; // e.g. "2026-11-10T00:00:00"
  grandTotalParRecognized: string;
  grandTotalParAwarded: string;
  directBiddersCompetitiveParAwarded: string;
  directBiddersNoncompetitiveParAwarded: string;
  indirectBiddersCompetitiveParAwarded: string;
  indirectBiddersNoncompetitiveParAwarded: string;
  primaryDealersCompetitiveParAwarded: string;
  primaryDealersNoncompetitiveParAwarded: string;
  bidToCoverRatio: string;
  highYield: string;
  medianYield: string;
  // TIPS-contamination fix (Scott, 2026-11-20): confirmed live via a direct
  // TA_WS call for CUSIP 91282CRE3 ("9-Year 8-Month TIPS",
  // inflationProtected: "Yes") -- this field is real and reliable, it was
  // just never read before. TIPS share securityType "Note"/"Bond" with
  // nominal notes/bonds, same reopening term shapes ("9-Year 8/10-Month"
  // is used by BOTH nominal and TIPS 10Y reopenings in different years) --
  // term-string pattern matching alone cannot tell them apart; this field
  // can.
  inflationProtected: string;
}

export interface MappedAuctionRow {
  auction_date: string;
  cusip: string;
  security_type: string;
  security_term: string;
  original_tenor: string | null;
  total_tendered_bn: number | null;
  total_accepted_bn: number | null;
  indirect_accepted_bn: number | null;
  direct_accepted_bn: number | null;
  primary_dealer_accepted_bn: number | null;
  indirect_share_pct: number | null;
  dealer_share_pct: number | null;
  bid_to_cover_ratio: number | null;
  high_yield_pct: number | null;
  avg_med_yield_pct: number | null;
  dispersion_bp: number | null;
  source: string;
  inflation_indexed: boolean;
}

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sumNum(a: string | undefined, b: string | undefined): number | null {
  const na = num(a), nb = num(b);
  if (na == null && nb == null) return null;
  return (na ?? 0) + (nb ?? 0);
}

// Mirrors ingest-auction-results's own row-building math exactly (same
// field semantics, same $bn scale, same share-pct/dispersion formulas) --
// a second real source, not a parallel definition of the same numbers.
export function mapTreasuryDirectRecord(
  r: TreasuryDirectRecord, mapSecurityTermToTenor: (term: string) => string | null,
): MappedAuctionRow {
  const totalTenderedBn = num(r.grandTotalParRecognized) != null ? num(r.grandTotalParRecognized)! / 1e9 : null;
  const totalAccepted = num(r.grandTotalParAwarded);
  const totalAcceptedBn = totalAccepted != null ? totalAccepted / 1e9 : null;
  const indirectTotal = sumNum(r.indirectBiddersCompetitiveParAwarded, r.indirectBiddersNoncompetitiveParAwarded);
  const directTotal = sumNum(r.directBiddersCompetitiveParAwarded, r.directBiddersNoncompetitiveParAwarded);
  const dealerTotal = sumNum(r.primaryDealersCompetitiveParAwarded, r.primaryDealersNoncompetitiveParAwarded);
  const highYield = num(r.highYield);
  const avgMedYield = num(r.medianYield);

  return {
    auction_date: r.competitiveAuctionCloseDate.slice(0, 10),
    cusip: r.cusip,
    security_type: r.securityType,
    security_term: r.securityTerm,
    original_tenor: mapSecurityTermToTenor(r.securityTerm),
    total_tendered_bn: totalTenderedBn,
    total_accepted_bn: totalAcceptedBn,
    indirect_accepted_bn: indirectTotal != null ? indirectTotal / 1e9 : null,
    direct_accepted_bn: directTotal != null ? directTotal / 1e9 : null,
    primary_dealer_accepted_bn: dealerTotal != null ? dealerTotal / 1e9 : null,
    indirect_share_pct: indirectTotal != null && totalAccepted ? Math.round((indirectTotal / totalAccepted) * 10000) / 100 : null,
    dealer_share_pct: dealerTotal != null && totalAccepted ? Math.round((dealerTotal / totalAccepted) * 10000) / 100 : null,
    bid_to_cover_ratio: num(r.bidToCoverRatio),
    high_yield_pct: highYield,
    avg_med_yield_pct: avgMedYield,
    dispersion_bp: highYield != null && avgMedYield != null ? Math.round((highYield - avgMedYield) * 10000) / 100 : null,
    source: "treasurydirect",
    inflation_indexed: r.inflationProtected === "Yes",
  };
}
