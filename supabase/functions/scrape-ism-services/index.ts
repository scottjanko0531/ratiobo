import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Mirrors scrape-ism (Manufacturing) almost exactly — see that function for
// the general design rationale. Built for the forward-signal two-horizon
// spec's Near-Term panel ("ISM Services New Orders / Business Activity").

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

const LISTING_URL = "https://www.prnewswire.com/news/institute-for-supply-management/";
// e.g. /news-releases/services-pmi-at-54-1-july-2026-ism-services-pmi-report-302843134.html
// The headline PMI value itself is embedded in the slug ("54-1" -> 54.1) —
// reliable and doesn't require parsing the article body.
const RELEASE_LINK_RE = /\/news-releases\/services-pmi-at-([\d-]+)-([a-z]+)-(\d{4})-ism-services-pmi-report-\d+\.html/gi;

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
  business_activity: number | null;
  new_orders: number | null;
  published_at: string | null;
  scraped_at: string;
}[]): Promise<void> {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ism_services_history`, {
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

// Best-effort extras from the article body — Business Activity + New Orders
// sub-indices and publish date. The headline PMI (from the URL slug) is what
// matters most; this is non-fatal on failure, same as scrape-ism.
//
// The regex requires "percent" NOT followed by "age" — services reports
// commonly phrase the sub-index sentence as e.g. "increasing 3.7 percentage
// points to 59.1 percent from June's reading", and a naive /(\d+)\s+percent/
// would grab the "3.7 percentage points" change instead of the actual index
// value. The (?!age) guard skips that false match and finds the real one.
function extractIndexValue(text: string, label: string, anchorIdx: number): number | null {
  const idx = text.indexOf(label, anchorIdx);
  if (idx === -1) return null;
  const window = text.slice(idx, idx + 250);
  const m = window.match(/([\d.]+)\s+percent(?!age)/i);
  return m ? parseFloat(m[1]) : null;
}

function parseReportExtras(text: string): { businessActivity: number | null; newOrders: number | null; publishedAt: string | null } {
  const anchorIdx = text.search(/SERVICES INDEX SUMMARIES/i);
  const from = anchorIdx !== -1 ? anchorIdx : 0;
  const businessActivity = extractIndexValue(text, "Business Activity Index", from);
  const newOrders = extractIndexValue(text, "New Orders Index", from);

  // Dateline sits right before the "/PRNewswire/" wire marker, e.g. "Aug. 5, 2026 /PRNewswire/ --"
  let publishedAt: string | null = null;
  const dateM = text.match(/([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})\s*\/?PRNewswire/i);
  if (dateM) {
    const d = new Date(dateM[1].replace(".", ""));
    if (!isNaN(d.getTime())) {
      publishedAt = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  }

  return { businessActivity, newOrders, publishedAt };
}

function periodDateFromSlug(monthSlug: string, yearSlug: string): string | null {
  const idx = MONTHS.indexOf(monthSlug.toLowerCase());
  if (idx === -1) return null;
  return `${yearSlug}-${String(idx + 1).padStart(2, "0")}-01`;
}

// Find Services PMI report links on the ISM newsroom listing page, most recent first.
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
  let businessActivity: number | null = null;
  let newOrders: number | null = null;
  let publishedAt: string | null = null;
  try {
    const html = await fetchText(url);
    const extras = parseReportExtras(stripHtml(html));
    businessActivity = extras.businessActivity;
    newOrders = extras.newOrders;
    publishedAt = extras.publishedAt;
  } catch {
    // Non-fatal — the headline PMI (from the URL slug) is what matters most.
  }
  return { period_date, pmi, business_activity: businessActivity, new_orders: newOrders, published_at: publishedAt, scraped_at: now };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const backfill = url.searchParams.get("backfill") === "true";

  try {
    const links = await findReleaseLinks();
    if (!links.length) throw new Error("No Services PMI release links found on listing page");

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
    console.error("[scrape-ism-services]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
