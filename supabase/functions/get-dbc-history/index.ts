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

function toMonthlyAvg(daily: { date: string; value: number }[]): Map<string, number> {
  const byMonth = new Map<string, number[]>();
  for (const o of daily) {
    const m = o.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(o.value);
  }
  const avg = new Map<string, number>();
  for (const [m, vals] of byMonth) {
    avg.set(m, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return avg;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const [dbcDaily, dxyDaily] = await Promise.all([
      fetchYahooDaily("DBC"),
      fetchYahooDaily("DX-Y.NYB"),
    ]);

    const dbcMonthAvg = toMonthlyAvg(dbcDaily);
    const dxyByMonth  = toMonthlyAvg(dxyDaily);

    const months = [...dbcMonthAvg.keys()].sort();

    // Base = first month with data (DBC inception ~2006-02)
    const baseDbc = dbcMonthAvg.get(months[0])!;

    type Row = {
      date: string;
      dbc: number;
      dbcYoy: number | null;
      dbcIndex: number;
      dxy: number | null;
      dxyYoy: number | null;
      spread: number | null;
    };

    const rows: Row[] = [];

    for (const m of months) {
      const dbc = Math.round(dbcMonthAvg.get(m)! * 100) / 100;
      const dbcIndex = Math.round((dbc / baseDbc) * 10000) / 100;

      const [yr, mo] = m.split("-").map(Number);
      const yaKey = `${yr - 1}-${String(mo).padStart(2, "0")}`;

      const dbcYa  = dbcMonthAvg.get(yaKey);
      const dbcYoy = dbcYa != null ? Math.round((dbc / dbcYa - 1) * 10000) / 100 : null;

      const dxy    = dxyByMonth.has(m) ? Math.round(dxyByMonth.get(m)! * 100) / 100 : null;
      const dxyYa  = dxyByMonth.get(yaKey);
      const dxyYoy = dxy != null && dxyYa != null
        ? Math.round((dxy / dxyYa - 1) * 10000) / 100
        : null;

      const spread = dxy != null ? Math.round((dbcIndex - dxy) * 100) / 100 : null;

      rows.push({ date: m + "-01", dbc, dbcYoy, dbcIndex, dxy, dxyYoy, spread });
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
