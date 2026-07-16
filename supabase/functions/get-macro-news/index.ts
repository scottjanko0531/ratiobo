import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BW_QUERIES = [
  "Bridgewater Associates connecting the dots",
  "Ray Dalio macro economic regime quadrant",
];

const MACRO_QUERIES = [
  "Federal Reserve inflation interest rates outlook",
  "GDP economic growth recession indicators",
  "CPI inflation consumer prices commodities",
  "yield curve credit spreads economic conditions",
  "gold oil copper commodities macro economy",
];

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
  if (source && title.endsWith(suffix)) {
    return title.slice(0, -suffix.length).trim();
  }
  return title;
}

async function fetchQuery(query: string, category: string): Promise<{ id: string; headline: string; source: string; url: string; category: string; publishedAt: number }[]> {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)",
        "Accept": "application/rss+xml, application/xml, text/xml",
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
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
      const headline = cleanTitle(rawTitle, sourceName);
      const ts = pubDate ? new Date(pubDate).getTime() : 0;
      const publishedAt = isNaN(ts) ? 0 : Math.floor(ts / 1000);
      items.push({ id: link, headline, source: sourceName, url: link, category, publishedAt });
    }
    return items;
  } catch (_e) {
    return [];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const allFetches = [
      ...BW_QUERIES.map((q) => fetchQuery(q, "bridgewater")),
      ...MACRO_QUERIES.map((q) => fetchQuery(q, "macro")),
    ];

    const results = await Promise.all(allFetches);
    const seen = new Set<string>();
    const all: { id: string; headline: string; source: string; url: string; category: string; publishedAt: number }[] = [];

    for (const items of results) {
      for (const item of items) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          all.push(item);
        }
      }
    }

    all.sort((a, b) => b.publishedAt - a.publishedAt);

    return new Response(JSON.stringify(all.slice(0, 50)), {
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
