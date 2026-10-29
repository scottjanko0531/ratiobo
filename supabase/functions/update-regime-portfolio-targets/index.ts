import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

// Mirrors lib/simulatorKeys.js's REGIME_DEFAULT_WEIGHTS exactly — the same weights
// already used to drive the Simulator's per-regime suggestions, now reused to
// automatically set a regime-driven portfolio's actual target_allocations.
const REGIME_DEFAULT_WEIGHTS: Record<string, Record<string, number>> = {
  rg_fi: { eq: 35, intl: 15, em: 10, nb: 20, tip: 5, com: 5, gld: 5, cash: 5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  rg_ri: { eq: 20, intl: 10, em: 20, nb: 0, tip: 15, com: 20, gld: 10, cash: 5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_ri: { eq: 5, intl: 5, em: 0, nb: 0, tip: 20, com: 30, gld: 30, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_fi: { eq: 5, intl: 5, em: 0, nb: 65, tip: 0, com: 0, gld: 15, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
};

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

interface RegimePortfolio {
  id: string; portfolio_name: string;
  current_regime_key: string | null; regime_confirmed_since: string | null;
  pending_regime_key: string | null; pending_regime_since: string | null;
  regime_auto_shift: boolean;
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
      .select("analysis_date,structural_key,nearterm_forward_key,nearterm_forward_confidence")
      .eq("analysis_date", todayStr)
      .maybeSingle();
    let structuralKey = todayRegime?.structural_key as string | null | undefined;
    let liveNearKey = todayRegime?.nearterm_forward_key as string | null | undefined;
    let liveNearConfidence = todayRegime?.nearterm_forward_confidence as number | null | undefined;
    if (structuralKey === undefined) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/get-regime-analysis`, {
          method: "GET",
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        });
        if (res.ok) {
          const j = await res.json();
          structuralKey = j?.structural_key ?? null;
          liveNearKey = j?.nearterm_forward_key ?? null;
          liveNearConfidence = j?.nearterm_forward_confidence ?? null;
        }
      } catch (e) { console.error("[regime-targets] triggering get-regime-analysis:", e); }
    }
    structuralKey = structuralKey ?? null;

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
      .select("id,portfolio_name,current_regime_key,regime_confirmed_since,pending_regime_key,pending_regime_since,regime_auto_shift")
      .eq("strategy_framework", "regime_driven");
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
    const effectiveKey: string | null = active && confirmedKey ? confirmedKey : structuralKey;
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

      if (!effectiveKey) {
        // Genuinely no structural reading today (missing GDP/CPI data, not
        // a dead-band case — get-regime-analysis already falls back to the
        // last confirmed regime for dead-band days) and no Near-Term
        // override active — leave current_regime_key untouched rather than
        // guess.
        results.push({ portfolioId: pf.id, action: "no_structural_signal" });
        continue;
      }

      if (effectiveKey === pf.current_regime_key) {
        results.push({ portfolioId: pf.id, action: "no_change" });
        continue;
      }

      const fromKey = pf.current_regime_key;

      if (!pf.regime_auto_shift) {
        // Held: record what WOULD have happened (applied=false) and notify,
        // but never touch target_allocations/current_regime_key. The
        // signal clock above already ran normally -- this only withholds
        // acting on it for this one portfolio.
        await sb.from("portfolio_regime_shifts").insert({
          portfolio_id: pf.id, from_key: fromKey, to_key: effectiveKey,
          from_label: fromKey ? (REGIME_LABELS[fromKey] ?? fromKey) : null, to_label: REGIME_LABELS[effectiveKey] ?? effectiveKey,
          applied: false,
        });
        heldNotifRows.push({
          category: "regime_signal", type: "signal_shift_suppressed", importance: "medium",
          title: `Shift to ${REGIME_LABELS[effectiveKey] ?? effectiveKey} suppressed — auto-shift is off for ${pf.portfolio_name}`,
          description: `${pf.portfolio_name} would have shifted from ${fromKey ? (REGIME_LABELS[fromKey] ?? fromKey) : "no regime"} to ${REGIME_LABELS[effectiveKey] ?? effectiveKey} today, but auto-shift is paused for this portfolio. Turn it back on to resume.`,
          metadata: { portfolio_id: pf.id, from_key: fromKey, to_key: effectiveKey },
          dedup_key: `regime_shift_suppressed:${pf.id}:${effectiveKey}:${todayStr}`,
        });
        results.push({ portfolioId: pf.id, action: "held" });
        continue;
      }

      await sb.from("portfolios").update({
        target_allocations: REGIME_DEFAULT_WEIGHTS[effectiveKey],
        current_regime_key: effectiveKey,
        regime_confirmed_since: todayStr,
        updated_at: new Date().toISOString(),
      }).eq("id", pf.id);
      await sb.from("portfolio_regime_shifts").insert({
        portfolio_id: pf.id, from_key: fromKey, to_key: effectiveKey,
        from_label: fromKey ? (REGIME_LABELS[fromKey] ?? fromKey) : null, to_label: REGIME_LABELS[effectiveKey] ?? effectiveKey,
      });
      results.push({ portfolioId: pf.id, action: fromKey ? "shifted" : "activated" });
    }

    if (heldNotifRows.length) {
      await sb.from("notifications").upsert(heldNotifRows, { onConflict: "dedup_key", ignoreDuplicates: true });
    }

    return json({
      structuralKey: structuralKey ?? null,
      liveNearKey: liveNearKey ?? null, liveNearConfidence: liveNearConfidence ?? null,
      smoothedConfidence, smoothingWindowDays: SMOOTHING_WINDOW_DAYS,
      pendingKey, pendingSince, confirmedKey, confirmedSince, active, fired, newlyConfirmed,
      processed: results.length, results,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
