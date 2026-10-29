import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { classifyInflationRegime, MonthlyObs } from "../_shared/inflationRegime.ts";

// Regime Tilt Recalibration, Phase 1 — recomputes the full inflation-level
// classification (Bera-Harvey-Hooper) from bond_raw_series's CPIAUCSL/INDPRO
// history and upserts inflation_regime_history. Same "recompute everything,
// idempotent upsert" convention as bond-lens-ingest, since the classifier is
// cheap (a few thousand months) and this sidesteps any incremental-update
// bugs around the 3-month confirmation filter or the percentile window.
// Scheduled nightly after bond-lens-ingest's FRED pull, before
// fetch-macro-data and update-regime-portfolio-targets.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // PostgREST enforces its own server-side max-rows cap regardless of a
  // client-requested .limit() above it, so page explicitly rather than
  // trust a single request to return all ~1300 months.
  async function fetchAllRows(seriesId: string): Promise<MonthlyObs[]> {
    const PAGE = 1000;
    const out: MonthlyObs[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("bond_raw_series")
        .select("obs_date, value")
        .eq("series_id", seriesId)
        .order("obs_date")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`${seriesId} read: ${error.message}`);
      for (const r of data ?? []) out.push({ date: r.obs_date, value: r.value });
      if (!data || data.length < PAGE) break;
    }
    return out;
  }

  try {
    const [cpi, ip] = await Promise.all([fetchAllRows("CPIAUCSL"), fetchAllRows("INDPRO")]);

    const rows = classifyInflationRegime(cpi, ip);

    const upsertRows = rows.map((r) => ({
      month: r.month,
      cpi_yoy: r.cpiYoy,
      cpi_p75: r.cpiP75,
      cpi_margin: r.cpiMargin,
      ip_yoy: r.ipYoy,
      ip_cagr10: r.ipCagr10,
      raw_state: r.rawState,
      confirmed_state: r.confirmedState,
      candidate_state: r.candidateState,
      candidate_count: r.candidateCount,
      accel_3m: r.accel3m,
      accel_6m: r.accel6m,
      accel_9m: r.accel9m,
      accel_vote: r.accelVote,
      computed_at: new Date().toISOString(),
    }));

    const CHUNK = 500;
    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const chunk = upsertRows.slice(i, i + CHUNK);
      const { error } = await sb.from("inflation_regime_history").upsert(chunk, { onConflict: "month" });
      if (error) throw new Error(`inflation_regime_history upsert: ${error.message}`);
    }

    const latest = rows[rows.length - 1] ?? null;
    return json({ ok: true, monthsComputed: rows.length, latest });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
