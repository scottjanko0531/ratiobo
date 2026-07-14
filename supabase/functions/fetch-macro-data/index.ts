import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const apiKey = Deno.env.get("FRED_API_KEY")!;
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function fetchFred(seriesId: string, needed: number): Promise<number[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${apiKey}&sort_order=desc&limit=${needed + 8}&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => parseFloat(o.value))
    .filter((n) => !isNaN(n))
    .slice(0, needed);
}

async function fetchFredObs(seriesId: string, limit: number): Promise<{ date: string; value: number }[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${apiKey}&sort_order=desc&limit=${limit}&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value));
}

async function fetchFredObsMonthly(seriesId: string, limit: number): Promise<{ date: string; value: number }[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${apiKey}&frequency=m&aggregation_method=avg&sort_order=desc&limit=${limit}&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId} monthly: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value));
}

async function fetchYahooGold(range: string): Promise<{ date: string; value: number }[]> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=${range}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" } }
  );
  if (!res.ok) throw new Error(`Yahoo GC=F: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo GC=F: no result in response");
  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  return timestamps
    .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), value: closes[i] ?? NaN }))
    .filter((o) => !isNaN(o.value))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function findYearAgo(
  obs: { date: string; value: number }[],
  refDate: string
): { date: string; value: number } | undefined {
  const d = new Date(refDate);
  const targetYear  = d.getUTCFullYear() - 1;
  const targetMonth = d.getUTCMonth();
  return obs.find((o) => {
    const od = new Date(o.date);
    return od.getUTCFullYear() === targetYear && od.getUTCMonth() === targetMonth;
  });
}

function yoyPair(
  obs: { date: string; value: number }[]
): { current: number; previous: number } | null {
  if (obs.length < 2) return null;
  const ya0 = findYearAgo(obs, obs[0].date);
  const ya1 = findYearAgo(obs, obs[1].date);
  if (!ya0 || !ya1) return null;
  return {
    current:  (obs[0].value / ya0.value - 1) * 100,
    previous: (obs[1].value / ya1.value - 1) * 100,
  };
}

async function fetchFredAnnual(seriesId: string): Promise<{ year: number; value: number }[]> {
  const url = `${FRED}?series_id=${seriesId}&api_key=${apiKey}&frequency=a&aggregation_method=avg&sort_order=asc&file_type=json&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId} annual: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ year: parseInt(o.date.slice(0, 4)), value: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.value));
}

type Status = "healthy" | "watch" | "danger" | "unknown";
type StatusFn = (v: number) => Status;

interface Indicator {
  name: string;
  layer: number;
  layer_name: string;
  description: string;
  fred_series_id: string | null;
  unit: string;
  data_source: string;
  sort_order: number;
  type:
    | "level"
    | "yoy_monthly"
    | "yoy_monthly_agg"
    | "yoy_quarterly"
    | "gdp_3yr_avg"
    | "cpi_3yr_avg"
    | "mom_change"
    | "mom_pct"
    | "computed"
    | "treasurydirect"
    | "supabase_debt_cycle"
    | "debt_tax_ratio"
    | "interest_gdp_pct"
    | "level_minus_yoy_quarterly"
    | "level_minus_yoy_monthly"
    | "walcl_pct_gdp"
    | "m2_minus_gdp"
    | "gpr_website"
    | "gold_3m_avg"
    | "cb_gold_imf";
  series?: string;
  series2?: string;
  statusFn: StatusFn;
}

const INDICATORS: Indicator[] = [
  // ── LAYER 1: Long-term Debt Cycle ──
  {
    name: "Total Debt / GDP",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "Total nonfinancial debt as % of GDP — long-term debt cycle position",
    fred_series_id: null, unit: "%", data_source: "supabase", sort_order: 1,
    type: "supabase_debt_cycle",
    statusFn: v => v < 200 ? "healthy" : v < 300 ? "watch" : "danger",
  },
  {
    name: "Federal Debt / Tax Revenue",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "Federal debt as multiple of annual tax receipts — sovereign repayment capacity",
    fred_series_id: null, unit: "ratio", data_source: "computed", sort_order: 2,
    series: "GFDEBTN", series2: "FYFR", type: "debt_tax_ratio",
    statusFn: v => v < 5 ? "healthy" : v < 8 ? "watch" : "danger",
  },
  {
    name: "Interest Expense % GDP",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "Federal interest payments as % of GDP — debt service burden",
    fred_series_id: null, unit: "%", data_source: "computed", sort_order: 3,
    series: "A091RC1Q027SBEA", series2: "GDP", type: "interest_gdp_pct",
    statusFn: v => v < 2 ? "healthy" : v < 4 ? "watch" : "danger",
  },
  {
    name: "Rate vs. GDP Growth Spread",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "10Y Treasury yield minus real GDP growth (r−g) — debt sustainability signal",
    fred_series_id: null, unit: "%", data_source: "computed", sort_order: 4,
    series: "DGS10", series2: "GDPC1", type: "level_minus_yoy_quarterly",
    statusFn: v => v < 0 ? "healthy" : v < 2 ? "watch" : "danger",
  },
  {
    name: "Real Fed Funds Rate",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "Fed funds rate minus CPI YoY — monetary policy stance (positive = restrictive)",
    fred_series_id: null, unit: "%", data_source: "computed", sort_order: 5,
    series: "FEDFUNDS", series2: "CPIAUCSL", type: "level_minus_yoy_monthly",
    statusFn: v => v >= -1 && v <= 2 ? "healthy" : v >= -3 && v <= 4 ? "watch" : "danger",
  },
  {
    name: "Fed Balance Sheet % GDP",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "Fed total assets as % of nominal GDP — QE/QT cycle position",
    fred_series_id: null, unit: "%", data_source: "computed", sort_order: 6,
    series: "WALCL", series2: "GDP", type: "walcl_pct_gdp",
    statusFn: v => v < 20 ? "healthy" : v < 35 ? "watch" : "danger",
  },
  {
    name: "M2 Growth minus Real GDP",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "Excess money supply growth over real output — liquidity and inflation pressure",
    fred_series_id: null, unit: "%", data_source: "computed", sort_order: 7,
    series: "M2SL", series2: "GDPC1", type: "m2_minus_gdp",
    statusFn: v => v >= 0 && v <= 4 ? "healthy" : v >= -2 && v <= 8 ? "watch" : "danger",
  },
  {
    name: "Treasury Bid-to-Cover",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "10-Year Treasury note auction bid-to-cover ratio — demand for US government debt; below 2.0 signals weakening appetite from investors",
    fred_series_id: null, unit: "ratio", data_source: "treasurydirect", sort_order: 95,
    type: "treasurydirect",
    statusFn: v => v >= 2.5 ? "healthy" : v >= 2.0 ? "watch" : "danger",
  },
  {
    name: "Gold Price (3M Avg)",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "COMEX gold futures 90-day rolling average vs prior 90 days — safe-haven demand and dollar confidence signal; rising gold signals fiat distrust",
    fred_series_id: null, unit: "$/oz", data_source: "yahoo", sort_order: 96,
    type: "gold_3m_avg",
    statusFn: v => v < 2000 ? "healthy" : v < 3000 ? "watch" : "danger",
  },
  {
    name: "CB Gold Reserves (YoY)",
    layer: 1, layer_name: "Long-term Debt Cycle",
    description: "YoY % change in gold price (COMEX GC=F) — proxy for central bank accumulation and de-dollarization pressure; rising gold signals sovereign distrust of fiat",
    fred_series_id: null, unit: "% YoY", data_source: "yahoo", sort_order: 97,
    type: "cb_gold_imf",
    statusFn: v => v < 5 ? "healthy" : v < 25 ? "watch" : "danger",
  },
  // ── LAYER 2: Short-Term Debt Cycle ──
  {
    name: "2yr/10yr Yield Spread",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "10Y minus 2Y Treasury yield — inversion signals recession 12–18 months forward",
    fred_series_id: "T10Y2Y", unit: "%", data_source: "fred", sort_order: 8,
    series: "T10Y2Y", type: "level",
    statusFn: v => v > 0.5 ? "healthy" : v >= 0 ? "watch" : "danger",
  },
  {
    name: "3mo/10yr Yield Spread",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "10Y minus 3M Treasury yield — Dalio's preferred recession signal, fewer false positives",
    fred_series_id: "T10Y3M", unit: "%", data_source: "fred", sort_order: 9,
    series: "T10Y3M", type: "level",
    statusFn: v => v > 1 ? "healthy" : v >= 0 ? "watch" : "danger",
  },
  {
    name: "Sr Loan Officer Survey",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "Net % of banks tightening C&I lending standards — leads recession 6–12 months (quarterly)",
    fred_series_id: "DRTSCILM", unit: "%", data_source: "fred", sort_order: 10,
    series: "DRTSCILM", type: "level",
    statusFn: v => v < 15 ? "healthy" : v < 35 ? "watch" : "danger",
  },
  {
    name: "HY Credit Spread (OAS)",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "High yield option-adjusted spread — widening signals credit stress and risk-off",
    fred_series_id: "BAMLH0A0HYM2", unit: "%", data_source: "fred", sort_order: 11,
    series: "BAMLH0A0HYM2", type: "level",
    statusFn: v => v < 4 ? "healthy" : v < 6 ? "watch" : "danger",
  },
  {
    name: "IG Credit Spread (OAS)",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "Investment grade option-adjusted spread — reliable financial system stress gauge",
    fred_series_id: "BAMLC0A0CM", unit: "%", data_source: "fred", sort_order: 12,
    series: "BAMLC0A0CM", type: "level",
    statusFn: v => v < 1.2 ? "healthy" : v < 2 ? "watch" : "danger",
  },
  {
    name: "C&I Loan Growth (YoY)",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "Commercial & industrial loan growth — contraction precedes recession",
    fred_series_id: "BUSLOANS", unit: "%", data_source: "fred", sort_order: 13,
    series: "BUSLOANS", type: "yoy_monthly_agg",
    statusFn: v => v > 5 ? "healthy" : v >= 0 ? "watch" : "danger",
  },
  {
    name: "Consumer Debt Service Ratio",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "Household debt payments as % of disposable income (quarterly)",
    fred_series_id: "TDSP", unit: "%", data_source: "fred", sort_order: 14,
    series: "TDSP", type: "level",
    statusFn: v => v < 10 ? "healthy" : v < 12 ? "watch" : "danger",
  },
  {
    name: "Conference Board LEI",
    layer: 2, layer_name: "Short-Term Debt Cycle",
    description: "Leading Economic Index MoM % change — 3 consecutive declines signal recession",
    fred_series_id: "USSLIND", unit: "%", data_source: "fred", sort_order: 15,
    series: "USSLIND", type: "mom_pct",
    statusFn: v => v > 0 ? "healthy" : v >= -0.3 ? "watch" : "danger",
  },
  // ── LAYER 3: Business Cycle ──
  {
    name: "Real GDP Growth", layer: 3, layer_name: "Business Cycle",
    description: "Annualized real GDP YoY — expansion vs contraction",
    fred_series_id: "GDPC1", unit: "%", data_source: "fred", sort_order: 16,
    series: "GDPC1", type: "yoy_quarterly",
    statusFn: v => v >= 2 ? "healthy" : v >= 0 ? "watch" : "danger",
  },
  {
    name: "GDP Growth (3Y Avg)", layer: 3, layer_name: "Business Cycle",
    description: "3-year trailing average of real GDP YoY growth — trend baseline for regime detection",
    fred_series_id: "GDPC1", unit: "%", data_source: "fred", sort_order: 165,
    series: "GDPC1", type: "gdp_3yr_avg",
    statusFn: v => v >= 2 ? "healthy" : v >= 0 ? "watch" : "danger",
  },
  {
    name: "Unemployment Rate", layer: 3, layer_name: "Business Cycle",
    description: "Headline unemployment — labor market health",
    fred_series_id: "UNRATE", unit: "%", data_source: "fred", sort_order: 17,
    series: "UNRATE", type: "level",
    statusFn: v => v < 5 ? "healthy" : v < 7 ? "watch" : "danger",
  },
  {
    name: "CPI (YoY)", layer: 3, layer_name: "Business Cycle",
    description: "Headline consumer inflation — price stability",
    fred_series_id: "CPIAUCSL", unit: "%", data_source: "fred", sort_order: 18,
    series: "CPIAUCSL", type: "yoy_monthly",
    statusFn: v => v >= 1 && v <= 3 ? "healthy" : v <= 5 ? "watch" : "danger",
  },
  {
    name: "Core CPI (YoY)", layer: 3, layer_name: "Business Cycle",
    description: "CPI ex-food and energy — persistent inflation signal",
    fred_series_id: "CPILFESL", unit: "%", data_source: "fred", sort_order: 19,
    series: "CPILFESL", type: "yoy_monthly",
    statusFn: v => v >= 1 && v <= 3 ? "healthy" : v <= 4.5 ? "watch" : "danger",
  },
  {
    name: "Nonfarm Payrolls (MoM)", layer: 3, layer_name: "Business Cycle",
    description: "Monthly job creation — labor market momentum",
    fred_series_id: "PAYEMS", unit: "K", data_source: "fred", sort_order: 20,
    series: "PAYEMS", type: "mom_change",
    statusFn: v => v > 150 ? "healthy" : v > 0 ? "watch" : "danger",
  },
  {
    name: "Personal Savings Rate", layer: 3, layer_name: "Business Cycle",
    description: "Savings as % of disposable income — consumer buffer",
    fred_series_id: "PSAVERT", unit: "%", data_source: "fred", sort_order: 21,
    series: "PSAVERT", type: "level",
    statusFn: v => v >= 5 ? "healthy" : v >= 3 ? "watch" : "danger",
  },
  {
    name: "Industrial Production (YoY)", layer: 3, layer_name: "Business Cycle",
    description: "Factory output growth — real economy demand signal",
    fred_series_id: "INDPRO", unit: "%", data_source: "fred", sort_order: 23,
    series: "INDPRO", type: "yoy_monthly",
    statusFn: v => v >= 1 ? "healthy" : v >= -1 ? "watch" : "danger",
  },
  {
    name: "PPI (YoY)", layer: 3, layer_name: "Business Cycle",
    description: "Producer price inflation — upstream inflation pipeline",
    fred_series_id: "PPIACO", unit: "%", data_source: "fred", sort_order: 24,
    series: "PPIACO", type: "yoy_monthly",
    statusFn: v => v >= 0 && v <= 3 ? "healthy" : v <= 6 ? "watch" : "danger",
  },
  {
    name: "Financial Conditions Index", layer: 3, layer_name: "Business Cycle",
    description: "Chicago Fed NFCI — overall financial tightness (negative = loose)",
    fred_series_id: "NFCI", unit: "z-score", data_source: "fred", sort_order: 25,
    series: "NFCI", type: "level",
    statusFn: v => v < 0 ? "healthy" : v < 0.5 ? "watch" : "danger",
  },
  {
    name: "Retail Sales (YoY)", layer: 3, layer_name: "Business Cycle",
    description: "Consumer spending growth — demand-side activity",
    fred_series_id: "RSAFS", unit: "%", data_source: "fred", sort_order: 26,
    series: "RSAFS", type: "yoy_monthly",
    statusFn: v => v >= 2 ? "healthy" : v >= 0 ? "watch" : "danger",
  },
  {
    name: "Capacity Utilization", layer: 3, layer_name: "Business Cycle",
    description: "Industrial capacity use — slack vs constraint signal",
    fred_series_id: "TCU", unit: "%", data_source: "fred", sort_order: 27,
    series: "TCU", type: "level",
    statusFn: v => v >= 76 && v <= 82 ? "healthy" : v >= 72 ? "watch" : "danger",
  },
  {
    name: "10Y Breakeven Inflation", layer: 3, layer_name: "Business Cycle",
    description: "TIPS-implied 10-year inflation expectation — market pricing",
    fred_series_id: "T10YIE", unit: "%", data_source: "fred", sort_order: 28,
    series: "T10YIE", type: "level",
    statusFn: v => v >= 1.5 && v <= 2.5 ? "healthy" : v <= 3.5 ? "watch" : "danger",
  },
  {
    name: "CPI Growth (3Y Avg)", layer: 3, layer_name: "Business Cycle",
    description: "3-year trailing average of CPI YoY inflation — trend baseline for regime detection",
    fred_series_id: "CPIAUCSL", unit: "%", data_source: "fred", sort_order: 285,
    series: "CPIAUCSL", type: "cpi_3yr_avg",
    statusFn: v => v >= 1 && v <= 2.5 ? "healthy" : v <= 4 ? "watch" : "danger",
  },
  // ── LAYER 4: Tail Risk ──
  {
    name: "VIX", layer: 4, layer_name: "Tail Risk",
    description: "CBOE equity volatility — fear gauge",
    fred_series_id: "VIXCLS", unit: "index", data_source: "fred", sort_order: 29,
    series: "VIXCLS", type: "level",
    statusFn: v => v < 20 ? "healthy" : v < 35 ? "watch" : "danger",
  },
  {
    name: "Consumer Sentiment", layer: 4, layer_name: "Tail Risk",
    description: "University of Michigan confidence — behavioral leading indicator",
    fred_series_id: "UMCSENT", unit: "index", data_source: "fred", sort_order: 30,
    series: "UMCSENT", type: "level",
    statusFn: v => v >= 70 ? "healthy" : v >= 55 ? "watch" : "danger",
  },
  {
    name: "Housing Starts", layer: 4, layer_name: "Tail Risk",
    description: "New residential construction — credit cycle and wealth effect signal",
    fred_series_id: "HOUST", unit: "K", data_source: "fred", sort_order: 31,
    series: "HOUST", type: "level",
    statusFn: v => v >= 1200 ? "healthy" : v >= 800 ? "watch" : "danger",
  },
  {
    name: "M2 Growth (YoY)", layer: 4, layer_name: "Tail Risk",
    description: "Broad money supply growth — monetary stimulus and tightening signal",
    fred_series_id: "M2SL", unit: "%", data_source: "fred", sort_order: 32,
    series: "M2SL", type: "yoy_monthly",
    statusFn: v => v >= 3 && v <= 8 ? "healthy" : v >= -2 ? "watch" : "danger",
  },
  {
    name: "30Y Mortgage Rate", layer: 4, layer_name: "Tail Risk",
    description: "30-year fixed rate — housing affordability and credit transmission",
    fred_series_id: "MORTGAGE30US", unit: "%", data_source: "fred", sort_order: 33,
    series: "MORTGAGE30US", type: "level",
    statusFn: v => v < 6 ? "healthy" : v < 8 ? "watch" : "danger",
  },
  {
    name: "Real Disposable Income (YoY)", layer: 4, layer_name: "Tail Risk",
    description: "Inflation-adjusted household income growth — purchasing power trend",
    fred_series_id: "DSPIC96", unit: "%", data_source: "fred", sort_order: 34,
    series: "DSPIC96", type: "yoy_monthly",
    statusFn: v => v >= 2 ? "healthy" : v >= 0 ? "watch" : "danger",
  },
  {
    name: "10Y Treasury Yield", layer: 4, layer_name: "Tail Risk",
    description: "10-year nominal Treasury yield — risk-free rate and valuation anchor",
    fred_series_id: "DGS10", unit: "%", data_source: "fred", sort_order: 35,
    series: "DGS10", type: "level",
    statusFn: v => v >= 2 && v <= 4.5 ? "healthy" : v <= 6 ? "watch" : "danger",
  },
  {
    name: "Geopolitical Risk Index", layer: 4, layer_name: "Tail Risk",
    description: "Caldara-Iacoviello GPR index (monthly) — text-mined war/conflict/terrorism risk from global news; baseline ≈ 100",
    fred_series_id: null, unit: "index", data_source: "gpr_website", sort_order: 36,
    type: "gpr_website",
    statusFn: v => v < 100 ? "healthy" : v < 200 ? "watch" : "danger",
  },
  // ── LAYER 3 additions: Oil, Energy, Copper ──
  {
    name: "WTI Crude Oil", layer: 3, layer_name: "Business Cycle",
    description: "West Texas Intermediate spot price — energy cost signal; >20% spike in 30 days is a regime trigger",
    fred_series_id: "DCOILWTICO", unit: "$/bbl", data_source: "fred", sort_order: 290,
    series: "DCOILWTICO", type: "level",
    statusFn: v => v < 70 ? "healthy" : v < 90 ? "watch" : "danger",
  },
  {
    name: "Crude Oil Inventories", layer: 3, layer_name: "Business Cycle",
    description: "U.S. commercial crude stocks (weekly EIA, thousand bbl) — low vs 5Y avg = upward price pressure",
    fred_series_id: "WCESTUS1", unit: "Kbbl", data_source: "fred", sort_order: 291,
    series: "WCESTUS1", type: "level",
    statusFn: v => v > 420000 ? "healthy" : v > 370000 ? "watch" : "danger",
  },
  {
    name: "Strategic Petroleum Reserve", layer: 3, layer_name: "Business Cycle",
    description: "U.S. SPR crude stocks (weekly EIA, thousand bbl) — geopolitical cushion; low = vulnerable to supply shocks",
    fred_series_id: "WCSSTUS1", unit: "Kbbl", data_source: "fred", sort_order: 292,
    series: "WCSSTUS1", type: "level",
    statusFn: v => v > 500000 ? "healthy" : v > 350000 ? "watch" : "danger",
  },
  {
    name: "Gasoline Retail Price", layer: 3, layer_name: "Business Cycle",
    description: "U.S. weekly regular gasoline ($/gal) — direct consumer transmission of crude price moves",
    fred_series_id: "GASREGCOVW", unit: "$/gal", data_source: "fred", sort_order: 293,
    series: "GASREGCOVW", type: "level",
    statusFn: v => v < 3.0 ? "healthy" : v < 4.5 ? "watch" : "danger",
  },
  {
    name: "Copper Price", layer: 3, layer_name: "Business Cycle",
    description: "Global copper price (USD/metric ton, monthly) — Dr. Copper: leading indicator of industrial demand and global growth",
    fred_series_id: "PCOPPUSDM", unit: "$/mt", data_source: "fred", sort_order: 294,
    series: "PCOPPUSDM", type: "level",
    statusFn: v => v > 9000 ? "healthy" : v > 7000 ? "watch" : "danger",
  },
];

interface ProcessedRow {
  name: string;
  layer: number;
  layer_name: string;
  description: string;
  fred_series_id: string | null;
  unit: string;
  data_source: string;
  sort_order: number;
  current_value: number;
  previous_value: number;
  change_value: number;
  status: Status;
  last_fetched_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

const fetchErrors: Record<string, string> = {};
let pendingGoldObs: Array<{ date: string; value: number }> = [];

async function processIndicator(ind: Indicator): Promise<ProcessedRow | null> {
  try {
    let current: number, previous: number;
    let metadata: Record<string, unknown> | undefined;
    switch (ind.type) {
      case "level": {
        const obs = await fetchFred(ind.series!, 2);
        if (obs.length < 2) return null;
        current = obs[0]; previous = obs[1];
        break;
      }
      case "yoy_monthly": {
        const obs = await fetchFredObs(ind.series!, 26);
        const yoy = yoyPair(obs);
        if (!yoy) return null;
        current = yoy.current; previous = yoy.previous;
        break;
      }
      case "yoy_monthly_agg": {
        const obs = await fetchFredObsMonthly(ind.series!, 26);
        const yoy = yoyPair(obs);
        if (!yoy) return null;
        current = yoy.current; previous = yoy.previous;
        break;
      }
      case "yoy_quarterly": {
        const obs = await fetchFredObs(ind.series!, 8);
        const yoy = yoyPair(obs);
        if (!yoy) return null;
        current = yoy.current; previous = yoy.previous;
        break;
      }
      case "gdp_3yr_avg": {
        const obs = await fetchFredObs(ind.series!, 20);
        if (obs.length < 17) return null;
        const yoyRates: number[] = [];
        for (let i = 0; i < 13 && i + 4 < obs.length; i++) {
          yoyRates.push((obs[i].value / obs[i + 4].value - 1) * 100);
        }
        if (yoyRates.length < 4) return null;
        const avg12 = yoyRates.slice(0, 12);
        const avg12prev = yoyRates.slice(1, 13);
        current  = avg12.reduce((a, b) => a + b, 0) / avg12.length;
        previous = avg12prev.reduce((a, b) => a + b, 0) / avg12prev.length;
        break;
      }
      case "cpi_3yr_avg": {
        const obs = await fetchFredObs(ind.series!, 50);
        if (obs.length < 14) return null;
        const yoyRates: number[] = [];
        for (let i = 0; i < 36 && i + 12 < obs.length; i++) {
          yoyRates.push((obs[i].value / obs[i + 12].value - 1) * 100);
        }
        if (yoyRates.length < 4) return null;
        const window = Math.min(36, yoyRates.length);
        current  = yoyRates.slice(0, window).reduce((a, b) => a + b, 0) / window;
        previous = yoyRates.slice(1, window + 1).reduce((a, b) => a + b, 0) / window;
        break;
      }
      case "mom_change": {
        const obs = await fetchFred(ind.series!, 3);
        if (obs.length < 3) return null;
        current = obs[0] - obs[1]; previous = obs[1] - obs[2];
        break;
      }
      case "mom_pct": {
        const obs = await fetchFred(ind.series!, 3);
        if (obs.length < 3 || obs[1] === 0 || obs[2] === 0) return null;
        current  = (obs[0] / obs[1] - 1) * 100;
        previous = (obs[1] / obs[2] - 1) * 100;
        break;
      }
      case "computed": {
        const [obs1, obs2] = await Promise.all([fetchFred(ind.series!, 2), fetchFred(ind.series2!, 2)]);
        if (obs1.length < 2 || obs2.length < 2) return null;
        current = obs1[0] - obs2[0]; previous = obs1[1] - obs2[1];
        break;
      }
      case "treasurydirect": {
        const url = "https://www.treasurydirect.gov/TA_WS/securities/auctioned?type=Note&term=10-Year&pagenum=0&pagesize=8&format=json";
        const res = await fetch(url);
        if (!res.ok) throw new Error(`TreasuryDirect: HTTP ${res.status}`);
        const auctions = await res.json() as { bidToCoverRatio?: string }[];
        const valid = auctions.filter(a => a.bidToCoverRatio && parseFloat(a.bidToCoverRatio!) > 0);
        if (valid.length < 2) throw new Error("Not enough auction data");
        current = parseFloat(valid[0].bidToCoverRatio!); previous = parseFloat(valid[1].bidToCoverRatio!);
        break;
      }
      case "supabase_debt_cycle": {
        const { data, error } = await supabase.from("macro_debt_cycle").select("year, debt_to_gdp_pct").not("debt_to_gdp_pct", "is", null).order("year", { ascending: false }).limit(2);
        if (error || !data || data.length < 2) return null;
        current = Number(data[0].debt_to_gdp_pct); previous = Number(data[1].debt_to_gdp_pct);
        break;
      }
      case "debt_tax_ratio": {
        const [debt, tax] = await Promise.all([fetchFred(ind.series!, 2), fetchFred(ind.series2!, 2)]);
        if (debt.length < 2 || tax.length < 2) return null;
        current = debt[0] / tax[0]; previous = debt[1] / tax[1];
        break;
      }
      case "interest_gdp_pct": {
        const [interest, gdp] = await Promise.all([fetchFred(ind.series!, 2), fetchFred(ind.series2!, 2)]);
        if (interest.length < 2 || gdp.length < 2) return null;
        current = interest[0] / gdp[0] * 100; previous = interest[1] / gdp[1] * 100;
        break;
      }
      case "level_minus_yoy_quarterly": {
        const [levels, gdpObs] = await Promise.all([fetchFred(ind.series!, 2), fetchFredObs(ind.series2!, 8)]);
        if (levels.length < 2) return null;
        const gdpYoy = yoyPair(gdpObs);
        if (!gdpYoy) return null;
        current = levels[0] - gdpYoy.current; previous = levels[1] - gdpYoy.previous;
        break;
      }
      case "level_minus_yoy_monthly": {
        const [rates, cpiObs] = await Promise.all([fetchFred(ind.series!, 2), fetchFredObs(ind.series2!, 26)]);
        if (rates.length < 2) return null;
        const cpiYoy = yoyPair(cpiObs);
        if (!cpiYoy) return null;
        current = rates[0] - cpiYoy.current; previous = rates[1] - cpiYoy.previous;
        break;
      }
      case "walcl_pct_gdp": {
        const [walcl, gdp] = await Promise.all([fetchFred(ind.series!, 2), fetchFred(ind.series2!, 2)]);
        if (walcl.length < 2 || gdp.length < 2) return null;
        current = (walcl[0] / 1000) / gdp[0] * 100; previous = (walcl[1] / 1000) / gdp[1] * 100;
        break;
      }
      case "m2_minus_gdp": {
        const [m2Obs, gdpObs] = await Promise.all([fetchFredObs(ind.series!, 26), fetchFredObs(ind.series2!, 8)]);
        const m2Yoy = yoyPair(m2Obs); const gdpYoy = yoyPair(gdpObs);
        if (!m2Yoy || !gdpYoy) return null;
        current = m2Yoy.current - gdpYoy.current; previous = m2Yoy.previous - gdpYoy.previous;
        break;
      }
      case "gpr_website": {
        const res = await fetch("https://www.matteoiacoviello.com/gpr_files/data_gpr_export.xls", {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" },
        });
        if (!res.ok) throw new Error(`GPR website: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const XLSX = await import("npm:xlsx");
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
        const valid = rows
          .filter(r => r.GPR != null && !isNaN(Number(r.GPR)))
          .map(r => Number(r.GPR));
        if (valid.length < 2) return null;
        current = valid[valid.length - 1];
        previous = valid[valid.length - 2];
        break;
      }
      case "gold_3m_avg": {
        const obs = await fetchYahooGold("2y");
        if (obs.length < 100) throw new Error(`gold_3m_avg: only ${obs.length} obs`);
        const half = Math.min(90, Math.floor(obs.length / 2));
        const avgFn = (arr: { value: number }[]) => arr.reduce((s, o) => s + o.value, 0) / arr.length;
        current  = avgFn(obs.slice(0, half));
        previous = avgFn(obs.slice(half, half * 2));
        metadata = { spot_price: Math.round(obs[0].value * 100) / 100 };
        pendingGoldObs = [...obs].reverse();
        break;
      }
      case "cb_gold_imf": {
        let imfOk = false;
        try {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(
            "https://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/IFS/Q.W00.RAXGFX_XDC?startPeriod=2018-Q1",
            { headers: { "Accept": "application/json" }, signal: controller.signal }
          );
          clearTimeout(tid);
          if (res.ok) {
            const j = await res.json();
            const series = j?.CompactData?.DataSet?.Series;
            const rawObs = Array.isArray(series?.Obs) ? series.Obs : (series?.Obs ? [series.Obs] : []);
            const vals = (rawObs as Array<Record<string, string>>)
              .filter(o => o["@OBS_VALUE"] && !isNaN(parseFloat(o["@OBS_VALUE"])))
              .sort((a, b) => a["@TIME_PERIOD"].localeCompare(b["@TIME_PERIOD"]))
              .map(o => parseFloat(o["@OBS_VALUE"]));
            if (vals.length >= 6) {
              const n = vals.length;
              current  = (vals[n - 1] / vals[n - 5] - 1) * 100;
              previous = (vals[n - 2] / vals[n - 6] - 1) * 100;
              imfOk = true;
            }
          }
        } catch { /* IMF not accessible from this runtime */ }
        if (!imfOk) {
          const obs = await fetchYahooGold("2y");
          if (obs.length < 260) throw new Error(`cb_gold fallback: only ${obs.length} obs`);
          current  = (obs[0].value   / obs[252].value - 1) * 100;
          previous = (obs[1].value / obs[253].value - 1) * 100;
        }
        break;
      }
      default: return null;
    }
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const now = new Date().toISOString();
    return {
      name: ind.name, layer: ind.layer, layer_name: ind.layer_name,
      description: ind.description, fred_series_id: ind.fred_series_id,
      unit: ind.unit, data_source: ind.data_source, sort_order: ind.sort_order,
      current_value: round(current), previous_value: round(previous),
      change_value: round(current - previous), status: ind.statusFn(current),
      last_fetched_at: now, updated_at: now,
      ...(metadata ? { metadata } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[macro] ${ind.name}:`, msg);
    fetchErrors[ind.name] = msg;
    return null;
  }
}

function detectRegimeKey(gdpYoy: number, cpiYoy: number, gdp3y: number, inflThreshold: number): string {
  const growing = gdpYoy > gdp3y;
  const rising  = cpiYoy > inflThreshold;
  if (growing && !rising) return "rg_fi";
  if (growing && rising)  return "rg_ri";
  if (!growing && rising) return "fg_ri";
  return "fg_fi";
}

async function backfillRegimeHistory(): Promise<void> {
  try {
    // Skip if we already have recent data (2020+)
    const { data: recentCheck } = await supabase.from("macro_regime_history").select("period_date").gte("period_date", "2020-01-01").limit(1);
    if ((recentCheck?.length ?? 0) > 0) return;

    // Fetch desc (most recent first) for last 25 years, then reverse to chronological
    const [gdpRes, cpiRes, breRes] = await Promise.all([
      fetch(`${FRED}?series_id=GDPC1&api_key=${apiKey}&sort_order=desc&limit=110&file_type=json`),
      fetch(`${FRED}?series_id=CPIAUCSL&api_key=${apiKey}&sort_order=desc&limit=300&file_type=json`),
      fetch(`${FRED}?series_id=T10YIE&api_key=${apiKey}&frequency=m&aggregation_method=avg&sort_order=desc&limit=300&file_type=json`),
    ]);
    const [gdpJson, cpiJson, breJson] = await Promise.all([gdpRes.json(), cpiRes.json(), breRes.json()]);
    const parseObs = (json: { observations: { date: string; value: string }[] }) =>
      (json.observations as { date: string; value: string }[])
        .filter(o => o.value !== "." && o.value !== "")
        .map(o => ({ date: o.date, value: parseFloat(o.value) }))
        .filter(o => !isNaN(o.value))
        .reverse();
    const gdpObs = parseObs(gdpJson);
    const cpiObs = parseObs(cpiJson);
    const breObs = parseObs(breJson);

    // Monthly CPI YoY
    const cpiYoySeries: { year: number; month: number; yoy: number }[] = [];
    for (const cur of cpiObs) {
      const d = new Date(cur.date);
      const ya = cpiObs.find(o => {
        const od = new Date(o.date);
        return od.getUTCFullYear() === d.getUTCFullYear() - 1 && od.getUTCMonth() === d.getUTCMonth();
      });
      if (!ya) continue;
      cpiYoySeries.push({ year: d.getUTCFullYear(), month: d.getUTCMonth(), yoy: (cur.value / ya.value - 1) * 100 });
    }

    // Quarterly GDP YoY
    const gdpYoySeries: { date: string; year: number; quarter: number; yoy: number }[] = [];
    for (const cur of gdpObs) {
      const d = new Date(cur.date);
      const ya = gdpObs.find(o => {
        const od = new Date(o.date);
        return od.getUTCFullYear() === d.getUTCFullYear() - 1 && od.getUTCMonth() === d.getUTCMonth();
      });
      if (!ya) continue;
      gdpYoySeries.push({ date: cur.date, year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1, yoy: (cur.value / ya.value - 1) * 100 });
    }

    // T10YIE by YYYY-MM
    const breMap = new Map<string, number>();
    for (const b of breObs) {
      const d = new Date(b.date);
      breMap.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, b.value);
    }

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const now = new Date().toISOString();
    const historyRows: Record<string, unknown>[] = [];

    for (let qi = 12; qi < gdpYoySeries.length; qi++) {
      const gq = gdpYoySeries[qi];
      const gdp3y = gdpYoySeries.slice(qi - 11, qi + 1).reduce((s, r) => s + r.yoy, 0) / 12;

      const qCpi = cpiYoySeries.filter(m => m.year === gq.year && m.month >= (gq.quarter - 1) * 3 && m.month < gq.quarter * 3);
      if (qCpi.length === 0) continue;
      const cpiYoy = qCpi.reduce((s, m) => s + m.yoy, 0) / qCpi.length;

      const endMn = gq.year * 12 + (gq.quarter * 3 - 1);
      const cpi3ySlice = cpiYoySeries.filter(m => { const mn = m.year * 12 + m.month; return mn >= endMn - 35 && mn <= endMn; });
      if (cpi3ySlice.length < 24) continue;
      const cpi3y = cpi3ySlice.reduce((s, m) => s + m.yoy, 0) / cpi3ySlice.length;

      let breSum = 0, breCount = 0;
      for (let m = 0; m < 3; m++) {
        const mn = (gq.quarter - 1) * 3 + m + 1;
        const bv = breMap.get(`${gq.year}-${String(mn).padStart(2, "0")}`);
        if (bv != null) { breSum += bv; breCount++; }
      }
      const breakeven = breCount > 0 ? breSum / breCount : null;
      const periodDate = `${gq.year}-${String((gq.quarter - 1) * 3 + 1).padStart(2, "0")}-01`;

      historyRows.push({
        period_date: periodDate,
        gdp_yoy: r2(gq.yoy), cpi_yoy: r2(cpiYoy),
        breakeven: breakeven != null ? r2(breakeven) : null,
        gdp_3y_avg: r2(gdp3y), cpi_3y_avg: r2(cpi3y),
        structural_key: detectRegimeKey(gq.yoy, cpiYoy, gdp3y, cpi3y),
        market_key: detectRegimeKey(gq.yoy, cpiYoy, gdp3y, breakeven ?? cpi3y),
        forward_key: null, forward_confidence: null, updated_at: now,
      });
    }

    for (let i = 0; i < historyRows.length; i += 50) {
      const { error } = await supabase.from("macro_regime_history").upsert(historyRows.slice(i, i + 50), { onConflict: "period_date", ignoreDuplicates: false });
      if (error) console.error("[regime_history] backfill upsert:", error);
    }
    console.log(`[regime_history] backfilled ${historyRows.length} quarters`);
  } catch (e) { console.error("[regime_history] backfill:", e); }
}

function computeEdgeFwdSignal(rows: ProcessedRow[]): { forwardKey: string | null; confidence: number | null } {
  const get = (name: string) => { const r = rows.find(r => r.name === name); return r?.current_value != null ? Number(r.current_value) : null; };
  type Sig = { name: string; w: number; vote: (v: number) => number };
  const G: Sig[] = [
    { name: "2yr/10yr Yield Spread",  w: 0.25, vote: v => v > 0.5 ? 1 : v >= 0    ? 0 : -1 },
    { name: "3mo/10yr Yield Spread",  w: 0.20, vote: v => v > 1   ? 1 : v >= 0    ? 0 : -1 },
    { name: "Sr Loan Officer Survey", w: 0.20, vote: v => v < 15  ? 1 : v <= 35   ? 0 : -1 },
    { name: "Conference Board LEI",   w: 0.15, vote: v => v > 0   ? 1 : v >= -0.3 ? 0 : -1 },
    { name: "HY Credit Spread (OAS)", w: 0.10, vote: v => v < 4   ? 1 : v <= 6    ? 0 : -1 },
    { name: "C&I Loan Growth (YoY)",  w: 0.10, vote: v => v > 5   ? 1 : v >= 0    ? 0 : -1 },
  ];
  const I: Sig[] = [
    { name: "Consumer Inflation Expectations", w: 0.25, vote: v => v > 4    ? 1 : v >= 2.5 ? 0 : -1 },
    { name: "10Y Breakeven Inflation",         w: 0.20, vote: v => v > 2.5  ? 1 : v >= 1.5 ? 0 : -1 },
    { name: "Copper Price",                    w: 0.20, vote: v => v > 9000 ? 1 : v >= 7000 ? 0 : -1 },
    { name: "WTI Crude Oil",                   w: 0.15, vote: v => v > 90   ? 1 : v >= 70  ? 0 : -1 },
    { name: "PPI (YoY)",                       w: 0.10, vote: v => v > 3    ? 1 : v >= 0   ? 0 : -1 },
    { name: "M2 Growth (YoY)",                 w: 0.10, vote: v => v > 8    ? 1 : v >= 3   ? 0 : -1 },
  ];
  type ScoreSig = { w: number; vote: number | null };
  const scoreGroup = (sigs: Sig[]): { signals: ScoreSig[]; score: number | null } => {
    let weighted = 0, totalW = 0;
    const signals: ScoreSig[] = sigs.map(s => {
      const val = get(s.name);
      if (val == null) return { w: s.w, vote: null };
      const v = s.vote(val);
      weighted += v * s.w; totalW += s.w;
      return { w: s.w, vote: v };
    });
    return { signals, score: totalW > 0 ? weighted / totalW : null };
  };
  const growth = scoreGroup(G);
  const infl   = scoreGroup(I);
  const THRESH = 0.05;
  const dir = (s: number | null) => s == null ? null : s > THRESH ? "up" : s < -THRESH ? "down" : "neutral";
  const rawGDir = dir(growth.score);
  const rawIDir = dir(infl.score);
  const gDir = rawGDir === "neutral" ? (growth.score! >= 0 ? "up" : "down") : rawGDir;
  const iDir = rawIDir === "neutral" ? (infl.score! >= 0 ? "up" : "down") : rawIDir;
  const forwardKey =
    gDir === "up"   && iDir === "down" ? "rg_fi" :
    gDir === "up"   && iDir === "up"   ? "rg_ri" :
    gDir === "down" && iDir === "up"   ? "fg_ri" :
    gDir === "down" && iDir === "down" ? "fg_fi" : null;
  if (!forwardKey) return { forwardKey: null, confidence: null };
  const consensus = (sigs: ScoreSig[], d: string) => {
    const target = d === "up" ? 1 : -1;
    let agreed = 0, total = 0;
    for (const s of sigs) { if (s.vote == null) continue; total += s.w; if (s.vote === target) agreed += s.w; }
    return total > 0 ? Math.round(agreed / total * 100) : null;
  };
  const gConf = consensus(growth.signals, gDir!);
  const iConf = consensus(infl.signals, iDir!);
  return { forwardKey, confidence: gConf != null && iConf != null ? Math.round((gConf + iConf) / 2) : null };
}

async function backfillForwardSignals(): Promise<void> {
  try {
    const now = new Date();
    const curQStart = `${now.getUTCFullYear()}-${String(Math.floor(now.getUTCMonth() / 3) * 3 + 1).padStart(2, "0")}-01`;
    const { data: pending } = await supabase.from("macro_regime_history").select("period_date").is("forward_key", null).lt("period_date", curQStart).limit(1);
    if (!pending?.length) return;

    const fm = (id: string, extra = "") =>
      fetch(`${FRED}?series_id=${id}&api_key=${apiKey}&sort_order=desc&limit=320${extra}&file_type=json`)
        .then(r => r.json())
        .then((j: { observations: { date: string; value: string }[] }) =>
          (j.observations ?? []).filter(o => o.value !== "." && o.value !== "")
            .map(o => ({ date: o.date, value: parseFloat(o.value) }))
            .filter(o => !isNaN(o.value)).reverse()
        );

    const [t10y2y, t10y3m, baml, mich, t10yie, copper, wti, sloos, usslind, busloans, ppiaco, m2sl] = await Promise.all([
      fm("T10Y2Y",       "&frequency=m&aggregation_method=avg"),
      fm("T10Y3M",       "&frequency=m&aggregation_method=avg"),
      fm("BAMLH0A0HYM2", "&frequency=m&aggregation_method=avg"),
      fm("MICH"),
      fm("T10YIE",       "&frequency=m&aggregation_method=avg"),
      fm("PCOPPUSDM"),
      fm("DCOILWTICO",   "&frequency=m&aggregation_method=avg"),
      fm("DRTSCILM",     "&frequency=q"),
      fm("USSLIND"),
      fm("BUSLOANS"),
      fm("PPIACO"),
      fm("M2SL"),
    ]);

    const bm = (obs: { date: string; value: number }[]) => {
      const m = new Map<string, number>();
      for (const o of obs) m.set(o.date.slice(0, 7), o.value);
      return m;
    };
    // SLOOS is quarterly — remap from quarter-start to quarter-end month key
    const mkSloos = new Map<string, number>();
    for (const o of sloos) {
      const d = new Date(o.date);
      const em = d.getUTCMonth() + 3; // 0-indexed start + 3 = 1-indexed end
      mkSloos.set(`${d.getUTCFullYear()}-${String(em).padStart(2, "0")}`, o.value);
    }
    const yoy = (obs: { date: string; value: number }[]) => {
      const m = new Map<string, number>();
      for (const o of obs) {
        const d = new Date(o.date);
        const yaKey = `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const ya = obs.find(x => x.date.slice(0, 7) === yaKey);
        if (ya) m.set(o.date.slice(0, 7), (o.value / ya.value - 1) * 100);
      }
      return m;
    };

    const mkT10y2y = bm(t10y2y), mkT10y3m = bm(t10y3m), mkBaml = bm(baml);
    const mkMich = bm(mich), mkT10yie = bm(t10yie), mkCopper = bm(copper), mkWti = bm(wti);
    const mkUsslind = bm(usslind), mkBusYoY = yoy(busloans), mkPpiYoY = yoy(ppiaco), mkM2YoY = yoy(m2sl);

    type MapSig = { map: Map<string, number>; w: number; vote: (v: number) => number };
    const GS: MapSig[] = [
      { map: mkT10y2y,  w: 0.25, vote: v => v > 0.5 ? 1 : v >= 0    ? 0 : -1 },
      { map: mkT10y3m,  w: 0.20, vote: v => v > 1   ? 1 : v >= 0    ? 0 : -1 },
      { map: mkSloos,   w: 0.20, vote: v => v < 15  ? 1 : v <= 35   ? 0 : -1 },
      { map: mkUsslind, w: 0.15, vote: v => v > 0   ? 1 : v >= -0.3 ? 0 : -1 },
      { map: mkBaml,    w: 0.10, vote: v => v < 4   ? 1 : v <= 6    ? 0 : -1 },
      { map: mkBusYoY,  w: 0.10, vote: v => v > 5   ? 1 : v >= 0    ? 0 : -1 },
    ];
    const IS: MapSig[] = [
      { map: mkMich,   w: 0.25, vote: v => v > 4    ? 1 : v >= 2.5 ? 0 : -1 },
      { map: mkT10yie, w: 0.20, vote: v => v > 2.5  ? 1 : v >= 1.5 ? 0 : -1 },
      { map: mkCopper, w: 0.20, vote: v => v > 9000 ? 1 : v >= 7000 ? 0 : -1 },
      { map: mkWti,    w: 0.15, vote: v => v > 90   ? 1 : v >= 70  ? 0 : -1 },
      { map: mkPpiYoY, w: 0.10, vote: v => v > 3    ? 1 : v >= 0   ? 0 : -1 },
      { map: mkM2YoY,  w: 0.10, vote: v => v > 8    ? 1 : v >= 3   ? 0 : -1 },
    ];
    type ScoreSig = { w: number; vote: number | null };
    const sg = (sigs: MapSig[], mk: string): { signals: ScoreSig[]; score: number | null } => {
      let weighted = 0, totalW = 0;
      const signals: ScoreSig[] = sigs.map(s => {
        const val = s.map.get(mk);
        if (val == null) return { w: s.w, vote: null };
        const v = s.vote(val); weighted += v * s.w; totalW += s.w;
        return { w: s.w, vote: v };
      });
      return { signals, score: totalW > 0 ? weighted / totalW : null };
    };
    const fwd = (mk: string): { forwardKey: string | null; confidence: number | null } => {
      const g = sg(GS, mk), inf = sg(IS, mk);
      const THRESH = 0.05;
      const dir = (s: number | null) => s == null ? null : s > THRESH ? "up" : s < -THRESH ? "down" : "neutral";
      const rawGd = dir(g.score), rawId = dir(inf.score);
      // fall back to sign when score is in the neutral band
      const gd = rawGd === "neutral" ? (g.score! >= 0 ? "up" : "down") : rawGd;
      const id = rawId === "neutral" ? (inf.score! >= 0 ? "up" : "down") : rawId;
      const fk = gd === "up" && id === "down" ? "rg_fi" : gd === "up" && id === "up" ? "rg_ri" : gd === "down" && id === "up" ? "fg_ri" : gd === "down" && id === "down" ? "fg_fi" : null;
      if (!fk) return { forwardKey: null, confidence: null };
      const cons = (sigs: ScoreSig[], d: string) => { const t = d === "up" ? 1 : -1; let a = 0, tot = 0; for (const s of sigs) { if (s.vote == null) continue; tot += s.w; if (s.vote === t) a += s.w; } return tot > 0 ? Math.round(a / tot * 100) : null; };
      const gc = cons(g.signals, gd!), ic = cons(inf.signals, id!);
      return { forwardKey: fk, confidence: gc != null && ic != null ? Math.round((gc + ic) / 2) : null };
    };

    const { data: rows } = await supabase.from("macro_regime_history").select("period_date").is("forward_key", null).lt("period_date", curQStart).order("period_date");
    if (!rows?.length) return;
    const updates = rows.map(r => {
      const d = new Date(r.period_date);
      const endMon = String(d.getUTCMonth() + 3).padStart(2, "0");
      const mk = `${d.getUTCFullYear()}-${endMon}`;
      const { forwardKey, confidence } = fwd(mk);
      return { period_date: r.period_date, forward_key: forwardKey, forward_confidence: confidence };
    });
    for (let i = 0; i < updates.length; i += 50) {
      await supabase.from("macro_regime_history").upsert(updates.slice(i, i + 50), { onConflict: "period_date" });
    }
    console.log(`[fwd_history] backfilled ${updates.length} forward signals`);
  } catch (e) { console.error("[fwd_history]", e); }
}

async function updateCurrentRegimeHistory(processedRows: ProcessedRow[]): Promise<void> {
  try {
    const gdpRow  = processedRows.find(r => r.name === "Real GDP Growth");
    const cpiRow  = processedRows.find(r => r.name === "CPI (YoY)");
    const breRow  = processedRows.find(r => r.name === "10Y Breakeven Inflation");
    const gdp3yRow = processedRows.find(r => r.name === "GDP Growth (3Y Avg)");
    const cpi3yRow = processedRows.find(r => r.name === "CPI Growth (3Y Avg)");
    if (!gdpRow || !cpiRow) return;

    const gdpYoy = Number(gdpRow.current_value);
    const cpiYoy = Number(cpiRow.current_value);
    const bre    = breRow   ? Number(breRow.current_value)   : null;
    const gdp3y  = gdp3yRow ? Number(gdp3yRow.current_value) : 0;
    const cpi3y  = cpi3yRow ? Number(cpi3yRow.current_value) : cpiYoy;

    const now = new Date();
    const q = Math.floor(now.getUTCMonth() / 3);
    const periodDate = `${now.getUTCFullYear()}-${String(q * 3 + 1).padStart(2, "0")}-01`;
    const r2 = (n: number) => Math.round(n * 100) / 100;

    const { forwardKey, confidence } = computeEdgeFwdSignal(processedRows);
    await supabase.from("macro_regime_history").upsert({
      period_date: periodDate,
      gdp_yoy: r2(gdpYoy), cpi_yoy: r2(cpiYoy),
      breakeven: bre != null ? r2(bre) : null,
      gdp_3y_avg: r2(gdp3y), cpi_3y_avg: r2(cpi3y),
      structural_key: detectRegimeKey(gdpYoy, cpiYoy, gdp3y, cpi3y),
      market_key: detectRegimeKey(gdpYoy, cpiYoy, gdp3y, bre ?? cpi3y),
      forward_key: forwardKey,
      forward_confidence: confidence,
      updated_at: new Date().toISOString(),
    }, { onConflict: "period_date", ignoreDuplicates: false });
  } catch (e) { console.error("[regime_history] current update:", e); }
}

async function updateCurrentYearLongCycle(processedRows: ProcessedRow[]): Promise<void> {
  const currentYear = new Date().getFullYear();
  const priorYear = currentYear - 1;
  const cpiRow = processedRows.find(r => r.name === "CPI (YoY)");
  const m2Row  = processedRows.find(r => r.name === "M2 Growth (YoY)");
  if (!cpiRow || !m2Row) return;
  let nominalGdpYoy: number | null = null;
  try {
    const obs = await fetchFredObs("GDP", 8);
    const yoy = yoyPair(obs);
    if (yoy) nominalGdpYoy = Math.round(yoy.current * 100) / 100;
  } catch (e) { console.error("[macro] nominal GDP fetch:", e); }
  if (nominalGdpYoy === null) return;
  const { data: priorRow } = await supabase.from("macro_debt_cycle").select("debt_to_gdp_pct").eq("year", priorYear).single();
  const priorDebtGdp: number | null = priorRow?.debt_to_gdp_pct ?? null;
  const debtGrowthProxy = m2Row.current_value;
  const estimatedDebtGdp = priorDebtGdp != null
    ? Math.round(priorDebtGdp * ((1 + debtGrowthProxy / 100) / (1 + nominalGdpYoy / 100)) * 10) / 10
    : null;
  const debtUpdate: Record<string, number> = {
    nominal_gdp_yoy: nominalGdpYoy,
    cpi_yoy_annual: Math.round(cpiRow.current_value * 100) / 100,
  };
  if (estimatedDebtGdp !== null) debtUpdate.debt_to_gdp_pct = estimatedDebtGdp;
  const { error: debtErr } = await supabase.from("macro_debt_cycle").upsert({ year: currentYear, ...debtUpdate }, { onConflict: "year", ignoreDuplicates: false });
  if (debtErr) console.error("[macro] debt_cycle upsert:", debtErr);
  const { error: creditErr } = await supabase.from("macro_credit_cycle").upsert({ year: currentYear, total_debt_growth_yoy: Math.round(debtGrowthProxy * 100) / 100 }, { onConflict: "year", ignoreDuplicates: false });
  if (creditErr) console.error("[macro] credit_cycle upsert:", creditErr);
}

async function computeGauge1(): Promise<void> {
  try {
    const [dspicRows, dspicMonthly, gdpObs] = await Promise.all([
      fetchFredAnnual("DSPIC96"), fetchFred("DSPIC96", 1), fetchFred("GDP", 2),
    ]);
    if (!dspicRows.length || !gdpObs.length) return;
    const latestGdpB = gdpObs[0]; const latestDspicB = dspicMonthly[0] ?? null;
    const { data: debtData } = await supabase.from("macro_debt_cycle").select("year, total_nonfinancial_t, debt_to_gdp_pct").not("debt_to_gdp_pct", "is", null).order("year");
    if (!debtData?.length) return;
    const dgAll = debtData.map(r => Number(r.debt_to_gdp_pct));
    const dgMean = dgAll.reduce((s, v) => s + v, 0) / dgAll.length;
    const dgSd = Math.sqrt(dgAll.reduce((s, v) => s + (v - dgMean) ** 2, 0) / dgAll.length) || 1;
    const dspicByYear = Object.fromEntries(dspicRows.map(r => [r.year, r.value])) as Record<number, number>;
    type DiRow = { year: number; ratio: number };
    const diSeries: DiRow[] = debtData
      .filter(r => r.total_nonfinancial_t != null && dspicByYear[r.year] != null)
      .map(r => ({ year: r.year, ratio: (Number(r.total_nonfinancial_t) * 1000) / dspicByYear[r.year] }));
    if (diSeries.length < 10) return;
    const diAll = diSeries.map(r => r.ratio);
    const diMean = diAll.reduce((s, v) => s + v, 0) / diAll.length;
    const diSd = Math.sqrt(diAll.reduce((s, v) => s + (v - diMean) ** 2, 0) / diAll.length) || 1;
    const diByYear = Object.fromEntries(diSeries.map(r => [r.year, r.ratio])) as Record<number, number>;
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    for (const row of debtData.filter(r => r.year >= 2022)) {
      const dspic = dspicByYear[row.year] ?? latestDspicB;
      if (dspic == null) continue;
      let diRatio = diByYear[row.year];
      if (diRatio == null) {
        const estimatedNtT = (Number(row.debt_to_gdp_pct) / 100) * (latestGdpB / 1000);
        diRatio = (estimatedNtT * 1000) / dspic;
      }
      const z_debt_gdp = r3((Number(row.debt_to_gdp_pct) - dgMean) / dgSd);
      const z_debt_income = r3((diRatio - diMean) / diSd);
      const gauge1 = r3((z_debt_gdp + z_debt_income) / 2);
      const { error } = await supabase.from("dalio_gauge_readings").upsert({ year: row.year, z_debt_gdp, z_debt_income, gauge1 }, { onConflict: "year" });
      if (error) console.error(`[gauge1] ${row.year}:`, error);
    }
  } catch (e) { console.error("[gauge1]", e); }
}

async function computeGauge2(): Promise<void> {
  try {
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const stdev = (arr: number[], mu: number) =>
      Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length) || 1;
    const zs = (v: number, mu: number, sd: number) => (v - mu) / sd;
    const [t10y3mObs, dbaaObs, dgs10Obs, cfnaiObs] = await Promise.all([
      fetchFredObsMonthly("T10Y3M", 600),
      fetchFredObsMonthly("DBAA",   800),
      fetchFredObsMonthly("DGS10",  800),
      fetchFredObs("CFNAI",         700),
    ]);
    const [drtscObs, tdspObs] = await Promise.all([
      fetchFredObs("DRTSCILM", 100),
      fetchFredObs("TDSP",     100),
    ]);
    const dgs10Map = new Map(dgs10Obs.map((o: { date: string; value: number }) => [o.date, o.value]));
    const baaSpreadObs = dbaaObs
      .filter((o: { date: string; value: number }) => dgs10Map.has(o.date))
      .map((o: { date: string; value: number }) => ({ date: o.date, value: o.value - (dgs10Map.get(o.date) as number) }));
    if (t10y3mObs.length < 24 || baaSpreadObs.length < 24 || drtscObs.length < 8 || tdspObs.length < 8 || cfnaiObs.length < 24) {
      console.error("[gauge2] insufficient historical data"); return;
    }
    const t10y3mVals = t10y3mObs.map((o: { value: number }) => o.value);
    const baaVals    = baaSpreadObs.map((o: { value: number }) => o.value);
    const drtscVals  = drtscObs.map((o: { value: number }) => o.value);
    const tdspVals   = tdspObs.map((o: { value: number }) => o.value);
    const cfnaiVals  = cfnaiObs.map((o: { value: number }) => o.value);
    const muT = avg(t10y3mVals); const sdT = stdev(t10y3mVals, muT);
    const muB = avg(baaVals);    const sdB = stdev(baaVals,    muB);
    const muD = avg(drtscVals);  const sdD = stdev(drtscVals,  muD);
    const muTD= avg(tdspVals);   const sdTD= stdev(tdspVals,   muTD);
    const muC = avg(cfnaiVals);  const sdC = stdev(cfnaiVals,  muC);
    const zYieldCurve  = r4(-zs(t10y3mVals[0], muT, sdT));
    const zHYSpread    = r4( zs(baaVals[0],     muB, sdB));
    const zLendingStds = r4( zs(drtscVals[0],   muD, sdD));
    const zDebtService = r4( zs(tdspVals[0],   muTD,sdTD));
    const zLEI         = r4(-zs(cfnaiVals[0],   muC, sdC));
    const gauge2 = r4(0.25*zYieldCurve + 0.25*zHYSpread + 0.20*zLendingStds + 0.15*zDebtService + 0.15*zLEI);
    const currentYear = new Date().getFullYear();
    const { error } = await supabase.from("dalio_gauge_readings").upsert(
      { year: currentYear, z_yield_curve: zYieldCurve, z_hy_spread: zHYSpread, z_lending_stds: zLendingStds, z_debt_service: zDebtService, z_lei_momentum: zLEI, gauge2 },
      { onConflict: "year" }
    );
    if (error) console.error("[gauge2] upsert:", error);
  } catch (e) { console.error("[gauge2]", e); }
}

async function computeGauge3(): Promise<void> {
  try {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    const currentYear = new Date().getFullYear();
    const [cpiAnnual, coreCpiAnnual, gdpcAnnual] = await Promise.all([
      fetchFredAnnual("CPIAUCSL"), fetchFredAnnual("CPILFESL"), fetchFredAnnual("GDPC1"),
    ]);
    const yoyFromAnnual = (rows: { year: number; value: number }[]): Record<number, number> => {
      const out: Record<number, number> = {};
      for (let i = 1; i < rows.length; i++) {
        if (rows[i - 1].value > 0) out[rows[i].year] = r2((rows[i].value / rows[i - 1].value - 1) * 100);
      }
      return out;
    };
    const cpiHistYoy = yoyFromAnnual(cpiAnnual);
    const coreCpiHistYoy = yoyFromAnnual(coreCpiAnnual);
    const realGdpHistYoy = yoyFromAnnual(gdpcAnnual);
    const histYears = [...new Set([...Object.keys(cpiHistYoy).map(Number), ...Object.keys(realGdpHistYoy).map(Number)])].filter(y => y < currentYear).sort((a, b) => a - b);
    for (const yr of histYears) {
      const upd: Record<string, unknown> = { year: yr };
      if (cpiHistYoy[yr] != null) upd.cpi_yoy_annual = cpiHistYoy[yr];
      if (coreCpiHistYoy[yr] != null) upd.core_cpi_yoy_annual = coreCpiHistYoy[yr];
      if (realGdpHistYoy[yr] != null) upd.real_gdp_yoy = realGdpHistYoy[yr];
      await supabase.from("macro_debt_cycle").upsert(upd, { onConflict: "year", ignoreDuplicates: false });
    }
    try {
      const [cpiObs, coreObs] = await Promise.all([fetchFredObs("CPIAUCSL", 28), fetchFredObs("CPILFESL", 28)]);
      const obsToYoy = (obs: { date: string; value: number }[]): number[] => {
        const byDate = Object.fromEntries(obs.map(o => [o.date, o.value]));
        return obs
          .filter(o => { const d = new Date(o.date); const ya = new Date(Date.UTC(d.getUTCFullYear()-1, d.getUTCMonth(), 1)).toISOString().slice(0,10); return byDate[ya] != null; })
          .map(o => { const d = new Date(o.date); const ya = new Date(Date.UTC(d.getUTCFullYear()-1, d.getUTCMonth(), 1)).toISOString().slice(0,10); return (o.value / byDate[ya] - 1) * 100; });
      };
      const cpiYoys = obsToYoy(cpiObs); const coreYoys = obsToYoy(coreObs);
      if (cpiYoys.length >= 1) {
        const cpiSpot = r2(cpiYoys[0]);
        const coreSpot = coreYoys.length >= 1 ? r2(coreYoys[0]) : null;
        const upd: Record<string, unknown> = { year: currentYear, cpi_yoy_annual: cpiSpot };
        if (coreSpot != null) upd.core_cpi_yoy_annual = coreSpot;
        await supabase.from("macro_debt_cycle").upsert(upd, { onConflict: "year", ignoreDuplicates: false });
      }
    } catch (e) { console.error("[gauge3] CPI 12mo:", e); }
    try {
      const gdpcObs = await fetchFredObs("GDPC1", 10);
      const byDate = Object.fromEntries(gdpcObs.map(o => [o.date, o.value]));
      const gdpcYoys = gdpcObs
        .filter(o => { const d = new Date(o.date); return byDate[new Date(Date.UTC(d.getUTCFullYear()-1,d.getUTCMonth(),1)).toISOString().slice(0,10)] != null; })
        .map(o => { const d = new Date(o.date); const ya = byDate[new Date(Date.UTC(d.getUTCFullYear()-1,d.getUTCMonth(),1)).toISOString().slice(0,10)]; return (o.value/ya-1)*100; });
      if (gdpcYoys.length >= 1) {
        const gdpSpot = r2(gdpcYoys[0]);
        await supabase.from("macro_debt_cycle").upsert({ year: currentYear, real_gdp_yoy: gdpSpot }, { onConflict: "year", ignoreDuplicates: false });
      }
    } catch (e) { console.error("[gauge3] real GDP 4q:", e); }
    const { data: computed, error: viewErr } = await supabase.from("macro_debt_cycle_computed").select("year,avg3_real,avg3_cpi");
    if (viewErr || !computed?.length) { console.error("[gauge3] view:", viewErr); return; }
    const mean  = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const stdev = (arr: number[], mu: number) => Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length) || 1;
    const rVals = computed.filter(r => r.avg3_real != null).map(r => Number(r.avg3_real));
    const cVals = computed.filter(r => r.avg3_cpi  != null).map(r => Number(r.avg3_cpi));
    const muR = mean(rVals); const sdR = stdev(rVals, muR);
    const muC = mean(cVals); const sdC = stdev(cVals, muC);
    const upserts = computed.filter(r => r.avg3_real != null && r.avg3_cpi != null).map(r => {
      const zReal = r4((Number(r.avg3_real) - muR) / sdR);
      const zCpi  = r4((Number(r.avg3_cpi)  - muC) / sdC);
      return { year: r.year, z_real_growth_3yr: zReal, z_cpi_3yr: zCpi, gauge3: r4((zCpi - zReal) / 2) };
    });
    const { error } = await supabase.from("dalio_gauge_readings").upsert(upserts, { onConflict: "year" });
    if (error) console.error("[gauge3] upsert:", error);
  } catch (e) { console.error("[gauge3]", e); }
}

async function updateIncomeSeries(): Promise<void> {
  try {
    const fredRows = await fetchFredAnnual("MEFAINUSA672N");
    if (fredRows.length < 2) return;
    fredRows.sort((a, b) => a.year - b.year);
    const latestFredYear = fredRows[fredRows.length - 1].year;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const fredUpserts = [];
    for (let i = 1; i < fredRows.length; i++) {
      const yr = fredRows[i].year; const curr = fredRows[i].value; const prev = fredRows[i-1].value;
      fredUpserts.push({ year: yr, real_median_family_income_2024: Math.round(curr), income_yoy: r2((curr/prev-1)*100) });
    }
    await supabase.from("macro_income").upsert(fredUpserts, { onConflict: "year" });
    const currentYear = new Date().getFullYear();
    if (latestFredYear < currentYear) {
      const { data: hudRows } = await supabase.from("hud_national_mfi").select("fiscal_year, national_mfi").gte("fiscal_year", latestFredYear).order("fiscal_year");
      if (hudRows?.length) {
        const hudByYear = Object.fromEntries(hudRows.map(r => [r.fiscal_year, r.national_mfi]));
        const hudUpserts = [];
        for (let yr = latestFredYear + 1; yr <= currentYear; yr++) {
          const hudCurr = hudByYear[yr]; const hudPrev = hudByYear[yr-1];
          if (!hudCurr || !hudPrev) continue;
          hudUpserts.push({ year: yr, income_yoy: r2((hudCurr/hudPrev-1)*100) });
        }
        if (hudUpserts.length) await supabase.from("macro_income").upsert(hudUpserts, { onConflict: "year" });
      }
    }
    try {
      const tdspRows = await fetchFredAnnual("TDSP");
      if (tdspRows.length) await supabase.from("macro_income").upsert(tdspRows.map(r => ({ year: r.year, debt_service_pct: r2(r.value) })), { onConflict: "year" });
    } catch (e) { console.error("[income] TDSP annual:", e); }
    try {
      const tdspLatest = await fetchFredObs("TDSP", 4);
      if (tdspLatest.length) {
        const latest = tdspLatest[0];
        const obsYear = parseInt(latest.date.slice(0, 4));
        if (obsYear >= currentYear) await supabase.from("macro_income").upsert({ year: obsYear, debt_service_pct: r2(latest.value), debt_service_as_of: latest.date }, { onConflict: "year" });
      }
    } catch (e) { console.error("[income] TDSP latest:", e); }
  } catch (e) { console.error("[income]", e); }
}

async function computeGauge4(): Promise<void> {
  try {
    const [{ data: debtRows, error: dErr }, { data: incomeRows, error: iErr }] = await Promise.all([
      supabase.from("macro_credit_cycle").select("year, total_debt_growth_yoy").not("total_debt_growth_yoy", "is", null).order("year"),
      supabase.from("macro_income").select("year, income_yoy").not("income_yoy", "is", null).order("year"),
    ]);
    if (dErr || iErr || !debtRows?.length || !incomeRows?.length) return;
    const mean  = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const stdev = (arr: number[], mu: number) => Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1)) || 1;
    const debtVals = debtRows.map(r => Number(r.total_debt_growth_yoy));
    const incVals  = incomeRows.map(r => Number(r.income_yoy));
    const muD = mean(debtVals); const sdD = stdev(debtVals, muD);
    const muI = mean(incVals);  const sdI = stdev(incVals,  muI);
    const incByYear = Object.fromEntries(incomeRows.map(r => [r.year, Number(r.income_yoy)]));
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    const upserts = debtRows.map(row => {
      const zDebt = r4((Number(row.total_debt_growth_yoy) - muD) / sdD);
      const incYoy = incByYear[row.year];
      const zIncome = incYoy != null ? r4((incYoy - muI) / sdI) : null;
      return { year: row.year, z_debt_growth_income: zDebt, gauge4: zIncome != null ? r4(zDebt - zIncome) : null };
    });
    const { error } = await supabase.from("dalio_gauge_readings").upsert(upserts, { onConflict: "year" });
    if (error) console.error("[gauge4] upsert:", error);
  } catch (e) { console.error("[gauge4]", e); }
}

async function updateConsumerExpectations(): Promise<void> {
  try {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const mean  = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const stdev = (arr: number[], mu: number) => Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1)) || 1;
    const pct = (sorted: number[], p: number) => sorted[Math.floor(sorted.length * p)] ?? 0;
    const michUrl = `${FRED}?series_id=MICH&api_key=${apiKey}&sort_order=asc&file_type=json&limit=700`;
    const michRes = await fetch(michUrl);
    if (!michRes.ok) throw new Error(`MICH: HTTP ${michRes.status}`);
    const michJson = await michRes.json();
    const michRows: { date: string; value: number }[] = (michJson.observations as { date: string; value: string }[])
      .filter(o => o.value !== "." && o.value !== "")
      .map(o => ({ date: o.date, value: parseFloat(o.value) }))
      .filter(o => !isNaN(o.value));
    if (michRows.length < 12) return;
    const nyfedInfMap: Record<string, number> = {};
    const nyfedDelinqMap: Record<string, number> = {};
    try {
      const nyfedRes = await fetch(
        "https://www.newyorkfed.org/medialibrary/interactives/sce/sce/downloads/data/FRBNY-SCE-Data.xlsx",
        { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Referer": "https://www.newyorkfed.org/microeconomics/sce", "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*" }}
      );
      if (nyfedRes.ok) {
        const buf = await nyfedRes.arrayBuffer();
        const XLSX = await import("npm:xlsx");
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const infWs = wb.Sheets["Inflation expectations"];
        if (infWs) {
          const infData = XLSX.utils.sheet_to_json<unknown[]>(infWs, { header: 1, defval: null });
          for (let i = 4; i < infData.length; i++) {
            const row = infData[i] as unknown[];
            if (row[0] == null || row[1] == null) continue;
            const yyyymm = String(Math.round(Number(row[0])));
            if (yyyymm.length !== 6) continue;
            const date = `${yyyymm.slice(0,4)}-${yyyymm.slice(4,6)}-01`;
            const val = parseFloat(String(row[1]));
            if (!isNaN(val)) nyfedInfMap[date] = Math.round(val * 100) / 100;
          }
        }
        const delinqWs = wb.Sheets["Delinquency expectations"];
        if (delinqWs) {
          const delinqData = XLSX.utils.sheet_to_json<unknown[]>(delinqWs, { header: 1, defval: null });
          for (let i = 4; i < delinqData.length; i++) {
            const row = delinqData[i] as unknown[];
            if (row[0] == null || row[1] == null) continue;
            const yyyymm = String(Math.round(Number(row[0])));
            if (yyyymm.length !== 6) continue;
            const date = `${yyyymm.slice(0,4)}-${yyyymm.slice(4,6)}-01`;
            const val = parseFloat(String(row[1]));
            if (!isNaN(val)) nyfedDelinqMap[date] = Math.round(val * 100) / 100;
          }
        }
      }
    } catch (nyfedErr) { console.error("[consumer_exp] NY Fed:", nyfedErr); }
    const michRefVals  = michRows.filter(r => r.date >= "2013-01-01").map(r => r.value);
    const nyfedInfVals = Object.values(nyfedInfMap);
    const nyfedDVals   = Object.values(nyfedDelinqMap);
    const muM  = mean(michRefVals);  const sdM  = stdev(michRefVals, muM);
    const muNI = nyfedInfVals.length > 1 ? mean(nyfedInfVals) : 0; const sdNI = nyfedInfVals.length > 1 ? stdev(nyfedInfVals, muNI) : 1;
    const muND = nyfedDVals.length   > 1 ? mean(nyfedDVals)   : 0; const sdND = nyfedDVals.length   > 1 ? stdev(nyfedDVals, muND)   : 1;
    const allDates = new Set([...michRows.map(r => r.date), ...Object.keys(nyfedInfMap), ...Object.keys(nyfedDelinqMap)]);
    const michMap = Object.fromEntries(michRows.map(r => [r.date, r.value]));
    const upserts = [...allDates].sort().map(date => {
      const mich = michMap[date] ?? null; const nyfInf = nyfedInfMap[date] ?? null; const nyfD = nyfedDelinqMap[date] ?? null;
      const zM = mich!=null?(mich-muM)/sdM:null; const zNI=nyfInf!=null?(nyfInf-muNI)/sdNI:null; const zND=nyfD!=null?(nyfD-muND)/sdND:null;
      const composite = (zM!=null&&zNI!=null&&zND!=null) ? r2(0.5*zND+0.25*zM+0.25*zNI) : null;
      return { survey_date: date, michigan_inf_exp_1yr: mich, nyfed_inf_exp_1yr: nyfInf, nyfed_delinquency_prob: nyfD, composite_stress_z: composite };
    });
    if (upserts.length) await supabase.from("consumer_expectations").upsert(upserts, { onConflict: "survey_date" });
    const compositeVals = upserts.filter(u=>u.composite_stress_z!=null).map(u=>u.composite_stress_z as number).sort((a,b)=>a-b);
    const p50 = pct(compositeVals, 0.50); const p80 = pct(compositeVals, 0.80);
    const latest = michRows[michRows.length-1]; const prev = michRows[michRows.length-2];
    const latestComposite = upserts.filter(u=>u.composite_stress_z!=null).pop();
    const compositeZ = latestComposite?.composite_stress_z ?? r2((latest.value-muM)/sdM);
    const status: Status = compositeZ > p80 ? "danger" : compositeZ > p50 ? "watch" : "healthy";
    const now = new Date().toISOString();
    await supabase.from("macro_indicators").upsert({
      name: "Consumer Inflation Expectations", layer: 3, layer_name: "Business Cycle",
      description: "Michigan Survey 1-yr ahead inflation expectation · NY Fed SCE consumer stress signals",
      fred_series_id: "MICH", unit: "%", data_source: "fred+nyfed", sort_order: 22,
      current_value: r2(latest.value), previous_value: r2(prev.value), change_value: r2(latest.value-prev.value), status,
      last_fetched_at: now, updated_at: now,
    }, { onConflict: "name" });
  } catch (e) { console.error("[consumer_exp]", e); }
}

async function generateNotifications(): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const currentYear = new Date().getFullYear();
    const { data: gaugeRow } = await supabase.from("dalio_gauge_readings").select("gauge1, gauge2, gauge3, gauge4, gauge5").eq("year", currentYear).single();
    if (gaugeRow) {
      const gaugeSnaps = (["gauge1","gauge2","gauge3","gauge4","gauge5"] as const)
        .filter(k => (gaugeRow as Record<string,unknown>)[k] != null)
        .map(k => ({ snapshot_date: today, gauge_key: k, value: Number((gaugeRow as Record<string,unknown>)[k]) }));
      if (gaugeSnaps.length) await supabase.from("gauge_daily_snapshots").upsert(gaugeSnaps, { onConflict: "snapshot_date,gauge_key", ignoreDuplicates: false });
    }
    const notifs: Record<string, unknown>[] = [];
    const { data: priorIndRow } = await supabase.from("macro_snapshots").select("snapshot_date").lt("snapshot_date", today).order("snapshot_date", { ascending: false }).limit(1).single();
    if (priorIndRow) {
      const priorDate = priorIndRow.snapshot_date;
      const { data: snaps } = await supabase.from("macro_snapshots").select("indicator_name, snapshot_date, value, status").in("snapshot_date", [today, priorDate]);
      if (snaps?.length) {
        type SnapDay = { value: number; status: string };
        const byName: Record<string, Record<string, SnapDay>> = {};
        for (const s of snaps) {
          if (!byName[s.indicator_name]) byName[s.indicator_name] = {};
          byName[s.indicator_name][s.snapshot_date] = { value: Number(s.value), status: s.status };
        }
        for (const [name, days] of Object.entries(byName)) {
          const t = days[today], p = days[priorDate];
          if (!t || !p) continue;
          const statusChanged = t.status !== p.status;
          const valueDiff = Math.abs(t.value - p.value);
          if (!statusChanged && valueDiff < 0.05) continue;
          let importance = "low";
          if (statusChanged && (t.status==="danger"||p.status==="danger")) importance="high";
          else if (statusChanged) importance="medium";
          const dir = t.value > p.value ? "↑" : "↓";
          const title = statusChanged ? `${name}: ${p.status} → ${t.status}` : `${name} ${dir} ${p.value.toFixed(2)} → ${t.value.toFixed(2)}`;
          notifs.push({ category:"indicator", type:statusChanged?"status_change":"value_change", importance, title, description:statusChanged?`${p.value.toFixed(2)} → ${t.value.toFixed(2)}`:null, metadata:{indicator:name,prior_value:p.value,new_value:t.value,prior_status:p.status,new_status:t.status}, dedup_key:`ind_${name.toLowerCase().replace(/\W+/g,"_")}_${statusChanged?"s":"v"}_${today}` });
        }
      }
    }
    if (notifs.length) {
      const { error } = await supabase.from("notifications").upsert(notifs, { onConflict: "dedup_key", ignoreDuplicates: true });
      if (error) console.error("[notify] upsert:", error);
    }
  } catch (e) { console.error("[notify]", e); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!apiKey) return new Response(JSON.stringify({ error: "FRED_API_KEY not set" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  const fredIndicators = INDICATORS.filter(i => i.type !== "gpr_website");
  const externalIndicators = INDICATORS.filter(i => i.type === "gpr_website");
  const results = await Promise.allSettled(fredIndicators.map(processIndicator));
  const rows: ProcessedRow[] = results.map((r) => (r.status === "fulfilled" ? r.value : null)).filter((r): r is ProcessedRow => r !== null);
  for (const ind of externalIndicators) {
    const row = await processIndicator(ind);
    if (row) rows.push(row);
  }
  const { error: upsertErr } = await supabase.from("macro_indicators").upsert(rows, { onConflict: "name", ignoreDuplicates: false });
  if (upsertErr) {
    return new Response(JSON.stringify({ error: upsertErr.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const today = new Date().toISOString().slice(0, 10);
  const snapshots = rows.map((r) => ({ indicator_name: r.name, snapshot_date: today, value: r.current_value, status: r.status }));
  await supabase.from("macro_snapshots").upsert(snapshots, { onConflict: "indicator_name,snapshot_date", ignoreDuplicates: false });
  EdgeRuntime.waitUntil((async () => {
    // Gold upsert runs first so it completes before the heavier gauge computations
    if (pendingGoldObs.length > 0) {
      const obsToWrite = pendingGoldObs;
      pendingGoldObs = [];
      const now = new Date().toISOString();
      let runSum = 0;
      const goldRows = obsToWrite.map((o, i) => {
        runSum += o.value;
        if (i >= 90) runSum -= obsToWrite[i - 90].value;
        const winLen = Math.min(i + 1, 90);
        return { date: o.date, close_price: Math.round(o.value * 100) / 100, avg_90d: Math.round(runSum / winLen * 100) / 100, updated_at: now };
      });
      for (let i = 0; i < goldRows.length; i += 100) {
        await supabase.from("gold_daily_prices").upsert(goldRows.slice(i, i + 100), { onConflict: "date", ignoreDuplicates: false });
      }
    }
    await backfillRegimeHistory();
    await updateCurrentRegimeHistory(rows);
    await backfillForwardSignals();
    await updateCurrentYearLongCycle(rows);
    await computeGauge1();
    await computeGauge2();
    await computeGauge3();
    await updateIncomeSeries();
    await computeGauge4();
    await updateConsumerExpectations();
    await generateNotifications();
  })());
  return new Response(
    JSON.stringify({
      updated: rows.length,
      skipped: (fredIndicators.length + externalIndicators.length) - rows.length,
      snapshotted: snapshots.length,
      timestamp: new Date().toISOString(),
      errors: Object.keys(fetchErrors).length ? fetchErrors : undefined,
    }),
    { headers: { ...CORS, "Content-Type": "application/json" } }
  );
});

