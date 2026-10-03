// Bond Lens overlay — §5 Global composite signal. Pure, Deno-API-free.
//
// v3 (2026-10-02, Phase E decision): `duration_score`/`duration_stance`/
// `duration_multiplier` are now driven by `valuation_score` ALONE, no
// trend gate, capped at Extend (1.3x) -- Phase E's six-variant backtest
// (docs/specs/bond-lens-phase-e-report.md) found the full 5-module
// composite doesn't beat a constant-1.0x-duration baseline on Sharpe in
// 2015-2026, and loses to simpler variants in one or both halves;
// valuation-only is the simplest variant that beats the baseline in BOTH
// halves AND outperforms every other variant tested, confirmed robust
// under +/-50% threshold/multiplier sensitivity. path_score/carry_score/
// quadrant_score/curve_score/trend_state are still computed (in
// scoring.ts) and still feed `instrument_pref`/`maturity_pref`/the
// explanation text -- they're "context," per Scott's own framing, not
// inputs to the duration decision anymore.

import { Quadrant } from "./types.ts";
import { BOND_LENS_CONFIG } from "./config.ts";
import { lagDaysThenAlign, rollingZScoreSeries, dailyDiff, rollingStdevSeries } from "./normalize.ts";
import { curveKnotsAt, carryAndRolldown, billYieldPct, interpolateYield, CarryHistoryInputs } from "./carry.ts";
import { spliceAcmWithFallback } from "./valuation.ts";
import { BondLensHistoryInputs, BondLensDayRow } from "./scoring.ts";

// "Max extend" dropped in v3 -- it existed only to reward trend=up at a
// score > 1.0, and there's no trend gate left to feed that condition.
// Phase E's backtest found no evidence a 1.6x band is warranted anyway
// (see the report's Test 3/Test 6) -- v1 caps at Extend (1.3x).
export type DurationStance = "Short" | "Neutral" | "Extend";

export interface DurationScoreResult {
  score: number;
  stance: DurationStance;
  multiplier: number;
}

// §5.1/§5.2, v3. `duration_score = valuation_score`, no other module, no
// trend gate. Stance thresholds are the SAME fixed bands the winning
// Phase E backtest actually used (-0.75 / 0.5) -- the backtest tested a
// percentile-based alternative too (see the report's §1), but that
// alternative was diagnostic only and was never the one carried into the
// Test 3 backtest that valuation-only won; keeping the fixed bands here
// is "exactly what was backtested," not a separate judgment call.
export function durationScore(valuation: number): DurationScoreResult {
  const score = valuation;
  let stance: DurationStance, multiplier: number;
  if (score < -0.75) { stance = "Short"; multiplier = 0.5; }
  else if (score <= 0.5) { stance = "Neutral"; multiplier = 1.0; }
  else { stance = "Extend"; multiplier = 1.3; }
  return { score, stance, multiplier };
}

// Snake_case, matching bond_lens_signal's own check constraint exactly
// (bond_lens_signal_instrument_pref_check, from the Phase A migration --
// discovered the hard way when the first live upsert after Phase C
// violated it with the human-readable "Bills / short TIPS" etc.). The
// human-readable form lives in the explanation text only.
//
// v3 scope note: instrument_pref/maturity_pref stay DISPLAY-ONLY -- they
// were never backtested (Phase E only tested the duration decision), so
// Phase D (per-portfolio application) applies ONLY duration_multiplier;
// the per-holding nominal/TIPS mix is left unchanged regardless of what
// this function says. A real backtest of the TIPS-tilt rule vs. a
// constant mix, and the EFF-based maturity choice vs. a fixed 7-10y
// bucket, is a logged follow-up (decisions.md), not blocking Phase D.
export type InstrumentPref = "bills_short_tips" | "tips_tilted" | "nominal_tilted";

const STANCE_RANK: Record<DurationStance, number> = { Short: 0, Neutral: 1, Extend: 2 };

// §5.3, evaluated in order, first match wins. `hedgeReliable === false`
// specifically (not null) -- a degraded/unknown hedge reading doesn't
// trigger the defensive tilt, since there's no basis for it; it falls
// through to the breakeven/quadrant rule instead.
export function instrumentPref(
  hedgeReliable: boolean | null, stance: DurationStance, breakevenGapBp: number | null, quadrant: Quadrant | null,
): InstrumentPref {
  if (hedgeReliable === false && STANCE_RANK[stance] <= STANCE_RANK.Neutral) return "bills_short_tips";
  if ((breakevenGapBp != null && breakevenGapBp > 25) || quadrant === "Q2" || quadrant === "Q3") return "tips_tilted";
  return "nominal_tilted";
}

export type MaturityYears = 2 | 5 | 7 | 10;
const MATURITIES: MaturityYears[] = [2, 5, 7, 10];

// EFF_n: excess carry per unit of yield vol. EFF_n = (CR_n - y_3m) /
// (D_mod(n) * sigma_n), sigma_n = trailing 1-year (252-trading-day) stdev
// of daily changes in y_n, annualized. BE_n (CR_n/D_mod(n), "breakeven
// yield rise") is the older, simpler metric, unchanged, still produced by
// carry.ts's carryAndRolldown -- both stay in the UI per-maturity table.
// Display-only in v3 (see InstrumentPref's own comment) -- not applied to
// any holding by Phase D.
export type EffTable = Record<MaturityYears, number | null>;
export interface MaturityTableEntry { yieldPct: number | null; Dmod: number | null; BE: number | null; EFF: number | null }
export type MaturityTable = Record<MaturityYears, MaturityTableEntry>;

function yieldSeriesForMaturity(inputs: BondLensHistoryInputs, n: MaturityYears): (number | null)[] {
  if (n === 2) return inputs.dgs2;
  if (n === 5) return inputs.dgs5;
  if (n === 7) return inputs.dgs7;
  return inputs.dgs10;
}

// sigma_n for every maturity, O(n) per maturity via dailyDiff +
// rollingStdevSeries -- same incremental-window CPU-budget discipline as
// rollingZScoreSeries. All four tenors {2,5,7,10} are EXACT knots
// (DGS2/5/7/10 directly), so this doesn't need curve interpolation --
// only CR_n/D_mod(n) (via carryAndRolldown, for the n-1 rolldown leg)
// needs the full curve.
function sigmaHistory(inputs: BondLensHistoryInputs): Record<MaturityYears, (number | null)[]> {
  const out = {} as Record<MaturityYears, (number | null)[]>;
  for (const n of MATURITIES) {
    const decimal = yieldSeriesForMaturity(inputs, n).map((v) => (v == null ? null : v / 100));
    const deltas = dailyDiff(decimal);
    const stdevs = rollingStdevSeries(deltas, 252); // 1 trading year
    out[n] = stdevs.map((s) => (s == null ? null : s * Math.sqrt(252)));
  }
  return out;
}

export type MaturityPrefValue = `${MaturityYears}y` | "bills";

// §5.4: highest EFF_n among {2,5,7,10}. No Max-extend override anymore
// (that override is gone along with the stance itself -- v3 dropped it).
// Returns "bills" -- not null -- when every available EFF_n is <= 0 (the
// curve isn't compensating for duration risk anywhere on it) OR when no
// maturity's EFF is computable at all (missing sigma/y_3m/CR data).
// bond_lens_signal.maturity_pref is NOT NULL, so "can't tell, stay in
// cash" is the deliberate fallback for both cases.
export function maturityPref(effTable: EffTable): MaturityPrefValue {
  let best: number | null = null;
  let bestN: MaturityYears | null = null;
  for (const n of MATURITIES) {
    const v = effTable[n];
    if (v != null && (best == null || v > best)) { best = v; bestN = n; }
  }
  if (bestN == null || best == null || best <= 0) return "bills";
  return `${bestN}y` as `${MaturityYears}y`;
}

export interface ExplanationInputs {
  durationScore: number;
  durationStance: DurationStance;
  trendState: string | null; // context only in v3 -- no longer gates or caps the score
  realYieldGapPct: number | null; // DFII10 - rstar, percentage points
  dfii10Pct: number | null;
  rstarPct: number | null;
  termPremiumZ: number | null;
  curveRegime: string | null;
  curveRegimeSince: string | null;
  hedgeReliable: boolean | null;
  inflationRegimeWarning: boolean; // display-only, next to the hedge badge -- see path.ts's stepInflationRegimeWarning
  instrumentPref: InstrumentPref;
  maturityPref: MaturityPrefValue;
  maturityEff: number | null; // Sharpe EFF_n at maturityPref, null for "bills"
  maturityTable: MaturityTable; // full {2,5,7,10} BE_n/EFF_n table, for the UI
}

export interface ExplanationResult {
  text: string;
  drivers: Record<string, unknown>;
}

// §5.5: a plain-English paragraph plus structured drivers. v3: trend/
// curve/quadrant/carry show up here as CONTEXT sentences only -- none of
// them affect durationScore anymore, so their sentences no longer claim
// to "cap" or otherwise change the score.
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

  if (x.trendState != null) parts.push(`Trend (context): ${x.trendState}.`);

  if (x.curveRegime != null) {
    const label = x.curveRegime.replace(/_/g, " ");
    parts.push(`Curve regime (context): ${label}${x.curveRegimeSince ? ` since ${x.curveRegimeSince}` : ""}.`);
  }

  if (x.hedgeReliable === false) {
    parts.push(`Bonds not a reliable hedge for equities right now — tilt toward ${x.instrumentPref === "tips_tilted" ? "TIPS" : "bills/short TIPS"}.`);
  } else if (x.hedgeReliable === true && x.instrumentPref === "tips_tilted") {
    parts.push("Bonds still hedge equities, but breakevens or the macro quadrant favor TIPS.");
  }

  if (x.inflationRegimeWarning) {
    parts.push("Inflation-regime warning (context, not a driver): core PCE is above 3% and not decelerating.");
  }

  if (x.maturityPref === "bills") {
    parts.push("No maturity on the curve compensates for duration risk right now — prefer bills. (Display only.)");
  } else {
    let sentence = `Best carry per unit risk: ${x.maturityPref}`;
    if (x.maturityEff != null) sentence += ` (risk-adjusted carry ${x.maturityEff.toFixed(2)})`;
    sentence += ". (Display only.)";
    parts.push(sentence);
  }

  return {
    text: parts.join(" "),
    drivers: {
      duration: { score: x.durationScore, stance: x.durationStance },
      valuation: { realYieldGapPct: x.realYieldGapPct, dfii10Pct: x.dfii10Pct, rstarPct: x.rstarPct, termPremiumZ: x.termPremiumZ },
      trend: { state: x.trendState, context_only: true },
      curve: { regime: x.curveRegime, since: x.curveRegimeSince, context_only: true },
      hedge: { reliable: x.hedgeReliable },
      inflation_regime_warning: { warning: x.inflationRegimeWarning, context_only: true },
      maturity: { pref: x.maturityPref, eff: x.maturityEff, table: x.maturityTable, display_only: true },
    },
  };
}

export interface BondLensSignalRow {
  as_of_date: string;
  duration_score: number;
  duration_stance: DurationStance;
  duration_multiplier: number;
  instrument_pref: InstrumentPref;
  maturity_pref: MaturityPrefValue;
  hedge_reliable: boolean | null;
  inflation_regime_warning: boolean;
  curve_regime: string | null;
  quadrant: string | null;
  explanation: Record<string, unknown>;
}

// Builds bond_lens_signal rows from an ALREADY-COMPUTED dayRows array
// (one call to computeBondLensHistory, reused -- not redone here) plus
// the same `inputs` that produced it. Only recomputes the pieces dayRows
// doesn't carry: r-star lagged-and-aligned (for the explanation's real-
// yield-gap sentence), term premium's own z (ditto), and the per-maturity
// BE/EFF table. All O(n) (no window rescanning).
//
// Gate, v3 (simplified from the prior "valuation+carry+trend" gate now
// that duration_score depends on valuation ALONE): a row is attempted
// once `valuation_score` is present -- full stop. carry_score/trend_state
// are no longer required (they're context, consumed only by the
// maturity-pref table / explanation text, both of which already degrade
// gracefully on missing data -- maturityPref falls back to "bills" and
// the explanation simply omits a context sentence). This is expected to
// push bond_lens_signal's start back to roughly valuation_score's own
// start (term-premium-only fallback pre-TIPS, ~1962 + z-score warmup),
// well before the prior ~1984 gate.
export function computeBondLensSignalHistory(
  dayRows: BondLensDayRow[], inputs: BondLensHistoryInputs, cfg = BOND_LENS_CONFIG,
): (BondLensSignalRow | null)[] {
  const { dates } = inputs;
  const n = dates.length;

  const rstarLagged = lagDaysThenAlign(dates, inputs.rstar, cfg.rstarLagDays, 100);
  const splicedTermPremium = spliceAcmWithFallback(inputs.acm, inputs.threefytp10);
  const termPremiumZSeries = rollingZScoreSeries(splicedTermPremium, cfg);
  const sigma = sigmaHistory(inputs);

  const out: (BondLensSignalRow | null)[] = new Array(n);
  for (let t = 0; t < n; t++) {
    const day = dayRows[t];
    if (day.valuation_score == null) {
      out[t] = null;
      continue;
    }

    const knots = curveKnotsAt(inputs as unknown as CarryHistoryInputs, t);
    const y3mPct = billYieldPct(inputs as unknown as CarryHistoryInputs, t);
    const y3m = y3mPct == null ? null : y3mPct / 100;

    const maturityTable = {} as MaturityTable;
    const effTable = {} as EffTable;
    for (const mN of MATURITIES) {
      const { CR, Dmod_n, BE } = carryAndRolldown(knots, mN);
      const sigmaN = sigma[mN][t];
      const eff = CR != null && Dmod_n != null && y3m != null && sigmaN != null && sigmaN !== 0
        ? (CR - y3m) / (Dmod_n * sigmaN)
        : null;
      // Market-view per-maturity table (§8, Phase D Step 4): yield and
      // D_mod alongside the existing BE_n/EFF_n -- yieldPct in percent
      // (FRED convention, matching bond_signals' other *Pct fields), not
      // decimal, since this is for display, not further math.
      const yieldDecimal = interpolateYield(knots, mN);
      maturityTable[mN] = { yieldPct: yieldDecimal == null ? null : yieldDecimal * 100, Dmod: Dmod_n, BE, EFF: eff };
      effTable[mN] = eff;
    }

    const dur = durationScore(day.valuation_score);
    const instr = instrumentPref(day.hedge_reliable, dur.stance, day.breakeven_gap_bp, day.quadrant as Quadrant | null);
    const maturity = maturityPref(effTable);

    const dfii10Pct = inputs.dfii10[t];
    const rstarPct = rstarLagged[t];
    const realYieldGapPct = dfii10Pct != null && rstarPct != null ? dfii10Pct - rstarPct : null;
    const termPremiumZ = termPremiumZSeries[t].z;
    const maturityEff = maturity === "bills" ? null : effTable[Number(maturity.slice(0, -1)) as MaturityYears];

    const { text, drivers } = buildExplanation({
      durationScore: dur.score, durationStance: dur.stance, trendState: day.trend_state,
      realYieldGapPct, dfii10Pct, rstarPct, termPremiumZ,
      curveRegime: day.curve_regime, curveRegimeSince: null, // regimeSince isn't carried on BondLensDayRow -- see decisions.md
      hedgeReliable: day.hedge_reliable, inflationRegimeWarning: day.inflation_regime_warning,
      instrumentPref: instr, maturityPref: maturity, maturityEff, maturityTable,
    });

    out[t] = {
      as_of_date: dates[t],
      duration_score: dur.score, duration_stance: dur.stance, duration_multiplier: dur.multiplier,
      instrument_pref: instr, maturity_pref: maturity, hedge_reliable: day.hedge_reliable,
      inflation_regime_warning: day.inflation_regime_warning,
      curve_regime: day.curve_regime, quadrant: day.quadrant,
      explanation: { text, drivers },
    };
  }
  return out;
}
