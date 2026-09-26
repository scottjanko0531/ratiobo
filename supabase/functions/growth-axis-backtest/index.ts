import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ── Dead-band-recalibration spec: forecast-accuracy verification tool ──────────
// No existing code in this repo implements a walk-forward MAE/RMSE/directional-
// hit-rate-vs-naive-baseline backtest of the Structural growth/inflation
// crossover (run-backtest/index.ts is a PORTFOLIO-RETURN backtest — annual-
// rebalanced regime-driven allocation performance — not a forecast-accuracy
// one). This is a standalone, temporary verification tool, deployed and
// curl-invoked for its JSON report rather than shipped as a page feature —
// same pattern as this repo's existing debug-cpi-history/debug-growth-
// composite/cpi-diagnostic functions.
//
// Methodology: at each historical point-in-time cutoff t (using only data
// knowable as of t — no lookahead), score two forecasts of the SAME quantity
// (the raw single-period YoY reading N periods later) against what actually
// happened:
//   naive  = fast(t)                              — "current smoothed level holds flat"
//   model  = fast(t) + N * (fast(t) - slow(t))     — if |fast-slow| > minGap (a real
//            fast(t)  [identical to naive]         — crossover); otherwise Persistence,
//                                                     which is BY DESIGN identical to naive
// Both forecasts share the same "current level" basis (the smoothed fast
// line, not the noisier raw spot reading) so the comparison isolates the
// crossover threshold's own value-add, not smoothing's. Directional hit-rate
// is scored only on periods where a real crossover fired (Persistence makes
// no directional claim, so it can't be scored as a directional hit or miss).
//
// 3-month-forward-forecast spec extensions (kept in the same tool since they
// share the identical walk-forward/point-in-time machinery above):
//   - summarizeStrict/windowedReport: Measure 2 (directional accuracy),
//     defined stricter than the original directionHit above — the actual
//     print must clear the SAME dead band the crossover itself uses to
//     count as a directional move at all, scored only against
//     Accelerating/Decelerating calls, with Persistence periods scored
//     separately as "continuation accuracy" (did the print stay flat).
//     Reported ALONGSIDE the original directionalHitRate, not replacing it,
//     so the two can be directly reconciled.
//   - biasCorrectionTest: should forecast error feed back into future
//     forecasts? Walk-forward expanding-mean and EWMA(a=0.3) bias
//     correction, estimated only from strictly-prior errors at each issue
//     date, scored out-of-sample against the flat naive anchor.
//   - stateConditionalBias: the naive anchor's own mean error by state — the
//     structural check for whether a single running bias term even could
//     work (it can't, if the bias flips sign by state).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;

interface Obs { date: string; value: number; }

async function fetchFredSeries(seriesId: string): Promise<Obs[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=asc&observation_start=1990-01-01`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  const obs = (j.observations ?? []) as { date: string; value: string }[];
  return obs.map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((o) => !isNaN(o.value));
}

// Date-matched (same calendar month, one year earlier) — identical pattern to
// run-backtest.ts's yoy(), avoids the off-by-one a positional offset would
// introduce across any gap in the source series.
function yoy(obs: Obs[]): Obs[] {
  const byDate = new Map(obs.map((o) => [o.date, o.value]));
  const out: Obs[] = [];
  for (const o of obs) {
    const d = new Date(o.date);
    const yaKey = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const prev = byDate.get(yaKey);
    if (prev != null && prev !== 0) out.push({ date: o.date, value: (o.value / prev - 1) * 100 });
  }
  return out;
}

function trailingAvg(series: Obs[], n: number): Obs[] {
  const out: Obs[] = [];
  for (let i = n - 1; i < series.length; i++) {
    const window = series.slice(i - n + 1, i + 1);
    out.push({ date: series[i].date, value: window.reduce((s, o) => s + o.value, 0) / window.length });
  }
  return out;
}

// N periods ahead by calendar arithmetic (not array-index offset), so a gap
// in the source series (e.g. CPIAUCSL's missing October 2025 print) can't
// silently misalign "N periods ahead" into an actual N±1 comparison.
function dateNPeriodsAhead(date: string, n: number, unit: "month" | "quarter"): string {
  const d = new Date(date);
  const monthsAhead = unit === "quarter" ? n * 3 : n;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsAhead, 1)).toISOString().slice(0, 10);
}

interface EvalPoint {
  date: string;
  isSignal: boolean; // true = a real crossover fired (Accelerating/Decelerating), false = Persistence
  state: "accelerating" | "decelerating" | "persistence";
  naive: number; // fast(t) — the level-anchored forecast basis for everything below
  model: number; // momentum-decay forecast — kept only for the original MAE/RMSE-vs-naive comparison
  actual: number;
  naiveAbsErr: number;
  modelAbsErr: number;
  naiveSqErr: number;
  modelSqErr: number;
  directionHit: boolean | null; // ORIGINAL definition: sign(model-naive) vs sign(actual-naive), any nonzero move counts
  actualDirection: "up" | "down" | "flat"; // dead-band-recalibration spec's Measure 2: actual vs level-at-issue, classified with the SAME dead band as the crossover itself
  strictDirectionalHit: boolean | null; // Measure 2: state's Accelerating/Decelerating call vs actualDirection — null for Persistence (no directional claim)
  continuationHit: boolean | null; // Persistence periods only: did the actual print stay inside the dead band as predicted
  gap: number; // raw fast-slow gap BEFORE dead-band thresholding — needed for the mixed-case "leaning" (nearSide) quadrant test, which uses which side of zero a Persistence axis's gap sits on even though it didn't clear the dead band
  targetDate: string; // issue date + horizon — the calendar period `actual` belongs to, needed to key a CSV export by target month rather than issue month
}

function walkForward(
  rawYoy: Obs[], fast: Obs[], slow: Obs[], minGap: number, horizonN: number, unit: "month" | "quarter"
): EvalPoint[] {
  const actualByDate = new Map(rawYoy.map((o) => [o.date, o.value]));
  const slowByDate = new Map(slow.map((o) => [o.date, o.value]));
  const points: EvalPoint[] = [];
  for (const f of fast) {
    const s = slowByDate.get(f.date);
    if (s == null) continue;
    const targetDate = dateNPeriodsAhead(f.date, horizonN, unit);
    const actual = actualByDate.get(targetDate);
    if (actual == null) continue; // future not yet realized, or a gap — skip, don't guess

    const gap = f.value - s;
    const isSignal = Math.abs(gap) > minGap;
    const state: EvalPoint["state"] = !isSignal ? "persistence" : gap > 0 ? "accelerating" : "decelerating";
    const naive = f.value;
    const model = isSignal ? f.value + horizonN * gap : f.value;

    const naiveAbsErr = Math.abs(actual - naive);
    const modelAbsErr = Math.abs(actual - model);
    const directionHit = isSignal
      ? Math.sign(model - naive) === Math.sign(actual - naive) || Math.abs(actual - naive) < 1e-9
      : null;

    // dead-band-recalibration spec, Measure 2: the actual print only counts
    // as having moved "Up"/"Down" if it clears the SAME dead band the
    // crossover itself uses — a nonzero wiggle inside the band is "Flat,"
    // not a directional move. This is stricter than directionHit above
    // (which counts any nonzero sign) and is scored only against the
    // state's own Accelerating/Decelerating call, never the momentum-decay
    // model's magnitude.
    const actualDelta = actual - naive;
    const actualDirection: EvalPoint["actualDirection"] = actualDelta > minGap ? "up" : actualDelta < -minGap ? "down" : "flat";
    const strictDirectionalHit = state === "accelerating" ? actualDirection === "up"
      : state === "decelerating" ? actualDirection === "down"
      : null;
    const continuationHit = state === "persistence" ? actualDirection === "flat" : null;

    points.push({
      date: f.date, isSignal, state, naive, model, actual,
      naiveAbsErr, modelAbsErr,
      naiveSqErr: naiveAbsErr ** 2, modelSqErr: modelAbsErr ** 2,
      directionHit, actualDirection, strictDirectionalHit, continuationHit, gap, targetDate,
    });
  }
  return points;
}

function summarize(points: EvalPoint[]) {
  if (points.length === 0) {
    return { n: 0, nSignal: 0, naiveMAE: null, modelMAE: null, naiveRMSE: null, modelRMSE: null, directionalHitRate: null, beatsNaiveMAE: null, beatsNaiveRMSE: null };
  }
  const n = points.length;
  const naiveMAE = points.reduce((s, p) => s + p.naiveAbsErr, 0) / n;
  const modelMAE = points.reduce((s, p) => s + p.modelAbsErr, 0) / n;
  const naiveRMSE = Math.sqrt(points.reduce((s, p) => s + p.naiveSqErr, 0) / n);
  const modelRMSE = Math.sqrt(points.reduce((s, p) => s + p.modelSqErr, 0) / n);
  const signalPoints = points.filter((p) => p.isSignal);
  const hits = signalPoints.filter((p) => p.directionHit === true).length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    n, nSignal: signalPoints.length,
    naiveMAE: r2(naiveMAE), modelMAE: r2(modelMAE),
    naiveRMSE: r2(naiveRMSE), modelRMSE: r2(modelRMSE),
    directionalHitRate: signalPoints.length ? r2((hits / signalPoints.length) * 100) : null,
    beatsNaiveMAE: modelMAE < naiveMAE,
    beatsNaiveRMSE: modelRMSE < naiveRMSE,
  };
}

// dead-band-recalibration spec, Measure 2: directional accuracy scored ONLY
// over real Accelerating/Decelerating calls (a Persistence period is a
// continuation claim, not a directional one, and must not dilute or inflate
// this rate — see continuationAccuracy below for its own separate score).
// This is deliberately reported ALONGSIDE the original directionalHitRate
// (Math.sign-based, no dead-band on the actual side) in summarize() above,
// not in place of it, so the two can be directly compared/reconciled.
function summarizeStrict(points: EvalPoint[]) {
  const callPoints = points.filter((p) => p.state !== "persistence");
  const persistPoints = points.filter((p) => p.state === "persistence");
  const hits = callPoints.filter((p) => p.strictDirectionalHit === true).length;
  const contHits = persistPoints.filter((p) => p.continuationHit === true).length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    nCalls: callPoints.length,
    nHits: hits,
    strictDirectionalHitRate: callPoints.length ? r2((hits / callPoints.length) * 100) : null,
    strictDirectionalHitCI: callPoints.length ? wilsonCI(hits, callPoints.length) : null,
    nPersistence: persistPoints.length,
    continuationAccuracy: persistPoints.length ? r2((contHits / persistPoints.length) * 100) : null,
  };
}

function windowedReport(points: EvalPoint[], nowDate: string) {
  const cutoff3y = new Date(nowDate); cutoff3y.setUTCFullYear(cutoff3y.getUTCFullYear() - 3);
  const cutoff5y = new Date(nowDate); cutoff5y.setUTCFullYear(cutoff5y.getUTCFullYear() - 5);
  const c3 = cutoff3y.toISOString().slice(0, 10);
  const c5 = cutoff5y.toISOString().slice(0, 10);
  return {
    fullHistory: { ...summarize(points), ...summarizeStrict(points) },
    trailing5yr: { ...summarize(points.filter((p) => p.date >= c5)), ...summarizeStrict(points.filter((p) => p.date >= c5)) },
    trailing3yr: { ...summarize(points.filter((p) => p.date >= c3)), ...summarizeStrict(points.filter((p) => p.date >= c3)) },
  };
}

// Walk-forward bias-correction test (dead-band-recalibration spec's
// error-feedback question): at each issue date, estimate a bias correction
// using ONLY errors from periods strictly before it (an expanding mean, and
// separately an EWMA(alpha=0.3)) — nothing looks ahead. minHistory is a
// burn-in: too few prior points makes the bias estimate itself noise, not
// signal, so those early periods are excluded from the OOS comparison
// entirely rather than scored on a near-meaningless correction.
function biasCorrectionTest(points: EvalPoint[], minHistory = 8, alpha = 0.3) {
  const priorErrors: number[] = []; // signed: actual - naive
  let ewma: number | null = null;
  let sumNaiveAbs = 0, sumExpAbs = 0, sumEwmaAbs = 0, nOOS = 0;
  for (const p of points) {
    const signedErr = p.actual - p.naive;
    if (priorErrors.length >= minHistory) {
      const expBias = priorErrors.reduce((a, b) => a + b, 0) / priorErrors.length;
      const ewmaBias = ewma ?? 0;
      sumNaiveAbs += Math.abs(p.actual - p.naive);
      sumExpAbs += Math.abs(p.actual - (p.naive + expBias));
      sumEwmaAbs += Math.abs(p.actual - (p.naive + ewmaBias));
      nOOS++;
    }
    priorErrors.push(signedErr);
    ewma = ewma == null ? signedErr : alpha * signedErr + (1 - alpha) * ewma;
  }
  if (nOOS === 0) return null;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const naiveMAE = sumNaiveAbs / nOOS, expMAE = sumExpAbs / nOOS, ewmaMAE = sumEwmaAbs / nOOS;
  return {
    nOOS, minHistory, alpha,
    naiveMAE: r2(naiveMAE),
    expandingMeanMAE: r2(expMAE), expandingMeanImprovementPct: r2((1 - expMAE / naiveMAE) * 100),
    ewmaMAE: r2(ewmaMAE), ewmaImprovementPct: r2((1 - ewmaMAE / naiveMAE) * 100),
  };
}

// State-conditional mean error — the structural argument for why a single
// running bias term can/can't work: if the naive forecast's own error
// already flips sign by state (overshoots in one, undershoots in another),
// a single running correction is chasing three different targets at once.
function stateConditionalBias(points: EvalPoint[]) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const byState = (state: EvalPoint["state"]) => {
    const pts = points.filter((p) => p.state === state);
    if (pts.length === 0) return null;
    const errs = pts.map((p) => p.actual - p.naive);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const variance = errs.reduce((s, v) => s + (v - mean) ** 2, 0) / errs.length;
    return { n: pts.length, meanError: r2(mean), sd: r2(Math.sqrt(variance)) };
  };
  return {
    accelerating: byState("accelerating"),
    decelerating: byState("decelerating"),
    persistence: byState("persistence"),
  };
}

function wilsonCI(hits: number, n: number): { low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.96;
  const phat = hits / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  const r1 = (x: number) => Math.round(x * 1000) / 10; // fraction -> percentage, 1 decimal
  return { low: r1((center - margin) / denom), high: r1((center + margin) / denom) };
}

// Momentum/reversal transition test (user question, not part of any shipped
// spec): restricted to non-persistence (Accelerating/Decelerating) periods
// only, walked chronologically and skipping over any Persistence periods in
// between — they have no directional call of their own to condition on, so
// "prior period" here means the prior CALL period, not the prior calendar
// period. Question: given the prior call period's realized direction (dead-
// band-classified Up/Down, the SAME actualDirection already used for
// strictDirectionalHitRate), does that predict the NEXT call period's
// direction better than (a) a coin flip, (b) the unconditional base rate of
// Up vs Down among calls seen so far, or (c) the axis's own state call for
// that period (already reported as strictDirectionalHitRate)? Walk-forward
// throughout — the transition table and the base rate are both rebuilt from
// ONLY prior observations at each step, same no-lookahead discipline as
// biasCorrectionTest above. axisOwnCallHitRateSamePeriods re-scores the
// existing axis call over the EXACT same restricted period set (same n) so
// the comparison to what's already shipped is apples-to-apples.
function momentumTransitionTest(points: EvalPoint[], minHistory = 6) {
  const calls = points
    .filter((p) => p.state !== "persistence" && (p.actualDirection === "up" || p.actualDirection === "down"))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const transitionCounts = { up: { up: 0, down: 0 }, down: { up: 0, down: 0 } };
  let seenUp = 0, seenDown = 0;
  let nOOS = 0, momentumHits = 0, reversalHits = 0, transitionHits = 0, baseRateHits = 0, ownCallHits = 0;
  const detail: { date: string; prevDir: string; actual: string; transitionPredicted: string; hit: boolean }[] = [];

  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const cur = calls[i];
    const prevDir = prev.actualDirection as "up" | "down";
    const actual = cur.actualDirection as "up" | "down";
    const seenTotal = seenUp + seenDown;

    if (seenTotal >= minHistory) {
      const c = transitionCounts[prevDir];
      const transitionPredicted: "up" | "down" = c.up > c.down ? "up" : c.down > c.up ? "down" : prevDir;
      const momentumPredicted: "up" | "down" = prevDir;
      const reversalPredicted: "up" | "down" = prevDir === "up" ? "down" : "up";
      const baseRatePredicted: "up" | "down" = seenUp >= seenDown ? "up" : "down";

      if (transitionPredicted === actual) transitionHits++;
      if (momentumPredicted === actual) momentumHits++;
      if (reversalPredicted === actual) reversalHits++;
      if (baseRatePredicted === actual) baseRateHits++;
      if (cur.strictDirectionalHit === true) ownCallHits++;
      nOOS++;
      detail.push({ date: cur.date, prevDir, actual, transitionPredicted, hit: transitionPredicted === actual });
    }

    transitionCounts[prevDir][actual]++;
    if (actual === "up") seenUp++; else seenDown++;
  }

  if (nOOS === 0) return null;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const rate = (hits: number) => r2((hits / nOOS) * 100);
  return {
    nOOS, minHistory,
    finalTransitionCounts: transitionCounts,
    transitionModelHitRate: rate(transitionHits), transitionModelCI: wilsonCI(transitionHits, nOOS),
    pureMomentumHitRate: rate(momentumHits), pureMomentumCI: wilsonCI(momentumHits, nOOS),
    pureReversalHitRate: rate(reversalHits), pureReversalCI: wilsonCI(reversalHits, nOOS),
    unconditionalBaseRateHitRate: rate(baseRateHits),
    axisOwnCallHitRateSamePeriods: rate(ownCallHits),
    detail: detail.slice(-20),
  };
}

// 3-state version of momentumTransitionTest above: up/flat/down instead of
// up/down-only. This uses the FULL non-persistence call set (same nCalls as
// summarizeStrict — 44 for CPI, 25 for GDP) rather than the binary version's
// much smaller subset that silently dropped every call whose actual print
// came in flat. That drop turned out to be the real story for CPI (27 of 44
// calls resolved flat, not opposite-direction), so folding flat back in as
// its own state is what actually answers "does knowing the prior period's
// realized state predict the next one" on a real sample size, not a
// temporally-clustered handful of points from one or two macro episodes.
// Same walk-forward, no-lookahead discipline throughout.
function momentumTransitionTest3State(points: EvalPoint[], minHistory = 6) {
  type Dir3 = "up" | "flat" | "down";
  const dirs: Dir3[] = ["up", "flat", "down"];
  const calls = points
    .filter((p) => p.state !== "persistence")
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const zeroRow = (): Record<Dir3, number> => ({ up: 0, flat: 0, down: 0 });
  const transitionCounts: Record<Dir3, Record<Dir3, number>> = { up: zeroRow(), flat: zeroRow(), down: zeroRow() };
  const seenCounts: Record<Dir3, number> = zeroRow();
  let nOOS = 0, transitionHits = 0, repeatHits = 0, baseRateHits = 0, ownCallHits = 0;
  const detail: { date: string; prevDir: Dir3; actual: Dir3; transitionPredicted: Dir3; hit: boolean }[] = [];

  const argmax = (row: Record<Dir3, number>, fallback: Dir3): Dir3 => {
    let best = fallback;
    for (const d of dirs) if (row[d] > row[best]) best = d;
    return best;
  };

  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const cur = calls[i];
    const prevDir = prev.actualDirection as Dir3;
    const actual = cur.actualDirection as Dir3;
    const seenTotal = seenCounts.up + seenCounts.flat + seenCounts.down;

    if (seenTotal >= minHistory) {
      const transitionPredicted = argmax(transitionCounts[prevDir], prevDir); // "repeat prior state" is the tie-break/cold-start fallback
      const repeatPredicted: Dir3 = prevDir; // pure "whatever just happened, happens again" hypothesis
      const baseRatePredicted = argmax(seenCounts, "up");

      if (transitionPredicted === actual) transitionHits++;
      if (repeatPredicted === actual) repeatHits++;
      if (baseRatePredicted === actual) baseRateHits++;
      if (cur.strictDirectionalHit === true) ownCallHits++; // flat actual can never hit here — by design, matches strictDirectionalHitRate exactly over this same set
      nOOS++;
      detail.push({ date: cur.date, prevDir, actual, transitionPredicted, hit: transitionPredicted === actual });
    }

    transitionCounts[prevDir][actual]++;
    seenCounts[actual]++;
  }

  if (nOOS === 0) return null;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const rate = (hits: number) => r2((hits / nOOS) * 100);
  const finalTransitionProbs: Record<Dir3, Record<Dir3, number> | null> = { up: null, flat: null, down: null };
  for (const d of dirs) {
    const row = transitionCounts[d];
    const total = row.up + row.flat + row.down;
    finalTransitionProbs[d] = total > 0
      ? { up: r2((row.up / total) * 100), flat: r2((row.flat / total) * 100), down: r2((row.down / total) * 100) }
      : null;
  }
  return {
    nOOS, minHistory,
    finalTransitionCounts: transitionCounts,
    finalTransitionProbsPct: finalTransitionProbs, // e.g. finalTransitionProbsPct.flat.flat = P(next is flat | prior was flat)
    transitionModelHitRate: rate(transitionHits), transitionModelCI: wilsonCI(transitionHits, nOOS),
    pureRepeatHitRate: rate(repeatHits), pureRepeatCI: wilsonCI(repeatHits, nOOS),
    unconditionalBaseRateHitRate: rate(baseRateHits),
    axisOwnCallHitRateSamePeriods: rate(ownCallHits),
    detail: detail.slice(-20),
  };
}

// Regime (quadrant) accuracy for current settings (user question): every
// prior measure in this file scores growth and inflation SEPARATELY —
// nothing has checked the actual product-facing claim, which is a joint
// quadrant (Reflation/Stagflation/Disinflationary Boom/Deflationary Bust),
// built from BOTH axes together. Matches gdpPoints (quarterly) against
// cpiPoints (monthly, filtered to the same quarter-start dates) by date.
// Two cleanly-defined cases, scored separately (never blended, same
// discipline as summarizeStrict):
//   - jointRealCall: both axes fired a real Accelerating/Decelerating call
//     at issue time — the model is predicting a FRESH quadrant. Scored a
//     hit only if BOTH axes' actual moves also cleared their own dead band
//     in the predicted direction (either axis coming in "flat" means the
//     predicted quadrant never fully materialized — scored a miss, not
//     excluded, since "the regime didn't actually get there" is a real
//     forecast failure, not an inapplicable case).
//   - jointPersistence: both axes were in Persistence at issue time — the
//     model's claim is "the current quadrant holds." Scored a hit if BOTH
//     axes' actual moves also stayed inside their own dead band.
//   - jointMixed: one axis real, one Persistence — the product's "leaning
//     quadrant" case. The Persistent axis's predicted direction is its
//     nearSide (which side of zero its own sub-threshold gap sits on —
//     mirrors app/macro/page.jsx's leaningQuadrantKey display logic exactly,
//     just computed from the backtest's own gap rather than live data).
//     Scored with the SAME strict rule as jointRealCall: a hit requires
//     BOTH axes' actual moves to clear their own dead band in the predicted
//     direction — the Persistent axis's actual is held to the same bar as
//     if it had made a real call, since that's what the leaning display is
//     implicitly claiming.
// overall: all three cases pooled by their natural frequency — the single
// number "how accurate is a regime read under current settings," blending
// however often each case actually occurs across the full history.
function regimeQuadrant(g: "accelerating" | "decelerating", i: "accelerating" | "decelerating"): string {
  if (g === "accelerating" && i === "accelerating") return "Reflation";
  if (g === "accelerating" && i === "decelerating") return "Disinflationary Boom";
  if (g === "decelerating" && i === "accelerating") return "Stagflation";
  return "Deflationary Bust";
}
function regimeAccuracyTest(gdpPoints: EvalPoint[], cpiPoints: EvalPoint[]) {
  const cpiByDate = new Map(cpiPoints.map((p) => [p.date, p]));
  let nRealCalls = 0, nRealHits = 0, nPersist = 0, nPersistHits = 0, nMixed = 0, nMixedHits = 0;
  const realDetail: { date: string; predicted: string; actual: string; hit: boolean }[] = [];
  const mixedDetail: { date: string; predicted: string; actual: string; hit: boolean }[] = [];
  const nearSide = (gap: number): "accelerating" | "decelerating" => (gap > 0 ? "accelerating" : "decelerating");
  for (const g of gdpPoints) {
    const c = cpiByDate.get(g.date);
    if (!c) continue;
    if (g.state !== "persistence" && c.state !== "persistence") {
      const predicted = regimeQuadrant(g.state as "accelerating" | "decelerating", c.state as "accelerating" | "decelerating");
      const bothCleared = g.actualDirection !== "flat" && c.actualDirection !== "flat";
      const actual = bothCleared
        ? regimeQuadrant(g.actualDirection === "up" ? "accelerating" : "decelerating", c.actualDirection === "up" ? "accelerating" : "decelerating")
        : `ambiguous (${g.actualDirection === "flat" ? "growth" : "inflation"} stayed flat)`;
      const hit = bothCleared && predicted === actual;
      nRealCalls++; if (hit) nRealHits++;
      realDetail.push({ date: g.date, predicted, actual, hit });
    } else if (g.state === "persistence" && c.state === "persistence") {
      nPersist++;
      if (g.continuationHit === true && c.continuationHit === true) nPersistHits++;
    } else {
      // Exactly one axis real, one Persistence — leaning-quadrant case.
      const gGrowth = g.state === "persistence" ? nearSide(g.gap) : (g.state as "accelerating" | "decelerating");
      const gInfl = c.state === "persistence" ? nearSide(c.gap) : (c.state as "accelerating" | "decelerating");
      const predicted = regimeQuadrant(gGrowth, gInfl);
      const bothCleared = g.actualDirection !== "flat" && c.actualDirection !== "flat";
      const actual = bothCleared
        ? regimeQuadrant(g.actualDirection === "up" ? "accelerating" : "decelerating", c.actualDirection === "up" ? "accelerating" : "decelerating")
        : `ambiguous (${g.actualDirection === "flat" ? "growth" : "inflation"} stayed flat)`;
      const hit = bothCleared && predicted === actual;
      nMixed++; if (hit) nMixedHits++;
      mixedDetail.push({ date: g.date, predicted, actual, hit });
    }
  }
  const r1 = (x: number) => Math.round(x * 1000) / 10; // fraction -> percentage, 1 decimal
  const nTotal = nRealCalls + nPersist + nMixed;
  const nTotalHits = nRealHits + nPersistHits + nMixedHits;
  return {
    jointRealCall: {
      n: nRealCalls, nHits: nRealHits,
      hitRatePct: nRealCalls ? r1(nRealHits / nRealCalls) : null,
      hitRateCI: nRealCalls ? wilsonCI(nRealHits, nRealCalls) : null,
      detail: realDetail,
    },
    jointPersistence: {
      n: nPersist, nHits: nPersistHits,
      hitRatePct: nPersist ? r1(nPersistHits / nPersist) : null,
      hitRateCI: nPersist ? wilsonCI(nPersistHits, nPersist) : null,
    },
    jointMixed: {
      n: nMixed, nHits: nMixedHits,
      hitRatePct: nMixed ? r1(nMixedHits / nMixed) : null,
      hitRateCI: nMixed ? wilsonCI(nMixedHits, nMixed) : null,
      detail: mixedDetail,
    },
    overall: {
      n: nTotal, nHits: nTotalHits,
      hitRatePct: nTotal ? r1(nTotalHits / nTotal) : null,
      hitRateCI: nTotal ? wilsonCI(nTotalHits, nTotal) : null,
    },
  };
}

// Level-vs-fixed-baseline test (user question, comparing our momentum/
// crossover model against a level-anchored one like 42 Macro's GRID —
// same fixed 2015-2019 window and z-score math as this repo's own
// computeFixedWindowZScore in fetch-macro-data/index.ts, just walked
// forward here). Genuinely different hypothesis from everything else in
// this file: instead of "is the recent trend pulling away from its own
// longer trend" (crossover/momentum), this asks "is the CURRENT reading
// abnormally far from a fixed pre-COVID normal" (level/deviation-from-
// anchor). The two can and do disagree.
// Directional ambiguity is real and untested, so both readings of what an
// elevated/subdued z-score implies are scored, exactly like the momentum-
// vs-reversal treatment above:
//   - momentum: elevated z predicts the actual keeps moving up; subdued
//     predicts it keeps moving down (the level equivalent of "the
//     hot/cold reading is itself the forecast").
//   - reversion: elevated z predicts the actual mean-reverts down toward
//     baseline; subdued predicts a reversion up.
// Threshold swept in z-units since there's no existing calibration to
// anchor to (same in-sample-optimization caveat as CPI_MIN_GAP's own
// history in this repo — the best-threshold number is a ceiling estimate,
// not a validated setting).
function zScoreLevelTest(
  points: EvalPoint[], rawYoyByDate: Map<string, number>, baselineMean: number, baselineStd: number, thresholds: number[]
) {
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  const sweep = thresholds.map((thresh) => {
    let n = 0, momentumHits = 0, reversionHits = 0;
    for (const p of points) {
      const raw = rawYoyByDate.get(p.date);
      if (raw == null) continue;
      const z = (raw - baselineMean) / baselineStd;
      const zState: "elevated" | "subdued" | "normal" = z > thresh ? "elevated" : z < -thresh ? "subdued" : "normal";
      if (zState === "normal") continue;
      if (p.actualDirection !== "up" && p.actualDirection !== "down") { n++; continue; } // flat actual: a miss for both hypotheses, still counted
      const momentumPredicted = zState === "elevated" ? "up" : "down";
      const reversionPredicted = zState === "elevated" ? "down" : "up";
      if (p.actualDirection === momentumPredicted) momentumHits++;
      if (p.actualDirection === reversionPredicted) reversionHits++;
      n++;
    }
    return {
      threshold: thresh, n,
      momentumHitRatePct: n ? r1(momentumHits / n) : null, momentumCI: n ? wilsonCI(momentumHits, n) : null,
      reversionHitRatePct: n ? r1(reversionHits / n) : null, reversionCI: n ? wilsonCI(reversionHits, n) : null,
    };
  });
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { baselineMean: r2(baselineMean), baselineStd: r2(baselineStd), sweep };
}

// Same fixed window as fetch-macro-data's computeFixedWindowZScore.
function fixedWindowBaseline(yoyArr: Obs[]): { mean: number; std: number } {
  const window = yoyArr.filter((o) => o.date >= "2015-01-01" && o.date <= "2019-12-31");
  const mean = window.reduce((a, b) => a + b.value, 0) / window.length;
  const variance = window.reduce((s, o) => s + (o.value - mean) ** 2, 0) / window.length;
  return { mean, std: Math.sqrt(variance) || 1 };
}

// Historical gap series' own volatility — a sanity cross-check for threshold
// calibration ("some multiple of its own historical standard deviation"),
// independent of the walk-forward MAE/RMSE/hit-rate sweep.
function gapStats(fast: Obs[], slow: Obs[]) {
  const slowByDate = new Map(slow.map((o) => [o.date, o.value]));
  const gaps: number[] = [];
  for (const f of fast) {
    const s = slowByDate.get(f.date);
    if (s != null) gaps.push(f.value - s);
  }
  if (gaps.length === 0) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / gaps.length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n: gaps.length, mean: r2(mean), stdev: r2(Math.sqrt(variance)) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    // Defaults match the current production GROWTH_MIN_GAP/CPI_MIN_GAP
    // (lib/simulatorKeys.js) so a no-param call reports on live behavior.
    const growthMinGap = Number(url.searchParams.get("growthMinGap") ?? "0.80");
    const cpiMinGap = Number(url.searchParams.get("cpiMinGap") ?? "1.00");
    const horizonQ = Number(url.searchParams.get("horizonQ") ?? "1"); // GDP horizon, in quarters
    const horizonM = Number(url.searchParams.get("horizonM") ?? "3"); // CPI horizon, in months (3mo = 1 "quarter-equivalent")

    const [gdpRaw, cpiRaw] = await Promise.all([fetchFredSeries("GDPC1"), fetchFredSeries("CPIAUCSL")]);
    const gdpYoy = yoy(gdpRaw);
    const cpiYoy = yoy(cpiRaw);
    const gdpFast = trailingAvg(gdpYoy, 2);
    const gdpSlow = trailingAvg(gdpYoy, 4);
    const cpiFast = trailingAvg(cpiYoy, 3);
    const cpiSlow = trailingAvg(cpiYoy, 9);

    const now = new Date().toISOString().slice(0, 10);

    const gdpPoints = walkForward(gdpYoy, gdpFast, gdpSlow, growthMinGap, horizonQ, "quarter");
    const cpiPoints = walkForward(cpiYoy, cpiFast, cpiSlow, cpiMinGap, horizonM, "month");

    const gdpYoyByDate = new Map(gdpYoy.map((o) => [o.date, o.value]));
    const cpiYoyByDate = new Map(cpiYoy.map((o) => [o.date, o.value]));
    const gdpBaseline = fixedWindowBaseline(gdpYoy);
    const cpiBaseline = fixedWindowBaseline(cpiYoy);
    const zThresholds = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

    // Pending tail rows for the CSV export: walkForward silently drops any
    // issue date whose target hasn't resolved yet (by design, for every
    // aggregate stat above — an unresolved forecast can't be scored). A
    // spreadsheet asking for "the last few months" wants those rows anyway,
    // labeled Pending rather than missing outright, so this walks the same
    // fast/slow arrays independently of actual-availability.
    function pendingTail(fast: Obs[], slow: Obs[], minGap: number, horizonN: number, unit: "month" | "quarter") {
      const slowByDate = new Map(slow.map((o) => [o.date, o.value]));
      const out: { issueDate: string; targetDate: string; state: string; gap: number; forecastValue: number }[] = [];
      for (const f of fast) {
        const s = slowByDate.get(f.date);
        if (s == null) continue;
        const targetDate = dateNPeriodsAhead(f.date, horizonN, unit);
        const gap = f.value - s;
        const isSignal = Math.abs(gap) > minGap;
        const state = !isSignal ? "persistence" : gap > 0 ? "accelerating" : "decelerating";
        out.push({ issueDate: f.date, targetDate, state, gap: Math.round(gap * 100) / 100, forecastValue: Math.round(f.value * 100) / 100 });
      }
      return out;
    }

    const includeDetail = url.searchParams.get("detail") === "1";
    const report = {
      params: { growthMinGap, cpiMinGap, horizonQ, horizonM },
      regimeAccuracy: regimeAccuracyTest(gdpPoints, cpiPoints),
      ...(includeDetail ? {
        // Raw per-period rows for a CSV/spreadsheet export — everything a
        // downstream table needs, none of the aggregate stats above.
        gdpDetail: gdpPoints.map((p) => {
          const raw = gdpYoyByDate.get(p.date) ?? null;
          const z = raw != null ? Math.round(((raw - gdpBaseline.mean) / gdpBaseline.std) * 100) / 100 : null;
          return {
            issueDate: p.date, targetDate: p.targetDate, state: p.state, gap: Math.round(p.gap * 100) / 100,
            forecastValue: Math.round(p.naive * 100) / 100, actual: p.actual != null ? Math.round(p.actual * 100) / 100 : null,
            actualDirection: p.actualDirection, strictDirectionalHit: p.strictDirectionalHit, continuationHit: p.continuationHit,
            rawYoyAtIssue: raw != null ? Math.round(raw * 100) / 100 : null, zScoreVsFixedBaseline: z,
          };
        }),
        cpiDetail: cpiPoints.map((p) => {
          const raw = cpiYoyByDate.get(p.date) ?? null;
          const z = raw != null ? Math.round(((raw - cpiBaseline.mean) / cpiBaseline.std) * 100) / 100 : null;
          return {
            issueDate: p.date, targetDate: p.targetDate, state: p.state, gap: Math.round(p.gap * 100) / 100,
            forecastValue: Math.round(p.naive * 100) / 100, actual: p.actual != null ? Math.round(p.actual * 100) / 100 : null,
            actualDirection: p.actualDirection, strictDirectionalHit: p.strictDirectionalHit, continuationHit: p.continuationHit,
            rawYoyAtIssue: raw != null ? Math.round(raw * 100) / 100 : null, zScoreVsFixedBaseline: z,
          };
        }),
        gdpPendingTail: pendingTail(gdpFast, gdpSlow, growthMinGap, horizonQ, "quarter")
          .filter((p) => !gdpPoints.some((r) => r.date === p.issueDate))
          .slice(-6),
        cpiPendingTail: pendingTail(cpiFast, cpiSlow, cpiMinGap, horizonM, "month")
          .filter((p) => !cpiPoints.some((r) => r.date === p.issueDate))
          .slice(-6),
      } : {}),
      growth: {
        gapStats: gapStats(gdpFast, gdpSlow),
        ...windowedReport(gdpPoints, now),
        biasCorrection: biasCorrectionTest(gdpPoints),
        stateConditionalBias: stateConditionalBias(gdpPoints),
        momentumTransition: momentumTransitionTest(gdpPoints),
        momentumTransition3State: momentumTransitionTest3State(gdpPoints),
        zScoreLevelTest: zScoreLevelTest(gdpPoints, gdpYoyByDate, gdpBaseline.mean, gdpBaseline.std, zThresholds),
      },
      inflation: {
        gapStats: gapStats(cpiFast, cpiSlow),
        ...windowedReport(cpiPoints, now),
        biasCorrection: biasCorrectionTest(cpiPoints),
        // CPI's monthly cadence + 3-month horizon means consecutive points'
        // target windows overlap by 2 months — inflates apparent
        // significance vs a clean sample (flagged explicitly in the
        // dead-band-recalibration spec). GDP needs no equivalent: quarterly
        // cadence + 1-quarter horizon means consecutive points don't
        // overlap at all. Re-run on every 3rd point (non-overlapping
        // 3-month windows) as the spec's requested de-correlation check.
        biasCorrectionNonOverlapping: biasCorrectionTest(cpiPoints.filter((_, i) => i % 3 === 0), 3),
        stateConditionalBias: stateConditionalBias(cpiPoints),
        momentumTransition: momentumTransitionTest(cpiPoints),
        momentumTransition3State: momentumTransitionTest3State(cpiPoints),
        zScoreLevelTest: zScoreLevelTest(cpiPoints, cpiYoyByDate, cpiBaseline.mean, cpiBaseline.std, zThresholds),
      },
    };

    return new Response(JSON.stringify(report, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
