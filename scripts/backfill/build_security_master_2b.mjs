#!/usr/bin/env node
// Phase 2b security master: builds the scr_securities + scr_ticker_history
// INSERT payload from universe_2b_companies.json (already CIK-resolved by
// build_universe_2b.mjs against the SEC submissions.zip index) --
// mapping_method='edgar_submissions' (a genuinely different resolution
// mechanism from Phase 2a's 'sec_ticker_file': the bulk submissions.zip
// reverse index, not SEC's smaller current-tickers-only company_tickers.json).
//
// Does NOT call any SEC HTTP endpoint -- everything needed (tickers,
// exchanges, category, entityType, sic, name) already came from the bulk
// file during universe construction. listed_date/delisted_date aren't
// knowable from this source (same limitation as Phase 2a: SEC gives no
// ticker-change date ranges) -- left null, same honest-gap convention.
//
// Usage: node scripts/backfill/build_security_master_2b.mjs

import { readFile, writeFile } from "node:fs/promises";

const IN_FILE = "scripts/backfill/data/universe_2b_companies.json";
const OUT_FILE = "scripts/backfill/data/security_master_2b_insert.json";

async function main() {
  const companies = JSON.parse(await readFile(IN_FILE, "utf8"));
  const rows = companies.map((c) => ({
    cik: c.cik,
    tickers: c.tickers.map((t) => ({ ticker: t.symbol, exchange: t.exchange })),
    names: [{ name: c.name }],
    sic_code: c.sic,
    sector: c.sicDescription,
    // 'delisted', not 'acquired' -- Alpaca only tells us the ticker is no
    // longer active, not WHY (acquisition, bankruptcy, voluntary
    // deregistration, rename+reticker all look the same from here).
    // 'acquired' is reserved for a confirmed M&A exit (Form 15-12G or
    // equivalent), same as Phase 2a -- not asserted here without that
    // evidence.
    status: c.tickers.every((t) => t.alpacaStatus === "inactive") ? "delisted" : "active",
    mapping_method: "edgar_submissions",
    needs_review: false,
  }));
  await writeFile(OUT_FILE, JSON.stringify(rows, null, 2));
  console.log(`wrote ${rows.length} rows to ${OUT_FILE}`);
  console.log(`status breakdown: active=${rows.filter((r) => r.status === "active").length}, delisted=${rows.filter((r) => r.status === "delisted").length}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
