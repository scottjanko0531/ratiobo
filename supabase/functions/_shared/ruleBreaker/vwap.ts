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

export type VwapState =
  | "Below VWAP: exit / stay out"
  | "Above, VWAP falling: caution"
  | "Uptrend: hold"
  | "Entry signal"
  | "Wait – no VWAP data yet";

// Placeholder for a symbol that doesn't (yet) have enough weekly-bar
// history to compute a VWAP state -- a newly-added symbol, or one where
// today's refresh hasn't landed a usable latest bar. The scoring engine
// must score this symbol normally on every OTHER field (percentiles are
// universe-wide; dropping the symbol would shift everyone else's rank)
// and simply fall back to this state + a neutral "Wait" action instead.
export const NO_VWAP_DATA: VwapState = "Wait – no VWAP data yet";

export interface WeeklyBarForVwapState {
  close: number;
  vwap6: number; // vm = the volume-weighted 6-wk VWAP mean for THIS week
}

// on(k) per the user's exact formula: up (close above its own 6-wk VWAP)
// AND rising (that 6-wk VWAP above what it was two weeks earlier).
function isOn(bars: WeeklyBarForVwapState[], k: number): boolean {
  return bars[k].close > bars[k].vwap6 && bars[k].vwap6 > bars[k - 2].vwap6;
}

// Formula supplied directly by the user from the live screen's own source
// code (not reverse-engineered) and confirmed 155/155 exact against the
// full real baseline: `i` = the latest week (weeklyBars' last index,
// ascending by week_start). up = close > vm (this week's own 6-wk VWAP
// mean); rising = vm > mp, where mp is the 6-wk VWAP mean AS OF TWO WEEKS
// EARLIER -- that's `weeklyBars[i-2].vwap6`, NOT the imported `vwap12`
// field. An earlier attempt used the stored `vwap12` field for this
// comparison (reasoning it was a precomputed stand-in) and topped out at
// 152/155 -- `vwap12` is a genuinely different 12-week aggregate that
// happens to track `mp` closely but not exactly, confirmed by the 3
// residual mismatches (RDDT/WING/AMT/TREX/ETSY/MNST-shaped cases) all
// having `vwap6[i] <= vwap12[i]` (predicting "falling") while the real
// state was "Entry signal", which only resolves once `mp` is read from
// `weeklyBars[i-2].vwap6` directly. `won` = weeks since `on()` (evaluated
// at each historical week k>=7) was last false, scanning k=i-1 down to 7;
// "Entry signal" requires up && rising && won<=2, else "Uptrend: hold".
// Needs at least 8 weeks of history (i>=7).
// Returns NO_VWAP_DATA rather than throwing when there isn't enough
// history yet (needs i>=7, i.e. 8+ weeks) -- a per-symbol data gap, not a
// reason to abort scoring the rest of the universe.
export function computeVwapState(weeklyBars: WeeklyBarForVwapState[]): VwapState {
  const i = weeklyBars.length - 1;
  if (i < 7) return NO_VWAP_DATA;
  const up = weeklyBars[i].close > weeklyBars[i].vwap6;
  const rising = weeklyBars[i].vwap6 > weeklyBars[i - 2].vwap6;
  if (!up) return "Below VWAP: exit / stay out";
  if (!rising) return "Above, VWAP falling: caution";
  let won: number | null = null;
  for (let k = i - 1; k >= 7; k--) {
    if (!isOn(weeklyBars, k)) {
      won = i - k;
      break;
    }
  }
  if (won == null) won = i - 6; // "on" as far back as checkable (k>=7 floor) -- never found a false week
  return won <= 2 ? "Entry signal" : "Uptrend: hold";
}

export type ActionKey = "nonew" | "wait" | "hold" | "buy" | "pull" | "half";

export interface ActionInputs {
  symbol: string;
  score: number;
  safety: number;
  met: number;
  owned: boolean;
  vwapState: VwapState;
  vwapZ: number | null; // null exactly when vwapState is NO_VWAP_DATA
  closedOn: string | null;
  priorWeekScore: number | null; // from rb_scores_history, the most recent row before this one
  vwap6a: number | null;
  vwap6sigma: number | null;
  price: number | null; // current week's close -- null exactly when vwapState is NO_VWAP_DATA, same as vwap6a/vwap6sigma
  riskType: "Aggressive" | "Moderate" | "Cautious";
}

export interface ActionResult {
  action: string;
  actionKey: ActionKey;
  actionWhy: string;
}

// Confirmed decision tree, evaluated in this exact precedence order against
// all 155 baseline rows (see config.ts's `action` block for per-step match
// evidence), PLUS a live 2026-10-20 confirmation (DOCS: met=3, z=2.41 ->
// "Half size", not "Buy on pullback") that resolved the one ambiguity the
// 2026-10-19 historical baseline couldn't: a stretched (z>=2) symbol that
// ISN'T met===6 gets "Half size", not "Buy on pullback" -- only met===6
// AND z>=2 together gets the full "Buy". See the z>=stretchedZThreshold
// branch below.
export function computeAction(inputs: ActionInputs): ActionResult {
  const { score, safety, met, owned, vwapState, vwapZ, closedOn, priorWeekScore, riskType } = inputs;
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
  // "Newly qualified" compares priorWeekScore against a threshold that
  // depends on TODAY's score, not the flat qualifyingScoreThreshold above
  // -- confirmed via two real 2026-10-20 cases: BRZE (last week 49, this
  // week 62 -> Wait, since 62>=60 raises the bar to 60 and 49<60) and EXEL
  // (last week 44, this week 52 -> Wait, since 52<60 keeps the bar at 50
  // and 44<50). A flat 50 threshold would have missed BRZE (49>=50, so a
  // flat-50 gate would NOT have flagged it newly-qualified) -- supplied
  // directly by the user from the artifact's real behavior, not
  // reverse-engineered.
  const newlyQualifiedThreshold = score >= 60 ? 60 : qualifyingScoreThreshold;
  const wasQualifiedLastWeek = priorWeekScore == null ? null : priorWeekScore >= newlyQualifiedThreshold;
  if (wasQualifiedLastWeek === false) {
    return {
      action: "Wait",
      actionKey: "wait",
      actionWhy: `Newly qualified (last week ${priorWeekScore}): confirm next week.`,
    };
  }

  // No weekly-bar history yet (new symbol, or today's refresh hasn't
  // landed a usable latest bar) -- every gate above still applies (a
  // closed rec, a safety veto, or a sub-50 score all still win outright),
  // but there's nothing to band on past this point, so this is a neutral
  // "Wait" rather than a guess.
  if (vwapState === NO_VWAP_DATA) {
    return { action: "Wait", actionKey: "wait", actionWhy: "No VWAP data yet for this symbol." };
  }
  // vwapState !== NO_VWAP_DATA from here on, which the caller only sets
  // alongside a real vwapZ/vwap6a/vwap6sigma -- safe to treat as non-null.
  const z = vwapZ as number;
  const vwap6a = inputs.vwap6a as number;
  const vwap6sigma = inputs.vwap6sigma as number;
  const price = inputs.price as number;

  if (owned) {
    if (vwapState === "Below VWAP: exit / stay out") {
      return {
        action: "Hold",
        actionKey: "hold",
        actionWhy: `Below its 6-wk VWAP, but the score is still ${score}: let the winner run. Exit only if the score drops below 45.`,
      };
    }
    if (z >= stretchedZThreshold) {
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
  // The number shown in actionWhy's opening clause is the current PRICE
  // (confirmed via MNST/DOCS on 2026-10-20: the displayed figure matched
  // `spot.price`, not vwap6a, despite an earlier version of this file
  // guessing vwap6a -- that guess was never actually checked against a
  // real numeric value, only against actionKey/action, so it went
  // unnoticed until this live date's ground truth was available).
  const zoneLow = vwap6a;
  const zoneHigh = vwap6a + vwap6sigma;
  const isRuleBreaker = met === 6;
  const priceStr = price.toFixed(2);
  // Confirmed via 4 real Aggressive examples carrying this suffix (IOT,
  // FIGS, RDDT, WRBY) vs. 6 real Moderate examples without it (ONON, UI,
  // TSLA, SHOP, ATRC, ISRG) on 2026-10-20 -- present only in the not-owned
  // pull/half/stretched-half branches below, never in the owned/Hold ones
  // (checked against 7 owned+Aggressive rows, none carry it).
  const aggressiveSuffix = riskType === "Aggressive" ? ` ${riskType}: keep it small.` : "";

  // Bands checked widest/most-specific first. Confirmed via DOCS on
  // 2026-10-20 (met=3, z=2.41 -> "Half size", not "Buy on pullback") that
  // stretched (z>=2) resolves to "Buy" only when met===6; otherwise it's
  // "Half size" with its own stretched-specific wording, not a fall-through
  // to the ordinary pullback band below. The 2026-10-19 historical
  // baseline had zero z>=2/met<6 rows at all, so this branch was
  // previously unconfirmed guesswork; DOCS is the first real data point.
  if (z >= stretchedZThreshold) {
    if (isRuleBreaker) {
      return {
        action: "Buy",
        actionKey: "buy",
        actionWhy: `Stretched above +2σ (${priceStr}). In the backtest these kept rising more often than not; consider a smaller starter position.`,
      };
    }
    return {
      action: "Half size",
      actionKey: "half",
      actionWhy: `Stretched above +2σ (${priceStr}). In the backtest these kept rising more often than not; consider a smaller starter position. Half size (score ${score}).${aggressiveSuffix}`,
    };
  }
  // KNOWN GAP: on 2026-10-20 the real export used this long
  // "but only {met} of 6 signs" clause for some met<6 pull/half rows
  // (IOT, ISRG, SHOP, FIGS, ATRC, TSLA, RDDT) but a shorter "(score
  // {score})." form with no signs-count clause for others (ONON, WRBY) --
  // met alone doesn't separate the two groups (met=4 appears on both
  // sides). Neither form affects action/action_key, only actionWhy's
  // wording, so parity on the fields that matter (action, action_key,
  // score, met, c1-c6, safety, risk_type) is unaffected; this file keeps
  // the long form everywhere rather than guess at the real split.
  if (z >= buyOnPullbackZBand[0]) {
    return {
      action: "Buy on pullback",
      actionKey: "pull",
      actionWhy:
        `${priceStr} is 1–2σ above the VWAP, the weakest spot to buy in the backtest. ` +
        `Set a limit order in the zone ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}.` +
        (isRuleBreaker ? "" : ` Half size: score ${score} but only ${met} of 6 signs, so not a Rule Breaker.`) +
        aggressiveSuffix,
    };
  }
  if (z >= halfSizeZBand[0] && z < halfSizeZBand[1]) {
    return {
      action: "Half size",
      actionKey: "half",
      actionWhy:
        `${priceStr} is inside the buy zone ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}.` +
        (isRuleBreaker ? "" : ` Half size: score ${score} but only ${met} of 6 signs, so not a Rule Breaker.`) +
        aggressiveSuffix,
    };
  }
  // Fallback for bands not yet confirmed (e.g. z<0 shouldn't reach here
  // given vwapState checks above, but guard rather than silently misclassify).
  throw new Error(
    `computeAction: unresolved band for ${inputs.symbol} (z=${z}, met=${met}, vwapState=${vwapState}) -- ` +
      `see vwap.ts header comment, this combination wasn't in the confirmed baseline`,
  );
}
