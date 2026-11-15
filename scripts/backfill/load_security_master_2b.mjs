#!/usr/bin/env node
// Phase 2b: loads security_master_2b_insert.json into scr_securities via
// scr-ingest (service-role write path). Upserts on cik with
// ignoreDuplicates, so Phase 2a's 176 existing rows (and their own
// mapping_method='sec_ticker_file', manually-curated tickers/names) are
// never touched -- only genuinely new companies get inserted.

import { readFile } from "node:fs/promises";
import { loadEnvLocal, requireEnv } from "./lib/env.mjs";
import { makeScrIngest } from "./lib/scrIngest.mjs";

const IN_FILE = process.env.IN_FILE ?? "scripts/backfill/data/security_master_2b_insert.json";
const BATCH_SIZE = 500;

async function main() {
  const env = loadEnvLocal(".env.local");
  requireEnv(env, ["NEXT_PUBLIC_SUPABASE_URL", "SCR_INGEST_KEY"]);
  const ingest = makeScrIngest(env);

  const rows = JSON.parse(await readFile(IN_FILE, "utf8"));
  console.log(`loading ${rows.length} security master rows...`);

  let totalSubmitted = 0, totalInserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const result = await ingest.sendSecurityMaster(batch);
    if (!result.securityMaster?.ok) throw new Error(`batch ${i} failed: ${JSON.stringify(result.securityMaster)}`);
    totalSubmitted += result.securityMaster.submitted;
    totalInserted += result.securityMaster.count ?? 0;
    console.log(`batch ${i}-${i + batch.length}: submitted ${result.securityMaster.submitted}, newly inserted ${result.securityMaster.count}`);
  }
  console.log(`done. total submitted: ${totalSubmitted}, total newly inserted: ${totalInserted}, skipped as already-present: ${totalSubmitted - totalInserted}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
