// Market Conditions Overlay — entry-signal oscillators (mc-1.4.0 entry-
// rule round, 2026-09-30). O1/O2 feed evaluateEntrySignal (entrySignal.ts)
// ONLY -- neither participates in the composite/tier/hysteresis pipeline,
// same separation as trend/stress raw series vs their pillar scores. Not
// named indicators/trend.ts's T-series because these aren't pillar sub-
// indicators; they're inputs to the entry-signal RULE layer, a distinct
// concept validated separately (market-conditions-entrysignal-validation).
//
// O1 = RSI14 (Wilder's original smoothing, the standard "RSI"
// construction -- 14-period seed as a simple average of the first 14
// gains/losses, then exponentially smoothed with alpha=1/14 thereafter).
//
// O2 = "stretch" vs SMA50, interpreted as a z-score: (close - SMA50) /
// stdev50(daily closes), NOT a raw percentage. Documented interpretation
// call (no build-spec doc is present in this repo to confirm against): the
// entry-rule thresholds (dipStretch=-1.5, hotStretch=2.0) only make sense
// as standard-deviation units -- a raw percentage reading of "1.5% below
// the 50-day average" would fire on a large fraction of ordinary trading
// days (too common to be a meaningful "dip" signal), whereas -1.5 standard
// deviations below a 50-day mean is a genuinely stretched move, consistent
// with how a "dip" or "hot" read is normally meant. Uses the same
// stdevPop() population-stdev convention already used for T3's vol
// denominator and S4's realized vol (normalize.ts), not sample stdev.

import { stdevPop } from "../normalize.ts";

export interface OscillatorRawSeries {
  rsi14: (number | null)[];
  stretch50d: (number | null)[];
}

export function computeOscillatorRawSeries(closes: number[]): OscillatorRawSeries {
  const n = closes.length;
  const rsi14: (number | null)[] = new Array(n).fill(null);
  const stretch50d: (number | null)[] = new Array(n).fill(null);

  const gains: number[] = new Array(n).fill(0);
  const losses: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }

  let avgGain = 0, avgLoss = 0;
  for (let t = 0; t < n; t++) {
    if (t === 14) {
      let sg = 0, sl = 0;
      for (let i = 1; i <= 14; i++) { sg += gains[i]; sl += losses[i]; }
      avgGain = sg / 14;
      avgLoss = sl / 14;
      rsi14[t] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else if (t > 14) {
      avgGain = (avgGain * 13 + gains[t]) / 14;
      avgLoss = (avgLoss * 13 + losses[t]) / 14;
      rsi14[t] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    if (t - 49 >= 0) {
      const window = closes.slice(t - 49, t + 1);
      const sma50 = window.reduce((a, b) => a + b, 0) / 50;
      const sd = stdevPop(window);
      stretch50d[t] = sd === 0 ? 0 : (closes[t] - sma50) / sd;
    }
  }

  return { rsi14, stretch50d };
}
