import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { capTurnover, StructuralKeySource } from "../_shared/regimeShiftRules.ts";
import { WeightSet, getWeightSet } from "../_shared/regimeWeights.ts";
import {
  LANES, LANE_IDS, CAPPED_LANES, RULES_VERSION, deriveEvent, deriveVariant, blendSectorTargets,
  ShadowInputs, LaneState,
} from "../_shared/shadowLanes.ts";

// Regime Shadow Targets Log (docs/specs/regime-shadow-targets.md).
// Runs every rule set ("lane") side by side for each regime-driven
// portfolio and records what targets each WOULD hold — never writes
// to portfolios, portfolio_regime_shifts or nearterm_signal_state.
// Scheduled 15 minutes after update-regime-portfolio-targets so this
// function's own failure can never block or delay the live job.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const TURNOVER_CAP_POINTS = 15;
const SMOOTHING_WINDOW_DAYS = 3;

// Baseline all lanes seed from (spec §4.3) — the restored Alpha/Tilting
// state from the Regime Tilt Recalibration Phase 2 commit.
const SEED_BASE_KEY = "fg_ri";
const SEED_BASE_CONFIRMED_SINCE = "2026-10-21";

function oneWayTurnover(a: WeightSet, b: WeightSet): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum / 2;
}

function weightsEqual(a: WeightSet, b: WeightSet): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    const { data: regimeRow } = await sb
      .from("dalio_regime_analysis")
      .select("structural_key,structural_key_source,nearterm_forward_key,nearterm_forward_confidence,infl_level_state,infl_accel_vote")
      .eq("analysis_date", todayStr)
      .maybeSingle();

    if (!regimeRow) {
      await sb.from("notifications").upsert({
        category: "regime_signal", type: "shadow_skipped", importance: "low",
        title: `Shadow targets skipped for ${todayStr}`,
        description: `No dalio_regime_analysis row exists for ${todayStr} yet. The shadow log never calls get-regime-analysis itself; it waits for the live job to produce one.`,
        metadata: { date: todayStr },
        dedup_key: `shadow_skipped:${todayStr}`,
      }, { onConflict: "dedup_key", ignoreDuplicates: true });
      return json({ ok: true, skipped: true, reason: "no dalio_regime_analysis row for today" });
    }

    const structuralKey = regimeRow.structural_key as string | null;
    const structuralKeySource = regimeRow.structural_key_source as StructuralKeySource;
    const liveNearKey = regimeRow.nearterm_forward_key as string | null;
    const inflLevelState = regimeRow.infl_level_state as string | null;
    const inflAccelVote = regimeRow.infl_accel_vote as string | null;

    const { data: sigRow } = await sb
      .from("nearterm_signal_state")
      .select("confirmed_key,active")
      .eq("id", true)
      .maybeSingle();
    const nearActive = !!sigRow?.active;
    const nearConfirmedKey = (sigRow?.confirmed_key as string | null) ?? null;

    // Same windowing as the live job (update-regime-portfolio-targets) —
    // read-only here; nearterm_signal_history is written exclusively by
    // that function.
    let smoothedConfidence: number | null = null;
    if (liveNearKey) {
      const windowStart = new Date(today);
      windowStart.setUTCDate(windowStart.getUTCDate() - (SMOOTHING_WINDOW_DAYS - 1));
      const { data: histRows } = await sb
        .from("nearterm_signal_history")
        .select("confidence")
        .eq("key", liveNearKey)
        .gte("snapshot_date", windowStart.toISOString().slice(0, 10))
        .lte("snapshot_date", todayStr)
        .not("confidence", "is", null);
      const vals = (histRows ?? []).map((r) => Number(r.confidence));
      if (vals.length > 0) smoothedConfidence = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    const { data: portfolios } = await sb
      .from("portfolios")
      .select("id, portfolio_name, current_regime_key, target_allocations")
      .eq("strategy_framework", "regime_driven");

    const variant = deriveVariant(inflLevelState, inflAccelVote);
    const results: Record<string, unknown>[] = [];
    const errorRows: Record<string, unknown>[] = [];

    for (const pf of portfolios ?? []) {
      const { data: sectorRows } = await sb
        .from("portfolio_sector_targets")
        .select("symbol, target_pct_of_bucket, regime_key")
        .eq("portfolio_id", pf.id);
      const sectorByRegime = (sectorRows ?? []).reduce((acc: Record<string, Record<string, number>>, r) => {
        (acc[r.regime_key] ??= {})[r.symbol] = Number(r.target_pct_of_bucket);
        return acc;
      }, {});
      const hasSectorTargets = Object.keys(sectorByRegime).length > 0;

      for (const lane of LANE_IDS) {
        try {
          const laneFn = LANES[lane];
          if (!laneFn) continue;

          const { data: prevStateRow } = await sb
            .from("regime_shadow_state")
            .select("*")
            .eq("portfolio_id", pf.id)
            .eq("lane", lane)
            .maybeSingle();

          let prev: LaneState;
          let prevVariant: "base" | "high" | "high_accel" | "high_decel" = "base";
          let isFirstRun = false;
          if (prevStateRow) {
            prev = {
              baseKey: prevStateRow.base_key, baseConfirmedSince: prevStateRow.base_confirmed_since,
              lastShiftDate: prevStateRow.last_shift_date,
              nearKey: null, lambda: 0, // reconstructed from regime_shadow_targets below; regime_shadow_state doesn't track near/lambda/variant
              currentTargets: prevStateRow.current_targets, desiredTargets: prevStateRow.desired_targets,
            };
            // near_key/lambda/variant carry forward via the last written
            // targets row, since regime_shadow_state only tracks base/
            // current/desired targets.
            const { data: lastRow } = await sb
              .from("regime_shadow_targets")
              .select("near_key, lambda, variant")
              .eq("portfolio_id", pf.id).eq("lane", lane)
              .order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
            if (lastRow) {
              prev.nearKey = lastRow.near_key;
              prev.lambda = Number(lastRow.lambda ?? 0);
              prevVariant = lastRow.variant ?? "base";
            }
          } else {
            isFirstRun = true;
            if (lane === "live") {
              prev = {
                baseKey: pf.current_regime_key, baseConfirmedSince: null, lastShiftDate: null,
                nearKey: null, lambda: 0,
                currentTargets: pf.target_allocations ?? {}, desiredTargets: pf.target_allocations ?? {},
              };
            } else {
              const seedTargets = getWeightSet(SEED_BASE_KEY, "base") ?? {};
              prev = {
                baseKey: SEED_BASE_KEY, baseConfirmedSince: SEED_BASE_CONFIRMED_SINCE, lastShiftDate: SEED_BASE_CONFIRMED_SINCE,
                nearKey: null, lambda: 0, currentTargets: seedTargets, desiredTargets: seedTargets,
              };
            }
          }

          const inputs: ShadowInputs = {
            structuralKey, structuralKeySource, nearActive, nearConfirmedKey, smoothedConfidence,
            inflLevelState, inflAccelVote,
            livePortfolio: { current_regime_key: pf.current_regime_key, target_allocations: pf.target_allocations },
            today,
          };

          const result = laneFn(inputs, prev);
          const capped = CAPPED_LANES.has(lane);
          const preCappedTurnover = oneWayTurnover(prev.currentTargets, result.desiredTargets);
          const steppedTargets = capped ? capTurnover(prev.currentTargets, result.desiredTargets, TURNOVER_CAP_POINTS) : result.desiredTargets;
          const reachedDesired = weightsEqual(steppedTargets, result.desiredTargets);
          const turnoverVsPrev = oneWayTurnover(prev.currentTargets, steppedTargets);

          const event = isFirstRun && weightsEqual(steppedTargets, prev.currentTargets) && result.regimeKey === prev.baseKey && !result.nearKey
            ? "seed"
            : deriveEvent({
                lane, capped,
                prevRegimeKey: prev.baseKey, nextRegimeKey: result.regimeKey,
                prevNearKey: prev.nearKey, nextNearKey: result.nearKey,
                prevVariant, nextVariant: result.variant,
                preCappedTurnover, reachedDesired,
              });
          const shifted = result.regimeKey !== prev.baseKey || result.nearKey !== prev.nearKey || result.lambda !== prev.lambda || result.variant !== prevVariant;

          let sectorTargets: Record<string, number> | null = null;
          if (hasSectorTargets && result.regimeKey) {
            const structRows = sectorByRegime[result.regimeKey] ?? null;
            const nearRows = result.nearKey ? (sectorByRegime[result.nearKey] ?? null) : null;
            if (structRows) sectorTargets = blendSectorTargets(structRows, nearRows, result.lambda);
          }

          const row = {
            snapshot_date: todayStr, portfolio_id: pf.id, lane, rules_version: RULES_VERSION,
            regime_key: result.regimeKey, near_key: result.nearKey, lambda: result.lambda, variant: result.variant,
            target_allocations: steppedTargets, sector_targets: sectorTargets,
            turnover_vs_prev: turnoverVsPrev, turnover_uncapped: capped ? preCappedTurnover : null,
            shifted, event, blocked_reason: result.blockedReason,
            inputs: {
              structural_key: structuralKey, structural_key_source: structuralKeySource,
              nearterm_forward_key: liveNearKey, nearterm_forward_confidence: regimeRow.nearterm_forward_confidence,
              smoothed_confidence: smoothedConfidence,
              infl_level_state: inflLevelState, infl_accel_vote: inflAccelVote,
              near_active: nearActive, near_confirmed_key: nearConfirmedKey,
            },
          };

          const { error: insertErr } = await sb
            .from("regime_shadow_targets")
            .upsert(row, { onConflict: "snapshot_date,portfolio_id,lane", ignoreDuplicates: true });
          if (insertErr) throw new Error(`regime_shadow_targets upsert: ${insertErr.message}`);

          await sb.from("regime_shadow_state").upsert({
            portfolio_id: pf.id, lane,
            base_key: result.regimeKey, base_confirmed_since: result.nextState.baseConfirmedSince,
            last_shift_date: result.nextState.lastShiftDate,
            current_targets: steppedTargets, desired_targets: result.desiredTargets,
            current_sector_targets: sectorTargets,
            updated_at: new Date().toISOString(),
          }, { onConflict: "portfolio_id,lane" });

          results.push({ portfolioId: pf.id, lane, event, blockedReason: result.blockedReason });
        } catch (laneErr) {
          const msg = laneErr instanceof Error ? laneErr.message : String(laneErr);
          errorRows.push({
            category: "regime_signal", type: "shadow_lane_error", importance: "medium",
            title: `Shadow lane error: ${lane} / ${pf.portfolio_name}`,
            description: msg,
            metadata: { portfolio_id: pf.id, lane, date: todayStr },
            dedup_key: `shadow_lane_error:${pf.id}:${lane}:${todayStr}`,
          });
          results.push({ portfolioId: pf.id, lane, error: msg });
        }
      }
    }

    if (errorRows.length) {
      await sb.from("notifications").upsert(errorRows, { onConflict: "dedup_key", ignoreDuplicates: true });
    }

    return json({ ok: true, date: todayStr, variant, processed: results.length, results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
