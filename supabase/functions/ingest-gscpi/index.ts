import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx";
import { parseGscpiSheetRows } from "../_shared/gscpiParser.ts";
import { assertGscpiFeedFresh, GscpiFeedStaleError } from "../_shared/gscpiFreshness.ts";

// Growth & Inflation Indicator Gaps spec, Phase 2b. NY Fed's GSCPI file is
// a stable, no-auth download (confirmed reachable from this runtime in
// Phase 0, unlike FRED's host). It's served at the .xlsx extension but is
// actually a legacy OLE2/BIFF binary -- the `xlsx` npm package (already
// used elsewhere in this codebase for the NY Fed Household Debt Report,
// see update-big-cycle-metrics) parses it fine either way. Sheet name is
// "GSCPI Monthly Data", two columns (Date, GSCPI).
//
// fetch-macro-data's `supabase_gscpi` indicator type reads the latest two
// rows from gscpi_history written here -- it does not re-fetch the NY Fed
// file itself. This is the one ingest path.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GSCPI_URL = "https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx";
const STALENESS_MAX_DAYS = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function logJobRun(
  sb: ReturnType<typeof createClient>,
  status: "ok" | "error",
  detail: Record<string, unknown>,
  startedAt: string,
) {
  await sb.from("rb_job_runs").insert({
    job_name: "ingest-gscpi",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    detail,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const startedAt = new Date().toISOString();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const res = await fetch(GSCPI_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching GSCPI file`);

    const buf = await res.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
    const ws = wb.Sheets["GSCPI Monthly Data"];
    if (!ws) throw new Error('sheet "GSCPI Monthly Data" not found in NY Fed file');

    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
    const points = parseGscpiSheetRows(rawRows);
    if (!points.length) throw new Error("no GSCPI rows parsed from NY Fed file");

    const newest = points[points.length - 1];
    assertGscpiFeedFresh(newest.date, new Date(), STALENESS_MAX_DAYS);

    const rows = points.map((p) => ({ period_date: p.date, value: Math.round(p.value * 1000) / 1000 }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("gscpi_history").upsert(rows.slice(i, i + 500), { onConflict: "period_date" });
      if (error) throw new Error(`gscpi_history upsert failed: ${error.message}`);
    }

    await logJobRun(sb, "ok", { rowsUpserted: rows.length, newestDate: newest.date, newestValue: newest.value }, startedAt);
    return json({ rowsUpserted: rows.length, newest });
  } catch (e) {
    const detail = e instanceof GscpiFeedStaleError
      ? { error: e.message, newestDate: e.newestDate, ageDays: e.ageDays, maxDays: e.maxDays }
      : { error: e instanceof Error ? e.message : String(e) };
    await logJobRun(sb, "error", detail, startedAt);
    console.error("[ingest-gscpi]", detail.error);
    return json({ error: detail.error }, 500);
  }
});
