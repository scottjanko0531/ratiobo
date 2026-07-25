import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const RF_ANN = 0.04;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

// ── Yahoo Finance monthly fetch ───────────────────────────────────────────────
async function fetchMonthly(ticker: string): Promise<Map<string, number>> {
  const enc = encodeURIComponent(ticker);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1mo&range=max`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; ratiobo-backtest/1.0)" }, signal: ctrl.signal }
    );
  } finally { clearTimeout(tid); }
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker}: no result`);

  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] =
    result.indicators?.adjclose?.[0]?.adjclose ??
    result.indicators?.quote?.[0]?.close ?? [];

  const priceMap = new Map<string, number>();
  for (let i = 0; i < timestamps.length; i++) {
    const p = closes[i];
    if (p == null || isNaN(p) || p <= 0) continue;
    // Normalise to first-of-month key so monthly alignment is deterministic
    const d = new Date(timestamps[i] * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    priceMap.set(key, p);
  }
  // Convert prices to monthly returns (sorted chronologically)
  const dates = [...priceMap.keys()].sort();
  const retMap = new Map<string, number>();
  for (let i = 1; i < dates.length; i++) {
    const p0 = priceMap.get(dates[i - 1])!;
    const p1 = priceMap.get(dates[i])!;
    if (p0 > 0) retMap.set(dates[i], p1 / p0 - 1);
  }
  return retMap;
}

// ── Splice proxy → ETF (proxy before ETF's first date, ETF after) ─────────────
function splice(proxy: Map<string, number>, etf: Map<string, number>): Map<string, number> {
  if (etf.size === 0) return proxy;
  const etfStart = [...etf.keys()].sort()[0];
  const out = new Map<string, number>();
  for (const [d, r] of proxy) if (d < etfStart) out.set(d, r);
  for (const [d, r] of etf) out.set(d, r);
  return out;
}

// ── 12-month time-series momentum proxy for managed futures ──────────────────
function buildTsmom(
  components: Record<string, Map<string, number>>,
  targetVol = 0.112,
  feeAnn = 0.0085
): Map<string, number> {
  const assets = Object.keys(components);
  const allDates = [...new Set(assets.flatMap(a => [...components[a].keys()]))].sort();

  // Build cumulative level index for each asset
  const levels: Record<string, Map<string, number>> = {};
  for (const asset of assets) {
    const rets = components[asset];
    const lvl = new Map<string, number>();
    let v = 1.0;
    for (const d of allDates) {
      const r = rets.get(d);
      if (r != null) v *= (1 + r);
      lvl.set(d, v);
    }
    levels[asset] = lvl;
  }

  // Compute raw portfolio returns using shifted 12M signal
  const rawRets: number[] = [];
  const rawDates: string[] = [];
  for (let i = 13; i < allDates.length; i++) {
    const signalDate = allDates[i - 1];   // signal known end of prior month
    const lookback   = allDates[i - 13];  // 12 months before signal date
    const tradeDate  = allDates[i];       // month we earn the return
    let sum = 0, count = 0;
    for (const asset of assets) {
      const lvlNow  = levels[asset].get(signalDate);
      const lvlThen = levels[asset].get(lookback);
      const ret     = components[asset].get(tradeDate);
      if (lvlNow == null || lvlThen == null || lvlThen === 0 || ret == null) continue;
      const signal = (lvlNow / lvlThen - 1) > 0 ? 1 : -1;
      sum += signal * ret;
      count++;
    }
    if (count > 0) { rawRets.push(sum / count); rawDates.push(tradeDate); }
  }
  if (rawRets.length === 0) return new Map();

  // Scale to target vol
  const mean = rawRets.reduce((s, v) => s + v, 0) / rawRets.length;
  const vol  = Math.sqrt(rawRets.reduce((s, v) => s + (v - mean) ** 2, 0) / rawRets.length) * Math.sqrt(12);
  const scale = vol > 0 ? targetVol / vol : 1;
  const feeM  = feeAnn / 12;
  const out = new Map<string, number>();
  for (let i = 0; i < rawDates.length; i++) out.set(rawDates[i], rawRets[i] * scale - feeM);
  return out;
}

// ── Annual-rebalanced backtest ────────────────────────────────────────────────
function runBacktest(
  weights: Record<string, number>,
  returns: Record<string, Map<string, number>>,
  dates: string[]
): { date: string; value: number }[] {
  const tickers = Object.keys(weights);
  const w0 = tickers.map(t => weights[t]);
  let curW = [...w0];
  let value = 1.0;
  const seenYears = new Set<number>();
  const out: { date: string; value: number }[] = [];

  for (let i = 0; i < dates.length; i++) {
    const d    = dates[i];
    const year = parseInt(d.slice(0, 4));
    if (i > 0 && !seenYears.has(year)) curW = [...w0];
    seenYears.add(year);

    const assetRets = tickers.map(t => returns[t]?.get(d) ?? 0);
    value *= 1 + assetRets.reduce((s, r, j) => s + curW[j] * r, 0);

    const drifted = curW.map((w, j) => w * (1 + assetRets[j]));
    const total   = drifted.reduce((s, v) => s + v, 0);
    curW = total > 0 ? drifted.map(w => w / total) : [...w0];
    out.push({ date: d, value });
  }
  return out;
}

// ── Performance metrics ───────────────────────────────────────────────────────
function computeMetrics(values: { date: string; value: number }[]) {
  if (values.length < 13) return null;
  const monthlyRets: number[] = [];
  for (let i = 1; i < values.length; i++) monthlyRets.push(values[i].value / values[i - 1].value - 1);

  const n     = monthlyRets.length;
  const nYrs  = n / 12;
  const total = values[values.length - 1].value / values[0].value - 1;
  const cagr  = Math.pow(1 + total, 1 / nYrs) - 1;
  const mean  = monthlyRets.reduce((s, v) => s + v, 0) / n;
  const vol   = Math.sqrt(monthlyRets.reduce((s, v) => s + (v - mean) ** 2, 0) / n) * Math.sqrt(12);
  const rfM   = Math.pow(1 + RF_ANN, 1 / 12) - 1;
  const stdM  = Math.sqrt(monthlyRets.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const sharpe  = stdM > 0 ? ((mean - rfM) / stdM) * Math.sqrt(12) : 0;
  const downV   = monthlyRets.filter(r => r < 0);
  const downStd = downV.length > 0 ? Math.sqrt(downV.reduce((s, r) => s + r * r, 0) / downV.length) * Math.sqrt(12) : 0;
  const sortino = downStd > 0 ? (mean * 12 - RF_ANN) / downStd : 0;

  // Max drawdown + duration
  let peak = values[0].value, maxDD = 0, inDD = 0, maxDDMo = 0;
  for (const { value } of values) {
    if (value >= peak) { peak = value; inDD = 0; }
    else { inDD++; maxDDMo = Math.max(maxDDMo, inDD); }
    const dd = (value - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Annual returns: last value of each calendar year
  const yearEndVal = new Map<number, number>();
  for (const { date, value } of values) yearEndVal.set(parseInt(date.slice(0, 4)), value);
  const sortedYears = [...yearEndVal.keys()].sort((a, b) => a - b);
  const annualReturns: { year: number; ret: number }[] = [];
  for (let i = 1; i < sortedYears.length; i++) {
    const yr = sortedYears[i], pr = sortedYears[i - 1];
    const ev = yearEndVal.get(yr)!, pv = yearEndVal.get(pr)!;
    if (pv > 0) annualReturns.push({ year: yr, ret: r4(ev / pv - 1) });
  }
  const yrRets = annualReturns.map(r => r.ret);
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : 0;

  return {
    cagr:         r4(cagr),
    total_return: r4(total),
    volatility:   r4(vol),
    sharpe:       r4(sharpe),
    sortino:      r4(sortino),
    max_dd:       r4(maxDD),
    max_dd_months: maxDDMo,
    calmar:       r4(calmar),
    best_year:    r4(Math.max(...yrRets)),
    worst_year:   r4(Math.min(...yrRets)),
    annual_returns: annualReturns,
  };
}

// ── Period return helper ──────────────────────────────────────────────────────
function periodReturn(values: { date: string; value: number }[], start: string, end: string): number | null {
  const seg = values.filter(v => v.date >= start && v.date <= end);
  if (seg.length < 2) return null;
  return r4(seg[seg.length - 1].value / seg[0].value - 1);
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // Fetch all tickers in parallel
    const TICKERS = ["VTI","IJS","GLD","TLT","SHY","IEF","DBC","DBMF",
                     "VTSMX","VISVX","GC=F","VUSTX","VFISX","VFITX","PCRIX"];
    const settled = await Promise.allSettled(TICKERS.map(t => fetchMonthly(t)));
    const rets: Record<string, Map<string, number>> = {};
    const errors: string[] = [];
    for (let i = 0; i < TICKERS.length; i++) {
      const r = settled[i];
      if (r.status === "fulfilled") rets[TICKERS[i]] = r.value;
      else errors.push(`${TICKERS[i]}: ${r.reason}`);
    }
    if (errors.length > 4) throw new Error(`Too many fetch failures: ${errors.join("; ")}`);

    // Build spliced series
    const g = (k: string) => rets[k] ?? new Map<string, number>();
    const asset: Record<string, Map<string, number>> = {
      VTI:  splice(g("VTSMX"), g("VTI")),
      IJS:  splice(g("VISVX"), g("IJS")),
      GLD:  splice(g("GC=F"),  g("GLD")),
      TLT:  splice(g("VUSTX"), g("TLT")),
      SHY:  splice(g("VFISX"), g("SHY")),
      IEF:  splice(g("VFITX"), g("IEF")),
      DBC:  splice(g("PCRIX"), g("DBC")),
    };

    // Build TSMOM proxy for DBMF
    const tsmomRaw = buildTsmom({ VTI: asset.VTI, TLT: asset.TLT, GLD: asset.GLD, DBC: asset.DBC });
    const dbmfActual = g("DBMF");
    const dbmfStart  = dbmfActual.size > 0 ? [...dbmfActual.keys()].sort()[0] : "9999";
    asset.DBMF = new Map<string, number>();
    for (const [d, r] of tsmomRaw) if (d < dbmfStart) asset.DBMF.set(d, r);
    for (const [d, r] of dbmfActual) asset.DBMF.set(d, r);

    // Common date universe (all 8 assets for hedged GB; adjust per portfolio below)
    const allAssets8 = ["VTI","IJS","GLD","TLT","SHY","IEF","DBC","DBMF"];
    const commonDatesAll = (() => {
      const sets = allAssets8.map(a => new Set(asset[a].keys()));
      const base = new Set(asset["VTI"].keys());
      for (const k of base) if (!sets.every(s => s.has(k))) base.delete(k);
      return [...base].sort();
    })();

    // Per-portfolio date sets (BW doesn't need DBMF; Standard GB doesn't need IEF or DBC)
    function commonFor(keys: string[]) {
      const sets = keys.map(k => new Set(asset[k].keys()));
      const base = new Set(asset[keys[0]].keys());
      for (const k of base) if (!sets.every(s => s.has(k))) base.delete(k);
      return [...base].sort();
    }

    const PORTFOLIOS: { key: string; name: string; weights: Record<string, number> }[] = [
      { key: "standard_gb", name: "Standard Golden Butterfly",
        weights: { VTI:0.20, IJS:0.20, GLD:0.20, TLT:0.20, SHY:0.20 } },
      { key: "hedged_gb",   name: "Hedged Golden Butterfly (+DBMF)",
        weights: { VTI:0.20, IJS:0.20, GLD:0.20, TLT:0.15, SHY:0.15, DBMF:0.10 } },
      { key: "bw_modified", name: "BW All Weather Modified",
        weights: { VTI:0.30, TLT:0.40, IEF:0.15, GLD:0.075, DBC:0.075 } },
    ];

    const portfolioResults = PORTFOLIOS.map(p => {
      const keys = Object.keys(p.weights);
      const dates = commonFor(keys);
      const values = runBacktest(p.weights, asset, dates);
      const metrics = computeMetrics(values);
      return { ...p, metrics, monthly_values: values };
    });

    // Stress periods for DBMF
    const STRESS = [
      { label: "2001–02 dot-com bear", start: "2001-02-01", end: "2002-12-01" },
      { label: "2008–09 GFC",          start: "2007-12-01", end: "2009-03-01" },
      { label: "2020 COVID crash",     start: "2020-01-01", end: "2020-04-01" },
      { label: "2022 rates/inflation", start: "2022-01-01", end: "2022-12-01" },
    ];
    const stressResults = STRESS.map(s => {
      const portfolioRets: Record<string, number | null> = {};
      for (const p of portfolioResults) {
        portfolioRets[p.key] = periodReturn(p.monthly_values, s.start, s.end);
      }
      // DBMF proxy return
      const dbmfArr = [...asset.DBMF.entries()]
        .filter(([d]) => d >= s.start && d <= s.end)
        .sort(([a], [b]) => a.localeCompare(b));
      let dbmfRet: number | null = null;
      if (dbmfArr.length >= 2) {
        const compounded = dbmfArr.reduce((prod, [, r]) => prod * (1 + r), 1) - 1;
        dbmfRet = r4(compounded);
      }
      return { ...s, portfolios: portfolioRets, dbmf_return: dbmfRet };
    });

    // Decade breakdowns (use longest available date range per portfolio)
    const DECADES = [
      { label: "2000s (dot-com + GFC)", start: "2001-01-01", end: "2009-12-01" },
      { label: "2010s (bull market)",   start: "2010-01-01", end: "2019-12-01" },
      { label: "2020s (YTD)",           start: "2020-01-01", end: "2099-12-01" },
      { label: "Full period",           start: "2000-01-01", end: "2099-12-01" },
    ];
    const decadeResults = DECADES.map(d => {
      const portfolioCAGRs: Record<string, number | null> = {};
      for (const p of portfolioResults) {
        const seg = p.monthly_values.filter(v => v.date >= d.start && v.date <= d.end);
        if (seg.length < 2) { portfolioCAGRs[p.key] = null; continue; }
        const nYrs = seg.length / 12;
        portfolioCAGRs[p.key] = r4(Math.pow(seg[seg.length - 1].value / seg[0].value, 1 / nYrs) - 1);
      }
      return { ...d, portfolios: portfolioCAGRs };
    });

    // Determine the actual shared window for the display
    const windowStart = commonDatesAll[0];
    const windowEnd   = commonDatesAll[commonDatesAll.length - 1];

    const output = {
      portfolios:    portfolioResults.map(p => ({ ...p, monthly_values: undefined })),  // strip large array
      portfolio_curves: portfolioResults.map(p => ({ key: p.key, monthly_values: p.monthly_values })),
      stress_periods: stressResults,
      decade_returns: decadeResults,
      window_start:   windowStart,
      window_end:     windowEnd,
      computed_at:    new Date().toISOString(),
      proxies:        "VTSMX→VTI, VISVX→IJS, GC=F→GLD, VUSTX→TLT, VFISX→SHY, VFITX→IEF, PCRIX→DBC; DBMF pre-2019 = 12M TSMOM factor (scaled to 11.2% vol, −0.85% fee)",
      fetch_errors:   errors,
    };

    // Upsert into cache (keep last 3 runs)
    await supabase.from("backtest_cache").insert({ results: output });
    // Prune old rows
    const { data: old } = await supabase.from("backtest_cache")
      .select("id").order("computed_at", { ascending: false }).range(3, 999);
    if (old?.length) await supabase.from("backtest_cache").delete().in("id", old.map(r => r.id));

    return new Response(JSON.stringify(output), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[run-backtest]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
