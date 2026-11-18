// v3 Phase 3c (debt-metrics-integrity-v3 spec). Deterministic, pure,
// regex-based fact-check rules -- a backstop BEHIND the prompt's own "do
// not reference holdings / do not issue rebalancing instructions" rule
// (generate-debt-cycle-brief's prompt), not the primary defense. Kept
// separate from validateConsistency()'s LLM-based contradiction check
// (generate-debt-cycle-brief/index.ts) specifically so these four rules
// are unit-testable without a network call -- an LLM's judgment can't be
// asserted on in CI the way a regex match can.
//
// Each check returns an array of issue strings (empty = clean). All four
// combine with the LLM check's own issues into one correction list; see
// the Phase 3 decisions log for the "regenerate once, then banner" flow
// this feeds.

const HOLDINGS_PATTERNS: RegExp[] = [
  /\byour\s+(portfolio|holdings?|balance|allocation)s?\b/i,
  /\bmy\s+(portfolio|holdings?|balance|allocation)s?\b/i,
  /\$[\d][\d,]*(\.\d+)?\s*(k|m|mm|b)?\b/i, // any dollar figure -- a macro brief has no legitimate reason to cite one
];

export function checkHoldingsReference(narrative: string): string[] {
  const issues: string[] = [];
  for (const re of HOLDINGS_PATTERNS) {
    const m = narrative.match(re);
    if (m) issues.push(`References the user's holdings/balance/allocation: "${m[0]}"`);
  }
  return issues;
}

const REBALANCE_VERB = /\b(buy|sell|reduce|increase|redeploy|rebalance|re-?allocate|trim|add to|cut|move (?:some|your)?\s*(?:money|funds|capital|position)|shift (?:into|out of))\b/i;
const CONCRETE_MOVES_HEADER = /\bconcrete moves\b/i;

export function checkRebalanceInstruction(narrative: string): string[] {
  const issues: string[] = [];
  if (CONCRETE_MOVES_HEADER.test(narrative)) {
    issues.push('Contains a "Concrete moves" section -- removed from the prompt in v3 Phase 3a, should never appear');
  }
  const m = narrative.match(REBALANCE_VERB);
  if (m) issues.push(`Contains a buy/sell/rebalance instruction: "${m[0]}"`);
  return issues;
}

// `supersededLabels` = the human-readable labels (e.g. "Auction demand
// deterioration") of trip-wires whose most recent 7-day firing has been
// identified as superseded by a recalibration note (see
// _shared/tripWireSupersession.ts). Flags the exact self-contradiction
// v3 Phase 0 caught verbatim: the brief citing its own recalibration note
// while still describing that trip-wire as having fired/deteriorated.
export function checkSupersededFiringClaim(narrative: string, supersededLabels: string[]): string[] {
  const issues: string[] = [];
  // Scoped to the SENTENCE the label appears in -- a document-wide check
  // for "fired" false-positives on the entirely legitimate, correct
  // sentence "no trip-wires... fired this week" (reporting an empty
  // list), which has nothing to do with any specific superseded wire.
  const sentences = narrative.split(/(?<=[.!?])\s+/);
  for (const label of supersededLabels) {
    const labelLower = label.toLowerCase();
    const hit = sentences.find((s) => {
      const sLower = s.toLowerCase();
      if (!sLower.includes(labelLower)) return false;
      // Strip the label's own text first -- it contains "deterioration"
      // by name (e.g. "Auction demand deterioration"), so just naming
      // the wire would otherwise always match.
      const withoutLabel = sLower.replace(labelLower, " ");
      return /\b(fired|deteriorat\w*)\b/i.test(withoutLabel);
    });
    if (hit) {
      issues.push(`Describes "${label}" as fired/deteriorating, but this firing is superseded by a recalibration note`);
    }
  }
  return issues;
}

// "This week" (or "this week's", "recent auction", "latest auction")
// language about a 10Y/30Y auction is only true if the newest auction the
// feed actually has (`dataAsOf`) falls within the trailing `maxDays`
// (default 7) of `now`. v3 Phase 1 found the Fiscal Data feed itself is
// currently 41+ days stale -- so right now this rule WILL fire on almost
// any "this week" auction claim, correctly; it is not a false positive,
// it is exactly the stale-claim the spec asks this rule to catch. A null
// `dataAsOf` (no auction data at all) is treated the same as stale --
// never passes.
const THIS_WEEK_AUCTION = /\b(this week|recent(?:ly)?|latest|just (?:happened|occurred))\b[^.]{0,80}\bauction\b|\bauction\b[^.]{0,80}\b(this week|recent(?:ly)?|latest|just (?:happened|occurred))\b/i;

export function checkStaleThisWeekClaim(
  narrative: string,
  dataAsOf: string | null,
  now: Date,
  maxDays = 7,
): string[] {
  const m = narrative.match(THIS_WEEK_AUCTION);
  if (!m) return [];
  if (dataAsOf == null) {
    return [`Claims a recent/this-week auction ("${m[0]}") but no auction data_as_of is available at all`];
  }
  const ageDays = Math.floor((now.getTime() - new Date(dataAsOf + "T00:00:00Z").getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays > maxDays) {
    return [`Claims a recent/this-week auction ("${m[0]}") but the newest 10Y/30Y auction on file is ${dataAsOf}, ${ageDays} days old (feed data_as_of)`];
  }
  return [];
}

export interface FactCheckContext {
  supersededLabels: string[];
  auctionDataAsOf: string | null;
  now: Date;
}

export function runDeterministicFactChecks(narrative: string, ctx: FactCheckContext): string[] {
  return [
    ...checkHoldingsReference(narrative),
    ...checkRebalanceInstruction(narrative),
    ...checkSupersededFiringClaim(narrative, ctx.supersededLabels),
    ...checkStaleThisWeekClaim(narrative, ctx.auctionDataAsOf, ctx.now),
  ];
}
