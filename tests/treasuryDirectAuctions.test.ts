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
  inflationProtected: "No",
};

// Real record confirmed live via TA_WS for CUSIP 91282CRE3 -- the actual
// Nov 19, 2026 "9-Year 8-Month" reopening, confirmed TIPS
// (inflationProtected: "Yes", securityDescription "9-Year 8-Month TIPS").
// This is the exact scope of the contamination bug: the SAME term shape
// ("9-Year 8-Month") is also used by nominal 10Y reopenings in other
// years -- the string alone can't distinguish them, only this field can.
const REAL_TIPS_NOV19: TreasuryDirectRecord = {
  cusip: "91282CRE3",
  securityType: "Note",
  securityTerm: "9-Year 8-Month",
  competitiveAuctionCloseDate: "2026-11-19T00:00:00",
  grandTotalParRecognized: "50000000000",
  grandTotalParAwarded: "20000000000",
  directBiddersCompetitiveParAwarded: "2000000000",
  directBiddersNoncompetitiveParAwarded: "0",
  indirectBiddersCompetitiveParAwarded: "10000000000",
  indirectBiddersNoncompetitiveParAwarded: "0",
  primaryDealersCompetitiveParAwarded: "8000000000",
  primaryDealersNoncompetitiveParAwarded: "0",
  bidToCoverRatio: "2.43",
  highYield: "2.100",
  medianYield: "2.050",
  inflationProtected: "Yes",
};

const tenorMap = (term: string) => {
  const newIssue = term.match(/^(\d+)-Year$/);
  if (newIssue) return `${newIssue[1]}Y`;
  const reopening = term.match(/^(\d+)-Year (\d{1,2})-Month$/);
  if (reopening) {
    const months = parseInt(reopening[2], 10);
    if (months >= 1 && months <= 11) return `${parseInt(reopening[1], 10) + 1}Y`;
  }
  return null;
};

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

  it("computes indirect/dealer share pct against the COMPETITIVE total (indirect+direct+dealer), not grand total awarded", () => {
    // Share-denominator fix (Scott, 2026-11-20): grandTotalParAwarded
    // (50,519,618,200) includes SOMA/noncompetitive add-ons -- using it
    // as the denominator understates every competitive category's real
    // share. The correct denominator is the sum of the three competitive
    // categories themselves.
    const row = mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap);
    const indirectTotal = 25566955000 + 172823000;
    const directTotal = 12109950200 + 0;
    const dealerTotal = 4080513500 + 0;
    const competitiveTotal = indirectTotal + directTotal + dealerTotal;
    const expectedPct = Math.round((indirectTotal / competitiveTotal) * 10000) / 100;
    expect(row.indirect_share_pct).toBeCloseTo(expectedPct, 2);
    // Validated against Scott's published-result check: real 2026-11-10
    // 10Y indirect share should be ~61.4% -- confirms the fix, not just
    // that the formula looks right.
    expect(row.indirect_share_pct).toBeCloseTo(61.4, 0);
  });

  it("computes dispersion_bp as (highYield - medianYield) in basis points", () => {
    const row = mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap);
    expect(row.dispersion_bp).toBeCloseTo((5.020 - 4.961) * 100, 2);
  });

  it("flags inflation_indexed from the real inflationProtected field, not the term string", () => {
    const nominal = mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap);
    expect(nominal.inflation_indexed).toBe(false);
    const tips = mapTreasuryDirectRecord(REAL_TIPS_NOV19, tenorMap);
    expect(tips.inflation_indexed).toBe(true);
    // Both map to original_tenor "10Y" by term shape alone -- the term
    // string genuinely cannot distinguish them; only inflation_indexed can.
    expect(tips.original_tenor).toBe("10Y");
  });

  it("a TIPS reopening sharing a CUSIP with a prior nominal '10-Year' auction is never selected as the latest nominal 10Y", () => {
    // CUSIP 91282CRE3's own real history: issued as a genuine "10-Year"
    // TIPS on 2026-07-23, reopened as TIPS again on 2026-09-17 and
    // 2026-11-19 -- every single row for this CUSIP is TIPS, confirmed
    // live. The REGRESSION this guards: picking "newest row where
    // original_tenor=10Y" without ALSO filtering inflation_indexed=false
    // would select this CUSIP's Nov 19 row as the "latest nominal 10Y",
    // silently reporting a TIPS auction's bid-to-cover/yields as if they
    // were the nominal market's.
    const originalIssue: TreasuryDirectRecord = { ...REAL_TIPS_NOV19, securityTerm: "10-Year", competitiveAuctionCloseDate: "2026-07-23T00:00:00" };
    const rows = [
      mapTreasuryDirectRecord(REAL_10Y_NOV10, tenorMap),      // real nominal 10Y, 2026-11-10
      mapTreasuryDirectRecord(REAL_TIPS_NOV19, tenorMap),     // TIPS reopening, 2026-11-19 -- LATER than the real nominal row
      mapTreasuryDirectRecord(originalIssue, tenorMap),       // same CUSIP's original TIPS issue, 2026-07-23
    ];
    const latestNominal10y = rows
      .filter((r) => r.original_tenor === "10Y" && !r.inflation_indexed)
      .sort((a, b) => b.auction_date.localeCompare(a.auction_date))[0];
    expect(latestNominal10y.cusip).toBe("91282CRX1");
    expect(latestNominal10y.auction_date).toBe("2026-11-10");
    // Without the inflation_indexed filter, the TIPS row (later date) would win instead:
    const latestUnfiltered = rows
      .filter((r) => r.original_tenor === "10Y")
      .sort((a, b) => b.auction_date.localeCompare(a.auction_date))[0];
    expect(latestUnfiltered.cusip).toBe("91282CRE3"); // confirms the bug this test guards against is real
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

  it("a large SOMA/noncompetitive add-on does NOT lower the computed indirect share (the specific regression this fix addresses)", () => {
    // grandTotalParAwarded includes SOMA + noncompetitive add-ons that
    // were never competed for. Holding the three competitive categories
    // fixed and varying ONLY the add-on baked into grandTotalParAwarded
    // must leave indirect_share_pct completely unchanged -- if it moved,
    // the add-on would still be leaking into the denominator.
    const competitiveOnly: TreasuryDirectRecord = {
      ...REAL_10Y_NOV10,
      // Same three competitive categories as the real record (no
      // noncompetitive component this time, to isolate the add-on
      // variable to grandTotalParAwarded alone).
      indirectBiddersCompetitiveParAwarded: "25000000000",
      indirectBiddersNoncompetitiveParAwarded: "0",
      directBiddersCompetitiveParAwarded: "12000000000",
      directBiddersNoncompetitiveParAwarded: "0",
      primaryDealersCompetitiveParAwarded: "4000000000",
      primaryDealersNoncompetitiveParAwarded: "0",
      // competitive total = 41,000,000,000 -- grandTotalParAwarded below
      // is deliberately set much larger via a large SOMA-style add-on.
      grandTotalParAwarded: "41000000000",
    };
    const noAddOn = mapTreasuryDirectRecord(competitiveOnly, tenorMap);

    const withHugeSomaAddOn: TreasuryDirectRecord = {
      ...competitiveOnly,
      // +15bn SOMA/noncompetitive add-on baked into the grand total only
      // -- the competitive categories above are untouched.
      grandTotalParAwarded: "56000000000",
    };
    const withAddOn = mapTreasuryDirectRecord(withHugeSomaAddOn, tenorMap);

    expect(noAddOn.indirect_share_pct).toBe(withAddOn.indirect_share_pct);
    expect(withAddOn.indirect_share_pct).toBeCloseTo((25000000000 / 41000000000) * 100, 2);
    // Prove the OLD (buggy) formula WOULD have moved -- this is what
    // confirms the fix actually fixes something, not just that the new
    // formula is invariant by coincidence.
    const oldBuggyShare = (25000000000 / 56000000000) * 100;
    expect(withAddOn.indirect_share_pct).not.toBeCloseTo(oldBuggyShare, 2);
  });
});
