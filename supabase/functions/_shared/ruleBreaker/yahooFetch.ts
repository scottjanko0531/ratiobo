// Rule Breaker Screener — Yahoo Finance fetch layer for the daily
// rb-refresh job. Every field/formula below is a direct translation of
// the artifact's own live collector (supplied verbatim by the user,
// 2026-10-20) -- this is the spec, not a guess. Pure fetch + parse logic,
// no DB access (that's rb-refresh/index.ts's job), mirroring this repo's
// existing ingest-function convention of keeping fetch/parse separate
// from upsert orchestration.
//
// Two Yahoo auth classes:
//   - v8 chart is unauthenticated (same query1/query2-fallback pattern
//     already proven in sync-asset-price-history/backfill-asset-price-
//     history).
//   - v7 quote, v10 quoteSummary, and fundamentals-timeseries all need a
//     cookie+crumb pair -- new to this repo, no existing precedent.
// "Missing stays null -- never coerce to 0" per the source's own
// explicit warning (root cause of 4 of this session's 8 metric bugs).

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://finance.yahoo.com/",
  "Origin": "https://finance.yahoo.com",
};

export interface YahooSession {
  cookie: string;
  crumb: string;
}

function parseCookieHeaderValue(setCookieValues: string[]): string {
  return setCookieValues
    .map((sc) => sc.split(";")[0]?.trim())
    .filter((v): v is string => !!v)
    .join("; ");
}

// Cookie from fc.yahoo.com, crumb from /v1/test/getcrumb using that
// cookie -- exactly the two-step dance the source describes. Fetch once
// per rb-refresh invocation, reuse for every call in that run.
export async function createYahooSession(): Promise<YahooSession> {
  const cookieRes = await fetch("https://fc.yahoo.com", { headers: YAHOO_HEADERS });
  const setCookies =
    typeof (cookieRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (cookieRes.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : cookieRes.headers.get("set-cookie")
        ? [cookieRes.headers.get("set-cookie")!]
        : [];
  const cookie = parseCookieHeaderValue(setCookies);
  if (!cookie) throw new Error("createYahooSession: no Set-Cookie from fc.yahoo.com");

  let crumb = "";
  let lastErr = "";
  for (const host of ["query2", "query1"]) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
        headers: { ...YAHOO_HEADERS, Cookie: cookie },
      });
      if (!res.ok) {
        lastErr = `${host} HTTP ${res.status}`;
        continue;
      }
      crumb = (await res.text()).trim();
      if (crumb) break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (!crumb) throw new Error(`createYahooSession: failed to get crumb -- ${lastErr}`);
  return { cookie, crumb };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Authenticated Yahoo call with crumb appended + cookie attached,
// query2->query1 host fallback, and 429 retry with backoff per the
// source's own "Gotchas" throttling note.
async function yahooFetch(path: string, session: YahooSession, maxRetries = 3): Promise<Record<string, unknown>> {
  let lastErr = "";
  for (const host of ["query2", "query1"]) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `https://${host}.finance.yahoo.com${path}${sep}crumb=${encodeURIComponent(session.crumb)}`;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, { headers: { ...YAHOO_HEADERS, Cookie: session.cookie } });
        if (res.status === 429 && attempt < maxRetries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        if (!res.ok) {
          lastErr = `${host} HTTP ${res.status}`;
          break;
        }
        return (await res.json()) as Record<string, unknown>;
      } catch (e) {
        lastErr = `${host} fetch error -- ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
  }
  throw new Error(lastErr || "yahooFetch: unknown failure");
}

function rawNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const r = (v as { raw?: unknown }).raw;
    return typeof r === "number" ? r : null;
  }
  return typeof v === "number" ? v : null;
}

// ── v7 quote (batched, 50 at a time) ──

export interface YahooQuote {
  symbol: string;
  name: string | null;
  currency: string | null;
  price: number | null;
  marketCap: number | null;
}

export async function fetchQuoteBatch(session: YahooSession, symbols: string[]): Promise<Map<string, YahooQuote>> {
  const out = new Map<string, YahooQuote>();
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    const json = await yahooFetch(`/v7/finance/quote?symbols=${batch.map(encodeURIComponent).join(",")}`, session);
    const results = ((json.quoteResponse as Record<string, unknown> | undefined)?.result as Array<Record<string, unknown>> | undefined) ?? [];
    for (const q of results) {
      const symbol = q.symbol as string;
      out.set(symbol, {
        symbol,
        name: (q.shortName as string | undefined) ?? (q.longName as string | undefined) ?? null,
        currency: (q.currency as string | undefined) ?? null,
        price: (q.regularMarketPrice as number | undefined) ?? null,
        marketCap: (q.marketCap as number | undefined) ?? null,
      });
    }
  }
  return out;
}

// FX rate to USD, cached per run. `GBp` (pence) maps to `GBP` per the
// source. USD is always 1 (collector pre-seeds window._FX={USD:1}).
export async function fetchFxRate(
  session: YahooSession,
  currency: string | null | undefined,
  cache: Map<string, number | null>,
): Promise<number | null> {
  if (!currency) return null;
  const normalized = currency === "GBp" ? "GBP" : currency;
  if (normalized === "USD") return 1;
  if (cache.has(normalized)) return cache.get(normalized)!;
  try {
    const json = await yahooFetch(`/v7/finance/quote?symbols=${encodeURIComponent(normalized)}USD=X`, session);
    const results = ((json.quoteResponse as Record<string, unknown> | undefined)?.result as Array<Record<string, unknown>> | undefined) ?? [];
    const rate = (results[0]?.regularMarketPrice as number | undefined) ?? null;
    cache.set(normalized, rate);
    return rate;
  } catch {
    cache.set(normalized, null);
    return null;
  }
}

// ── v10 quoteSummary ──

export interface YahooQuoteSummaryFields {
  sector: string | null;
  industry: string | null;
  ins: number | null;
  inst: number | null;
  fpe: number | null;
  ps: number | null;
  evRev: number | null;
  evEbitda: number | null;
  rgQ: number | null;
  gmTTM: number | null;
  insNet6m: number | null;
  insBuyN: number | null;
  insSellN: number | null;
}

export async function fetchQuoteSummary(session: YahooSession, yahooSymbol: string): Promise<YahooQuoteSummaryFields> {
  const modules = "defaultKeyStatistics,financialData,netSharePurchaseActivity,assetProfile,summaryDetail";
  const json = await yahooFetch(`/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}`, session);
  const result = (((json.quoteSummary as Record<string, unknown> | undefined)?.result as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
  const ks = (result.defaultKeyStatistics as Record<string, unknown>) ?? {};
  const fd = (result.financialData as Record<string, unknown>) ?? {};
  const sd = (result.summaryDetail as Record<string, unknown>) ?? {};
  const ns = (result.netSharePurchaseActivity as Record<string, unknown>) ?? {};
  const ap = (result.assetProfile as Record<string, unknown>) ?? {};
  return {
    sector: (ap.sector as string | undefined) ?? null,
    industry: (ap.industry as string | undefined) ?? null,
    ins: rawNum(ks.heldPercentInsiders),
    inst: rawNum(ks.heldPercentInstitutions),
    fpe: rawNum(ks.forwardPE) ?? rawNum(sd.forwardPE),
    ps: rawNum(sd.priceToSalesTrailing12Months),
    evRev: rawNum(ks.enterpriseToRevenue),
    evEbitda: rawNum(ks.enterpriseToEbitda),
    rgQ: rawNum(fd.revenueGrowth),
    gmTTM: rawNum(fd.grossMargins),
    insNet6m: rawNum(ns.netPercentInsiderShares),
    insBuyN: rawNum(ns.buyInfoCount),
    insSellN: rawNum(ns.sellInfoCount),
  };
}

// ── fundamentals-timeseries ──

export interface YahooTimeseriesFields {
  fcur: string | null;
  fy: string | null;
  rev: [number | null, number | null, number | null];
  gp: [number | null, number | null];
  cfo: [number | null, number | null];
  ni: number | null;
  assets: [number | null, number | null];
  ebitda: number | null;
  ebit: number | null;
  debt: number | null;
  cash: number | null;
  eq: number | null;
  rd: number | null;
  sbc: number | null;
  rep: number | null;
  div: number | null;
  tax: number | null;
  ic: number | null;
  qni: number[] | null;
  qrev: number[] | null;
  qgp: number[] | null;
  qoi: number[] | null;
}

const TIMESERIES_TYPES = [
  "annualTotalRevenue",
  "annualGrossProfit",
  "annualOperatingCashFlow",
  "annualNetIncome",
  "annualTotalAssets",
  "annualEBITDA",
  "annualEBIT",
  "annualTotalDebt",
  "annualCashCashEquivalentsAndShortTermInvestments",
  "annualStockholdersEquity",
  "annualResearchAndDevelopment",
  "annualStockBasedCompensation",
  "annualRepurchaseOfCapitalStock",
  "annualCashDividendsPaid",
  "annualTaxRateForCalcs",
  "annualInvestedCapital",
  "quarterlyNetIncome",
  "quarterlyTotalRevenue",
  "quarterlyGrossProfit",
  "quarterlyOperatingIncome",
];

type TimeseriesEntry = { reportedValue?: { raw?: number }; currencyCode?: string; asOfDate?: string };

export async function fetchFundamentalsTimeseries(
  session: YahooSession,
  yahooSymbol: string,
  quoteCurrency: string | null,
): Promise<YahooTimeseriesFields> {
  const period1 = 1577836800; // 2020-01-01, matches the source exactly
  const period2 = Math.floor(Date.now() / 1000);
  const json = await yahooFetch(
    `/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(yahooSymbol)}?type=${TIMESERIES_TYPES.join(",")}&period1=${period1}&period2=${period2}`,
    session,
  );
  const results = ((json.timeseries as Record<string, unknown> | undefined)?.result as Array<Record<string, unknown>> | undefined) ?? [];

  const series: Record<string, TimeseriesEntry[]> = {};
  let fcur: string | null = null;
  let fy: string | null = null;
  for (const r of results) {
    const key = ((r.meta as Record<string, unknown> | undefined)?.type as string[] | undefined)?.[0];
    if (!key) continue;
    const entries = ((r[key] as Array<TimeseriesEntry | null> | undefined) ?? []).filter((e): e is TimeseriesEntry => !!e);
    series[key] = entries;
    if (key === "annualTotalRevenue" && entries.length > 0) {
      const latest = entries[entries.length - 1];
      fcur = latest.currencyCode ?? null;
      fy = latest.asOfDate ?? null;
    }
  }

  // i-th-from-the-end (1-indexed) of the null-filtered array -- "latest"
  // means the newest entry that actually has a value, per the source's
  // own "Latest = last element after dropping null entries" rule.
  const L = (key: string, i = 1): number | null => {
    const arr = series[key] ?? [];
    if (arr.length < i) return null;
    return arr[arr.length - i]?.reportedValue?.raw ?? null;
  };
  const Q = (key: string): number[] | null => {
    const arr = series[key] ?? [];
    const vals = arr.map((e) => e.reportedValue?.raw).filter((v): v is number => v != null);
    const last8 = vals.slice(-8);
    return last8.length > 0 ? last8 : null;
  };

  return {
    fcur: fcur ?? quoteCurrency ?? null,
    fy,
    rev: [L("annualTotalRevenue", 1), L("annualTotalRevenue", 2), L("annualTotalRevenue", 3)],
    gp: [L("annualGrossProfit", 1), L("annualGrossProfit", 2)],
    cfo: [L("annualOperatingCashFlow", 1), L("annualOperatingCashFlow", 2)],
    ni: L("annualNetIncome"),
    assets: [L("annualTotalAssets", 1), L("annualTotalAssets", 2)],
    ebitda: L("annualEBITDA"),
    ebit: L("annualEBIT"),
    debt: L("annualTotalDebt"),
    cash: L("annualCashCashEquivalentsAndShortTermInvestments"),
    eq: L("annualStockholdersEquity"),
    rd: L("annualResearchAndDevelopment"),
    sbc: L("annualStockBasedCompensation"),
    rep: L("annualRepurchaseOfCapitalStock"),
    div: L("annualCashDividendsPaid"),
    tax: L("annualTaxRateForCalcs"),
    ic: L("annualInvestedCapital"),
    qni: Q("quarterlyNetIncome"),
    qrev: Q("quarterlyTotalRevenue"),
    qgp: Q("quarterlyGrossProfit"),
    qoi: Q("quarterlyOperatingIncome"),
  };
}

// ── v8 chart, range=1y (price-derived metrics) ──
// Unauthenticated -- same query1/query2 fallback already proven in
// sync-asset-price-history, no crumb needed.

export interface YahooChart1yFields {
  n: number;
  ret1y: number | null;
  mom12_1: number | null;
  mom6: number | null;
  mom3: number | null;
  liqTrend: number | null;
  liqCV: number | null;
  rv: number | null;
  mdd1y: number | null;
}

function mean(a: number[]): number {
  return a.reduce((s, x) => s + x, 0) / a.length;
}

async function fetchChartJson(yahooSymbol: string, range: "1y" | "2y"): Promise<Record<string, unknown>> {
  let lastErr = "";
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=${range}`,
        { headers: YAHOO_HEADERS },
      );
      if (!res.ok) {
        lastErr = `${host} HTTP ${res.status}`;
        continue;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      lastErr = `${host} fetch error -- ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(lastErr || `fetchChartJson(${yahooSymbol}, ${range}): unknown failure`);
}

export async function fetchChart1y(yahooSymbol: string): Promise<YahooChart1yFields> {
  const json = await fetchChartJson(yahooSymbol, "1y");
  const result = ((json.chart as Record<string, unknown> | undefined)?.result as Array<Record<string, unknown>> | undefined)?.[0];
  if (!result) throw new Error(`chart(1y, ${yahooSymbol}): no result`);
  const quote = ((result.indicators as Record<string, unknown> | undefined)?.quote as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const closes = (quote.close as Array<number | null> | undefined) ?? [];
  const volumes = (quote.volume as Array<number | null> | undefined) ?? [];

  const px: number[] = [];
  const vv: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null) {
      px.push(closes[i]!);
      vv.push((volumes[i] ?? 0) * closes[i]!);
    }
  }
  const n = px.length;
  const at = (k: number): number | null => (n > k ? px[n - 1 - k] : null);

  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push(Math.log(px[i] / px[i - 1]));
  // Sample stdev (n-1) for the log-return vol, matching the source
  // exactly -- NOT the same denominator convention as liqCV below.
  const m = rets.length > 0 ? mean(rets) : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1)) : 0;

  const v63 = vv.length > 0 ? mean(vv.slice(-63)) : 0;
  const vall = vv.length > 0 ? mean(vv) : 0;
  // Population stdev (plain n) for the dollar-volume dispersion -- the
  // source uses a different denominator convention here than rv's sd.
  const lsd = vall !== 0 ? Math.sqrt(mean(vv.map((x) => (x - vall) ** 2))) : 0;

  let peak = 0;
  let mdd = 0;
  for (const p of px) {
    peak = Math.max(peak, p);
    mdd = Math.min(mdd, p / peak - 1);
  }

  const at21 = at(21);
  const at126 = at(126);
  const at63 = at(63);
  return {
    n,
    ret1y: n > 200 ? px[n - 1] / px[0] - 1 : null,
    mom12_1: n > 200 && at21 != null ? at21 / px[0] - 1 : null,
    mom6: n > 126 && at126 != null ? px[n - 1] / at126 - 1 : null,
    mom3: n > 63 && at63 != null ? px[n - 1] / at63 - 1 : null,
    liqTrend: vall !== 0 ? v63 / vall : null,
    liqCV: vall !== 0 ? lsd / vall : null,
    rv: sd * Math.sqrt(252),
    mdd1y: n > 0 ? mdd : null,
  };
}

// ── v8 chart, range=2y (weekly bars for rb_weekly_bars + daily closes
// for asset_price_history) ──
// Verbatim translation of the source's `chartFor()`.

export interface WeeklyBarOutput {
  week_start: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number;
  vwap6_a: number | null;
  vwap6_sigma: number | null;
  vwap12_b: number | null;
  signal: "u" | "d" | null;
}

export interface Chart2yResult {
  weeklyBars: WeeklyBarOutput[]; // last 52 weeks, ascending
  dailyCloses: Array<{ date: string; close: number }>;
}

interface WeekAccumulator {
  wk: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  pv: number;
  days: Array<[number, number]>; // [typicalPrice, volume]
}

export async function fetchChart2y(yahooSymbol: string): Promise<Chart2yResult> {
  const json = await fetchChartJson(yahooSymbol, "2y");
  const result = ((json.chart as Record<string, unknown> | undefined)?.result as Array<Record<string, unknown>> | undefined)?.[0];
  if (!result) throw new Error(`chart(2y, ${yahooSymbol}): no result`);
  const timestamps = (result.timestamp as number[] | undefined) ?? [];
  const quote = ((result.indicators as Record<string, unknown> | undefined)?.quote as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const opens = (quote.open as Array<number | null> | undefined) ?? [];
  const highs = (quote.high as Array<number | null> | undefined) ?? [];
  const lows = (quote.low as Array<number | null> | undefined) ?? [];
  const closes = (quote.close as Array<number | null> | undefined) ?? [];
  const volumes = (quote.volume as Array<number | null> | undefined) ?? [];

  const dailyCloses: Array<{ date: string; close: number }> = [];
  const W: WeekAccumulator[] = [];
  let cur: WeekAccumulator | null = null;

  for (let k = 0; k < timestamps.length; k++) {
    const o = opens[k], h = highs[k], l = lows[k], cl = closes[k], v = volumes[k];
    if (cl != null) dailyCloses.push({ date: new Date(timestamps[k] * 1000).toISOString().slice(0, 10), close: cl });
    if (cl == null || h == null || l == null || v == null) continue;
    const d = new Date(timestamps[k] * 1000);
    const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    const weekStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
    if (!cur || cur.wk !== weekStart) {
      cur = { wk: weekStart, o: o ?? cl, h: -Infinity, l: Infinity, c: cl, v: 0, pv: 0, days: [] };
      W.push(cur);
    }
    cur.h = Math.max(cur.h, h);
    cur.l = Math.min(cur.l, l);
    cur.c = cl;
    cur.v += v;
    const tp = (h + l + cl) / 3;
    cur.pv += tp * v;
    cur.days.push([tp, v]);
  }

  // Volume-weighted mean/stdev of daily typical price over the L weeks
  // ending at week index i. [null, null] if there isn't enough history
  // yet (i < L-1) or if the window had zero volume.
  const va = (i: number, L: number): [number | null, number | null] => {
    if (i < L - 1) return [null, null];
    let pv = 0;
    let v = 0;
    const days: Array<[number, number]> = [];
    for (let k = i - L + 1; k <= i; k++) {
      pv += W[k].pv;
      v += W[k].v;
      days.push(...W[k].days);
    }
    if (!v) return [null, null];
    const m = pv / v;
    let s2 = 0;
    for (const [tp, x] of days) s2 += x * (tp - m) ** 2;
    return [m, Math.sqrt(s2 / v)];
  };

  const A: Array<[number | null, number | null]> = W.map((_, i) => va(i, 6));
  const B: Array<number | null> = W.map((_, i) => va(i, 12)[0]);
  const signals: Array<"u" | "d" | null> = W.map((w, i) => {
    if (i < 8 || A[i][0] == null || A[i - 1][0] == null) return null;
    const s = w.c > A[i][0]!;
    const p = W[i - 1].c > A[i - 1][0]!;
    const rising = A[i][0]! > A[i - 2][0]!;
    if (s && !p && rising) return "u";
    if (!s && p) return "d";
    return null;
  });

  const n = W.length;
  const start = Math.max(0, n - 52);
  const weeklyBars: WeeklyBarOutput[] = [];
  for (let i = start; i < n; i++) {
    weeklyBars.push({
      week_start: W[i].wk,
      open: W[i].o,
      high: W[i].h,
      low: W[i].l,
      close: W[i].c,
      volume: W[i].v,
      vwap6_a: A[i][0],
      vwap6_sigma: A[i][1],
      vwap12_b: B[i],
      signal: signals[i],
    });
  }

  return { weeklyBars, dailyCloses };
}
