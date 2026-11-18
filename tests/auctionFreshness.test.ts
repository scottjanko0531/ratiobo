import { describe, it, expect } from "vitest";
import { assertAuctionFeedFresh, AuctionFeedStaleError } from "../supabase/functions/_shared/auctionFreshness.ts";

describe("assertAuctionFeedFresh", () => {
  const now = new Date("2026-11-18T00:00:00Z");

  it("does not throw when the newest auction is within 35 days", () => {
    expect(() => assertAuctionFeedFresh("2026-10-25", now, 35)).not.toThrow(); // 24 days
  });

  it("does not throw at exactly 35 days", () => {
    expect(() => assertAuctionFeedFresh("2026-10-14", now, 35)).not.toThrow(); // 35 days exactly
  });

  it("throws above 35 days -- the real live case this guard exists for (2026-10-22, ~27 days at the time of writing, would NOT throw; a feed stuck since August WOULD)", () => {
    expect(() => assertAuctionFeedFresh("2026-08-13", now, 35)).toThrow(AuctionFeedStaleError); // ~97 days
  });

  it("throws at 36 days (one past the boundary)", () => {
    expect(() => assertAuctionFeedFresh("2026-10-13", now, 35)).toThrow(AuctionFeedStaleError); // 36 days
  });

  it("treats a null newest-auction-date (no 10Y/30Y row found at all) as maximally stale, not a silent pass", () => {
    expect(() => assertAuctionFeedFresh(null, now, 35)).toThrow(AuctionFeedStaleError);
  });

  it("error carries the actual date/age for logging", () => {
    try {
      assertAuctionFeedFresh("2026-08-13", now, 35);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuctionFeedStaleError);
      const err = e as AuctionFeedStaleError;
      expect(err.newestAuctionDate).toBe("2026-08-13");
      expect(err.maxDays).toBe(35);
      expect(err.ageDays).toBeGreaterThan(35);
    }
  });
});
