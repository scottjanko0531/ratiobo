import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { computeUniverseScores } from "../_shared/ruleBreaker/scoring.ts";
import type { SymbolScoreInput } from "../_shared/ruleBreaker/scoring.ts";
import type { RbWeeklyBarInput } from "../_shared/ruleBreaker/types.ts";

// Rule Breaker Screener — Phase 3 daily compute. Runs once, after every
// rb-refresh slice has landed today's data. Loads the full active
// universe (percentiles are cross-sectional -- this cannot be split the
// way rb-refresh is), calls computeUniverseScores once, and inserts one
// rb_scores row per symbol with config_version='ratiobo-v1'.
//
// rb_ratings/the owned set are keyed by user_id, not global -- there is
// exactly one portfolio with rb_strategy=true today (confirmed live
// before building this), so that portfolio's owner is "the" user. If
// that ever stops being true this throws rather than silently guessing
// which user's ratings to use.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// The Monday (UTC) of `dateStr`'s own week -- the artifact's own
// "newly qualified" gate anchors to this, not to the prior calendar day,
// so the gate holds for a whole Mon-Fri week rather than recomputing
// day-by-day (confirmed by the user from the artifact's real source).
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = new Date().toISOString();
  const url = new URL(req.url);
  // Manual/ad-hoc override for re-running a specific past date's compute
  // (e.g. verifying a formula fix against a day that already has
  // rb_fundamentals/rb_job_runs data) -- not used by the daily schedule,
  // same convention as rb-refresh's `?symbols=` override.
  const today = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const skipped: string[] = [];

  try {
    const { data: rbPortfolios, error: portErr } = await supabase
      .from("portfolios")
      .select("id, user_id")
      .eq("rb_strategy", true);
    if (portErr) throw new Error(`portfolios query: ${portErr.message}`);
    if (!rbPortfolios || rbPortfolios.length !== 1) {
      throw new Error(`expected exactly 1 portfolio with rb_strategy=true, found ${rbPortfolios?.length ?? 0}`);
    }
    const userId = rbPortfolios[0].user_id as string;

    const { data: companies, error: compErr } = await supabase
      .from("rb_companies")
      .select("symbol")
      .eq("active", true)
      .order("symbol");
    if (compErr) throw new Error(`rb_companies query: ${compErr.message}`);
    const symbols = (companies ?? []).map((c) => c.symbol as string);
    if (symbols.length === 0) throw new Error("no active rb_companies symbols");

    // Confirm every rb-refresh slice finished today before scoring --
    // never a mix of today's and yesterday's rb_fundamentals rows. Checks
    // actual (offset, limit) coverage from today's `rb_job_runs` rows
    // rather than hardcoding "4 slices of 40": any slice that's missing,
    // still running, or itself errored leaves a gap, which is treated the
    // same way regardless of why. Per-symbol failures INSIDE an 'ok' slice
    // are fine (that symbol just keeps yesterday's row) -- only a slice
    // that never reached 'ok' at all blocks the run.
    const todayStart = `${today}T00:00:00.000Z`;
    const nextDay = new Date(todayStart);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const { data: refreshRuns, error: refreshRunsErr } = await supabase
      .from("rb_job_runs")
      .select("status, detail")
      .eq("job_name", "rb-refresh")
      .gte("started_at", todayStart)
      .lt("started_at", nextDay.toISOString());
    if (refreshRunsErr) throw new Error(`rb_job_runs query: ${refreshRunsErr.message}`);

    const okRanges = (refreshRuns ?? [])
      .filter((r) => r.status === "ok")
      .map((r) => ({
        offset: Number((r.detail as Record<string, unknown> | null)?.offset),
        limit: Number((r.detail as Record<string, unknown> | null)?.limit),
      }))
      .filter((r) => Number.isFinite(r.offset) && Number.isFinite(r.limit))
      .sort((a, b) => a.offset - b.offset);
    let covered = 0;
    for (const r of okRanges) {
      if (r.offset > covered) break; // gap -- a slice is missing, still running, or errored
      covered = Math.max(covered, r.offset + r.limit);
    }
    if (covered < symbols.length) {
      const reason = "skipped: refresh incomplete";
      await supabase.from("rb_job_runs").insert({
        job_name: "rb-compute", started_at: startedAt, finished_at: new Date().toISOString(),
        status: "ok",
        detail: { date: today, reason, covered, totalSymbols: symbols.length, refreshRuns: (refreshRuns ?? []).map((r) => r.status) },
      });
      return new Response(JSON.stringify({ date: today, reason, covered, totalSymbols: symbols.length }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { data: fundamentalsRows, error: fErr } = await supabase
      .from("rb_fundamentals")
      .select("symbol, raw, mcap_usd, fx_to_usd")
      .eq("asof", today)
      .in("symbol", symbols);
    if (fErr) throw new Error(`rb_fundamentals query: ${fErr.message}`);
    const fundamentalsBySymbol = new Map((fundamentalsRows ?? []).map((r) => [r.symbol as string, r]));

    // rb_weekly_bars already has ~8000 rows (155 symbols x 50+ weeks each)
    // -- well past PostgREST's default 1000-row cap, so this must be
    // paginated explicitly rather than read in one unbounded query.
    const barRows: Array<Record<string, unknown>> = [];
    const PAGE_SIZE = 1000;
    for (let page = 0; ; page++) {
      // Order by (symbol, week_start) -- the table's own primary key --
      // not week_start alone: ties on week_start across ~155 symbols
      // would otherwise make page boundaries non-deterministic (rows
      // duplicated or dropped across pages).
      const { data: pageRows, error: bErr } = await supabase
        .from("rb_weekly_bars")
        .select("symbol, week_start, close, vwap6_a, vwap6_sigma, vwap12_b, signal")
        .in("symbol", symbols)
        .order("symbol", { ascending: true })
        .order("week_start", { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (bErr) throw new Error(`rb_weekly_bars query: ${bErr.message}`);
      barRows.push(...(pageRows ?? []));
      if (!pageRows || pageRows.length < PAGE_SIZE) break;
    }
    const barsBySymbol = new Map<string, RbWeeklyBarInput[]>();
    for (const r of barRows) {
      const list = barsBySymbol.get(r.symbol as string) ?? [];
      list.push({
        symbol: r.symbol as string,
        week_start: r.week_start as string,
        close: r.close as number | null,
        vwap6_a: r.vwap6_a as number | null,
        vwap6_sigma: r.vwap6_sigma as number | null,
        vwap12_b: r.vwap12_b as number | null,
        signal: r.signal as "u" | "d" | null,
      });
      barsBySymbol.set(r.symbol as string, list);
    }

    const { data: foolRows, error: foolErr } = await supabase
      .from("rb_fool")
      .select("symbol, f5, type, top10, closed_on")
      .in("symbol", symbols);
    if (foolErr) throw new Error(`rb_fool query: ${foolErr.message}`);
    const foolBySymbol = new Map((foolRows ?? []).map((r) => [r.symbol as string, r]));

    const { data: ratingRows, error: ratingErr } = await supabase
      .from("rb_ratings")
      .select("symbol, td, moat, mgmt, appeal")
      .eq("user_id", userId)
      .in("symbol", symbols);
    if (ratingErr) throw new Error(`rb_ratings query: ${ratingErr.message}`);
    const ratingsBySymbol = new Map((ratingRows ?? []).map((r) => [r.symbol as string, r]));

    // Owned set -- same join scripts/rb-import.ts's holdings cross-check
    // already proves out: portfolio_holdings -> holdings (quantity>0)
    // joined to the rb_strategy=true portfolio.
    const { data: holdingRows, error: holdErr } = await supabase
      .from("portfolio_holdings")
      .select("holdings!inner(symbol, quantity), portfolios!inner(rb_strategy)")
      .eq("portfolios.rb_strategy", true);
    if (holdErr) throw new Error(`portfolio_holdings query: ${holdErr.message}`);
    const ownedSymbols = new Set(
      ((holdingRows ?? []) as unknown as Array<{ holdings: { symbol: string; quantity: number } }>)
        .filter((r) => Number(r.holdings.quantity) > 0)
        .map((r) => r.holdings.symbol),
    );

    // "Newly qualified" prior-week snapshot -- anchored to the MOST
    // RECENT WEEK strictly before this week (not the prior calendar day),
    // using the FIRST rb_scores row recorded in that week, ANY
    // config_version (so the imported artifact-v15 weekly snapshots count
    // as real prior-week data, not just live 'ratiobo-v1' history).
    // Confirmed via the user's exact spec and two real 2026-10-20 cases
    // (BRZE: week of 2026-10-12 score 49; EXEL: week of 2026-10-12 score
    // 44) -- see vwap.ts's computeAction for the threshold side of this.
    const thisWeekId = mondayOf(today);
    const priorRows: Array<{ symbol: string; date: string; score: number | null }> = [];
    const PRIOR_PAGE_SIZE = 1000;
    for (let page = 0; ; page++) {
      const { data: pageRows, error: priorErr } = await supabase
        .from("rb_scores")
        .select("symbol, date, score")
        .in("symbol", symbols)
        .lt("date", thisWeekId)
        .order("date", { ascending: true })
        .range(page * PRIOR_PAGE_SIZE, page * PRIOR_PAGE_SIZE + PRIOR_PAGE_SIZE - 1);
      if (priorErr) throw new Error(`prior rb_scores query: ${priorErr.message}`);
      priorRows.push(...((pageRows ?? []) as typeof priorRows));
      if (!pageRows || pageRows.length < PRIOR_PAGE_SIZE) break;
    }
    // Rows arrive ascending by date, so for each symbol the first row seen
    // at a given weekId is necessarily that week's earliest-dated row;
    // only advance bestWeekIdBySymbol on a STRICTLY greater weekId, which
    // naturally lands on the most recent prior week's first row.
    const bestWeekIdBySymbol = new Map<string, string>();
    const priorScoreBySymbol = new Map<string, number>();
    for (const r of priorRows) {
      const weekId = mondayOf(r.date);
      const best = bestWeekIdBySymbol.get(r.symbol);
      if (best == null || weekId > best) {
        bestWeekIdBySymbol.set(r.symbol, weekId);
        if (r.score != null) priorScoreBySymbol.set(r.symbol, r.score);
        else priorScoreBySymbol.delete(r.symbol);
      }
    }

    const members: SymbolScoreInput[] = [];
    for (const symbol of symbols) {
      const fund = fundamentalsBySymbol.get(symbol);
      const bars = barsBySymbol.get(symbol) ?? [];
      if (!fund) {
        // No today's fundamentals row at all means no score is possible
        // for this symbol today -- genuinely skipped, not scored. A thin
        // weekly-bar history is NOT a reason to skip: computeUniverseScores
        // falls back to vwap_state=NO_VWAP_DATA for that case on its own,
        // scoring the symbol normally on every other field (dropping it
        // here would shift everyone else's percentile and break parity).
        skipped.push(`${symbol}: no rb_fundamentals row for ${today}`);
        continue;
      }
      const fool = foolBySymbol.get(symbol);
      const rating = ratingsBySymbol.get(symbol);
      members.push({
        symbol,
        date: today,
        raw: fund.raw,
        mcapUsd: fund.mcap_usd as number | null,
        fxToUsd: fund.fx_to_usd as number | null,
        weeklyBars: bars,
        fool: fool
          ? { symbol, f5: fool.f5 as number | null, type: fool.type as "Cautious" | "Moderate" | "Aggressive" | null, top10: fool.top10 as boolean, closed_on: fool.closed_on as string | null }
          : null,
        rating: rating
          ? { symbol, td: rating.td as number | null, moat: rating.moat as number | null, mgmt: rating.mgmt as number | null, appeal: rating.appeal as number | null }
          : null,
        owned: ownedSymbols.has(symbol),
        priorWeekScore: priorScoreBySymbol.get(symbol) ?? null,
      });
    }

    if (members.length === 0) throw new Error("no symbols have today's rb_fundamentals row -- nothing to score");

    const results = computeUniverseScores(members);
    const rows = results.map((r) => ({
      symbol: r.symbol,
      date: r.date,
      // The live pipeline's own tag, NOT the engine's RB_CONFIG.version
      // (r.config_version) -- that one tracks the scoring *formula*'s own
      // iteration (e.g. "rb-1.1.0-draft", used when reproducing a frozen
      // historical baseline like "artifact-v15"), a different axis from
      // "which pipeline run produced this row". rb-compute always writes
      // the latter.
      config_version: "ratiobo-v1",
      c1: r.c1, c2: r.c2, c3: r.c3, c4: r.c4, c5: r.c5, c6: r.c6,
      met: r.met,
      composite: r.composite,
      score: r.score,
      rank: r.rank,
      screen: r.screen,
      safety: r.safety,
      quality: r.quality,
      qgroup: r.qgroup,
      weak_pillar: r.weak_pillar,
      risk_type: r.risk_type,
      action: r.action,
      action_key: r.action_key,
      action_why: r.action_why,
      vwap_state: r.vwap_state,
      vwap_z: r.vwap_z,
      drivers: r.drivers,
      partial: false,
    }));

    const { error: insErr } = await supabase.from("rb_scores").insert(rows);
    if (insErr) throw new Error(`rb_scores insert: ${insErr.message}`);

    await supabase.from("rb_job_runs").insert({
      job_name: "rb-compute", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "ok", detail: { date: today, scored: rows.length, skipped },
    });

    return new Response(JSON.stringify({ date: today, scored: rows.length, skipped }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    await supabase.from("rb_job_runs").insert({
      job_name: "rb-compute", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "error", detail: { date: today, error: String(e), skipped },
    });
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
