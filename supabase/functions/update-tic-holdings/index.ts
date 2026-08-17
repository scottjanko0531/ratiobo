import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Treasury TIC "Table 5: Major Foreign Holders of Treasury Securities" — a
// stock-level (not net-flow) split of foreign UST holdings into Foreign
// Official (central banks / reserve managers) vs. the private-sector residual
// (Grand Total minus Foreign Official). Distinct from Gauge 5's COFER data
// (USD share of *global FX reserves* broadly) — this tracks the official/
// private split specifically within US Treasury holdings, which is the more
// direct read on whether central banks are net sellers relative to private
// buyers, and by extension how much slack the Fed (QE) or banks (regulatory
// pressure) would need to absorb. Free, public, no auth.
//
// Two source files, both re-fetched and upserted (idempotent) every run:
//  - slt_table5.txt: rolling 13-month window, always current.
//  - mfhhis01.txt: year-block archive back to 2000, same Official/Private
//    split under the row label "For. Official" instead of "Of Which: Foreign
//    Official". Without this, YoY change and the z-score table would only
//    ever have ~1 usable row (needs 12 months of lookback) since the rolling
//    file alone never accumulates more than 13 months of true history.
const RECENT_URL = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt";
const HISTORY_URL = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/mfhhis01.txt";

const MONTH_NUM: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

type Row = {
  as_of_month: string;
  grand_total_bn: number;
  foreign_official_bn: number;
  foreign_official_bills_bn: number | null;
  foreign_official_bonds_notes_bn: number | null;
  updated_at: string;
};

function parseRecent(text: string): Row[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const headerLine = lines.find((l) => l.startsWith("Country\t"));
  if (!headerLine) return [];
  const months = headerLine.split("\t").slice(1).map((m) => m.trim()).filter(Boolean);

  const findRow = (label: string) => {
    const l = lines.find((l) => l.trim().startsWith(label));
    return l ? l.split("\t").slice(1).map((v) => v.trim()) : null;
  };

  const totalRow = findRow("Grand Total");
  // "Of Which: Foreign Official" is a literal string prefix of the Bills/Bonds
  // labels too, but it appears first in the file, so find()'s first-match
  // semantics still land on the right row.
  const officialRow = findRow("Of Which: Foreign Official");
  const billsRow = findRow("Of Which: Foreign Official Treasury Bills");
  const bondsRow = findRow("Of Which: Foreign Official T-Bonds");
  if (!totalRow || !officialRow) return [];

  const rows: Row[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < months.length; i++) {
    const total = Number(totalRow[i]);
    const official = Number(officialRow[i]);
    if (!Number.isFinite(total) || !Number.isFinite(official)) continue;
    rows.push({
      as_of_month: `${months[i]}-01`,
      grand_total_bn: total,
      foreign_official_bn: official,
      foreign_official_bills_bn: billsRow && Number.isFinite(Number(billsRow[i])) ? Number(billsRow[i]) : null,
      foreign_official_bonds_notes_bn: bondsRow && Number.isFinite(Number(bondsRow[i])) ? Number(bondsRow[i]) : null,
      updated_at: now,
    });
  }
  return rows;
}

function parseHistory(text: string): Row[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const rows: Row[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("Country\t")) continue;
    const yearCols = lines[i].split("\t").slice(1).map((v) => v.trim()).filter(Boolean);
    const year = yearCols[0];
    if (!year || !/^\d{4}$/.test(year)) continue;

    // The month-order row (e.g. "Dec Nov Oct ... Jan") sits immediately above
    // each year block's "Country" row.
    const monthLine = i > 0 ? lines[i - 1] : "";
    const months = monthLine.split("\t").slice(1).map((v) => v.trim()).filter(Boolean);

    let blockEnd = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith("Country\t")) { blockEnd = j; break; }
    }
    const block = lines.slice(i, blockEnd);
    const totalLine = block.find((l) => l.trim().startsWith("Grand Total"));
    const officialLine = block.find((l) => l.trim().startsWith("For. Official"));
    if (!totalLine || !officialLine) continue;
    const totalVals = totalLine.split("\t").slice(1).map((v) => v.trim());
    const officialVals = officialLine.split("\t").slice(1).map((v) => v.trim());

    for (let k = 0; k < months.length && k < 12; k++) {
      const mm = MONTH_NUM[months[k]];
      if (!mm) continue;
      const total = Number(totalVals[k]);
      const official = Number(officialVals[k]);
      if (!Number.isFinite(total) || !Number.isFinite(official)) continue;
      rows.push({
        as_of_month: `${year}-${mm}-01`,
        grand_total_bn: total,
        foreign_official_bn: official,
        foreign_official_bills_bn: null,
        foreign_official_bonds_notes_bn: null,
        updated_at: now,
      });
    }
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const [recentRes, historyRes] = await Promise.all([fetch(RECENT_URL), fetch(HISTORY_URL)]);
    if (!recentRes.ok) return json({ error: `TIC recent fetch: HTTP ${recentRes.status}` }, 500);
    if (!historyRes.ok) return json({ error: `TIC history fetch: HTTP ${historyRes.status}` }, 500);

    const historyRows = parseHistory(await historyRes.text());
    const recentRows = parseRecent(await recentRes.text());
    if (!historyRows.length && !recentRows.length) return json({ error: "no parseable rows from either source" }, 500);

    // History (2000–last complete year) and recent (rolling 13-month window)
    // overlap on several months — dedupe by as_of_month before upserting
    // (Postgres upsert errors if the same conflict key appears twice in one
    // statement), keeping recent's live figures for any overlap.
    const byMonth = new Map<string, Row>();
    for (const r of historyRows) byMonth.set(r.as_of_month, r);
    for (const r of recentRows) byMonth.set(r.as_of_month, r);
    const allRows = [...byMonth.values()];
    for (let i = 0; i < allRows.length; i += 500) {
      const { error: upErr } = await sb.from("tic_foreign_official_holdings").upsert(allRows.slice(i, i + 500), { onConflict: "as_of_month" });
      if (upErr) return json({ error: upErr.message }, 500);
    }

    return json({
      historyMonths: historyRows.length,
      recentMonths: recentRows.length,
      totalUpserted: allRows.length,
      latest: [...recentRows].sort((a, b) => b.as_of_month.localeCompare(a.as_of_month))[0] ?? null,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
