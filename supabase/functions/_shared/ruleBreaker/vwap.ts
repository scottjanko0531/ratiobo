// Rule Breaker Screener — VWAP overlay and the buy/hold/wait/exit action
// decision tree. Confirmed far more of this than the original plan
// expected via systematic action_why text-mining against all 155 baseline
// rows this session (the artifact's own English explanation for every
// row's action is itself ground truth, not just a display string). See
// each function's comment for exact confirmed match rate.

import { RB_CONFIG } from "./config.ts";

// Confirmed exact on every example checked.
export function computeVwapZ(close: number, vwap6a: number, vwap6sigma: number): number | null {
  if (vwap6sigma === 0) return null;
  return (close - vwap6a) / vwap6sigma;
}

export type VwapState = "Below VWAP: exit / stay out" | "Above, VWAP falling: caution" | "Uptrend: hold" | "Entry signal";

// Confirmed 143/155 (92%) exact with this rule: a fresh 'u' signal this
// week wins outright ("Entry signal"); else z<0 is "Below VWAP"; else
// (z>=0) compare this week's vwap6_a to last week's to call "Uptrend:
// hold" (rising) vs "Above, VWAP falling: caution" (falling). The 12
// residual mismatches all involve a very small week-over-week vwap6_a
// change near z>1 -- likely a trend dead-zone or longer lookback is
// needed; left as a documented gap for scripts/rb-calibrate.ts rather than
// guessed further.
export function computeVwapState(
  z: number,
  latestSignal: "u" | "d" | null,
  vwap6aNow: number,
  vwap6aPrior: number | null,
): VwapState {
  if (latestSignal === "u" && RB_CONFIG.vwap.entrySignalWinsOutright) return "Entry signal";
  if (z < 0) return "Below VWAP: exit / stay out";
  if (vwap6aPrior != null && vwap6aNow < vwap6aPrior) return "Above, VWAP falling: caution";
  return "Uptrend: hold";
}

export type ActionKey = "nonew" | "wait" | "hold" | "buy" | "pull" | "half";

export interface ActionInputs {
  symbol: string;
  score: number;
  safety: number;
  met: number;
  owned: boolean;
  vwapState: VwapState;
  vwapZ: number;
  closedOn: string | null;
  priorWeekScore: number | null; // from rb_scores_history, the most recent row before this one
  vwap6a: number;
  vwap6sigma: number;
}

export interface ActionResult {
  action: string;
  actionKey: ActionKey;
  actionWhy: string;
}

// Confirmed decision tree, evaluated in this exact precedence order against
// all 155 baseline rows (see config.ts's `action` block for per-step match
// evidence). The one genuine ambiguity: whether "buy" (full size) requires
// met===6 specifically, or just vwapZ>=stretchedZThreshold -- only one real
// "buy" example exists (met=6 AND z>=2 together), so this can't be
// disambiguated from the current baseline. This implementation requires
// met===6, the more conservative reading (matches the spec's own framing
// of a true "Rule Breaker" vs a partial-qualifier needing hedged sizing).
export function computeAction(inputs: ActionInputs): ActionResult {
  const { score, safety, met, owned, vwapState, vwapZ, closedOn, priorWeekScore } = inputs;
  const { safetyVetoThreshold, qualifyingScoreThreshold, stretchedZThreshold, halfSizeZBand, buyOnPullbackZBand } =
    RB_CONFIG.action;

  if (closedOn != null) {
    return { action: "No new money", actionKey: "nonew", actionWhy: `The Fool closed this recommendation on ${closedOn}.` };
  }
  if (safety < safetyVetoThreshold) {
    return {
      action: "No new money",
      actionKey: "nonew",
      actionWhy: `Safety veto: debt or volatility too high (${safety}).`,
    };
  }
  if (score < qualifyingScoreThreshold) {
    return { action: "No new money", actionKey: "nonew", actionWhy: `Score ${score} is under 50.` };
  }
  const wasQualifiedLastWeek = priorWeekScore == null ? null : priorWeekScore >= qualifyingScoreThreshold;
  if (wasQualifiedLastWeek === false) {
    return {
      action: "Wait",
      actionKey: "wait",
      actionWhy: `Newly qualified (last week ${priorWeekScore}): confirm next week.`,
    };
  }

  if (owned) {
    if (vwapState === "Below VWAP: exit / stay out") {
      return {
        action: "Hold",
        actionKey: "hold",
        actionWhy: `Below its 6-wk VWAP, but the score is still ${score}: let the winner run. Exit only if the score drops below 45.`,
      };
    }
    if (vwapZ >= stretchedZThreshold) {
      return {
        action: "Hold",
        actionKey: "hold",
        actionWhy: `Stretched above +2σ; momentum held up in the backtest, so adding a little is fine.`,
      };
    }
    return { action: "Hold", actionKey: "hold", actionWhy: "Strong score, inside the buy zone: can add." };
  }

  if (vwapState === "Below VWAP: exit / stay out") {
    return {
      action: "Wait",
      actionKey: "wait",
      actionWhy: "Qualifies, but below its VWAP (risk control): wait for a weekly close above.",
    };
  }
  if (vwapState === "Above, VWAP falling: caution") {
    return { action: "Wait", actionKey: "wait", actionWhy: "Qualifies, but VWAP is falling (risk control)." };
  }

  // vwapState is "Entry signal" or "Uptrend: hold" from here -- z-banded
  // buy/pull/half, with the suggested limit-order zone confirmed as
  // exactly [vwap6_a, vwap6_a + 1*vwap6_sigma] on every pull/half example.
  const zoneLow = inputs.vwap6a;
  const zoneHigh = inputs.vwap6a + inputs.vwap6sigma;
  const isRuleBreaker = met === 6;

  // Bands checked widest/most-specific first: stretched (>=2) only reads
  // as a full "Buy" when met===6 (the one confirmed real example); every
  // other z>=1 case -- including a met===6 symbol that isn't also
  // stretched, which has no confirmed example either way -- falls through
  // to "Buy on pullback" rather than silently guessing it's a full "Buy".
  if (vwapZ >= stretchedZThreshold && isRuleBreaker) {
    return {
      action: "Buy",
      actionKey: "buy",
      actionWhy: `Stretched above +2σ (${inputs.vwap6a.toFixed(2)}). In the backtest these kept rising more often than not; consider a smaller starter position.`,
    };
  }
  if (vwapZ >= buyOnPullbackZBand[0]) {
    return {
      action: "Buy on pullback",
      actionKey: "pull",
      actionWhy:
        `${inputs.vwap6a.toFixed(2)} is 1–2σ above the VWAP, the weakest spot to buy in the backtest. ` +
        `Set a limit order in the zone ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}.` +
        (isRuleBreaker ? "" : ` Half size: score ${score} but only ${met} of 6 signs, so not a Rule Breaker.`),
    };
  }
  if (vwapZ >= halfSizeZBand[0] && vwapZ < halfSizeZBand[1]) {
    return {
      action: "Half size",
      actionKey: "half",
      actionWhy:
        `${inputs.vwap6a.toFixed(2)} is inside the buy zone ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}.` +
        (isRuleBreaker ? "" : ` Half size: score ${score} but only ${met} of 6 signs, so not a Rule Breaker.`),
    };
  }
  // Fallback for bands not yet confirmed (e.g. z<0 shouldn't reach here
  // given vwapState checks above, but guard rather than silently misclassify).
  throw new Error(
    `computeAction: unresolved band for ${inputs.symbol} (z=${vwapZ}, met=${met}, vwapState=${vwapState}) -- ` +
      `see vwap.ts header comment, this combination wasn't in the confirmed baseline`,
  );
}
