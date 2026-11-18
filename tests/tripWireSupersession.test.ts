import { describe, it, expect } from "vitest";
import {
  supersededByDate,
  filterSupersededFirings,
  TRIP_WIRE_RECALIBRATION_NOTE_PREFIX,
} from "../supabase/functions/_shared/tripWireSupersession.ts";

// Real data (v3 Phase 0/3 decisions log): the 2026-11-17 "Auction demand
// deterioration" firing (fired 20:46:47 UTC) was superseded by the
// recalibration note created 22:20:48 UTC the same day, and the trip-wire
// is disarmed as of the live v3 Phase 2 deploy. This is the exact artifact
// that was still inflating the header count before this fix.
const REAL_NOTE = {
  note: "Auction-demand trip-wire recalibrated 2026-11-17: now relative to its own history; prior armed state reflected a threshold mismatch, not new deterioration.",
  createdAt: "2026-11-17T22:20:48.033Z",
};
const REAL_FIRING = { tripWireKey: "auction_demand_deterioration", firedAt: "2026-11-17T20:46:47.408Z" };

describe("supersededByDate", () => {
  it("marks the real Nov 17 auction-demand firing as superseded (disarmed + note dated after)", () => {
    expect(supersededByDate(REAL_FIRING, [REAL_NOTE], false)).toBe("2026-11-17");
  });

  it("does NOT supersede if the trip-wire is still armed, even with a matching note", () => {
    expect(supersededByDate(REAL_FIRING, [REAL_NOTE], true)).toBeNull();
  });

  it("does NOT supersede if no note matches this trip-wire's key", () => {
    const firing = { tripWireKey: "stock_bond_corr_positive", firedAt: "2026-11-17T20:46:47.408Z" };
    expect(supersededByDate(firing, [REAL_NOTE], false)).toBeNull();
  });

  it("does NOT supersede if the matching note predates the firing", () => {
    const earlyNote = { ...REAL_NOTE, createdAt: "2026-11-16T00:00:00.000Z" };
    const laterFiring = { tripWireKey: "auction_demand_deterioration", firedAt: "2026-11-17T20:46:47.408Z" };
    expect(supersededByDate(laterFiring, [earlyNote], false)).toBeNull();
  });

  it("recognizes the exact live note-prefix convention already used by update-big-cycle-metrics", () => {
    expect(TRIP_WIRE_RECALIBRATION_NOTE_PREFIX.auction_demand_deterioration).toBe("Auction-demand trip-wire recalibrated");
  });
});

describe("filterSupersededFirings", () => {
  it("splits a mix of superseded and real firings, keeping armed/unmatched ones", () => {
    const firings = [
      REAL_FIRING, // superseded
      { tripWireKey: "stock_bond_corr_positive", firedAt: "2026-11-17T20:46:47.408Z" }, // kept: no note, still armed
    ];
    const { kept, superseded } = filterSupersededFirings(firings, [REAL_NOTE], {
      auction_demand_deterioration: false,
      stock_bond_corr_positive: true,
    });
    expect(kept).toEqual([{ tripWireKey: "stock_bond_corr_positive", firedAt: "2026-11-17T20:46:47.408Z" }]);
    expect(superseded).toEqual([{ ...REAL_FIRING, supersededBy: "2026-11-17" }]);
  });

  it("returns everything kept when there are no notes at all", () => {
    const firings = [REAL_FIRING];
    const { kept, superseded } = filterSupersededFirings(firings, [], { auction_demand_deterioration: false });
    expect(kept).toEqual(firings);
    expect(superseded).toEqual([]);
  });
});
