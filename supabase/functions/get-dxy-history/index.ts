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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const obs = await fetchMonthly("DTWEXBGS");
    const byDate = Object.fromEntries(obs.map((o) => [o.date, o.value]));

    type Row = {
      date: string;
      value: number;
      yoy: number | null;
      mom: number | null;
    };

    const rows: Row[] = [];
    for (let i = 0; i < obs.length; i++) {
      const curr = obs[i];
      const d = new Date(curr.date);

      // YoY: same month last year
      const yaKey = `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const yaVal = byDate[yaKey];
      const yoy = yaVal != null
        ? Math.round((curr.value / yaVal - 1) * 10000) / 100
        : null;

      // MoM %
      const prev = i > 0 ? obs[i - 1].value : null;
      const mom = prev != null && prev !== 0
        ? Math.round((curr.value / prev - 1) * 10000) / 100
        : null;

      rows.push({ date: curr.date, value: Math.round(curr.value * 100) / 100, yoy, mom });
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
