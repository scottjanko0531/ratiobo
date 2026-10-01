import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx";

// Bond Lens overlay (docs/specs/bond-lens.md v2.1) -- Phase A ingestion.
// Three source types, one function:
//   1. FRED (JSON API, FRED_API_KEY -- same env var fetch-macro-data uses).
//   2. NY Fed ACM term premium (daily .xls, same XLSX.read pattern already
//      proven in fetch-macro-data for the GPR website download).
//   3. NY Fed Holston-Laubach-Williams r-star (quarterly .xlsx).
// All write to bond_raw_series. Publication-lag handling (r-star's
// one-quarter lag) is a Phase B concern when the series is READ, not
// baked into storage here -- this just stores obs_date + fetched_at.
//
// Full backfill every run (idempotent upsert on (series_id, obs_date)),
// same "derived table, full rebuild avoids incremental bugs" choice
// already used elsewhere in this repo (ingest-liquidity-data,
// market-conditions-compute).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED_URL = "https://api.stlouisfed.org/fred/series/observations";
const fredApiKey = Deno.env.get("FRED_API_KEY")!;

// Spec 3.1. GDPNOW/PCEPILFE/CPIAUCSL/EXPINF1YR are monthly (or irregular,
// in GDPNOW's case -- it updates intra-quarter, FRED serves it as a daily
// series of quarterly-nowcast revisions); fetched with the same daily
// endpoint since FRED returns whatever native frequency the series has
// when no `frequency` param is passed, which is what we want here (we
// need every revision point, not a monthly average).
const FRED_SERIES: { id: string; label: string }[] = [
  { id: "DGS3MO", label: "3-month nominal Treasury yield" },
  { id: "DGS1", label: "1-year nominal Treasury yield" },
  { id: "DGS2", label: "2-year nominal Treasury yield" },
  { id: "DGS3", label: "3-year nominal Treasury yield" },
  { id: "DGS5", label: "5-year nominal Treasury yield" },
  { id: "DGS7", label: "7-year nominal Treasury yield" },
  { id: "DGS10", label: "10-year nominal Treasury yield" },
  { id: "DGS30", label: "30-year nominal Treasury yield" },
  { id: "DFII5", label: "5-year TIPS real yield" },
  { id: "DFII10", label: "10-year TIPS real yield" },
  { id: "T5YIE", label: "5-year breakeven inflation" },
  { id: "T10YIE", label: "10-year breakeven inflation" },
  { id: "T5YIFR", label: "5y5y forward breakeven inflation" },
  { id: "DFF", label: "Effective federal funds rate" },
  { id: "SOFR", label: "Secured Overnight Financing Rate" },
  { id: "THREEFYTP10", label: "Kim-Wright 10y term premium (ACM fallback)" },
  { id: "GDPNOW", label: "Atlanta Fed GDPNow nowcast" },
  { id: "PCEPILFE", label: "Core PCE price index" },
  { id: "CPIAUCSL", label: "CPI, all urban consumers" },
  { id: "EXPINF1YR", label: "Cleveland Fed 1-year expected inflation" },
];

type RawRow = { series_id: string; obs_date: string; value: number; source: string; target_quarter?: string };

// GDPNow's CurrentQtrEvolution rows interleave across column-blocks in
// push order (see fetchAtlFedGdpNow), so the array's first/last element
// isn't reliably the earliest/latest obs_date -- compute it properly
// for the job-run summary rather than trust insertion order.
function dateRange(rows: RawRow[]): { from?: string; to?: string } {
  if (rows.length === 0) return {};
  let from = rows[0].obs_date, to = rows[0].obs_date;
  for (const r of rows) {
    if (r.obs_date < from) from = r.obs_date;
    if (r.obs_date > to) to = r.obs_date;
  }
  return { from, to };
}

// Excel serial date -> "YYYYQN", using the date's month to pick the
// calendar quarter (Jan/Apr/Jul/Oct starts). Used for GDPNow's
// "Quarter being forecasted" column, which is always the 1st of a
// quarter, so this is exact, not an approximation.
function serialToQuarter(serial: number): string {
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${y}Q${q}`;
}

async function fetchFredSeries(seriesId: string): Promise<{ rows: RawRow[]; error?: string }> {
  // 100000 is FRED's documented max per-request limit -- every series
  // listed above has far fewer observations than that even at daily
  // frequency since 1962, so one request covers full history.
  const url = `${FRED_URL}?series_id=${seriesId}&api_key=${fredApiKey}&sort_order=asc&limit=100000&file_type=json`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    return { rows: [], error: `${seriesId}: fetch error -- ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { rows: [], error: `${seriesId}: HTTP ${res.status}` };
  const j = await res.json();
  if (j.error_message) return { rows: [], error: `${seriesId}: ${j.error_message}` };
  const obs = (j.observations ?? []) as { date: string; value: string }[];
  const rows = obs
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ series_id: seriesId, obs_date: o.date, value: parseFloat(o.value), source: "fred" }))
    .filter((r) => Number.isFinite(r.value));
  return { rows };
}

// DD-MMM-YYYY (NY Fed's ACM date format) -> YYYY-MM-DD.
function parseAcmDate(s: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m) return null;
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const mon = months[m[2]];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

async function fetchAcmTermPremium(): Promise<{ rows: RawRow[]; error?: string }> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch("https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ratiobo-bond-lens/1.0)" },
      signal: ctrl.signal,
    });
  } catch (e) {
    return { rows: [], error: `ACM term premium: fetch error -- ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) return { rows: [], error: `ACM term premium: HTTP ${res.status}` };
  const buf = await res.arrayBuffer();
  // `sheets` restricts XLSX.read to fully parsing only "ACM Daily" --
  // "ACM Monthly" (unused) is left as an unparsed stub. This is what
  // pushed the single-source invocation over WORKER_RESOURCE_LIMIT.
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", sheets: ["ACM Daily"], dense: true });
  const ws = wb.Sheets["ACM Daily"];
  if (!ws) return { rows: [], error: `ACM term premium: "ACM Daily" sheet not found (sheets: ${wb.SheetNames.join(", ")})` };
  const data = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  const header = data[0] as string[];
  const dateIdx = header.indexOf("DATE");
  const tp10Idx = header.indexOf("ACMTP10");
  if (dateIdx < 0 || tp10Idx < 0) {
    return { rows: [], error: `ACM term premium: expected columns DATE/ACMTP10 not found (got: ${header.join(", ")})` };
  }
  const rows: RawRow[] = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i] as unknown[];
    const rawDate = row[dateIdx];
    const rawVal = row[tp10Idx];
    if (typeof rawDate !== "string" || typeof rawVal !== "number") continue;
    const obsDate = parseAcmDate(rawDate);
    if (!obsDate) continue;
    rows.push({ series_id: "ACMTP10", obs_date: obsDate, value: rawVal, source: "nyfed_acm" });
  }
  return { rows };
}

// Excel serial date (1899-12-30 epoch) -> YYYY-MM-DD.
function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000); // 25569 = days between 1899-12-30 and 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchHlwRstar(): Promise<{ rows: RawRow[]; error?: string }> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(
      "https://www.newyorkfed.org/medialibrary/media/research/economists/williams/data/Holston_Laubach_Williams_current_estimates.xlsx",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; ratiobo-bond-lens/1.0)" }, signal: ctrl.signal },
    );
  } catch (e) {
    return { rows: [], error: `HLW r-star: fetch error -- ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) return { rows: [], error: `HLW r-star: HTTP ${res.status}` };
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const ws = wb.Sheets["HLW Estimates"];
  if (!ws) return { rows: [], error: `HLW r-star: "HLW Estimates" sheet not found (sheets: ${wb.SheetNames.join(", ")})` };
  const data = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  // Header row is index 5 ("Date", ..., "Natural Rate (r*)" group starting
  // at column 10 with US/Canada/Euro Area sub-columns); verified by hand
  // against the live file 2026-10-01 -- if NY Fed ever reshuffles columns
  // this will fail the column-name check below rather than silently
  // reading the wrong series.
  const header = (data[5] ?? []) as unknown[];
  if (header[0] !== "Date" || header[10] !== "US") {
    return { rows: [], error: `HLW r-star: expected header layout changed (row 5: ${JSON.stringify(header)})` };
  }
  const rows: RawRow[] = [];
  for (let i = 6; i < data.length; i++) {
    const row = data[i] as unknown[];
    const rawDate = row[0];
    const rawVal = row[10];
    if (typeof rawDate !== "number" || typeof rawVal !== "number") continue;
    rows.push({ series_id: "RSTAR_HLW_US", obs_date: excelSerialToDate(rawDate), value: rawVal, source: "nyfed_hlw" });
  }
  return { rows };
}

// FRED's GDPNOW series is quarterly-snapshot only (~61 rows) -- the
// Atlanta Fed's own file carries the full intraquarter nowcast revision
// history spec 4.2 needs ("8-week change in GDPNOW"). Unlike ACM's
// legacy .xls, this is modern OOXML (.xlsx) -- zip of per-sheet XML --
// so `sheets` genuinely limits what gets decoded (confirmed locally:
// ~23MB for both sheets below vs. ~363MB decoding ACM's single .xls
// sheet), keeping this well inside the edge function's budget despite
// the file being ~11MB on disk (50+ sheets total; only two are read).
// TrackingDeepArchives covers 2011:Q3-2014:Q1 (pre-live-model), handed
// off to TrackingArchives for 2014:Q2 onward -- both have a "Forecast
// Date"/"GDP Nowcast" column pair at the same position, looked up by
// header name (not hardcoded index) since this file is Atlanta Fed's
// own working model export, not a stable published interface.
async function fetchAtlFedGdpNow(): Promise<{ rows: RawRow[]; error?: string }> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(
      "https://www.atlantafed.org/-/media/Project/Atlanta/FRBA/Documents/research-and-data/data/gdpnow/GDPTrackingModelDataAndForecasts.xlsx",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; ratiobo-bond-lens/1.0)" }, signal: ctrl.signal },
    );
  } catch (e) {
    return { rows: [], error: `Atlanta Fed GDPNow: fetch error -- ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) return { rows: [], error: `Atlanta Fed GDPNow: HTTP ${res.status}` };
  const buf = await res.arrayBuffer();
  const archiveSheets = ["TrackingDeepArchives", "TrackingArchives"];
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", sheets: [...archiveSheets, "CurrentQtrEvolution"], dense: true });
  const rows: RawRow[] = [];

  for (const sheetName of archiveSheets) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return { rows: [], error: `Atlanta Fed GDPNow: "${sheetName}" sheet not found (sheets: ${wb.SheetNames.join(", ")})` };
    const data = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
    const header = data[0] as string[];
    const dateIdx = header.indexOf("Forecast Date");
    const valIdx = header.indexOf("GDP Nowcast");
    const qtrIdx = header.indexOf("Quarter being forecasted");
    if (dateIdx < 0 || valIdx < 0) {
      return { rows: [], error: `Atlanta Fed GDPNow: expected columns "Forecast Date"/"GDP Nowcast" not found in ${sheetName} (got: ${header.join(", ")})` };
    }
    for (let i = 1; i < data.length; i++) {
      const row = data[i] as unknown[];
      const rawDate = row[dateIdx];
      const rawVal = row[valIdx];
      if (typeof rawDate !== "number" || typeof rawVal !== "number") continue;
      const rawQtr = qtrIdx >= 0 ? row[qtrIdx] : null;
      rows.push({
        series_id: "GDPNOW_ATL_NOWCAST",
        obs_date: excelSerialToDate(rawDate),
        value: rawVal,
        source: "atlantafed_gdpnow",
        target_quarter: typeof rawQtr === "number" ? serialToQuarter(rawQtr) : undefined,
      });
    }
  }

  // CurrentQtrEvolution tracks the live, still-open quarter -- the one
  // TrackingArchives doesn't have yet (it only gets a quarter's block
  // once that quarter's BEA advance estimate ships and the sequence is
  // closed out). Laid out as repeating (Date, Major Releases, GDP*)
  // column triples that WRAP into a new triple every ~12-13 rows rather
  // than growing one column indefinitely -- confirmed by hand against
  // the live file 2026-10-01 (block 1: Jul 30-Aug 25, block 2: Aug 26-
  // Sep 25, block 3: Sep 30-Oct 1, all one continuous Q3 2026 sequence).
  // Detect however many triples exist generically rather than assuming 3.
  const curWs = wb.Sheets["CurrentQtrEvolution"];
  if (!curWs) return { rows: [], error: `Atlanta Fed GDPNow: "CurrentQtrEvolution" sheet not found (sheets: ${wb.SheetNames.join(", ")})` };
  const curData = XLSX.utils.sheet_to_json<unknown[]>(curWs, { header: 1, defval: null });
  const curHeader = (curData[0] ?? []) as unknown[];
  const blockCols: number[] = [];
  for (let c = 0; c < curHeader.length; c += 3) {
    if (curHeader[c] === "Date" && curHeader[c + 2] === "GDP*") blockCols.push(c);
  }
  if (blockCols.length === 0) {
    return { rows: [], error: `Atlanta Fed GDPNow: no (Date, Major Releases, GDP*) triples found in CurrentQtrEvolution header` };
  }
  // The live quarter's own label ("Initial GDPNow 26:Q3 forecast") only
  // appears once, on the first row of block 1 -- every row in every
  // block of this sheet is that same quarter, so find it once and apply
  // to all. Null (not inferred) if the label text ever changes shape --
  // Phase B treats a missing target_quarter as "can't do a within-
  // quarter comparison," not as a wrong guess.
  let currentTargetQuarter: string | undefined;
  for (const row of curData) {
    for (const col of blockCols) {
      const label = (row as unknown[])[col + 1];
      const m = typeof label === "string" ? /Initial GDPNow (\d{2}):Q(\d)/.exec(label) : null;
      if (m) { currentTargetQuarter = `20${m[1]}Q${m[2]}`; break; }
    }
    if (currentTargetQuarter) break;
  }
  for (let i = 1; i < curData.length; i++) {
    const row = curData[i] as unknown[];
    for (const col of blockCols) {
      const rawDate = row[col];
      const rawVal = row[col + 2];
      if (typeof rawDate !== "number" || typeof rawVal !== "number") continue;
      rows.push({
        series_id: "GDPNOW_ATL_NOWCAST",
        obs_date: excelSerialToDate(rawDate),
        value: rawVal,
        source: "atlantafed_gdpnow",
        target_quarter: currentTargetQuarter,
      });
    }
  }
  return { rows };
}

// Running all three source types (20 FRED series in parallel + a ~10MB
// ACM XLS parse + an HLW XLSX parse) in one invocation hit
// WORKER_RESOURCE_LIMIT -- same class of issue as market-conditions-
// crossmarket and market-conditions-sensitivity, just from cumulative
// work rather than variants. ?source=fred|acm|rstar restricts a single
// invocation to one source, called up to three times from the scheduler
// instead. FRED itself also batches (not all 20 at once) for the same
// reason.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = new Date().toISOString();
  const url = new URL(req.url);
  const source = url.searchParams.get("source") ?? "all";
  if (!["fred", "acm", "rstar", "gdpnow", "all"].includes(source)) {
    return new Response(JSON.stringify({ error: `unknown source ${source}, expected fred|acm|rstar|gdpnow|all` }), { status: 400, headers: CORS });
  }

  const results: Record<string, unknown> = {};
  const gaps: string[] = [];
  let totalRows = 0;

  try {
    if (!fredApiKey) throw new Error("FRED_API_KEY not set");

    if (source === "fred" || source === "all") {
      const FRED_BATCH = 5;
      for (let i = 0; i < FRED_SERIES.length; i += FRED_BATCH) {
        const batch = FRED_SERIES.slice(i, i + FRED_BATCH);
        const batchResults = await Promise.all(batch.map((s) => fetchFredSeries(s.id)));
        for (let j = 0; j < batch.length; j++) {
          const s = batch[j];
          const { rows, error } = batchResults[j];
          if (error) { gaps.push(error); results[s.id] = { ok: false, error }; continue; }
          results[s.id] = { ok: true, rowCount: rows.length, ...dateRange(rows) };
          totalRows += rows.length;
          await upsertRows(supabase, rows);
        }
      }
    }

    if (source === "acm" || source === "all") {
      const acm = await fetchAcmTermPremium();
      if (acm.error) { gaps.push(acm.error); results["ACMTP10"] = { ok: false, error: acm.error }; }
      else {
        results["ACMTP10"] = { ok: true, rowCount: acm.rows.length, ...dateRange(acm.rows) };
        totalRows += acm.rows.length;
        await upsertRows(supabase, acm.rows);
      }
    }

    if (source === "rstar" || source === "all") {
      const rstar = await fetchHlwRstar();
      if (rstar.error) { gaps.push(rstar.error); results["RSTAR_HLW_US"] = { ok: false, error: rstar.error }; }
      else {
        results["RSTAR_HLW_US"] = { ok: true, rowCount: rstar.rows.length, ...dateRange(rstar.rows) };
        totalRows += rstar.rows.length;
        await upsertRows(supabase, rstar.rows);
      }
    }

    if (source === "gdpnow" || source === "all") {
      const gdpnow = await fetchAtlFedGdpNow();
      if (gdpnow.error) { gaps.push(gdpnow.error); results["GDPNOW_ATL_NOWCAST"] = { ok: false, error: gdpnow.error }; }
      else {
        results["GDPNOW_ATL_NOWCAST"] = { ok: true, rowCount: gdpnow.rows.length, ...dateRange(gdpnow.rows) };
        totalRows += gdpnow.rows.length;
        await upsertRows(supabase, gdpnow.rows);
      }
    }

    await supabase.from("bond_lens_job_runs").insert({
      job_name: `bond-lens-ingest:${source}`, started_at: startedAt, finished_at: new Date().toISOString(),
      status: gaps.length === 0 ? "ok" : "partial", detail: { totalRows, gaps, results },
    });

    return new Response(JSON.stringify({ source, totalRows, gaps, results }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    await supabase.from("bond_lens_job_runs").insert({
      job_name: `bond-lens-ingest:${source}`, started_at: startedAt, finished_at: new Date().toISOString(),
      status: "error", detail: { error: String(e), totalRows, gaps, results },
    });
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

async function upsertRows(supabase: ReturnType<typeof createClient>, rows: RawRow[]) {
  const chunkSize = 1000;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("bond_raw_series").upsert(chunk, { onConflict: "series_id,obs_date" });
    if (error) throw new Error(`bond_raw_series upsert: ${error.message}`);
  }
}
