// Market Conditions Overlay — Trend pillar (build spec Section 6.1).
// Pure, Deno-API-free. Two-pass design, same shape as stress.ts:
//   1. computeTrendRawSeries — one O(n) pass producing every day's raw
//      indicator value from `closes` alone (SMA-based).
//   2. scoreTrendAtIndex — normalizes each indicator into [-1,1] and
//      returns that day's pillar result.
//   3. resolveTrendState — the trend-state TRANSITION machine (mc-1.2.0),
//      separate from scoreTrendAtIndex because it's inherently stateful
//      (needs yesterday's state + a running streak), unlike the pure
//      per-day indicator scoring above.
//
// mc-1.2.0 structural fix (diagnosed against 2002/2009/2011/2022: SPX
// closed back above its 200d SMA 7-17 WEEKS before trend_state left DOWN
// in every one of those episodes, entirely because of stickiness holding
// DOWN through the choppy within-band chop that follows most recoveries):
// DOWN now exits to MIXED once close > SMA200*(1+band) for 3 CONSECUTIVE
// days, regardless of slope. The slope (T2) requirement is kept ONLY for
// MIXED -> UP, so DOWN can never jump straight to UP in one step anymore —
// it always passes through MIXED first. UP's own exit condition (belowBand
// + slopeDown, single day) is unchanged.
//
// mc-1.3.0: T1 and T3 switched from percentile rank to absolute mappings
// (see scoreTrendAtIndex) after diagnosing that percentile-ranked trend
// scores were the actual bottleneck behind mc-1.2.0's still-slow recovery
// dates -- a bare SMA200 cross ranks low percentile-wise (unremarkable vs.
// a full bull market's typical readings) even though it's technically
// bullish. Both drop the minHistory gate entirely: an absolute formula
// doesn't need a trailing population to rank against.

import { SubIndicatorResult, TrendState } from "../types.ts";
import { sma, clip, stdevPop } from "../normalize.ts";
import { MC_CONFIG } from "../config.ts";

export interface TrendRawSeries {
  t1raw: (number | null)[]; // close/SMA200 - 1
  t2raw: (number | null)[]; // +1 / -1 / null
  t3raw: (number | null)[]; // 12-1 momentum (simple return, t-252 to t-21)
  t3vol: (number | null)[]; // 252-day annualized vol of daily log returns -- mc-1.3.0, T3's risk-adjustment denominator
  t4raw: (number | null)[]; // +1 / -1 / null (10-month rule)
  sma50: (number | null)[]; // plain SMA50 level -- not a scored indicator, used only by the recovery fast-path (scoring.ts)
}

// Month-end index of each trading day's calendar month, i.e. the last
// index i such that dates[i] is the final trading day of its month.
function monthEndIndices(dates: string[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    const isLastOfMonth = i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);
    if (isLastOfMonth) idx.push(i);
  }
  return idx;
}

export function computeTrendRawSeries(
  closes: number[], dates: string[], cfg = MC_CONFIG,
): TrendRawSeries {
  const n = closes.length;
  const t1raw: (number | null)[] = new Array(n).fill(null);
  const t2raw: (number | null)[] = new Array(n).fill(null);
  const t3raw: (number | null)[] = new Array(n).fill(null);
  const t3vol: (number | null)[] = new Array(n).fill(null);
  const t4raw: (number | null)[] = new Array(n).fill(null);
  const sma50: (number | null)[] = new Array(n).fill(null);

  const slope = cfg.trend.slopeLookback;
  const months = cfg.trend.tenMonthRuleMonths;
  const monthEnd = monthEndIndices(dates);

  const logRet: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) logRet[i] = Math.log(closes[i] / closes[i - 1]);
  }

  for (let t = 0; t < n; t++) {
    const sma200 = sma(closes, t, 200);
    if (sma200 != null) t1raw[t] = closes[t] / sma200 - 1;
    sma50[t] = sma(closes, t, 50);

    if (t - slope >= 0) {
      const sma200now = sma(closes, t, 200);
      const sma200prior = sma(closes, t - slope, 200);
      if (sma200now != null && sma200prior != null) {
        t2raw[t] = sma200now / sma200prior - 1 > 0 ? 1 : -1;
      }
    }

    // 12-1 momentum: return from t-252 to t-21 (skip the most recent month,
    // standard momentum-factor construction — avoids the short-term
    // mean-reversion window contaminating a "trend" signal).
    if (t - 252 >= 0 && t - 21 >= 0) {
      t3raw[t] = closes[t - 21] / closes[t - 252] - 1;
    }

    // 252-day annualized vol of daily log returns -- T3's risk-adjustment
    // denominator (mc-1.3.0). Needs 252 log-return values ending at t, i.e.
    // closes[t-252..t].
    if (t - 252 >= 0) {
      const window: number[] = [];
      for (let i = t - 251; i <= t; i++) { const r = logRet[i]; if (r != null) window.push(r); }
      if (window.length === 252) t3vol[t] = stdevPop(window) * Math.sqrt(252);
    }

    // 10-month rule: last completed month-end close vs the trailing
    // N-month SMA of month-end closes (including that month-end itself) —
    // held constant through the following month, same "monthly signal,
    // evaluated only at month boundaries" discipline as the KISS backtest.
    let pos = -1;
    for (let i = 0; i < monthEnd.length; i++) {
      if (monthEnd[i] <= t) pos = i; else break;
    }
    if (pos >= months - 1) {
      const meCloses = monthEnd.slice(pos - months + 1, pos + 1).map((idx) => closes[idx]);
      const meSma = meCloses.reduce((a, b) => a + b, 0) / months;
      const lastMeClose = closes[monthEnd[pos]];
      t4raw[t] = lastMeClose > meSma ? 1 : -1;
    }
  }

  return { t1raw, t2raw, t3raw, t3vol, t4raw, sma50 };
}

export interface TrendScoreAtT {
  indicators: { T1: SubIndicatorResult; T2: SubIndicatorResult; T3: SubIndicatorResult; T4: SubIndicatorResult };
  pillarScore: number | null;
}

// T1 (mc-1.3.0): absolute linear mapping, +/-5% distance from SMA200.
const T1_BOUND = 0.05;
function scoreT1(raw: number | null): SubIndicatorResult {
  if (raw == null) return { raw: null, percentile: null, score: null, excluded: true, excludeReason: "sma200 unavailable" };
  return { raw, percentile: null, score: clip(raw / T1_BOUND), excluded: false };
}

// T3 (mc-1.3.0): 12-1 momentum divided by its own 252-day annualized vol
// (a risk-adjusted momentum ratio), clipped to [-1,1] directly -- no
// percentile step, no minHistory gate. `raw` stays the plain momentum
// value (unchanged meaning across scoring-method changes, same convention
// as T1's raw staying the plain SMA200 distance); the vol-adjustment is an
// internal step within scoring, not a separately exposed field.
function scoreT3(momentum: number | null, vol: number | null): SubIndicatorResult {
  if (momentum == null || vol == null) return { raw: momentum, percentile: null, score: null, excluded: true, excludeReason: "12-1 window or 252d vol unavailable" };
  if (vol === 0) return { raw: momentum, percentile: null, score: momentum > 0 ? 1 : momentum < 0 ? -1 : 0, excluded: false };
  return { raw: momentum, percentile: null, score: clip(momentum / vol), excluded: false };
}

export function scoreTrendAtIndex(
  raw: TrendRawSeries, t: number, closes: number[], cfg = MC_CONFIG,
): TrendScoreAtT {
  const T1 = scoreT1(raw.t1raw[t]);

  // T2: already +/-1, no percentile step.
  const T2: SubIndicatorResult = raw.t2raw[t] != null
    ? { raw: raw.t2raw[t], percentile: null, score: raw.t2raw[t], excluded: false }
    : { raw: null, percentile: null, score: null, excluded: true, excludeReason: "sma200 slope unavailable" };

  const T3 = scoreT3(raw.t3raw[t], raw.t3vol[t]);

  // T4: already +/-1, no percentile step.
  const T4: SubIndicatorResult = raw.t4raw[t] != null
    ? { raw: raw.t4raw[t], percentile: null, score: raw.t4raw[t], excluded: false }
    : { raw: null, percentile: null, score: null, excluded: true, excludeReason: "10-month history unavailable" };

  const available = [T1, T2, T3, T4].filter((r) => !r.excluded && r.score != null);
  const pillarScore = available.length ? available.reduce((s, r) => s + (r.score as number), 0) / available.length : null;

  return { indicators: { T1, T2, T3, T4 }, pillarScore };
}

export interface TrendStateResult {
  state: TrendState;
  aboveBandStreak: number;
}

// Trend-state transition machine (mc-1.2.0 — see file header for the
// diagnosis this fixes). Stateful by nature (needs yesterday's state + a
// running streak), so it's separate from the stateless per-day
// scoreTrendAtIndex above; scoring.ts's walk calls this once per day,
// carrying `state`/`aboveBandStreak` forward via HysteresisState.
//
// Transitions:
//   DOWN  -> MIXED  when close > SMA200*(1+band) for 3 CONSECUTIVE days,
//            regardless of slope (T2). Never DOWN -> UP directly.
//   MIXED -> UP     when close > SMA200*(1+band) AND slope (T2) > 0, same
//            day (unchanged from before).
//   MIXED -> DOWN   when close < SMA200*(1-band) AND slope (T2) < 0, same
//            day (unchanged from before).
//   UP    -> DOWN   when close < SMA200*(1-band) AND slope (T2) < 0, same
//            day (unchanged from before); otherwise UP is sticky.
export function resolveTrendState(
  t1raw: number | null, t2raw: number | null, priorState: TrendState, priorAboveBandStreak: number, band: number,
): TrendStateResult {
  const aboveBand = t1raw != null && t1raw > band;
  const belowBand = t1raw != null && t1raw < -band;
  const slopeUp = t2raw === 1;
  const slopeDown = t2raw === -1;

  const aboveBandStreak = aboveBand ? priorAboveBandStreak + 1 : 0;

  let state: TrendState = priorState;
  if (priorState === "DOWN") {
    state = aboveBandStreak >= 3 ? "MIXED" : "DOWN";
  } else if (priorState === "UP") {
    state = (belowBand && slopeDown) ? "DOWN" : "UP";
  } else {
    // MIXED, including the initial bootstrap state.
    if (aboveBand && slopeUp) state = "UP";
    else if (belowBand && slopeDown) state = "DOWN";
    else state = "MIXED";
  }

  return { state, aboveBandStreak };
}
