#!/usr/bin/env node
// Bond Lens overlay -- one-time DTB3 backfill (bond-lens-decisions.md,
// 2026-10-02 follow-up #7, Phase E variant (d)).
//
// Why this is a standalone script run by hand, not an MCP/edge-function
// call: DTB3's full 1954-present history is ~18k rows, too large to push
// through the agent's own SQL tooling in one go, and this repo's security
// posture keeps the Supabase service-role key out of the assistant's
// hands entirely. Run locally with your own key instead.
//
// Idempotent: upserts on (series_id, obs_date) with merge-duplicates, so
// re-running this (e.g. after a partial failure) is always safe.
//
// Usage (Node 20.6+, for --env-file support):
//   node --env-file=.env.local scripts/backfill-dtb3.mjs
//
// Requires in .env.local (or the environment):
//   NEXT_PUBLIC_SUPABASE_URL          (already present)
//   SUPABASE_SERVICE_ROLE_KEY         (add this -- never printed by this script)

const FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3";
const CHUNK_SIZE = 1000;
const MAX_RETRIES = 3;

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set -- add it to .env.local or export it before running`);
  return v;
}

async function fetchDtb3Rows() {
  const res = await fetch(FRED_CSV_URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ratiobo-bond-lens-backfill/1.0)" } });
  if (!res.ok) throw new Error(`FRED fetch failed: HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",");
  if (header[0] !== "DATE" || header[1] !== "DTB3") {
    throw new Error(`unexpected FRED CSV header: ${header.join(",")}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(",");
    if (!date || raw === undefined || raw === "." || raw === "") continue;
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    rows.push({ series_id: "DTB3", obs_date: date, value, source: "fred" });
  }
  return rows;
}

async function upsertChunk(supabaseUrl, serviceKey, chunk, attempt = 1) {
  const url = `${supabaseUrl}/rest/v1/bond_raw_series?on_conflict=series_id,obs_date`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(chunk),
  });
  if (res.ok) return;
  if (attempt < MAX_RETRIES) {
    const backoffMs = 500 * 2 ** (attempt - 1);
    await new Promise((r) => setTimeout(r, backoffMs));
    return upsertChunk(supabaseUrl, serviceKey, chunk, attempt + 1);
  }
  const text = await res.text();
  throw new Error(`upsert failed after ${MAX_RETRIES} attempts: HTTP ${res.status} ${text}`);
}

async function upsertRows(supabaseUrl, serviceKey, rows) {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await upsertChunk(supabaseUrl, serviceKey, chunk);
    console.log(`upserted rows ${i}-${i + chunk.length} of ${rows.length}`);
  }
}

async function logJobRun(supabaseUrl, serviceKey, startedAt, status, detail) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/bond_lens_job_runs`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_name: "bond-lens-dtb3-backfill",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status,
        detail,
      }),
    });
  } catch (e) {
    console.warn(`warning: failed to log job run: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL ?? env("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const startedAt = new Date().toISOString();

  try {
    const rows = await fetchDtb3Rows();
    if (rows.length === 0) throw new Error("FRED returned zero usable DTB3 rows");
    await upsertRows(supabaseUrl, serviceKey, rows);
    const detail = { totalRows: rows.length, from: rows[0].obs_date, to: rows[rows.length - 1].obs_date };
    await logJobRun(supabaseUrl, serviceKey, startedAt, "ok", detail);
    console.log(`DTB3 backfill ok: ${JSON.stringify(detail)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logJobRun(supabaseUrl, serviceKey, startedAt, "error", { error: message });
    console.error(`DTB3 backfill failed: ${message}`);
    process.exit(1);
  }
}

main();
