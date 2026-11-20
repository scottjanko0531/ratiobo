import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  computeIndirectBidderSnapshot,
  computeIndirectBidderFullSeries,
  meanAndStdev,
  zScoreOf,
  evalAuctionDemandDeterioration,
  type AuctionRow,
} from "../supabase/functions/_shared/indirectBidder.ts";
import { INDIRECT_BIDDER_THRESHOLDS, indirectBidderCardStatus, indirectBidderIsWeak } from "../supabase/functions/_shared/statusThresholds.ts";

// Phase 4a (debt-metrics-integrity spec): one calculation for the Indirect
// Bidder Share — per-term trailing-6 averages (10Y and 30Y), then an
// equal-weighted mean of the two. This is the macro card's own original
// method (confirmed by reading its pre-Phase-4 source before consolidating
// it — see the Phase 4 decisions log); the classifier gate and the
// auction-demand trip-wire previously pooled both terms' auctions into one
// interleaved list instead, producing a different number off the same
// table (59.3% pooled vs. 57.55% per-term-then-mean, same live day).

const ROWS: AuctionRow[] = [
  // Real live data (desc by auction_date), as pulled in the Phase 4
  // decisions log — 6 most-recent 10-Year and 6 most-recent 30-Year
  // auctions as of 2026-11-17.
  { auction_date: "2026-08-12", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 60.98, inflation_indexed: false },
  { auction_date: "2026-07-23", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 58.29, inflation_indexed: false },
  { auction_date: "2026-05-12", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 51.52, inflation_indexed: false },
  { auction_date: "2026-02-11", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 50.1, inflation_indexed: false },
  { auction_date: "2026-01-22", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 66.99, inflation_indexed: false },
  { auction_date: "2025-11-12", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 57.77, inflation_indexed: false },
  { auction_date: "2025-08-06", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 47.79, inflation_indexed: false },
  { auction_date: "2026-08-13", security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: 53.15, inflation_indexed: false },
  { auction_date: "2026-05-13", security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: 53.69, inflation_indexed: false },
  { auction_date: "2026-02-19", security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: 77.99, inflation_indexed: false },
  { auction_date: "2026-02-12", security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: 54.41, inflation_indexed: false },
  { auction_date: "2025-11-13", security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: 61.29, inflation_indexed: false },
  { auction_date: "2025-08-07", security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: 44.37, inflation_indexed: false },
  { auction_date: "2025-02-13", security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: 50.96, inflation_indexed: false },
].sort((a, b) => b.auction_date.localeCompare(a.auction_date));

describe("computeIndirectBidderSnapshot", () => {
  it("matches the live card value: per-term trailing-6 averages, then an equal-weighted mean", () => {
    const snap = computeIndirectBidderSnapshot(ROWS, 0);
    expect(snap.avg10).toBeCloseTo(57.61, 1);
    expect(snap.avg30).toBeCloseTo(57.48, 1);
    expect(snap.value).toBeCloseTo(57.55, 1); // confirmed live card value, Phase 4 decisions log
  });

  it("does NOT match the old pooled-across-both-terms average (59.3%) — that method is retired", () => {
    const snap = computeIndirectBidderSnapshot(ROWS, 0);
    expect(snap.value).not.toBeCloseTo(59.27, 1);
  });

  it("offset shifts the window back one auction round per term", () => {
    const snap1 = computeIndirectBidderSnapshot(ROWS, 1);
    // Dropping the most recent auction of each term and picking up the 7th
    // most recent changes the average — just confirm it's a different,
    // real number, not a copy of offset 0.
    expect(snap1.value).not.toBeNull();
    expect(snap1.value).not.toBe(computeIndirectBidderSnapshot(ROWS, 0).value);
  });

  it("returns null when a term has no data at all", () => {
    const only10y = ROWS.filter((r) => r.original_tenor === "10Y");
    const snap = computeIndirectBidderSnapshot(only10y, 0);
    expect(snap.avg30).toBeNull();
    // Still produces a value from the one term that does have data.
    expect(snap.value).toBeCloseTo(snap.avg10!, 5);
  });

  it("returns a fully null snapshot with no rows", () => {
    const snap = computeIndirectBidderSnapshot([], 0);
    expect(snap.value).toBeNull();
    expect(snap.avg10).toBeNull();
    expect(snap.avg30).toBeNull();
  });
});

// v3 Phase 1c (debt-metrics-integrity-v3 spec): the whole point of
// original_tenor is that a reopening's security_term string ("9-Year
// 10-Month") is NOT "10-Year", so the old exact-match filter silently
// dropped it. These rows mix a new-issue label and two differently-worded
// reopening labels, all mapped to the same original_tenor -- proving
// cleanRows/windowOf now include all three, which the old security_term
// check never would have.
describe("computeIndirectBidderSnapshot — reopenings included (v3 fix)", () => {
  const withReopenings: AuctionRow[] = [
    { auction_date: "2026-08-12", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 60, inflation_indexed: false },
    { auction_date: "2026-07-12", security_term: "9-Year 11-Month", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 58, inflation_indexed: false },
    { auction_date: "2026-06-12", security_term: "9-Year 10-Month", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 56, inflation_indexed: false },
  ];

  it("a reopening's non-'N-Year' security_term label still counts toward the 10Y window", () => {
    const snap = computeIndirectBidderSnapshot(withReopenings, 0);
    // All 3 rows are 10Y by original_tenor, so the trailing-3 average is
    // the mean of all three readings, not just the one new-issue row.
    expect(snap.avg10).toBeCloseTo((60 + 58 + 56) / 3, 2);
  });

  it("the OLD security_term exact-match would have excluded both reopenings (regression guard)", () => {
    const oldStyleFiltered = withReopenings.filter((r) => r.security_term === "10-Year" || r.security_term === "30-Year");
    expect(oldStyleFiltered.length).toBe(1); // only the new-issue row survives the old check
  });

  // The old "TIPS/FRN excluded via security_type" test here used a
  // fictional security_type: "TIPS" value that never actually occurs in
  // real data (confirmed live: TIPS use security_type "Note"/"Bond", same
  // as nominal) -- see the real-shape version of this test in the
  // evalAuctionDemandDeterioration describe block below, using
  // inflation_indexed instead.
});

describe("meanAndStdev / zScoreOf", () => {
  it("computes a population mean/stdev (divide by n, not n-1)", () => {
    const { mean, stdev } = meanAndStdev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBeCloseTo(5, 5);
    expect(stdev).toBeCloseTo(2, 5); // textbook population stdev for this set
  });

  it("returns null for a series with fewer than 2 points (no meaningful z)", () => {
    expect(zScoreOf(10, [10])).toBeNull();
    expect(zScoreOf(10, [])).toBeNull();
  });

  it("returns z=0 for a degenerate (zero-variance) series rather than dividing by zero", () => {
    expect(zScoreOf(5, [5, 5, 5])).toBe(0);
  });
});

describe("computeIndirectBidderFullSeries", () => {
  it("is oldest-first and its newest entry matches computeIndirectBidderSnapshot(rows, 0)", () => {
    const series = computeIndirectBidderFullSeries(ROWS);
    expect(series.length).toBeGreaterThan(0);
    expect(series[series.length - 1].value).toBe(computeIndirectBidderSnapshot(ROWS, 0).value);
    // Oldest-first: each entry's asofDate should be <= the next entry's.
    for (let i = 1; i < series.length; i++) {
      expect(series[i - 1].asofDate <= series[i].asofDate).toBe(true);
    }
  });
});

// v2 Phase 1 (debt-metrics-integrity-v2 spec): evalAuctionDemandDeterioration
// rewrite. v1's version checked the consolidated reading against a FIXED
// <65% threshold, which the metric's own structural range (mid-50s since
// ~2024) can never clear — a permanently-armed trip-wire. This version
// compares against the metric's own trailing-2-year mean/stdev with
// hysteresis (rule 7: every gate must have a real disarm path) and reports
// sinceDate as the true start of the current streak (rule 9), not the edge
// of some lookback window.
//
// Each synthetic round below supplies both a 10-Year and a 30-Year auction
// so every offset has a real consolidated value; rounds are spaced 14 days
// apart (round 0 = newest), same convention as the old debtCycleTripWires.ts
// auction tests this replaces.
function daysAgo(n: number, anchor = "2026-08-21T00:00:00Z"): string {
  const d = new Date(anchor);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function buildAuctionRounds(roundValues: { y10: number; y30: number }[]): AuctionRow[] {
  const rows: AuctionRow[] = [];
  roundValues.forEach(({ y10, y30 }, round) => {
    rows.push({ auction_date: daysAgo(round * 14), security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: y10, inflation_indexed: false });
    rows.push({ auction_date: daysAgo(round * 14 + 1), security_term: "30-Year", original_tenor: "30Y", security_type: "Bond", indirect_share_pct: y30, inflation_indexed: false });
  });
  return rows;
}

describe("evalAuctionDemandDeterioration (v2 Phase 1 hysteresis rewrite)", () => {
  // 12 low rounds (newest) preceded by 12 high rounds (oldest) — the low
  // stretch is long enough that its own trailing-6-per-term windows read a
  // clean, stable ~39% once past the 6-round transition zone, well below
  // the mean-1sd arm threshold for >= armPersistRounds (3) in a row.
  const armedBaseRounds = [
    ...Array.from({ length: 12 }, () => ({ y10: 40, y30: 38 })),
    ...Array.from({ length: 12 }, () => ({ y10: 60, y30: 58 })),
  ];

  it("armed: a sustained multi-round drop below the trailing-2-year mean arms the wire, with sinceDate at the streak's true start", () => {
    const rows = buildAuctionRounds(armedBaseRounds);
    const result = evalAuctionDemandDeterioration(rows, INDIRECT_BIDDER_THRESHOLDS.tripWire);
    expect(result.armed).toBe(true);
    // The true streak start (first of 3+ consecutive below-threshold
    // rounds), not the oldest row in the array (daysAgo(23*14) = 2025-10-04)
    // and not some fixed lookback-window edge — this is rule 9's fix.
    expect(result.sinceDate).toBe("2026-05-29");
    expect(result.sinceDate).not.toBe(rows[rows.length - 1].auction_date);
  });

  it("disarm (rule 7): the SAME armed condition, with recovery rounds appended, turns the wire back off", () => {
    // Prepend 5 strong recovery rounds (newest) onto the exact rows that
    // armed above — proves the gate has a genuine disarm path, not just an
    // absence of arming.
    const recoveredRounds = [
      ...Array.from({ length: 5 }, () => ({ y10: 60, y30: 58 })),
      ...armedBaseRounds,
    ];
    const rows = buildAuctionRounds(recoveredRounds);
    const result = evalAuctionDemandDeterioration(rows, INDIRECT_BIDDER_THRESHOLDS.tripWire);
    expect(result.armed).toBe(false);
    expect(result.sinceDate).toBeNull();
  });

  it("hysteresis — arm side: a dip shorter than armPersistRounds (3) never arms", () => {
    const rounds = [
      { y10: 40, y30: 38 },
      { y10: 40, y30: 38 }, // only 2 consecutive low rounds
      ...Array.from({ length: 22 }, () => ({ y10: 60, y30: 58 })),
    ];
    const rows = buildAuctionRounds(rounds);
    const result = evalAuctionDemandDeterioration(rows, INDIRECT_BIDDER_THRESHOLDS.tripWire);
    expect(result.armed).toBe(false);
  });

  it("hysteresis — disarm side: a single recovery round (short of disarmPersistRounds=2) does NOT disarm an armed wire", () => {
    const partialRecoveryRounds = [
      { y10: 60, y30: 58 }, // only 1 recovery round
      ...armedBaseRounds,
    ];
    const rows = buildAuctionRounds(partialRecoveryRounds);
    const result = evalAuctionDemandDeterioration(rows, INDIRECT_BIDDER_THRESHOLDS.tripWire);
    expect(result.armed).toBe(true);
  });

  it("today's live numbers (regression anchor): real NOMINAL-ONLY, CORRECT-DENOMINATOR 2010-2026 auction history reads disarmed", () => {
    // This regression anchor has now been corrected TWICE in one day, both
    // times by Scott catching a real bug in the live numbers:
    //
    // 1. TIPS-contamination fix: the original fixture (tests/fixtures/
    //    indirect-bidder-auction-history-2026-11-17.json, 185 rows) had 51
    //    real TIPS auctions (27.6%) mixed in -- security_type "Note"/"Bond"
    //    never distinguished them from nominal. Fixed by filtering
    //    inflation_indexed=false (_shared/indirectBidder.ts's cleanRows).
    // 2. Share-denominator fix: indirect_share_pct/dealer_share_pct were
    //    dividing by total_accepted_bn (includes SOMA + noncompetitive
    //    add-ons never competed for), not the sum of the three COMPETITIVE
    //    bidder categories. Validated against Scott's published-result
    //    checks before trusting it: 2026-11-10 10Y -> 61.39% (expected
    //    ~61.4%), 2026-10-07 10Y -> 80.34% (expected ~80.4%) -- both landed
    //    almost exactly, confirming the fix.
    //
    // tests/fixtures/indirect-bidder-auction-history-nominal-only-
    // 2026-11-20.json now reflects BOTH corrections (134 genuinely nominal
    // rows, each with the correct competitive-total-denominator share) --
    // not a new fetch, the real history with both bugs removed.
    //
    // FULL RETROACTIVE IMPACT CHAIN, reported explicitly at every stage
    // (all computed with the real evalAuctionDemandDeterioration/
    // computeIndirectBidderFullSeries functions):
    //                          latest    mean2y   sd2y   windowN   z       status   armed
    //   original (both bugs):  57.55%    56.83    2.02   12        +1.16   healthy  false
    //   TIPS fixed only:       52.57%    53.66    2.35    8        +0.86   healthy  false
    //   BOTH fixed (final):    66.70%    65.93    0.61    8        +0.92   healthy  false
    //
    // The denominator fix alone moved "latest" up ~14pp (52.57% -> 66.70%)
    // -- removing SOMA/noncompetitive from the denominator always INCREASES
    // the computed competitive share for the same numerator. Across the
    // full chain (both bugs), the DISPLAYED number swung by double digits
    // (57.55% -> 66.70%), and sd2y dropped sharply (2.02 -> 0.61 -- the old
    // formula's SOMA-add-on noise was inflating the metric's apparent
    // volatility). But the qualitative, actionable conclusions are
    // UNCHANGED at every stage: status "healthy", trip-wire disarmed,
    // z-score comfortably positive and nowhere near the -1/-1.5/-2
    // thresholds that would flip anything live.
    const raw = JSON.parse(
      readFileSync(
        new URL("./fixtures/indirect-bidder-auction-history-nominal-only-2026-11-20.json", import.meta.url),
        "utf8",
      ),
    ) as AuctionRow[];
    const rows = [...raw].sort((a, b) => b.auction_date.localeCompare(a.auction_date));

    const result = evalAuctionDemandDeterioration(rows, INDIRECT_BIDDER_THRESHOLDS.tripWire);
    expect(result.armed).toBe(false);
    expect(result.sinceDate).toBeNull();
    expect(result.values.latest).toBeCloseTo(66.70, 1);
    expect(result.values.mean2y).toBeCloseTo(65.93, 1);
    expect(result.values.sd2y).toBeCloseTo(0.61, 1);
    expect(result.values.windowReadingCount).toBe(8);

    // The card/classifier's full-history z-score for the same latest
    // reading: +0.92 — healthy (z > -1), not weak (z > -1.5).
    const fullSeries = computeIndirectBidderFullSeries(rows);
    const z = zScoreOf(fullSeries[fullSeries.length - 1].value, fullSeries.map((s) => s.value));
    expect(z).toBeCloseTo(0.92, 1);
    expect(indirectBidderCardStatus(z!)).toBe("healthy");
    expect(indirectBidderIsWeak(z!)).toBe(false);
  });

  it("a TIPS row mixed into otherwise-clean nominal rows is excluded even though security_type matches 'Note'/'Bond' (the real contamination shape)", () => {
    // Confirmed live: real TIPS auctions have security_type "Note"/"Bond",
    // the SAME values NOMINAL_TYPES already checked -- that check alone
    // was never sufficient. Only inflation_indexed actually distinguishes
    // them, which is why this fixture row has security_type "Note" (not
    // the fictional "TIPS" value the old, now-removed test used).
    const withRealShapeTips: AuctionRow[] = [
      { auction_date: "2026-08-12", security_term: "10-Year", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 60, inflation_indexed: false },
      { auction_date: "2026-07-12", security_term: "9-Year 11-Month", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 58, inflation_indexed: false },
      { auction_date: "2026-06-12", security_term: "9-Year 10-Month", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 56, inflation_indexed: false },
      { auction_date: "2026-08-01", security_term: "9-Year 10-Month", original_tenor: "10Y", security_type: "Note", indirect_share_pct: 99, inflation_indexed: true },
    ];
    const snap = computeIndirectBidderSnapshot(withRealShapeTips, 0);
    // The TIPS row's 99% would skew the average if it weren't excluded.
    expect(snap.avg10).toBeCloseTo((60 + 58 + 56) / 3, 2);
  });
});
