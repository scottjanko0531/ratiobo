// Growth & Inflation Indicator Gaps spec, Phase 2b. Mirrors
// auctionFreshness.ts's "make failures visible" guard exactly -- a
// null/stale newest-month read must throw, not silently serve an old
// value as current. The NY Fed publishes GSCPI monthly; 60 days gives
// one full cycle plus slack for a late publish before calling it broken.

export class GscpiFeedStaleError extends Error {
  constructor(public readonly newestDate: string, public readonly ageDays: number, public readonly maxDays: number) {
    super(`newest GSCPI month (${newestDate}) is ${ageDays} days old, exceeding the ${maxDays}-day staleness guard`);
    this.name = "GscpiFeedStaleError";
  }
}

// Throws GscpiFeedStaleError if `newestDate` (the most recent month actually
// parsed from the NY Fed file) is more than `maxDays` old as of `now`. A
// null `newestDate` (no rows parsed at all) is treated as maximally stale.
export function assertGscpiFeedFresh(newestDate: string | null, now: Date, maxDays = 60): void {
  if (newestDate == null) {
    throw new GscpiFeedStaleError("none", Infinity, maxDays);
  }
  const ageMs = now.getTime() - new Date(newestDate + "T00:00:00Z").getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (ageDays > maxDays) {
    throw new GscpiFeedStaleError(newestDate, ageDays, maxDays);
  }
}
