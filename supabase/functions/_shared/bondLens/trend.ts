// Bond Lens overlay — §4.5 Trend filter (timing gate). Pure, Deno-API-free.

import { TrendState } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";

export function sma(values: (number | null)[], t: number, n: number): number | null {
  if (t - n + 1 < 0) return null;
  let s = 0;
  for (let i = t - n + 1; i <= t; i++) {
    const v = values[i];
    if (v == null) return null;
    s += v;
  }
  return s / n;
}

// 12-month time-series momentum: IEF's (or synthetic) total return over
// the lookback minus the 1-year T-bill yield that prevailed at the START
// of that same window -- the standard "what a bill bought then would
// have returned by now" proxy for the 12-month bill return, since a bill
// held near maturity realizes close to its quoted yield.
export function timeSeriesMomentum(
  prices: (number | null)[], dgs1Pct: (number | null)[], t: number, lookbackDays = BOND_LENS_CONFIG.trend.momentumLookbackDays,
): number | null {
  const i0 = t - lookbackDays;
  if (i0 < 0) return null;
  const p0 = prices[i0], p1 = prices[t], bill = dgs1Pct[i0];
  if (p0 == null || p1 == null || bill == null || p0 === 0) return null;
  const totalReturn = p1 / p0 - 1;
  return totalReturn - bill / 100;
}

export function priceVsSma(prices: (number | null)[], t: number, window = BOND_LENS_CONFIG.trend.smaWindow): number | null {
  const avg = sma(prices, t, window);
  const p = prices[t];
  if (avg == null || p == null || avg === 0) return null;
  return p / avg - 1;
}

export interface TrendFilterResult {
  momentum: number | null;
  priceVsSma: number | null;
  state: TrendState | null;
  score: number | null;
  excluded: boolean;
}

// trend_state: up if both legs positive, down if both negative, mixed
// otherwise (spec §4.5) -- including "excluded" (neither leg computable)
// as a distinct case from a genuine "mixed" reading.
export function trendFilter(momentum: number | null, pvSma: number | null): TrendFilterResult {
  if (momentum == null || pvSma == null) {
    return { momentum, priceVsSma: pvSma, state: null, score: null, excluded: true };
  }
  let state: TrendState;
  if (momentum > 0 && pvSma > 0) state = "up";
  else if (momentum < 0 && pvSma < 0) state = "down";
  else state = "mixed";
  const score = state === "up" ? 1.5 : state === "down" ? -1.5 : 0;
  return { momentum, priceVsSma: pvSma, state, score, excluded: false };
}
