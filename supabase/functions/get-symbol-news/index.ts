import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "d8li5c9r01qnkjl6n4n0d8li5c9r01qnkjl6n4ng";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NewsItem {
  headline: string;
  source: string;
  url: string;
  publishedAt: number;
}

// Finnhub's company-news endpoint only covers exchange-listed tickers.
const FINNHUB_TYPES = new Set(["equity", "etf", "closed_end_fund", "mutual_fund", "bond"]);

function getText(block: string, tag: string): string {
  const open = "<" + tag;
  const close = "</" + tag + ">";
  const start = block.indexOf(open);
  if (start === -1) return "";
  const gt = block.indexOf(">", start);
  if (gt === -1) return "";
  const end = block.indexOf(close, gt);
  if (end === -1) return "";
  return block.slice(gt + 1, end).trim();
}
function getLink(block: string): string {
  const start = block.indexOf("<link>");
  if (start === -1) return "";
  const end = block.indexOf("</link>", start);
  if (end === -1) return "";
  return block.slice(start + 6, end).trim();
}
function getSource(block: string): string {
  const start = block.indexOf("<source");
  if (start === -1) return "";
  const gt = block.indexOf(">", start);
  if (gt === -1) return "";
  const end = block.indexOf("</source>", gt);
  if (end === -1) return "";
  return block.slice(gt + 1, end).trim();
}
function cleanTitle(title: string, source: string): string {
  const suffix = " - " + source;
  return source && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

async function fetchGoogleNews(query: string): Promise<NewsItem[]> {
  try {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)",
        "Accept": "application/rss+xml, application/xml, text/xml",
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items: NewsItem[] = [];
    let pos = 0;
    while (true) {
      const s = xml.indexOf("<item>", pos);
      if (s === -1) break;
      const e = xml.indexOf("</item>", s);
      if (e === -1) break;
      const block = xml.slice(s + 6, e);
      pos = e + 7;
      const rawTitle = getText(block, "title");
      const link = getLink(block);
      const pubDate = getText(block, "pubDate");
      const sourceName = getSource(block);
      if (!rawTitle || !link) continue;
      const ts = pubDate ? new Date(pubDate).getTime() : 0;
      items.push({
        headline: cleanTitle(rawTitle, sourceName),
        source: sourceName || "Google News",
        url: link,
        publishedAt: isNaN(ts) ? 0 : Math.floor(ts / 1000),
      });
    }
    return items;
  } catch {
    return [];
  }
}

async function fetchFinnhubNews(symbol: string): Promise<NewsItem[]> {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((n: { headline?: string; url?: string }) => n.headline && n.url)
      .map((n: { headline: string; source?: string; url: string; datetime?: number }) => ({
        headline: n.headline,
        source: n.source || "Finnhub",
        url: n.url,
        publishedAt: n.datetime ?? 0,
      }));
  } catch {
    return [];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
    const assetType = url.searchParams.get("asset_type") ?? "";
    const name = url.searchParams.get("name")?.trim() ?? "";
    if (!symbol) {
      return new Response(JSON.stringify({ error: "symbol required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const query = name ? `${name} ${symbol}` : symbol;
    const [finnhubItems, googleItems] = await Promise.all([
      FINNHUB_TYPES.has(assetType) ? fetchFinnhubNews(symbol) : Promise.resolve([] as NewsItem[]),
      fetchGoogleNews(query),
    ]);

    const seen = new Set<string>();
    const all: NewsItem[] = [];
    for (const item of [...finnhubItems, ...googleItems]) {
      if (!seen.has(item.url)) { seen.add(item.url); all.push(item); }
    }
    all.sort((a, b) => b.publishedAt - a.publishedAt);

    return new Response(JSON.stringify(all.slice(0, 5)), {
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=900" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
