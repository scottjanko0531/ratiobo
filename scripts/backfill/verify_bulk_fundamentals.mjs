#!/usr/bin/env node
// One-off validation (read-only, no writes): confirms
// load_fundamentals_bulk.mjs's companyfacts.zip-based derivation
// reproduces the EXISTING, already-validated scr_fundamentals rows
// (same value and filed_date) for the 176-company Phase 2a population,
// before trusting the bulk path for the Phase 2b full run.
//
// Usage: node scripts/backfill/verify_bulk_fundamentals.mjs <path-to-companyfacts.zip>

import { readFile } from "node:fs/promises";
import { loadEnvLocal, requireEnv } from "./lib/env.mjs";
import { makeScrIngest } from "./lib/scrIngest.mjs";
import { loadCompanyFacts } from "./lib/companyFactsZip.mjs";
import { filterUnitsEntries } from "./lib/sec.mjs";
import { buildFundamentalsForCompany } from "./lib/fundamentalsCore.mjs";

const COMPANIES_FILE = "scripts/backfill/data/companies.json";

function makeFetchTagEntries(companyFacts) {
  const usGaap = companyFacts?.facts?.["us-gaap"];
  return async (tag, opts) => filterUnitsEntries(usGaap?.[tag]?.units?.[opts.unit], opts.kind);
}

function keyOf(r) {
  return `${r.metric}|${r.period_end}|${r.filed_date}`;
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) throw new Error("usage: verify_bulk_fundamentals.mjs <path-to-companyfacts.zip>");

  const env = loadEnvLocal(".env.local");
  requireEnv(env, ["NEXT_PUBLIC_SUPABASE_URL", "SCR_INGEST_KEY"]);
  const ingest = makeScrIngest(env);

  const companies = JSON.parse(await readFile(COMPANIES_FILE, "utf8"));

  console.log(`reading existing scr_fundamentals rows for ${companies.length} companies...`);
  const allExistingRows = await ingest.readFundamentals(companies.map((c) => c.id));
  const existingByCompany = new Map();
  for (const r of allExistingRows) {
    const arr = existingByCompany.get(r.company_id) ?? [];
    arr.push(r);
    existingByCompany.set(r.company_id, arr);
  }
  console.log(`got ${allExistingRows.length} existing rows across ${existingByCompany.size} companies`);

  let companiesChecked = 0;
  let companiesNoFacts = 0;
  let companiesMatched = 0;
  let companiesMismatched = 0;
  let totalMissingFromBulk = 0; // existing row, bulk path didn't produce it
  let totalExtraInBulk = 0; // bulk path produced it, didn't exist before
  let totalValueMismatch = 0; // same key, different value
  const mismatchDetails = [];

  for (const company of companies) {
    const companyFacts = await loadCompanyFacts(zipPath, company.cik);
    if (!companyFacts) {
      companiesNoFacts += 1;
      console.log(`${company.symbol}: NO companyfacts.zip entry for CIK ${company.cik}`);
      continue;
    }

    const bulkRows = await buildFundamentalsForCompany(company, makeFetchTagEntries(companyFacts));
    const existingRows = existingByCompany.get(company.id) ?? [];

    const bulkByKey = new Map(bulkRows.map((r) => [keyOf(r), r]));
    const existingByKey = new Map(existingRows.map((r) => [keyOf(r), r]));

    let missing = 0, extra = 0, mismatch = 0;
    for (const [key, ex] of existingByKey) {
      const b = bulkByKey.get(key);
      if (!b) { missing += 1; continue; }
      if (Number(b.value) !== Number(ex.value)) {
        mismatch += 1;
        mismatchDetails.push({ symbol: company.symbol, key, bulkValue: b.value, existingValue: ex.value });
      }
    }
    for (const key of bulkByKey.keys()) {
      if (!existingByKey.has(key)) extra += 1;
    }

    companiesChecked += 1;
    totalMissingFromBulk += missing;
    totalExtraInBulk += extra;
    totalValueMismatch += mismatch;

    if (missing === 0 && extra === 0 && mismatch === 0) {
      companiesMatched += 1;
    } else {
      companiesMismatched += 1;
      console.log(`${company.symbol}: existing=${existingRows.length} bulk=${bulkRows.length} missing=${missing} extra=${extra} valueMismatch=${mismatch}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`companies checked: ${companiesChecked}, no companyfacts entry: ${companiesNoFacts}`);
  console.log(`fully matched: ${companiesMatched}, had differences: ${companiesMismatched}`);
  console.log(`total rows missing from bulk (existed in HTTP path, not in bulk): ${totalMissingFromBulk}`);
  console.log(`total rows extra in bulk (bulk found, HTTP path didn't): ${totalExtraInBulk}`);
  console.log(`total value mismatches (same key, different value): ${totalValueMismatch}`);
  if (mismatchDetails.length > 0) {
    console.log("\nvalue mismatch details (first 20):");
    for (const d of mismatchDetails.slice(0, 20)) console.log(" ", JSON.stringify(d));
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
