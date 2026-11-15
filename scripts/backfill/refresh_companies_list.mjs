#!/usr/bin/env node
// Monthly loader workflow, step 0: regenerate companies.json from the LIVE
// scr_securities/scr_ticker_history tables instead of using the static file
// left over from the one-time Phase 2b backfill. Without this, the loaders
// (load_prices.mjs etc.) would never see companies onboarded later -- either
// through a future bulk pass or the single-company incremental onboarding
// path -- since they only read whatever companies.json already contains.
//
// Current ticker = the scr_ticker_history row with valid_to IS NULL for
// that company (falls back to the most recent valid_from if more than one
// or none is open-ended, same "most recent wins" convention used
// elsewhere in this codebase for point-in-time ticker resolution).
//
// Usage: node scripts/backfill/refresh_companies_list.mjs

import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocal, requireEnv } from "./lib/env.mjs";

const OUT_FILE = "scripts/backfill/data/companies.json";

async function main() {
  const env = loadEnvLocal(".env.local");
  requireEnv(env, ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: securities, error: secErr } = await supabase
    .from("scr_securities")
    .select("id, cik, status, delisted_date");
  if (secErr) throw new Error(`scr_securities: ${secErr.message}`);

  const { data: tickers, error: tickErr } = await supabase
    .from("scr_ticker_history")
    .select("company_id, ticker, valid_from, valid_to")
    .order("valid_from", { ascending: false });
  if (tickErr) throw new Error(`scr_ticker_history: ${tickErr.message}`);

  const currentTicker = new Map();
  for (const t of tickers) {
    if (currentTicker.has(t.company_id)) continue;
    if (t.valid_to === null) currentTicker.set(t.company_id, t.ticker);
  }
  // Fall back to the most recent row (tickers is already sorted
  // valid_from desc) for any company with no open-ended entry.
  for (const t of tickers) {
    if (!currentTicker.has(t.company_id)) currentTicker.set(t.company_id, t.ticker);
  }

  const companies = securities
    .filter((s) => currentTicker.has(s.id))
    .map((s) => ({
      id: s.id,
      symbol: currentTicker.get(s.id),
      cik: s.cik,
      status: s.status,
      delisted_date: s.delisted_date,
    }));

  await writeFile(OUT_FILE, JSON.stringify(companies, null, 2));
  console.log(`wrote ${companies.length} companies to ${OUT_FILE} (${securities.length - companies.length} skipped: no ticker history)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
