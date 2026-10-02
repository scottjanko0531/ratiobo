// Bond Lens overlay — §4.3 Valuation. Pure, Deno-API-free.

import { rollingZScoreAt, ZScoreResult } from "./normalize.ts";
import { ModuleResult } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";

// Builds the DFII10-minus-rstar gap series once -- callers walking a full
// history must compute this ONCE outside their per-day loop and pass the
// result to realYieldGapScore below, not rebuild it every call (an O(n)
// rebuild inside an O(n)-day walk was an O(n^2) bug over a ~16k-row
// history, caught before this ever ran against real data).
export function dfii10MinusRstarGap(dfii10: (number | null)[], rstarLagged: (number | null)[]): (number | null)[] {
  return dfii10.map((y, i) => (y != null && rstarLagged[i] != null ? y - (rstarLagged[i] as number) : null));
}

// Real yield gap: average of z-score(DFII10 - rstar_lagged) and
// z-score(DFII10 against its own rolling history) -- spec §4.3: "Real
// yield gap: DFII10 - rstar_HLW (lagged), plus DFII10 vs. its rolling
// 10-year mean. The score is the average of the two z-scores." `gapSeries`
// is dfii10MinusRstarGap's output, computed once by the caller.
export function realYieldGapScore(
  dfii10: (number | null)[], gapSeries: (number | null)[], t: number, cfg = BOND_LENS_CONFIG,
): ModuleResult<{ gap: number | null; dfii10: number | null }> {
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

// Splices ACM with its fallback once -- same O(n^2)-avoidance reason as
// dfii10MinusRstarGap above; callers walking a full history compute this
// ONCE outside their per-day loop.
export function spliceAcmWithFallback(acmFF: (number | null)[], fallbackFF: (number | null)[]): (number | null)[] {
  return acmFF.map((v, i) => v ?? fallbackFF[i]);
}

// `acmFF`/`fallbackFF` must already be forward-filled onto the shared
// trading calendar by the caller, with `acmFF` capped at exactly the
// staleness threshold (10 business days -- bond-lens-decisions.md's ACM
// item 1: "if ACM's last observation is more than 10 business days old
// ... fall back to THREEFYTP10, z-scored on its own history, set the
// degraded flag"). Forward-filling is itself how "more than N days old"
// becomes a null at index t (see normalize.ts's alignForwardFill), so
// that threshold is enforced by the CALLER's forward-fill cap, not
// re-checked here. `spliced` is spliceAcmWithFallback's output.
//
// "z-scored on its own history" (the spliced series, not ACM alone) is
// exactly what z-scoring `spliced` below gives: every point before the
// first substitution still reads as ACM's own z-score (spliced == acmFF
// there), and once substitution starts, the rolling window naturally
// blends in THREEFYTP10 history too.
export function termPremiumScore(acmFF: (number | null)[], spliced: (number | null)[], t: number, cfg = BOND_LENS_CONFIG): TermPremiumResult {
  const z = rollingZScoreAt(spliced, t, cfg);
  const value = spliced[t];
  const source: TermPremiumResult["source"] = value == null ? null : acmFF[t] != null ? "acm" : "threefytp10";
  return { value, source, score: z.z, excluded: z.excluded, degraded: acmFF[t] == null && spliced[t] != null };
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

// 2026-10-02 follow-up #5: before TIPS existed (DFII10 starts 2003, so
// realYieldGap's own 756-day minimum pushes its first score to ~2006),
// valuation_score was fully excluded even though ACM term premium alone
// (available from 1961, scoreable from ~1964 once its own 756-day
// minimum is met) had a real, scoreable reading the whole time. Spec's
// own "missing inputs are reweighted and flagged" rule (§4 Phase B
// acceptance) applies here exactly: when realYieldGap is excluded but
// termPremium isn't, fall back to termPremium alone, flagged degraded --
// pulling valuation_score's effective start back to ~1964 instead of
// ~2006, so Phase E's "reduced, flagged as degraded: from 1990" backtest
// window (§6) actually has a valuation input to run against.
export function valuationScore(
  dfii10: (number | null)[], gapSeries: (number | null)[], acmFF: (number | null)[], splicedTermPremium: (number | null)[],
  corePce12mo: number | null, expInf1yr: number | null, t5yifr: number | null,
  t: number, cfg = BOND_LENS_CONFIG,
): ValuationScoreResult {
  const ryg = realYieldGapScore(dfii10, gapSeries, t, cfg);
  const tp = termPremiumScore(acmFF, splicedTermPremium, t, cfg);
  const be = breakevenGapBp(corePce12mo, expInf1yr, t5yifr);
  if (ryg.excluded && !tp.excluded) {
    return {
      realYieldGap: ryg, termPremium: tp, breakevenGapBp: be,
      score: tp.score, excluded: false, degraded: true,
    };
  }
  const excluded = ryg.excluded || tp.excluded;
  return {
    realYieldGap: ryg, termPremium: tp, breakevenGapBp: be,
    score: excluded ? null : ((ryg.score as number) + (tp.score as number)) / 2,
    excluded, degraded: tp.degraded,
  };
}
