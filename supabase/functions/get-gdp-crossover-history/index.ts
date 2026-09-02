import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const apiKey = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchObs(seriesId: string): Promise<{ date: string; value: number }[]> {
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

// Same fast/slow crossover definition as the live "GDP Growth (2Q Avg)" /
// "GDP Growth (4Q Avg)" indicators in fetch-macro-data: fast = 2-quarter
// trailing average of real GDP YoY, slow = 4-quarter trailing average.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const obs = await fetchObs("GDPC1");
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

    type Row = { date: string; fast: number; slow: number; actual: number; avg10y: number | null };
    const rows: Row[] = [];
    const WINDOW_10Y = 40; // quarters, matches G1's z-score window in fetch-macro-data
    for (let i = 3; i < yoySeries.length; i++) {
      const fast = (yoySeries[i].yoy + yoySeries[i - 1].yoy) / 2;
      const slow = (yoySeries[i].yoy + yoySeries[i - 1].yoy + yoySeries[i - 2].yoy + yoySeries[i - 3].yoy) / 4;
      let avg10y: number | null = null;
      if (i >= WINDOW_10Y - 1) {
        let sum = 0;
        for (let j = i - (WINDOW_10Y - 1); j <= i; j++) sum += yoySeries[j].yoy;
        avg10y = Math.round((sum / WINDOW_10Y) * 100) / 100;
      }
      rows.push({
        date: yoySeries[i].date,
        fast: Math.round(fast * 100) / 100,
        slow: Math.round(slow * 100) / 100,
        actual: Math.round(yoySeries[i].yoy * 100) / 100,
        avg10y,
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
