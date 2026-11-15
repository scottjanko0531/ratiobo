#!/usr/bin/env node
// Phase 2b universe construction: every US common stock listed on NYSE,
// Nasdaq, or NYSE American (Alpaca's "AMEX") at any time since 2016,
// active or delisted, excluding ETFs, closed-end funds, warrants,
// preferreds, and OTC listings.
//
// Source: Alpaca's full asset list (active + inactive, us_equity class)
// joined against SEC's submissions.zip reverse ticker index
// (scripts/backfill/data/sec_ticker_index.json, built by
// build_sec_ticker_index.mjs). Alpaca gives the listing/exchange/active-
// vs-inactive signal; SEC gives CIK resolution + the operating-company-
// vs-fund signal.
//
// Filter pipeline (each step's reasoning is empirically grounded, not
// assumed -- see the Nov 2026 session notes):
//   1. exchange IN (NASDAQ, NYSE, AMEX) -- drops OTC, ARCA, BATS, TXSE.
//      Confirmed: nearly all warrant/unit-named Alpaca assets are OTC-
//      listed already, so this filter does most of that exclusion work
//      on its own.
//   2. symbol does not match the preferred-share pattern Alpaca itself
//      uses (e.g. "TCBI.PRB", "BAC.PRL" -- confirmed via live sample).
//   3. asset name does not contain "Warrant" (backstop beyond #1).
//   4. ticker resolves to exactly one CIK via the SEC index; zero or
//      multiple matches go to the review list, not a guess (same rule
//      as Phase 2a's security master).
//   5. that CIK's `category` field (filer size category, e.g. "Large
//      accelerated filer") is non-empty. Confirmed via submissions.zip:
//      ADI (real operating company) has a populated category; SPY (a
//      known ETF) has category="" and sic="". This is the primary
//      fund/ETF exclusion signal -- entityType alone doesn't work,
//      since foreign private issuers also show entityType="other" but
//      DO have a populated category and must be kept (confirmed in
//      Phase 2a: ARM, BNTX, etc.).
//
// "Since 2016" is not independently date-checked here -- Alpaca's own
// tracked universe (even its inactive list) is unlikely to include
// symbols whose only relevance predates Alpaca's own operating history
// (~2015+), so exchange+category+pattern filtering on Alpaca's asset
// list is treated as a reasonable proxy. Documented as a simplifying
// assumption, not a verified guarantee.
//
// Multiple Alpaca tickers can resolve to the same CIK (different share
// classes, e.g. GOOG/GOOGL, or Z/ZG) -- grouped into one company per CIK
// with all qualifying tickers, same structure as Phase 2a's
// scr_securities.tickers array.

import { readFile, writeFile } from "node:fs/promises";
import { loadEnvLocal } from "./lib/env.mjs";

const SEC_INDEX_FILE = "scripts/backfill/data/sec_ticker_index.json";
const SEC_NAME_INDEX_FILE = "scripts/backfill/data/sec_name_index.json";
const OUT_COMPANIES = "scripts/backfill/data/universe_2b_companies.json";
const OUT_REVIEW = "scripts/backfill/data/universe_2b_review.json";

// Same normalization as build_sec_name_index.mjs -- exact match on the
// normalized string only, never fuzzy/approximate.
function normalizeName(name) {
  return String(name)
    .toUpperCase()
    .replace(/[.,'"]/g, "")
    .replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|LLC|LP|PLC|HOLDINGS?|GROUP)\b\.?/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

// Alpaca names append the security type after the company name (e.g.
// "Digital Ally, Inc. Common Stock", "Meta Platforms, Inc. Class A
// Common Stock") -- strip from the first such marker onward so the
// remainder is comparable to SEC's bare corporate name.
const ALPACA_NAME_SUFFIX = /\s+(Common Stock|Class [A-Z]\b.*|Ordinary Shares?.*|Depositary Shares?.*|Sponsored ADR.*|American Depositary.*).*$/i;
function stripAlpacaSuffix(name) {
  return String(name).replace(ALPACA_NAME_SUFFIX, "").trim();
}

// Alpaca can carry two separate asset records for the exact same symbol
// (confirmed: Prudential's "PRH" appears once active, once inactive) --
// both correctly resolve to the same CIK, but pushing both as separate
// ticker entries creates two identical (ticker, open-ended daterange)
// claims for scr_ticker_history's exclusion constraint to reject. Add at
// most one entry per distinct symbol per company, preferring "active"
// if the two disagree.
function addTicker(company, tickerEntry) {
  const existing = company.tickers.find((t) => t.symbol === tickerEntry.symbol);
  if (!existing) {
    company.tickers.push(tickerEntry);
  } else if (existing.alpacaStatus === "inactive" && tickerEntry.alpacaStatus === "active") {
    existing.alpacaStatus = "active";
  }
}

const TARGET_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX"]);
// Bare ".PR" (e.g. DCOM.PR) as well as a series letter (e.g. BAC.PRL) --
// confirmed both forms exist via a live sample.
const PREFERRED_PATTERN = /\.PR[A-Z]*$/i;
// Depositary preferred shares sometimes use a ticker with no recognizable
// suffix at all (e.g. METAM for Meta's preferred depositary shares) --
// confirmed via a real unresolved case. Name-based backstop.
const PREFERRED_NAME_PATTERN = /preferred stock|non-cumulative|cumulative (redeemable |convertible )?preferred/i;
// Administrative artifacts in Alpaca's asset list (tender-offer contra
// securities, test entries, stock rights) -- not real tradable common
// stock. Confirmed real: a numeric-CUSIP "symbol" for a tender contra
// slipped through name-based resolution and became MorphoSys AG's only
// resolved ticker instead of its real ticker "MOR" (used before this
// filter existed; left as a documented known gap for that one company
// rather than redone, since it's immaterial at 1 of 5,650).
// Pure-numeric CUSIPs (e.g. "123456782") and alphanumeric 9-character
// CUSIPs (e.g. "23248B208", "928CVR018" -- both confirmed real, attached
// to companies -- XTI Aerospace, Dogwood Therapeutics -- that ALSO have
// their real ticker, so no company data is lost, just a bogus extra
// ticker-row). Real tickers are essentially never 7+ characters AND
// contain a digit, which is what both CUSIP forms share.
const ADMINISTRATIVE_SYMBOL_PATTERN = /^\d+$/;
const CUSIP_LIKE_PATTERN = /^[0-9A-Z]{7,}$/;
function looksLikeCusip(symbol) {
  return CUSIP_LIKE_PATTERN.test(symbol) && /\d/.test(symbol);
}
const ADMINISTRATIVE_NAME_PATTERN = /\bcontra\b|tender offer|test dummy|\brights\b/i;

async function fetchAlpacaAssets(env, status) {
  const headers = { "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY };
  const res = await fetch(`https://api.alpaca.markets/v2/assets?status=${status}&asset_class=us_equity`, { headers });
  if (!res.ok) throw new Error(`Alpaca assets HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const env = loadEnvLocal(".env.local");
  const secIndex = JSON.parse(await readFile(SEC_INDEX_FILE, "utf8"));
  const secNameIndex = JSON.parse(await readFile(SEC_NAME_INDEX_FILE, "utf8"));

  console.log("fetching Alpaca active + inactive us_equity assets...");
  const [active, inactive] = await Promise.all([
    fetchAlpacaAssets(env, "active"),
    fetchAlpacaAssets(env, "inactive"),
  ]);
  const allAssets = [...active.map((a) => ({ ...a, alpacaStatus: "active" })), ...inactive.map((a) => ({ ...a, alpacaStatus: "inactive" }))];
  console.log(`total assets: ${allAssets.length} (active ${active.length}, inactive ${inactive.length})`);

  const exchangeFiltered = allAssets.filter((a) => TARGET_EXCHANGES.has(a.exchange));
  console.log(`after exchange filter (NASDAQ/NYSE/AMEX): ${exchangeFiltered.length}`);

  const review = {};
  const byCik = new Map(); // cik -> { cik, tickers: [{symbol, exchange, alpacaStatus}], name, category, sic, sicDescription }

  let excludedPreferred = 0, excludedWarrantName = 0, excludedNoCategory = 0, excludedAmbiguous = 0, excludedUnresolved = 0, excludedAdministrative = 0;

  for (const asset of exchangeFiltered) {
    if (ADMINISTRATIVE_SYMBOL_PATTERN.test(asset.symbol) || looksLikeCusip(asset.symbol) || ADMINISTRATIVE_NAME_PATTERN.test(asset.name)) { excludedAdministrative += 1; continue; }
    if (PREFERRED_PATTERN.test(asset.symbol)) { excludedPreferred += 1; continue; }
    if (PREFERRED_NAME_PATTERN.test(asset.name)) { excludedPreferred += 1; continue; }
    if (/warrant/i.test(asset.name)) { excludedWarrantName += 1; continue; }

    // SEC's own ticker records use "-" for dual-class shares (confirmed:
    // "BF-A"/"BF-B" for Brown-Forman); Alpaca uses "." ("BF.A"/"BF.B").
    // Try the direct symbol first, then the "-"-normalized form.
    const candidates = secIndex[asset.symbol] ?? (asset.symbol.includes(".") ? secIndex[asset.symbol.replace(/\./g, "-")] : undefined);
    if (!candidates || candidates.length === 0) {
      excludedUnresolved += 1;
      review[asset.symbol] = { symbol: asset.symbol, reason: "no CIK match in SEC submissions index", alpacaName: asset.name, exchange: asset.exchange, alpacaStatus: asset.alpacaStatus };
      continue;
    }
    const uniqueCiks = new Set(candidates.map((c) => c.cik));
    if (uniqueCiks.size > 1) {
      excludedAmbiguous += 1;
      review[asset.symbol] = { symbol: asset.symbol, reason: `ambiguous: ${uniqueCiks.size} distinct CIKs match this ticker`, candidates, alpacaName: asset.name, exchange: asset.exchange, alpacaStatus: asset.alpacaStatus };
      continue;
    }
    const match = candidates[0];
    if (!match.category) { excludedNoCategory += 1; continue; }

    const existing = byCik.get(match.cik);
    const tickerEntry = { symbol: asset.symbol, exchange: asset.exchange, alpacaStatus: asset.alpacaStatus };
    if (existing) {
      addTicker(existing, tickerEntry);
    } else {
      byCik.set(match.cik, {
        cik: match.cik, tickers: [tickerEntry], name: match.name,
        category: match.category, entityType: match.entityType, sic: match.sic, sicDescription: match.sicDescription,
      });
    }
  }

  console.log(`\nafter ticker-based pass: administrative=${excludedAdministrative}, preferred=${excludedPreferred}, warrant-name=${excludedWarrantName}, no-category=${excludedNoCategory}, ambiguous=${excludedAmbiguous}, unresolved=${excludedUnresolved}`);
  console.log(`companies resolved by ticker: ${byCik.size}`);

  // Name-based fallback pass: ticker resolution systematically misses
  // delisted/acquired companies, because SEC's tickers[] field tracks
  // only the CURRENT ticker and a deregistered CIK often has none at all
  // (confirmed empirically: zero companies resolved by ticker alone had
  // every Alpaca ticker marked inactive, despite Alpaca's inactive list
  // having 19,155 entries). formerNames preserves name history with real
  // dates, so retry every still-unresolved, non-administrative symbol by
  // normalized name. Still exact-match only -- multiple distinct CIKs
  // matching the same normalized name go to review, not a guess.
  let resolvedByName = 0, stillUnresolved = 0;
  for (const [symbol, entry] of Object.entries(review)) {
    if (entry.reason !== "no CIK match in SEC submissions index") continue;
    const stripped = stripAlpacaSuffix(entry.alpacaName);
    const norm = normalizeName(stripped);
    const nameMatches = norm ? secNameIndex[norm] : undefined;
    if (!nameMatches || nameMatches.length === 0) { stillUnresolved += 1; continue; }
    const uniqueCiks = new Set(nameMatches.map((m) => m.cik));
    if (uniqueCiks.size > 1) {
      entry.reason = `ambiguous by name: ${uniqueCiks.size} distinct CIKs match "${norm}"`;
      entry.nameMatches = nameMatches;
      stillUnresolved += 1;
      continue;
    }
    const cik = [...uniqueCiks][0];
    // category/entityType/sic come from the name match itself now (the
    // CIK's current filing record, carried on every name-index entry
    // regardless of which name matched) -- not a secIndex[symbol] lookup,
    // which would look up the very stale ticker that just failed to
    // resolve.
    const meta = nameMatches[0];
    if (!meta.category) { excludedNoCategory += 1; delete review[symbol]; continue; }
    const existing = byCik.get(cik);
    const tickerEntry = { symbol, exchange: entry.exchange, alpacaStatus: entry.alpacaStatus };
    if (existing) {
      addTicker(existing, tickerEntry);
    } else {
      byCik.set(cik, { cik, tickers: [tickerEntry], name: meta.name, category: meta.category, entityType: meta.entityType, sic: meta.sic, sicDescription: meta.sicDescription });
    }
    delete review[symbol];
    resolvedByName += 1;
  }
  console.log(`name-based fallback pass: resolved ${resolvedByName}, still unresolved ${stillUnresolved}`);

  const companies = [...byCik.values()];
  console.log(`\ncompanies resolved (total): ${companies.length} (from ${exchangeFiltered.length} exchange-filtered assets)`);
  console.log(`review list: ${Object.keys(review).length} entries`);

  await writeFile(OUT_COMPANIES, JSON.stringify(companies, null, 2));
  await writeFile(OUT_REVIEW, JSON.stringify(review, null, 2));
  console.log(`wrote ${OUT_COMPANIES} and ${OUT_REVIEW}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
