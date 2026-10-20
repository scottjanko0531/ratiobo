#!/usr/bin/env node
// Rule Breaker Screener — one-time import from the claude.ai artifact's
// JSON export (Phase 1, build spec). Run once by hand after Scott hands
// over the export; safe to re-run (idempotent upserts on each table's own
// primary key).
//
// Export shape (confirmed against the real rule-breaker-ratiobo-import.zip,
// 2026-10-19): one JSON array per target table, already close to the final
// column names, NOT a single nested blob keyed by "collection" -- the
// build spec's own description ("collections companies, ratings,
// holdings, scorehist, theses, tags, meta") described the OLD artifact's
// internal Firestore-style shape, not this export's actual file layout.
// Point this script at the directory the zip extracts to; it reads each
// file below by its expected name.
//
//   rb_companies.json       -> rb_companies
//   rb_fool.json             -> rb_fool
//   rb_holders_13f.json      -> rb_holders_13f
//   rb_fundamentals.json     -> rb_fundamentals
//   rb_weekly_bars.json      -> rb_weekly_bars
//   rb_ratings.json          -> rb_ratings (per-user -- needs --user-id)
//   rb_scores_history.json   -> rb_scores (weekly, score-only snapshots)
//   rb_scores_baseline_*.json -> rb_scores (full breakdown for one date --
//                                 filename's date suffix is read verbatim,
//                                 not parsed/validated)
//   rb_theses.json           -> rb_theses (per-user -- needs --user-id)
//   rb_thesis_tags.json      -> rb_thesis_tags
//   rb_owned_check.json      -> NOT imported -- cross-checked against live
//                                 portfolio data only, per the build spec's
//                                 explicit "report mismatches, don't import"
//   rb_meta.json             -> one rb_job_runs row (informational log of
//                                 the artifact's last refresh), not rb_config
//                                 -- rb_config is live-engine scoring
//                                 calibration (Phase 2+), unrelated to "when
//                                 did the old artifact last refresh."
//
// Deviates from scripts/backfill-dtb3.mjs's raw-fetch/.mjs precedent:
// @supabase/supabase-js (already a project dependency) and a TS module
// with exported pure mapping functions, unit-tested against a synthetic
// fixture in tests/rbImportMapping.test.ts -- justified by this script's
// size (10 files -> 9 tables, plus a holdings cross-check), unlike
// backfill-dtb3's single series/table. Runs directly on Node's native TS
// type-stripping -- no tsx/ts-node dependency.
//
// Usage:
//   node --env-file=.env.local scripts/rb-import.ts <export-dir>                  # dry run, writes nothing
//   node --env-file=.env.local scripts/rb-import.ts <export-dir> --write \
//     --user-id=<uuid>             # ratings/theses are per-user -- required with --write
//     [--rb-portfolio-id=<uuid>]   # also sets portfolios.rb_strategy=true on that one portfolio
//
// Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (never printed; never handed to the assistant -- run this yourself).

import { parseArgs } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ── export file row shapes (confirmed against the real export) ──

export interface ExportCompanyRow {
  symbol: string;
  yahoo: string;
  name: string;
  sector: string | null;
  industry: string | null;
  quote_currency: string;
  source: "fool" | "our";
  added: string | null;
  note: string | null;
  active: boolean;
}

export interface ExportFoolRow {
  symbol: string;
  f5: number | null;
  type: "Cautious" | "Moderate" | "Aggressive" | null;
  first_rec: string | null; // bare year string, e.g. "2022" -- not a parseable date
  recs: number | null;
  top10: boolean;
  status: "active" | "closed";
  closed_on: string | null;
}

export interface ExportHolder13fRow {
  symbol: string;
  quarter: string; // free-text filing label, not a quarter-end date
  fund: string;
  weight_pct: number | null;
  change: "new" | "add" | "cut" | null;
}

export interface ExportFundamentalsRow {
  symbol: string;
  asof: string;
  fcur: string | null;
  fx_to_usd: number | null;
  mcap_usd: number | null;
  price?: number | null;
  price_asof?: string | null;
  raw: Record<string, unknown>;
}

export interface ExportWeeklyBarRow {
  symbol: string;
  week_start: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  vwap6: number | null;
  vwap6_sd: number | null;
  vwap12: number | null;
  signal: string | null;
}

export interface ExportRatingRow {
  symbol: string;
  td: number | null;
  moat: number | null;
  mgmt: number | null;
  appeal: number | null;
  founder: boolean;
  why: string | null;
  appeal_why: string | null;
  appeal_basis: string;
  rated_by: string | null; // free-text annotator name, e.g. "Claude" -- not a RatioBo user
  rated_on: string | null;
  appeal_rated_on: string | null;
  source_url: string | null;
}

export interface ExportScoreHistoryRow {
  symbol: string;
  date: string;
  score: number | null;
  config_version: string;
  partial: boolean;
}

export interface ExportScoreBaselineRow {
  symbol: string;
  date: string;
  config_version: string;
  rank: number | null;
  score: number | null;
  met: number | null;
  c1: number | null;
  c2: number | null;
  c3: number | null;
  c4: number | null;
  c5: number | null;
  c6: number | null;
  composite: number | null;
  screen: string | null;
  safety: number | null;
  quality: number | null;
  qgroup: string | null;
  weak_pillar: string | null;
  risk_type: string | null;
  owned?: boolean; // snapshot-time fact for the parity test only -- never stored (see header comment)
  vwap_state: string | null;
  vwap_z: number | null;
  action: string | null;
  action_key: string | null;
  action_why: string | null;
  drivers: Record<string, unknown>;
}

export interface ExportThesisRow {
  id: string;
  name: string;
  note: string | null;
  created: string | null;
}

export interface ExportThesisTagRow {
  symbol: string;
  thesis_id: string;
}

export interface ExportOwnedCheckRow {
  symbol: string;
  owned: boolean;
  updated: string | null;
}

export interface ExportMeta {
  fool_check_note?: string;
  fool_checked?: string;
  fool_top10_label?: string;
  last_refresh?: string;
  notes?: string;
  [key: string]: unknown;
}

// ── DB row shapes (match the migration columns exactly) ──

export interface RbCompanyRow {
  symbol: string;
  yahoo_symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  currency: string;
  source: "fool" | "our";
  added: string | null;
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

export type RbHolders13fRow = ExportHolder13fRow;

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
  rated_by: string | null;
  rated_on: string | null;
  appeal_rated_on: string | null;
  source_url: string | null;
}

export interface RbScoreRow {
  symbol: string;
  date: string;
  config_version: string;
  c1: number | null;
  c2: number | null;
  c3: number | null;
  c4: number | null;
  c5: number | null;
  c6: number | null;
  met: number | null;
  composite: number | null;
  score: number | null;
  rank: number | null;
  screen: string | null;
  safety: number | null;
  quality: number | null;
  qgroup: string | null;
  weak_pillar: string | null;
  risk_type: string | null;
  action: string | null;
  action_key: string | null;
  action_why: string | null;
  vwap_state: string | null;
  vwap_z: number | null;
  partial: boolean | null;
  drivers: Record<string, unknown>;
}

export interface RbThesisRow {
  id: string;
  user_id: string;
  name: string;
  note: string | null;
  created_at: string | null;
}

export type RbThesisTagRow = ExportThesisTagRow;

// ── pure mapping functions (unit-tested, no I/O) ──

export function mapCompanies(rows: ExportCompanyRow[]): RbCompanyRow[] {
  return rows.map((r) => ({
    symbol: r.symbol,
    yahoo_symbol: r.yahoo,
    name: r.name,
    sector: r.sector ?? null,
    industry: r.industry ?? null,
    currency: r.quote_currency ?? "USD",
    source: r.source ?? "our",
    added: r.added ?? null,
    note: r.note ?? null,
    active: r.active ?? true,
  }));
}

export function mapFool(rows: ExportFoolRow[]): RbFoolRow[] {
  return rows.map((r) => ({
    symbol: r.symbol,
    f5: r.f5 ?? null,
    type: r.type ?? null,
    first_rec: r.first_rec ?? null,
    recs: r.recs ?? null,
    top10: r.top10 ?? false,
    status: r.status ?? "active",
    closed_on: r.closed_on ?? null,
  }));
}

export function mapHolders13f(rows: ExportHolder13fRow[]): RbHolders13fRow[] {
  return rows.map((r) => ({ ...r }));
}

export function mapFundamentals(rows: ExportFundamentalsRow[]): RbFundamentalsRow[] {
  return rows.map((r) => {
    // price/price_asof aren't their own columns (not a scored input per
    // the build spec's raw-fields table) -- folded into `raw` rather than
    // dropped, so nothing from the export is silently lost.
    const raw: Record<string, unknown> = { ...r.raw };
    if (r.price !== undefined) raw.price = r.price;
    if (r.price_asof !== undefined) raw.price_asof = r.price_asof;
    return {
      symbol: r.symbol,
      asof: r.asof,
      raw,
      fcur: r.fcur ?? null,
      fx_to_usd: r.fx_to_usd ?? null,
      mcap_usd: r.mcap_usd ?? null,
    };
  });
}

export function mapWeeklyBars(rows: ExportWeeklyBarRow[]): RbWeeklyBarRow[] {
  return rows.map((r) => ({
    symbol: r.symbol,
    week_start: r.week_start,
    open: r.open ?? null,
    high: r.high ?? null,
    low: r.low ?? null,
    close: r.close ?? null,
    volume: r.volume ?? null,
    vwap6_a: r.vwap6 ?? null,
    vwap6_sigma: r.vwap6_sd ?? null,
    vwap12_b: r.vwap12 ?? null,
    signal: r.signal ?? null,
  }));
}

export function mapRatings(rows: ExportRatingRow[], userId: string): RbRatingRow[] {
  return rows.map((r) => ({
    symbol: r.symbol,
    user_id: userId,
    td: r.td ?? null,
    moat: r.moat ?? null,
    mgmt: r.mgmt ?? null,
    appeal: r.appeal ?? null,
    founder: r.founder ?? false,
    why: r.why ?? null,
    appeal_why: r.appeal_why ?? null,
    appeal_basis: r.appeal_basis ?? "customer",
    rated_by: r.rated_by ?? null,
    rated_on: r.rated_on ?? null,
    appeal_rated_on: r.appeal_rated_on ?? null,
    source_url: r.source_url ?? null,
  }));
}

export function mapScoreHistory(rows: ExportScoreHistoryRow[]): RbScoreRow[] {
  return rows.map((r) => ({
    symbol: r.symbol,
    date: r.date,
    config_version: r.config_version,
    c1: null, c2: null, c3: null, c4: null, c5: null, c6: null,
    met: null,
    composite: null,
    score: r.score ?? null,
    rank: null,
    screen: null,
    safety: null,
    quality: null,
    qgroup: null,
    weak_pillar: null,
    risk_type: null,
    action: null,
    action_key: null,
    action_why: null,
    vwap_state: null,
    vwap_z: null,
    partial: r.partial ?? null,
    drivers: {},
  }));
}

export function mapScoreBaseline(rows: ExportScoreBaselineRow[]): RbScoreRow[] {
  // `owned` is deliberately dropped -- the build spec is explicit that
  // ownership is never stored on rb_scores (or anywhere in rb_*), only
  // ever derived live from portfolios.rb_strategy -> portfolio_holdings ->
  // holdings.quantity > 0.
  return rows.map((r) => ({
    symbol: r.symbol,
    date: r.date,
    config_version: r.config_version,
    c1: r.c1 ?? null,
    c2: r.c2 ?? null,
    c3: r.c3 ?? null,
    c4: r.c4 ?? null,
    c5: r.c5 ?? null,
    c6: r.c6 ?? null,
    met: r.met ?? null,
    composite: r.composite ?? null,
    score: r.score ?? null,
    rank: r.rank ?? null,
    screen: r.screen ?? null,
    safety: r.safety ?? null,
    quality: r.quality ?? null,
    qgroup: r.qgroup ?? null,
    weak_pillar: r.weak_pillar ?? null,
    risk_type: r.risk_type ?? null,
    action: r.action ?? null,
    action_key: r.action_key ?? null,
    action_why: r.action_why ?? null,
    vwap_state: r.vwap_state ?? null,
    vwap_z: r.vwap_z ?? null,
    partial: false,
    drivers: r.drivers ?? {},
  }));
}

export function mapTheses(rows: ExportThesisRow[], userId: string): RbThesisRow[] {
  return rows.map((r) => ({
    id: r.id,
    user_id: userId,
    name: r.name,
    note: r.note ?? null,
    created_at: r.created ?? null,
  }));
}

export function mapThesisTags(rows: ExportThesisTagRow[]): RbThesisTagRow[] {
  return rows.map((r) => ({ ...r }));
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

function readJsonArray<T>(dir: string, filename: string): T[] {
  try {
    return JSON.parse(readFileSync(join(dir, filename), "utf8")) as T[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function findScoreBaselineFile(dir: string): string | null {
  return readdirSync(dir).find((f) => /^rb_scores_baseline_.*\.json$/.test(f)) ?? null;
}

async function fetchLiveOwnedSymbols(
  supabase: SupabaseClient,
  rbPortfolioId?: string,
): Promise<{ symbol: string; quantity: number }[]> {
  const { data, error } = rbPortfolioId
    ? await supabase
        .from("portfolio_holdings")
        .select("holdings!inner(symbol, quantity)")
        .eq("portfolio_id", rbPortfolioId)
    : await supabase
        .from("portfolio_holdings")
        .select("holdings!inner(symbol, quantity), portfolios!inner(rb_strategy)")
        .eq("portfolios.rb_strategy", true);

  if (error) throw new Error(`fetchLiveOwnedSymbols: ${error.message}`);
  const rows = (data ?? []) as unknown as { holdings: { symbol: string; quantity: number } }[];
  return rows.map((r) => r.holdings).filter((h) => Number(h.quantity) > 0);
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

  const exportDir = positionals[0];
  if (!exportDir) {
    console.error(
      "usage: rb-import.ts <export-dir> [--write] [--user-id=<uuid>] [--rb-portfolio-id=<uuid>]",
    );
    process.exit(1);
  }

  const companies = mapCompanies(readJsonArray(exportDir, "rb_companies.json"));
  const fool = mapFool(readJsonArray(exportDir, "rb_fool.json"));
  const holders13f = mapHolders13f(readJsonArray(exportDir, "rb_holders_13f.json"));
  const fundamentals = mapFundamentals(readJsonArray(exportDir, "rb_fundamentals.json"));
  const weeklyBars = mapWeeklyBars(readJsonArray(exportDir, "rb_weekly_bars.json"));
  const scoreHistory = mapScoreHistory(readJsonArray(exportDir, "rb_scores_history.json"));

  const baselineFile = findScoreBaselineFile(exportDir);
  const scoreBaseline = baselineFile
    ? mapScoreBaseline(readJsonArray(exportDir, baselineFile))
    : [];
  const scores = [...scoreHistory, ...scoreBaseline];

  const rawTheses = readJsonArray<ExportThesisRow>(exportDir, "rb_theses.json");
  const rawThesisTags = readJsonArray<ExportThesisTagRow>(exportDir, "rb_thesis_tags.json");
  const rawRatings = readJsonArray<ExportRatingRow>(exportDir, "rb_ratings.json");

  const userId = values["user-id"];
  const hasRatingsOrTheses = rawRatings.length > 0 || rawTheses.length > 0;
  if (hasRatingsOrTheses && !userId) {
    console.error(
      "export contains ratings/theses but no --user-id=<uuid> was given -- " +
        "rb_ratings/rb_theses are per-user (see 20261019_rule_breaker_user_owned_tables.sql), " +
        "so a target user must be specified explicitly.",
    );
    process.exit(1);
  }
  const ratings = userId ? mapRatings(rawRatings, userId) : [];
  const theses = userId ? mapTheses(rawTheses, userId) : [];
  const tags = mapThesisTags(rawThesisTags);

  let metaDict: ExportMeta | null = null;
  try {
    metaDict = JSON.parse(readFileSync(join(exportDir, "rb_meta.json"), "utf8")) as ExportMeta;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const liveOwned = await fetchLiveOwnedSymbols(supabase, values["rb-portfolio-id"]);
  const ownedCheck = readJsonArray<ExportOwnedCheckRow>(exportDir, "rb_owned_check.json");
  const artifactOwned = ownedCheck.filter((h) => h.owned).map((h) => h.symbol);
  const mismatches = crossCheckHoldings(artifactOwned, liveOwned);

  console.log(
    `companies: ${companies.length}, fool: ${fool.length}, 13f rows: ${holders13f.length}, ` +
      `fundamentals: ${fundamentals.length}, weekly bars: ${weeklyBars.length}, ` +
      `score history: ${scoreHistory.length}, score baseline: ${scoreBaseline.length} ` +
      `(from ${baselineFile ?? "none found"}), ratings: ${ratings.length}, theses: ${theses.length}, ` +
      `thesis tags: ${tags.length}, meta: ${metaDict ? "found" : "none"}`,
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
    if (metaDict) {
      await supabase.from("rb_job_runs").insert({
        job_name: "rb-import-legacy-meta",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: "ok",
        detail: metaDict,
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
