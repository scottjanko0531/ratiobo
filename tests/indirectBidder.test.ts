import { describe, it, expect } from "vitest";
import { computeIndirectBidderSnapshot, type AuctionRow } from "../supabase/functions/_shared/indirectBidder.ts";

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
  { auction_date: "2026-08-12", security_term: "10-Year", indirect_share_pct: 60.98 },
  { auction_date: "2026-07-23", security_term: "10-Year", indirect_share_pct: 58.29 },
  { auction_date: "2026-05-12", security_term: "10-Year", indirect_share_pct: 51.52 },
  { auction_date: "2026-02-11", security_term: "10-Year", indirect_share_pct: 50.1 },
  { auction_date: "2026-01-22", security_term: "10-Year", indirect_share_pct: 66.99 },
  { auction_date: "2025-11-12", security_term: "10-Year", indirect_share_pct: 57.77 },
  { auction_date: "2025-08-06", security_term: "10-Year", indirect_share_pct: 47.79 },
  { auction_date: "2026-08-13", security_term: "30-Year", indirect_share_pct: 53.15 },
  { auction_date: "2026-05-13", security_term: "30-Year", indirect_share_pct: 53.69 },
  { auction_date: "2026-02-19", security_term: "30-Year", indirect_share_pct: 77.99 },
  { auction_date: "2026-02-12", security_term: "30-Year", indirect_share_pct: 54.41 },
  { auction_date: "2025-11-13", security_term: "30-Year", indirect_share_pct: 61.29 },
  { auction_date: "2025-08-07", security_term: "30-Year", indirect_share_pct: 44.37 },
  { auction_date: "2025-02-13", security_term: "30-Year", indirect_share_pct: 50.96 },
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
    const only10y = ROWS.filter((r) => r.security_term === "10-Year");
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

// Phase 4a: "Pin the threshold boundary in tests: is 57.5 'weak' or not?"
// The consolidated live value (57.55%) sits just ABOVE the classifier's
// existing 57.5 threshold — confirmed here directly against the real
// numbers, not just asserted in prose. See
// docs/specs/debt-metrics-integrity-decisions.md Phase 4 for the full
// reasoning on why 57.5 itself is unchanged (the spec asked to pin down
// which side of it the corrected number falls on, not to recalibrate it).
describe("the 57.5 boundary, pinned against real data", () => {
  it("57.55% (live) is NOT weak under the existing <57.5 threshold", () => {
    const snap = computeIndirectBidderSnapshot(ROWS, 0);
    expect(snap.value).not.toBeNull();
    expect(snap.value! < 57.5).toBe(false);
  });
});
