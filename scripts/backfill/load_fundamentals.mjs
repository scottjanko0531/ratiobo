#!/usr/bin/env node
// Phase 2a step 5 (Stock Screen Research Platform spec): point-in-time
// fundamentals backfill into scr_fundamentals via per-company SEC
// companyconcept HTTP calls. All metric definitions and derivation logic
// (tag-fallback merge, deriveQuarters, gross_profit/total_debt/
// total_liabilities/free_cash_flow fallbacks) live in
// scripts/backfill/lib/fundamentalsCore.mjs, shared with
// load_fundamentals_bulk.mjs (the companyfacts.zip bulk-file path built
// for Phase 2b scale) -- this file only supplies the HTTP-based
// fetchTagEntries.
//
// Resumable: progress tracked in a local JSON file keyed by symbol.
// Writes go through scr-ingest (service-role path). Rate-limited to SEC's
// declared throttle (~8.3 req/s, well under their 10 req/s cap).
//
// Usage: node scripts/backfill/load_fundamentals.mjs [SYMBOL ...]

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvLocal, requireEnv } from "./lib/env.mjs";
import { makeScrIngest } from "./lib/scrIngest.mjs";
import { fetchSecConcept, sleep, SEC_THROTTLE_MS } from "./lib/sec.mjs";
import { buildFundamentalsForCompany, ALL_METRICS } from "./lib/fundamentalsCore.mjs";

const COMPANIES_FILE = "scripts/backfill/data/companies.json";
const PROGRESS_FILE = "scripts/backfill/data/fundamentals_progress.json";
const JOB_NAME = "scr_load_fundamentals_2a";
const INGEST_BATCH_SIZE = 500;

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const env = loadEnvLocal(".env.local");
  requireEnv(env, ["NEXT_PUBLIC_SUPABASE_URL", "SCR_INGEST_KEY"]);
  const ingest = makeScrIngest(env);

  const allCompanies = await loadJson(COMPANIES_FILE, []);
  if (allCompanies.length === 0) throw new Error(`no companies in ${COMPANIES_FILE}`);

  const requested = process.argv.slice(2).map((s) => s.toUpperCase());
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

  const jobRunId = await ingest.startJobRun(JOB_NAME, { scope: requested.length > 0 ? requested : "full_2a", companiesInScope: companies.length, metrics: Object.keys(ALL_METRICS) });
  console.log(`job run ${jobRunId} started`);

  const coverage = Object.fromEntries([...Object.keys(ALL_METRICS), "free_cash_flow"].map((m) => [m, 0]));
  let totalRows = 0;
  let errorCount = 0;

  try {
    for (const company of pending) {
      try {
        const fetchTagEntries = async (tag, opts) => {
          const entries = await fetchSecConcept(company.cik, tag, opts);
          await sleep(SEC_THROTTLE_MS);
          return entries;
        };
        const rows = await buildFundamentalsForCompany(company, fetchTagEntries);
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
    await ingest.finishJobRun(jobRunId, status, { companiesProcessed: pending.length, totalRows, errorCount, coverage });
    console.log(`job run ${jobRunId} finished: ${status}`);
  }

  console.log(`done. rows loaded: ${totalRows}, errors: ${errorCount}`);
  console.log(`coverage (companies with >=1 row, out of ${companies.length}):`);
  for (const [m, n] of Object.entries(coverage)) {
    console.log(`  ${m}: ${n} (${((n / companies.length) * 100).toFixed(1)}%)`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
