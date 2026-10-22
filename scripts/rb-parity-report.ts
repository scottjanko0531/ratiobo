#!/usr/bin/env node
// Rule Breaker Screener, Phase 3 — ongoing parity check between RatioBo's
// own live scores (rb_scores where config_version='ratiobo-v1') and the
// artifact's real numbers for the same date. Replaces scripts/rb-
// calibrate.ts's one-time "does our engine match the historical
// baseline" gate, which this supersedes -- that script is deleted
// alongside this one landing, since its whole job is now done on an
// ongoing basis against live data instead.
//
// Run by hand, whenever Scott has a fresh export (via Claude in Cowork)
// of the artifact's own daily numbers for a given date.
//
// Export shape: assumed to match rb_scores_baseline_<date>.json's own
// shape from the Phase 1 import (the most likely thing Cowork would
// reproduce) -- one JSON array of objects with at least
// {symbol, score, met, screen, safety, risk_type, action, c1..c6}. Not
// yet confirmed against a real export; adjust the field reads below if
// Cowork's actual shape differs once Scott has one.
//
// Usage:
//   node --env-file=.env.local scripts/rb-parity-report.ts --date=2026-10-20 --export=/path/to/export.json
//
// Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (never printed; never handed to the assistant -- run this yourself,
// same convention as scripts/rb-import.ts).

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

interface ArtifactRow {
  symbol: string;
  score?: number | null;
  met?: number | null;
  screen?: string | null;
  safety?: number | null;
  risk_type?: string | null;
  action?: string | null;
  action_key?: string | null;
  c1?: number | null; c2?: number | null; c3?: number | null;
  c4?: number | null; c5?: number | null; c6?: number | null;
}

interface RbScoresRow {
  symbol: string;
  score: number | null;
  met: number | null;
  screen: string | null;
  safety: number | null;
  risk_type: string | null;
  action: string | null;
  action_key: string | null;
  c1: number | null; c2: number | null; c3: number | null;
  c4: number | null; c5: number | null; c6: number | null;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name} -- set it in .env.local`);
  return v;
}

function numDiffOver(a: number | null | undefined, b: number | null | undefined, tolerance: number): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > tolerance;
}

function strDiffers(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) !== (b ?? null);
}

async function main() {
  const { values } = parseArgs({
    options: {
      date: { type: "string" },
      export: { type: "string" },
      "config-version": { type: "string", default: "ratiobo-v1" },
    },
  });
  if (!values.export) throw new Error("--export=<path to Cowork export JSON> is required");
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const configVersion = values["config-version"]!;

  const artifactRows = JSON.parse(readFileSync(values.export, "utf8")) as ArtifactRow[];
  const artifactBySymbol = new Map(artifactRows.map((r) => [r.symbol, r]));

  const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const { data, error } = await supabase
    .from("rb_scores")
    .select("symbol, score, met, screen, safety, risk_type, action, action_key, c1, c2, c3, c4, c5, c6")
    .eq("config_version", configVersion)
    .eq("date", date);
  if (error) throw new Error(`rb_scores query: ${error.message}`);
  const ratioboRows = (data ?? []) as RbScoresRow[];
  const ratioboBySymbol = new Map(ratioboRows.map((r) => [r.symbol, r]));

  const onlyInArtifact = [...artifactBySymbol.keys()].filter((s) => !ratioboBySymbol.has(s));
  const onlyInRatiobo = [...ratioboBySymbol.keys()].filter((s) => !artifactBySymbol.has(s));

  const diffs: string[] = [];
  for (const [symbol, artifact] of artifactBySymbol) {
    const mine = ratioboBySymbol.get(symbol);
    if (!mine) continue;
    const reasons: string[] = [];
    if (numDiffOver(artifact.score, mine.score, 1)) reasons.push(`score ${artifact.score}->${mine.score}`);
    for (const sign of ["c1", "c2", "c3", "c4", "c5", "c6"] as const) {
      if (numDiffOver(artifact[sign], mine[sign], 1)) reasons.push(`${sign} ${artifact[sign]}->${mine[sign]}`);
    }
    if ((artifact.met ?? null) !== (mine.met ?? null)) reasons.push(`met ${artifact.met}->${mine.met}`);
    if (strDiffers(artifact.screen, mine.screen)) reasons.push(`screen ${artifact.screen}->${mine.screen}`);
    const artifactVeto = artifact.safety != null && artifact.safety < 20;
    const mineVeto = mine.safety != null && mine.safety < 20;
    if (artifactVeto !== mineVeto) reasons.push(`safety-veto ${artifactVeto}->${mineVeto} (safety ${artifact.safety}->${mine.safety})`);
    if (strDiffers(artifact.risk_type, mine.risk_type)) reasons.push(`risk_type ${artifact.risk_type}->${mine.risk_type}`);
    if (strDiffers(artifact.action, mine.action) || strDiffers(artifact.action_key, mine.action_key)) {
      reasons.push(`action ${artifact.action_key}->${mine.action_key}`);
    }
    if (reasons.length > 0) diffs.push(`${symbol}: ${reasons.join(", ")}`);
  }

  console.log(`Rule Breaker parity report -- date=${date} config_version=${configVersion}`);
  console.log(`artifact rows: ${artifactRows.length}, ratiobo rows: ${ratioboRows.length}`);
  if (onlyInArtifact.length > 0) console.log(`only in artifact export: ${onlyInArtifact.join(", ")}`);
  if (onlyInRatiobo.length > 0) console.log(`only in ratiobo rb_scores: ${onlyInRatiobo.join(", ")}`);
  if (diffs.length === 0) {
    console.log("no differences found on any compared symbol.");
  } else {
    console.log(`${diffs.length} symbol(s) differ:`);
    for (const d of diffs) console.log(`  ${d}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
