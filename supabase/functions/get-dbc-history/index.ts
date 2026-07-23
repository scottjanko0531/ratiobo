import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const apiKey = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchYahoo(ticker: string): Promise<{ date: string; value: number }[]> {
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

async function fetchDxyMonthly(): Promise<Map<string, number>> {
  const url = `${FRED}?series_id=DTWEXBGS&api_key=${apiKey}&frequency=m&aggregation_method=avg&sort_order=asc&limit=600&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED DTWEXBGS: HTTP ${res.status}`);
  const j = await res.json();
  const map = new Map<string, number>();
  for (const o of j.observations as { date: string; value: string }[]) {
    if (o.value === "." || o.value === "") continue;
    const v = parseFloat(o.value);
    if (!isNaN(v)) map.set(o.date.slice(0, 7), v);
  }
  return map;
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
    const [dbcDaily, dxyByMonth, dxyLatest] = await Promise.all([
      fetchYahoo("DBC"),
      fetchDxyMonthly(),
      fetchYahooLatest("DX-Y.NYB"),
    ]);

    // Plug current month DXY if FRED hasn't published it yet
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    if (dxyLatest != null && !dxyByMonth.has(currentMonth)) {
      dxyByMonth.set(currentMonth, Math.round(dxyLatest * 100) / 100);
    }

    // Convert DBC daily → monthly averages
    const dbcByMonth = new Map<string, number[]>();
    for (const o of dbcDaily) {
      const m = o.date.slice(0, 7);
      if (!dbcByMonth.has(m)) dbcByMonth.set(m, []);
      dbcByMonth.get(m)!.push(o.value);
    }

    const dbcMonthAvg = new Map<string, number>();
    for (const [m, vals] of dbcByMonth) {
      dbcMonthAvg.set(m, vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    const months = [...dbcMonthAvg.keys()].sort();

    // Base = first month with data (DBC inception ~2006-02)
    const baseDbc = dbcMonthAvg.get(months[0])!;

    type Row = {
      date: string;
      dbc: number;
      dbcYoy: number | null;
      dbcIndex: number;       // DBC rebased to 100 at inception
      dxy: number | null;
      dxyYoy: number | null;
      spread: number | null;  // dbcIndex - dxy (positive = commodities above dollar)
    };

    const rows: Row[] = [];

    for (const m of months) {
      const dbc = Math.round(dbcMonthAvg.get(m)! * 100) / 100;
      const dbcIndex = Math.round((dbc / baseDbc) * 10000) / 100; // 2 decimal places

      const [yr, mo] = m.split("-").map(Number);
      const yaKey = `${yr - 1}-${String(mo).padStart(2, "0")}`;

      const dbcYa = dbcMonthAvg.get(yaKey);
      const dbcYoy = dbcYa != null ? Math.round((dbc / dbcYa - 1) * 10000) / 100 : null;

      const dxy = dxyByMonth.has(m) ? Math.round(dxyByMonth.get(m)! * 100) / 100 : null;
      const dxyYa = dxyByMonth.get(yaKey);
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
