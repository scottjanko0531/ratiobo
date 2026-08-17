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
// pressure) would need to absorb. Free, public, no auth. Rolling 13-month
// window per fetch — re-fetched and upserted (idempotent) every run.
const SOURCE_URL = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const res = await fetch(SOURCE_URL);
    if (!res.ok) return json({ error: `TIC fetch: HTTP ${res.status}` }, 500);
    const text = await res.text();
    const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));

    const headerLine = lines.find((l) => l.startsWith("Country\t"));
    if (!headerLine) return json({ error: "header row not found" }, 500);
    const months = headerLine.split("\t").slice(1).map((m) => m.trim()).filter(Boolean);

    const findRow = (label: string) => {
      const l = lines.find((l) => l.trim().startsWith(label));
      return l ? l.split("\t").slice(1).map((v) => v.trim()) : null;
    };

    const totalRow = findRow("Grand Total");
    // Line order in the source file is Official, then Bills, then Bonds — since
    // "Of Which: Foreign Official" is a literal string prefix of the other two
    // labels too, findRow's first-match semantics still land on the right row
    // because it appears first in the file.
    const officialRow = findRow("Of Which: Foreign Official");
    const billsRow = findRow("Of Which: Foreign Official Treasury Bills");
    const bondsRow = findRow("Of Which: Foreign Official T-Bonds");

    if (!totalRow || !officialRow) return json({ error: "data rows not found", found: { totalRow: !!totalRow, officialRow: !!officialRow } }, 500);

    const rows: Record<string, unknown>[] = [];
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
        updated_at: new Date().toISOString(),
      });
    }
    if (!rows.length) return json({ error: "no parseable monthly rows" }, 500);

    const { error: upErr } = await sb.from("tic_foreign_official_holdings").upsert(rows, { onConflict: "as_of_month" });
    if (upErr) return json({ error: upErr.message }, 500);

    return json({ monthsSynced: rows.length, latest: rows[0] });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
