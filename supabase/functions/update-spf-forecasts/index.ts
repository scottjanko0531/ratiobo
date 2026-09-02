import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx";

// GDP & Inflation Regime Metrics spec, G4/I4 "Forward Consensus": ingests
// the Philadelphia Fed Survey of Professional Forecasters' median-forecast
// files. URL pattern and file shape verified manually (curl + openpyxl)
// before building this — the query-string hash on the site's own download
// links is a CDN cache-buster, not required for a valid fetch.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SPF_BASE = "https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/survey-of-professional-forecasters/data-files/files";

// Inflation variables' Median_*_Level.xlsx files store the annualized q/q
// rate forecast directly in columns {CODE}1..{CODE}6 — no derivation needed.
const RATE_VARS = ["CPI", "CORECPI", "PCE", "COREPCE"];
// RGDP's file stores forecasted price LEVELS (billions, chained $), not a
// growth rate — derived below via consecutive-quarter annualized q/q change,
// the standard BEA-style ((level_h / level_(h-1))^4 - 1) * 100 convention.
const LEVEL_VARS = ["RGDP"];
// Single-column long-run (10-year) expected-inflation series.
const LONGRUN_VARS = ["CPI10"];

type Row = { vintage_label: string; variable_code: string; horizon_quarters: number; value: number };

async function fetchSpfSheet(code: string): Promise<Record<string, unknown>[]> {
  const url = `${SPF_BASE}/Median_${code}_Level.xlsx`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" } });
  if (!res.ok) throw new Error(`SPF ${code}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
}

function num(v: unknown): number | null {
  if (v == null || v === "#N/A") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const rows: Row[] = [];
    const errors: string[] = [];

    for (const code of RATE_VARS) {
      try {
        const data = await fetchSpfSheet(code);
        const last = data[data.length - 1];
        if (!last) continue;
        const year = num(last.YEAR), quarter = num(last.QUARTER);
        if (year == null || quarter == null) continue;
        const vintage_label = `${year}-Q${quarter}`;
        for (let h = 1; h <= 6; h++) {
          const v = num(last[`${code}${h}`]);
          if (v == null) continue;
          rows.push({ vintage_label, variable_code: code, horizon_quarters: h, value: r2(v) });
        }
      } catch (e) { errors.push(`${code}: ${e instanceof Error ? e.message : String(e)}`); }
    }

    for (const code of LONGRUN_VARS) {
      try {
        const data = await fetchSpfSheet(code);
        const last = data[data.length - 1];
        if (!last) continue;
        const year = num(last.YEAR), quarter = num(last.QUARTER);
        const v = num(last[code]);
        if (year == null || quarter == null || v == null) continue;
        rows.push({ vintage_label: `${year}-Q${quarter}`, variable_code: code, horizon_quarters: 0, value: r2(v) });
      } catch (e) { errors.push(`${code}: ${e instanceof Error ? e.message : String(e)}`); }
    }

    for (const code of LEVEL_VARS) {
      try {
        const data = await fetchSpfSheet(code);
        const last = data[data.length - 1];
        if (!last) continue;
        const year = num(last.YEAR), quarter = num(last.QUARTER);
        if (year == null || quarter == null) continue;
        const vintage_label = `${year}-Q${quarter}`;
        const levels: (number | null)[] = [];
        for (let h = 1; h <= 6; h++) levels.push(num(last[`${code}${h}`]));
        // Growth INTO quarter h, from the level forecast at h-1 to h — so
        // horizon_quarters=2 is "the annualized growth rate forecast for 2
        // quarters from now," etc. No horizon_quarters=1 row: that would
        // need the already-realized base-quarter level, which this file
        // doesn't carry (see the plan's noted derivation caveat).
        for (let h = 2; h <= 6; h++) {
          const a = levels[h - 2], b = levels[h - 1];
          if (a == null || b == null || a <= 0) continue;
          const growth = (Math.pow(b / a, 4) - 1) * 100;
          rows.push({ vintage_label, variable_code: code, horizon_quarters: h, value: r2(growth) });
        }
      } catch (e) { errors.push(`${code}: ${e instanceof Error ? e.message : String(e)}`); }
    }

    if (rows.length) {
      const { error } = await supabase.from("spf_forecasts").upsert(rows, {
        onConflict: "vintage_label,variable_code,horizon_quarters",
      });
      if (error) throw new Error(`upsert failed: ${error.message}`);
    }

    // Stamp the nearest-available RGDP consensus onto "Real GDP Growth"'s
    // own metadata — horizon 1 ("this quarter") when present, else the
    // next-4Q average, since RGDP's derivation above has no horizon-1 row.
    // Used by the Forward Signal's "GDP vs SPF" growth-momentum signal and
    // the GDP drawer's Forward Consensus block. Fetch-then-merge, not a
    // blind upsert, so this doesn't clobber zscore_10y/reference_period,
    // which fetch-macro-data writes on the same row.
    const rgdpRows = rows.filter((r) => r.variable_code === "RGDP");
    if (rgdpRows.length) {
      const h1 = rgdpRows.find((r) => r.horizon_quarters === 1)?.value ?? null;
      const next4 = rgdpRows.filter((r) => r.horizon_quarters >= 2 && r.horizon_quarters <= 5).map((r) => r.value);
      const consensusVal = h1 ?? (next4.length ? r2(next4.reduce((a, b) => a + b, 0) / next4.length) : null);
      if (consensusVal != null) {
        const { data: gdpRow } = await supabase
          .from("macro_indicators")
          .select("metadata")
          .eq("name", "Real GDP Growth")
          .maybeSingle();
        if (gdpRow) {
          await supabase.from("macro_indicators").update({
            metadata: { ...(gdpRow.metadata ?? {}), spf_consensus_gdp: consensusVal, spf_consensus_vintage: rgdpRows[0].vintage_label },
          }).eq("name", "Real GDP Growth");
        }
      }
    }

    return new Response(
      JSON.stringify({ updated: rows.length, errors: errors.length ? errors : undefined }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[update-spf-forecasts]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
