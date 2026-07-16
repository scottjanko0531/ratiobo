import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "d8li5c9r01qnkjl6n4n0d8li5c9r01qnkjl6n4ng";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  url: string;
  source: "finnhub" | "dailyshot";
  publishedAt: number;
}

function extractCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTag(block: string, tag: string): string {
  const r = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return r ? extractCdata(r[1]) : "";
}

function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = getTag(block, "title");
    // <link> in RSS 2.0 is a bare text node immediately after the tag
    const link = (block.match(/<link>(.*?)<\/link>/i) ?? [])[1]?.trim() ?? "";
    const pubDate = getTag(block, "pubDate");
    const desc = stripHtml(getTag(block, "description")).slice(0, 220);
    if (!title || !link) continue;
    const ts = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0;
    items.push({ id: `ds-${link}`, headline: title, summary: desc, url: link, source: "dailyshot", publishedAt: ts });
  }
  return items;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const [finnhubRes, rssRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/news?category=economic&token=${FINNHUB_KEY}`),
      fetch("https://thedailyshot.com/feed/", { headers: { "User-Agent": "RatioBo/1.0" } }),
    ]);

    const [finnhubData, rssText] = await Promise.all([
      finnhubRes.json(),
      rssRes.text(),
    ]);

    const finnhubItems: NewsItem[] = (Array.isArray(finnhubData) ? finnhubData : [])
      .slice(0, 30)
      .map((n: { id: number; headline: string; summary: string; url: string; datetime: number }) => ({
        id: `fh-${n.id}`,
        headline: n.headline,
        summary: n.summary?.slice(0, 220) ?? "",
        url: n.url,
        source: "finnhub" as const,
        publishedAt: n.datetime,
      }));

    const dsItems = parseRss(rssText).slice(0, 10);

    const all = [...finnhubItems, ...dsItems]
      .filter(i => i.headline && i.url)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 40);

    return new Response(JSON.stringify(all), {
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=900" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
