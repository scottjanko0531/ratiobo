// v3 Phase 1d (debt-metrics-integrity-v3 spec). "Make failures visible":
// the old ingest reported success every single day for ~27 days while
// silently serving August auction data (confirmed live, v3 Phase 0 --
// the daily cron logged "succeeded" throughout). This is the guard that
// makes a stopped feed actually show up instead of silently reading as
// healthy forever. 10Y auctions roughly monthly; 35 days gives one full
// cycle plus slack for a late publish before calling it broken.

export class AuctionFeedStaleError extends Error {
  constructor(public readonly newestAuctionDate: string, public readonly ageDays: number, public readonly maxDays: number) {
    super(`newest 10Y/30Y auction (${newestAuctionDate}) is ${ageDays} days old, exceeding the ${maxDays}-day staleness guard`);
    this.name = "AuctionFeedStaleError";
  }
}

// Throws AuctionFeedStaleError if `newestAuctionDate` (the most recent
// 10Y or 30Y auction_date actually found) is more than `maxDays` old as
// of `now`. A null `newestAuctionDate` (no 10Y/30Y row found at all) is
// treated as maximally stale -- it throws too, not a silent pass.
export function assertAuctionFeedFresh(newestAuctionDate: string | null, now: Date, maxDays = 35): void {
  if (newestAuctionDate == null) {
    throw new AuctionFeedStaleError("none", Infinity, maxDays);
  }
  const ageMs = now.getTime() - new Date(newestAuctionDate + "T00:00:00Z").getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (ageDays > maxDays) {
    throw new AuctionFeedStaleError(newestAuctionDate, ageDays, maxDays);
  }
}
