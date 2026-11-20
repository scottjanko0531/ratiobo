// Pure, Deno-API-free Indirect Bidder Share (10Y/30Y) computation — the ONE
// place this calculation lives, per debt-metrics-integrity.md v1 Phase 4a.
// Before this file existed, three call sites each computed their own
// version: the macro card did per-term trailing-6 averages then an
// equal-weighted mean (10Y and 30Y averaged separately, THEN combined);
// classifyDebtCycleStageV2's input and the auction-demand trip-wire both
// instead pooled the two terms' auctions into one interleaved list and
// averaged the most recent 6 of THAT, regardless of term. Those two methods
// read different numbers off the same table (confirmed live: 59.3% pooled
// vs. 57.55% per-term-then-mean, same day) — the per-term-then-mean method
// is kept here because it's the macro card's original, user-facing method,
// and because pooling a 30Y auction in with a 10Y auction into one average
// is not actually a well-defined "trailing 6" when the two terms auction on
// different, uneven schedules (confirmed live: 30Y auctions roughly
// quarterly, 10Y roughly every 6-10 weeks — a naive pooled-and-sorted top-6
// skews toward whichever term happened to auction more recently, not an
// equal blend of both).
//
// v2 Phase 1 adds: a full-history consolidated series (for the card's and
// classifier's z-scores) and a proper hysteresis state machine for the
// trip-wire (v1's fixed `< 65` per-round check never disarmed once the
// metric's typical range structurally rose past the mid-2010s — see
// docs/specs/debt-metrics-integrity-decisions.md's v2 Phase 0 distribution
// work). Thresholds themselves live in _shared/statusThresholds.ts
// (INDIRECT_BIDDER_THRESHOLDS) — this file only computes the numbers the
// thresholds get compared against.
//
// v3 Phase 1c (debt-metrics-integrity-v3 spec): switched from exact-matching
// security_term === "10-Year"/"30-Year" (which silently excluded every
// reopening -- confirmed live in v3 Phase 0 to be most 10Y/30Y auctions,
// not an edge case) to original_tenor IN ("10Y","30Y") + security_type IN
// ("Note","Bond").
//
// TIPS-contamination fix (Scott, 2026-11-20): that comment's claim --
// "tenor and nominal-vs-inflation-protected are two independently-checked
// conditions" -- was aspirational, not actually enforced. security_type
// "Note"/"Bond" does NOT exclude TIPS; TIPS share that exact security_type,
// just with a separate inflation-indexed characteristic. Confirmed live:
// 143 of 550 rows (26%) ever tagged original_tenor IN ("10Y","30Y") going
// back to 2010 are real TIPS auctions, across 51 distinct CUSIPs -- not a
// recent or edge-case problem. The real, reliable field now exists
// (inflation_indexed, backfilled from Fiscal Data's inflation_index_
// security / TreasuryDirect's inflationProtected) and is filtered here.
export interface AuctionRow {
  auction_date: string;
  security_term: string;
  original_tenor: string | null;
  security_type: string;
  indirect_share_pct: number | null;
  inflation_indexed: boolean;
}

export interface IndirectBidderSnapshot {
  value: number | null; // equal-weighted mean of avg10/avg30
  avg10: number | null;
  avg30: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const NOMINAL_TYPES = ["Note", "Bond"];

function cleanRows(rows: AuctionRow[]): AuctionRow[] {
  return rows.filter(
    (r) =>
      r.indirect_share_pct != null &&
      (r.original_tenor === "10Y" || r.original_tenor === "30Y") &&
      NOMINAL_TYPES.includes(r.security_type) &&
      !r.inflation_indexed
  );
}

// `offset` shifts the trailing-6 window back by `offset` auctions PER TERM
// (0 = current/most recent trailing-6, 1 = the trailing-6 as of one auction
// round earlier per term, ...). `rows` must be sorted descending by
// auction_date and should include enough history for the requested offset.
export function computeIndirectBidderSnapshot(rows: AuctionRow[], offset = 0): IndirectBidderSnapshot {
  const clean = cleanRows(rows);
  const windowOf = (tenor: string) => clean.filter((r) => r.original_tenor === tenor).slice(offset, offset + 6);
  const avgOfWindow = (w: AuctionRow[]) =>
    w.length ? w.reduce((s, r) => s + Number(r.indirect_share_pct), 0) / w.length : null;

  const w10 = windowOf("10Y");
  const w30 = windowOf("30Y");
  const avg10 = avgOfWindow(w10);
  const avg30 = avgOfWindow(w30);
  const parts = [avg10, avg30].filter((v): v is number => v != null);
  const value = parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;

  return {
    value: value != null ? round2(value) : null,
    avg10: avg10 != null ? round2(avg10) : null,
    avg30: avg30 != null ? round2(avg30) : null,
  };
}

export interface HistoricalSnapshot {
  offset: number;
  value: number;
  asofDate: string; // the most recent auction_date folded into this round (max across both terms' window[0])
}

// Every consolidated reading available in `rows`, oldest first — one entry
// per "auction round" (offset), stopping once an offset produces no value
// at all (both terms' windows empty). Used for both the full-history
// z-score (card/classifier) and the trailing-2-year hysteresis walk
// (trip-wire), so both read the exact same underlying series.
export function computeIndirectBidderFullSeries(rows: AuctionRow[]): HistoricalSnapshot[] {
  const clean = cleanRows(rows);
  const byTerm = (tenor: string) => clean.filter((r) => r.original_tenor === tenor);
  const ten = byTerm("10Y");
  const thirty = byTerm("30Y");
  const maxOffset = Math.max(ten.length, thirty.length) - 1;

  const out: HistoricalSnapshot[] = [];
  for (let offset = 0; offset <= maxOffset; offset++) {
    const snap = computeIndirectBidderSnapshot(rows, offset);
    if (snap.value == null) continue;
    const w10latest = ten.slice(offset, offset + 6)[0]?.auction_date;
    const w30latest = thirty.slice(offset, offset + 6)[0]?.auction_date;
    const asofDate = [w10latest, w30latest].filter((d): d is string => !!d).sort().reverse()[0];
    out.push({ offset, value: snap.value, asofDate });
  }
  return out.reverse(); // oldest first
}

// Population mean/stdev (same convention as _shared/paradigmScoring.ts's
// zScore — the window IS the population being compared against, not a
// sample of a larger one). Returns null stdev for a degenerate series.
export function meanAndStdev(values: number[]): { mean: number; stdev: number } {
  const n = values.length;
  const mean = n ? values.reduce((s, v) => s + v, 0) / n : 0;
  const variance = n ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / n : 0;
  return { mean, stdev: Math.sqrt(variance) };
}

export function zScoreOf(value: number, series: number[]): number | null {
  if (series.length < 2) return null;
  const { mean, stdev } = meanAndStdev(series);
  if (stdev === 0) return 0;
  return (value - mean) / stdev;
}

export interface TripWireResultShape {
  armed: boolean;
  sinceDate: string | null;
  values: Record<string, number | null>;
}

// TW2 "auction demand deterioration" — v2 Phase 1 rewrite. v1's version
// checked whether the last 6 CONSOLIDATED readings (an improvement over
// the original pooled-raw-auction check) were all below a fixed 65%
// threshold — but the consolidated reading has run ~55-58% for the entire
// trailing 2 years (see the v2 Phase 0 distribution), so that fixed
// threshold could never clear once met: a permanently-armed trip-wire,
// not a real early-warning signal.
//
// This version is relative, not fixed, and has a genuine disarm path
// (rule 7): it walks the FULL available history forward chronologically,
// tracking the hysteresis state exactly as it would have evolved in real
// time — arms when 3 consecutive rounds fall more than 1 std dev below the
// metric's own trailing-2-year mean, disarms when 2 consecutive rounds
// recover back above (mean - 0.5 sd). `sinceDate` (rule 9) is the date of
// the FIRST round in the streak that triggered the CURRENT state, not the
// oldest point in some fixed lookback window — fixing the exact bug Phase
// 0 found (sinceDate pinned to 2024-08-08, the edge of a 6-round window,
// regardless of when the condition actually started).
//
// The trailing-2-year mean/stdev is computed ONCE, anchored to the most
// recent reading (not recomputed at every historical point in the walk) —
// the same simplification every other trend test in this codebase already
// makes (isSustainedRising/isSustainedPositive don't recompute a rolling
// window per historical day either); recomputing a true rolling 2-year
// window at each of ~100 historical points would be a much larger
// investment for a threshold that's explicitly uncalibrated and starting-
// point-only anyway.
export function evalAuctionDemandDeterioration(
  rows: AuctionRow[],
  thresholds: { armSdMultiplier: number; armPersistRounds: number; disarmSdMultiplier: number; disarmPersistRounds: number },
  trailingYears = 2,
): TripWireResultShape {
  const series = computeIndirectBidderFullSeries(rows); // oldest first
  if (series.length === 0) {
    return { armed: false, sinceDate: null, values: { latest: null, mean2y: null, sd2y: null } };
  }

  const latest = series[series.length - 1];
  const cutoff = new Date(latest.asofDate + "T00:00:00Z");
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - trailingYears);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const window2y = series.filter((s) => s.asofDate >= cutoffStr).map((s) => s.value);

  if (window2y.length < 2) {
    return { armed: false, sinceDate: null, values: { latest: latest.value, mean2y: null, sd2y: null } };
  }
  const { mean: mean2y, stdev: sd2y } = meanAndStdev(window2y);
  const armThreshold = mean2y - thresholds.armSdMultiplier * sd2y;
  const disarmThreshold = mean2y - thresholds.disarmSdMultiplier * sd2y;

  let armed = false;
  let sinceDate: string | null = null;
  let belowStreak = 0;
  let belowStreakStart: string | null = null;
  let aboveStreak = 0;

  for (const snap of series) {
    if (snap.value < armThreshold) {
      belowStreak++;
      if (belowStreak === 1) belowStreakStart = snap.asofDate;
    } else {
      belowStreak = 0;
      belowStreakStart = null;
    }
    if (snap.value > disarmThreshold) {
      aboveStreak++;
    } else {
      aboveStreak = 0;
    }

    if (!armed && belowStreak >= thresholds.armPersistRounds) {
      armed = true;
      sinceDate = belowStreakStart;
    } else if (armed && aboveStreak >= thresholds.disarmPersistRounds) {
      armed = false;
      sinceDate = null;
    }
  }

  return {
    armed,
    sinceDate,
    values: {
      latest: latest.value,
      mean2y: round2(mean2y),
      sd2y: round2(sd2y),
      armThreshold: round2(armThreshold),
      disarmThreshold: round2(disarmThreshold),
      windowReadingCount: window2y.length,
    },
  };
}
