import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

const LISTING_URL = "https://www.prnewswire.com/news/institute-for-supply-management/";
// e.g. /news-releases/manufacturing-pmi-at-55-6-july-2026-ism-manufacturing-pmi-report-302840669.html
// The PMI value itself is embedded in the slug ("55-6" -> 55.6, "54" -> 54) — reliable and doesn't
// require parsing the article body, which uses inconsistent sentence phrasing month to month.
const RELEASE_LINK_RE = /\/news-releases\/manufacturing-pmi-at-([\d-]+)-([a-z]+)-(\d{4})-ism-manufacturing-pmi-report-\d+\.html/gi;

function valueFromSlug(slug: string): number | null {
  const s = slug.includes("-") ? slug.replace("-", ".") : slug;
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&reg;|&#174;/g, "®")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s{2,}/g, " ");
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function upsertRows(rows: {
  period_date: string;
  pmi: number;
  new_orders: number | null;
  published_at: string | null;
  scraped_at: string;
}[]): Promise<void> {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ism_history`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
}

// Best-effort extras from the article body — New Orders sub-index and publish date.
// The headline PMI itself comes from the URL slug (see findReleaseLinks), not from here,
// since the body's sentence phrasing ("registered" vs "reading of" vs parenthetical) varies
// month to month and isn't worth chasing for a value we already have reliably.
function parseReportExtras(text: string): { newOrders: number | null; publishedAt: string | null } {
  let newOrders: number | null = null;
  const anchorIdx = text.search(/MANUFACTURING INDEX SUMMARIES/i);
  const noIdx = text.indexOf("New Orders Index", anchorIdx !== -1 ? anchorIdx : 0);
  if (noIdx !== -1) {
    const window = text.slice(noIdx, noIdx + 250);
    const noM = window.match(/([\d.]+)\s+percent/i);
    if (noM) newOrders = parseFloat(noM[1]);
  }

  // Dateline sits right before the "/PRNewswire/" wire marker, e.g. "Aug. 3, 2026 /PRNewswire/ --"
  let publishedAt: string | null = null;
  const dateM = text.match(/([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})\s*\/?PRNewswire/i);
  if (dateM) {
    const d = new Date(dateM[1].replace(".", ""));
    if (!isNaN(d.getTime())) {
      publishedAt = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  }

  return { newOrders, publishedAt };
}

function periodDateFromSlug(monthSlug: string, yearSlug: string): string | null {
  const idx = MONTHS.indexOf(monthSlug.toLowerCase());
  if (idx === -1) return null;
  return `${yearSlug}-${String(idx + 1).padStart(2, "0")}-01`;
}

// Find Manufacturing PMI report links on the ISM newsroom listing page, most recent first.
async function findReleaseLinks(): Promise<{ url: string; period_date: string; pmi: number }[]> {
  const html = await fetchText(LISTING_URL);
  const seen = new Set<string>();
  const out: { url: string; period_date: string; pmi: number }[] = [];
  for (const m of html.matchAll(RELEASE_LINK_RE)) {
    const pmi = valueFromSlug(m[1]);
    const period_date = periodDateFromSlug(m[2], m[3]);
    if (!period_date || pmi == null || seen.has(period_date)) continue;
    seen.add(period_date);
    out.push({ url: `https://www.prnewswire.com${m[0]}`, period_date, pmi });
  }
  return out.sort((a, b) => b.period_date.localeCompare(a.period_date));
}

async function scrapeOne(url: string, period_date: string, pmi: number, now: string) {
  let newOrders: number | null = null;
  let publishedAt: string | null = null;
  try {
    const html = await fetchText(url);
    const extras = parseReportExtras(stripHtml(html));
    newOrders = extras.newOrders;
    publishedAt = extras.publishedAt;
  } catch {
    // Non-fatal — the headline PMI (from the URL slug) is what matters most.
  }
  return { period_date, pmi, new_orders: newOrders, published_at: publishedAt, scraped_at: now };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const backfill = url.searchParams.get("backfill") === "true";

  try {
    const links = await findReleaseLinks();
    if (!links.length) throw new Error("No Manufacturing PMI release links found on listing page");

    const now = new Date().toISOString();
    const targets = backfill ? links : links.slice(0, 1);

    const rows = [];
    const errors: string[] = [];
    for (const { url: reportUrl, period_date, pmi } of targets) {
      try {
        rows.push(await scrapeOne(reportUrl, period_date, pmi, now));
      } catch (e) {
        errors.push(`${period_date}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!rows.length) throw new Error(`No reports parsed. Errors: ${errors.join("; ")}`);

    await upsertRows(rows);

    return new Response(
      JSON.stringify({ scraped: rows.length, periods: rows.map(r => r.period_date), errors: errors.length ? errors : undefined }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[scrape-ism]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
