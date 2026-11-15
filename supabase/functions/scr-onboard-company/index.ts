import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Narrow, single-company incremental onboarding for the forward test's
// trade triggers (P1-P6): given a symbol not yet in scr_securities,
// resolve it via SEC's live company_tickers.json (the same source Phase
// 2a's mapping_method='sec_ticker_file' used -- lightweight, no bulk
// submissions.zip extraction) and upsert through scr-ingest's existing
// securityMaster path, same insert-only/ignoreDuplicates model it already
// uses. Deliberately does NOT replicate build_universe_2b.mjs's full
// batch pipeline (the bulk ticker/name reverse indexes, the name-based
// fallback pass) -- this is the "one ticker at a time, common case
// onboards automatically, anything ambiguous goes to needs_review"
// version Scott asked for, not the dedicated bulk pipeline.
//
// Ambiguity handling, matching build_universe_2b.mjs's own standard:
// no ticker match in SEC's live index, or the ticker resolves but the
// caller's company name doesn't match SEC's registered name after the
// SAME normalization build_universe_2b.mjs/build_sec_name_index.mjs use
// -> insert with needs_review=true and a review_note, but still insert
// (so the forward-test trade is never blocked on this -- Scott's explicit
// instruction: "the common/clean case... should onboard automatically...
// forward-test picks [shouldn't be] delayed").

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Exact ports of build_universe_2b.mjs's normalizeName/stripAlpacaSuffix
// -- same exact-match-only convention, never fuzzy.
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,'"]/g, "")
    .replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|LLC|LP|PLC|HOLDINGS?|GROUP)\b\.?/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}
const ALPACA_NAME_SUFFIX = /\s+(Common Stock|Class [A-Z]\b.*|Ordinary Shares?.*|Depositary Shares?.*|Sponsored ADR.*|American Depositary.*).*$/i;
function stripAlpacaSuffix(name: string): string {
  return name.replace(ALPACA_NAME_SUFFIX, "").trim();
}

let tickerIndexCache: Record<string, { cik_str: number; ticker: string; title: string }> | null = null;

async function fetchSecTickerIndex(): Promise<Record<string, { cik_str: number; ticker: string; title: string }>> {
  if (tickerIndexCache) return tickerIndexCache;
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "Ratiobo research tool contact@example.com" },
  });
  if (!res.ok) throw new Error(`SEC company_tickers.json fetch failed: HTTP ${res.status}`);
  const data = await res.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
  const byTicker: Record<string, { cik_str: number; ticker: string; title: string }> = {};
  for (const entry of Object.values(data)) byTicker[entry.ticker.toUpperCase()] = entry;
  tickerIndexCache = byTicker;
  return byTicker;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const { symbol, company_name } = await req.json();
    if (!symbol) {
      return new Response(JSON.stringify({ error: "symbol is required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const upperSymbol = String(symbol).toUpperCase();

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Already onboarded? (check the current-ticker view, not just any
    // historical ticker, so a reused/recycled symbol doesn't short-circuit.)
    const { data: existing } = await supabase
      .from("scr_ticker_history")
      .select("company_id")
      .eq("ticker", upperSymbol)
      .is("valid_to", null)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ ok: true, company_id: existing.company_id, onboarded: false, reason: "already in scr_securities" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const index = await fetchSecTickerIndex();
    const secCandidate = index[upperSymbol] ?? (upperSymbol.includes(".") ? index[upperSymbol.replace(/\./g, "-")] : undefined);

    let needsReview = false;
    let reviewNote: string | null = null;
    let cik: string | null = null;
    let name: string | null = null;

    if (!secCandidate) {
      needsReview = true;
      reviewNote = "no CIK match in SEC's live company_tickers.json";
      name = company_name ?? upperSymbol;
    } else {
      cik = String(secCandidate.cik_str).padStart(10, "0");
      name = secCandidate.title;
      if (company_name) {
        const normCaller = normalizeName(stripAlpacaSuffix(company_name));
        const normSec = normalizeName(secCandidate.title);
        if (normCaller && normSec && normCaller !== normSec) {
          needsReview = true;
          reviewNote = `caller name "${company_name}" does not match SEC's registered name "${secCandidate.title}" after normalization`;
        }
      }
    }

    const { data: ingestResult, error: ingestErr } = await supabase.functions.invoke("scr-ingest", {
      headers: { "x-ingest-key": Deno.env.get("SCR_INGEST_KEY")! },
      body: {
        securityMaster: [{
          cik: cik ?? `UNRESOLVED-${upperSymbol}`,
          tickers: [{ ticker: upperSymbol, exchange: null }],
          names: [{ name }],
          sic_code: null,
          sector: null,
          status: "active",
          mapping_method: cik ? "sec_ticker_file" : "manual",
          needs_review: needsReview,
          review_note: reviewNote,
        }],
      },
    });
    if (ingestErr) throw new Error(`scr-ingest call failed: ${ingestErr.message}`);

    // securityMaster upsert is onConflict:'cik', ignoreDuplicates:true --
    // doesn't return the inserted id, so look the company back up by CIK
    // (or by the ticker we just inserted, for the unresolved-CIK case).
    const { data: created } = await supabase
      .from("scr_securities")
      .select("id")
      .eq("cik", cik ?? `UNRESOLVED-${upperSymbol}`)
      .maybeSingle();

    // A freshly onboarded company also needs a ticker-history row (every
    // other onboarding path creates one) and corresponding entries in
    // scr_ticker_history so refresh_companies_list.mjs and future
    // onboarding checks see it going forward.
    if (created) {
      await supabase.from("scr_ticker_history").insert({
        company_id: created.id, ticker: upperSymbol, valid_from: new Date().toISOString().slice(0, 10),
        valid_to: null, source: "scr-onboard-company",
      });
    }

    return new Response(JSON.stringify({
      ok: true, onboarded: true, company_id: created?.id ?? null, needs_review: needsReview, review_note: reviewNote, ingest: ingestResult,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
