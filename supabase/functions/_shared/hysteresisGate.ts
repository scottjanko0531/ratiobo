// Generic, pure hysteresis gate (debt-metrics-integrity-v2 spec, Phase 3a).
// Arms when a series has run above `on` for `persistMonths` consecutive
// distinct readings; disarms when it's run below `off` for the same count;
// otherwise holds its prior state (a reading in the dead band between `off`
// and `on` moves neither streak and so can't flip the gate either way).
//
// "Distinct readings" = dedupeConsecutive(series), reused from
// debtCycleClassifier.ts rather than reinvented here, per the spec's own
// instruction -- this collapses repeated daily snapshot values (the MTS
// cadence means the same monthly figure gets snapshotted every day until
// the next month's release) down to one entry per actual change, which for
// a monthly-cadence series is one entry per month.
//
// Insufficient-history bootstrap (v2 Phase 3 investigation, logged in
// docs/specs/debt-metrics-integrity-decisions.md): a brand-new series (or
// one that just switched basis/definition, like net-interest/receipts' MTS
// cutover) may have fewer than `persistMonths` distinct readings at all --
// not even enough to evaluate persistence once, in either direction. There
// is no real prior state to "hold" in that case (the gate has never been
// evaluated), so rather than silently defaulting to off (which could hide a
// genuinely strained reading behind a false "not enough data yet, so no")
// or arming on a single noisy print, this returns `insufficientHistory:
// true` and falls back to comparing the single latest reading against the
// STRICTER `on` bound only (never the looser `off` bound) -- the same bar a
// confirmed read would need to clear, just without the persistence
// requirement yet. Callers must surface `insufficientHistory` distinctly
// from a confirmed read, not silently treat it as equivalent.

import { WeeklyPoint, dedupeConsecutive } from "./debtCycleClassifier.ts";

export interface HysteresisGateResult {
  armed: boolean;
  insufficientHistory: boolean;
  monthsAvailable: number;
  latest: number | null;
}

export function hysteresisGate(
  series: WeeklyPoint[], // most-recent-first; any sampling granularity
  opts: { on: number; off: number; persistMonths: number },
): HysteresisGateResult {
  const distinct = dedupeConsecutive(series); // most-recent-first, one entry per run
  if (distinct.length === 0) {
    return { armed: false, insufficientHistory: true, monthsAvailable: 0, latest: null };
  }
  const latest = distinct[0].value;

  if (distinct.length < opts.persistMonths) {
    return { armed: latest > opts.on, insufficientHistory: true, monthsAvailable: distinct.length, latest };
  }

  const oldestFirst = [...distinct].reverse();
  let armed = false;
  let aboveStreak = 0;
  let belowStreak = 0;
  for (const p of oldestFirst) {
    aboveStreak = p.value > opts.on ? aboveStreak + 1 : 0;
    belowStreak = p.value < opts.off ? belowStreak + 1 : 0;
    if (!armed && aboveStreak >= opts.persistMonths) armed = true;
    else if (armed && belowStreak >= opts.persistMonths) armed = false;
  }
  return { armed, insufficientHistory: false, monthsAvailable: distinct.length, latest };
}
