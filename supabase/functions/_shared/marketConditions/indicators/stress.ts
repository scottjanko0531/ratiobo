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

import { SubIndicatorResult } from "../types.ts";
import { percentileRank, percentileToScore, collectPriorNonNull, stdevPop, clip } from "../normalize.ts";
import { MC_CONFIG } from "../config.ts";

export interface StressRawSeries {
  s1raw: (number | null)[]; // VIX / VIX3M
  s2raw: (number | null)[]; // credit spread level (%) -- BAA10Y
  s3raw: (number | null)[]; // credit spread 20d change, in BASIS POINTS (not %) -- see conversion below
  s4raw: (number | null)[]; // 20d annualized realized vol of SPX log returns
  s5raw: (number | null)[]; // VIX level
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

  const logRet: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) logRet[i] = Math.log(closes[i] / closes[i - 1]);
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
  }

  return { s1raw, s2raw, s3raw, s4raw, s5raw };
}

export interface StressScoreAtT {
  indicators: { S1: SubIndicatorResult; S2: SubIndicatorResult; S3: SubIndicatorResult; S4: SubIndicatorResult; S5: SubIndicatorResult };
  pillarScore: number | null;
}

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

  const available = [S1, S2, S3, S4, S5].filter((r) => !r.excluded && r.score != null);
  const pillarScore = available.length ? available.reduce((s, r) => s + (r.score as number), 0) / available.length : null;

  return { indicators: { S1, S2, S3, S4, S5 }, pillarScore };
}

// Raw veto trigger conditions (build spec Section 7.3) — evaluated from
// RAW values, not normalized scores, and kept separate from scoreOne above
// since the veto is a hard threshold rule, not part of the composite.
export function vetoConditionsAtIndex(raw: StressRawSeries, t: number, cfg = MC_CONFIG): { termStructureTriggered: boolean; creditWideningTriggered: boolean } {
  const termStructureTriggered = raw.s1raw[t] != null && raw.s1raw[t]! > cfg.veto.termStructure;
  const creditWideningTriggered = raw.s3raw[t] != null && raw.s3raw[t]! > cfg.veto.creditWideningBp;
  return { termStructureTriggered, creditWideningTriggered };
}
