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

import { PillarName, TrendState, HysteresisState, DayScoreRow, TierName } from "./types.ts";
import { MC_CONFIG, TIER_ORDER, CAUTIOUS_IDX, DEFENSIVE_IDX, tierForComposite } from "./config.ts";
import { clip } from "./normalize.ts";
import { computeTrendRawSeries, scoreTrendAtIndex } from "./indicators/trend.ts";
import { computeStressRawSeries, scoreStressAtIndex, vetoConditionsAtIndex } from "./indicators/stress.ts";
import { evaluateEntrySignal } from "./entrySignal.ts";

export interface ComputeInputs {
  dates: string[]; // SPY trading-day calendar, ascending, drives everything else
  closes: number[]; // SPY close
  vix: (number | null)[]; // VIXCLS, aligned to `dates`
  vix3m: (number | null)[]; // ^VIX3M, aligned to `dates`
  hyOas: (number | null)[]; // BAMLH0A0HYM2, aligned to `dates`
}

const initialState = (): HysteresisState => ({
  tierIndex: TIER_ORDER.indexOf("NORMAL"), // neutral starting point before any real composite exists
  upStreak: 0, downStreak: 0,
  trendState: "MIXED",
  vetoActive: false, vetoTermStructureStreak: 0, vetoClearStreak: 0,
});

export interface TierStepInput {
  composite: number;
  trendState: TrendState; // already stickiness-resolved by the caller
  termStructureTriggered: boolean;
  creditWideningTriggered: boolean;
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

  if (tierIndex > 0) {
    const nextUpMin = cfg.tiers[tierIndex - 1].min;
    upStreak = inp.composite > nextUpMin + cfg.hysteresis.upgradeMargin ? upStreak + 1 : 0;
    if (upStreak >= cfg.hysteresis.upgradeDays) { tierIndex -= 1; upgraded = true; }
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

  // Trend cap (spec 7.3 #3): DOWN trend caps tier at CAUTIOUS or worse.
  let finalTierIndex = tierIndex;
  if (inp.trendState === "DOWN") finalTierIndex = Math.max(finalTierIndex, CAUTIOUS_IDX);

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
      vetoActive, vetoTermStructureStreak, vetoClearStreak,
    },
  };
}

export function computeMarketConditionsHistory(inp: ComputeInputs, cfg = MC_CONFIG): DayScoreRow[] {
  const n = inp.dates.length;
  const trendRaw = computeTrendRawSeries(inp.closes, inp.dates, cfg);
  const stressRaw = computeStressRawSeries(inp.closes, inp.vix, inp.vix3m, inp.hyOas);

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

    // Trend state stickiness (spec 6.1): a MIXED reading holds the prior
    // UP/DOWN state rather than resetting to neutral.
    const trendStateFinal: TrendState = trendResult.trendStateRaw !== "MIXED"
      ? trendResult.trendStateRaw
      : (state.trendState === "UP" || state.trendState === "DOWN" ? state.trendState : "MIXED");

    // Cross-pillar weight redistribution (spec Section 6): only pillars
    // with a score today count, renormalized to sum to 1.
    const totalWeight = available.reduce((s, p) => s + cfg.pillarWeights[p.name], 0);
    const composite = clip(available.reduce((s, p) => s + (cfg.pillarWeights[p.name] / totalWeight) * (p.score as number), 0));
    const missingPillars = (["trend", "breadth", "stress", "sentiment", "macro"] as PillarName[])
      .filter((p) => !available.some((a) => a.name === p));

    const vetoConds = vetoConditionsAtIndex(stressRaw, t, cfg);
    const { rawTierIndex, finalTierIndex, nextState } = stepTierState(
      { composite, trendState: trendStateFinal, termStructureTriggered: vetoConds.termStructureTriggered, creditWideningTriggered: vetoConds.creditWideningTriggered },
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
      },
      components: { trend: trendResult.indicators, stress: stressResult.indicators },
    };
    rows.push(row);

    state = nextState;
  }

  return rows;
}
