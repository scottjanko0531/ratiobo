#!/usr/bin/env node
// Rule Breaker Screener — calibration/validation script (Phase 2). Loads
// the live rb_* tables, runs every piece of _shared/ruleBreaker/ that's
// already confirmed against the real 155-symbol baseline
// (config_version='artifact-v15' AND partial=false, the one shared-date
// full-breakdown snapshot -- see scripts/rb-import.ts's mapScoreBaseline),
// and reports an exact-match rate per field. This is the literal
// implementation of the build spec's "Phase 2 matches artifact" gate.
//
// Each confirmed function is tested against GROUND-TRUTH inputs for its
// OWN upstream fields (e.g. computeScreen is tested with the baseline
// row's own met/score, not this script's own computed met/score) --
// deliberately decoupled, so a function already confirmed correct keeps
// reporting 100% even while upstream pillars (c2-c6/safety/quality/c5/
// risk_type) are still NotCalibratedError stubs. Only the full
// buildDrivers -> computeC1 -> ... end-to-end chain additionally needs
// every upstream piece to already be solved; that's reported separately.
//
// Usage:
//   node --env-file=.env.local scripts/rb-calibrate.ts                # report only, writes nothing
//   node --env-file=.env.local scripts/rb-calibrate.ts --write-config  # ALSO writes rb_config, but
//                                                                       # refuses unless every field is 100%
//
// Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (never printed; never handed to the assistant -- run this yourself, same
// convention as scripts/rb-import.ts).

import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

import { buildMetricUniverse, buildDrivers } from "../supabase/functions/_shared/ruleBreaker/scoring.ts";
import type { UniverseMember } from "../supabase/functions/_shared/ruleBreaker/scoring.ts";
import { computeScreen, computeQgroup, computeWeakPillar } from "../supabase/functions/_shared/ruleBreaker/classify.ts";
import { computeVwapZ, computeVwapState, computeAction } from "../supabase/functions/_shared/ruleBreaker/vwap.ts";
import type { RbFundamentalsRaw, Drivers, DriverGroup } from "../supabase/functions/_shared/ruleBreaker/types.ts";

interface Tally {
  match: number;
  total: number;
  mismatches: string[]; // "SYMBOL: expected=X got=Y"
}

function newTally(): Tally {
  return { match: 0, total: 0, mismatches: [] };
}

function record(tally: Tally, symbol: string, expected: unknown, actual: unknown, tolerance = 0) {
  tally.total++;
  const bothNull = expected == null && actual == null;
  const numericClose =
    typeof expected === "number" && typeof actual === "number" && Math.abs(expected - actual) <= tolerance;
  const exact = expected === actual;
  if (bothNull || numericClose || exact) {
    tally.match++;
  } else if (tally.mismatches.length < 10) {
    tally.mismatches.push(`${symbol}: expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
  }
}

function report(name: string, tally: Tally) {
  const pct = tally.total === 0 ? 0 : (tally.match / tally.total) * 100;
  console.log(`${name}: ${tally.match}/${tally.total} (${pct.toFixed(1)}%)`);
  if (tally.mismatches.length > 0) {
    console.log(`  sample mismatches: ${tally.mismatches.slice(0, 5).join("; ")}`);
  }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set -- add it to .env.local`);
  return v;
}

interface BaselineRow {
  symbol: string;
  date: string;
  c1: number | null; c2: number | null; c3: number | null; c4: number | null; c5: number | null; c6: number | null;
  met: number | null; composite: number | null; score: number | null; rank: number | null;
  screen: string | null; safety: number | null; quality: number | null; qgroup: string | null;
  weak_pillar: string | null; risk_type: string | null;
  action: string | null; action_key: string | null; action_why: string | null;
  vwap_state: string | null; vwap_z: number | null;
  drivers: Drivers;
}

async function main() {
  const { values } = parseArgs({ options: { "write-config": { type: "boolean", default: false } } });

  const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  console.log("Loading live rb_* data...");

  const [fundamentalsRes, weeklyBarsRes, companiesRes, foolRes, baselineRes, historyRes, holdingsRes] =
    await Promise.all([
      supabase.from("rb_fundamentals").select("symbol, asof, raw, mcap_usd, fx_to_usd"),
      supabase.from("rb_weekly_bars").select("symbol, week_start, close, vwap6_a, vwap6_sigma, vwap12_b, signal"),
      supabase.from("rb_companies").select("symbol, sector"),
      supabase.from("rb_fool").select("symbol, f5, type, top10, closed_on"),
      supabase.from("rb_scores").select("*").eq("config_version", "artifact-v15").eq("partial", false),
      supabase.from("rb_scores").select("symbol, date, score").eq("config_version", "artifact-v15").eq("partial", true),
      supabase
        .from("portfolio_holdings")
        .select("holdings!inner(symbol, quantity), portfolios!inner(rb_strategy)")
        .eq("portfolios.rb_strategy", true),
    ]);

  for (const [name, res] of Object.entries({ fundamentalsRes, weeklyBarsRes, companiesRes, foolRes, baselineRes, historyRes, holdingsRes })) {
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
  }

  const fundamentals = fundamentalsRes.data! as { symbol: string; asof: string; raw: RbFundamentalsRaw; mcap_usd: number | null; fx_to_usd: number | null }[];
  const weeklyBars = weeklyBarsRes.data! as { symbol: string; week_start: string; close: number | null; vwap6_a: number | null; vwap6_sigma: number | null; vwap12_b: number | null; signal: "u" | "d" | null }[];
  const fool = new Map((foolRes.data as { symbol: string; closed_on: string | null }[]).map((f) => [f.symbol, f]));
  const baseline = baselineRes.data! as BaselineRow[];
  const history = historyRes.data! as { symbol: string; date: string; score: number | null }[];
  const liveOwnedRows = (holdingsRes.data ?? []) as unknown as { holdings: { symbol: string; quantity: number } }[];
  const liveOwned = new Set(liveOwnedRows.map((r) => r.holdings).filter((h) => Number(h.quantity) > 0).map((h) => h.symbol));

  if (baseline.length === 0) {
    throw new Error("No full-breakdown baseline rows found (config_version='artifact-v15' AND partial=false) -- nothing to calibrate against.");
  }
  const baselineDates = new Set(baseline.map((r) => r.date));
  if (baselineDates.size !== 1) {
    throw new Error(
      `Expected all baseline rows to share one date, found ${baselineDates.size}: ${[...baselineDates].join(", ")} -- ` +
        "the 'one baseline file' assumption about the export may be wrong; investigate before trusting anything below.",
    );
  }
  const baselineDate = [...baselineDates][0];
  console.log(`Baseline date: ${baselineDate}, ${baseline.length} full-breakdown symbols.\n`);

  // Preflight: does the live fundamentals/weekly-bars snapshot actually
  // line up with the baseline date? A mismatch here means any formula
  // "failure" below is a stale-input artifact, not a real formula bug.
  const staleFundamentals = fundamentals.filter((f) => f.asof !== baselineDate);
  const latestBarDateBySymbol = new Map<string, string>();
  for (const bar of weeklyBars) {
    const prev = latestBarDateBySymbol.get(bar.symbol);
    if (!prev || bar.week_start > prev) latestBarDateBySymbol.set(bar.symbol, bar.week_start);
  }
  const staleBars = baseline.filter((r) => latestBarDateBySymbol.get(r.symbol) !== baselineDate);
  console.log(
    `Preflight: ${staleFundamentals.length} symbol(s) with rb_fundamentals.asof != baseline date, ` +
      `${staleBars.length} symbol(s) whose latest rb_weekly_bars.week_start != baseline date.`,
  );
  if (staleFundamentals.length > 0 || staleBars.length > 0) {
    console.log("  (if these are non-zero, treat mismatches below with suspicion -- they may be stale-input, not formula, issues)\n");
  } else {
    console.log("  clean -- every symbol's inputs line up with the baseline date.\n");
  }

  // Percentile universe = exactly the symbols present in the baseline rows
  // (not rb_companies generally, which can drift post-import) -- per the
  // Plan-agent review this session.
  const baselineSymbols = new Set(baseline.map((r) => r.symbol));
  const universeMembers: UniverseMember[] = fundamentals
    .filter((f) => baselineSymbols.has(f.symbol))
    .map((f) => ({ symbol: f.symbol, raw: f.raw, mcapUsd: f.mcap_usd, fxToUsd: f.fx_to_usd }));
  console.log(`Metric universe: ${universeMembers.length} symbols (expected ${baselineSymbols.size}).\n`);

  const metricUniverse = buildMetricUniverse(universeMembers);
  const fundamentalsBySymbol = new Map(fundamentals.map((f) => [f.symbol, f]));
  const barsBySymbol = new Map<string, typeof weeklyBars>();
  for (const bar of weeklyBars) {
    if (!barsBySymbol.has(bar.symbol)) barsBySymbol.set(bar.symbol, []);
    barsBySymbol.get(bar.symbol)!.push(bar);
  }
  for (const bars of barsBySymbol.values()) bars.sort((a, b) => a.week_start.localeCompare(b.week_start));
  const historyBySymbol = new Map<string, typeof history>();
  for (const h of history) {
    if (!historyBySymbol.has(h.symbol)) historyBySymbol.set(h.symbol, []);
    historyBySymbol.get(h.symbol)!.push(h);
  }
  for (const hs of historyBySymbol.values()) hs.sort((a, b) => a.date.localeCompare(b.date));

  // ── 1. metrics.ts + crossSectionalRank.ts + buildMetricUniverse, via buildDrivers ──
  const driverValueTally = newTally();
  const driverPctTally = newTally();
  for (const row of baseline) {
    const fund = fundamentalsBySymbol.get(row.symbol);
    if (!fund) continue;
    const drivers = buildDrivers(fund.raw, fund.mcap_usd, fund.fx_to_usd, metricUniverse);
    for (const group of Object.keys(drivers) as DriverGroup[]) {
      const expectedGroup = row.drivers?.[group] ?? [];
      const actualGroup = drivers[group];
      for (let i = 0; i < Math.max(expectedGroup.length, actualGroup.length); i++) {
        const e = expectedGroup[i], a = actualGroup[i];
        record(driverValueTally, `${row.symbol}.${group}[${i}]`, e?.value ?? null, a?.value ?? null, 1e-6);
        record(driverPctTally, `${row.symbol}.${group}[${i}]`, e?.pct ?? null, a?.pct ?? null, 0.5);
      }
    }
  }
  report("driver values (metrics.ts formulas)", driverValueTally);
  report("driver percentiles (crossSectionalRank.ts + universe null-handling)", driverPctTally);

  // ── 2. c1-c6/safety/quality/c5/risk_type -- NONE calibrated yet, report as skipped.
  // A flat mean of driver pcts was tried for c1 and safety against the
  // FULL baseline (not just one example) and refuted for both -- see
  // pillars.ts's header comment. This is real, open calibration work for
  // a future pass (likely needs a search, e.g. linear regression against
  // the 155 ground-truth values, not more hand-guessing).
  for (const field of ["c1", "c2", "c3", "c4", "c5", "c6", "safety", "quality", "risk_type"]) {
    console.log(`${field} pillar: SKIPPED (not yet calibrated -- see pillars.ts/classify.ts)`);
  }

  // ── 4. screen/qgroup/weak_pillar, tested against the baseline's OWN met/score/quality/drivers (decoupled from the uncalibrated pillars above) ──
  const screenTally = newTally();
  const qgroupTally = newTally();
  const weakPillarTally = newTally();
  for (const row of baseline) {
    if (row.met == null || row.score == null) continue;
    record(screenTally, row.symbol, row.screen, computeScreen(row.met, row.score));
    record(qgroupTally, row.symbol, row.qgroup, computeQgroup(row.met, row.quality));
    const wp = computeWeakPillar({
      cashDrivers: row.drivers?.cash ?? [],
      trendDrivers: row.drivers?.trend ?? [],
      profDrivers: row.drivers?.prof ?? [],
      safety: row.safety,
    });
    record(weakPillarTally, row.symbol, row.weak_pillar, wp);
  }
  report("screen", screenTally);
  report("qgroup", qgroupTally);
  report("weak_pillar", weakPillarTally);
  console.log("risk_type: SKIPPED (not yet calibrated -- correlates with but != rb_fool.type)");

  // ── 5. vwap_z / vwap_state, from live rb_weekly_bars ──
  const vwapZTally = newTally();
  const vwapStateTally = newTally();
  for (const row of baseline) {
    const bars = barsBySymbol.get(row.symbol);
    if (!bars || bars.length === 0) continue;
    const current = bars[bars.length - 1];
    const prior = bars.length >= 2 ? bars[bars.length - 2] : null;
    if (current.close == null || current.vwap6_a == null || current.vwap6_sigma == null) continue;
    const z = computeVwapZ(current.close, current.vwap6_a, current.vwap6_sigma);
    record(vwapZTally, row.symbol, row.vwap_z, z == null ? null : Math.round(z * 100) / 100, 0.01);
    if (z != null) {
      const state = computeVwapState(z, current.signal, current.vwap6_a, prior?.vwap6_a ?? null);
      record(vwapStateTally, row.symbol, row.vwap_state, state);
    }
  }
  report("vwap_z", vwapZTally);
  report("vwap_state", vwapStateTally);

  // ── 6. action/action_key, tested against the baseline's OWN score/safety/met/vwap_state (decoupled), using live owned-derivation + rb_scores_history for priorWeekScore ──
  const actionKeyTally = newTally();
  for (const row of baseline) {
    if (row.score == null || row.safety == null || row.met == null || row.vwap_state == null || row.vwap_z == null) continue;
    const bars = barsBySymbol.get(row.symbol);
    const current = bars?.[bars.length - 1];
    if (!current?.vwap6_a || !current?.vwap6_sigma) continue;
    const hist = historyBySymbol.get(row.symbol) ?? [];
    const priorRow = [...hist].filter((h) => h.date < row.date).pop();
    const result = computeAction({
      symbol: row.symbol,
      score: row.score,
      safety: row.safety,
      met: row.met,
      owned: liveOwned.has(row.symbol),
      vwapState: row.vwap_state as never,
      vwapZ: row.vwap_z,
      closedOn: fool.get(row.symbol)?.closed_on ?? null,
      priorWeekScore: priorRow?.score ?? null,
      vwap6a: current.vwap6_a,
      vwap6sigma: current.vwap6_sigma,
    });
    record(actionKeyTally, row.symbol, row.action_key, result.actionKey);
  }
  report("action_key", actionKeyTally);

  // ── Summary + optional rb_config write ──
  const allTallies = [driverValueTally, driverPctTally, c1Tally, screenTally, qgroupTally, weakPillarTally, vwapZTally, vwapStateTally, actionKeyTally];
  const allPerfect = allTallies.every((t) => t.total > 0 && t.match === t.total);
  console.log(`\nAll measured fields at 100%: ${allPerfect}`);
  console.log("(c2-c6/safety/quality/c5/risk_type are not included in that check -- they're skipped above, not measured)");

  if (values["write-config"]) {
    if (!allPerfect) {
      console.error("\n--write-config refused: not every measured field is at 100%. Fix the mismatches above first.");
      process.exit(1);
    }
    // Deliberately NOT implemented further: c2-c6/safety/quality/c5/
    // risk_type/vwap_state's residual gap must be fully solved (not just
    // the measured fields above) before there's anything real to write
    // into rb_config.weights/thresholds. Writing now would lock in an
    // incomplete config under a version bump, which is worse than not
    // writing at all.
    console.error(
      "\n--write-config refused: c2-c6/safety/quality/c5/risk_type are still NotCalibratedError stubs " +
        "and vwap_state has a confirmed 92% (not 100%) match rate -- there is nothing complete to write yet.",
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
