import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getWeightSet, getLegacyWeightSet, applyNbInterimTreatment, WeightSet } from "../_shared/regimeWeights.ts";
import {
  computeLambda, capTurnover, resolveBaseKey, canApplyKeyShift, deriveVariant,
  StructuralKeySource, Variant,
} from "../_shared/regimeShiftRules.ts";
import { resolveWeightsFor, resolveLegacyWeightsFor } from "../_shared/shadowLanes.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Same mapping as get-regime-analysis.ts / app/macro/page.jsx's REGIME_META — the
// canonical Dalio four-quadrant labels used everywhere else the regime is displayed.
const REGIME_LABELS: Record<string, string> = {
  rg_fi: "Disinflationary Boom",
  rg_ri: "Reflation",
  fg_ri: "Stagflation",
  fg_fi: "Deflationary Bust",
};

// Regime weights now come from _shared/regimeWeights.ts's getWeightSet
// (Regime Tilt Recalibration Phase 2 §4.0) — the single Deno-side copy,
// replacing this function's own former hand-copy of REGIME_DEFAULT_WEIGHTS
// (run-backtest has its own separate copy for a display-only field; see
// that module's own comment).

// Phase 2 §4.3: caps and holds.
const TURNOVER_CAP_POINTS = 15; // one-way, per run (D-3)
const MIN_HOLD_DAYS = 21; // between applied key-level shifts (D-4)
const LAMBDA_MAX = 0.5; // near-term blend never moves more than halfway (D-2)

// A regime-driven portfolio's allocation is driven by the active STRUCTURAL
// regime by default (a real, current-conditions read — not a forecast, so
// it takes effect immediately, no confidence floor or confirmation window:
// get-regime-analysis's own dead-band/Persistence handling already is that
// debounce). The Near-Term (2-3mo) Forward Signal can OVERRIDE structural,
// but only once it clears the confidence floor AND holds for this many
// consecutive days — avoids whipsawing a real portfolio's targets on a
// noisy week (Scott's spec). Both current regime-driven portfolios (All
// Weather Alpha, All Weather With Equity Tilting) use this same rule, so
// the clock itself is computed ONCE per run (nearterm_signal_state) rather
// than once per portfolio — see that table's migration comment.
const NEARTERM_CONFIRMATION_DAYS = 7;

// Below this the Near-Term signal is "moderate" at best on the app's own
// confidenceQualifier scale, not the "unambiguous" bar required before it's
// allowed to override a live structural read.
const CONFIDENCE_FLOOR = 60;

interface RegimeBlend {
  struct_key: string | null; struct_source: StructuralKeySource;
  variant: Variant; near_key: string | null;
  near_conf: number | null; lambda: number;
}

interface RegimePortfolio {
  id: string; portfolio_name: string;
  current_regime_key: string | null; regime_confirmed_since: string | null;
  pending_regime_key: string | null; pending_regime_since: string | null;
  regime_auto_shift: boolean;
  regime_phase3_weights: boolean;
  target_allocations: WeightSet | null;
  regime_blend: RegimeBlend | null;
}

interface SignalState {
  pending_key: string | null; pending_since: string | null;
  confirmed_key: string | null; confirmed_since: string | null;
  active: boolean;
}

function daysBetween(a: string, b: Date): number {
  const diffMs = b.getTime() - new Date(a + "T00:00:00Z").getTime();
  return Math.floor(diffMs / 86_400_000);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // This can run before a human has visited /macro today — ensure Clio's
    // regime analysis (which persists structural_key AND
    // nearterm_forward_key/nearterm_forward_confidence) exists.
    const { data: todayRegime } = await sb
      .from("dalio_regime_analysis")
      .select("analysis_date,structural_key,structural_key_source,nearterm_forward_key,nearterm_forward_confidence,infl_level_state,infl_accel_vote")
      .eq("analysis_date", todayStr)
      .maybeSingle();
    let structuralKey = todayRegime?.structural_key as string | null | undefined;
    let structuralKeySource = todayRegime?.structural_key_source as StructuralKeySource | undefined;
    let liveNearKey = todayRegime?.nearterm_forward_key as string | null | undefined;
    let liveNearConfidence = todayRegime?.nearterm_forward_confidence as number | null | undefined;
    let inflLevelState = todayRegime?.infl_level_state as string | null | undefined;
    let inflAccelVote = todayRegime?.infl_accel_vote as string | null | undefined;
    if (structuralKey === undefined) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/get-regime-analysis`, {
          method: "GET",
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        });
        if (res.ok) {
          const j = await res.json();
          structuralKey = j?.structural_key ?? null;
          structuralKeySource = j?.structural_key_source ?? null;
          liveNearKey = j?.nearterm_forward_key ?? null;
          liveNearConfidence = j?.nearterm_forward_confidence ?? null;
          inflLevelState = j?.infl_level_state ?? null;
          inflAccelVote = j?.infl_accel_vote ?? null;
        }
      } catch (e) { console.error("[regime-targets] triggering get-regime-analysis:", e); }
    }
    structuralKey = structuralKey ?? null;
    structuralKeySource = structuralKeySource ?? null;
    // Phase 3 (§5): the real computed variant, independent of whether
    // any given portfolio is actually allowed to USE it — that gate is
    // per-portfolio (regime_phase3_weights), applied below in the loop.
    const computedVariant: Variant = deriveVariant(inflLevelState ?? null, inflAccelVote ?? null);

    // ── The Near-Term override's own clock, computed once ──────────────────
    const { data: sigRow } = await sb
      .from("nearterm_signal_state")
      .select("pending_key,pending_since,confirmed_key,confirmed_since,active")
      .eq("id", true)
      .maybeSingle();
    const prev: SignalState = sigRow ?? { pending_key: null, pending_since: null, confirmed_key: null, confirmed_since: null, active: false };

    // Permanent daily record of today's raw reading -- insert-only (on
    // conflict do nothing), so a second same-day invocation (e.g. a manual
    // rerun) never overwrites the day's first/official reading. This is
    // also the smoothing window's own data source, not just an audit log.
    await sb.from("nearterm_signal_history").upsert(
      { snapshot_date: todayStr, key: liveNearKey ?? null, confidence: liveNearConfidence ?? null },
      { onConflict: "snapshot_date", ignoreDuplicates: true },
    );

    // Trailing 3-day average (today inclusive), restricted to rows whose
    // key matches today's liveNearKey -- a day a different key was leading
    // doesn't count toward this key's average, same principle the streak
    // logic below already uses (prev.pending_key === liveNearKey). Absorbs
    // single-day noise (same-day commodity/FX price moves feeding the
    // Inflation Momentum votes) without changing the existing 7-day
    // confirmation streak, which is already the real trend-confirmation
    // mechanism -- just previously fed an unsmoothed single-day input.
    const SMOOTHING_WINDOW_DAYS = 3;
    let smoothedConfidence: number | null = null;
    if (liveNearKey) {
      const windowStart = addDays(todayStr, -(SMOOTHING_WINDOW_DAYS - 1));
      const { data: histRows } = await sb
        .from("nearterm_signal_history")
        .select("confidence")
        .eq("key", liveNearKey)
        .gte("snapshot_date", windowStart)
        .lte("snapshot_date", todayStr)
        .not("confidence", "is", null);
      const vals = (histRows ?? []).map((r) => Number(r.confidence));
      if (vals.length > 0) smoothedConfidence = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    const nearMeetsFloor = !!liveNearKey && smoothedConfidence != null && smoothedConfidence >= CONFIDENCE_FLOOR;

    let pendingKey: string | null;
    let pendingSince: string | null;
    if (nearMeetsFloor) {
      if (prev.pending_key === liveNearKey && prev.pending_since) {
        // Same streak continuing — don't touch the start date.
        pendingKey = prev.pending_key;
        pendingSince = prev.pending_since;
      } else {
        // A brand-new streak: either nothing was pending, or a different
        // key just crossed the floor. This is the "signal fires" moment.
        pendingKey = liveNearKey as string;
        pendingSince = todayStr;
      }
    } else {
      // Doesn't qualify today at all — the streak breaks, full stop.
      pendingKey = null;
      pendingSince = null;
    }
    const fired = pendingKey != null && pendingSince === todayStr;

    const daysPending = pendingSince ? daysBetween(pendingSince, today) : 0;
    const justQualifies = !!pendingKey && daysPending >= NEARTERM_CONFIRMATION_DAYS;

    let confirmedKey = prev.confirmed_key;
    let confirmedSince = prev.confirmed_since;
    let active = false;
    let newlyConfirmed = false;

    if (justQualifies) {
      active = true;
      if (confirmedKey !== pendingKey) {
        // First day this SPECIFIC key reaches the confirmation window (not
        // just "still active from before") — the actual confirm date is
        // pendingSince + 7, not "today," so a missed cron day still lands
        // on the true date rather than whichever day the function happened
        // to catch up.
        confirmedKey = pendingKey;
        confirmedSince = addDays(pendingSince as string, NEARTERM_CONFIRMATION_DAYS);
        newlyConfirmed = true;
      }
    }

    await sb.from("nearterm_signal_state").update({
      pending_key: pendingKey, pending_since: pendingSince,
      confirmed_key: confirmedKey, confirmed_since: confirmedSince,
      active, updated_at: new Date().toISOString(),
    }).eq("id", true);

    const { data: portfolios } = await sb
      .from("portfolios")
      .select("id,portfolio_name,current_regime_key,regime_confirmed_since,pending_regime_key,pending_regime_since,regime_auto_shift,regime_phase3_weights,target_allocations,regime_blend")
      .eq("strategy_framework", "regime_driven");
    // fg_ri nb interim treatment (Scott's decision 2026-10-30, until
    // Phase 4's IEI ship): gates applyNbInterimTreatment per portfolio.
    const { data: ieiRows } = (portfolios ?? []).length
      ? await sb
          .from("portfolio_holdings")
          .select("portfolio_id, holdings!inner(symbol, quantity)")
          .in("portfolio_id", (portfolios ?? []).map((p) => p.id))
          .eq("holdings.symbol", "IEI")
          .gt("holdings.quantity", 0)
      : { data: [] };
    const ieiPortfolioIds = new Set((ieiRows ?? []).map((r) => r.portfolio_id as string));

    const portfolioNames = (portfolios ?? []).map((p) => (p as RegimePortfolio).portfolio_name);
    const portfolioNamesText = portfolioNames.length
      ? portfolioNames.join(" and ")
      : "regime-driven portfolios";
    const verb = portfolioNames.length === 1 ? "has" : "have";

    // ── Notifications: one per signal-level event, not one per portfolio — ──
    // both portfolios react identically, so this names the signal itself,
    // not a per-portfolio duplicate. Idempotent via dedup_key (same
    // upsert+ignoreDuplicates pattern as update-big-cycle-metrics' trip-wire
    // notifications), so a retried/duplicate run is a silent no-op.
    const notifRows: Record<string, unknown>[] = [];
    if (fired) {
      const confirmsOn = addDays(pendingSince as string, NEARTERM_CONFIRMATION_DAYS);
      notifRows.push({
        category: "regime_signal", type: "signal_fired", importance: "medium",
        title: `Near-Term signal: ${REGIME_LABELS[pendingKey as string] ?? pendingKey} crossed 60% confidence`,
        description: `Today's reading is ${liveNearConfidence}% (${SMOOTHING_WINDOW_DAYS}-day average ${smoothedConfidence}%). If it holds through ${confirmsOn}, ${portfolioNamesText} will shift to ${REGIME_LABELS[pendingKey as string] ?? pendingKey}.`,
        metadata: { key: pendingKey, confidence: liveNearConfidence, smoothed_confidence: smoothedConfidence, pending_since: pendingSince, confirms_on: confirmsOn },
        dedup_key: `nearterm_signal_fired:${pendingKey}:${pendingSince}`,
      });
    }
    if (newlyConfirmed) {
      notifRows.push({
        category: "regime_signal", type: "signal_confirmed", importance: "high",
        title: `Near-Term signal confirmed: ${REGIME_LABELS[confirmedKey as string] ?? confirmedKey}`,
        description: `Confirmed ${confirmedSince}. ${portfolioNamesText} ${verb} shifted to ${REGIME_LABELS[confirmedKey as string] ?? confirmedKey} weights.`,
        metadata: { key: confirmedKey, confirmed_since: confirmedSince },
        dedup_key: `nearterm_signal_confirmed:${confirmedKey}:${confirmedSince}`,
      });
    }
    if (notifRows.length) {
      await sb.from("notifications").upsert(notifRows, { onConflict: "dedup_key", ignoreDuplicates: true });
    }

    const results: { portfolioId: string; action: string }[] = [];
    // Near-term's active key for blending purposes (Phase 2 §4.2) — it no
    // longer fully overrides structural; it's a blend target, only when
    // active/confirmed AND it differs from whatever the base ends up being.
    const nearActiveKey: string | null = active && confirmedKey ? confirmedKey : null;
    // Regime Tilt Recalibration Phase 0: per-portfolio notifications for a
    // held (regime_auto_shift=false) portfolio -- separate from the
    // signal-level notifRows above since these name a specific portfolio,
    // not the shared clock. Same upsert+dedup_key pattern, sent once after
    // the loop.
    const heldNotifRows: Record<string, unknown>[] = [];

    for (const pf of (portfolios ?? []) as RegimePortfolio[]) {
      // Mirror the shared clock onto each portfolio's own columns purely so
      // the /portfolios page's existing display keeps showing pending
      // state without re-deriving it — this function is the only writer of
      // the clock itself now (nearterm_signal_state above).
      if (pf.pending_regime_key !== pendingKey || pf.pending_regime_since !== pendingSince) {
        await sb.from("portfolios").update({ pending_regime_key: pendingKey, pending_regime_since: pendingSince }).eq("id", pf.id);
      }

      const currentBaseKey = pf.current_regime_key;
      // §4.1: a "carry" source never moves this portfolio's base off
      // whatever it's already on — only a fresh (crossover/leaning)
      // reading can.
      const proposedBaseKey = resolveBaseKey(structuralKey, structuralKeySource, currentBaseKey);

      if (!proposedBaseKey && !nearActiveKey) {
        // Genuinely no structural reading ever (missing GDP/CPI data, not
        // a dead-band case — get-regime-analysis already falls back to the
        // last confirmed regime for dead-band days), no existing base, and
        // no Near-Term override active — leave everything untouched rather
        // than guess.
        results.push({ portfolioId: pf.id, action: "no_structural_signal" });
        continue;
      }

      const prevBlend = pf.regime_blend;
      const prevNearKey = prevBlend?.near_key ?? null;
      const baseChanging = proposedBaseKey !== null && proposedBaseKey !== currentBaseKey;
      // Near-term only matters for blending when it differs from the base
      // it would otherwise be blended against — agreeing with the base is
      // a no-op for the blend (even though it may still count as the
      // "agreement exception" below).
      const nearKeyForThisRun = nearActiveKey && nearActiveKey !== proposedBaseKey ? nearActiveKey : null;
      const nearChanging = nearKeyForThisRun !== prevNearKey;
      const isKeyLevelEvent = baseChanging || nearChanging;

      let finalBaseKey = proposedBaseKey ?? currentBaseKey;
      let finalNearKey = nearKeyForThisRun;
      let blocked = false;

      if (isKeyLevelEvent) {
        // §4.3 agreement exception: a genuine crossover and an active
        // Near-Term signal landing on the SAME key (different from the
        // current base) is strong enough to bypass the minimum hold.
        const agreement = structuralKeySource === "crossover"
          && nearActiveKey != null
          && structuralKey === nearActiveKey
          && structuralKey !== currentBaseKey;
        const allowed = canApplyKeyShift(pf.regime_confirmed_since, today, MIN_HOLD_DAYS, agreement);
        if (!allowed) {
          blocked = true;
          finalBaseKey = currentBaseKey;
          finalNearKey = prevNearKey;
        }
      }

      if (!finalBaseKey) {
        results.push({ portfolioId: pf.id, action: "no_structural_signal" });
        continue;
      }

      // Phase 3 (§5): regime_phase3_weights is a second, independent
      // safety lever from regime_auto_shift. With it off, the live job
      // uses the frozen pre-Phase-3 weight SETS entirely (D-1 changed
      // fg_ri's base numbers themselves, not just added a high tier),
      // so re-enabling auto-shift alone tests Phase 2's rules against
      // the original numbers, not a mix of old rules and new weights.
      // The real computed variant is still stored in regime_blend below
      // either way, so it's visible while gated off, not just once on.
      // Calls the exact same resolveWeightsFor/resolveLegacyWeightsFor
      // the phase3/phase2 shadow lanes call (_shared/shadowLanes.ts) —
      // this flag's two settings are, by construction, what those two
      // lanes exist to mirror; tests/shadowLanes.test.ts pins that
      // equivalence directly.
      const lambda = finalNearKey ? computeLambda(smoothedConfidence, LAMBDA_MAX) : 0;
      const hasIEI = ieiPortfolioIds.has(pf.id);
      const wStruct = pf.regime_phase3_weights
        ? applyNbInterimTreatment(finalBaseKey, getWeightSet(finalBaseKey, computedVariant) ?? {}, hasIEI)
        : (getLegacyWeightSet(finalBaseKey) ?? {});
      const wDesired = pf.regime_phase3_weights
        ? resolveWeightsFor(finalBaseKey, finalNearKey, lambda, computedVariant, wStruct, hasIEI)
        : resolveLegacyWeightsFor(finalBaseKey, finalNearKey, lambda, wStruct);
      const wCurrent = pf.target_allocations && Object.keys(pf.target_allocations).length > 0 ? pf.target_allocations : wStruct;
      const wWritten = capTurnover(wCurrent, wDesired, TURNOVER_CAP_POINTS);

      const newBlend: RegimeBlend = {
        struct_key: finalBaseKey, struct_source: structuralKeySource,
        variant: computedVariant, near_key: finalNearKey, near_conf: finalNearKey ? smoothedConfidence : null, lambda,
      };
      const keyEventApplied = isKeyLevelEvent && !blocked;

      const nothingToWrite = !keyEventApplied
        && JSON.stringify(wWritten) === JSON.stringify(wCurrent)
        && JSON.stringify(newBlend) === JSON.stringify(prevBlend);
      if (nothingToWrite) {
        results.push({ portfolioId: pf.id, action: blocked ? "shift_blocked_min_hold" : "no_change" });
        continue;
      }

      const fromKey = currentBaseKey;

      if (!pf.regime_auto_shift) {
        // Held: record what WOULD have happened (applied=false) and notify
        // for a genuine key-level event only, but never touch
        // target_allocations/current_regime_key/regime_blend. The signal
        // clock above already ran normally -- this only withholds acting
        // on it for this one portfolio.
        if (keyEventApplied) {
          // Prefer the blend target as "where we're heading" when one is
          // active; a near-term deactivation (finalNearKey back to null)
          // correctly falls back to the base rather than showing null.
          const toKeyForNotif = finalNearKey ?? finalBaseKey;
          await sb.from("portfolio_regime_shifts").insert({
            portfolio_id: pf.id, from_key: fromKey, to_key: toKeyForNotif,
            from_label: fromKey ? (REGIME_LABELS[fromKey] ?? fromKey) : null,
            to_label: REGIME_LABELS[toKeyForNotif as string] ?? toKeyForNotif,
            applied: false,
          });
          heldNotifRows.push({
            category: "regime_signal", type: "signal_shift_suppressed", importance: "medium",
            title: `Shift to ${REGIME_LABELS[toKeyForNotif as string] ?? toKeyForNotif} suppressed — auto-shift is off for ${pf.portfolio_name}`,
            description: `${pf.portfolio_name} would have shifted from ${fromKey ? (REGIME_LABELS[fromKey] ?? fromKey) : "no regime"} toward ${REGIME_LABELS[toKeyForNotif as string] ?? toKeyForNotif} today, but auto-shift is paused for this portfolio. Turn it back on to resume.`,
            metadata: { portfolio_id: pf.id, from_key: fromKey, to_key: toKeyForNotif },
            dedup_key: `regime_shift_suppressed:${pf.id}:${toKeyForNotif}:${todayStr}`,
          });
        }
        results.push({ portfolioId: pf.id, action: "held" });
        continue;
      }

      const updatePayload: Record<string, unknown> = {
        target_allocations: wWritten,
        current_regime_key: finalBaseKey,
        regime_blend: newBlend,
        updated_at: new Date().toISOString(),
      };
      if (keyEventApplied) updatePayload.regime_confirmed_since = todayStr;
      await sb.from("portfolios").update(updatePayload).eq("id", pf.id);

      if (keyEventApplied) {
        const toKey = finalNearKey ?? finalBaseKey;
        await sb.from("portfolio_regime_shifts").insert({
          portfolio_id: pf.id, from_key: fromKey, to_key: toKey,
          from_label: fromKey ? (REGIME_LABELS[fromKey] ?? fromKey) : null,
          to_label: REGIME_LABELS[toKey as string] ?? toKey,
        });
        results.push({ portfolioId: pf.id, action: fromKey ? "shifted" : "activated" });
      } else {
        results.push({ portfolioId: pf.id, action: blocked ? "shift_blocked_min_hold" : "blend_adjusted" });
      }
    }

    if (heldNotifRows.length) {
      await sb.from("notifications").upsert(heldNotifRows, { onConflict: "dedup_key", ignoreDuplicates: true });
    }

    return json({
      structuralKey: structuralKey ?? null, structuralKeySource: structuralKeySource ?? null, computedVariant,
      liveNearKey: liveNearKey ?? null, liveNearConfidence: liveNearConfidence ?? null,
      smoothedConfidence, smoothingWindowDays: SMOOTHING_WINDOW_DAYS,
      pendingKey, pendingSince, confirmedKey, confirmedSince, active, fired, newlyConfirmed,
      processed: results.length, results,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
