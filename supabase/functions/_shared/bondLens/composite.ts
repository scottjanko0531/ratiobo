// Bond Lens overlay — §5 Global composite signal (Phase C). Pure,
// Deno-API-free. Combines the six §4 module outputs (already in bond_
// signals, already rescaled to the [-2,+2] module-output contract) into
// duration_score/stance/multiplier, instrument_pref, maturity_pref, and
// an explanation paragraph -- the bond_lens_signal row.

import { Quadrant, TrendState } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";
import { lagDaysThenAlign, rollingZScoreSeries } from "./normalize.ts";
import { curveKnotsAt, carryAndRolldown, CarryHistoryInputs } from "./carry.ts";
import { spliceAcmWithFallback } from "./valuation.ts";
import { BondLensHistoryInputs, BondLensDayRow } from "./scoring.ts";

export type DurationStance = "Short" | "Neutral" | "Extend" | "Max extend";

export interface DurationScoreResult {
  raw: number; // weighted sum, before the trend gate
  score: number; // after the trend gate cap
  stance: DurationStance;
  multiplier: number;
}

// §5.1. Weights sum to 1.00 (0.30+0.25+0.20+0.15+0.10). Trend gate caps
// the (already-weighted) score, not any individual module: down -> 0,
// mixed -> +0.75, up -> uncapped.
export function durationScore(
  valuation: number, path: number, carry: number, quadrant: number, curve: number, trendState: TrendState,
): DurationScoreResult {
  const raw = 0.30 * valuation + 0.25 * path + 0.20 * carry + 0.15 * quadrant + 0.10 * curve;
  let score = raw;
  if (trendState === "down") score = Math.min(score, 0);
  else if (trendState === "mixed") score = Math.min(score, 0.75);

  // §5.2 stance table. Boundary judgment call: a raw score > 1.0 that
  // doesn't also have trend = up (impossible for "mixed" or "down" after
  // the gate above, since those cap below 1.0 already -- this only
  // matters for a literal reading of the table's row order) falls back
  // to "Extend" rather than being left unclassified, since nothing else
  // in the table claims that region.
  let stance: DurationStance, multiplier: number;
  if (score < -0.75) { stance = "Short"; multiplier = 0.5; }
  else if (score <= 0.5) { stance = "Neutral"; multiplier = 1.0; }
  else if (score > 1.0 && trendState === "up") { stance = "Max extend"; multiplier = 1.6; }
  else { stance = "Extend"; multiplier = 1.3; }

  return { raw, score, stance, multiplier };
}

export type InstrumentPref = "Bills / short TIPS" | "TIPS-tilted" | "Nominal-tilted";

const STANCE_RANK: Record<DurationStance, number> = { Short: 0, Neutral: 1, Extend: 2, "Max extend": 3 };

// §5.3, evaluated in order, first match wins. `hedgeReliable === false`
// specifically (not null) -- a degraded/unknown hedge reading doesn't
// trigger the defensive tilt, since there's no basis for it; it falls
// through to the breakeven/quadrant rule instead.
export function instrumentPref(
  hedgeReliable: boolean | null, stance: DurationStance, breakevenGapBp: number | null, quadrant: Quadrant | null,
): InstrumentPref {
  if (hedgeReliable === false && STANCE_RANK[stance] <= STANCE_RANK.Neutral) return "Bills / short TIPS";
  if ((breakevenGapBp != null && breakevenGapBp > 25) || quadrant === "Q2" || quadrant === "Q3") return "TIPS-tilted";
  return "Nominal-tilted";
}

export type MaturityYears = 2 | 5 | 7 | 10;
export type EffTable = Record<MaturityYears, number | null>;

// §5.4: highest EFF_n among {2,5,7,10}; Max extend overrides to 10y
// regardless of which maturity actually has the highest EFF. Null if
// every maturity's EFF is unavailable that day (caller should skip the
// composite row entirely in that case -- bond_lens_signal.maturity_pref
// is NOT NULL).
export function maturityPref(effTable: EffTable, stance: DurationStance): `${MaturityYears}y` | null {
  if (stance === "Max extend") return "10y";
  let best: number | null = null;
  let bestN: MaturityYears | null = null;
  for (const n of [2, 5, 7, 10] as MaturityYears[]) {
    const v = effTable[n];
    if (v != null && (best == null || v > best)) { best = v; bestN = n; }
  }
  return bestN == null ? null : (`${bestN}y` as `${MaturityYears}y`);
}

export interface ExplanationInputs {
  durationScore: number;
  durationStance: DurationStance;
  trendState: TrendState;
  realYieldGapPct: number | null; // DFII10 - rstar, percentage points
  dfii10Pct: number | null;
  rstarPct: number | null;
  termPremiumZ: number | null;
  curveRegime: string | null;
  curveRegimeSince: string | null;
  hedgeReliable: boolean | null;
  instrumentPref: InstrumentPref;
  maturityPref: `${MaturityYears}y` | null;
  maturityEff: number | null; // EFF_n at maturityPref, decimal (e.g. 0.011 -> "1.1%")
}

export interface ExplanationResult {
  text: string;
  drivers: Record<string, unknown>;
}

// §5.5: a plain-English paragraph plus structured drivers, in the spirit
// of the spec's own worked example. Omits the exact realized SPY/IEF
// correlation number in the hedge sentence (not persisted per-day in
// bond_signals, only the boolean hedge_reliable is) -- says "reliable"/
// "not a reliable hedge" instead, which is the only piece the stance/
// instrument decision itself actually depends on.
export function buildExplanation(x: ExplanationInputs): ExplanationResult {
  const parts: string[] = [];
  parts.push(`Duration: ${x.durationStance} (score ${x.durationScore.toFixed(2)}).`);

  if (x.realYieldGapPct != null && x.rstarPct != null && x.dfii10Pct != null) {
    const favorable = x.realYieldGapPct > 0 ? "favorable" : "unfavorable";
    let sentence = `Valuation ${favorable} (real 10y ${x.dfii10Pct.toFixed(1)}% vs r-star ${x.rstarPct.toFixed(1)}%`;
    if (x.termPremiumZ != null) sentence += `; term premium z ${x.termPremiumZ >= 0 ? "+" : ""}${x.termPremiumZ.toFixed(1)}`;
    sentence += ").";
    parts.push(sentence);
  }

  if (x.trendState === "mixed") parts.push("Trend is mixed, capping the score.");
  else if (x.trendState === "down") parts.push("Trend is down, capping the score at 0.");

  if (x.curveRegime != null) {
    const label = x.curveRegime.replace(/_/g, " ");
    parts.push(`Curve regime: ${label}${x.curveRegimeSince ? ` since ${x.curveRegimeSince}` : ""}.`);
  }

  if (x.hedgeReliable === false) {
    parts.push(`Bonds not a reliable hedge for equities right now — tilt toward ${x.instrumentPref === "TIPS-tilted" ? "TIPS" : "bills/short TIPS"}.`);
  } else if (x.hedgeReliable === true && x.instrumentPref === "TIPS-tilted") {
    parts.push("Bonds still hedge equities, but breakevens or the macro quadrant favor TIPS.");
  }

  if (x.maturityPref != null) {
    let sentence = `Best carry per unit risk: ${x.maturityPref}`;
    if (x.maturityEff != null) sentence += ` (breakeven rise ${(x.maturityEff * 100).toFixed(1)}%)`;
    sentence += ".";
    parts.push(sentence);
  }

  return {
    text: parts.join(" "),
    drivers: {
      duration: { score: x.durationScore, stance: x.durationStance },
      valuation: { realYieldGapPct: x.realYieldGapPct, dfii10Pct: x.dfii10Pct, rstarPct: x.rstarPct, termPremiumZ: x.termPremiumZ },
      trend: { state: x.trendState },
      curve: { regime: x.curveRegime, since: x.curveRegimeSince },
      hedge: { reliable: x.hedgeReliable },
      maturity: { pref: x.maturityPref, eff: x.maturityEff },
    },
  };
}

export interface BondLensSignalRow {
  as_of_date: string;
  duration_score: number;
  duration_stance: DurationStance;
  duration_multiplier: number;
  instrument_pref: InstrumentPref;
  maturity_pref: `${MaturityYears}y`;
  hedge_reliable: boolean;
  curve_regime: string | null;
  quadrant: string | null;
  explanation: Record<string, unknown>;
}

// Builds bond_lens_signal rows from an ALREADY-COMPUTED dayRows array
// (one call to computeBondLensHistory, reused -- not redone here) plus
// the same `inputs` that produced it. Only recomputes the pieces dayRows
// doesn't carry: r-star lagged-and-aligned (for the explanation's real-
// yield-gap sentence), term premium's own z (ditto), and the per-
// maturity EFF table (§5.4). All three are O(n) (no window rescanning),
// same CPU-budget discipline as scoring.ts's own z-scoring fix -- this
// was checked empirically after deploying, not just assumed.
//
// Returns one row per trading day where ALL of duration_score's inputs,
// trend_state, hedge_reliable, and at least one maturity's EFF are
// present -- `null` otherwise (bond_lens_signal's columns are NOT NULL,
// so a day with any missing piece is simply not inserted, rather than
// inserted with a placeholder).
export function computeBondLensSignalHistory(
  dayRows: BondLensDayRow[], inputs: BondLensHistoryInputs, cfg = BOND_LENS_CONFIG,
): (BondLensSignalRow | null)[] {
  const { dates } = inputs;
  const n = dates.length;

  const rstarLagged = lagDaysThenAlign(dates, inputs.rstar, cfg.rstarLagDays, 100);
  const splicedTermPremium = spliceAcmWithFallback(inputs.acm, inputs.threefytp10);
  const termPremiumZSeries = rollingZScoreSeries(splicedTermPremium, cfg);

  const out: (BondLensSignalRow | null)[] = new Array(n);
  for (let t = 0; t < n; t++) {
    const day = dayRows[t];
    if (
      day.valuation_score == null || day.path_score == null || day.carry_score == null ||
      day.quadrant_score == null || day.curve_score == null || day.trend_state == null ||
      day.hedge_reliable == null
    ) {
      out[t] = null;
      continue;
    }

    const knots = curveKnotsAt(inputs as unknown as CarryHistoryInputs, t);
    const effTable: EffTable = {
      2: carryAndRolldown(knots, 2).EFF, 5: carryAndRolldown(knots, 5).EFF,
      7: carryAndRolldown(knots, 7).EFF, 10: carryAndRolldown(knots, 10).EFF,
    };

    // BondLensDayRow types trend_state as a plain string (it also backs
    // the bond_signals.trend_state text column); narrowed here since
    // scoring.ts's trendFilter() only ever sets it to "up"/"down"/"mixed"
    // or null, and the null case was already filtered out above.
    const trendState = day.trend_state as TrendState;
    const dur = durationScore(day.valuation_score, day.path_score, day.carry_score, day.quadrant_score, day.curve_score, trendState);
    const instr = instrumentPref(day.hedge_reliable, dur.stance, day.breakeven_gap_bp, day.quadrant as Quadrant | null);
    const maturity = maturityPref(effTable, dur.stance);
    if (maturity == null) { out[t] = null; continue; }

    const dfii10Pct = inputs.dfii10[t];
    const rstarPct = rstarLagged[t];
    const realYieldGapPct = dfii10Pct != null && rstarPct != null ? dfii10Pct - rstarPct : null;
    const termPremiumZ = termPremiumZSeries[t].z;
    const maturityN = Number(maturity.slice(0, -1)) as MaturityYears;

    const { text, drivers } = buildExplanation({
      durationScore: dur.score, durationStance: dur.stance, trendState,
      realYieldGapPct, dfii10Pct, rstarPct, termPremiumZ,
      curveRegime: day.curve_regime, curveRegimeSince: null, // regimeSince isn't carried on BondLensDayRow -- see decisions.md
      hedgeReliable: day.hedge_reliable, instrumentPref: instr, maturityPref: maturity, maturityEff: effTable[maturityN],
    });

    out[t] = {
      as_of_date: dates[t],
      duration_score: dur.score, duration_stance: dur.stance, duration_multiplier: dur.multiplier,
      instrument_pref: instr, maturity_pref: maturity, hedge_reliable: day.hedge_reliable,
      curve_regime: day.curve_regime, quadrant: day.quadrant,
      explanation: { text, drivers },
    };
  }
  return out;
}
