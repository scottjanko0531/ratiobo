import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const apiKey = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchMonthly(seriesId: string): Promise<{ date: string; value: number }[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${apiKey}&sort_order=desc&limit=1000&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value))
    .reverse(); // desc → asc
}

// Same fast/slow crossover definition as the live "CPI Growth (3M Avg)" /
// "CPI Growth (9M Avg)" indicators in fetch-macro-data: fast = 3-month
// trailing average of headline CPI YoY, slow = 9-month trailing average.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const obs = await fetchMonthly("CPIAUCSL");
    const byDate = Object.fromEntries(obs.map((o) => [o.date, o.value]));

    type YoyRow = { date: string; yoy: number };
    const yoySeries: YoyRow[] = [];
    for (const curr of obs) {
      const d = new Date(curr.date);
      const yearAgoKey = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const ya = byDate[yearAgoKey];
      if (ya == null) continue;
      yoySeries.push({ date: curr.date, yoy: (curr.value / ya - 1) * 100 });
    }

    type Row = { date: string; fast: number; slow: number };
    const rows: Row[] = [];
    for (let i = 8; i < yoySeries.length; i++) {
      const last3 = yoySeries.slice(i - 2, i + 1);
      const last9 = yoySeries.slice(i - 8, i + 1);
      const fast = last3.reduce((s, r) => s + r.yoy, 0) / last3.length;
      const slow = last9.reduce((s, r) => s + r.yoy, 0) / last9.length;
      rows.push({
        date: yoySeries[i].date,
        fast: Math.round(fast * 100) / 100,
        slow: Math.round(slow * 100) / 100,
      });
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
