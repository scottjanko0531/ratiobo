import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRED_KEY     = Deno.env.get("FRED_API_KEY")!;

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

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

// Parse the CB LEI page text for the leading sentence with level + mom_pct
function parseLeiText(text: string): { monthStr: string; level: number; mom_pct: number } | null {
  const m = text.match(
    /LEI\)?(?:®)?\s+for\s+(?:the\s+)?U\.?S\.?\s+(increased|declined|fell|rose|was unchanged|unchanged|inched up|inched down|ticked up|ticked down|edged up|edged down|remained flat)(?:\s+(?:slightly|sharply|marginally|briefly|for the \w+ consecutive \w+))*(?:\s+by\s+([\d.]+)\s*(?:%|percent))?\s+in\s+([A-Za-z]+(?:\s+\d{4})?)\s+to\s+([\d.]+)/i
  );
  if (!m) return null;

  const direction = m[1].toLowerCase();
  const pctMag    = parseFloat(m[2] ?? "0");
  const mom_pct   =
    direction.includes("declin") || direction === "fell" || direction.includes("down")
      ? -pctMag
      : direction.includes("increas") || direction === "rose" || direction.includes("up")
      ? pctMag
      : 0;
  const level = parseFloat(m[4]);
  if (isNaN(level)) return null;
  return { monthStr: m[3].trim(), level, mom_pct };
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
  const parsed = parseLeiText(text);
  if (!parsed) throw new Error("Could not parse LEI sentence from CB page");

  const { monthStr, level, mom_pct } = parsed;

  // monthStr should include year for current page (e.g. "June 2026")
  const periodDate  = new Date(`${monthStr} 1`);
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
    level: null as number | null,
    mom_pct: o.value,
    published_at: null as string | null,
    scraped_at: now,
  }));

  await upsertRows(rows);
  return rows.length;
}

// Backfill 2022-present from Wayback Machine snapshots of the CB LEI page.
// Each snapshot is fetched, parsed with the same regex as scrapeLatest(), and upserted.
// Covers the gap that FRED USSLIND (ended Feb 2020) and the daily scraper cannot fill.
async function backfillFromWayback(): Promise<{ count: number; months: string[]; skipped: number; errors: string[] }> {
  const now = new Date().toISOString();
  const upserted: string[] = [];
  const errors: string[] = [];
  let skipped = 0;

  // Step 1: Get all CDX snapshot timestamps for the CB LEI page from 2022-01 to present
  const cdxUrl =
    "https://web.archive.org/cdx/search/cdx?url=conference-board.org/topics/us-leading-indicators/&matchType=exact&output=text&from=20220101&to=20260601&fl=timestamp&limit=600";
  const cdxRes = await fetch(cdxUrl, { signal: AbortSignal.timeout(25000) });
  if (!cdxRes.ok) throw new Error(`CDX API: ${cdxRes.status}`);
  const tsLines = (await cdxRes.text()).trim().split("\n").filter(t => /^\d{14}$/.test(t.trim())).map(t => t.trim());

  if (tsLines.length === 0) throw new Error("No CDX timestamps returned");

  // Step 2: Collapse to one snapshot per calendar month (take the last = most up-to-date)
  const byYM = new Map<string, string>();
  for (const ts of tsLines) {
    byYM.set(ts.slice(0, 6), ts); // last writer wins since tsLines are ascending
  }
  const selectedSnapshots = [...byYM.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, ts]) => ({ ym, ts }));

  // Step 3: For each snapshot, fetch the archived CB page and parse the LEI reading
  const seen = new Set<string>();

  async function parseSnapshot(ts: string, ym: string): Promise<void> {
    const snapYear     = parseInt(ym.slice(0, 4));
    const snapMonthIdx = parseInt(ym.slice(4, 6)) - 1; // 0-indexed

    try {
      const res = await fetch(
        `https://web.archive.org/web/${ts}/https://www.conference-board.org/topics/us-leading-indicators/`,
        {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" },
          signal: AbortSignal.timeout(20000),
        }
      );
      if (!res.ok) { skipped++; return; }

      const html = await res.text();
      const text = stripHtml(html);
      const parsed = parseLeiText(text);
      if (!parsed) { skipped++; return; }

      let { monthStr, level, mom_pct } = parsed;

      // Parse the date — modern pages include the year ("June 2026"), older ones don't ("December")
      let year: number;
      const yearMatch = monthStr.match(/(\d{4})$/);
      if (yearMatch) {
        year = parseInt(yearMatch[1]);
        monthStr = monthStr.slice(0, -5).trim();
      } else {
        // Infer year: CB releases month M data in 3rd week of M+1, so snapshot from month S
        // typically shows data from month S-1. If data month index > snap month index + 3, it
        // wrapped around the year boundary.
        const dataMonthIdx = MONTHS.indexOf(monthStr.toLowerCase());
        if (dataMonthIdx === -1) { skipped++; return; }
        year = dataMonthIdx > snapMonthIdx + 3 ? snapYear - 1 : snapYear;
        monthStr = MONTHS[dataMonthIdx];
      }

      const dataMonthIdx = MONTHS.indexOf(monthStr.toLowerCase());
      if (dataMonthIdx === -1) { skipped++; return; }

      const period_date = `${year}-${String(dataMonthIdx + 1).padStart(2, "0")}-01`;

      // Only keep months in the target backfill range
      if (period_date < "2020-03-01" || period_date > "2026-05-01") return;
      if (seen.has(period_date)) return;
      seen.add(period_date);

      await upsertRows([{ period_date, level, mom_pct, published_at: null, scraped_at: now }]);
      upserted.push(period_date);
    } catch (e) {
      errors.push(`${ts}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Process in batches of 4 with a short pause between batches
  const BATCH = 4;
  for (let i = 0; i < selectedSnapshots.length; i += BATCH) {
    const batch = selectedSnapshots.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(({ ts, ym }) => parseSnapshot(ts, ym)));
    if (i + BATCH < selectedSnapshots.length) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  return { count: upserted.length, months: upserted.sort(), skipped, errors };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const backfill = url.searchParams.get("backfill");

  try {
    if (backfill === "true" || backfill === "fred") {
      // Legacy FRED backfill (through Feb 2020)
      const count = await backfillFromFred();
      return new Response(
        JSON.stringify({ source: "fred", backfilled: count }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    if (backfill === "wayback") {
      // Wayback Machine backfill for 2022-02 → 2026-05 gap
      const result = await backfillFromWayback();
      return new Response(
        JSON.stringify({ source: "wayback", ...result }),
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
