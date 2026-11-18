// v3 Phase 1b (debt-metrics-integrity-v3 spec): one shared mapping from a
// Treasury auction's `security_term` string to its ORIGINAL maturity tenor
// (e.g. "9-Year 10-Month" -- a reopening of a 10-Year note, auctioned with
// ~9 years 10 months of remaining life -- maps to "10Y", the tenor it was
// ORIGINALLY issued at, not its remaining maturity).
//
// Derived from the real data (v2 Phase 0 investigation,
// docs/specs/debt-metrics-integrity-decisions.md's v3 section), not just
// the two illustrative labels ("9-Year 10-Month", "9-Year 11-Month") the
// spec's own problem table used as examples. Treasury's actual reopening
// calendar has used DIFFERENT month-offsets in different eras -- confirmed
// live: the 10Y family alone uses 8/9/10/11-month reopenings depending on
// when in 2010-2026 the auction happened, and 30Y uses 4/6/8/10/11. A
// hardcoded list of "the labels seen so far" would silently misclassify
// (or worse, silently NOT classify) a reopening auctioned under a
// month-offset that simply hasn't shown up yet. The general rule instead:
//
//   "N-Year"              (a new issue)              -> tenor NY
//   "(N-1)-Year X-Month"  (a reopening, 1 <= X <= 11) -> tenor NY
//
// Confirmed this generalizes correctly to every tenor family in the live
// table, not just 10Y/30Y -- e.g. "1-Year 10-Month" -> 2Y (a 2-Year
// reopening), "4-Year 8-Month" -> 5Y (a 5-Year reopening), "19-Year
// 11-Month" -> 20Y (20Y family, reference only, out of scope for this
// phase's consumers).
//
// Deliberately does NOT look at `security_type` here -- "TIPS/FRN handled
// via security_type, kept separate from nominal" (the spec's own
// instruction) means tenor mapping and nominal-vs-inflation-protected are
// two SEPARATE, independently-checked conditions at the CONSUMER level
// (`original_tenor IN (...) AND security_type IN ('Note','Bond')`), not
// one fused into this function. A TIPS note auctioned under a "10-Year"
// term string genuinely does have original tenor 10Y; it's the caller's
// job to also require security_type = 'Note'/'Bond' when nominal-only
// matters (confirmed live, 2026-11-18: this repo's ingested data has no
// TIPS/FRN rows at all right now -- only Bill/Note/Bond -- but the
// function is written to be correct if that ever changes, not just
// correct for today's data).
//
// Bills (13-Week, 4-Week, 150-Day, ...) and CMBs never match either
// pattern -- they fall through to `null` by construction, never a wrong
// guess. Same for any genuinely unrecognized term string.

export function mapSecurityTermToTenor(securityTerm: string): string | null {
  const newIssue = securityTerm.match(/^(\d+)-Year$/);
  if (newIssue) return `${newIssue[1]}Y`;

  const reopening = securityTerm.match(/^(\d+)-Year (\d{1,2})-Month$/);
  if (reopening) {
    const baseYears = parseInt(reopening[1], 10);
    const months = parseInt(reopening[2], 10);
    if (months >= 1 && months <= 11) return `${baseYears + 1}Y`;
  }

  return null;
}
