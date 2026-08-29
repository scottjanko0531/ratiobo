import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const apiKey = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchMonthly(seriesId: string, extra = ""): Promise<{ date: string; value: number }[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${apiKey}&sort_order=desc&limit=1000&file_type=json${extra}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value))
    .reverse(); // desc → asc
}

// Market Expectations / Inflation cell: is realized CPI YoY tracking above or
// below the market's own 10Y breakeven (T10YIE) inflation pricing? T10YIE is
// daily; aggregated to monthly averages so it lines up with CPI's own cadence.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const [cpiObs, breObs] = await Promise.all([
      fetchMonthly("CPIAUCSL"),
      fetchMonthly("T10YIE", "&frequency=m&aggregation_method=avg"),
    ]);
    const cpiByDate = Object.fromEntries(cpiObs.map((o) => [o.date, o.value]));
    const breByDate = Object.fromEntries(breObs.map((o) => [o.date, o.value]));

    type Row = { date: string; cpiYoy: number; breakeven: number | null };
    const rows: Row[] = [];
    for (const curr of cpiObs) {
      const d = new Date(curr.date);
      const yearAgoKey = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const ya = cpiByDate[yearAgoKey];
      if (ya == null) continue;
      const cpiYoy = (curr.value / ya - 1) * 100;
      const breakeven = breByDate[curr.date] ?? null;
      if (breakeven == null) continue; // T10YIE only exists from 2003 onward
      rows.push({
        date: curr.date,
        cpiYoy: Math.round(cpiYoy * 100) / 100,
        breakeven: Math.round(breakeven * 100) / 100,
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
