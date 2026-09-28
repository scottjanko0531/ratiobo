// Market Conditions Overlay — Trend pillar (build spec Section 6.1).
// Pure, Deno-API-free. Two-pass design, same shape as stress.ts:
//   1. computeTrendRawSeries — one O(n) pass producing every day's raw
//      indicator value from `closes` alone (SMA-based, no percentile yet).
//   2. scoreTrendAtIndex — percentile-normalizes T1/T3 against their own
//      trailing window (T2/T4 are already +/-1 per the spec's own table,
//      no percentile step) and returns that day's pillar result plus the
//      RAW (pre-stickiness) trend state. Stickiness needs the PRIOR day's
//      final state, which is sequential/carried-forward state that belongs
//      to scoring.ts's walk, not to this pure per-indicator module.

import { SubIndicatorResult, TrendState } from "../types.ts";
import { sma, percentileRank, percentileToScore, collectPriorNonNull } from "../normalize.ts";
import { MC_CONFIG } from "../config.ts";

export interface TrendRawSeries {
  t1raw: (number | null)[]; // close/SMA200 - 1
  t2raw: (number | null)[]; // +1 / -1 / null
  t3raw: (number | null)[]; // 12-1 momentum
  t4raw: (number | null)[]; // +1 / -1 / null (10-month rule)
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
  const t4raw: (number | null)[] = new Array(n).fill(null);

  const slope = cfg.trend.slopeLookback;
  const months = cfg.trend.tenMonthRuleMonths;
  const monthEnd = monthEndIndices(dates);

  for (let t = 0; t < n; t++) {
    const sma200 = sma(closes, t, 200);
    if (sma200 != null) t1raw[t] = closes[t] / sma200 - 1;

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

  return { t1raw, t2raw, t3raw, t4raw };
}

export interface TrendScoreAtT {
  indicators: { T1: SubIndicatorResult; T2: SubIndicatorResult; T3: SubIndicatorResult; T4: SubIndicatorResult };
  pillarScore: number | null;
  trendStateRaw: TrendState;
}

export function scoreTrendAtIndex(
  raw: TrendRawSeries, t: number, closes: number[], cfg = MC_CONFIG,
): TrendScoreAtT {
  const { normWindow, minHistory } = cfg;

  // T1: percentile of close/SMA200-1 within its own trailing history.
  let T1: SubIndicatorResult = { raw: raw.t1raw[t], percentile: null, score: null, excluded: true, excludeReason: "sma200 unavailable" };
  if (raw.t1raw[t] != null) {
    const hist = collectPriorNonNull(raw.t1raw, t, normWindow, minHistory);
    if (hist) {
      const pct = percentileRank(hist, raw.t1raw[t]!);
      T1 = { raw: raw.t1raw[t], percentile: pct, score: percentileToScore(pct, false), excluded: false };
    } else {
      T1 = { raw: raw.t1raw[t], percentile: null, score: null, excluded: true, excludeReason: "insufficient history (<minHistory)" };
    }
  }

  // T2: already +/-1, no percentile step.
  const T2: SubIndicatorResult = raw.t2raw[t] != null
    ? { raw: raw.t2raw[t], percentile: null, score: raw.t2raw[t], excluded: false }
    : { raw: null, percentile: null, score: null, excluded: true, excludeReason: "sma200 slope unavailable" };

  // T3: percentile of 12-1 momentum.
  let T3: SubIndicatorResult = { raw: raw.t3raw[t], percentile: null, score: null, excluded: true, excludeReason: "12-1 window unavailable" };
  if (raw.t3raw[t] != null) {
    const hist = collectPriorNonNull(raw.t3raw, t, normWindow, minHistory);
    if (hist) {
      const pct = percentileRank(hist, raw.t3raw[t]!);
      T3 = { raw: raw.t3raw[t], percentile: pct, score: percentileToScore(pct, false), excluded: false };
    } else {
      T3 = { raw: raw.t3raw[t], percentile: null, score: null, excluded: true, excludeReason: "insufficient history (<minHistory)" };
    }
  }

  // T4: already +/-1, no percentile step.
  const T4: SubIndicatorResult = raw.t4raw[t] != null
    ? { raw: raw.t4raw[t], percentile: null, score: raw.t4raw[t], excluded: false }
    : { raw: null, percentile: null, score: null, excluded: true, excludeReason: "10-month history unavailable" };

  const available = [T1, T2, T3, T4].filter((r) => !r.excluded && r.score != null);
  const pillarScore = available.length ? available.reduce((s, r) => s + (r.score as number), 0) / available.length : null;

  // Raw trend state (pre-stickiness — see file header). Reuses T1's raw
  // ratio directly: close > SMA200*(1+band) <=> T1raw > band.
  const band = cfg.trend.trendBand;
  let trendStateRaw: TrendState = "MIXED";
  if (raw.t1raw[t] != null && raw.t2raw[t] != null) {
    if (raw.t1raw[t]! > band && raw.t2raw[t] === 1) trendStateRaw = "UP";
    else if (raw.t1raw[t]! < -band && raw.t2raw[t] === -1) trendStateRaw = "DOWN";
  }

  return { indicators: { T1, T2, T3, T4 }, pillarScore, trendStateRaw };
}
