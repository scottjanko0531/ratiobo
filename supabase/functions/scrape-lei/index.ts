import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRED_KEY     = Deno.env.get("FRED_API_KEY")!;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s{2,}/g, " ");
}

async function upsertRows(rows: {
  period_date: string;
  level: number | null;
  mom_pct: number;
  published_at: string | null;
  scraped_at: string;
}[]): Promise<void> {
  // Batch in chunks of 100
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/lei_history`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
    }
  }
}

// Scrape current reading from Conference Board website
async function scrapeLatest() {
  const cbRes = await fetch(
    "https://www.conference-board.org/topics/us-leading-indicators/",
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    }
  );
  if (!cbRes.ok) throw new Error(`CB page HTTP ${cbRes.status}`);

  const text = stripHtml(await cbRes.text());

  // Match: "LEI) for the US declined by 0.2% in June 2026 to 99.1"
  const m = text.match(
    /LEI\)\s+for\s+the\s+US\s+(increased|declined|was unchanged)(?:\s+by\s+([\d.]+)%)?\s+in\s+([A-Za-z]+\s+\d{4})\s+to\s+([\d.]+)/i
  );
  if (!m) throw new Error("Could not parse LEI sentence from CB page");

  const direction = m[1].toLowerCase();
  const pctMag    = parseFloat(m[2] ?? "0");
  const mom_pct   = direction === "declined" ? -pctMag : direction === "increased" ? pctMag : 0;
  const level     = parseFloat(m[4]);

  const periodDate  = new Date(`${m[3]} 1`);
  const period_date = `${periodDate.getFullYear()}-${String(periodDate.getMonth() + 1).padStart(2, "0")}-01`;

  const pubM = text.match(/Updated:\s+\w+,\s+([A-Za-z]+ \d+,?\s+\d{4})/i);
  let published_at: string | null = null;
  if (pubM) {
    const d = new Date(pubM[1]);
    if (!isNaN(d.getTime())) {
      published_at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  }

  return { period_date, level, mom_pct, published_at };
}

// Backfill historical data from FRED USSLIND (valid through Feb 2020)
// USSLIND stores the MoM % change of the LEI index directly (not the level)
async function backfillFromFred(): Promise<number> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=USSLIND&api_key=${FRED_KEY}&sort_order=asc&limit=2000&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED USSLIND: HTTP ${res.status}`);
  const j = await res.json();

  const obs: { date: string; value: number }[] = (j.observations as { date: string; value: string }[])
    .filter(o => o.value !== "." && o.value !== "" && !isNaN(parseFloat(o.value)))
    .map(o => ({ date: o.date, value: parseFloat(o.value) }));

  if (obs.length === 0) throw new Error("No USSLIND observations returned");

  const now = new Date().toISOString();
  const rows = obs.map(o => ({
    period_date: o.date,
    level: null as number | null,   // USSLIND is MoM % change, not the index level
    mom_pct: o.value,
    published_at: null as string | null,
    scraped_at: now,
  }));

  await upsertRows(rows);
  return rows.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const backfill = url.searchParams.get("backfill") === "true";

  try {
    if (backfill) {
      const count = await backfillFromFred();
      return new Response(
        JSON.stringify({ backfilled: count }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Normal daily scrape
    const row = await scrapeLatest();
    await upsertRows([{ ...row, scraped_at: new Date().toISOString() }]);

    return new Response(
      JSON.stringify({ ...row, scraped: true }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[scrape-lei]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
