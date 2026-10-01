// Bond Lens overlay — walks the full aligned history through every §4
// module and produces one bond_signals row per trading day. Pure,
// Deno-API-free, same "full rebuild, not incremental" choice as Market
// Conditions' computeMarketConditionsHistory.

import { BOND_LENS_CONFIG } from "./config.ts";
import { lagDaysThenAlign, indexDaysAgo } from "./normalize.ts";
import { computeCarryHistory, CarryHistoryInputs } from "./carry.ts";
import { pricedHikes, inflTrend, growthMom, growthMomFallback, pathScore, GrowthMomResult } from "./path.ts";
import { valuationScore } from "./valuation.ts";
import { inflationAxis, classifyQuadrant, dailyReturns, hedgeCorrelation, stepHedgeReliable, HedgeState } from "./quadrant.ts";
import { timeSeriesMomentum, priceVsSma, trendFilter } from "./trend.ts";
import { curveRegimeRaw, classifyCurveCandidate, stepCurveRegime, CurveRegimeState } from "./curveRegime.ts";

export interface BondLensHistoryInputs {
  dates: string[]; // the shared trading calendar every series below is already aligned onto
  dgs3mo: (number | null)[]; dgs1: (number | null)[]; dgs2: (number | null)[]; dgs3: (number | null)[];
  dgs5: (number | null)[]; dgs7: (number | null)[]; dgs10: (number | null)[]; dgs30: (number | null)[];
  dfii5: (number | null)[]; dfii10: (number | null)[];
  t5yie: (number | null)[]; t10yie: (number | null)[]; t5yifr: (number | null)[];
  dff: (number | null)[];
  acm: (number | null)[]; // already forward-filled with the 10-business-day staleness cap
  threefytp10: (number | null)[];
  rstar: { date: string; value: number }[]; // RAW (not yet aligned) -- this function applies the 1-quarter lag + forward-fill itself
  pceIndex: (number | null)[]; expInf1yr: (number | null)[];
  gdpnow: (number | null)[]; gdpnowQuarter: (string | null)[];
  spy: (number | null)[]; ief: (number | null)[];
}

export interface BondLensDayRow {
  as_of_date: string;
  carry_score: number | null;
  path_score: number | null;
  valuation_score: number | null;
  quadrant_score: number | null;
  curve_score: number | null;
  trend_score: number | null;
  trend_state: string | null;
  quadrant: string | null;
  curve_regime: string | null;
  hedge_reliable: boolean | null;
  breakeven_gap_bp: number | null;
  inputs_hash: string | null;
  flags: Record<string, unknown>;
}

// "Weekly read" for the hysteresis-gated modules (hedge_reliable, curve
// regime): the last trading day of each ISO week, same construction as
// Market Conditions' monthEndIndices but week-granular. Spec ties both
// modules' persistence explicitly to "weekly reads," not daily ones.
function weekEndIndices(dates: string[]): Set<number> {
  const idx = new Set<number>();
  for (let i = 0; i < dates.length; i++) {
    const isLastOfWeek = i === dates.length - 1 || isoWeek(dates[i + 1]) !== isoWeek(dates[i]);
    if (isLastOfWeek) idx.add(i);
  }
  return idx;
}

function isoWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

export function computeBondLensHistory(inputs: BondLensHistoryInputs, cfg = BOND_LENS_CONFIG): BondLensDayRow[] {
  const { dates } = inputs;
  const n = dates.length;

  const carryHistory = computeCarryHistory(inputs as unknown as CarryHistoryInputs, cfg);
  const rstarLagged = lagDaysThenAlign(dates, inputs.rstar, cfg.rstarLagDays, 95);
  const spyReturns = dailyReturns(inputs.spy);
  const iefReturns = dailyReturns(inputs.ief);
  const weekEnds = weekEndIndices(dates);

  let hedgeState: HedgeState = { hedgeReliable: true, streak: 0 };
  let curveState: CurveRegimeState = { confirmed: null, candidate: null, candidateStreak: 0, regimeSince: null };

  const rows: BondLensDayRow[] = [];
  for (let t = 0; t < n; t++) {
    const flags: Record<string, unknown> = {};

    // §4.2
    const infl = inflTrend(inputs.pceIndex, dates, t);
    const inflSign = infl.score == null ? null : infl.score > 0 ? 1 : infl.score < 0 ? -1 : 0;
    let gm: GrowthMomResult;
    if (dates[t] < "2011-01-01") {
      const slope10y2y = inputs.dgs10.map((y, i) => (y != null && inputs.dgs2[i] != null ? y - (inputs.dgs2[i] as number) : null));
      gm = growthMomFallback(dates, inputs.t5yie, slope10y2y, dates, t);
    } else {
      gm = growthMom(dates, inputs.gdpnow, inputs.gdpnowQuarter, t, cfg.path.lookbackDays);
    }
    if (gm.degraded) flags.growth_mom_degraded = gm.reason;
    const path = pathScore(inputs.dgs2[t], inputs.dff[t], gm, infl);

    // §4.3
    const val = valuationScore(
      inputs.dfii10, rstarLagged, inputs.acm, inputs.threefytp10,
      infl.excluded ? null : (infl.raw as { rate12mo: number | null }).rate12mo,
      inputs.expInf1yr[t], inputs.t5yifr[t], t, cfg,
    );
    if (val.degraded) flags.term_premium_degraded = "ACM stale >10 business days, spliced THREEFYTP10";

    // §4.4
    let t5yieChange: number | null = null;
    const i8w = indexDaysAgo(dates, t, cfg.quadrant.lookbackDays);
    if (i8w != null && inputs.t5yie[t] != null && inputs.t5yie[i8w] != null) t5yieChange = (inputs.t5yie[t] as number) - (inputs.t5yie[i8w] as number);
    const inflAxis = inflationAxis(t5yieChange, inflSign);
    const quad = classifyQuadrant(gm.value, inflAxis);

    if (weekEnds.has(t)) {
      const corr = hedgeCorrelation(spyReturns, iefReturns, t, cfg.hedge.corrWindow);
      hedgeState = stepHedgeReliable(corr, quad.quadrant, hedgeState, cfg);
    }

    // §4.5
    const momentum = timeSeriesMomentum(inputs.ief, inputs.dgs1, t, cfg.trend.momentumLookbackDays);
    const pvSma = priceVsSma(inputs.ief, t, cfg.trend.smaWindow);
    const trend = trendFilter(momentum, pvSma);

    // §4.6
    let curveScore: number | null = null;
    if (weekEnds.has(t)) {
      const raw = curveRegimeRaw(inputs.dgs10, inputs.dgs5, inputs.dgs2, t, cfg.curveRegime.lookbackDays);
      const candidate = classifyCurveCandidate(raw, cfg);
      const step = stepCurveRegime(candidate, dates[t], curveState, cfg);
      curveState = step.state;
      curveScore = step.score;
      if (step.lateycleTransition) flags.late_cycle_transition = "bear_flattening -> bull_flattening";
    } else {
      curveScore = curveState.confirmed ? cfg.curveRegime.scores[curveState.confirmed] : null;
    }

    rows.push({
      as_of_date: dates[t],
      carry_score: carryHistory[t].carryScore.z,
      path_score: path.score,
      valuation_score: val.score,
      quadrant_score: quad.score,
      curve_score: curveScore,
      trend_score: trend.score,
      trend_state: trend.state,
      quadrant: quad.quadrant,
      curve_regime: curveState.confirmed,
      hedge_reliable: hedgeState.hedgeReliable,
      breakeven_gap_bp: val.breakevenGapBp.score,
      inputs_hash: null,
      flags,
    });
  }
  return rows;
}
