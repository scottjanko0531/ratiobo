// Bond Lens overlay — §4.3 Valuation. Pure, Deno-API-free.

import { rollingZScoreAt, ZScoreResult } from "./normalize.ts";
import { ModuleResult } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";

// Real yield gap: average of z-score(DFII10 - rstar_lagged) and
// z-score(DFII10 against its own rolling history) -- spec §4.3: "Real
// yield gap: DFII10 - rstar_HLW (lagged), plus DFII10 vs. its rolling
// 10-year mean. The score is the average of the two z-scores." rstar is
// expected to already be lag-aligned by the caller (normalize.ts's
// lagDaysThenAlign) before this function sees it.
export function realYieldGapScore(
  dfii10: (number | null)[], rstarLagged: (number | null)[], t: number, cfg = BOND_LENS_CONFIG,
): ModuleResult<{ gap: number | null; dfii10: number | null }> {
  const gapSeries = dfii10.map((y, i) => (y != null && rstarLagged[i] != null ? y - (rstarLagged[i] as number) : null));
  const gapZ = rollingZScoreAt(gapSeries, t, cfg);
  const levelZ = rollingZScoreAt(dfii10, t, cfg);
  if (gapZ.excluded || levelZ.excluded) {
    return { raw: { gap: gapSeries[t], dfii10: dfii10[t] }, score: null, excluded: true, excludeReason: gapZ.excludeReason ?? levelZ.excludeReason };
  }
  return { raw: { gap: gapSeries[t], dfii10: dfii10[t] }, score: ((gapZ.z as number) + (levelZ.z as number)) / 2, excluded: false };
}

export interface TermPremiumResult {
  value: number | null; // the (possibly spliced) raw term premium used
  source: "acm" | "threefytp10" | null;
  score: number | null;
  excluded: boolean;
  degraded: boolean; // true when ACM was stale and THREEFYTP10 was substituted
}

// `acmFF`/`fallbackFF` must already be forward-filled onto the shared
// trading calendar by the caller, with `acmFF` capped at exactly the
// staleness threshold (10 business days -- bond-lens-decisions.md's ACM
// item 1: "if ACM's last observation is more than 10 business days old
// ... fall back to THREEFYTP10, z-scored on its own history, set the
// degraded flag"). Forward-filling is itself how "more than N days old"
// becomes a null at index t (see normalize.ts's alignForwardFill), so
// that threshold is enforced by the CALLER's forward-fill cap, not
// re-checked here.
//
// "z-scored on its own history" (the spliced series, not ACM alone) is
// exactly what z-scoring `spliced` below gives: every point before the
// first substitution still reads as ACM's own z-score (spliced == acmFF
// there), and once substitution starts, the rolling window naturally
// blends in THREEFYTP10 history too.
export function termPremiumScore(acmFF: (number | null)[], fallbackFF: (number | null)[], t: number, cfg = BOND_LENS_CONFIG): TermPremiumResult {
  const spliced: (number | null)[] = acmFF.map((v, i) => v ?? fallbackFF[i]);
  const z = rollingZScoreAt(spliced, t, cfg);
  const value = spliced[t];
  const source: TermPremiumResult["source"] = value == null ? null : acmFF[t] != null ? "acm" : "threefytp10";
  return { value, source, score: z.z, excluded: z.excluded, degraded: acmFF[t] == null && fallbackFF[t] != null };
}

// Breakeven gap (basis points): inflation_view - T5YIFR, where
// inflation_view = average of core PCE 12m and EXPINF1YR. Positive favors
// TIPS -- an INSTRUMENT signal, not a duration signal, so this is never
// folded into valuation_score itself.
export function breakevenGapBp(
  corePce12mo: number | null, expInf1yr: number | null, t5yifr: number | null,
): ModuleResult<{ inflationView: number | null }> {
  if (corePce12mo == null || expInf1yr == null || t5yifr == null) {
    return { raw: { inflationView: null }, score: null, excluded: true, excludeReason: "core PCE 12mo, EXPINF1YR, or T5YIFR unavailable" };
  }
  const inflationView = (corePce12mo + expInf1yr) / 2;
  return { raw: { inflationView }, score: (inflationView - t5yifr) * 100, excluded: false };
}

export interface ValuationScoreResult {
  realYieldGap: ModuleResult<{ gap: number | null; dfii10: number | null }>;
  termPremium: TermPremiumResult;
  breakevenGapBp: ModuleResult<{ inflationView: number | null }>;
  score: number | null; // equal-weighted average of realYieldGap.score and termPremium.score
  excluded: boolean;
  degraded: boolean;
}

export function valuationScore(
  dfii10: (number | null)[], rstarLagged: (number | null)[], acmFF: (number | null)[], fallbackFF: (number | null)[],
  corePce12mo: number | null, expInf1yr: number | null, t5yifr: number | null,
  t: number, cfg = BOND_LENS_CONFIG,
): ValuationScoreResult {
  const ryg = realYieldGapScore(dfii10, rstarLagged, t, cfg);
  const tp = termPremiumScore(acmFF, fallbackFF, t, cfg);
  const be = breakevenGapBp(corePce12mo, expInf1yr, t5yifr);
  const excluded = ryg.excluded || tp.excluded;
  return {
    realYieldGap: ryg, termPremium: tp, breakevenGapBp: be,
    score: excluded ? null : ((ryg.score as number) + (tp.score as number)) / 2,
    excluded, degraded: tp.degraded,
  };
}
