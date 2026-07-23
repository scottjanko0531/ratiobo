import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const apiKey = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchMonthly(seriesId: string): Promise<{ date: string; value: number }[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${apiKey}&frequency=m&aggregation_method=avg&sort_order=desc&limit=600&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value))
    .reverse(); // asc order
}

async function fetchYahooLatest(ticker: string): Promise<number | null> {
  try {
    const encoded = encodeURIComponent(ticker);
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const closes: (number | null)[] = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const valid = closes.filter((v): v is number => v != null && !isNaN(v));
    return valid.length ? valid[valid.length - 1] : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const [obs, yahooLatest] = await Promise.all([
      fetchMonthly("DTWEXBGS"),
      fetchYahooLatest("DX-Y.NYB"),
    ]);

    const byDate = Object.fromEntries(obs.map((o) => [o.date, o.value]));

    // Plug current month with Yahoo price if FRED hasn't published it yet
    const now = new Date();
    const currentMonthDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const lastFredDate = obs.length ? obs[obs.length - 1].date : "";

    if (yahooLatest != null && lastFredDate < currentMonthDate) {
      obs.push({ date: currentMonthDate, value: Math.round(yahooLatest * 100) / 100 });
      byDate[currentMonthDate] = Math.round(yahooLatest * 100) / 100;
    }

    type Row = {
      date: string;
      value: number;
      yoy: number | null;
      mom: number | null;
      estimated?: boolean;
    };

    const rows: Row[] = [];
    for (let i = 0; i < obs.length; i++) {
      const curr = obs[i];
      const d = new Date(curr.date);

      const yaKey = `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const yaVal = byDate[yaKey];
      const yoy = yaVal != null
        ? Math.round((curr.value / yaVal - 1) * 10000) / 100
        : null;

      const prev = i > 0 ? obs[i - 1].value : null;
      const mom = prev != null && prev !== 0
        ? Math.round((curr.value / prev - 1) * 10000) / 100
        : null;

      const estimated = curr.date === currentMonthDate && lastFredDate < currentMonthDate;
      rows.push({ date: curr.date, value: Math.round(curr.value * 100) / 100, yoy, mom, ...(estimated ? { estimated: true } : {}) });
    }

    return new Response(JSON.stringify(rows), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
