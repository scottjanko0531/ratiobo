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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const ppiObs = await fetchMonthly("PPIACO");
    const ppiByDate = Object.fromEntries(ppiObs.map((o) => [o.date, o.value]));

    type Row = {
      date: string;
      ppiYoy: number;
      ppiAccel: number | null;
    };

    const rows: Row[] = [];

    for (const curr of ppiObs) {
      const d = new Date(curr.date);
      const yearAgo = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1));
      const yearAgoKey = yearAgo.toISOString().slice(0, 10);

      const ppiYA = ppiByDate[yearAgoKey];
      if (ppiYA == null) continue;

      const ppiYoy = Math.round((curr.value / ppiYA - 1) * 10000) / 100;

      const prevPpiYoy = rows.length > 0 ? rows[rows.length - 1].ppiYoy : null;
      const ppiAccel = prevPpiYoy != null
        ? Math.round((ppiYoy - prevPpiYoy) * 100) / 100
        : null;

      rows.push({ date: curr.date, ppiYoy, ppiAccel });
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
