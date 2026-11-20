import { describe, it, expect } from "vitest";
import { mapTreasuryDirectRecord, TreasuryDirectRecord } from "../supabase/functions/_shared/treasuryDirectAuctions.ts";

// Real record confirmed live via TA_WS for CUSIP 91282CRX1 (the actual
// Nov 10, 2026 10-Year Note auction) -- the exact gap that triggered this
// fallback (Fiscal Data had nothing past 2026-10-22 at all).
const REAL_10Y_NOV10: TreasuryDirectRecord = {
  cusip: "91282CRX1",
  securityType: "Note",
  securityTerm: "10-Year",
  competitiveAuctionCloseDate: "2026-11-10T00:00:00",
  grandTotalParRecognized: "111822237500",
  grandTotalParAwarded: "50519618200",
  directBiddersCompetitiveParAwarded: "12109950200",
  directBiddersNoncompetitiveParAwarded: "0",
  indirectBiddersCompetitiveParAwarded: "25566955000",
  indirectBiddersNoncompetitiveParAwarded: "172823000",
  primaryDealersCompetitiveParAwarded: "4080513500",
  primaryDealersNoncompetitiveParAwarded: "0",
  bidToCoverRatio: "2.46",
  highYield: "5.020",
  medianYield: "4.961",
};

const tenorMap = (term: string) => (term === "10-Year" ? "10Y" : term === "30-Year" ? "30Y" : null);

describe("mapTreasuryDirectRecord", () => {
  it("maps the real Nov 10, 2026 10-Year Note record correctly", () => {
    const row = mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap);
    expect(row.auction_date).toBe("2026-11-10");
    expect(row.cusip).toBe("91282CRX1");
    expect(row.security_type).toBe("Note");
    expect(row.security_term).toBe("10-Year");
    expect(row.original_tenor).toBe("10Y");
    expect(row.bid_to_cover_ratio).toBe(2.46);
    expect(row.high_yield_pct).toBe(5.02);
    expect(row.avg_med_yield_pct).toBe(4.961);
    expect(row.source).toBe("treasurydirect");
  });

  it("sums competitive + noncompetitive awarded for indirect/direct/dealer totals", () => {
    const row = mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap);
    // indirect: 25,566,955,000 + 172,823,000 = 25,739,778,000 -> /1e9
    expect(row.indirect_accepted_bn).toBeCloseTo(25.739778, 5);
    // direct: 12,109,950,200 + 0
    expect(row.direct_accepted_bn).toBeCloseTo(12.1099502, 5);
    // dealer: 4,080,513,500 + 0
    expect(row.primary_dealer_accepted_bn).toBeCloseTo(4.0805135, 5);
  });

  it("computes indirect/dealer share pct against the grand total awarded", () => {
    const row = mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap);
    const totalAwarded = 50519618200;
    const indirectTotal = 25566955000 + 172823000;
    expect(row.indirect_share_pct).toBeCloseTo(Math.round((indirectTotal / totalAwarded) * 10000) / 100, 2);
  });

  it("computes dispersion_bp as (highYield - medianYield) in basis points", () => {
    const row = mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap);
    expect(row.dispersion_bp).toBeCloseTo((5.020 - 4.961) * 100, 2);
  });

  it("returns null fields gracefully for a Bill-type record with no bidder breakdown", () => {
    const billRecord: TreasuryDirectRecord = {
      ...REAL_10Y_NOV10,
      securityType: "Bill", securityTerm: "4-Week",
      directBiddersCompetitiveParAwarded: "", directBiddersNoncompetitiveParAwarded: "",
      indirectBiddersCompetitiveParAwarded: "", indirectBiddersNoncompetitiveParAwarded: "",
      primaryDealersCompetitiveParAwarded: "", primaryDealersNoncompetitiveParAwarded: "",
    };
    const row = mapTreasuryDirectRecord(billRecord, tenorMap);
    expect(row.original_tenor).toBeNull(); // tenorMap doesn't recognize "4-Week"
    expect(row.indirect_accepted_bn).toBeNull();
    expect(row.direct_accepted_bn).toBeNull();
    expect(row.indirect_share_pct).toBeNull();
  });
});
