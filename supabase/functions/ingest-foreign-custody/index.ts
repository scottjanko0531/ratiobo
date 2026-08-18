import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRED_API_KEY = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Foreign Official Custody Holdings — marketable Treasuries held in custody
// at FRBNY for foreign official and international accounts. Weekly Wednesday
// level from the Fed H.4.1 release, ~1-day lag — a leading indicator for the
// TIC-based Foreign Official Share card (which publishes with a ~2-month
// lag). Series is WMTSECL1, NOT the discontinued WMTSECL (last obs
// 2012-11-07) — an easy, silent mistake per the spec.
//
// Custody holdings will not tie to TIC foreign official holdings (custody
// only covers FRBNY-held securities, not the whole foreign official
// universe) — never reconcile the levels, only the trend.
const SERIES_ID = "WMTSECL1";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${SERIES_ID}&api_key=${FRED_API_KEY}&sort_order=asc&limit=100000&file_type=json`;
    const res = await fetch(url);
    if (!res.ok) return json({ error: `FRED ${SERIES_ID}: HTTP ${res.status}` }, 500);
    const j = await res.json();
    const obs = (j.observations as { date: string; value: string }[])
      .filter((o) => o.value !== "." && o.value !== "")
      .map((o) => ({ date: o.date, value_mn: parseFloat(o.value) }))
      .filter((o) => !isNaN(o.value_mn));
    if (obs.length < 60) return json({ error: `too few observations (${obs.length})` }, 500);

    // obs is ascending by date (weekly Wednesdays) — 13/52 observations back
    // is 13/52 weeks back exactly, since the series has no gaps to speak of.
    const rows = obs.map((o, i) => {
      const treasury_bn = Math.round((o.value_mn / 1000) * 1000) / 1000; // millions -> billions
      const prev13 = i >= 13 ? obs[i - 13].value_mn / 1000 : null;
      const prev52 = i >= 52 ? obs[i - 52].value_mn / 1000 : null;
      return {
        obs_date: o.date,
        treasury_bn,
        change_13w_bn: prev13 != null ? Math.round((treasury_bn - prev13) * 1000) / 1000 : null,
        change_52w_bn: prev52 != null ? Math.round((treasury_bn - prev52) * 1000) / 1000 : null,
        source: "FRED:WMTSECL1",
      };
    });

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("foreign_custody_holdings").upsert(rows.slice(i, i + 500), { onConflict: "obs_date" });
      if (error) return json({ error: error.message }, 500);
    }

    const latest = rows[rows.length - 1];
    return json({ rowsUpserted: rows.length, dateRange: [rows[0].obs_date, latest.obs_date], latest });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
