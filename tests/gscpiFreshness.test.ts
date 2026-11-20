import { describe, it, expect } from "vitest";
import { assertGscpiFeedFresh, GscpiFeedStaleError } from "../supabase/functions/_shared/gscpiFreshness.ts";

describe("assertGscpiFeedFresh", () => {
  const now = new Date("2026-11-20T00:00:00Z");

  it("does not throw when the newest month is within 60 days", () => {
    expect(() => assertGscpiFeedFresh("2026-10-31", now, 60)).not.toThrow(); // 20 days
  });

  it("does not throw at exactly 60 days", () => {
    expect(() => assertGscpiFeedFresh("2026-09-21", now, 60)).not.toThrow(); // 60 days exactly
  });

  it("throws above 60 days -- a feed stuck for two+ release cycles", () => {
    expect(() => assertGscpiFeedFresh("2026-07-31", now, 60)).toThrow(GscpiFeedStaleError); // ~112 days
  });

  it("throws at 61 days (one past the boundary)", () => {
    expect(() => assertGscpiFeedFresh("2026-09-20", now, 60)).toThrow(GscpiFeedStaleError); // 61 days
  });

  it("treats a null newest-date (no rows parsed at all) as maximally stale, not a silent pass", () => {
    expect(() => assertGscpiFeedFresh(null, now, 60)).toThrow(GscpiFeedStaleError);
  });

  it("error carries the actual date/age for logging", () => {
    try {
      assertGscpiFeedFresh("2026-07-31", now, 60);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GscpiFeedStaleError);
      const err = e as GscpiFeedStaleError;
      expect(err.newestDate).toBe("2026-07-31");
      expect(err.maxDays).toBe(60);
      expect(err.ageDays).toBeGreaterThan(60);
    }
  });
});
