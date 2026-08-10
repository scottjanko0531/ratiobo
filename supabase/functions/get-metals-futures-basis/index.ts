import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchYahooDaily(ticker: string, range: string): Promise<{ date: string; value: number }[]> {
  const encoded = encodeURIComponent(ticker);
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=${range}`,
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
    .filter((o) => !isNaN(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
const stdev = (arr: number[], mu: number) => Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length) || 1;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// December contracts ("Z") exactly one calendar year apart — the most liquid,
// consistently-spaced pair for both COMEX gold and silver. Using the same
// contract month for both legs avoids the seasonal-roll noise of comparing
// across different months, and gives a clean ~12-month basis with no further
// annualization needed.
function decContractYears(now = new Date()): { front: number; forward: number } {
  const y = now.getUTCFullYear();
  // Roll to next year's December once the current year's Dec contract is in
  // its expiry month, so we never quote a contract about to go off the board.
  const front = now.getUTCMonth() === 11 ? y + 1 : y;
  return { front, forward: front + 1 };
}

interface BasisResult {
  latest: {
    date: string;
    frontSymbol: string; forwardSymbol: string;
    frontPrice: number; forwardPrice: number;
    basisPct: number; zBasis: number; trend20d: number | null;
    historyDays: number;
  };
  history: { date: string; basisPct: number; zBasis: number }[];
}

async function computeBasis(root: "GC" | "SI", front: number, forward: number): Promise<BasisResult> {
  const frontSym = `${root}Z${String(front).slice(2)}.CMX`;
  const forwardSym = `${root}Z${String(forward).slice(2)}.CMX`;
  const [frontRaw, forwardRaw] = await Promise.all([
    fetchYahooDaily(frontSym, "5y"),
    fetchYahooDaily(forwardSym, "5y"),
  ]);
  const forwardMap = new Map(forwardRaw.map((o) => [o.date, o.value]));
  const merged = frontRaw
    .filter((o) => forwardMap.has(o.date))
    .map((o) => ({ date: o.date, front: o.value, forward: forwardMap.get(o.date)! }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (merged.length < 60) throw new Error(`${root}: insufficient overlapping history (${merged.length}d)`);

  // Basis = forward contract premium (or discount) to front, as %. Positive =
  // contango (normal cost-of-carry). Compressing toward / through zero =
  // backwardation, historically a physical-demand / monetary-stress signal
  // distinct from the price level itself.
  const basis = merged.map((m) => r3(((m.forward / m.front) - 1) * 100));
  const mu = mean(basis), sd = stdev(basis, mu);
  const z = basis.map((b) => r3((b - mu) / sd));

  // 20-trading-day OLS slope of the basis itself — direction independent of
  // level: is contango widening (normal carry building) or compressing
  // (physical stress building)?
  const trendWindow = Math.min(20, merged.length - 1);
  const xbar = (trendWindow - 1) / 2;
  const sxx = (trendWindow * (trendWindow * trendWindow - 1)) / 12;
  const tail = basis.slice(-trendWindow);
  let sxy = 0;
  tail.forEach((v, k) => { sxy += (k - xbar) * v; });
  const trend20d = sxx > 0 ? r3(sxy / sxx) : null;

  const HIST_DAYS = 500;
  const startIdx = Math.max(0, merged.length - HIST_DAYS);
  const history = merged.slice(startIdx).map((m, i) => ({
    date: m.date,
    basisPct: basis[startIdx + i],
    zBasis: z[startIdx + i],
  }));

  const last = merged.length - 1;
  return {
    latest: {
      date: merged[last].date,
      frontSymbol: frontSym, forwardSymbol: forwardSym,
      frontPrice: r3(merged[last].front), forwardPrice: r3(merged[last].forward),
      basisPct: basis[last], zBasis: z[last], trend20d,
      historyDays: merged.length,
    },
    history,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { front, forward } = decContractYears();
    const [gold, silver] = await Promise.all([
      computeBasis("GC", front, forward),
      computeBasis("SI", front, forward),
    ]);
    // Both metals showing meaningfully compressed contango at once is the
    // cross-market confirmation the framework calls for — a single metal
    // moving alone is more likely idiosyncratic supply/demand noise.
    const agreement =
      gold.latest.zBasis < -0.5 && silver.latest.zBasis < -0.5;
    return new Response(JSON.stringify({ gold, silver, agreement }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
