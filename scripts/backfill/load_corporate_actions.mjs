#!/usr/bin/env node
// Phase 2a step 4b (Stock Screen Research Platform spec): corporate actions
// backfill into scr_corporate_actions.
//
// Alpaca's /v2/corporate_actions/announcements endpoint (Trading API,
// 200 req/min -- NOT the Market Data API used by load_prices.mjs) requires
// ca_types (no default) and caps since/until at 90 days apart. It supports
// querying across the WHOLE MARKET with no symbol filter, so the efficient
// design is: loop over ~90-day windows x the 4 ca_types (dividend, merger,
// split, spinoff), filter each window's results down to our population
// client-side, and submit only the matches. This is population-size-
// independent: unchanged at Phase 2b scale.
//
// Confirmed via real samples (not guessed) that all 4 ca_types share one
// response shape: {ca_type, ca_sub_type, initiating_symbol, target_symbol,
// ex_date, cash, old_rate, new_rate, ...}. target_symbol is the reliable
// field to match against our population across all 4 types -- a merger's
// target_symbol is the company being acquired/converted (the one that may
// be in our universe); initiating_symbol is often the OTHER party (e.g. the
// acquirer, or the spinoff parent) and matching on it would misattribute
// an action to the wrong company's history.
//
// Mapping to our schema's action_type (dividend -> cash_dividend is a
// rename; merger -> other, since our check constraint doesn't have a
// dedicated merger value and a merger is the direct cause of 4 known
// "acquired" companies in this population found via SEC Form 15-12G):
//   split    -> action_type "split",         ratio = new_rate/old_rate, cash_amount = null
//   dividend -> action_type "cash_dividend",  ratio = null,              cash_amount = parseFloat(cash)
//   spinoff  -> action_type "spinoff",        ratio = new_rate/old_rate, cash_amount = null
//   merger   -> action_type "other",          ratio = new_rate/old_rate, cash_amount = (cash !== "0" ? parseFloat(cash) : null)
// raw_payload always stores the full original record regardless, so
// nothing is lost if a mapping assumption above turns out incomplete for
// some record this population never actually surfaces.
//
// Resumable: progress tracked in a local JSON file, keyed by
// "{ca_type}|{since}|{until}" -- a window+type already marked done is
// skipped on rerun. Writes go through scr-ingest (service-role path);
// corp-actions dedup happens there via an application-level pre-check
// (see that function's own comments for why: nullable ratio/cash_amount
// make a DB-level unique constraint unsafe).
//
// Usage: node scripts/backfill/load_corporate_actions.mjs

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvLocal, requireEnv } from "./lib/env.mjs";
import { makeScrIngest } from "./lib/scrIngest.mjs";

const COMPANIES_FILE = process.env.COMPANIES_FILE ?? "scripts/backfill/data/companies.json";
const PROGRESS_FILE = process.env.PROGRESS_FILE ?? "scripts/backfill/data/corp_actions_progress.json";
const JOB_NAME = "scr_load_corporate_actions_2a";

const START_DATE = "2016-01-01";
const WINDOW_DAYS = 90;
const CA_TYPES = ["split", "dividend", "spinoff", "merger"];
const REQUEST_DELAY_MS = 400; // Trading API cap is 200 req/min; ~150/min stays comfortably under it
const INGEST_BATCH_SIZE = 500;

const ACTION_TYPE_MAP = { split: "split", dividend: "cash_dividend", spinoff: "spinoff", merger: "other" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function generateWindows(startIso, endIso, maxDays) {
  const windows = [];
  let cursor = new Date(startIso + "T00:00:00Z");
  const end = new Date(endIso + "T00:00:00Z");
  while (cursor <= end) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + maxDays - 1);
    const until = windowEnd > end ? end : windowEnd;
    windows.push({ since: isoDate(cursor), until: isoDate(until) });
    cursor = new Date(until);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

function recordToRow(rec, company) {
  const caType = rec.ca_type;
  const actionType = ACTION_TYPE_MAP[caType];
  if (!actionType) return null; // shouldn't happen -- we only request known ca_types
  const oldRate = Number(rec.old_rate);
  const newRate = Number(rec.new_rate);
  const ratio = (Number.isFinite(oldRate) && oldRate !== 0 && Number.isFinite(newRate))
    ? newRate / oldRate : null;
  const cash = Number(rec.cash ?? "0");

  let finalRatio = null;
  let finalCash = null;
  if (caType === "split" || caType === "spinoff" || caType === "merger") {
    finalRatio = ratio;
    if (caType === "merger" && cash !== 0) finalCash = cash;
  } else if (caType === "dividend") {
    finalCash = Number.isFinite(cash) ? cash : null;
  }

  // Merger records don't carry an ex_date field at all (confirmed via real
  // samples: only split/dividend/spinoff do) -- fall back to the next-best
  // available date rather than violate the NOT NULL constraint or guess.
  const exDate = rec.ex_date ?? rec.effective_date ?? rec.record_date ?? rec.payable_date;
  if (!exDate) return null;

  return {
    company_id: company.id,
    action_type: actionType,
    ex_date: exDate,
    ratio: finalRatio,
    cash_amount: finalCash,
    raw_payload: rec,
  };
}

async function fetchAnnouncements(caType, since, until, alpacaHeaders) {
  const records = [];
  let pageToken = null;
  do {
    const url = new URL("https://api.alpaca.markets/v2/corporate_actions/announcements");
    url.searchParams.set("ca_types", caType);
    url.searchParams.set("since", since);
    url.searchParams.set("until", until);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url, { headers: alpacaHeaders });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca HTTP ${res.status} for ${caType} ${since}..${until}: ${body}`);
    }
    const json = await res.json();
    // The endpoint's top-level response IS the array in practice (confirmed
    // via direct inspection) -- but defensively handle an object-wrapped
    // shape too, in case that varies by ca_type or account tier.
    const arr = Array.isArray(json) ? json : (json.corporate_actions ?? json.announcements ?? []);
    records.push(...arr);
    pageToken = Array.isArray(json) ? null : (json.next_page_token ?? null);
    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);
  return records;
}

async function main() {
  const env = loadEnvLocal(".env.local");
  requireEnv(env, ["NEXT_PUBLIC_SUPABASE_URL", "SCR_INGEST_KEY", "ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"]);
  const ingest = makeScrIngest(env);
  const alpacaHeaders = {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY,
  };

  const companies = await loadJson(COMPANIES_FILE, []);
  if (companies.length === 0) throw new Error(`no companies in ${COMPANIES_FILE}`);
  // One symbol can map to SEVERAL companies: Phase 2b's SEC-discovered
  // delisted population has confirmed real ticker recycling within this
  // same companies.json (45 symbols shared across distinct companies --
  // e.g. "AGN" is both Allergan plc and, earlier, Warner Chilcott Ltd).
  // A plain Map(symbol -> company) would silently keep only the LAST
  // company for a repeated symbol, permanently losing corporate actions
  // for the other(s). Group into arrays instead, and when a symbol has
  // more than one company, resolve by whether the record's date falls
  // inside that company's priceStart/priceEnd window (set for exactly
  // this population); a company with no such window (Phase 2a / Alpaca-
  // 2b, one row per symbol) is matched unconditionally, same as before.
  const bySymbol = new Map();
  for (const c of companies) {
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
    bySymbol.get(c.symbol).push(c);
  }
  function resolveCompanyForSymbol(symbol, recordDate) {
    const candidates = bySymbol.get(symbol);
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const inWindow = candidates.filter((c) => {
      if (!c.priceStart && !c.priceEnd) return true; // no window info -- can't rule out
      if (c.priceStart && recordDate < c.priceStart) return false;
      if (c.priceEnd && recordDate > c.priceEnd) return false;
      return true;
    });
    return inWindow[0] ?? candidates[0]; // ambiguous fallback: first candidate, same as pre-fix behavior
  }

  const today = isoDate(new Date());
  const windows = generateWindows(START_DATE, today, WINDOW_DAYS);
  const tasks = [];
  for (const caType of CA_TYPES) {
    for (const w of windows) tasks.push({ caType, ...w });
  }

  const progress = await loadJson(PROGRESS_FILE, {});
  const keyOf = (t) => `${t.caType}|${t.since}|${t.until}`;
  const pending = tasks.filter((t) => progress[keyOf(t)]?.status !== "done");

  console.log(`windows x types: ${tasks.length}, already done: ${tasks.length - pending.length}, pending: ${pending.length}`);
  if (pending.length === 0) {
    console.log("nothing to do");
    return;
  }

  const jobRunId = await ingest.startJobRun(JOB_NAME, { totalTasks: tasks.length, windowDays: WINDOW_DAYS, caTypes: CA_TYPES });
  console.log(`job run ${jobRunId} started`);

  let totalFetched = 0;
  let totalMatched = 0;
  let totalInserted = 0;
  let errorCount = 0;
  const actionTypeCounts = {};

  try {
    for (const task of pending) {
      const key = keyOf(task);
      try {
        const records = await fetchAnnouncements(task.caType, task.since, task.until, alpacaHeaders);
        const matchedRows = [];
        for (const rec of records) {
          const recordDate = rec.ex_date ?? rec.effective_date ?? rec.record_date ?? rec.payable_date;
          const company = resolveCompanyForSymbol(rec.target_symbol, recordDate);
          if (!company) continue;
          const row = recordToRow(rec, company);
          if (row) matchedRows.push(row);
        }

        for (let i = 0; i < matchedRows.length; i += INGEST_BATCH_SIZE) {
          const batch = matchedRows.slice(i, i + INGEST_BATCH_SIZE);
          const result = await ingest.sendCorporateActions(batch);
          if (!result.corporateActions?.ok) throw new Error(`scr-ingest corp-actions write failed: ${JSON.stringify(result.corporateActions)}`);
          totalInserted += result.corporateActions.inserted;
        }

        for (const row of matchedRows) {
          actionTypeCounts[row.action_type] = (actionTypeCounts[row.action_type] ?? 0) + 1;
        }

        totalFetched += records.length;
        totalMatched += matchedRows.length;
        progress[key] = {
          status: "done", fetched: records.length, matched: matchedRows.length,
          finishedAt: new Date().toISOString(),
        };
        await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        if (matchedRows.length > 0) {
          console.log(`${key}: fetched ${records.length}, matched ${matchedRows.length}`);
        }
      } catch (e) {
        errorCount += 1;
        progress[key] = { status: "error", error: String(e.message ?? e), at: new Date().toISOString() };
        await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        console.error(`${key}: ERROR -- ${String(e.message ?? e)}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    const status = errorCount > 0 ? "error" : "ok";
    await ingest.finishJobRun(jobRunId, status, {
      tasksProcessed: pending.length, totalFetched, totalMatched, totalInserted, errorCount, actionTypeCounts,
    });
    console.log(`job run ${jobRunId} finished: ${status}`);
  }

  console.log(`done. fetched: ${totalFetched}, matched: ${totalMatched}, inserted: ${totalInserted}, errors: ${errorCount}`);
  console.log(`by action_type: ${JSON.stringify(actionTypeCounts)}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
