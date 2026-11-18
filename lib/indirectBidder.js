// Display-only mirror of supabase/functions/_shared/indirectBidder.ts's
// filtering + per-tenor trailing-window logic (a Deno edge function and this
// Next.js frontend can't literally share a module; same convention already
// used for lib/paradigmMetrics.js and lib/simulatorKeys.js). Kept in sync by
// hand -- if the shared module's tenor/nominal-type filter changes, mirror
// the change here too.
//
// v3 Phase 1c (debt-metrics-integrity-v3 spec): this replaces the
// IndirectBidderDrawer's own independent inline byTerm/avg6 computation,
// which exact-matched security_term === "10-Year"/"30-Year" and silently
// dropped every reopening -- the same bug the backend's indirectBidder.ts
// had before its v3 fix. Grouping is now by original_tenor ("10Y"/"30Y"),
// not the raw security_term label (which varies per reopening).

const NOMINAL_TYPES = ["Note", "Bond"];

// Matches _shared/indirectBidder.ts's cleanRows().
export function cleanAuctionRows(rows) {
  return rows.filter(
    (r) =>
      r.indirect_share_pct != null &&
      (r.original_tenor === "10Y" || r.original_tenor === "30Y") &&
      NOMINAL_TYPES.includes(r.security_type)
  );
}

// Trailing-N average of `field` for one tenor, one point per row of that
// tenor (ascending auction_date in, ascending auction_date out) -- the same
// per-term rolling-window shape _shared/indirectBidder.ts's windowOf()
// walks, just emitted as a full series instead of one offset at a time
// (the drawer's chart needs every point, not a single snapshot).
export function trailingAvgSeries(rows, tenor, field = "indirect_share_pct", windowSize = 6) {
  const clean = cleanAuctionRows(rows).filter((r) => r.original_tenor === tenor);
  return clean.map((r, i) => {
    const w = clean.slice(Math.max(0, i - (windowSize - 1)), i + 1);
    return {
      auction_date: r.auction_date,
      avg: w.reduce((s, x) => s + Number(x[field]), 0) / w.length,
    };
  });
}
