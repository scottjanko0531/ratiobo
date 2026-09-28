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
// regardless of slope — see that file's header for the diagnosis) instead
// of the old raw-classification + generic stickiness. Also adds the
// recovery fast-path (config.recovery, all placeholder values): when
// VIX/VIX3M, BAA10Y's 20d change, and price-vs-SMA50 all turn favorable at
// once, the upgrade hysteresis window shortens and the DOWN trend cap is
// suspended for that day.

import { PillarName, TrendState, HysteresisState, DayScoreRow, TierName } from "./types.ts";
import { MC_CONFIG, TIER_ORDER, CAUTIOUS_IDX, DEFENSIVE_IDX, tierForComposite } from "./config.ts";
import { clip } from "./normalize.ts";
import { computeTrendRawSeries, scoreTrendAtIndex, resolveTrendState } from "./indicators/trend.ts";
import { computeStressRawSeries, scoreStressAtIndex, vetoConditionsAtIndex } from "./indicators/stress.ts";
import { evaluateEntrySignal } from "./entrySignal.ts";

export interface ComputeInputs {
  dates: string[]; // SPY trading-day calendar, ascending, drives everything else
  closes: number[]; // SPY close
  vix: (number | null)[]; // VIXCLS, aligned to `dates`
  vix3m: (number | null)[]; // ^VIX3M, aligned to `dates`
  creditSpread: (number | null)[]; // BAA10Y (mc-1.1.0+; was BAMLH0A0HYM2), aligned to `dates`
}

const initialState = (): HysteresisState => ({
  tierIndex: TIER_ORDER.indexOf("NORMAL"), // neutral starting point before any real composite exists
  upStreak: 0, downStreak: 0,
  trendState: "MIXED",
  aboveBandStreak: 0,
  vetoActive: false, vetoTermStructureStreak: 0, vetoClearStreak: 0,
});

export interface TierStepInput {
  composite: number;
  trendState: TrendState; // already resolved (resolveTrendState) by the caller
  aboveBandStreak: number; // already resolved by the caller -- threaded through into nextState
  termStructureTriggered: boolean;
  creditWideningTriggered: boolean;
  recoveryFastPathActive: boolean; // mc-1.2.0 — see config.recovery
}

export interface TierStepResult {
  rawTierIndex: number;
  finalTierIndex: number;
  nextState: HysteresisState;
}

// The hysteresis/trend-cap/stress-veto state machine (spec Section 7.3),
// factored out of computeMarketConditionsHistory's loop so it's directly
// testable against synthetic composite sequences (spec Section 12's own
// phrasing) without needing 756+ days of realistic price/series data to
// drive it through computeTrendRawSeries/computeStressRawSeries first.
export function stepTierState(inp: TierStepInput, prior: HysteresisState, cfg = MC_CONFIG): TierStepResult {
  const rawTierIndex = tierForComposite(inp.composite);

  let tierIndex = prior.tierIndex;
  let upStreak = prior.upStreak;
  let downStreak = prior.downStreak;
  let upgraded = false, downgraded = false;

  // mc-1.2.0: the recovery fast-path shortens the upgrade window from
  // hysteresis.upgradeDays down to recovery.fastPathUpgradeDays (default 1
  // -- i.e. same-day) when active.
  const upgradeDaysNeeded = inp.recoveryFastPathActive ? cfg.recovery.fastPathUpgradeDays : cfg.hysteresis.upgradeDays;

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
  // suspended when the mc-1.2.0 recovery fast-path is active (a no-op
  // unless trend_state is actually DOWN).
  let finalTierIndex = tierIndex;
  if (inp.trendState === "DOWN" && !inp.recoveryFastPathActive) finalTierIndex = Math.max(finalTierIndex, CAUTIOUS_IDX);

  // Stress veto (spec 7.3 #4).
  const vetoTermStructureStreak = inp.termStructureTriggered ? prior.vetoTermStructureStreak + 1 : 0;
  const vetoClearStreak = (!inp.termStructureTriggered && !inp.creditWideningTriggered) ? prior.vetoClearStreak + 1 : 0;

  let vetoActive = prior.vetoActive;
  if (!vetoActive) {
    if (vetoTermStructureStreak >= cfg.veto.termStructureDays || inp.creditWideningTriggered) vetoActive = true;
  } else {
    if (vetoClearStreak >= cfg.veto.clearDays) vetoActive = false;
  }
  if (vetoActive) finalTierIndex = Math.max(finalTierIndex, DEFENSIVE_IDX);

  return {
    rawTierIndex,
    finalTierIndex,
    // Persists the FINAL (capped) tier as next day's baseline -- see file
    // header for why.
    nextState: {
      tierIndex: finalTierIndex,
      upStreak, downStreak,
      trendState: inp.trendState,
      aboveBandStreak: inp.aboveBandStreak,
      vetoActive, vetoTermStructureStreak, vetoClearStreak,
    },
  };
}

export function computeMarketConditionsHistory(inp: ComputeInputs, cfg = MC_CONFIG): DayScoreRow[] {
  const n = inp.dates.length;
  const trendRaw = computeTrendRawSeries(inp.closes, inp.dates, cfg);
  const stressRaw = computeStressRawSeries(inp.closes, inp.vix, inp.vix3m, inp.creditSpread);

  const rows: DayScoreRow[] = [];
  let state = initialState();

  for (let t = 0; t < n; t++) {
    const trendResult = scoreTrendAtIndex(trendRaw, t, inp.closes, cfg);
    const stressResult = scoreStressAtIndex(stressRaw, t, cfg);

    const pillars: { name: PillarName; score: number | null }[] = [
      { name: "trend", score: trendResult.pillarScore },
      { name: "stress", score: stressResult.pillarScore },
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

    // mc-1.2.0 recovery fast-path (config.recovery — all placeholders).
    const closeAboveSma50 = trendRaw.sma50[t] != null && inp.closes[t] > trendRaw.sma50[t]!;
    const recoveryFastPathActive = cfg.recovery.enabled
      && stressRaw.s1raw[t] != null && stressRaw.s1raw[t]! < cfg.recovery.vixTermStructureMax
      && stressRaw.s3raw[t] != null && stressRaw.s3raw[t]! < cfg.recovery.baa10yChangeMaxBp
      && closeAboveSma50;

    const { rawTierIndex, finalTierIndex, nextState } = stepTierState(
      {
        composite, trendState: trendStateFinal, aboveBandStreak,
        termStructureTriggered: vetoConds.termStructureTriggered, creditWideningTriggered: vetoConds.creditWideningTriggered,
        recoveryFastPathActive,
      },
      state, cfg,
    );
    const vetoActive = nextState.vetoActive;

    const entryResult = evaluateEntrySignal({ trendState: trendStateFinal, vetoActive });

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
        recovery_fast_path_active: recoveryFastPathActive,
      },
      components: { trend: trendResult.indicators, stress: stressResult.indicators },
    };
    rows.push(row);

    state = nextState;
  }

  return rows;
}
