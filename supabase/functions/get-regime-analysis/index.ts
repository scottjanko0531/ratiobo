import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REGIME_LABELS: Record<string, string> = {
  rg_fi: "Disinflationary Boom",
  rg_ri: "Reflation",
  fg_ri: "Stagflation",
  fg_fi: "Deflationary Bust",
};

interface MarketTick { name: string; price: number; changePct: number; }
interface NewsItem { headline: string; source: string; publishedAt: number; }
interface SupplyChainRisk {
  name: string; category: string; score: number; status: string; trend: string;
  primaryThreat: string | null; concentration: string | null; riskType: string | null;
}
interface CreditIndicator { name: string; value: number | null; status: string | null; }
type YieldCurveState = "inverted" | "normalizing_from_inversion" | "never_inverted_steep" | "unknown";

// ── News helpers (same RSS approach as get-macro-news) ────────────────────────
function getText(block: string, tag: string): string {
  const open = "<" + tag;
  const close = "</" + tag + ">";
  const start = block.indexOf(open);
  if (start === -1) return "";
  const gt = block.indexOf(">", start);
  if (gt === -1) return "";
  const end = block.indexOf(close, gt);
  if (end === -1) return "";
  return block.slice(gt + 1, end).trim();
}
function getSource(block: string): string {
  const start = block.indexOf("<source");
  if (start === -1) return "";
  const gt = block.indexOf(">", start);
  if (gt === -1) return "";
  const end = block.indexOf("</source>", gt);
  if (end === -1) return "";
  return block.slice(gt + 1, end).trim();
}
function cleanTitle(title: string, source: string): string {
  const suffix = " - " + source;
  return source && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}
function stripMarkdown(text: string, opts: { allowBullets?: boolean } = {}): string {
  let out = text
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1");
  if (!opts.allowBullets) out = out.replace(/^[-*]\s+/gm, "");
  else out = out.replace(/^\*\s+/gm, "- "); // normalize "* " bullets to "- "
  return out.trim();
}

// Confidence language must be pulled from a fixed band, never chosen freely by
// the model — this is what keeps prose like "confidence is high" from
// contradicting a stored 37% forward-signal number.
function confidenceQualifier(pct: number | null): string {
  if (pct == null) return "unstated confidence";
  if (pct <= 33) return "low confidence";
  if (pct <= 60) return "moderate confidence";
  if (pct <= 80) return "high confidence";
  return "very high confidence";
}

async function fetchMacroVoices(): Promise<NewsItem | null> {
  const urls = [
    "https://www.macrovoices.com/feed/podcast",
    "https://www.macrovoices.com/feed",
  ];
  for (const feedUrl of urls) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const s = xml.indexOf("<item>");
      if (s === -1) continue;
      const e = xml.indexOf("</item>", s);
      if (e === -1) continue;
      const block = xml.slice(s + 6, e);
      const title = getText(block, "title");
      if (!title) continue;
      const pubDate = getText(block, "pubDate");
      let sub = getText(block, "itunes:subtitle") || getText(block, "description") || "";
      sub = sub.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").slice(0, 140).trim();
      const headline = sub ? `${title} — ${sub}` : title;
      const ts = pubDate ? new Date(pubDate).getTime() : 0;
      return { headline, source: "MacroVoices", publishedAt: isNaN(ts) ? 0 : Math.floor(ts / 1000) };
    } catch { continue; }
  }
  return null;
}

async function fetchTopNews(limit = 5): Promise<NewsItem[]> {
  const queries = [
    "Federal Reserve inflation interest rates",
    "GDP economic growth recession",
    "CPI inflation consumer prices",
    "gold oil commodities macro economy",
    "Treasury bonds yield curve",
  ];
  try {
    const results = await Promise.all(queries.map(async (q) => {
      const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)" } });
      if (!res.ok) return [] as NewsItem[];
      const xml = await res.text();
      const items: NewsItem[] = [];
      let pos = 0;
      while (true) {
        const s = xml.indexOf("<item>", pos);
        if (s === -1) break;
        const e = xml.indexOf("</item>", s);
        if (e === -1) break;
        const block = xml.slice(s + 6, e);
        pos = e + 7;
        const raw = getText(block, "title");
        const pubDate = getText(block, "pubDate");
        const source = getSource(block);
        if (!raw) continue;
        const ts = pubDate ? new Date(pubDate).getTime() : 0;
        items.push({ headline: cleanTitle(raw, source), source, publishedAt: isNaN(ts) ? 0 : Math.floor(ts / 1000) });
      }
      return items;
    }));
    const seen = new Set<string>();
    const all: NewsItem[] = [];
    for (const items of results) {
      for (const item of items) {
        if (!seen.has(item.headline)) { seen.add(item.headline); all.push(item); }
      }
    }
    return all.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, limit);
  } catch { return []; }
}

// ── Market snapshot ───────────────────────────────────────────────────────────
async function getMarketSnapshot(): Promise<MarketTick[]> {
  const tickers = [
    { key: "SPY",    name: "S&P 500"       },
    { key: "QQQ",    name: "Nasdaq 100"    },
    { key: "IWM",    name: "Russell 2000"  },
    { key: "GLD",    name: "Gold"          },
    { key: "CL%3DF", name: "WTI Oil"       },
    { key: "TLT",    name: "20Y Treasuries"},
    { key: "%5EVIX", name: "VIX"           },
    { key: "DX-Y.NYB", name: "DXY"        },
  ];
  const results = await Promise.all(tickers.map(async ({ key, name }) => {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${key}?interval=1d&range=5d`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; macro-dashboard/1.0)" } }
      );
      if (!res.ok) return null;
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
      const valid = closes.filter((v): v is number => v != null);
      if (valid.length < 2) return null;
      const price = valid[valid.length - 1];
      const prev  = valid[valid.length - 2];
      return { name, price, changePct: ((price - prev) / prev) * 100 } satisfies MarketTick;
    } catch { return null; }
  }));
  return results.filter((r): r is MarketTick => r !== null);
}

// ── Supply chain risk snapshot ──────────────────────────────────────────────────
async function getSupplyChainRisks(sb: ReturnType<typeof createClient>): Promise<SupplyChainRisk[]> {
  const { data } = await sb
    .from("supply_chain_items")
    .select("name,category,current_score,current_status,current_trend,primary_threat,concentration,risk_type")
    .eq("is_active", true)
    .order("current_score", { ascending: false });
  return (data ?? [])
    .filter((r: { current_score: number | null }) => r.current_score != null)
    .map((r: {
      name: string; category: string; current_score: number; current_status: string;
      current_trend: string | null; primary_threat: string | null; concentration: string | null; risk_type: string | null;
    }) => ({
      name: r.name, category: r.category, score: r.current_score,
      status: r.current_status, trend: r.current_trend ?? "stable",
      primaryThreat: r.primary_threat, concentration: r.concentration, riskType: r.risk_type,
    }));
}

// ── Yield curve state (3-state model) ───────────────────────────────────────────
// A positive 2/10 spread means very different things depending on recent history:
// still-inverted, just-normalized-from-inversion (the historically volatile,
// recession-adjacent transition), or never inverted at all (an ordinary steep
// curve, not a recession signal). Fetches ~24 months of FRED's own T10Y2Y series
// directly rather than inferring state from a single point-in-time value.
async function getYieldCurveState(): Promise<{ value: number | null; state: YieldCurveState }> {
  try {
    const url = `${FRED}?series_id=T10Y2Y&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=550`;
    const res = await fetch(url);
    if (!res.ok) return { value: null, state: "unknown" };
    const j = await res.json();
    const obs = (j.observations ?? []) as { date: string; value: string }[];
    const vals = obs.map((o) => parseFloat(o.value)).filter((v) => !isNaN(v));
    if (vals.length === 0) return { value: null, state: "unknown" };
    const current = vals[0]; // sort_order=desc -> most recent first
    const wasInvertedTrailing24mo = vals.some((v) => v < 0);
    const state: YieldCurveState = current < 0 ? "inverted" : wasInvertedTrailing24mo ? "normalizing_from_inversion" : "never_inverted_steep";
    return { value: current, state };
  } catch { return { value: null, state: "unknown" }; }
}

const YIELD_CURVE_STATE_NOTE: Record<YieldCurveState, string> = {
  inverted: "currently inverted — the classic pre-recession signal, still active",
  normalizing_from_inversion: "positive now but was inverted within the trailing 24 months — historically the more volatile, recession-adjacent transition period, not a blanket recession signal on its own",
  never_inverted_steep: "positive and has NOT been inverted at any point in the trailing 24 months — an ordinary steep curve, not a recession warning by itself",
  unknown: "state could not be determined from FRED",
};

interface FedOdds {
  meetingLabel: string;
  meetingDate: string;
  currentUpper: number;
  pHike: number; pHold: number; pCut: number;
  asOf: string;
}

// Market-implied Fed policy odds (Kalshi's public FOMC markets, no auth
// required) for the next FOMC meeting — a ground truth the news-musing pass
// can be reconciled against, since headline sentiment and priced odds can
// (and did, per the review that prompted this) point opposite directions.
// Kalshi lists one binary "will the upper bound end up above $X" market per
// 25bp strike; the current-rate strike's YES price is P(hike), the strike one
// notch below minus that is P(hold), and the remainder is P(cut).
async function getFedRateOdds(): Promise<FedOdds | null> {
  try {
    const fredRes = await fetch(`${FRED}?series_id=DFEDTARU&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`);
    if (!fredRes.ok) return null;
    const fredJ = await fredRes.json();
    const currentUpper = parseFloat(fredJ.observations?.[0]?.value);
    if (isNaN(currentUpper)) return null;

    const evRes = await fetch("https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFED&status=open");
    if (!evRes.ok) return null;
    const evJ = await evRes.json();
    const events = (evJ.events ?? []) as { event_ticker: string; title: string; strike_date?: string }[];
    if (events.length === 0) return null;
    const nextEvent = events[0]; // Kalshi returns these in ascending meeting-date order

    const mkRes = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${nextEvent.event_ticker}`);
    if (!mkRes.ok) return null;
    const mkJ = await mkRes.json();
    const markets = (mkJ.markets ?? []) as { floor_strike: number; yes_ask_dollars: string; yes_bid_dollars: string }[];
    const yesProb = (strike: number): number | null => {
      const m = markets.find((mk) => Math.abs(mk.floor_strike - strike) < 0.01);
      if (!m) return null;
      const bid = parseFloat(m.yes_bid_dollars), ask = parseFloat(m.yes_ask_dollars);
      return !isNaN(bid) && !isNaN(ask) ? (bid + ask) / 2 : null;
    };
    const pAboveCurrent = yesProb(currentUpper);       // P(hike)
    const pAboveOneCutDown = yesProb(currentUpper - 0.25); // P(no cut, i.e. hold-or-hike)
    if (pAboveCurrent == null || pAboveOneCutDown == null) return null;

    return {
      meetingLabel: nextEvent.title,
      meetingDate: nextEvent.strike_date ?? "",
      currentUpper,
      pHike: Math.round(pAboveCurrent * 100),
      pHold: Math.round((pAboveOneCutDown - pAboveCurrent) * 100),
      pCut: Math.round((1 - pAboveOneCutDown) * 100),
      asOf: new Date().toISOString(),
    };
  } catch { return null; }
}

// ── Live regime detection (structural / market / forward) ──────────────────────
// Ported verbatim from fetch-macro-data's detectRegimeKey + computeEdgeFwdSignal
// (and the frontend's identical computeForwardSignal) so all three surfaces
// agree by construction. Computed here from the same macro_indicators snapshot
// this request already fetched, rather than trusting the once-nightly
// macro_regime_history cache, which was found to silently go a full day stale.
function detectRegimeKeyLive(gdpYoy: number, cpiYoy: number, gdp3y: number, cpi3y: number): string {
  const growing = gdpYoy > gdp3y;
  const rising = cpiYoy > cpi3y;
  if (growing && !rising) return "rg_fi";
  if (growing && rising) return "rg_ri";
  if (!growing && rising) return "fg_ri";
  return "fg_fi";
}

type Getter = (name: string) => number | null;

function computeLiveRegimeKeys(
  get: Getter, getPrev: Getter, getMeta3m: Getter,
): { structuralKey: string | null; marketKey: string | null; fwdKey: string | null; fwdConf: number | null } {
  const gdpYoy = get("Real GDP Growth");
  const cpiYoy = get("CPI (YoY)");
  const gdp3y = get("GDP Growth (3Y Avg)");
  const cpi3y = get("CPI Growth (3Y Avg)");
  const breakeven = get("10Y Breakeven Inflation");

  const structuralKey = gdpYoy != null && cpiYoy != null
    ? detectRegimeKeyLive(gdpYoy, cpiYoy, gdp3y ?? 0, cpi3y ?? cpiYoy)
    : null;

  const marketKey = gdpYoy != null && gdp3y != null
    ? (() => {
        const mktInflUp = (breakeven ?? 2.5) > 2.5;
        const mktGrowthUp = gdpYoy > gdp3y;
        return mktGrowthUp ? (mktInflUp ? "rg_ri" : "rg_fi") : (mktInflUp ? "fg_ri" : "fg_fi");
      })()
    : null;

  type Sig = { name: string; w: number; useDir?: boolean; usePct3m?: boolean; vote: (v: number) => number };
  const G: Sig[] = [
    { name: "2yr/10yr Yield Spread",  w: 0.25, vote: v => v > 0.5 ? 1 : v >= 0    ? 0 : -1 },
    { name: "3mo/10yr Yield Spread",  w: 0.20, vote: v => v > 1   ? 1 : v >= 0    ? 0 : -1 },
    { name: "Sr Loan Officer Survey", w: 0.20, vote: v => v < 15  ? 1 : v <= 35   ? 0 : -1 },
    { name: "Conference Board LEI",   w: 0.15, vote: v => v > 0   ? 1 : v >= -0.3 ? 0 : -1 },
    { name: "HY Credit Spread (OAS)", w: 0.10, vote: v => v < 4   ? 1 : v <= 6    ? 0 : -1 },
    { name: "C&I Loan Growth (YoY)",  w: 0.10, vote: v => v > 5   ? 1 : v >= 0    ? 0 : -1 },
  ];
  const I: Sig[] = [
    { name: "CPI (YoY)",                       w: 0.20, useDir: true,   vote: v => v < -5  ? -1 : v > 5  ? 1 : 0 },
    { name: "PPI (YoY)",                       w: 0.10, useDir: true,   vote: v => v < -5  ? -1 : v > 5  ? 1 : 0 },
    { name: "10Y Breakeven Inflation",         w: 0.20,                 vote: v => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
    { name: "Consumer Inflation Expectations", w: 0.15,                 vote: v => v > 5.5 ? 1 : v >= 2.5 ? 0 : -1 },
    { name: "Copper Price",                    w: 0.15, usePct3m: true, vote: v => v > 5   ? 1 : v >= -5 ? 0 : -1 },
    { name: "WTI Crude Oil",                   w: 0.10, usePct3m: true, vote: v => v > 5   ? 1 : v >= -5 ? 0 : -1 },
    { name: "M2 Growth (YoY)",                 w: 0.10,                 vote: v => v > 8   ? 1 : v >= 3  ? 0 : -1 },
  ];
  const getDirPct = (name: string): number | null => {
    const curr = get(name), prev = getPrev(name);
    return curr != null && prev != null && prev !== 0 ? (curr - prev) / Math.abs(prev) * 100 : null;
  };
  type Scored = { w: number; vote: number | null };
  const scoreGroup = (sigs: Sig[]): { signals: Scored[]; score: number | null } => {
    let weighted = 0, totalW = 0;
    const signals = sigs.map((s) => {
      const val = s.useDir ? getDirPct(s.name) : s.usePct3m ? getMeta3m(s.name) : get(s.name);
      if (val == null) return { w: s.w, vote: null };
      const v = s.vote(val);
      weighted += v * s.w; totalW += s.w;
      return { w: s.w, vote: v };
    });
    return { signals, score: totalW > 0 ? weighted / totalW : null };
  };
  const growth = scoreGroup(G);
  const infl = scoreGroup(I);
  const THRESH = 0.05;
  const dir = (s: number | null) => s == null ? null : s > THRESH ? "up" : s < -THRESH ? "down" : "neutral";
  const rawGDir = dir(growth.score);
  const rawIDir = dir(infl.score);
  const gDir = rawGDir === "neutral" ? (growth.score! >= 0 ? "up" : "down") : rawGDir;
  const iDir = rawIDir === "neutral" ? (infl.score! >= 0 ? "up" : "down") : rawIDir;
  const fwdKey =
    gDir === "up" && iDir === "down" ? "rg_fi" :
    gDir === "up" && iDir === "up" ? "rg_ri" :
    gDir === "down" && iDir === "up" ? "fg_ri" :
    gDir === "down" && iDir === "down" ? "fg_fi" : null;

  let fwdConf: number | null = null;
  if (fwdKey && gDir && iDir) {
    const consensus = (signals: Scored[], d: string): number | null => {
      const target = d === "up" ? 1 : -1;
      let agreed = 0, total = 0;
      for (const s of signals) { if (s.vote == null) continue; total += s.w; if (s.vote === target) agreed += s.w; }
      return total > 0 ? Math.round(agreed / total * 100) : null;
    };
    const gConf = consensus(growth.signals, gDir);
    const iConf = consensus(infl.signals, iDir);
    fwdConf = gConf != null && iConf != null ? Math.round((gConf + iConf) / 2) : null;
  }

  return { structuralKey, marketKey, fwdKey, fwdConf };
}

// ── Reference block shared by the main prompt and the consistency checker ──────
// Keeping this in one place means the "ground truth" the model is constrained
// against and the "ground truth" the validator checks against never drift apart.
function buildReferenceBlock(p: {
  regimeLabel: string; marketLabel: string | null; fwdLabel: string | null; fwdConf: number | null;
  qualifier: string; yieldCurveValue: number | null; yieldCurveState: YieldCurveState;
  credit: CreditIndicator[];
}): string {
  const creditLines = p.credit
    .map((c) => `  ${c.name}: ${c.value != null ? c.value : "n/a"}${c.status ? ` (${c.status.toUpperCase()})` : ""}`)
    .join("\n");
  return `Structural regime: ${p.regimeLabel}
Market-implied regime: ${p.marketLabel ?? "unknown"}
Forward signal: ${p.fwdLabel ?? "none"}${p.fwdConf != null ? `, ${p.fwdConf}% confidence — must be described as "${p.qualifier}"` : ""}
2/10 yield curve: ${p.yieldCurveValue != null ? p.yieldCurveValue.toFixed(2) + "%" : "n/a"} — ${YIELD_CURVE_STATE_NOTE[p.yieldCurveState]}
Credit stress indicators (lead recessions; HEALTHY = no stress despite any bust narrative):
${creditLines}`;
}

// ── Main regime analysis ──────────────────────────────────────────────────────
async function generateAnalysis(params: {
  regimeLabel: string; marketLabel: string | null; fwdLabel: string | null;
  fwdConf: number | null; divergence: boolean;
  gdp: number | null; cpi: number | null; ppi: number | null; t10y2y: number | null;
  lei: number | null; breakeven: number | null;
  prevGdp: number | null; prevCpi: number | null; prevPpi: number | null;
  prevLei: number | null; prevBe: number | null;
  marketSnapshot: MarketTick[];
  supplyChain: SupplyChainRisk[];
  yieldCurveState: YieldCurveState;
  credit: CreditIndicator[];
  correction?: string; // set on the one-shot retry after a failed consistency check
}): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const {
      regimeLabel, marketLabel, fwdLabel, fwdConf, divergence,
      gdp, cpi, ppi, t10y2y, lei, breakeven,
      prevGdp, prevCpi, prevPpi, prevLei, prevBe,
      marketSnapshot, supplyChain, yieldCurveState, credit, correction,
    } = params;

    const qualifier = confidenceQualifier(fwdConf);

    const mktLines = marketSnapshot
      .map(m => `${m.name}: ${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(1)}%`)
      .join(" | ");
    const scLines = supplyChain
      .filter(s => s.status === "critical" || s.trend === "worsening")
      .slice(0, 6)
      .map(s => `  ${s.score} ${s.status.toUpperCase()}/${s.trend} [${(s.riskType ?? "unclassified").toUpperCase()}] — ${s.name} (${s.category})${s.primaryThreat ? `: ${s.primaryThreat}` : ""}`)
      .join("\n");
    const creditLines = credit
      .map(c => `  ${c.name}: ${c.value != null ? c.value : "n/a"}${c.status ? ` (${c.status.toUpperCase()})` : ""}`)
      .join("\n");
    const anyCreditHealthy = credit.some(c => c.status === "healthy");

    const n = (v: number | null, d = 1, plus = false) =>
      v != null ? `${plus && v >= 0 ? "+" : ""}${v.toFixed(d)}%` : "n/a";
    const delta = (curr: number | null, prev: number | null) => {
      if (curr == null || prev == null) return "";
      const d = curr - prev;
      return ` (${d >= 0 ? "+" : ""}${d.toFixed(2)} vs prior)`;
    };
    const arrow = (curr: number | null, prev: number | null, threshold = 0.05) => {
      if (curr == null || prev == null) return "→";
      return curr > prev + threshold ? "↑" : curr < prev - threshold ? "↓" : "→";
    };

    const gdpUp  = gdp != null && prevGdp != null && gdp > prevGdp + 0.05;
    const inflUp = cpi != null && prevCpi != null && cpi > prevCpi + 0.05;
    const momentumRegime =
       gdpUp && inflUp  ? "Reflation" :
       gdpUp && !inflUp ? "Disinflationary Boom" :
      !gdpUp && inflUp  ? "Stagflation" : "Deflationary Bust";
    const momentumDiverges = momentumRegime !== regimeLabel;

    const prompt = `You are Clio, macro analyst at RatioBo, using the Dalio/Bridgewater four-quadrant framework. Write direct, sharp analysis — no hedging language, no fluff, under 400 words total. No markdown headers, no bold, no title line.
${correction ? `\nCORRECTION REQUIRED — your previous draft was flagged for these factual/consistency problems; fix all of them in this rewrite:\n${correction}\n` : ""}
PORTFOLIO FRAMEWORK — BW Modified (structural base, always held):
  US Equities 20% · International 8% · EM 5% · Nominal Bonds 20% · TIPS 20% · Commodities 12% · Gold 12% · Cash 3%
  Rationale: Bridgewater's 2025–2026 thesis holds that the old paradigm (US-heavy, equity-heavy, long nominal bonds) is broken. Modern mercantilism, AI-driven commodity demand, and CB gold accumulation create structural bids for real assets regardless of the cyclical quadrant. BW Modified is the resilient base. Regime-specific tilts are overlays on top of it, only when the signal is unambiguous.

CONFIDENCE LANGUAGE — HARD CONSTRAINT: Any time you describe how confident we should be in a regime transition (structural, momentum-implied, or forward), you MUST use language consistent with "${qualifier}" — this is derived directly from the ${fwdConf ?? "n/a"}% forward-signal confidence stored on this page. Never use stronger language (e.g. "high confidence," "unambiguous," "clearly confirmed") than that band supports, and never contradict it elsewhere in the piece.

You have five signals that may conflict. Reconcile them explicitly.

SIGNAL 1 — Structural regime (level-based, 3Y trailing averages):
  ${regimeLabel}

SIGNAL 2 — Structural momentum (direction of hard data, 15–60 day lag):
  GDP:      ${n(gdp, 2, true)}${delta(gdp, prevGdp)} ${arrow(gdp, prevGdp)}
  CPI:      ${n(cpi, 2)}${delta(cpi, prevCpi)} ${arrow(cpi, prevCpi)}
  PPI:      ${n(ppi, 2, true)}${delta(ppi, prevPpi)} ${arrow(ppi, prevPpi)}
  10Y BE:   ${n(breakeven, 2)}${delta(breakeven, prevBe)} ${arrow(breakeven, prevBe, 0.02)}
  LEI:      ${n(lei, 2, true)}${delta(lei, prevLei)} ${arrow(lei, prevLei)}
  2/10 spread: ${n(t10y2y, 2, true)} — ${YIELD_CURVE_STATE_NOTE[yieldCurveState]}
  Yield-curve framing constraint: only describe the curve as a "recession warning" if its state is normalizing_from_inversion. If never_inverted_steep, do not call it a recession signal. If inverted, call it an active inversion, not a normalization story.
  Momentum-implied regime: ${momentumRegime}${momentumDiverges ? ` ⚑ diverges from structural ${regimeLabel}` : " ✓ aligns"}

SIGNAL 2b — Credit stress (leads recessions; check this before asserting a bust case):
${creditLines || "  No credit-stress data available."}
${anyCreditHealthy ? `  Constraint: at least one credit-stress indicator above is HEALTHY. If your narrative leans toward an imminent recession/deflationary-bust case, you MUST explicitly acknowledge this tension (e.g. "credit markets are not yet confirming this") rather than asserting an unhedged bust case.` : ""}

SIGNAL 3 — Market pricing (yesterday's action, forward-looking):
  Market-implied regime: ${marketLabel ?? "unknown"}
  ${divergence ? `⚑ Market diverges from structural regime` : "✓ Market aligns with structural regime"}
  Forward signal: ${fwdLabel ?? "none"}${fwdConf != null ? ` (${fwdConf}% confidence — "${qualifier}")` : ""}
  ${mktLines}

SIGNAL 4 — Supply chain / structural tail risk (12 tracked chokepoints, daily AI+web-search scored, 0–100). Each is tagged [ACTIVE] (a confirmed, currently-in-progress disruption) or [STRUCTURAL] (elevated but latent — no live triggering event right now):
${scLines || "  No critical or worsening chokepoints currently flagged."}
  Framing constraint: only describe an [ACTIVE] item as a "live catalyst within N days." An [STRUCTURAL] item must be framed as an "elevated tail risk" or similar — do not describe it as an active/live/imminent catalyst on the same footing as an [ACTIVE] item, even if its score is equally high.

Structure your answer in four parts, separated by blank lines:
(1) A paragraph: what is the hard data momentum telling us — is the structural regime transitioning, and how confident should we be? (must use the "${qualifier}" language constraint above)
(2) A paragraph: is yesterday's market action consistent with that momentum signal, or pricing a different scenario? If leaning toward a recession/bust read, address the credit-stress tension from Signal 2b if it applies.
(3) A paragraph: what does the supply chain signal confirm or complicate — does it corroborate the BW Modified real-assets sleeve (gold/commodities/TIPS), and is any specific chokepoint above a live tail risk for a sector or asset class in the portfolio? Respect the active-vs-structural framing constraint above.
(4) A "Concrete moves:" section: one short lead-in sentence, then 3-6 bullet points (each on its own line, starting with "- "), each one specific, actionable sentence naming a real instrument or asset class and what to do with it — not just "hold the base." Split opportunities and hedges across the bullets as the analysis warrants, rather than writing separate paragraphs for each.

Parts 1-3 must be plain prose — no bullets, no bold, no headers. Part 4 must be lead-in sentence + bullets only, no bold, no headers.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1100,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.content?.[0]?.text as string | undefined) ?? null;
    return raw ? stripMarkdown(raw, { allowBullets: true }) : null;
  } catch { return null; }
}

// ── Post-generation self-consistency check ──────────────────────────────────────
// A second, cheap pass that cross-checks the generated prose against the same
// reference numbers the prompt was constrained by — catches drift the
// generation-time constraints missed (e.g. claiming an inverted curve when the
// stored value is positive, or confidence language stronger than the qualifier).
async function validateConsistency(analysis: string, reference: string): Promise<{ consistent: boolean; issues: string[] }> {
  if (!ANTHROPIC_KEY) return { consistent: true, issues: [] };
  try {
    const prompt = `You are a fact-checker. Compare the ANALYSIS below against the REFERENCE DATA it must be consistent with. Flag ONLY clear, checkable contradictions — not stylistic quibbles.

Specifically check for:
1. Confidence language stronger than the reference's required qualifier (e.g. reference requires "moderate confidence" but the text says "high confidence" or "unambiguous").
2. Yield-curve claims that contradict the reference's stated state (e.g. calling the curve "inverted" when the reference says it is not, or omitting required recession-framing constraints).
3. An unhedged recession/deflationary-bust narrative that does NOT acknowledge a HEALTHY credit-stress indicator the reference flags as requiring acknowledgment.

REFERENCE DATA:
${reference}

ANALYSIS:
${analysis}

Respond with ONLY raw JSON, no markdown fences: {"consistent": true|false, "issues": ["short description of each contradiction found, empty array if none"]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return { consistent: true, issues: [] };
    const j = await res.json();
    const text = (j.content?.[0]?.text as string | undefined) ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return { consistent: true, issues: [] };
    const parsed = JSON.parse(text.slice(start, end + 1));
    return { consistent: parsed.consistent !== false, issues: Array.isArray(parsed.issues) ? parsed.issues : [] };
  } catch { return { consistent: true, issues: [] }; }
}

// ── News musing ───────────────────────────────────────────────────────────────
async function generateNewsMusing(params: {
  headlines: NewsItem[];
  regimeLabel: string;
  momentumRegime: string;
  marketLabel: string | null;
  fedOdds: FedOdds | null;
}): Promise<string | null> {
  if (!ANTHROPIC_KEY || params.headlines.length === 0) return null;
  try {
    const { headlines, regimeLabel, momentumRegime, marketLabel, fedOdds } = params;
    const mvEpisode = headlines.find(h => h.source === "MacroVoices");
    const newsLines = headlines
      .map((h, i) => `${i + 1}. "${h.headline}"${h.source ? ` — ${h.source}` : ""}`)
      .join("\n");
    const newestHeadline = headlines.reduce((max, h) => (h.publishedAt > max ? h.publishedAt : max), 0);
    const headlineWindow = newestHeadline > 0
      ? `${new Date(newestHeadline * 1000).toISOString().slice(0, 10)} (most recent)`
      : "unknown";

    const mvInstruction = mvEpisode
      ? `\nThe first item is the most recent MacroVoices podcast episode. Briefly note what it covers and how it informs the macro picture.`
      : "";

    const fedOddsBlock = fedOdds
      ? `\nMARKET-IMPLIED FED ODDS (Kalshi, priced as of ${fedOdds.asOf.slice(0, 16).replace("T", " ")} UTC, for ${fedOdds.meetingLabel}):
  Hike: ${fedOdds.pHike}% · Hold: ${fedOdds.pHold}% · Cut: ${fedOdds.pCut}%
  Headlines above are dated ${headlineWindow} — REQUIRED: explicitly reconcile headline sentiment against these priced odds, and name both dates so staleness is visible. If headline tone (e.g. hawkish Fed-speaker rhetoric) points a different direction than the priced odds, say so directly — do not silently pick the headline-implied direction as your conclusion. If they agree, say that too.`
      : `\nMarket-implied Fed odds were not available for this run — do not assert a directional conclusion about Fed policy odds (hike/hold/cut) from headline tone alone; frame any policy-direction read explicitly as headline sentiment, not priced probability.`;

    const prompt = `You are Clio, macro analyst at RatioBo. Write 2 sharp paragraphs (under 180 words total), plain prose only. Do not use any markdown syntax: no #, no **, no bullet or numbered lists, no title line.

Current regime signals:
  Structural: ${regimeLabel}
  Momentum-implied: ${momentumRegime}
  Market-implied: ${marketLabel ?? "unknown"}

Top macro headlines (last 24–48 hours):
${newsLines}
${mvInstruction}
${fedOddsBlock}

Assess: (1) What macro narrative are these headlines collectively signaling — growth, inflation, credit stress, risk-on, or risk-off? (2) Does that narrative align with or diverge from the regime signals above and the priced Fed odds, and what (if anything) should a BW Modified portfolio holder do differently in response?`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.content?.[0]?.text as string | undefined) ?? null;
    return raw ? stripMarkdown(raw) : null;
  } catch { return null; }
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get("refresh") === "true";
    const today = new Date().toISOString().slice(0, 10);

    if (!forceRefresh) {
      const { data: cached } = await sb
        .from("dalio_regime_analysis")
        .select("*")
        .eq("analysis_date", today)
        .maybeSingle();
      if (cached) {
        return new Response(JSON.stringify(cached), {
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
    }

    const [{ data: macroRows }, marketSnapshot, topNews, mvItem, supplyChain, yieldCurve, fedOdds] = await Promise.all([
      sb.from("macro_indicators").select("name,current_value,previous_value,status,metadata"),
      getMarketSnapshot(),
      fetchTopNews(5),
      fetchMacroVoices(),
      getSupplyChainRisks(sb),
      getYieldCurveState(),
      getFedRateOdds(),
    ]);
    const headlines: NewsItem[] = mvItem ? [mvItem, ...topNews] : topNews;

    const get = (name: string) => {
      const i = (macroRows ?? []).find((x: { name: string; current_value: number | null }) => x.name === name);
      return i?.current_value != null ? Number(i.current_value) : null;
    };
    const getPrev = (name: string) => {
      const i = (macroRows ?? []).find((x: { name: string; previous_value: number | null }) => x.name === name);
      return i?.previous_value != null ? Number(i.previous_value) : null;
    };
    const getStatus = (name: string): string | null => {
      const i = (macroRows ?? []).find((x: { name: string; status: string | null }) => x.name === name);
      return i?.status ?? null;
    };
    const getMeta3m = (name: string): number | null => {
      const i = (macroRows ?? []).find((x: { name: string; metadata: Record<string, unknown> | null }) => x.name === name);
      const v = i?.metadata?.change3m_pct;
      return typeof v === "number" ? v : null;
    };
    const creditIndicatorNames = ["HY Credit Spread (OAS)", "IG Credit Spread (OAS)", "Sr Loan Officer Survey", "C&I Loan Growth (YoY)"];
    const credit: CreditIndicator[] = creditIndicatorNames.map((name) => ({ name, value: get(name), status: getStatus(name) }));

    // Regime keys are computed LIVE from current macro_indicators rather than
    // read from the once-nightly macro_regime_history cache — that cache was
    // found stale by a full day (forward_confidence showing 43% against a
    // freshly-computed 37%, with structural/market keys equally stale) when
    // its nightly update silently failed to run for that day. Computing live
    // means Clio's narrative can never drift from what the Forward Signal tile
    // on the same page shows, regardless of whether the nightly job succeeded.
    const { structuralKey, marketKey, fwdKey, fwdConf } = computeLiveRegimeKeys(get, getPrev, getMeta3m);
    const regimeLabel = structuralKey ? (REGIME_LABELS[structuralKey] ?? structuralKey) : "Unknown";
    const marketLabel = marketKey ? (REGIME_LABELS[marketKey] ?? marketKey) : null;
    const fwdLabel = fwdKey ? (REGIME_LABELS[fwdKey] ?? fwdKey) : null;
    const divergence = !!(structuralKey && marketKey && structuralKey !== marketKey);

    const gdp     = get("Real GDP Growth");
    const prevGdp = getPrev("Real GDP Growth");
    const cpi     = get("CPI (YoY)");
    const prevCpi = getPrev("CPI (YoY)");

    const gdpUp  = gdp != null && prevGdp != null && gdp > prevGdp + 0.05;
    const inflUp = cpi != null && prevCpi != null && cpi > prevCpi + 0.05;
    const momentumRegime =
       gdpUp && inflUp  ? "Reflation" :
       gdpUp && !inflUp ? "Disinflationary Boom" :
      !gdpUp && inflUp  ? "Stagflation" : "Deflationary Bust";

    const analysisParams = {
      regimeLabel, marketLabel, fwdLabel, fwdConf,
      divergence,
      gdp,
      cpi,
      ppi:       get("PPI (YoY)"),
      t10y2y:    get("2yr/10yr Yield Spread"),
      lei:       get("Conference Board LEI"),
      breakeven: get("10Y Breakeven Inflation"),
      prevGdp,
      prevCpi,
      prevPpi:   getPrev("PPI (YoY)"),
      prevLei:   getPrev("Conference Board LEI"),
      prevBe:    getPrev("10Y Breakeven Inflation"),
      marketSnapshot,
      supplyChain,
      yieldCurveState: yieldCurve.state,
      credit,
    };

    const [analysisFirstPass, newsMusing] = await Promise.all([
      generateAnalysis(analysisParams),
      generateNewsMusing({ headlines, regimeLabel, momentumRegime, marketLabel, fedOdds }),
    ]);

    if (!analysisFirstPass) {
      return new Response(JSON.stringify({ error: "Analysis generation failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Self-consistency pass: cross-check the generated prose against the same
    // reference numbers it was constrained by. If it flags a real contradiction,
    // log it and regenerate once with the specific issues named — always publish
    // something (never block the page), but the flag is on record for review.
    const referenceBlock = buildReferenceBlock({
      regimeLabel, marketLabel, fwdLabel, fwdConf,
      qualifier: confidenceQualifier(fwdConf),
      yieldCurveValue: yieldCurve.value, yieldCurveState: yieldCurve.state,
      credit,
    });
    const check = await validateConsistency(analysisFirstPass, referenceBlock);

    let analysis = analysisFirstPass;
    if (!check.consistent && check.issues.length > 0) {
      await sb.from("dalio_narrative_flags").insert({
        analysis_date: today,
        issues: check.issues,
        original_analysis: analysisFirstPass,
        retried: true,
      });
      const retried = await generateAnalysis({
        ...analysisParams,
        correction: check.issues.map((i) => `- ${i}`).join("\n"),
      });
      if (retried) analysis = retried;
    }

    const row = {
      analysis_date: today,
      analysis,
      news_musing: newsMusing ?? null,
      news_headlines: headlines.length > 0 ? headlines : null,
      alignment: divergence ? "divergent" : "aligned",
      structural_regime: regimeLabel,
      market_regime: marketLabel,
      market_snapshot: marketSnapshot,
      generated_at: new Date().toISOString(),
    };

    await sb.from("dalio_regime_analysis").upsert(row, { onConflict: "analysis_date" });

    return new Response(JSON.stringify(row), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
