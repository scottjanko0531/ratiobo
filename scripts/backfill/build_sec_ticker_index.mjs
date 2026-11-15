#!/usr/bin/env node
// Phase 2b: reverse ticker -> CIK index from SEC's submissions.zip bulk
// file (https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip),
// extracted once to disk (991,698 main CIK files -- individually
// unzip -p'ing each would have been far too slow; a single bulk
// extraction + local fs reads is fast).
//
// Covers every SEC registrant ever (not just operating companies with
// XBRL -- that's companyfacts.zip's smaller 20,547), so this is the
// right source for resolving Alpaca's full active+inactive asset list,
// including companies that delisted long enough ago to have no XBRL
// facts, or that never filed XBRL at all.
//
// Usage: node scripts/backfill/build_sec_ticker_index.mjs <path-to-extracted-submissions-dir>

import { readdir, readFile, writeFile } from "node:fs/promises";

const OUT_FILE = "scripts/backfill/data/sec_ticker_index.json";

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: build_sec_ticker_index.mjs <path-to-extracted-submissions-dir>");

  const entries = await readdir(dir);
  const files = entries.filter((f) => /^CIK\d+\.json$/.test(f));
  console.log(`main CIK files: ${files.length}`);

  const index = {}; // ticker -> [{cik, exchange, category, entityType, sic, sicDescription, name}]
  let processed = 0;
  let parseErrors = 0;

  for (const file of files) {
    let j;
    try {
      j = JSON.parse(await readFile(`${dir}/${file}`, "utf8"));
    } catch {
      parseErrors += 1;
      continue;
    }
    const cik = String(j.cik ?? file.match(/CIK(\d+)\.json/)[1]).padStart(10, "0");
    const tickers = j.tickers ?? [];
    const exchanges = j.exchanges ?? [];
    for (let i = 0; i < tickers.length; i++) {
      const t = tickers[i];
      const entry = {
        cik, exchange: exchanges[i] ?? null, category: j.category || null,
        entityType: j.entityType || null, sic: j.sic || null, sicDescription: j.sicDescription || null,
        name: j.name || null,
      };
      (index[t] ??= []).push(entry);
    }
    processed += 1;
    if (processed % 100000 === 0) console.log(`  processed ${processed}/${files.length}...`);
  }

  console.log(`processed: ${processed}, parse errors: ${parseErrors}, unique tickers: ${Object.keys(index).length}`);
  await writeFile(OUT_FILE, JSON.stringify(index));
  console.log(`wrote ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
