#!/usr/bin/env node
// Rule Breaker Screener — one-time import from the claude.ai artifact's
// JSON export (Phase 1, build spec). Run once by hand after Scott hands
// over the export; safe to re-run (idempotent upserts on each table's own
// primary key).
//
// Deviates from scripts/backfill-dtb3.mjs's raw-fetch/.mjs precedent:
// @supabase/supabase-js (already a project dependency) and a TS module
// with exported pure mapping functions, unit-tested against a synthetic
// fixture in tests/rbImportMapping.test.ts -- justified by this script's
// size (7 collections -> 9 tables, plus a holdings cross-check), unlike
// backfill-dtb3's single series/table. Runs directly on Node's native TS
// type-stripping -- no tsx/ts-node dependency added.
//
// Usage:
//   node --env-file=.env.local scripts/rb-import.ts <export.json>                  # dry run, writes nothing
//   node --env-file=.env.local scripts/rb-import.ts <export.json> --write          # actually commits
//   node --env-file=.env.local scripts/rb-import.ts <export.json> --write \
//     --rb-portfolio-id=<uuid>   # also sets portfolios.rb_strategy=true on that one portfolio
//   node --env-file=.env.local scripts/rb-import.ts <export.json> --write --user-id=<uuid>
//     # ratings/theses are per-user (see 20261019_rule_breaker_user_owned_tables.sql) --
//     # required with --write whenever the export contains ratings/theses data.
//
// Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (never printed; never handed to the assistant -- run this yourself).

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ── types for the artifact export ──
//
// NOTE: these shapes are a best-effort guess at the artifact's actual
// field names based on the build spec's own description of each
// collection ("companies (sym, name, sector, source, fool object,
// holders, raw, chart)" etc.) -- adjust the map* functions below once
// Scott's real export lands and the exact field names are visible. The
// shapes are kept loose (optional fields, `unknown` where the spec
// doesn't pin down a structure) specifically so this first pass is cheap
// to correct without a structural rewrite.

export interface ArtifactFoolInfo {
  f5?: number | null;
  type?: "Cautious" | "Moderate" | "Aggressive" | null;
  firstRec?: string | null;
  recs?: number | null;
  top10?: boolean | null;
  status?: "active" | "closed" | null;
  closedOn?: string | null;
}

export interface ArtifactHolder13f {
  fund: string;
  quarter: string; // quarter-end date
  weight?: number | null;
  change?: "new" | "add" | "cut" | null;
}

export interface ArtifactRawFundamentals {
  asof?: string | null;
  fcur?: string | null;
  fxToUsd?: number | null;
  mcapUsd?: number | null;
  [key: string]: unknown; // the raw field grab-bag (rev[], qrev[], etc.) -- stored whole into rb_fundamentals.raw
}

export interface ArtifactWeeklyBar {
  weekStart: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  vwap6a?: number | null;
  vwap6sigma?: number | null;
  vwap12b?: number | null;
  signal?: "u" | "d" | null;
}

export interface ArtifactCompany {
  sym: string;
  name: string;
  sector?: string | null;
  industry?: string | null;
  currency?: string | null;
  source?: "fool" | "our" | null;
  added?: string | null;
  note?: string | null;
  active?: boolean | null;
  fool?: ArtifactFoolInfo | null;
  holders?: ArtifactHolder13f[] | null;
  raw?: ArtifactRawFundamentals | null;
  chart?: ArtifactWeeklyBar[] | null;
}

export interface ArtifactRating {
  sym: string;
  td?: number | null;
  moat?: number | null;
  mgmt?: number | null;
  appeal?: number | null;
  founder?: boolean | null;
  why?: string | null;
  appealWhy?: string | null;
  sourceUrl?: string | null;
  ratedOn?: string | null;
}

export interface ArtifactHoldingFlag {
  symbol: string;
  owned: boolean;
}

export interface ArtifactScoreSnapshot {
  sym: string;
  date: string; // Friday weekly snapshot date
  c1?: boolean | null;
  c2?: boolean | null;
  c3?: boolean | null;
  c4?: boolean | null;
  c5?: boolean | null;
  c6?: boolean | null;
  met?: number | null;
  composite?: number | null;
  score?: number | null;
  rank?: number | null;
  screen?: string | null;
  safety?: string | null;
  quality?: number | null;
  qgroup?: string | null;
  weakPillar?: string | null;
  riskType?: string | null;
  action?: string | null;
  actionKey?: string | null;
  actionWhy?: string | null;
  vwapState?: "u" | "d" | null;
  drivers?: Record<string, unknown> | null;
}

export interface ArtifactThesis {
  id: string;
  name: string;
  note?: string | null;
}

export interface ArtifactThesisTag {
  symbol: string;
  thesisId: string;
}

export interface ArtifactExport {
  companies: ArtifactCompany[];
  ratings: ArtifactRating[];
  holdings: ArtifactHoldingFlag[];
  scorehist: ArtifactScoreSnapshot[];
  theses: ArtifactThesis[];
  tags: ArtifactThesisTag[];
  meta?: Record<string, unknown>;
}

// ── DB row shapes (match the migration columns exactly) ──

export interface RbCompanyRow {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  currency: string;
  source: "fool" | "our";
  added: string;
  note: string | null;
  active: boolean;
}

export interface RbFoolRow {
  symbol: string;
  f5: number | null;
  type: string | null;
  first_rec: string | null;
  recs: number | null;
  top10: boolean;
  status: string;
  closed_on: string | null;
}

export interface RbHolders13fRow {
  symbol: string;
  quarter: string;
  fund: string;
  weight_pct: number | null;
  change: string | null;
}

export interface RbFundamentalsRow {
  symbol: string;
  asof: string;
  raw: Record<string, unknown>;
  fcur: string | null;
  fx_to_usd: number | null;
  mcap_usd: number | null;
}

export interface RbWeeklyBarRow {
  symbol: string;
  week_start: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  vwap6_a: number | null;
  vwap6_sigma: number | null;
  vwap12_b: number | null;
  signal: string | null;
}

export interface RbRatingRow {
  symbol: string;
  user_id: string;
  td: number | null;
  moat: number | null;
  mgmt: number | null;
  appeal: number | null;
  founder: boolean;
  why: string | null;
  appeal_why: string | null;
  appeal_basis: string;
  rated_on: string | null;
  source_url: string | null;
}

export const LEGACY_IMPORT_CONFIG_VERSION = "rb-legacy-import";

export interface RbScoreRow {
  symbol: string;
  date: string;
  config_version: string;
  c1: boolean | null;
  c2: boolean | null;
  c3: boolean | null;
  c4: boolean | null;
  c5: boolean | null;
  c6: boolean | null;
  met: number | null;
  composite: number | null;
  score: number | null;
  rank: number | null;
  screen: string | null;
  safety: string | null;
  quality: number | null;
  qgroup: string | null;
  weak_pillar: string | null;
  risk_type: string | null;
  action: string | null;
  action_key: string | null;
  action_why: string | null;
  vwap_state: string | null;
  drivers: Record<string, unknown>;
}

export interface RbThesisRow {
  id: string;
  user_id: string;
  name: string;
  note: string | null;
}

export interface RbThesisTagRow {
  symbol: string;
  thesis_id: string;
}

// ── pure mapping functions (unit-tested, no I/O) ──

export function mapCompanies(companies: ArtifactCompany[]): RbCompanyRow[] {
  return companies.map((c) => ({
    symbol: c.sym,
    name: c.name,
    sector: c.sector ?? null,
    industry: c.industry ?? null,
    currency: c.currency ?? "USD",
    source: c.source ?? "our",
    added: c.added ?? new Date().toISOString().slice(0, 10),
    note: c.note ?? null,
    active: c.active ?? true,
  }));
}

export function mapFool(companies: ArtifactCompany[]): RbFoolRow[] {
  return companies
    .filter((c) => c.fool != null)
    .map((c) => {
      const f = c.fool!;
      return {
        symbol: c.sym,
        f5: f.f5 ?? null,
        type: f.type ?? null,
        first_rec: f.firstRec ?? null,
        recs: f.recs ?? null,
        top10: f.top10 ?? false,
        status: f.status ?? "active",
        closed_on: f.closedOn ?? null,
      };
    });
}

export function mapHolders13f(companies: ArtifactCompany[]): RbHolders13fRow[] {
  const rows: RbHolders13fRow[] = [];
  for (const c of companies) {
    for (const h of c.holders ?? []) {
      rows.push({
        symbol: c.sym,
        quarter: h.quarter,
        fund: h.fund,
        weight_pct: h.weight ?? null,
        change: h.change ?? null,
      });
    }
  }
  return rows;
}

export function mapFundamentals(companies: ArtifactCompany[]): RbFundamentalsRow[] {
  return companies
    .filter((c) => c.raw != null && c.raw.asof != null)
    .map((c) => {
      const raw = c.raw!;
      // asof/fcur/fxToUsd/mcapUsd are promoted to their own columns per the
      // migration's design; the rest of the grab-bag stays in `raw` jsonb.
      const { asof, fcur, fxToUsd, mcapUsd, ...rest } = raw;
      return {
        symbol: c.sym,
        asof: asof as string,
        raw: rest,
        fcur: (fcur as string) ?? null,
        fx_to_usd: (fxToUsd as number) ?? null,
        mcap_usd: (mcapUsd as number) ?? null,
      };
    });
}

export function mapWeeklyBars(companies: ArtifactCompany[]): RbWeeklyBarRow[] {
  const rows: RbWeeklyBarRow[] = [];
  for (const c of companies) {
    for (const bar of c.chart ?? []) {
      rows.push({
        symbol: c.sym,
        week_start: bar.weekStart,
        open: bar.open ?? null,
        high: bar.high ?? null,
        low: bar.low ?? null,
        close: bar.close ?? null,
        volume: bar.volume ?? null,
        vwap6_a: bar.vwap6a ?? null,
        vwap6_sigma: bar.vwap6sigma ?? null,
        vwap12_b: bar.vwap12b ?? null,
        signal: bar.signal ?? null,
      });
    }
  }
  return rows;
}

export function mapRatings(ratings: ArtifactRating[], userId: string): RbRatingRow[] {
  return ratings.map((r) => ({
    symbol: r.sym,
    user_id: userId,
    td: r.td ?? null,
    moat: r.moat ?? null,
    mgmt: r.mgmt ?? null,
    appeal: r.appeal ?? null,
    founder: r.founder ?? false,
    why: r.why ?? null,
    appeal_why: r.appealWhy ?? null,
    appeal_basis: "customer",
    rated_on: r.ratedOn ?? null,
    source_url: r.sourceUrl ?? null,
  }));
}

export function mapScoreHistory(snapshots: ArtifactScoreSnapshot[]): RbScoreRow[] {
  return snapshots.map((s) => ({
    symbol: s.sym,
    date: s.date,
    // Sentinel, never a guessed real artifact version number -- see
    // header comment -- so these imported historical rows can never be
    // mistaken for live-engine output once Phase 2's scoring engine
    // starts writing its own config_version values.
    config_version: LEGACY_IMPORT_CONFIG_VERSION,
    c1: s.c1 ?? null,
    c2: s.c2 ?? null,
    c3: s.c3 ?? null,
    c4: s.c4 ?? null,
    c5: s.c5 ?? null,
    c6: s.c6 ?? null,
    met: s.met ?? null,
    composite: s.composite ?? null,
    score: s.score ?? null,
    rank: s.rank ?? null,
    screen: s.screen ?? null,
    safety: s.safety ?? null,
    quality: s.quality ?? null,
    qgroup: s.qgroup ?? null,
    weak_pillar: s.weakPillar ?? null,
    risk_type: s.riskType ?? null,
    action: s.action ?? null,
    action_key: s.actionKey ?? null,
    action_why: s.actionWhy ?? null,
    vwap_state: s.vwapState ?? null,
    drivers: s.drivers ?? {},
  }));
}

export function mapTheses(
  theses: ArtifactThesis[],
  tags: ArtifactThesisTag[],
  userId: string,
): { theses: RbThesisRow[]; tags: RbThesisTagRow[] } {
  return {
    theses: theses.map((t) => ({ id: t.id, user_id: userId, name: t.name, note: t.note ?? null })),
    tags: tags.map((t) => ({ symbol: t.symbol, thesis_id: t.thesisId })),
  };
}

export interface HoldingsMismatch {
  kind: "artifact_owned_not_live" | "live_not_in_artifact";
  symbol: string;
}

// Pure diff, no DB calls -- testable. Never writes ownership anywhere;
// per the spec, ownership is only ever derived live from
// portfolios.rb_strategy -> portfolio_holdings -> holdings.quantity > 0,
// this just reports where the artifact's belief and that live derivation
// disagree.
export function crossCheckHoldings(
  artifactOwned: string[],
  liveOwned: { symbol: string; quantity: number }[],
): HoldingsMismatch[] {
  const artifactSet = new Set(artifactOwned);
  const liveSet = new Set(liveOwned.map((h) => h.symbol));
  const mismatches: HoldingsMismatch[] = [];
  for (const symbol of artifactSet) {
    if (!liveSet.has(symbol)) mismatches.push({ kind: "artifact_owned_not_live", symbol });
  }
  for (const symbol of liveSet) {
    if (!artifactSet.has(symbol)) mismatches.push({ kind: "live_not_in_artifact", symbol });
  }
  return mismatches.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// ── I/O layer (not unit-tested; dry-run output is its own proof) ──

async function fetchLiveOwnedSymbols(
  supabase: SupabaseClient,
  rbPortfolioId?: string,
): Promise<{ symbol: string; quantity: number }[]> {
  let query = supabase
    .from("portfolio_holdings")
    .select("portfolios!inner(rb_strategy), holdings!inner(symbol, quantity)");

  const { data, error } = rbPortfolioId
    ? await supabase
        .from("portfolio_holdings")
        .select("holdings!inner(symbol, quantity)")
        .eq("portfolio_id", rbPortfolioId)
    : await query.eq("portfolios.rb_strategy", true);

  if (error) throw new Error(`fetchLiveOwnedSymbols: ${error.message}`);
  const rows = (data ?? []) as unknown as { holdings: { symbol: string; quantity: number } }[];
  return rows
    .map((r) => r.holdings)
    .filter((h) => Number(h.quantity) > 0);
}

async function upsertChunked(
  supabase: SupabaseClient,
  table: string,
  rows: object[],
  onConflict: string,
  opts: { ignoreDuplicates?: boolean } = {},
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict, ...opts });
    if (error) throw new Error(`${table} upsert (rows ${i}-${i + chunk.length}): ${error.message}`);
  }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set -- add it to .env.local`);
  return v;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      write: { type: "boolean", default: false },
      "rb-portfolio-id": { type: "string" },
      "user-id": { type: "string" },
    },
  });

  const exportPath = positionals[0];
  if (!exportPath) {
    console.error(
      "usage: rb-import.ts <export.json> [--write] [--rb-portfolio-id=<uuid>] [--user-id=<uuid>]",
    );
    process.exit(1);
  }

  const artifact: ArtifactExport = JSON.parse(readFileSync(exportPath, "utf8"));
  const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const companies = mapCompanies(artifact.companies ?? []);
  const fool = mapFool(artifact.companies ?? []);
  const holders13f = mapHolders13f(artifact.companies ?? []);
  const fundamentals = mapFundamentals(artifact.companies ?? []);
  const weeklyBars = mapWeeklyBars(artifact.companies ?? []);
  const scores = mapScoreHistory(artifact.scorehist ?? []);

  const userId = values["user-id"];
  const hasRatingsOrTheses = (artifact.ratings?.length ?? 0) > 0 || (artifact.theses?.length ?? 0) > 0;
  if (hasRatingsOrTheses && !userId) {
    console.error(
      "export contains ratings/theses but no --user-id=<uuid> was given -- " +
        "rb_ratings/rb_theses are per-user (see 20261019_rule_breaker_user_owned_tables.sql), " +
        "so a target user must be specified explicitly.",
    );
    process.exit(1);
  }
  const ratings = userId ? mapRatings(artifact.ratings ?? [], userId) : [];
  const { theses, tags } = userId
    ? mapTheses(artifact.theses ?? [], artifact.tags ?? [], userId)
    : { theses: [], tags: [] };

  const liveOwned = await fetchLiveOwnedSymbols(supabase, values["rb-portfolio-id"]);
  const artifactOwned = (artifact.holdings ?? []).filter((h) => h.owned).map((h) => h.symbol);
  const mismatches = crossCheckHoldings(artifactOwned, liveOwned);

  console.log(
    `companies: ${companies.length}, fool: ${fool.length}, 13f rows: ${holders13f.length}, ` +
      `fundamentals: ${fundamentals.length}, weekly bars: ${weeklyBars.length}, scores: ${scores.length}, ` +
      `ratings: ${ratings.length}, theses: ${theses.length}, thesis tags: ${tags.length}`,
  );
  if (mismatches.length === 0) {
    console.log("holdings cross-check: clean, no mismatches");
  } else {
    for (const m of mismatches) console.log(`MISMATCH [${m.kind}] ${m.symbol}`);
    console.log(
      `holdings cross-check: ${mismatches.length} mismatch(es) -- see above ` +
        "(informational only; ownership is never written by this script)",
    );
  }

  if (!values.write) {
    console.log("dry run complete -- nothing written. Pass --write to commit.");
    return;
  }

  const startedAt = new Date().toISOString();
  try {
    if (values["rb-portfolio-id"]) {
      const { error } = await supabase
        .from("portfolios")
        .update({ rb_strategy: true })
        .eq("id", values["rb-portfolio-id"]);
      if (error) throw new Error(`portfolios.rb_strategy update: ${error.message}`);
    }

    await upsertChunked(supabase, "rb_companies", companies, "symbol");
    await upsertChunked(supabase, "rb_fool", fool, "symbol");
    await upsertChunked(supabase, "rb_holders_13f", holders13f, "symbol,quarter,fund");
    await upsertChunked(supabase, "rb_fundamentals", fundamentals, "symbol,asof");
    await upsertChunked(supabase, "rb_weekly_bars", weeklyBars, "symbol,week_start");
    if (ratings.length) await upsertChunked(supabase, "rb_ratings", ratings, "symbol,user_id");
    if (theses.length) await upsertChunked(supabase, "rb_theses", theses, "id");
    if (tags.length) await upsertChunked(supabase, "rb_thesis_tags", tags, "symbol,thesis_id");
    // rb_scores is append-only -- the trigger rejects an UPDATE outright,
    // so this upsert must ignore (not overwrite) a row already imported,
    // making a re-run safe.
    if (scores.length) {
      await upsertChunked(supabase, "rb_scores", scores, "symbol,date,config_version", {
        ignoreDuplicates: true,
      });
    }

    await supabase.from("rb_job_runs").insert({
      job_name: "rb-import",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "ok",
      detail: { companies: companies.length, scores: scores.length, mismatches: mismatches.length },
    });
    console.log("import complete.");
  } catch (e) {
    await supabase.from("rb_job_runs").insert({
      job_name: "rb-import",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "error",
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
