// Market Conditions Overlay — Breadth pillar, PROXY version (Phase 2,
// 2026-09-30 round). This is the ONLY breadth pillar ever scored into the
// composite (live or backtest) — see DECISIONS.md "scored vs display"
// entry. Constituent-based B1-B5/thrust/%oversold (indicators/breadth
// Constituent module, separate file) are diagnostics only, never wired
// into computeMarketConditionsHistory's `breadthScore` input.
//
// Built entirely from 3 already-long-lived, non-survivorship-biased
// instruments — the 9 original sector SPDRs (XLB/XLE/XLF/XLI/XLK/XLP/XLU/
// XLV/XLY, all inception 1998-12-16) and RSP (equal-weight S&P 500 ETF,
// inception 2003-04-30) vs SPY — so it's usable for BOTH live scoring and
// a full-history backtest without the current-constituents-projected-
// backward bias that makes the constituent-based pillar unusable for the
// keep-or-drop decision.
//
// Three sub-indicators, PB1/PB2 using the exact user-specified formula
// (count of 9 sectors above/below their own SMA, mapped through the
// natural midpoint 4.5), PB3 using the same "0% = neutral" absolute
// mapping as T1/S1 before it:
//   PB1 = count(SPDR close > own SMA200) -> score = (count - 4.5) / 4.5
//   PB2 = count(SPDR close > own SMA50)  -> score = (count - 4.5) / 4.5
//   PB3 = 50-day % change of (RSP/SPY)   -> score = clip(raw / pb3BoundPct, -1, 1)
// plus a divergence flag/penalty: SPY within divergenceHighPct of its own
// 252-day high, while PB1's count is < divergenceCountMax (5) AND lower
// than it was divergenceLookbackDays (60) trading days ago -- applies
// divergencePenalty as a subtraction from the combined pillar score.

import { clip } from "../normalize.ts";
import { MC_CONFIG } from "../config.ts";

export interface ProxyBreadthRawSeries {
  pb1count: (number | null)[]; // 0-9, count of SPDRs above own SMA200
  pb2count: (number | null)[]; // 0-9, count of SPDRs above own SMA50
  pb3raw: (number | null)[]; // RSP/SPY 50-day % change
  spy252High: (number | null)[]; // trailing 252d rolling max of SPY close, inclusive of today
  divergenceActive: boolean[];
}

function sma(values: (number | null)[], t: number, n: number): number | null {
  if (t - n + 1 < 0) return null;
  let s = 0;
  for (let i = t - n + 1; i <= t; i++) {
    const v = values[i];
    if (v == null) return null;
    s += v;
  }
  return s / n;
}

function rollingMax(values: number[], t: number, n: number): number | null {
  if (t - n + 1 < 0) return null;
  let m = -Infinity;
  for (let i = t - n + 1; i <= t; i++) m = Math.max(m, values[i]);
  return m;
}

// `dates` is SPY's own trading calendar (the pillar's native calendar --
// divergence is explicitly defined against SPY, not whichever market a
// caller later aligns this onto). `spdrCloses` is 9 arrays (one per
// sector SPDR, same order doesn't matter), each pre-aligned to `dates` by
// exact-date match (all are US-listed, same trading calendar as SPY --
// unlike VIXCLS/BAA10Y there's no cross-source publish-lag to forward-fill
// here). `rspCloses` is null before RSP's own 2003-04-30 inception.
export function computeProxyBreadthRawSeries(
  dates: string[], spyCloses: number[], spdrCloses: (number | null)[][], rspCloses: (number | null)[],
): ProxyBreadthRawSeries {
  const n = dates.length;
  const pb1count: (number | null)[] = new Array(n).fill(null);
  const pb2count: (number | null)[] = new Array(n).fill(null);
  const pb3raw: (number | null)[] = new Array(n).fill(null);
  const spy252High: (number | null)[] = new Array(n).fill(null);
  const divergenceActive: boolean[] = new Array(n).fill(false);

  const ratio: (number | null)[] = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    if (rspCloses[t] != null && spyCloses[t] > 0) ratio[t] = rspCloses[t]! / spyCloses[t];
  }

  for (let t = 0; t < n; t++) {
    spy252High[t] = rollingMax(spyCloses, t, 252);

    let above200 = 0, above50 = 0, avail = true;
    for (const s of spdrCloses) {
      const sma200 = sma(s, t, 200);
      const sma50 = sma(s, t, 50);
      if (sma200 == null || sma50 == null || s[t] == null) { avail = false; break; }
      if (s[t]! > sma200) above200++;
      if (s[t]! > sma50) above50++;
    }
    if (avail) { pb1count[t] = above200; pb2count[t] = above50; }

    if (t - 50 >= 0 && ratio[t] != null && ratio[t - 50] != null && ratio[t - 50] !== 0) {
      pb3raw[t] = ratio[t]! / ratio[t - 50]! - 1;
    }
  }

  for (let t = 0; t < n; t++) {
    const near252High = spy252High[t] != null && spyCloses[t] >= spy252High[t]! * (1 - MC_CONFIG.breadth.divergenceHighPct);
    const countNow = pb1count[t];
    const countPrior = t - MC_CONFIG.breadth.divergenceLookbackDays >= 0 ? pb1count[t - MC_CONFIG.breadth.divergenceLookbackDays] : null;
    divergenceActive[t] = near252High && countNow != null && countNow < MC_CONFIG.breadth.divergenceCountMax
      && countPrior != null && countNow < countPrior;
  }

  return { pb1count, pb2count, pb3raw, spy252High, divergenceActive };
}

export interface ProxyBreadthScoreAtT {
  pb1: number | null;
  pb2: number | null;
  pb3: number | null;
  divergenceActive: boolean;
  pillarScore: number | null;
}

export function scoreProxyBreadthAtIndex(raw: ProxyBreadthRawSeries, t: number, cfg = MC_CONFIG): ProxyBreadthScoreAtT {
  const pb1 = raw.pb1count[t] != null ? (raw.pb1count[t]! - 4.5) / 4.5 : null;
  const pb2 = raw.pb2count[t] != null ? (raw.pb2count[t]! - 4.5) / 4.5 : null;
  const pb3 = raw.pb3raw[t] != null ? clip(raw.pb3raw[t]! / cfg.breadth.pb3BoundPct) : null;

  const available = [pb1, pb2, pb3].filter((v): v is number => v != null);
  let pillarScore: number | null = null;
  if (available.length) {
    const avg = available.reduce((s, v) => s + v, 0) / available.length;
    pillarScore = clip(raw.divergenceActive[t] ? avg - cfg.breadth.divergencePenalty : avg);
  }

  return { pb1, pb2, pb3, divergenceActive: raw.divergenceActive[t], pillarScore };
}
