#!/usr/bin/env node
// Phase 2a: join scr_securities (id, cik, status, delisted_date) against
// security_master_resolved.json (keyed by the AUTHORITATIVE universe symbol,
// also carrying cik) to produce the companies list the prices/corp-actions
// loaders consume. Do NOT use scr_securities.tickers[0] as "the symbol" --
// SEC's tickers[] array order isn't guaranteed to put our original universe
// symbol first (e.g. Zillow: tickers=["ZG","Z"] but our symbol is "Z").

import { readFile, writeFile } from "node:fs/promises";

const SECURITIES_FILE = process.argv[2] ?? "/private/tmp/claude-501/-Users-scottjanko/c87d9499-5dca-48c5-9868-0990c024917b/scratchpad/securities_ids.json";
const RESOLVED_FILE = process.argv[3] ?? "scripts/backfill/data/security_master_resolved.json";
const OUT_FILE = process.argv[4] ?? "scripts/backfill/data/companies.json";

const securities = JSON.parse(await readFile(SECURITIES_FILE, "utf8"));
const resolved = JSON.parse(await readFile(RESOLVED_FILE, "utf8"));

const byCik = new Map();
for (const row of securities) {
  byCik.set(row.cik, row);
}

const companies = [];
const unmatched = [];

for (const [symbol, entry] of Object.entries(resolved)) {
  const row = byCik.get(entry.cik);
  if (!row) {
    unmatched.push({ symbol, cik: entry.cik, reason: "no scr_securities row for this cik" });
    continue;
  }
  companies.push({
    id: row.id,
    symbol,
    cik: entry.cik,
    status: row.status,
    delisted_date: row.delisted_date,
  });
}

if (unmatched.length > 0) {
  console.error("UNMATCHED (resolved.json entries with no scr_securities row):");
  console.error(JSON.stringify(unmatched, null, 2));
}

// Sanity check the other direction: every scr_securities row should map back
// to exactly one symbol.
const ciksUsed = new Set(companies.map((c) => c.cik));
const orphanRows = securities.filter((r) => !ciksUsed.has(r.cik));
if (orphanRows.length > 0) {
  console.error("ORPHAN scr_securities rows (no resolved.json symbol maps to them):");
  console.error(JSON.stringify(orphanRows, null, 2));
}

companies.sort((a, b) => a.symbol.localeCompare(b.symbol));
await writeFile(OUT_FILE, JSON.stringify(companies, null, 2));

console.log(`securities rows: ${securities.length}`);
console.log(`resolved.json entries: ${Object.keys(resolved).length}`);
console.log(`companies written: ${companies.length} -> ${OUT_FILE}`);
console.log(`unmatched: ${unmatched.length}, orphan rows: ${orphanRows.length}`);
