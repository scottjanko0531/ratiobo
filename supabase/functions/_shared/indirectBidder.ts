// Pure, Deno-API-free Indirect Bidder Share (10Y/30Y) computation — the ONE
// place this calculation lives, per debt-metrics-integrity.md Phase 4a.
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

export interface AuctionRow {
  auction_date: string;
  security_term: string;
  indirect_share_pct: number | null;
}

export interface IndirectBidderSnapshot {
  value: number | null; // equal-weighted mean of avg10/avg30
  avg10: number | null;
  avg30: number | null;
  windowOldestDate: string | null; // oldest auction_date folded into this snapshot's trailing-6 windows
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cleanRows(rows: AuctionRow[]): AuctionRow[] {
  return rows.filter(
    (r) => r.indirect_share_pct != null && (r.security_term === "10-Year" || r.security_term === "30-Year")
  );
}

// `offset` shifts the trailing-6 window back by `offset` auctions PER TERM
// (0 = current/most recent trailing-6, 1 = the trailing-6 as of one auction
// round earlier per term, ...). `rows` must be sorted descending by
// auction_date and should include enough history for the requested offset
// (the card and classifier only ever need offset 0-1; the trip-wire needs
// up to `n`).
export function computeIndirectBidderSnapshot(rows: AuctionRow[], offset = 0): IndirectBidderSnapshot {
  const clean = cleanRows(rows);
  const windowOf = (term: string) => clean.filter((r) => r.security_term === term).slice(offset, offset + 6);
  const avgOfWindow = (w: AuctionRow[]) =>
    w.length ? w.reduce((s, r) => s + Number(r.indirect_share_pct), 0) / w.length : null;

  const w10 = windowOf("10-Year");
  const w30 = windowOf("30-Year");
  const avg10 = avgOfWindow(w10);
  const avg30 = avgOfWindow(w30);
  const parts = [avg10, avg30].filter((v): v is number => v != null);
  const value = parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;

  const oldestDates = [w10[w10.length - 1]?.auction_date, w30[w30.length - 1]?.auction_date].filter(
    (d): d is string => !!d
  );
  const windowOldestDate = oldestDates.length ? oldestDates.sort()[0] : null;

  return {
    value: value != null ? round2(value) : null,
    avg10: avg10 != null ? round2(avg10) : null,
    avg30: avg30 != null ? round2(avg30) : null,
    windowOldestDate,
  };
}

export interface TripWireResultShape {
  armed: boolean;
  sinceDate: string | null;
  values: Record<string, number | null>;
}

// TW2 "auction demand deterioration" — now built directly on the
// consolidated snapshot above: armed only if the LAST `n` consolidated
// readings (not raw pooled auctions) are all below 65%, a persistent
// failure to recover rather than one weak print. `n` auction *rounds*
// back, each round being its own per-term-trailing-6-then-mean snapshot —
// same persistence semantics as before, now computed on the consistent
// number instead of the pooled/interleaved one.
export function evalAuctionDemandDeterioration(rows: AuctionRow[], n = 6): TripWireResultShape {
  const snapshots = Array.from({ length: n }, (_, i) => computeIndirectBidderSnapshot(rows, i));
  const complete = snapshots.filter((s) => s.value != null);
  if (!complete.length) return { armed: false, sinceDate: null, values: { trailingAvg: null, latest: null } };
  const armed = complete.length === n && complete.every((s) => s.value! < 65);
  const trailingAvg = round2(complete.reduce((s, sn) => s + sn.value!, 0) / complete.length);
  const sinceDate = armed ? snapshots[n - 1].windowOldestDate : null;
  return { armed, sinceDate, values: { trailingAvg, latest: snapshots[0].value } };
}
