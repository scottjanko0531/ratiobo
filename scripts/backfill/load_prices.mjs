#!/usr/bin/env node
// Phase 2a step 4a (Stock Screen Research Platform spec): daily price
// backfill into scr_prices_daily.
//
// RAW bars only (adjustment=raw), feed=sip, 2016-01-01 through today by
// default, one Alpaca request per symbol (paginated via next_page_token
// if the range exceeds one page -- ~2,500 trading days fits Alpaca's
// page limit in practice, but don't assume it always will). A company
// record may carry priceStart/priceEnd to bound the fetch to its own
// real listed window instead -- required for tickers that get recycled
// by a later, unrelated company (e.g. Alpaca's "MON" is now an unrelated
// SPAC, not Monsanto); without bounding, a blind 2016-to-today fetch
// would silently blend the two companies' histories into one series.
// Writes go through the scr-ingest edge function (service-role write
// path, gated by x-ingest-key) -- this script only ever holds the anon
// key + Alpaca read credentials, never the real service_role key.
//
// Resumable: progress is tracked in a local JSON file (not by reading
// scr_prices_daily back -- RLS only grants SELECT to `authenticated`,
// which this script, holding just the anon key, is not). A symbol marked
// "done" is skipped on rerun. Re-running a "done" symbol is still safe
// regardless (scr_prices_daily upserts with ignoreDuplicates on
// (company_id, date)), the progress file just avoids redoing the work.
//
// For companies marked status="acquired" (Phase 2a: the 4 found via Form
// 15-12G -- EA, EXAS, GTLS, SKX) or status="delisted" (Phase 2b: Alpaca-
// inactive-ticker candidates with no confirmed delisting reason),
// records the last available close as scr_securities.final_price. Never
// touches status or delisted_date -- those come from security-master
// resolution, not the price loader.
//
// Usage: node scripts/backfill/load_prices.mjs [SYMBOL ...]
// With no args, runs the full companies.json population.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvLocal, requireEnv } from "./lib/env.mjs";
import { makeScrIngest } from "./lib/scrIngest.mjs";

const COMPANIES_FILE = process.env.COMPANIES_FILE ?? "scripts/backfill/data/companies.json";
const PROGRESS_FILE = process.env.PROGRESS_FILE ?? "scripts/backfill/data/prices_progress.json";
const JOB_NAME = "scr_load_prices_2a";

const START_DATE = "2016-01-01";
const BARS_PAGE_LIMIT = 10000;
const REQUEST_DELAY_MS = 100; // polite spacing; Alpaca's Market Data limit is 10k req/min, nowhere near binding at 176 symbols
const INGEST_BATCH_SIZE = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchAllBars(symbol, alpacaHeaders, { start, end } = {}) {
  const bars = [];
  let pageToken = null;
  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("start", start ?? START_DATE);
    url.searchParams.set("end", end ?? todayIso());
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", "sip");
    url.searchParams.set("limit", String(BARS_PAGE_LIMIT));
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url, { headers: alpacaHeaders });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca HTTP ${res.status} for ${symbol}: ${body}`);
    }
    const json = await res.json();
    bars.push(...(json.bars ?? []));
    pageToken = json.next_page_token ?? null;
    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);
  return bars;
}

function barToRow(bar, company) {
  return {
    company_id: company.id,
    symbol: company.symbol,
    date: bar.t.slice(0, 10),
    open: bar.o, high: bar.h, low: bar.l, close: bar.c,
    volume: bar.v,
    vwap: bar.vw ?? null,
  };
}

async function main() {
  const env = loadEnvLocal(".env.local");
  requireEnv(env, ["NEXT_PUBLIC_SUPABASE_URL", "SCR_INGEST_KEY", "ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"]);
  const ingest = makeScrIngest(env);
  const alpacaHeaders = {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY,
  };

  const allCompanies = await loadJson(COMPANIES_FILE, []);
  if (allCompanies.length === 0) throw new Error(`no companies in ${COMPANIES_FILE}`);

  const requested = process.argv.slice(2).map((s) => s.toUpperCase());
  const companies = requested.length > 0
    ? allCompanies.filter((c) => requested.includes(c.symbol))
    : allCompanies;
  if (requested.length > 0 && companies.length !== requested.length) {
    const found = new Set(companies.map((c) => c.symbol));
    const missing = requested.filter((s) => !found.has(s));
    console.warn(`WARNING: requested symbols not found in companies.json: ${missing.join(", ")}`);
  }

  const progress = await loadJson(PROGRESS_FILE, {});
  // Keyed by company.id, not company.symbol: Phase 2b's SEC-discovered
  // population can have genuine ticker recycling WITHIN this same
  // companies.json (confirmed: 45 symbols shared across distinct
  // companies in the delisted-company batch) -- a symbol-keyed progress
  // file would treat the second company sharing a symbol as already
  // "done" once the first one finished and silently skip it.
  const pending = companies.filter((c) => progress[c.id]?.status !== "done");

  console.log(`companies in scope: ${companies.length}, already done: ${companies.length - pending.length}, pending: ${pending.length}`);
  if (pending.length === 0) {
    console.log("nothing to do");
    return;
  }

  const jobRunId = await ingest.startJobRun(JOB_NAME, { scope: requested.length > 0 ? requested : "full_2a", companiesInScope: companies.length });
  console.log(`job run ${jobRunId} started`);

  const zeroBarSymbols = [];
  let totalRows = 0;
  let errorCount = 0;

  try {
    for (const company of pending) {
      try {
        // Tickers get recycled (confirmed real: "MON" now resolves to an
        // unrelated SPAC, Monument Circle Acquisition Corp, on Alpaca --
        // fetching a blind 2016-to-today range for a delisted company's
        // old ticker would silently blend in that LATER, unrelated
        // company's trading history). When the company record carries an
        // explicit priceStart/priceEnd (set for SEC-discovered delisted
        // companies from their real scr_ticker_history window), use it;
        // otherwise fall back to the original global range unchanged.
        const bars = await fetchAllBars(company.symbol, alpacaHeaders, {
          start: company.priceStart, end: company.priceEnd,
        });
        if (bars.length === 0) {
          zeroBarSymbols.push(company.symbol);
          console.log(`${company.symbol}: 0 bars (flagged)`);
          progress[company.id] = { status: "done", rows: 0, finishedAt: new Date().toISOString(), note: "zero bars from Alpaca" };
          await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
          await sleep(REQUEST_DELAY_MS);
          continue;
        }

        const rows = bars.map((b) => barToRow(b, company));
        for (let i = 0; i < rows.length; i += INGEST_BATCH_SIZE) {
          const batch = rows.slice(i, i + INGEST_BATCH_SIZE);
          const result = await ingest.sendPrices(batch);
          if (!result.prices?.ok) throw new Error(`scr-ingest prices write failed: ${JSON.stringify(result.prices)}`);
        }

        // A company can have several ticker-rows (symbol changes over
        // time) in the SAME companies.json -- only the row covering the
        // company's actual LAST trading day should set final_price;
        // setting it from every row would let an earlier ticker's final
        // bar overwrite the real final price if rows process out of
        // date order. When priceEnd/delisted_date aren't set (Phase 2a /
        // Alpaca-2b population, one row per company, no ambiguity),
        // fall back to the original unconditional behavior.
        const isFinalSegment = !company.priceEnd || !company.delisted_date || company.priceEnd === company.delisted_date;
        if ((company.status === "acquired" || company.status === "delisted") && isFinalSegment) {
          const last = bars[bars.length - 1];
          const result = await ingest.sendSecurityUpdates([{ company_id: company.id, final_price: last.c }]);
          if (!result.securityUpdates?.ok) throw new Error(`final_price update failed: ${JSON.stringify(result.securityUpdates)}`);
        }

        totalRows += rows.length;
        progress[company.id] = {
          status: "done", rows: rows.length, symbol: company.symbol,
          firstDate: rows[0].date, lastDate: rows[rows.length - 1].date,
          finishedAt: new Date().toISOString(),
        };
        await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        console.log(`${company.symbol}: ${rows.length} bars (${rows[0].date} .. ${rows[rows.length - 1].date})`);
      } catch (e) {
        errorCount += 1;
        progress[company.id] = { status: "error", symbol: company.symbol, error: String(e.message ?? e), at: new Date().toISOString() };
        await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        console.error(`${company.symbol}: ERROR -- ${String(e.message ?? e)}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    const status = errorCount > 0 ? "error" : "ok";
    await ingest.finishJobRun(jobRunId, status, {
      companiesProcessed: pending.length,
      totalRows, errorCount, zeroBarSymbols,
    });
    console.log(`job run ${jobRunId} finished: ${status}`);
  }

  console.log(`done. rows loaded: ${totalRows}, errors: ${errorCount}, zero-bar symbols: ${zeroBarSymbols.length}${zeroBarSymbols.length ? " (" + zeroBarSymbols.join(", ") + ")" : ""}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
