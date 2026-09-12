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

// ── Regime-driven dynamic-weight backtest ──────────────────────────────────────
// Was: reconstruct, for each calendar year, which structural regime was in
// effect from FRED GDP/CPI alone, then hold that year's target weights —
// explicitly NOT a replay of the live portfolio feature's real activation
// logic (60% Forward Signal confidence floor + confirmation window), because
// historical Forward Signal confidence was never stored.
//
// It's stored now: macro_regime_history (forward_key/forward_confidence,
// quarterly, 2004-present) — the same real data this session's "does the
// medium-term signal ever fire" analysis used. This replaces the old FRED-
// reconstruction with a real replay of the live pending/confirm state
// machine (see update-regime-portfolio-targets's identical logic) against
// that actual history: a candidate regime must clear the 60% floor and
// remain the live read at the NEXT quarterly snapshot (~91 days later,
// comfortably past the real 30-day medium-term confirmation window) before
// the portfolio actually shifts. Quarterly resolution can only under-count
// fires that would have confirmed mid-quarter under live daily monitoring —
// a conservative, not optimistic, reconstruction.
const REGIME_LABELS: Record<string, string> = {
  rg_fi: "Disinflationary Boom", rg_ri: "Reflation", fg_ri: "Stagflation", fg_fi: "Deflationary Bust",
};

// Percent form, asset-class keyed — identical to lib/simulatorKeys.js's
// REGIME_DEFAULT_WEIGHTS, kept in sync manually. Used for the transparency
// table the frontend renders, not for the backtest math itself.
const REGIME_DEFAULT_WEIGHTS_PCT: Record<string, Record<string, number>> = {
  rg_fi: { eq: 35, intl: 15, em: 10, nb: 20, tip: 5, com: 5, gld: 5, cash: 5 },
  rg_ri: { eq: 20, intl: 10, em: 20, nb: 0, tip: 15, com: 20, gld: 10, cash: 5 },
  fg_ri: { eq: 5, intl: 5, em: 0, nb: 0, tip: 20, com: 30, gld: 30, cash: 10 },
  fg_fi: { eq: 5, intl: 5, em: 0, nb: 65, tip: 0, com: 0, gld: 15, cash: 10 },
};

// Fractional (0-1), ticker-keyed — same 8 tickers bw_modified already backtests
// with (eq→VTI, intl→VXUS, em→VWO, nb→TLT, tip→SCHP, com→DBC, gld→GLD, cash→SHY),
// so this shares bw_modified's exact date-availability window, no new proxy gaps.
const REGIME_TICKER_WEIGHTS: Record<string, Record<string, number>> = {
  rg_fi: { VTI: 0.35, VXUS: 0.15, VWO: 0.10, TLT: 0.20, SCHP: 0.05, DBC: 0.05, GLD: 0.05, SHY: 0.05 },
  rg_ri: { VTI: 0.20, VXUS: 0.10, VWO: 0.20, TLT: 0.00, SCHP: 0.15, DBC: 0.20, GLD: 0.10, SHY: 0.05 },
  fg_ri: { VTI: 0.05, VXUS: 0.05, VWO: 0.00, TLT: 0.00, SCHP: 0.20, DBC: 0.30, GLD: 0.30, SHY: 0.10 },
  fg_fi: { VTI: 0.05, VXUS: 0.05, VWO: 0.00, TLT: 0.65, SCHP: 0.00, DBC: 0.00, GLD: 0.15, SHY: 0.10 },
};
const REGIME_TICKERS = ["VTI", "VXUS", "VWO", "TLT", "SCHP", "DBC", "GLD", "SHY"];

const REGIME_CONFIDENCE_FLOOR = 60;

interface RegimeSegment { sinceDate: string; regimeKey: string; }

// Real replay of the pending/confirm state machine (see the header comment
// above) against macro_regime_history's actual quarterly forward-signal
// series. Starts from the FIRST row's own structural_key — "start invested
// per whatever the confirmed regime already was" — exactly the baseline
// this session's earlier forward-vs-reactive comparison used.
async function fetchRegimeSegments(): Promise<RegimeSegment[]> {
  const { data, error } = await supabase
    .from("macro_regime_history")
    .select("period_date, structural_key, forward_key, forward_confidence")
    .order("period_date", { ascending: true });
  if (error) throw new Error(`macro_regime_history: ${error.message}`);
  const rows = (data ?? []).filter(
    (r: { structural_key: string | null }) => r.structural_key != null
  ) as { period_date: string; structural_key: string; forward_key: string | null; forward_confidence: number | null }[];
  if (rows.length === 0) return [];

  let current = rows[0].structural_key;
  let pendingKey: string | null = null;
  const segments: RegimeSegment[] = [{ sinceDate: rows[0].period_date, regimeKey: current }];

  for (let i = 1; i < rows.length; i++) {
    const { forward_key: fwd, forward_confidence: conf, period_date: date } = rows[i];
    if (fwd == null || conf == null) continue;
    if (fwd === current) { pendingKey = null; continue; }
    if (conf < REGIME_CONFIDENCE_FLOOR) continue;
    if (pendingKey === fwd) {
      current = fwd;
      pendingKey = null;
      segments.push({ sinceDate: date, regimeKey: current });
    } else {
      pendingKey = fwd;
    }
  }
  return segments;
}

function regimeKeyForDate(segments: RegimeSegment[], date: string): string {
  let key = segments[0]?.regimeKey ?? "rg_ri";
  for (const seg of segments) { if (seg.sinceDate <= date) key = seg.regimeKey; else break; }
  return key;
}

// Same annual-rebalance mechanics as runBacktest above, except the weight
// vector applied is looked up per-date from the real regime segments (which
// can change mid-year, unlike the old Jan-1-only annual reclassification),
// re-evaluated every month so a mid-year regime shift takes effect the month
// it actually happened rather than waiting for the next calendar year.
function runBacktestBySegments(
  segments: RegimeSegment[],
  tickers: string[],
  returns: Record<string, Map<string, number>>,
  dates: string[],
): { date: string; value: number }[] {
  let curKey = "";
  let curW: number[] = [];
  let value = 1.0;
  const out: { date: string; value: number }[] = [];

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const liveKey = regimeKeyForDate(segments, d);
    if (liveKey !== curKey) {
      const w = REGIME_TICKER_WEIGHTS[liveKey] ?? {};
      curW = tickers.map((t) => w[t] ?? 0);
      curKey = liveKey;
    }

    const assetRets = tickers.map((t) => returns[t]?.get(d) ?? 0);
    value *= 1 + assetRets.reduce((s, r, j) => s + curW[j] * r, 0);

    const drifted = curW.map((w, j) => w * (1 + assetRets[j]));
    const total = drifted.reduce((s, v) => s + v, 0);
    curW = total > 0 ? drifted.map((w) => w / total) : curW;
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
    // Fetch all tickers in parallel, alongside the real regime-segment
    // history and the two resize-overlay portfolios' own already-validated
    // backtests — independent data sources/functions, no reason to serialize.
    const TICKERS = ["VTI","IJS","GLD","TLT","SHY","DBC","DBMF","VXUS","VWO","SCHP",
                     "VTSMX","VISVX","GC=F","VUSTX","VFISX","PCRIX","VGTSX","VEIEX","VIPSX"];
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    async function fetchOverlayPortfolio(fn: string): Promise<{ overlayMonthlyCurve: { date: string; value: number }[] }> {
      const res = await fetch(`${SB_URL}/functions/v1/${fn}`, {
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
      });
      if (!res.ok) throw new Error(`${fn}: HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`${fn}: ${j.error}`);
      return j;
    }
    const [settled, regimeSegments, kissRaw, awaRaw] = await Promise.all([
      Promise.allSettled(TICKERS.map(t => fetchMonthly(t))),
      fetchRegimeSegments(),
      fetchOverlayPortfolio("kiss-portfolio-backtest"),
      fetchOverlayPortfolio("all-weather-alpha-backtest"),
    ]);
    const rets: Record<string, Map<string, number>> = {};
    const errors: string[] = [];
    for (let i = 0; i < TICKERS.length; i++) {
      const r = settled[i];
      if (r.status === "fulfilled") rets[TICKERS[i]] = r.value;
      else errors.push(`${TICKERS[i]}: ${r.reason}`);
    }
    if (errors.length > 5) throw new Error(`Too many fetch failures: ${errors.join("; ")}`);

    // Build spliced series
    const g = (k: string) => rets[k] ?? new Map<string, number>();
    const asset: Record<string, Map<string, number>> = {
      VTI:  splice(g("VTSMX"), g("VTI")),   // US equity
      IJS:  splice(g("VISVX"), g("IJS")),   // US small-cap value
      GLD:  splice(g("GC=F"),  g("GLD")),   // gold
      TLT:  splice(g("VUSTX"), g("TLT")),   // long nominal bonds
      SHY:  splice(g("VFISX"), g("SHY")),   // short-term bonds / cash
      DBC:  splice(g("PCRIX"), g("DBC")),   // commodities
      VXUS: splice(g("VGTSX"), g("VXUS")),  // international developed
      VWO:  splice(g("VEIEX"), g("VWO")),   // emerging markets
      SCHP: splice(g("VIPSX"), g("SCHP")),  // TIPS
    };

    // Build TSMOM proxy for DBMF
    const tsmomRaw = buildTsmom({ VTI: asset.VTI, TLT: asset.TLT, GLD: asset.GLD, DBC: asset.DBC });
    const dbmfActual = g("DBMF");
    const dbmfStart  = dbmfActual.size > 0 ? [...dbmfActual.keys()].sort()[0] : "9999";
    asset.DBMF = new Map<string, number>();
    for (const [d, r] of tsmomRaw) if (d < dbmfStart) asset.DBMF.set(d, r);
    for (const [d, r] of dbmfActual) asset.DBMF.set(d, r);

    // Common date universe across all portfolios (used for window display)
    const allAssets8 = ["VTI","IJS","GLD","TLT","SHY","DBC","DBMF","VXUS","VWO","SCHP"];
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
        weights: { VTI:0.20, VXUS:0.08, VWO:0.05, TLT:0.20, SCHP:0.20, DBC:0.12, GLD:0.12, SHY:0.03 } },
    ];

    const staticResults = PORTFOLIOS.map(p => {
      const keys = Object.keys(p.weights);
      const dates = commonFor(keys);
      const values = runBacktest(p.weights, asset, dates);
      const metrics = computeMetrics(values);
      return { ...p, metrics, monthly_values: values };
    });

    // Regime-driven: dynamic weights, same 8 tickers (and thus same date
    // window) as bw_modified — see runBacktestBySegments / fetchRegimeSegments.
    const regimeDates = commonFor(REGIME_TICKERS);
    const regimeValues = runBacktestBySegments(regimeSegments, REGIME_TICKERS, asset, regimeDates);
    const regimeResult = {
      key: "regime_driven", name: "Regime-Driven (real Forward Signal history)",
      metrics: computeMetrics(regimeValues), monthly_values: regimeValues,
    };

    // KISS and All Weather Alpha: real per-symbol resize-overlay portfolios,
    // already backtested at daily resolution by their own dedicated
    // functions (kiss-portfolio-backtest / all-weather-alpha-backtest) —
    // consumed here as their monthly-downsampled curve so they plug into
    // the exact same computeMetrics/decade/stress-period machinery as every
    // other portfolio on this page, no separate rendering path needed.
    const kissResult = {
      key: "kiss", name: "KISS (+ resize overlay)",
      metrics: computeMetrics(kissRaw.overlayMonthlyCurve), monthly_values: kissRaw.overlayMonthlyCurve,
    };
    const allWeatherAlphaResult = {
      key: "all_weather_alpha", name: "All Weather Alpha (+ resize overlay)",
      metrics: computeMetrics(awaRaw.overlayMonthlyCurve), monthly_values: awaRaw.overlayMonthlyCurve,
    };

    const portfolioResults = [...staticResults, regimeResult, kissResult, allWeatherAlphaResult];

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

    // Transparency table for the frontend: each real confirmed-regime segment
    // within the backtest window (date range, not calendar year — a segment
    // can start and end mid-year now that this replays the real forward-
    // signal state machine instead of a Jan-1-only annual reclassification),
    // and what each segment's target allocation looks like (asset-class %,
    // not the ticker-fractional form used internally for the return math).
    const regimeDrivenHistory = regimeSegments.map((seg, i) => {
      const nextSince = regimeSegments[i + 1]?.sinceDate ?? null;
      return {
        since_date: seg.sinceDate,
        until_date: nextSince,
        regime_key: seg.regimeKey,
        regime_label: REGIME_LABELS[seg.regimeKey],
        weights_pct: REGIME_DEFAULT_WEIGHTS_PCT[seg.regimeKey],
      };
    }).filter(r => r.since_date >= windowStart || (r.until_date == null || r.until_date >= windowStart));

    const output = {
      portfolios:    portfolioResults.map(p => ({ ...p, monthly_values: undefined })),  // strip large array
      portfolio_curves: portfolioResults.map(p => ({ key: p.key, monthly_values: p.monthly_values })),
      stress_periods: stressResults,
      decade_returns: decadeResults,
      regime_driven_history: regimeDrivenHistory,
      window_start:   windowStart,
      window_end:     windowEnd,
      computed_at:    new Date().toISOString(),
      proxies:        "VTSMX→VTI, VISVX→IJS, GC=F→GLD, VUSTX→TLT, VFISX→SHY, PCRIX→DBC, VGTSX→VXUS, VEIEX→VWO, VIPSX→SCHP; DBMF pre-2019 = 12M TSMOM factor (scaled to 11.2% vol, −0.85% fee). Regime-Driven: real replay of the live 60%-confidence-floor/confirmation-window state machine against macro_regime_history's actual quarterly Forward Signal history (2004-present) — shifts only when a candidate regime clears 60% confidence and is still the live read ~1 quarter later, not a Jan-1-only annual reclassification. KISS and All Weather Alpha: each holds its own real per-symbol resize overlay (asset_resize_rule_config — trend/vol-regime/drawdown rules backtested per asset), monthly-rebalanced, freed weight parked in USFR; computed by their own dedicated functions (kiss-portfolio-backtest, all-weather-alpha-backtest) at daily resolution, consumed here as a monthly-downsampled curve.",
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
