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
    .filter((o) => !isNaN(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// OLS slope of `values` against day-index (0..window-1) for each trailing window.
// Closed-form: slope = Σ((x-x̄)·y) / Σ((x-x̄)²), with Σ(x-x̄)² = window·(window²-1)/12 for x=0..window-1.
function rollingSlope(values: number[], window: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  const xbar = (window - 1) / 2;
  const sxx = (window * (window * window - 1)) / 12;
  for (let i = window - 1; i < n; i++) {
    let sxy = 0;
    for (let k = 0; k < window; k++) sxy += (k - xbar) * values[i - window + 1 + k];
    out[i] = sxy / sxx;
  }
  return out;
}

function rollingMean(values: number[], window: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function rollingCorr(a: number[], b: number[], window: number): (number | null)[] {
  const n = a.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let k = i - window + 1; k <= i; k++) {
      sa += a[k]; sb += b[k]; saa += a[k] * a[k]; sbb += b[k] * b[k]; sab += a[k] * b[k];
    }
    const cov = sab / window - (sa / window) * (sb / window);
    const va = saa / window - (sa / window) ** 2;
    const vb = sbb / window - (sb / window) ** 2;
    const denom = Math.sqrt(va * vb);
    out[i] = denom > 0 ? cov / denom : null;
  }
  return out;
}

const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
const stdev = (arr: number[], mu: number) => Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length) || 1;

function zscoreSeries(arr: (number | null)[]): (number | null)[] {
  const valid = arr.filter((v): v is number => v != null);
  if (valid.length < 30) return arr.map(() => null);
  const mu = mean(valid), sd = stdev(valid, mu);
  return arr.map((v) => (v == null ? null : (v - mu) / sd));
}

const WINDOWS = [20, 60] as const;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const [t30Raw, dxyRaw] = await Promise.all([fetchYahooDaily("^TYX"), fetchYahooDaily("DX-Y.NYB")]);

    const t30Map = new Map(t30Raw.map((o) => [o.date, o.value]));
    const dxyMap = new Map(dxyRaw.map((o) => [o.date, o.value]));
    const dates = [...t30Map.keys()].filter((d) => dxyMap.has(d)).sort();
    const t30Vals = dates.map((d) => t30Map.get(d)!);
    const dxyVals = dates.map((d) => dxyMap.get(d)!);
    const n = dates.length;
    if (n < 120) throw new Error("insufficient overlapping history");

    const t30MeanW: Record<number, (number | null)[]> = {};
    const dxyMeanW: Record<number, (number | null)[]> = {};
    const zT30: Record<number, (number | null)[]> = {};
    const zDxy: Record<number, (number | null)[]> = {};
    const spread: Record<number, (number | null)[]> = {};
    const corr: Record<number, (number | null)[]> = {};

    for (const w of WINDOWS) {
      t30MeanW[w] = rollingMean(t30Vals, w);
      dxyMeanW[w] = rollingMean(dxyVals, w);
      const t30SlopeRaw = rollingSlope(t30Vals, w);
      const dxySlopeRaw = rollingSlope(dxyVals, w);
      // Native units: T30 slope (pct-point/day) -> bp/day; DXY slope (index-pt/day) -> %/day.
      const t30SlopeBp = t30SlopeRaw.map((s) => (s == null ? null : s * 100));
      const dxySlopePct = dxySlopeRaw.map((s, i) => (s == null ? null : dxyMeanW[w][i] ? (s / (dxyMeanW[w][i] as number)) * 100 : null));
      zT30[w] = zscoreSeries(t30SlopeBp);
      zDxy[w] = zscoreSeries(dxySlopePct);
      spread[w] = zT30[w].map((z, i) => (z == null || zDxy[w][i] == null ? null : z - (zDxy[w][i] as number)));
    }

    // Trend of the persistent (60d) divergence: 20-day OLS slope of the spread series itself.
    const spreadTrendRaw = rollingSlope(spread[60].map((v) => v ?? 0), 20);
    const spreadTrend = spreadTrendRaw.map((v, i) => {
      if (v == null) return null;
      const start = i - 19;
      return start >= 0 && spread[60][start] != null ? v : null;
    });

    // Rolling correlation of daily % change (co-movement, not shared trend).
    const pctChange = (vals: number[]): number[] => {
      const out = [0];
      for (let i = 1; i < vals.length; i++) out.push(vals[i - 1] !== 0 ? vals[i] / vals[i - 1] - 1 : 0);
      return out;
    };
    const t30Chg = pctChange(t30Vals);
    const dxyChg = pctChange(dxyVals);
    for (const w of WINDOWS) corr[w] = rollingCorr(t30Chg, dxyChg, w);

    const HIST_DAYS = 500;
    const startIdx = Math.max(0, n - HIST_DAYS);
    const history = [];
    for (let i = startIdx; i < n; i++) {
      history.push({
        date: dates[i],
        spread20: spread[20][i] != null ? r3(spread[20][i] as number) : null,
        spread60: spread[60][i] != null ? r3(spread[60][i] as number) : null,
        spreadTrend: spreadTrend[i] != null ? r3(spreadTrend[i] as number) : null,
        corr20: corr[20][i] != null ? r3(corr[20][i] as number) : null,
        corr60: corr[60][i] != null ? r3(corr[60][i] as number) : null,
      });
    }

    const last = n - 1;
    const sign = (v: number | null) => (v == null ? 0 : v > 0 ? 1 : v < 0 ? -1 : 0);
    const s20 = spread[20][last], s60 = spread[60][last];
    const agreement = s20 != null && s60 != null && sign(s20) === sign(s60) && Math.abs(s20) >= 1 && Math.abs(s60) >= 1;

    const rr = (v: number | null) => (v == null ? null : r3(v));
    const latest = {
      date: dates[last],
      zT30_20: rr(zT30[20][last]), zDxy_20: rr(zDxy[20][last]), spread20: rr(s20),
      zT30_60: rr(zT30[60][last]), zDxy_60: rr(zDxy[60][last]), spread60: rr(s60),
      spreadTrend: rr(spreadTrend[last]),
      corr20: rr(corr[20][last]), corr60: rr(corr[60][last]),
      agreement,
    };

    return new Response(JSON.stringify({ latest, history }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
