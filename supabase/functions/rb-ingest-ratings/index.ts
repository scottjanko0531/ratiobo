import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Stock Picker Phase 1 -- the one write path for ratings/Fool/13F data
// into RatioBo, so the external claude.ai Rule Breaker workspace stops
// being the only place those edits ever land. verify_jwt=true (project
// default) PLUS a dedicated x-ingest-key header checked against the
// RB_INGEST_KEY edge function secret -- a leaked workspace credential
// alone can't reach anything beyond this one narrow write path.
//
// Upserts into rb_ratings/rb_fool trigger their existing (rb_ratings) or
// new (rb_fool, this phase's migration) archive-on-update triggers
// automatically -- this function doesn't write history rows itself.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-key",
};

const ingestKey = Deno.env.get("RB_INGEST_KEY");

interface RatingInput {
  symbol: string; td?: number; moat?: number; mgmt?: number; appeal?: number;
  founder?: boolean; why?: string; appeal_why?: string; appeal_basis?: string;
  rated_on?: string; source_url?: string;
}
interface FoolInput {
  symbol: string; f5?: number; type?: string; first_rec?: string;
  recs?: number; top10?: boolean; status?: string; closed_on?: string;
}
interface Holder13fInput {
  symbol: string; quarter: string; fund: string; weight_pct?: number; change?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (!ingestKey || req.headers.get("x-ingest-key") !== ingestKey) {
    return new Response(JSON.stringify({ error: "invalid or missing x-ingest-key" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = new Date().toISOString();
  const results: Record<string, unknown> = {};

  try {
    const body = await req.json();
    const ratings: RatingInput[] = body.ratings ?? [];
    const fool: FoolInput[] = body.fool ?? [];
    const holders13f: Holder13fInput[] = body.holders13f ?? [];

    if (ratings.length > 0) {
      try {
        // rb_ratings' real key is (symbol, user_id) -- single-user system
        // today, so derive "the" user the same way rb-compute already
        // does: the one rb_strategy=true portfolio's owner.
        const { data: rbPortfolios, error: pErr } = await supabase
          .from("portfolios").select("user_id").eq("rb_strategy", true);
        if (pErr) throw new Error(`portfolios lookup: ${pErr.message}`);
        if (!rbPortfolios || rbPortfolios.length !== 1) {
          throw new Error(`expected exactly 1 portfolio with rb_strategy=true, found ${rbPortfolios?.length ?? 0}`);
        }
        const userId = rbPortfolios[0].user_id as string;

        const rows = ratings.map((r) => ({
          symbol: r.symbol, user_id: userId,
          td: r.td ?? null, moat: r.moat ?? null, mgmt: r.mgmt ?? null, appeal: r.appeal ?? null,
          founder: r.founder ?? false, why: r.why ?? null, appeal_why: r.appeal_why ?? null,
          appeal_basis: r.appeal_basis ?? "customer", rated_on: r.rated_on ?? null,
          source_url: r.source_url ?? null, updated_at: new Date().toISOString(),
        }));
        const { error } = await supabase.from("rb_ratings").upsert(rows, { onConflict: "symbol,user_id" });
        if (error) throw new Error(error.message);
        results.ratings = { ok: true, count: rows.length };
      } catch (e) {
        results.ratings = { ok: false, error: String(e) };
      }
    }

    if (fool.length > 0) {
      try {
        const rows = fool.map((f) => ({
          symbol: f.symbol, f5: f.f5 ?? null, type: f.type ?? null, first_rec: f.first_rec ?? null,
          recs: f.recs ?? null, top10: f.top10 ?? false, status: f.status ?? "active",
          closed_on: f.closed_on ?? null, updated_at: new Date().toISOString(),
        }));
        const { error } = await supabase.from("rb_fool").upsert(rows, { onConflict: "symbol" });
        if (error) throw new Error(error.message);
        results.fool = { ok: true, count: rows.length };
      } catch (e) {
        results.fool = { ok: false, error: String(e) };
      }
    }

    if (holders13f.length > 0) {
      try {
        const rows = holders13f.map((h) => ({
          symbol: h.symbol, quarter: h.quarter, fund: h.fund,
          weight_pct: h.weight_pct ?? null, change: h.change ?? null, updated_at: new Date().toISOString(),
        }));
        const { error } = await supabase.from("rb_holders_13f").upsert(rows, { onConflict: "symbol,quarter,fund" });
        if (error) throw new Error(error.message);
        results.holders13f = { ok: true, count: rows.length };
      } catch (e) {
        results.holders13f = { ok: false, error: String(e) };
      }
    }

    const hasError = Object.values(results).some((r) => (r as { ok: boolean }).ok === false);
    await supabase.from("rb_job_runs").insert({
      job_name: "rb-ingest-ratings", started_at: startedAt, finished_at: new Date().toISOString(),
      status: hasError ? "error" : "ok", detail: results,
    });

    return new Response(JSON.stringify(results, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    await supabase.from("rb_job_runs").insert({
      job_name: "rb-ingest-ratings", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "error", detail: { ...results, error: String(e) },
    });
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
