// v3 Phase 3d (debt-metrics-integrity-v3 spec). A trip-wire firing
// notification is SUPERSEDED (not a real signal, an artifact of a since-
// fixed threshold) when all three hold:
//   1. a big_cycle_stage_notes recalibration note exists for that SAME
//      trip-wire key;
//   2. the note is dated ON OR AFTER the firing;
//   3. the trip-wire is disarmed NOW (not currently armed).
//
// Confirmed live (v3 Phase 0/3): the 2026-11-17 "Auction demand
// deterioration" firing (dedup_key ...:2024-08-08) fired under the OLD
// fixed-threshold trip-wire, literally hours before that same day's
// recalibration note -- exactly the artifact this filter exists to catch,
// and the one still inflating the "N FIRED IN LAST 7 DAYS" header.
//
// Note-to-key association is by TEXT PREFIX, matching the existing
// convention update-big-cycle-metrics/index.ts already uses for its own
// same-day notification suppression (`ilike("note", "Auction-demand
// trip-wire recalibrated%")`) -- not a new `trip_wire_key` column, so this
// stays consistent with the one note already in production rather than
// requiring a migration + backfill for a single row.
export const TRIP_WIRE_RECALIBRATION_NOTE_PREFIX: Record<string, string> = {
  auction_demand_deterioration: "Auction-demand trip-wire recalibrated",
};

export interface StageNoteLike {
  note: string;
  createdAt: string; // ISO timestamp
}

export interface FiringLike {
  tripWireKey: string;
  firedAt: string; // ISO timestamp
}

// Returns the superseding note's date (YYYY-MM-DD) if `firing` is
// superseded, else null. `currentlyArmed` must reflect the trip-wire's
// state as of the SAME audit run the caller is building the report
// against (not an independent query), so this can never disagree with
// what the UI/brief shows elsewhere for the same run.
export function supersededByDate(
  firing: FiringLike,
  notes: StageNoteLike[],
  currentlyArmed: boolean,
): string | null {
  if (currentlyArmed) return null; // still armed -- not superseded, a live signal
  const prefix = TRIP_WIRE_RECALIBRATION_NOTE_PREFIX[firing.tripWireKey];
  if (!prefix) return null; // no known recalibration-note convention for this key
  const match = notes.find(
    (n) => n.note.startsWith(prefix) && n.createdAt >= firing.firedAt,
  );
  return match ? match.createdAt.slice(0, 10) : null;
}

export interface FiringWithSupersession extends FiringLike {
  supersededBy: string | null; // the recalibration note's date, or null if this is a real (kept) firing
}

// Splits `firings` (already pre-filtered to the relevant trailing window,
// e.g. the last 7 days) into kept (real) and superseded, using the SAME
// per-firing test both `tripWiresFiredThisWeek` (brief input) and the "N
// FIRED IN LAST 7 DAYS" header must agree on -- one function, not two
// independently-written filters that could drift.
export function filterSupersededFirings(
  firings: FiringLike[],
  notes: StageNoteLike[],
  armedNow: Record<string, boolean>,
): { kept: FiringLike[]; superseded: FiringWithSupersession[] } {
  const kept: FiringLike[] = [];
  const superseded: FiringWithSupersession[] = [];
  for (const f of firings) {
    const supersededBy = supersededByDate(f, notes, Boolean(armedNow[f.tripWireKey]));
    if (supersededBy) {
      superseded.push({ ...f, supersededBy });
    } else {
      kept.push(f);
    }
  }
  return { kept, superseded };
}
