import { resolveSimulatorKey } from "./simulatorKeys";

// Bond Lens overlay — Phase D (per-portfolio application), docs/specs/bond-lens.md §6.
//
// v3 scope (2026-10-02, Phase E decision): ONLY `duration_multiplier` is
// applied to holdings. `instrument_pref`/`maturity_pref` are display-only
// (never backtested) -- this module never shifts weight BETWEEN the "nb"
// and "tip" simulator buckets (that would be the TIPS tilt), only WITHIN
// each bucket, among that bucket's own in-scope holdings, to move the
// bucket's own weighted duration. Each bucket's own total weight (its
// share of the whole portfolio) is left exactly as the strategic/current
// allocation has it -- "the sleeve is nb+tip combined; combined weight is
// fixed" (v2.1 decision #2) plus v3's added constraint that the SPLIT
// between the two buckets doesn't move either, since that split is now
// display-only.
//
// Deliberately built as a `sectorTargets` producer, not a parallel
// "apply to targets" pipeline: `lib/simulatorKeys.js`'s existing
// `computeAllocationDeltas(holdings, suggestedPcts, { sectorTargets })`
// already supports overriding a bucket's default pro-rata split with an
// explicit per-symbol override, falling back to pro-rata for any symbol
// not in the map -- exactly the mechanism every other call site already
// uses, and exactly what's needed here. This is also what makes the
// Phase D acceptance test ("Bond Lens off == identical to a build
// without it") close to free: `sectorTargets = {}` (or simply never
// calling into this module) is ALREADY `computeAllocationDeltas`'s own
// no-op default, not a new code path that has to be kept in sync.

const BOND_BUCKET_KEYS = new Set(["nb", "tip"]);

// §6.3 default eligible_instruments, used whenever a portfolio's own
// setting is null. Ordered by duration within each bucket purely for
// readability -- selection logic below doesn't depend on list order.
export const DEFAULT_ELIGIBLE_INSTRUMENTS = {
  nb: ["BIL", "SHY", "IEF", "TLT"],
  tip: ["VTIP", "SCHP"],
};

// bond_type values that are ALWAYS in scope regardless of include_credit
// (§6.1 v3: "In scope by default: Treasury, TIPS, bills, aggregate funds").
const ALWAYS_IN_SCOPE_TYPES = new Set(["treasury_nominal", "tips", "bills_cash_like", "aggregate"]);
// bond_type values gated on include_credit (v3 default false) -- agency
// MBS joins IG corporate/munis under the same gate (§6.1 v3 note: these
// three are grouped together, distinguished from always-excluded HY/EM).
const CREDIT_GATED_TYPES = new Set(["ig_corporate", "muni", "agency_mbs"]);
// Anything else (high_yield, em_debt, other) is always excluded -- not
// listed explicitly since "not always-in-scope and not credit-gated" is
// the correct fallback, and new bond_type values added later should be
// excluded-and-flagged by default rather than silently included.

// Splits `holdings` into in-scope bond-sleeve entries (each paired with
// its bond_instrument_meta row) and excluded entries (each with a
// reason), per §6.1's scope table. `bondInstrumentMetaByHoldingId` is a
// plain object keyed by `holding.id` (the caller's job to build from a
// `bond_instrument_meta` query -- this module takes no DB dependency).
//
// Holdings outside the nb/tip simulator buckets entirely are skipped
// silently (not "excluded" -- they were never bond-sleeve candidates in
// the first place, e.g. an equity ETF has no business in this report).
export function classifyBondSleeve(holdings, bondInstrumentMetaByHoldingId, includeCredit) {
  const inScope = [];
  const excluded = [];
  for (const h of holdings ?? []) {
    const key = resolveSimulatorKey(h);
    if (!BOND_BUCKET_KEYS.has(key)) continue;

    const meta = bondInstrumentMetaByHoldingId?.[h.id];
    if (!meta) { excluded.push({ holding: h, key, reason: "unclassified" }); continue; }
    if (!meta.is_bond || !meta.in_scope) {
      excluded.push({ holding: h, key, reason: meta.exclusion_reason ?? "out_of_scope" });
      continue;
    }
    if (CREDIT_GATED_TYPES.has(meta.bond_type) && !includeCredit) {
      excluded.push({ holding: h, key, reason: "credit_excluded_by_default" });
      continue;
    }
    if (!ALWAYS_IN_SCOPE_TYPES.has(meta.bond_type) && !CREDIT_GATED_TYPES.has(meta.bond_type)) {
      excluded.push({ holding: h, key, reason: meta.exclusion_reason ?? "excluded_bond_type" });
      continue;
    }
    if (meta.effective_duration == null) {
      excluded.push({ holding: h, key, reason: "missing_duration" });
      continue;
    }
    inScope.push({ holding: h, meta, key });
  }
  return { inScope, excluded };
}

// §6.1's sleeve statistics: weight, weighted effective duration, and mix
// (nominal/TIPS/bills/credit -- "aggregate" counted as nominal here since
// it has no single better bucket and isn't inflation-linked or credit).
export function sleeveStats(inScopeEntries) {
  let weight = 0, weightedDurSum = 0;
  const mix = { nominal: 0, tips: 0, bills: 0, credit: 0 };
  for (const { holding, meta } of inScopeEntries ?? []) {
    const val = Number(holding.current_value ?? 0);
    weight += val;
    if (meta.effective_duration != null) weightedDurSum += val * Number(meta.effective_duration);
    if (meta.bond_type === "tips") mix.tips += val;
    else if (meta.bond_type === "bills_cash_like") mix.bills += val;
    else if (CREDIT_GATED_TYPES.has(meta.bond_type)) mix.credit += val;
    else mix.nominal += val; // treasury_nominal, aggregate
  }
  return { weight, weightedDuration: weight > 0 ? weightedDurSum / weight : null, mix };
}

// Minimum-turnover reallocation within ONE bucket's own in-scope holdings
// to hit `targetDuration`, holding the bucket's total weight fixed.
// Provably turnover-minimal for a single linear equality constraint (the
// weighted-average duration) with an L1 objective: the optimum moves
// weight only between the two CURRENT extremes needed to close the gap
// (shortest-duration donor, longest-duration receiver when raising
// duration; reversed when lowering) -- the same "LP corner solution"
// shape as any one-constraint minimum-movement allocation problem, no
// general LP solver needed.
//
// Returns { weights: {symbol: newWeight}, reachable, gapNote }. If the
// bucket has only one in-scope holding, or the target is beyond what the
// bucket's own holdings can reach, `reachable: false` with a `gapNote`
// (§6.3's existing "target can't be reached" convention -- caller sets
// `target_reachable = false` and surfaces the note, same as any other
// unreachable-target case).
//
// `entries` may include synthetic substitute entries (`isSubstitute:
// true`, `holding.current_value: 0`) introduced by
// `solveDurationShiftWithSubstitutes` below -- those are kept in the
// solve as potential RECEIVERS even at zero starting weight (a real
// holding at zero value is still excluded, unchanged from before), but
// can never DONATE since the donor-capacity check (`donor.currentWeight
// <= 1e-9`) already skips any entry with nothing to give away --
// zero-weight by construction for a not-yet-held substitute, so this
// falls out of the existing logic with no special-casing needed.
export function solveDurationShiftWithinBucket(entries, targetDuration, { minTradeThreshold = 0 } = {}) {
  const items = (entries ?? [])
    .map((e) => ({ symbol: e.holding.symbol, currentWeight: Number(e.holding.current_value ?? 0), duration: Number(e.meta.effective_duration), isSubstitute: Boolean(e.isSubstitute) }))
    .filter((it) => (it.currentWeight > 0 || it.isSubstitute) && Number.isFinite(it.duration));

  const total = items.reduce((s, it) => s + it.currentWeight, 0);
  if (total <= 0 || items.length === 0 || targetDuration == null) {
    return { weights: Object.fromEntries(items.map((it) => [it.symbol, it.currentWeight])), reachable: true, gapNote: null };
  }

  const currentDurSum = items.reduce((s, it) => s + it.currentWeight * it.duration, 0);
  const currentDuration = currentDurSum / total;
  const targetDurSum = targetDuration * total;

  if (items.length === 1 || Math.abs(targetDurSum - currentDurSum) < 1e-9) {
    const reachable = items.length > 1 || Math.abs(targetDuration - currentDuration) < 1e-6;
    return {
      weights: Object.fromEntries(items.map((it) => [it.symbol, it.currentWeight])),
      reachable,
      gapNote: reachable ? null
        : `Only one in-scope holding (${items[0].symbol}) in this bucket -- can't shift duration without an eligible substitute instrument.`,
    };
  }

  const raising = targetDurSum > currentDurSum;
  const bySym = Object.fromEntries(items.map((it) => [it.symbol, { ...it }]));
  const donors = [...items].sort((a, b) => raising ? a.duration - b.duration : b.duration - a.duration);
  const receivers = [...items].sort((a, b) => raising ? b.duration - a.duration : a.duration - b.duration);

  let durSum = currentDurSum;
  let di = 0, ri = 0;
  while (di < donors.length && ri < receivers.length && Math.abs(durSum - targetDurSum) > 1e-9) {
    const donor = bySym[donors[di].symbol];
    const receiver = bySym[receivers[ri].symbol];
    if (donor.symbol === receiver.symbol || donor.currentWeight <= 1e-9) { di++; continue; }
    const durDiff = receiver.duration - donor.duration;
    if ((raising && durDiff <= 0) || (!raising && durDiff >= 0)) { ri++; if (ri >= receivers.length) { di++; ri = 0; } continue; }
    const neededShift = Math.abs((targetDurSum - durSum) / durDiff);
    const shift = Math.min(donor.currentWeight, neededShift);
    if (shift <= 1e-12) { di++; continue; }
    donor.currentWeight -= shift;
    receiver.currentWeight += shift;
    durSum += shift * durDiff; // durDiff's sign already matches the direction being closed (positive when raising, negative when lowering)
    if (donor.currentWeight <= 1e-9) di++;
  }

  const reachable = Math.abs(durSum - targetDurSum) <= 1e-6 * Math.max(1, total);
  const achievedDuration = durSum / total;
  const weights = Object.fromEntries(items.map((it) => [it.symbol, bySym[it.symbol].currentWeight]));

  const gapNote = reachable ? null
    : `Target duration ${targetDuration.toFixed(2)}y not fully reachable by reallocating only among this bucket's held instruments (reached ${achievedDuration.toFixed(2)}y) -- consider an eligible substitute instrument.`;

  if (minTradeThreshold > 0) {
    for (const it of items) {
      if (Math.abs(weights[it.symbol] - it.currentWeight) < minTradeThreshold * total) weights[it.symbol] = it.currentWeight;
    }
  }

  return { weights, reachable, gapNote };
}

// §6.3: "may assign weight to substitutes the portfolio doesn't hold...
// introduce a substitute only when held instruments can't reach the
// target, and then use the fewest new instruments possible." Turnover-
// minimizing preference for held instruments is just "try the held-only
// solve first" -- this function only reaches for a substitute at all
// when that first attempt is unreachable.
//
// "Fewest new instruments possible" is always AT MOST ONE for this
// problem shape: a single linear constraint (weighted-average duration)
// is maximally extended by whichever available instrument is most
// EXTREME in the needed direction (longest duration when raising beyond
// every held holding's own longest, shortest when lowering beyond every
// held holding's own shortest) -- no combination of two or more less-
// extreme substitutes could ever reach further than that one instrument
// already does on its own, so there's never a reason to introduce a
// second one.
//
// `eligibleMeta` is the list of bond_instrument_meta-shaped objects
// (`{symbol, effective_duration, ...}`) for this bucket's configured (or
// default) eligible_instruments -- the caller resolves the symbol list
// against actual meta rows (held or reference) before calling this.
export function solveDurationShiftWithSubstitutes(entries, targetDuration, eligibleMeta, { minTradeThreshold = 0 } = {}) {
  const first = solveDurationShiftWithinBucket(entries, targetDuration, { minTradeThreshold });
  if (first.reachable || targetDuration == null || (entries ?? []).length === 0) {
    return { ...first, substitutesUsed: [] };
  }

  // "Held" for substitute-eligibility purposes means POSITIVE weight,
  // not merely "a bond_instrument_meta/holdings row happens to exist for
  // this symbol" -- a real holding sitting at $0 (e.g. a position fully
  // sold down, or a bucket Scott zeroed out) contributes nothing to the
  // bucket's actual achievable duration range and must be just as
  // eligible to receive weight as a substitute would be. Found via the
  // dry run: a $0 SCHP row in one portfolio was silently blocking SCHP
  // from ever being proposed there, even though VTIP-alone's own range
  // needed exactly that substitute.
  const positivelyHeld = entries.filter((e) => Number(e.holding.current_value ?? 0) > 0);
  const heldSymbols = new Set(positivelyHeld.map((e) => e.holding.symbol));
  const heldDurations = positivelyHeld.map((e) => Number(e.meta.effective_duration)).filter(Number.isFinite);
  if (heldDurations.length === 0) return { ...first, substitutesUsed: [] };

  const total = positivelyHeld.reduce((s, e) => s + Number(e.holding.current_value ?? 0), 0);
  const currentDurSum = positivelyHeld.reduce((s, e) => s + Number(e.holding.current_value ?? 0) * Number(e.meta.effective_duration), 0);
  const currentDuration = total > 0 ? currentDurSum / total : null;
  if (currentDuration == null) return { ...first, substitutesUsed: [] };
  const raising = targetDuration > currentDuration;

  const maxHeld = Math.max(...heldDurations);
  const minHeld = Math.min(...heldDurations);

  const candidates = (eligibleMeta ?? [])
    .filter((m) => m?.symbol && !heldSymbols.has(m.symbol) && Number.isFinite(Number(m.effective_duration)))
    .filter((m) => raising ? Number(m.effective_duration) > maxHeld : Number(m.effective_duration) < minHeld);

  if (candidates.length === 0) return { ...first, substitutesUsed: [] };

  const best = candidates.reduce((a, b) => {
    const aDur = Number(a.effective_duration), bDur = Number(b.effective_duration);
    return raising ? (bDur > aDur ? b : a) : (bDur < aDur ? b : a);
  });

  const augmented = [...entries, { holding: { symbol: best.symbol, current_value: 0 }, meta: best, key: entries[0].key, isSubstitute: true }];
  const second = solveDurationShiftWithinBucket(augmented, targetDuration, { minTradeThreshold });
  const substituteGotWeight = Number(second.weights?.[best.symbol] ?? 0) > 1e-9;

  return { ...second, substitutesUsed: substituteGotWeight ? [best.symbol] : [] };
}

// Top-level entry point: builds a `sectorTargets` map (symbol -> % of its
// OWN bucket, the exact shape `computeAllocationDeltas` already expects)
// from the latest `bond_lens_signal` row and a portfolio's holdings.
//
// `settings.benchmark_duration`, if set, overrides "use each bucket's own
// current duration as its own benchmark" with a single sleeve-wide
// number (§6.1: "if the portfolio setting is null, use the sleeve's
// duration under the portfolio's strategic allocation"). Either way, the
// SAME ratio (target sleeve duration / current sleeve duration) is
// applied to every bucket's own current duration to get that bucket's
// own target -- this is what makes a Neutral stance (multiplier 1.0) a
// true no-op regardless of which benchmark source is used: "leaves the
// sleeve where it was designed to sit."
// `bondInstrumentMetaBySymbol` (new, optional): a plain object keyed by
// SYMBOL (not holding_id) covering every symbol in
// `settings.eligible_instruments` / `DEFAULT_ELIGIBLE_INSTRUMENTS` --
// both currently-held symbols (their own bond_instrument_meta row,
// looked up by symbol instead of holding_id) and reference-only
// substitute symbols (bond_instrument_meta rows with `holding_id: null`,
// `symbol` set instead -- §6.3 follow-up, 2026-10-XX). Omit it (or pass
// `{}`) to get the pre-substitute behavior back exactly -- an empty map
// means `solveDurationShiftWithSubstitutes` never finds a candidate,
// which is the same as calling `solveDurationShiftWithinBucket` directly.
export function computeBondLensSectorTargets(holdings, bondInstrumentMetaByHoldingId, signalRow, settings = {}, bondInstrumentMetaBySymbol = {}) {
  const includeCredit = settings.include_credit ?? false;
  const { inScope, excluded } = classifyBondSleeve(holdings, bondInstrumentMetaByHoldingId, includeCredit);
  const before = sleeveStats(inScope);

  if (!signalRow || inScope.length === 0) {
    return {
      sectorTargets: {}, excluded, sleeveBefore: before, sleeveAfter: before,
      targetReachable: true, gapNotes: [], stance: signalRow?.duration_stance ?? null, multiplier: 1,
      proposedNewHoldings: [],
    };
  }

  const multiplier = Number(signalRow.duration_multiplier ?? 1);
  const benchmark = settings.benchmark_duration != null ? Number(settings.benchmark_duration) : before.weightedDuration;
  const sleeveTarget = benchmark != null ? benchmark * multiplier : null;
  const ratio = sleeveTarget != null && before.weightedDuration > 0 ? sleeveTarget / before.weightedDuration : 1;

  const byBucket = {};
  for (const entry of inScope) (byBucket[entry.key] ??= []).push(entry);

  const sectorTargets = {};
  const gapNotes = [];
  let overallReachable = true;
  const afterEntries = [];
  const proposedNewHoldings = [];

  for (const [bucketKey, entries] of Object.entries(byBucket)) {
    const bucketTotal = entries.reduce((s, e) => s + Number(e.holding.current_value ?? 0), 0);
    const bucketCurrentDur = bucketTotal > 0
      ? entries.reduce((s, e) => s + Number(e.holding.current_value ?? 0) * Number(e.meta.effective_duration), 0) / bucketTotal
      : null;
    const bucketTarget = bucketCurrentDur != null ? bucketCurrentDur * ratio : null;

    const eligibleSymbols = settings.eligible_instruments?.[bucketKey] ?? DEFAULT_ELIGIBLE_INSTRUMENTS[bucketKey] ?? [];
    const eligibleMeta = eligibleSymbols.map((sym) => bondInstrumentMetaBySymbol[sym]).filter(Boolean);

    const { weights, reachable, gapNote, substitutesUsed } = solveDurationShiftWithSubstitutes(entries, bucketTarget, eligibleMeta, {
      minTradeThreshold: settings.min_trade_threshold ?? 0,
    });
    if (!reachable) { overallReachable = false; if (gapNote) gapNotes.push(gapNote); }

    for (const e of entries) {
      const w = weights[e.holding.symbol] ?? Number(e.holding.current_value ?? 0);
      sectorTargets[e.holding.symbol] = bucketTotal > 0 ? (w / bucketTotal) * 100 : 0;
      afterEntries.push({ holding: { ...e.holding, current_value: w }, meta: e.meta, key: e.key });
    }
    for (const subSymbol of substitutesUsed ?? []) {
      const w = Number(weights?.[subSymbol] ?? 0);
      if (w <= 1e-9) continue;
      const meta = bondInstrumentMetaBySymbol[subSymbol];
      sectorTargets[subSymbol] = bucketTotal > 0 ? (w / bucketTotal) * 100 : 0;
      proposedNewHoldings.push({ symbol: subSymbol, key: bucketKey, targetVal: w, meta });
      afterEntries.push({ holding: { symbol: subSymbol, current_value: w }, meta, key: bucketKey });
    }
  }

  return {
    sectorTargets, excluded,
    sleeveBefore: before, sleeveAfter: sleeveStats(afterEntries),
    targetReachable: overallReachable, gapNotes,
    stance: signalRow.duration_stance, multiplier,
    proposedNewHoldings,
  };
}
