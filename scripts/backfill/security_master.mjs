#!/usr/bin/env node
// Phase 2a step 3 (Stock Screen Research Platform spec): security master
// CIK resolution. Pure external-fetch script -- no DB credentials needed.
// Reads the universe list, resolves each symbol to exactly one CIK via SEC's
// company_tickers.json + submissions API, and writes resolved/review JSON
// files for the caller to turn into scr_securities rows.
//
// Resumable: on rerun, skips any symbol already present in the resolved or
// review output file (keyed by symbol), so a crash partway through a big
// (Phase 2b-scale) run just picks back up.
//
// SEC fair-access: declared User-Agent (same string as compute-capex-cycle's
// SEC_UA), max ~8 req/s (120ms delay between submissions-API calls, same
// throttle compute-capex-cycle uses to stay under SEC's stated 10 req/s cap).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SEC_UA = { "User-Agent": "Ratiobo research (ratiobo.com)", "Accept": "application/json" };
const THROTTLE_MS = 120;

const UNIVERSE_FILE = process.argv[2] ?? "scripts/backfill/data/universe_2a.json";
const RESOLVED_FILE = process.argv[3] ?? "scripts/backfill/data/security_master_resolved.json";
const REVIEW_FILE = process.argv[4] ?? "scripts/backfill/data/security_master_review.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: SEC_UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function padCik(cikStr) {
  return String(cikStr).padStart(10, "0");
}

async function main() {
  const universe = await loadJson(UNIVERSE_FILE, []);
  if (universe.length === 0) throw new Error(`no symbols in ${UNIVERSE_FILE}`);

  const resolved = await loadJson(RESOLVED_FILE, {});
  const review = await loadJson(REVIEW_FILE, {});
  const alreadyDone = new Set([...Object.keys(resolved), ...Object.keys(review)]);
  const pending = universe.filter((s) => !alreadyDone.has(s));

  console.log(`universe: ${universe.length}, already done: ${alreadyDone.size}, pending: ${pending.length}`);
  if (pending.length === 0) {
    console.log("nothing to do");
    return;
  }

  // Bulk ticker->CIK map, one request, covers current/active tickers (and
  // some historical ones SEC still indexes under the old symbol).
  console.log("fetching company_tickers.json ...");
  const tickerMapRaw = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  const tickerToCik = new Map();
  for (const entry of Object.values(tickerMapRaw)) {
    tickerToCik.set(String(entry.ticker).toUpperCase(), padCik(entry.cik_str));
  }

  for (const symbol of pending) {
    const cik = tickerToCik.get(symbol.toUpperCase());
    if (!cik) {
      review[symbol] = { symbol, reason: "no exact ticker match in company_tickers.json" };
      await writeFile(REVIEW_FILE, JSON.stringify(review, null, 2));
      console.log(`${symbol}: NO MATCH -> review`);
      continue;
    }

    await sleep(THROTTLE_MS);
    let sub;
    try {
      sub = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
    } catch (e) {
      review[symbol] = { symbol, cik, reason: `submissions fetch failed: ${String(e.message ?? e)}` };
      await writeFile(REVIEW_FILE, JSON.stringify(review, null, 2));
      console.log(`${symbol}: FETCH ERROR -> review`);
      continue;
    }

    // formerNames: [{name, from, to}]; tickers/exchanges are parallel arrays
    // (same index = same ticker's exchange), not independently dated -- SEC
    // doesn't give us ticker-change date ranges directly, only the current
    // list of all tickers ever associated with this CIK. Flag multi-ticker
    // entities explicitly so the caller can decide valid_from/valid_to by
    // cross-referencing filing history if it matters, rather than guessing.
    const allTickers = sub.tickers ?? [];
    const exchanges = sub.exchanges ?? [];
    const formerNames = (sub.formerNames ?? []).map((f) => ({
      name: f.name, from: f.from, to: f.to,
    }));

    resolved[symbol] = {
      symbol,
      cik,
      name: sub.name ?? null,
      sic: sub.sic ?? null,
      sicDescription: sub.sicDescription ?? null,
      entityType: sub.entityType ?? null,
      category: sub.category ?? null, // e.g. "Large accelerated filer" -- also surfaces funds/trusts here
      stateOfIncorporation: sub.stateOfIncorporation ?? null,
      tickers: allTickers,
      exchanges,
      formerNames,
      multiTicker: allTickers.length > 1,
    };
    await writeFile(RESOLVED_FILE, JSON.stringify(resolved, null, 2));
    console.log(`${symbol}: CIK ${cik} (${sub.name}), ${allTickers.length} ticker(s), ${formerNames.length} former name(s)`);
  }

  console.log(`done. resolved: ${Object.keys(resolved).length}, review: ${Object.keys(review).length}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
