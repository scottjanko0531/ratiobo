// Bond Lens overlay — walks the full aligned history through every §4
// module and produces one bond_signals row per trading day. Pure,
// Deno-API-free, same "full rebuild, not incremental" choice as Market
// Conditions' computeMarketConditionsHistory.

import { BOND_LENS_CONFIG } from "./config.ts";
import { lagDaysThenAlign, indexDaysAgo, rollingZScoreSeries } from "./normalize.ts";
import { computeCarryHistory, CarryHistoryInputs } from "./carry.ts";
import { inflTrend, growthMom, growthMomFallback, pricedHikes, pathScoreContinuous, GrowthMomResult } from "./path.ts";
import { valuationScore, dfii10MinusRstarGap, spliceAcmWithFallback } from "./valuation.ts";
import {
  inflationAxis, classifyQuadrantLabel, stepQuadrantLabel, quadrantScoreContinuous, QuadrantLabelState,
  dailyReturns, hedgeCorrelation, stepHedgeReliable, HedgeState,
} from "./quadrant.ts";
import { timeSeriesMomentum, priceVsSma, trendFilter } from "./trend.ts";
import { curveRegimeRaw, classifyCurveCandidate, stepCurveRegime, CurveRegimeState } from "./curveRegime.ts";
import {
  syntheticBondTotalReturnIndex, spliceSyntheticBeforeReal, monthlyReturnsFromDailyIndex,
  rollingMonthlyCorrelation, monthlyCorrAsOf,
} from "./syntheticBond.ts";

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
  // Pre-1993 hedge fallback (§4.4, 2026-10-02 follow-up #1): Shiller's
  // monthly nominal S&P total return, RAW (monthly dates only, not
  // aligned onto the daily trading calendar -- rollingMonthlyCorrelation
  // works in monthly-return space directly).
  shillerSp500MonthlyTr: { date: string; value: number }[];
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
// regime, and now the quadrant display label): the last trading day of
// each ISO week, same construction as Market Conditions' monthEndIndices
// but week-granular. Spec ties hedge/curve persistence explicitly to
// "weekly reads," not daily ones; the quadrant label's own 3-week
// persistence (2026-10-02 follow-up #2) reuses the same cadence.
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

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function computeBondLensHistory(inputs: BondLensHistoryInputs, cfg = BOND_LENS_CONFIG): BondLensDayRow[] {
  const { dates } = inputs;
  const n = dates.length;

  const carryHistory = computeCarryHistory(inputs as unknown as CarryHistoryInputs, cfg);
  // 100 calendar days bridges one full quarter (~91-92 days) between
  // r-star releases with margin -- normalize.ts's alignForwardFill cap is
  // calendar days, not trading-day positions (see its own comment).
  const rstarLagged = lagDaysThenAlign(dates, inputs.rstar, cfg.rstarLagDays, 100);
  const spyReturns = dailyReturns(inputs.spy);
  const iefReturns = dailyReturns(inputs.ief);
  const weekEnds = weekEndIndices(dates);

  // Precomputed ONCE for the whole history -- rebuilding either of these
  // inside the per-day loop (an O(n) rebuild called n times) would be an
  // O(n^2) bug, the same class already found and fixed once in this file.
  const realYieldGapSeries = dfii10MinusRstarGap(inputs.dfii10, rstarLagged);
  const splicedTermPremium = spliceAcmWithFallback(inputs.acm, inputs.threefytp10);
  // Pre-2011 growth_mom fallback's own input (§4.2) -- same once-only reasoning.
  const slope10y2y = inputs.dgs10.map((y, i) => (y != null && inputs.dgs2[i] != null ? y - (inputs.dgs2[i] as number) : null));

  // §4.5 synthetic 10y total return (2026-10-02 follow-up #5): extends
  // trend's "IEF price" back to DGS10's own 1962 start, spliced
  // continuously onto real IEF from its 2002-07-30 inception.
  const syntheticBondIndex = syntheticBondTotalReturnIndex(inputs.dgs10);
  const effectiveIefPrice = spliceSyntheticBeforeReal(inputs.ief, syntheticBondIndex);
  const firstRealIefIdx = inputs.ief.findIndex((v) => v != null);
  // Trend reads degraded until a FULL momentum lookback window sits
  // entirely within real-IEF-covered dates, not merely until IEF itself
  // starts (the lookback still reaches back into synthetic territory for
  // a while after that).
  const trendDegradedUntilIdx = firstRealIefIdx < 0 ? n : firstRealIefIdx + cfg.trend.momentumLookbackDays;

  // §4.4 pre-1993 hedge fallback (2026-10-02 follow-up #1): monthly
  // Shiller S&P total return vs. the synthetic 10y return's own monthly
  // resampling, rolling 36-month correlation. Real SPY months (from
  // SPY's 1993-01-29 inception) override Shiller wherever both exist --
  // better data wins -- but this whole construction is moot once real
  // daily SPY/IEF correlation becomes available (~Dec 2002, 90 real
  // trading days after IEF's inception), since hedgeCorrelation (real)
  // is always tried FIRST below and only falls back to this when it
  // returns null.
  const syntheticMonthlyReturns = monthlyReturnsFromDailyIndex(dates, syntheticBondIndex);
  const spyMonthlyReturns = monthlyReturnsFromDailyIndex(dates, inputs.spy);
  const equityMonthlyMap = new Map<string, number>();
  for (const r of inputs.shillerSp500MonthlyTr) equityMonthlyMap.set(r.date, r.value);
  for (const r of spyMonthlyReturns) equityMonthlyMap.set(r.date, r.value); // real SPY wins where present
  const equityMonthly = Array.from(equityMonthlyMap.entries()).map(([date, value]) => ({ date, value })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const monthlyCorrSeries = rollingMonthlyCorrelation(equityMonthly, syntheticMonthlyReturns, cfg.hedge.fallbackWindowMonths);

  // §4.2/§4.4 continuous scoring (2026-10-02 follow-ups #2 and #4) both
  // need growth_mom/infl_trend/priced_hikes/inflation-axis z-scored
  // against their OWN rolling history -- that requires the raw series
  // built in full FIRST (one pass), before any single day can be
  // z-scored against it (rollingZScoreAt looks backward through the
  // series it's given).
  const growthMomSeries: (number | null)[] = new Array(n);
  const growthMomFlags: (string | undefined)[] = new Array(n);
  const inflTrendSeries: (number | null)[] = new Array(n);
  const inflRate12moSeries: (number | null)[] = new Array(n);
  const inflAxisSeries: (number | null)[] = new Array(n);
  const pricedHikesSeries: (number | null)[] = new Array(n);
  const rawQuadrantLabelSeries: (ReturnType<typeof classifyQuadrantLabel>)[] = new Array(n);
  for (let t = 0; t < n; t++) {
    const infl = inflTrend(inputs.pceIndex, dates, t);
    inflTrendSeries[t] = infl.score;
    inflRate12moSeries[t] = infl.excluded ? null : (infl.raw as { rate12mo: number | null }).rate12mo;
    const inflSign = infl.score == null ? null : sign(infl.score);

    const gm: GrowthMomResult = dates[t] < "2011-01-01"
      ? growthMomFallback(dates, inputs.t5yie, slope10y2y, dates, t)
      : growthMom(dates, inputs.gdpnow, inputs.gdpnowQuarter, t, cfg.path.lookbackDays);
    growthMomSeries[t] = gm.value;
    if (gm.degraded) growthMomFlags[t] = gm.reason;

    pricedHikesSeries[t] = pricedHikes(inputs.dgs2[t], inputs.dff[t]);

    const i8w = indexDaysAgo(dates, t, cfg.quadrant.lookbackDays);
    const t5yieChange = i8w != null && inputs.t5yie[t] != null && inputs.t5yie[i8w] != null
      ? (inputs.t5yie[t] as number) - (inputs.t5yie[i8w] as number) : null;
    inflAxisSeries[t] = inflationAxis(t5yieChange, inflSign);
    rawQuadrantLabelSeries[t] = classifyQuadrantLabel(growthMomSeries[t], inflAxisSeries[t]);
  }

  // O(n) z-scoring for the 4 series path_score/quadrant_score need --
  // see rollingZScoreSeries's own comment on why this isn't just
  // rollingZScoreAt called per day (same result, but O(n*window) instead
  // of O(n), which is what pushed bond-lens-compute into consistently
  // hitting WORKER_RESOURCE_LIMIT once these two modules went continuous.
  const pricedHikesZSeries = rollingZScoreSeries(pricedHikesSeries, cfg);
  const growthMomZSeries = rollingZScoreSeries(growthMomSeries, cfg);
  const inflTrendZSeries = rollingZScoreSeries(inflTrendSeries, cfg);
  const inflAxisZSeries = rollingZScoreSeries(inflAxisSeries, cfg);

  let hedgeState: HedgeState = { hedgeReliable: null, streak: 0 };
  let curveState: CurveRegimeState = { confirmed: null, candidate: null, candidateStreak: 0, regimeSince: null };
  let quadrantLabelState: QuadrantLabelState = { confirmed: null, candidate: null, candidateStreak: 0 };

  const rows: BondLensDayRow[] = [];
  for (let t = 0; t < n; t++) {
    const flags: Record<string, unknown> = {};
    if (growthMomFlags[t]) flags.growth_mom_degraded = growthMomFlags[t];

    // §4.2 path_score (continuous, 2026-10-02 follow-up #4)
    const pricedHikesZ = pricedHikesZSeries[t];
    const growthMomZ = growthMomZSeries[t];
    const inflTrendZ = inflTrendZSeries[t];
    const path = pathScoreContinuous(pricedHikesZ, growthMomZ, inflTrendZ);

    // §4.3 valuation (falls back to term premium alone pre-TIPS, 2026-10-02 follow-up #5)
    const val = valuationScore(
      inputs.dfii10, realYieldGapSeries, inputs.acm, splicedTermPremium,
      inflRate12moSeries[t], inputs.expInf1yr[t], inputs.t5yifr[t], t, cfg,
    );
    if (val.termPremium.degraded) flags.term_premium_degraded = "ACM stale >10 business days, spliced THREEFYTP10";
    if (val.realYieldGap.excluded && !val.excluded) flags.valuation_degraded_pre_tips = "DFII10 unavailable, scored from ACM term premium alone";

    // §4.4 quadrant (continuous score, 2026-10-02 follow-up #2)
    const inflAxisZ = inflAxisZSeries[t];
    const quad = quadrantScoreContinuous(growthMomZ, inflAxisZ);
    const rawLabel = rawQuadrantLabelSeries[t];

    if (weekEnds.has(t)) {
      quadrantLabelState = stepQuadrantLabel(rawLabel, quadrantLabelState, cfg);

      // §4.4 hedge reliability: real SPY/IEF correlation first; before
      // real data is sufficient (pre-~Dec 2002), fall back to the
      // pre-1993-oriented monthly construction above, flagged degraded.
      // Still null (never a silent default to true, 2026-10-02
      // follow-up #1) if NEITHER source has enough history yet
      // (before ~1965, 36 months after DGS10's 1962 start).
      const realCorr = hedgeCorrelation(spyReturns, iefReturns, t, cfg.hedge.corrWindow);
      const fallbackCorr = realCorr == null ? monthlyCorrAsOf(monthlyCorrSeries, dates[t]) : null;
      const corr = realCorr ?? fallbackCorr;
      if (realCorr == null && fallbackCorr != null) flags.hedge_reliable_degraded = "pre-1993 monthly Shiller/synthetic-bond fallback, not real SPY/IEF correlation";
      hedgeState = stepHedgeReliable(corr, rawLabel, hedgeState, cfg);
    }
    if (hedgeState.hedgeReliable === null) {
      flags.hedge_reliable_degraded = "no SPY/IEF correlation (real or pre-1993 fallback) available yet";
    }

    // §4.5 trend (synthetic 10y return before IEF, 2026-10-02 follow-up #5)
    const momentum = timeSeriesMomentum(effectiveIefPrice, inputs.dgs1, t, cfg.trend.momentumLookbackDays);
    const pvSma = priceVsSma(effectiveIefPrice, t, cfg.trend.smaWindow);
    const trend = trendFilter(momentum, pvSma);
    if (!trend.excluded && t < trendDegradedUntilIdx) flags.trend_degraded = "synthetic 10y total return (duration-based proxy), IEF not yet inception-eligible for this window";

    // §4.6 curve regime (unchanged -- lower priority, 2026-10-02 follow-up #6 keeps a stricter config alongside this one for Phase E comparison only)
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
      quadrant: quadrantLabelState.confirmed,
      curve_regime: curveState.confirmed,
      hedge_reliable: hedgeState.hedgeReliable,
      breakeven_gap_bp: val.breakevenGapBp.score,
      inputs_hash: null,
      flags,
    });
  }
  return rows;
}
