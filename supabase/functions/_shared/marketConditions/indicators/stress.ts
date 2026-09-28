// Market Conditions Overlay — Stress pillar (build spec Section 6.3). All
// five sub-indicators are INVERTED percentiles (higher raw value = more
// stress = lower score). Pure, Deno-API-free. Same two-pass shape as
// trend.ts: computeStressRawSeries (raw values only) then
// scoreStressAtIndex (percentile-normalize + combine).
//
// Inputs are pre-aligned by the caller (market-conditions-compute) to SPY's
// trading-day calendar, each as a same-length array with `null` for any
// date a given series doesn't (yet) have a value — VIX3M is null before
// 2006-07-17 (see DECISIONS.md).
//
// Credit spread series: BAA10Y (Moody's Baa corporate yield less the 10y
// Treasury, daily from 1986), not BAMLH0A0HYM2 (ICE BofA HY OAS) — switched
// in mc-1.1.0 after discovering FRED now serves BAMLH0A0HYM2 as only a
// rolling ~3-year window (see DECISIONS.md). BAMLH0A0HYM2 is still ingested
// for reference but no longer scored. Same percentage-point units and same
// *100-to-bp conversion apply to BAA10Y as applied to HY OAS.
//
// mc-1.3.0: added S6 (VIXCLS 20-day change) and a change-vs-level weight
// split (see STRESS_WEIGHTS below) instead of equal weighting. Also added
// `vixSma50` (VIXCLS's own 50-day SMA) — not a scored indicator, used only
// by scoring.ts's pre-2006 recovery fast-path fallback trigger (no VIX3M
// before 2006-07-17, so the fast-path's term-structure leg substitutes
// "VIXCLS below its own 50d average and falling" — s6raw < 0 covers the
// "falling" half, vixSma50 covers the "below its average" half).

import { SubIndicatorResult } from "../types.ts";
import { percentileRank, percentileToScore, collectPriorNonNull, stdevPop, clip } from "../normalize.ts";
import { MC_CONFIG } from "../config.ts";

export interface StressRawSeries {
  s1raw: (number | null)[]; // VIX / VIX3M
  s2raw: (number | null)[]; // credit spread level (%) -- BAA10Y
  s3raw: (number | null)[]; // credit spread 20d change, in BASIS POINTS (not %) -- see conversion below
  s4raw: (number | null)[]; // 20d annualized realized vol of SPX log returns
  s5raw: (number | null)[]; // VIX level
  s6raw: (number | null)[]; // VIXCLS 20d change, in VIX points (mc-1.3.0)
  vixSma50: (number | null)[]; // VIXCLS's own 50d SMA -- not scored, recovery fast-path fallback only
}

export function computeStressRawSeries(
  closes: number[], vix: (number | null)[], vix3m: (number | null)[], creditSpread: (number | null)[],
): StressRawSeries {
  const n = closes.length;
  const s1raw: (number | null)[] = new Array(n).fill(null);
  const s2raw: (number | null)[] = new Array(n).fill(null);
  const s3raw: (number | null)[] = new Array(n).fill(null);
  const s4raw: (number | null)[] = new Array(n).fill(null);
  const s5raw: (number | null)[] = new Array(n).fill(null);
  const s6raw: (number | null)[] = new Array(n).fill(null);
  const vixSma50: (number | null)[] = new Array(n).fill(null);

  const logRet: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) logRet[i] = Math.log(closes[i] / closes[i - 1]);
  }

  // vix is a plain array here (not "with nulls filtered"), so sma()'s
  // index-arithmetic needs a null-tolerant read -- vix may contain nulls
  // (pre-ingest gaps beyond the forward-fill cap), and sma() sums raw
  // array slots directly, so compute vixSma50 by hand with null-skipping
  // rather than reusing sma() verbatim.
  for (let t = 0; t < n; t++) {
    if (t - 49 >= 0) {
      let sum = 0, count = 0;
      for (let i = t - 49; i <= t; i++) { if (vix[i] != null) { sum += vix[i]!; count++; } }
      if (count === 50) vixSma50[t] = sum / 50;
    }
  }

  for (let t = 0; t < n; t++) {
    if (vix[t] != null && vix3m[t] != null && vix3m[t] !== 0) s1raw[t] = vix[t]! / vix3m[t]!;
    if (creditSpread[t] != null) s2raw[t] = creditSpread[t];
    // Stored in percentage points (FRED units: "Percent"). A 20-day change
    // of 0.01pp = 1bp, so *100 converts to bp -- matches
    // config.veto.creditWideningBp's own bp units directly.
    if (t - 20 >= 0 && creditSpread[t] != null && creditSpread[t - 20] != null) {
      s3raw[t] = (creditSpread[t]! - creditSpread[t - 20]!) * 100;
    }
    if (t - 19 >= 0) {
      const window: number[] = [];
      for (let i = t - 19; i <= t; i++) { const r = logRet[i]; if (r != null) window.push(r); }
      if (window.length === 20) s4raw[t] = stdevPop(window) * Math.sqrt(252);
    }
    if (vix[t] != null) s5raw[t] = vix[t];
    if (t - 20 >= 0 && vix[t] != null && vix[t - 20] != null) s6raw[t] = vix[t]! - vix[t - 20]!;
  }

  return { s1raw, s2raw, s3raw, s4raw, s5raw, s6raw, vixSma50 };
}

export interface StressScoreAtT {
  indicators: { S1: SubIndicatorResult; S2: SubIndicatorResult; S3: SubIndicatorResult; S4: SubIndicatorResult; S5: SubIndicatorResult; S6: SubIndicatorResult };
  pillarScore: number | null;
}

// mc-1.3.0: explicit change-vs-level weighting, not equal weight. S3/S6
// ("is it moving") total 50% of the pillar; S1/S2/S4/S5 ("where does it
// sit") share the other 50%. When some sub-indicators are excluded, the
// remaining available ones are renormalized proportionally to these
// nominal weights (same redistribution mechanic as the cross-pillar
// weighting in scoring.ts, not a special case).
const STRESS_WEIGHTS: Record<string, number> = { S1: 0.125, S2: 0.125, S3: 0.25, S4: 0.125, S5: 0.125, S6: 0.25 };

function scoreOne(raw: (number | null)[], t: number, cfg = MC_CONFIG): SubIndicatorResult {
  if (raw[t] == null) return { raw: null, percentile: null, score: null, excluded: true, excludeReason: "input unavailable" };
  const hist = collectPriorNonNull(raw, t, cfg.normWindow, cfg.minHistory);
  if (!hist) return { raw: raw[t], percentile: null, score: null, excluded: true, excludeReason: "insufficient history (<minHistory)" };
  const pct = percentileRank(hist, raw[t]!);
  return { raw: raw[t], percentile: pct, score: percentileToScore(pct, true), excluded: false }; // all Stress sub-indicators inverted
}

// S1 (mc-1.2.0): absolute linear mapping instead of percentile rank. A
// VIX/VIX3M ratio has a genuinely meaningful fixed reference point (1.0 =
// flat term structure) -- ranking it against 10 years of its own history
// (the percentile approach used for every other Stress sub-indicator)
// answers "is this unusual for the ratio," not "is the term structure
// actually inverted right now," which is the thing that matters. No
// minHistory gate either: live from the moment VIX3M itself exists
// (2006-07-17), not +756 trading days after that.
const S1_LOW = 0.85; // ratio <= this -> +1 (normal/favorable term structure)
const S1_HIGH = 1.05; // ratio >= this -> -1 (inverted/stressed), matches veto.termStructure
function scoreS1(raw: (number | null)[], t: number): SubIndicatorResult {
  if (raw[t] == null) return { raw: null, percentile: null, score: null, excluded: true, excludeReason: "input unavailable" };
  const ratio = raw[t]!;
  let score: number;
  if (ratio <= S1_LOW) score = 1;
  else if (ratio >= S1_HIGH) score = -1;
  else score = 1 - (2 * (ratio - S1_LOW)) / (S1_HIGH - S1_LOW);
  return { raw: ratio, percentile: null, score: clip(score), excluded: false };
}

export function scoreStressAtIndex(raw: StressRawSeries, t: number, cfg = MC_CONFIG): StressScoreAtT {
  const S1 = scoreS1(raw.s1raw, t);
  const S2 = scoreOne(raw.s2raw, t, cfg);
  const S3 = scoreOne(raw.s3raw, t, cfg);
  const S4 = scoreOne(raw.s4raw, t, cfg);
  const S5 = scoreOne(raw.s5raw, t, cfg);
  const S6 = scoreOne(raw.s6raw, t, cfg); // inverted percentile, same as S3

  const entries: [string, SubIndicatorResult][] = [["S1", S1], ["S2", S2], ["S3", S3], ["S4", S4], ["S5", S5], ["S6", S6]];
  const available = entries.filter(([, r]) => !r.excluded && r.score != null);
  let pillarScore: number | null = null;
  if (available.length) {
    const totalWeight = available.reduce((s, [k]) => s + STRESS_WEIGHTS[k], 0);
    pillarScore = available.reduce((s, [k, r]) => s + (STRESS_WEIGHTS[k] / totalWeight) * (r.score as number), 0);
  }

  return { indicators: { S1, S2, S3, S4, S5, S6 }, pillarScore };
}

// Raw veto trigger conditions (build spec Section 7.3) — evaluated from
// RAW values, not normalized scores, and kept separate from scoreOne above
// since the veto is a hard threshold rule, not part of the composite.
export function vetoConditionsAtIndex(raw: StressRawSeries, t: number, cfg = MC_CONFIG): { termStructureTriggered: boolean; creditWideningTriggered: boolean } {
  const termStructureTriggered = raw.s1raw[t] != null && raw.s1raw[t]! > cfg.veto.termStructure;
  const creditWideningTriggered = raw.s3raw[t] != null && raw.s3raw[t]! > cfg.veto.creditWideningBp;
  return { termStructureTriggered, creditWideningTriggered };
}
