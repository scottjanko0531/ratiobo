import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchYahooDaily(ticker: string): Promise<{ date: string; value: number }[]> {
  const encoded = encodeURIComponent(ticker);
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=20y`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" } }
  );
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker}: no result`);
  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  return timestamps
    .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), value: closes[i] ?? NaN }))
    .filter(o => !isNaN(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const daily = await fetchYahooDaily("DX-Y.NYB");

    // Aggregate daily → monthly averages
    const byMonth = new Map<string, number[]>();
    for (const o of daily) {
      const m = o.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m)!.push(o.value);
    }

    const months = [...byMonth.keys()].sort();
    const monthAvg = new Map<string, number>();
    for (const m of months) {
      const vals = byMonth.get(m)!;
      monthAvg.set(m, vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    type Row = {
      date: string;
      value: number;
      yoy: number | null;
      mom: number | null;
    };

    const rows: Row[] = [];
    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      const value = Math.round(monthAvg.get(m)! * 100) / 100;

      const [yr, mo] = m.split("-").map(Number);
      const yaKey = `${yr - 1}-${String(mo).padStart(2, "0")}`;
      const yaVal = monthAvg.get(yaKey);
      const yoy = yaVal != null ? Math.round((value / yaVal - 1) * 10000) / 100 : null;

      const prevVal = i > 0 ? monthAvg.get(months[i - 1])! : null;
      const mom = prevVal != null ? Math.round((value / prevVal - 1) * 10000) / 100 : null;

      rows.push({ date: m + "-01", value, yoy, mom });
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
