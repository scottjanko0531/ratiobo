#!/usr/bin/env node
// Phase 2b fundamentals loader: same output as load_fundamentals.mjs
// (identical derivation logic, shared via lib/fundamentalsCore.mjs), but
// reads tag entries from SEC's companyfacts.zip bulk file instead of one
// HTTP call per tag per company.
//
// Why not SEC's frames API: frames returns one deduplicated value per
// company per period -- the LATEST filed -- which would bake restated
// numbers into history (look-ahead bias, exactly what the point-in-time
// design exists to prevent). companyfacts.zip preserves every filed
// vintage with its own filed date, same as the per-company
// companyconcept API this replaces, so fundamentalsCore.mjs's logic
// (including "earliest-filed wins" point-in-time dedup) is UNCHANGED --
// only how raw entries are fetched differs.
//
// Why this instead of per-company HTTP at Phase 2b scale: ~26 SEC
// requests/company (13 metrics x tag fallbacks + fallback-derivation
// helper tags) at SEC's 10 req/s cap is ~18 hours sequential for ~8,000
// companies. One 1.3GB download + local JSON reads has no rate limit at
// all, and no network round-trip per tag.
//
// Validated 2026-11-05 against the 176-company Phase 2a population: this
// bulk-file path reproduces every existing scr_fundamentals row (same
// value and filed_date) for every company whose CIK exists in the
// companyfacts.zip snapshot -- see scripts/backfill/verify_bulk_fundamentals.mjs.
//
// Usage: node scripts/backfill/load_fundamentals_bulk.mjs <path-to-companyfacts.zip> [SYMBOL ...]

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvLocal, requireEnv } from "./lib/env.mjs";
import { makeScrIngest } from "./lib/scrIngest.mjs";
import { filterUnitsEntries } from "./lib/sec.mjs";
import { loadCompanyFacts } from "./lib/companyFactsZip.mjs";
import { buildFundamentalsForCompany, ALL_METRICS } from "./lib/fundamentalsCore.mjs";

const COMPANIES_FILE = process.env.COMPANIES_FILE ?? "scripts/backfill/data/companies.json";
const PROGRESS_FILE = process.env.PROGRESS_FILE ?? "scripts/backfill/data/fundamentals_bulk_progress.json";
const JOB_NAME = "scr_load_fundamentals_bulk_2b";
const INGEST_BATCH_SIZE = 500;

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

function makeFetchTagEntries(companyFacts) {
  return async (tag, opts) => {
    const taxonomy = companyFacts?.facts?.[opts.namespace ?? "us-gaap"];
    return filterUnitsEntries(taxonomy?.[tag]?.units?.[opts.unit], opts.kind);
  };
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath || !existsSync(zipPath)) throw new Error("usage: load_fundamentals_bulk.mjs <path-to-companyfacts.zip> [SYMBOL ...]");

  const env = loadEnvLocal(".env.local");
  requireEnv(env, ["NEXT_PUBLIC_SUPABASE_URL", "SCR_INGEST_KEY"]);
  const ingest = makeScrIngest(env);

  const allCompanies = await loadJson(COMPANIES_FILE, []);
  if (allCompanies.length === 0) throw new Error(`no companies in ${COMPANIES_FILE}`);

  const requested = process.argv.slice(3).map((s) => s.toUpperCase());
  const companies = requested.length > 0
    ? allCompanies.filter((c) => requested.includes(c.symbol))
    : allCompanies;

  const progress = await loadJson(PROGRESS_FILE, {});
  const pending = companies.filter((c) => progress[c.symbol]?.status !== "done");

  console.log(`companies in scope: ${companies.length}, already done: ${companies.length - pending.length}, pending: ${pending.length}`);
  if (pending.length === 0) {
    console.log("nothing to do");
    return;
  }

  const jobRunId = await ingest.startJobRun(JOB_NAME, { scope: requested.length > 0 ? requested : "full", companiesInScope: companies.length, metrics: Object.keys(ALL_METRICS), source: "companyfacts.zip" });
  console.log(`job run ${jobRunId} started`);

  const coverage = Object.fromEntries([...Object.keys(ALL_METRICS), "free_cash_flow"].map((m) => [m, 0]));
  let totalRows = 0;
  let errorCount = 0;
  let noFactsCount = 0;

  try {
    for (const company of pending) {
      try {
        const companyFacts = await loadCompanyFacts(zipPath, company.cik);
        if (!companyFacts) {
          noFactsCount += 1;
          progress[company.symbol] = { status: "done", rows: 0, metricsPresent: [], finishedAt: new Date().toISOString(), note: "no CIK entry in companyfacts.zip" };
          await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
          console.log(`${company.symbol}: no companyfacts entry (flagged)`);
          continue;
        }
        const rows = await buildFundamentalsForCompany(company, makeFetchTagEntries(companyFacts));
        for (let i = 0; i < rows.length; i += INGEST_BATCH_SIZE) {
          const batch = rows.slice(i, i + INGEST_BATCH_SIZE);
          const result = await ingest.sendFundamentals(batch);
          if (!result.fundamentals?.ok) throw new Error(`scr-ingest fundamentals write failed: ${JSON.stringify(result.fundamentals)}`);
        }
        const metricsPresent = new Set(rows.map((r) => r.metric));
        for (const m of metricsPresent) coverage[m] += 1;
        totalRows += rows.length;
        progress[company.symbol] = { status: "done", rows: rows.length, metricsPresent: [...metricsPresent], finishedAt: new Date().toISOString() };
        await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        console.log(`${company.symbol}: ${rows.length} rows across ${metricsPresent.size} metrics`);
      } catch (e) {
        errorCount += 1;
        progress[company.symbol] = { status: "error", error: String(e.message ?? e), at: new Date().toISOString() };
        await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        console.error(`${company.symbol}: ERROR -- ${String(e.message ?? e)}`);
      }
    }
  } finally {
    const status = errorCount > 0 ? "error" : "ok";
    await ingest.finishJobRun(jobRunId, status, { companiesProcessed: pending.length, totalRows, errorCount, noFactsCount, coverage });
    console.log(`job run ${jobRunId} finished: ${status}`);
  }

  console.log(`done. rows loaded: ${totalRows}, errors: ${errorCount}, no-facts: ${noFactsCount}`);
  console.log(`coverage (companies with >=1 row, out of ${companies.length}):`);
  for (const [m, n] of Object.entries(coverage)) {
    console.log(`  ${m}: ${n} (${((n / companies.length) * 100).toFixed(1)}%)`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
