#!/usr/bin/env node
// Phase 2b: name -> CIK index from SEC's submissions.zip, covering both
// current names AND formerNames (with their from/to dates). Needed
// because ticker-based resolution (build_sec_ticker_index.mjs)
// systematically misses delisted/acquired companies: SEC's tickers[]
// field tracks only the CURRENT ticker, and a deregistered/acquired
// company's CIK often has no current ticker at all (or the acquirer's
// name instead) -- confirmed empirically: of 5,447 companies resolved by
// ticker alone, ZERO had every Alpaca ticker marked inactive, even
// though Alpaca's inactive asset list has 19,155 entries. formerNames
// preserves the company's name history with real date ranges, which is
// exactly what a delisted company needs for resolution.
//
// Usage: node scripts/backfill/build_sec_name_index.mjs <path-to-extracted-submissions-dir>

import { readdir, readFile, writeFile } from "node:fs/promises";

const OUT_FILE = "scripts/backfill/data/sec_name_index.json";

// Normalize for exact (not fuzzy) matching: uppercase, strip punctuation,
// collapse whitespace, drop common corporate suffixes. Still exact-match
// only on the normalized string -- not a fuzzy/approximate match -- so
// ambiguity (multiple CIKs normalizing to the same string) is flagged by
// the caller, not silently resolved.
function normalizeName(name) {
  return String(name)
    .toUpperCase()
    .replace(/[.,'"]/g, "")
    .replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|LLC|LP|PLC|HOLDINGS?|GROUP)\b\.?/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: build_sec_name_index.mjs <path-to-extracted-submissions-dir>");

  const entries = await readdir(dir);
  const files = entries.filter((f) => /^CIK\d+\.json$/.test(f));
  console.log(`main CIK files: ${files.length}`);

  const index = {}; // normalizedName -> [{cik, name, kind: 'current'|'former', from, to}]
  let processed = 0;

  for (const file of files) {
    let j;
    try {
      j = JSON.parse(await readFile(`${dir}/${file}`, "utf8"));
    } catch {
      continue;
    }
    const cik = String(j.cik ?? file.match(/CIK(\d+)\.json/)[1]).padStart(10, "0");
    // category/entityType/sic come from the CIK's CURRENT filing record
    // regardless of which name (current or former) matched -- a
    // deregistered/renamed company's OLD ticker is gone from the ticker
    // index by definition (that's why it needed the name fallback), so
    // this is the only place that category check can come from.
    const meta = { category: j.category || null, entityType: j.entityType || null, sic: j.sic || null, sicDescription: j.sicDescription || null };
    if (j.name) {
      const norm = normalizeName(j.name);
      if (norm) (index[norm] ??= []).push({ cik, name: j.name, kind: "current", ...meta });
    }
    for (const fn of j.formerNames ?? []) {
      const norm = normalizeName(fn.name);
      if (norm) (index[norm] ??= []).push({ cik, name: fn.name, kind: "former", from: fn.from, to: fn.to, ...meta });
    }
    processed += 1;
    if (processed % 200000 === 0) console.log(`  processed ${processed}/${files.length}...`);
  }

  console.log(`processed: ${processed}, unique normalized names: ${Object.keys(index).length}`);
  await writeFile(OUT_FILE, JSON.stringify(index));
  console.log(`wrote ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
