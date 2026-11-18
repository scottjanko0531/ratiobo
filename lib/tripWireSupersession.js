// Display-only mirror of
// supabase/functions/_shared/tripWireSupersession.ts (a Deno edge function
// and this Next.js frontend can't literally share a module; same
// convention already used for lib/indirectBidder.js and
// lib/paradigmMetrics.js). Kept in sync by hand.
//
// v3 Phase 3d (debt-metrics-integrity-v3 spec): both the brief's
// tripWiresFiredThisWeek input and this component's own "N FIRED IN LAST
// 7 DAYS" header must apply the identical supersession test, or the two
// could disagree about the Nov 17 artifact the way the header alone used
// to (the brief already excluded nothing; the header counted everything).

export const TRIP_WIRE_RECALIBRATION_NOTE_PREFIX = {
  auction_demand_deterioration: "Auction-demand trip-wire recalibrated",
};

// Returns the superseding note's date (YYYY-MM-DD) if `firing` is
// superseded, else null.
export function supersededByDate(firing, notes, currentlyArmed) {
  if (currentlyArmed) return null;
  const prefix = TRIP_WIRE_RECALIBRATION_NOTE_PREFIX[firing.tripWireKey];
  if (!prefix) return null;
  const match = notes.find((n) => n.note.startsWith(prefix) && n.createdAt >= firing.firedAt);
  return match ? match.createdAt.slice(0, 10) : null;
}

export function filterSupersededFirings(firings, notes, armedNow) {
  const kept = [];
  const superseded = [];
  for (const f of firings) {
    const supersededBy = supersededByDate(f, notes, Boolean(armedNow[f.tripWireKey]));
    if (supersededBy) superseded.push({ ...f, supersededBy });
    else kept.push(f);
  }
  return { kept, superseded };
}
