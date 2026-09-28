// Market Conditions Overlay — composite, tiers, hysteresis, vetoes (build
// spec Section 7). Pure, Deno-API-free. Orchestrates trend.ts + stress.ts
// (breadth/sentiment/macro are wired in once Phase 2/4 exist — absent
// pillars here just fall out of the redistribution step, not a special
// Phase-1 code path).
//
// Idempotency (spec Section 9.1 / "no persisted state to resume from"):
// this always recomputes the FULL history from the first day any pillar
// becomes available through the last input date, carrying hysteresis state
// forward in-memory rather than reading yesterday's stored row from the DB.
// Same "derived table, full rebuild avoids incremental bugs" choice already
// used elsewhere in this repo (ingest-liquidity-data). At ~6-7k trading
// days this is a cheap in-memory loop, not a real cost.
//
// One interpretation call the spec doesn't fully disambiguate, documented
// here rather than guessed silently: the hysteresis state machine's
// `tierIndex` carried into tomorrow is the FINAL tier (after the trend cap
// and stress veto are applied), not the pre-cap hysteresis-only tier. A
// trend-DOWN cap or a stress veto is treated as real state, not a display
// filter — so when trend flips back to UP or a veto clears, the tier has to
// re-climb through hysteresis like any other upgrade rather than snapping
// straight back to wherever the uncapped tier had drifted. This matches the
// system's stated design goal (reduce drawdowns, avoid whipsaws) better
// than the alternative.
//
// mc-1.2.0: trend-state transitions now go through indicators/trend.ts's
// resolveTrendState (DOWN -> MIXED via a 3-day above-band streak,
// regardless of slope — see that file's header for the diagnosis).
//
// mc-1.3.0:
//   1. 200-day floor: once close has closed above the band for 3
//      consecutive days AND veto is inactive, tier cannot be worse than
//      NORMAL. Applied after hysteresis + trend cap, before the veto's own
//      cap (per explicit instruction) — computed using `inp.aboveBandStreak`
//      (already threaded through for the trend-state machine) so no new
//      raw input is needed for the streak itself.
//   2. Recovery fast-path becomes a LATCH: `fastPathLatched` in
//      HysteresisState persists across days once `fastPathTriggerNow`
//      fires, until tier reaches NORMAL (checked against THIS day's own
//      outcome — not one day late) or `fastPathInvalidated`. The trigger
//      and invalidation conditions themselves are computed by the caller
//      (computeMarketConditionsHistory) from raw trend/stress data, since
//      they need access to both trendRaw.sma50 and stressRaw's VIX/BAA10Y
//      series — stepTierState only manages the persistent latch STATE.
//
// mc-1.4.0: the entry-signal call below now passes O1/O2 (RSI14/stretch,
// indicators/oscillators.ts) instead of vetoActive -- E-VETO was removed
// from entrySignal.ts (failed its own pre-registered validation, see
// DECISIONS.md); the TIER veto below (finalTierIndex capped at DEFENSIVE
// when vetoActive) is a separate mechanism, unaffected. cfg.veto.disabled
// (default false) is a diagnostic-only ablation hook, not a real feature —
// see stepTierState.

import { PillarName, TrendState, HysteresisState, DayScoreRow, TierName } from "./types.ts";
import { MC_CONFIG, TIER_ORDER, NORMAL_IDX, CAUTIOUS_IDX, DEFENSIVE_IDX, tierForComposite } from "./config.ts";
import { clip } from "./normalize.ts";
import { computeTrendRawSeries, scoreTrendAtIndex, resolveTrendState } from "./indicators/trend.ts";
import { computeStressRawSeries, scoreStressAtIndex, vetoConditionsAtIndex } from "./indicators/stress.ts";
import { computeOscillatorRawSeries } from "./indicators/oscillators.ts";
import { evaluateEntrySignal } from "./entrySignal.ts";

export interface ComputeInputs {
  dates: string[]; // SPY trading-day calendar, ascending, drives everything else
  closes: number[]; // SPY close
  vix: (number | null)[]; // VIXCLS, aligned to `dates`
  vix3m: (number | null)[]; // ^VIX3M, aligned to `dates`
  creditSpread: (number | null)[]; // BAA10Y (mc-1.1.0+; was BAMLH0A0HYM2), aligned to `dates`
  // mc-1.4.0 breadth round: OPTIONAL, aligned to `dates`. Omitted by
  // market-conditions-compute (the live/production caller) -- production
  // scoring stays trend+stress only, unaffected by this round, per
  // DECISIONS.md's "scored vs display" decision (breadth isn't validated
  // on unbiased history yet). Only backtest-only callers (the with/
  // without-breadth comparison) pass this, using indicators/breadth.ts's
  // proxy pillar. When present, "breadth" becomes a third pillar in the
  // redistribution below exactly like trend/stress -- no special-casing
  // needed since the redistribution already only counts non-null scores.
  breadthScore?: (number | null)[];
}

const initialState = (): HysteresisState => ({
  tierIndex: TIER_ORDER.indexOf("NORMAL"), // neutral starting point before any real composite exists
  upStreak: 0, downStreak: 0,
  trendState: "MIXED",
  aboveBandStreak: 0,
  fastPathLatched: false,
  vetoActive: false, vetoTermStructureStreak: 0, vetoClearStreak: 0,
});

export interface TierStepInput {
  composite: number;
  trendState: TrendState; // already resolved (resolveTrendState) by the caller
  aboveBandStreak: number; // already resolved by the caller -- drives both trend-state stickiness AND the mc-1.3.0 200-day floor
  termStructureTriggered: boolean;
  creditWideningTriggered: boolean;
  fastPathTriggerNow: boolean; // mc-1.3.0: raw "would trigger fresh today" (3-part AND, or pre-2006 fallback) — see computeMarketConditionsHistory
  fastPathInvalidated: boolean; // mc-1.3.0: raw "close < SMA50 OR VIX/VIX3M > vixTermStructureInvalidate" (pre-2006: SMA50 leg only)
}

export interface TierStepResult {
  rawTierIndex: number;
  finalTierIndex: number;
  fastPathActiveToday: boolean; // whether the latch (or a fresh trigger) was active FOR today's tier computation -- distinct from nextState.fastPathLatched, which reflects tomorrow's baseline (false on the very day the latch exits via success)
  floorActiveToday: boolean;
  nextState: HysteresisState;
}

// The hysteresis/trend-cap/floor/stress-veto/fast-path-latch state machine
// (spec Section 7.3 + mc-1.3.0's additions), factored out of
// computeMarketConditionsHistory's loop so it's directly testable against
// synthetic composite sequences (spec Section 12's own phrasing) without
// needing 756+ days of realistic price/series data to drive it through
// computeTrendRawSeries/computeStressRawSeries first.
export function stepTierState(inp: TierStepInput, prior: HysteresisState, cfg = MC_CONFIG): TierStepResult {
  const rawTierIndex = tierForComposite(inp.composite, cfg.tiers);

  // mc-1.3.0: the fast-path is a LATCH — once triggered it stays active
  // (driving both the shortened upgrade window and the trend-cap
  // suspension below) regardless of whether today's raw trigger conditions
  // still hold, until stepTierState's own exit checks (below, after tier
  // is known) turn it off for TOMORROW.
  const fastPathActive = prior.fastPathLatched || inp.fastPathTriggerNow;

  let tierIndex = prior.tierIndex;
  let upStreak = prior.upStreak;
  let downStreak = prior.downStreak;
  let upgraded = false, downgraded = false;

  const upgradeDaysNeeded = fastPathActive ? cfg.recovery.fastPathUpgradeDays : cfg.hysteresis.upgradeDays;

  if (tierIndex > 0) {
    const nextUpMin = cfg.tiers[tierIndex - 1].min;
    upStreak = inp.composite > nextUpMin + cfg.hysteresis.upgradeMargin ? upStreak + 1 : 0;
    if (upStreak >= upgradeDaysNeeded) { tierIndex -= 1; upgraded = true; }
  } else {
    upStreak = 0;
  }

  if (!upgraded && tierIndex < cfg.tiers.length - 1) {
    const ownMin = cfg.tiers[tierIndex].min;
    downStreak = inp.composite < ownMin - cfg.hysteresis.downgradeMargin ? downStreak + 1 : 0;
    if (downStreak >= cfg.hysteresis.downgradeDays) { tierIndex += 1; downgraded = true; }
  } else if (tierIndex === cfg.tiers.length - 1) {
    downStreak = 0;
  }

  if (upgraded || downgraded) { upStreak = 0; downStreak = 0; }

  // Trend cap (spec 7.3 #3): DOWN trend caps tier at CAUTIOUS or worse --
  // suspended when the fast-path is active (a no-op unless trend_state is
  // actually DOWN).
  let finalTierIndex = tierIndex;
  if (inp.trendState === "DOWN" && !fastPathActive) finalTierIndex = Math.max(finalTierIndex, CAUTIOUS_IDX);

  // Veto state computed here (before the floor) since the mc-1.3.0 floor's
  // OWN condition requires knowing whether veto is active today, even
  // though the veto's tier-capping EFFECT is applied after the floor (per
  // explicit instruction: floor "after hysteresis, before the veto").
  //
  // mc-1.4.0 ablation hook: cfg.veto.disabled (default false, so this
  // branch is dead in every existing call site) forces the entire veto
  // mechanism inert -- streaks pinned at 0, vetoActive always false --
  // rather than just skipping its tier-cap effect below, so the floor's
  // own `!vetoActive` gate and downstream state are equally unaffected,
  // a clean "what if this mechanism never existed" ablation.
  const vetoDisabled = cfg.veto.disabled === true;
  const vetoTermStructureStreak = vetoDisabled ? 0 : (inp.termStructureTriggered ? prior.vetoTermStructureStreak + 1 : 0);
  const vetoClearStreak = vetoDisabled ? 0 : ((!inp.termStructureTriggered && !inp.creditWideningTriggered) ? prior.vetoClearStreak + 1 : 0);
  let vetoActive = vetoDisabled ? false : prior.vetoActive;
  if (!vetoDisabled) {
    if (!vetoActive) {
      if (vetoTermStructureStreak >= cfg.veto.termStructureDays || inp.creditWideningTriggered) vetoActive = true;
    } else {
      if (vetoClearStreak >= cfg.veto.clearDays) vetoActive = false;
    }
  }

  // mc-1.3.0 200-day floor: 3+ consecutive days above the band AND veto
  // inactive -> tier cannot be worse than NORMAL. Independent of
  // hysteresis's day-count (this is a floor, not an upgrade path).
  const floorIdx = TIER_ORDER.indexOf(cfg.recovery.tierFloor);
  const floorActiveToday = inp.aboveBandStreak >= 3 && !vetoActive;
  if (floorActiveToday) finalTierIndex = Math.min(finalTierIndex, floorIdx);

  // Veto's own cap, applied last.
  if (vetoActive) finalTierIndex = Math.max(finalTierIndex, DEFENSIVE_IDX);

  // Fast-path latch exit, decided from TODAY's own outcome (not one day
  // late): success if tier actually reached NORMAL-or-better today;
  // otherwise invalidated if the raw invalidation condition fired today;
  // otherwise the latch (or fresh trigger) carries into tomorrow.
  let fastPathLatchedNext = fastPathActive;
  if (finalTierIndex <= NORMAL_IDX) fastPathLatchedNext = false;
  else if (inp.fastPathInvalidated) fastPathLatchedNext = false;

  return {
    rawTierIndex,
    finalTierIndex,
    fastPathActiveToday: fastPathActive,
    floorActiveToday,
    // Persists the FINAL (capped) tier as next day's baseline -- see file
    // header for why.
    nextState: {
      tierIndex: finalTierIndex,
      upStreak, downStreak,
      trendState: inp.trendState,
      aboveBandStreak: inp.aboveBandStreak,
      fastPathLatched: fastPathLatchedNext,
      vetoActive, vetoTermStructureStreak, vetoClearStreak,
    },
  };
}

export function computeMarketConditionsHistory(inp: ComputeInputs, cfg = MC_CONFIG): DayScoreRow[] {
  const n = inp.dates.length;
  const trendRaw = computeTrendRawSeries(inp.closes, inp.dates, cfg);
  const stressRaw = computeStressRawSeries(inp.closes, inp.vix, inp.vix3m, inp.creditSpread);
  const oscRaw = computeOscillatorRawSeries(inp.closes);

  const rows: DayScoreRow[] = [];
  let state = initialState();

  for (let t = 0; t < n; t++) {
    const trendResult = scoreTrendAtIndex(trendRaw, t, inp.closes, cfg);
    const stressResult = scoreStressAtIndex(stressRaw, t, cfg);

    const pillars: { name: PillarName; score: number | null }[] = [
      { name: "trend", score: trendResult.pillarScore },
      { name: "stress", score: stressResult.pillarScore },
      { name: "breadth", score: inp.breadthScore ? (inp.breadthScore[t] ?? null) : null },
    ];
    const available = pillars.filter((p) => p.score != null);
    if (available.length === 0) continue; // nothing computable yet -- no row, no state advance

    // mc-1.2.0 trend-state transition (see file header + trend.ts).
    const { state: trendStateFinal, aboveBandStreak } = resolveTrendState(
      trendRaw.t1raw[t], trendRaw.t2raw[t], state.trendState, state.aboveBandStreak, cfg.trend.trendBand,
    );

    // Cross-pillar weight redistribution (spec Section 6): only pillars
    // with a score today count, renormalized to sum to 1.
    const totalWeight = available.reduce((s, p) => s + cfg.pillarWeights[p.name], 0);
    const composite = clip(available.reduce((s, p) => s + (cfg.pillarWeights[p.name] / totalWeight) * (p.score as number), 0));
    const missingPillars = (["trend", "breadth", "stress", "sentiment", "macro"] as PillarName[])
      .filter((p) => !available.some((a) => a.name === p));

    const vetoConds = vetoConditionsAtIndex(stressRaw, t, cfg);

    // mc-1.3.0 recovery fast-path trigger/invalidation (config.recovery —
    // all placeholders). Pre-2006 fallback (no VIX3M, so s1raw is null):
    // VIXCLS below its own 50d average AND falling over 20 days
    // (s6raw < 0), in place of the VIX/VIX3M < vixTermStructureMax leg.
    const hasVix3m = stressRaw.s1raw[t] != null;
    const termStructureFavorable = hasVix3m
      ? stressRaw.s1raw[t]! < cfg.recovery.vixTermStructureMax
      : (stressRaw.vixSma50[t] != null && inp.vix[t] != null && inp.vix[t]! < stressRaw.vixSma50[t]!
          && stressRaw.s6raw[t] != null && stressRaw.s6raw[t]! < 0);
    const creditFavorable = stressRaw.s3raw[t] != null && stressRaw.s3raw[t]! < cfg.recovery.baa10yChangeMaxBp;
    const closeAboveSma50 = trendRaw.sma50[t] != null && inp.closes[t] > trendRaw.sma50[t]!;
    const fastPathTriggerNow = cfg.recovery.enabled && termStructureFavorable && creditFavorable && closeAboveSma50;

    // Invalidation: close < SMA50, or (only evaluable post-2006)
    // VIX/VIX3M > vixTermStructureInvalidate. No fallback invalidation leg
    // was specified for the pre-2006 case — see DECISIONS.md.
    const closeBelowSma50 = trendRaw.sma50[t] != null && inp.closes[t] < trendRaw.sma50[t]!;
    const vixInverted = hasVix3m && stressRaw.s1raw[t]! > cfg.recovery.vixTermStructureInvalidate;
    const fastPathInvalidated = closeBelowSma50 || vixInverted;

    const { rawTierIndex, finalTierIndex, fastPathActiveToday, floorActiveToday, nextState } = stepTierState(
      {
        composite, trendState: trendStateFinal, aboveBandStreak,
        termStructureTriggered: vetoConds.termStructureTriggered, creditWideningTriggered: vetoConds.creditWideningTriggered,
        fastPathTriggerNow, fastPathInvalidated,
      },
      state, cfg,
    );
    const vetoActive = nextState.vetoActive;

    const entryResult = evaluateEntrySignal({
      trendState: trendStateFinal,
      rsi14: oscRaw.rsi14[t] ?? undefined,
      stretch50d: oscRaw.stretch50d[t] ?? undefined,
    });

    const row: DayScoreRow = {
      date: inp.dates[t],
      configVersion: cfg.version,
      trendState: trendStateFinal,
      scoreTrend: trendResult.pillarScore,
      scoreBreadth: null,
      scoreStress: stressResult.pillarScore,
      scoreSentiment: null,
      scoreMacro: null,
      composite,
      rawTier: TIER_ORDER[rawTierIndex] as TierName,
      tier: TIER_ORDER[finalTierIndex] as TierName,
      exposureMultiplier: cfg.tiers[finalTierIndex].mult,
      entrySignal: entryResult.signal,
      entryReason: entryResult.reason,
      vetoActive,
      flags: {
        missing_pillars: missingPillars,
        veto: {
          termStructureTriggered: vetoConds.termStructureTriggered,
          creditWideningTriggered: vetoConds.creditWideningTriggered,
          termStructureStreak: nextState.vetoTermStructureStreak,
          clearStreak: nextState.vetoClearStreak,
        },
        recovery_fast_path_active: fastPathActiveToday,
        floor_active: floorActiveToday,
      },
      components: { trend: trendResult.indicators, stress: stressResult.indicators },
    };
    rows.push(row);

    state = nextState;
  }

  return rows;
}
