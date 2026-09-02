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
interface LiquidityIndicator {
  totalCompositeYoy: number | null;
  zscore: number | null;
  sixMonthAgoYoy: number | null;
  direction: "accelerating" | "decelerating" | "stable" | "unknown";
}
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

async function fetchRssQuery(query: string): Promise<NewsItem[]> {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)" } });
    if (!res.ok) return [];
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
  } catch { return []; }
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
    const results = await Promise.all(queries.map(fetchRssQuery));
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

// Yield curve control, money supply (M2), and QE/balance-sheet news publish
// far less often than generic Fed/CPI/GDP headlines, so they'd rarely survive
// fetchTopNews' global top-N recency cutoff on their own merits even when
// something genuinely newsworthy just happened (e.g. a fresh YCC program
// announcement). Each topic below is fetched separately and its single most
// recent headline is force-included regardless of rank — same guaranteed-
// inclusion pattern as the MacroVoices episode — so Clio never misses a live
// development on one of these debt-cycle-relevant topics just because that
// week's Fed-speak coverage was more numerous.
const WATCHED_TOPIC_QUERIES = [
  "yield curve control Treasury Federal Reserve",
  "M2 money supply growth Federal Reserve",
  "quantitative easing Federal Reserve balance sheet",
];

async function fetchWatchedTopics(): Promise<NewsItem[]> {
  const results = await Promise.all(WATCHED_TOPIC_QUERIES.map(async (query) => {
    const items = await fetchRssQuery(query);
    return items.sort((a, b) => b.publishedAt - a.publishedAt)[0] ?? null;
  }));
  return results.filter((r): r is NewsItem => r !== null);
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

// ── Liquidity composite snapshot ────────────────────────────────────────────────
// Reads liquidity_monthly directly (rather than the macro_indicators mirror) to get
// a 6-month-ago comparison point — matching the "Direction (latest vs 6m ago)"
// convention already established in the source calc sheet this indicator was
// validated against, rather than a noisier single-month-over-month read.
async function getLiquiditySnapshot(sb: ReturnType<typeof createClient>): Promise<LiquidityIndicator> {
  try {
    const { data } = await sb
      .from("liquidity_monthly")
      .select("month, total_composite_yoy, composite_zscore")
      .not("total_composite_yoy", "is", null)
      .order("month", { ascending: false })
      .limit(7);
    const rows = data ?? [];
    if (!rows.length) return { totalCompositeYoy: null, zscore: null, sixMonthAgoYoy: null, direction: "unknown" };
    const latest = rows[0];
    const sixMoAgo = rows.length >= 7 ? rows[6] : null;
    const curr = latest.total_composite_yoy != null ? Number(latest.total_composite_yoy) : null;
    const prior = sixMoAgo?.total_composite_yoy != null ? Number(sixMoAgo.total_composite_yoy) : null;
    const direction: LiquidityIndicator["direction"] =
      curr == null || prior == null ? "unknown"
      : curr > prior + 0.5 ? "accelerating"
      : curr < prior - 0.5 ? "decelerating"
      : "stable";
    return {
      totalCompositeYoy: curr,
      zscore: latest.composite_zscore != null ? Number(latest.composite_zscore) : null,
      sixMonthAgoYoy: prior,
      direction,
    };
  } catch { return { totalCompositeYoy: null, zscore: null, sixMonthAgoYoy: null, direction: "unknown" }; }
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
// Kept in sync with fetch-macro-data's identical constants/formula.
const GROWTH_MIN_GAP = 0.15;
// Dead band for the inflation crossover's up/down read — wider than
// GROWTH_MIN_GAP since inflation prints are noisier month to month than
// GDP's quarterly cadence. Kept in sync with lib/simulatorKeys.js's
// identical constant.
const CPI_MIN_GAP = 0.20;
// The Fed's actual inflation mandate, not an arbitrary round number.
const FED_INFLATION_TARGET = 2.0;

// Labor veto for the growth axis (see lib/simulatorKeys.js's
// isLaborDeteriorating, the canonical copy — kept in sync manually): a GDP
// crossover that would otherwise read "Expanding" gets pulled down on a
// 2-of-3 majority of payrolls/unemployment/claims deterioration. Null
// inputs don't vote; fewer than 2 votes present skips the veto.
function isLaborDeteriorating(payrolls3mAvg: number | null, unemploymentTrend: number | null, joblessClaimsTrend: number | null): boolean {
  const votes = [
    payrolls3mAvg      != null ? payrolls3mAvg < 0        : null,
    unemploymentTrend  != null ? unemploymentTrend > 0.1  : null,
    joblessClaimsTrend != null ? joblessClaimsTrend > 0   : null,
  ].filter((v): v is boolean => v !== null);
  if (votes.length < 2) return false;
  return votes.filter(Boolean).length >= 2;
}

function detectRegimeKeyLive(
  gdpYoy: number, cpiYoy: number, gdp3y: number, cpi3y: number,
  laborInputs?: { payrolls3mAvg: number | null; unemploymentTrend: number | null; joblessClaimsTrend: number | null },
): string {
  // Growth axis: the SAME gap-vs-dead-band test the Structural Growth
  // panel displays (rateOfChangeLabel === "Accelerating"), not a
  // separately-computed test — this used to also require clearing the
  // potential-GDP floor, which the panel's own label never checked, so
  // the two could disagree on the identical fast/slow pair. The potential
  // floor is still a legitimate, separately-displayed data point on the
  // macro page — it's just no longer a silent gate on this classification.
  // See the regime-table dead-band bug fix and the follow-up request to
  // stop having an independent GDP-state read.
  const growing = (gdpYoy - gdp3y > GROWTH_MIN_GAP)
    && !(laborInputs && isLaborDeteriorating(laborInputs.payrolls3mAvg, laborInputs.unemploymentTrend, laborInputs.joblessClaimsTrend));
  // Inflation axis: same dead-band treatment as growth — a bare
  // cpiYoy > cpi3y sign test let a print separated by a hundredth of a
  // point flip the regime read. See the follow-up request to stop having
  // an independent inflation-state read.
  const rising = (cpiYoy - cpi3y) > CPI_MIN_GAP;
  if (growing && !rising) return "rg_fi";
  if (growing && rising) return "rg_ri";
  if (!growing && rising) return "fg_ri";
  return "fg_fi";
}

type Getter = (name: string) => number | null;

function computeLiveRegimeKeys(
  get: Getter, getMeta3m: Getter, getPP3m: Getter,
  getShortPct: Getter, getVolShock: (name: string) => boolean, getSpfSpread: Getter,
): { structuralKey: string | null; marketKey: string | null; fwdKey: string | null; fwdConf: number | null; fwdConfVolMod: number } {
  // Fast/slow moving-average crossover, not raw-reading-vs-baseline: a
  // regime flip only fires when the fast line actually crosses the slow
  // line, which requires a real, sustained shift rather than one noisy
  // print. GDP: 2-quarter avg (fast) vs 4-quarter avg (slow). CPI: 3-month
  // avg (fast) vs 9-month avg (slow).
  const gdpFast = get("GDP Growth (2Q Avg)");
  const gdpSlow = get("GDP Growth (4Q Avg)");
  const cpiFast = get("CPI Growth (3M Avg)");
  const cpiSlow = get("CPI Growth (9M Avg)");
  const breakeven = get("10Y Breakeven Inflation");
  // Labor veto inputs (see isLaborDeteriorating) — same three indicators
  // already read into the G array below, reused here so payrolls/
  // unemployment/claims deterioration can move the Structural/Market
  // classifiers directly, not just the Forward Signal composite score.
  const laborInputs = {
    payrolls3mAvg:      get("Payrolls (3M Avg)"),
    unemploymentTrend:  get("Unemployment Rate Trend"),
    joblessClaimsTrend: get("Initial Jobless Claims Trend"),
  };

  const structuralKey = gdpFast != null && cpiFast != null
    ? detectRegimeKeyLive(gdpFast, cpiFast, gdpSlow ?? 0, cpiSlow ?? cpiFast, laborInputs)
    : null;

  const marketKey = gdpFast != null && gdpSlow != null
    ? (() => {
        const mktInflUp = (breakeven ?? FED_INFLATION_TARGET) > FED_INFLATION_TARGET;
        // Same gap-only growth test as detectRegimeKeyLive above — no
        // separate potential-floor gate (see the regime-table dead-band
        // bug fix / independent-GDP-state-read follow-up).
        const mktGrowthUp = (gdpFast - gdpSlow > GROWTH_MIN_GAP)
          && !isLaborDeteriorating(laborInputs.payrolls3mAvg, laborInputs.unemploymentTrend, laborInputs.joblessClaimsTrend);
        return mktGrowthUp ? (mktInflUp ? "rg_ri" : "rg_fi") : (mktInflUp ? "fg_ri" : "fg_fi");
      })()
    : null;

  type Sig = {
    name: string; w: number; usePct3m?: boolean; usePP3m?: boolean; useShortPct?: boolean; useSpfSpread?: boolean;
    shockGate?: boolean; sourceName?: string; vote: (v: number) => number;
  };
  const G: Sig[] = [
    { name: "2yr/10yr Yield Spread",  w: 0.25, vote: v => v > 0.5 ? 1 : v >= 0    ? 0 : -1 },
    { name: "3mo/10yr Yield Spread",  w: 0.20, vote: v => v > 1   ? 1 : v >= 0    ? 0 : -1 },
    { name: "Sr Loan Officer Survey", w: 0.20, vote: v => v < 15  ? 1 : v <= 35   ? 0 : -1 },
    { name: "Conference Board LEI",   w: 0.15, vote: v => v > 0   ? 1 : v >= -0.3 ? 0 : -1 },
    { name: "HY Credit Spread (OAS)", w: 0.10, vote: v => v < 4   ? 1 : v <= 6    ? 0 : -1 },
    { name: "C&I Loan Growth (YoY)",  w: 0.10, vote: v => v > 5   ? 1 : v >= 0    ? 0 : -1 },
    // Liquidity leads growth by ~12-18mo (banding matches the card's own healthy/watch/danger thresholds)
    { name: "US Total Liquidity Composite", w: 0.15, vote: v => v > 0 ? 1 : v > -3 ? 0 : -1 },
    // Consumer spending, ~2/3 of GDP by expenditure (banding matches the card's own thresholds)
    { name: "Retail Sales (YoY)", w: 0.15, vote: v => v >= 2 ? 1 : v >= 0 ? 0 : -1 },
    // Above/below-trend growth LEVEL (Investment Clock's own growth-axis definition),
    // distinct from the momentum signals above. Quarterly — lower weight, slow-moving anchor
    { name: "Output Gap", w: 0.10, vote: v => v > 0.5 ? 1 : v >= -0.5 ? 0 : -1 },
    // Labor data — previously absent from the growth axis entirely (credit
    // and GDP data are lagging confirmations of a growth turn; payrolls and
    // claims lead it). Weighted comparably to the credit signals above, not
    // as a minor addendum. Kept in sync with fetch-macro-data's identical G array.
    { name: "Payrolls (3M Avg)", w: 0.20, vote: v => v > 100 ? 1 : v >= 0 ? 0 : -1 },
    { name: "Unemployment Rate Trend", w: 0.15, vote: v => v < -0.05 ? 1 : v <= 0.05 ? 0 : -1 },
    // Weekly, ~1-week lag — the fastest-reacting growth signal in this
    // composite, standing in for the ISM employment sub-index (not available
    // for free scraping).
    { name: "Initial Jobless Claims Trend", w: 0.15, vote: v => v < 0 ? 1 : v <= 5 ? 0 : -1 },
    // GDP & Inflation Regime Metrics spec, G4 "Forward Consensus": is the
    // economy actually running ahead of or behind what forecasters
    // expected? A genuine surprise signal, distinct from every other
    // growth signal above, which measure the economy's own trend rather
    // than comparing it to a forecast. Kept in sync with fetch-macro-data
    // and page.jsx's identical entry.
    { name: "Real GDP Growth", w: 0.15, useSpfSpread: true, vote: v => v > 0.2 ? 1 : v >= -0.2 ? 0 : -1 },
  ];
  const I: Sig[] = [
    // 3-month pp-change signals, in raw percentage points (not relative % —
    // these are already rates, so a relative-%-change would invert sensitivity:
    // the same absolute pp move reads as huge when the rate is low, trivial
    // when it's high). PPI's threshold is wider since it's the noisier series
    // (also why it's weighted lower here).
    { name: "CPI (YoY)",                       w: 0.20, usePP3m: true,   vote: v => v < -0.5 ? -1 : v > 0.5 ? 1 : 0 },
    { name: "PPI (YoY)",                       w: 0.10, usePP3m: true,   vote: v => v < -1.0 ? -1 : v > 1.0 ? 1 : 0 },
    { name: "10Y Breakeven Inflation",         w: 0.20,                 vote: v => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
    { name: "Consumer Inflation Expectations", w: 0.15,                 vote: v => v > 5.5 ? 1 : v >= 2.5 ? 0 : -1 },
    { name: "Copper Price",                    w: 0.15, usePct3m: true, vote: v => v > 5   ? 1 : v >= -5 ? 0 : -1 },
    { name: "WTI Crude Oil",                   w: 0.10, usePct3m: true, vote: v => v > 5   ? 1 : v >= -5 ? 0 : -1 },
    // Explicit shock override — see fetch-macro-data's identical entry.
    { name: "WTI Crude Oil (Shock)", sourceName: "WTI Crude Oil", w: 0.15, useShortPct: true, shockGate: true, vote: v => v > 10 ? 1 : v < -10 ? -1 : 0 },
    { name: "M2 Growth (YoY)",                 w: 0.10,                 vote: v => v > 8   ? 1 : v >= 3  ? 0 : -1 },
    // Leads realized inflation by ~6-12mo (Merrill Lynch Investment Clock) — tight
    // capacity is genuinely forward-looking, unlike CPI/PPI trend which are coincident
    { name: "Capacity Utilization", w: 0.15, vote: v => v > 80 ? 1 : v >= 74 ? 0 : -1 },
    // Dollar strength lags into LOWER future inflation (~2mo, cheaper imports) — vote
    // is inverted relative to a normal "rising = inflationary" reading
    { name: "DXY", w: 0.10, usePct3m: true, vote: v => v > 5 ? -1 : v < -5 ? 1 : 0 },
    // Unlike CPI/PPI, this has no FRED backfill — macro_snapshots only starts
    // accumulating from launch, so its 3-month trend (change3m_pp) can't exist
    // for ~90 days and would vote null the whole time. Votes on the current
    // LEVEL instead (how much tariffs are adding to CPI right now), which is
    // itself informative from day one — thresholds match the danger/watch/
    // healthy bands update-supply-chain-risk already derives for this composite.
    { name: "Tariff Inflation Impact", w: 0.10, vote: v => v > 0.30 ? 1 : v > 0.10 ? 0 : -1 },
  ];
  type Scored = { w: number; vote: number | null };
  const scoreGroup = (sigs: Sig[]): { signals: Scored[]; score: number | null } => {
    let weighted = 0, totalW = 0;
    const signals = sigs.map((s) => {
      const source = s.sourceName ?? s.name;
      if (s.shockGate && !getVolShock(source)) return { w: s.w, vote: null };
      const val = s.useSpfSpread ? getSpfSpread(source) : s.useShortPct ? getShortPct(source) : s.usePct3m ? getMeta3m(source) : s.usePP3m ? getPP3m(source) : get(source);
      if (val == null) return { w: s.w, vote: null };
      const v = s.vote(val);
      weighted += v * s.w; totalW += s.w;
      return { w: s.w, vote: v };
    });
    return { signals, score: totalW > 0 ? weighted / totalW : null };
  };
  const growth = scoreGroup(G);
  const infl = scoreGroup(I);
  const THRESH = 0.10; // dead band — see #8 in the regime-calc work order
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

  // Vol-regime cross-check: VIX/MOVE are countercyclical (rise in downturns,
  // fall in expansions) — ties to the GROWTH direction specifically, kept in
  // sync with the identical logic in app/macro/page.jsx's computeForwardSignal.
  let fwdConfVolMod = 0;
  if (fwdKey && gDir) {
    const vixChg = getMeta3m("VIX");
    const moveChg = getMeta3m("MOVE Index");
    const trends = [vixChg, moveChg].filter((v): v is number => v != null);
    if (trends.length) {
      const avgTrend = trends.reduce((s, v) => s + v, 0) / trends.length;
      if (avgTrend > 5 || avgTrend < -5) {
        const volRising = avgTrend > 5;
        const confirms = (gDir === "down" && volRising) || (gDir === "up" && !volRising);
        fwdConfVolMod = confirms ? 5 : -8;
      }
    }
    if (fwdConf != null) fwdConf = Math.max(0, Math.min(100, fwdConf + fwdConfVolMod));
  }

  return { structuralKey, marketKey, fwdKey, fwdConf, fwdConfVolMod };
}

// ── Reference block shared by the main prompt and the consistency checker ──────
// Keeping this in one place means the "ground truth" the model is constrained
// against and the "ground truth" the validator checks against never drift apart.
function buildReferenceBlock(p: {
  regimeLabel: string; marketLabel: string | null; fwdLabel: string | null; fwdConf: number | null;
  qualifier: string; yieldCurveValue: number | null; yieldCurveState: YieldCurveState;
  credit: CreditIndicator[]; liquidity: LiquidityIndicator;
}): string {
  const creditLines = p.credit
    .map((c) => `  ${c.name}: ${c.value != null ? c.value : "n/a"}${c.status ? ` (${c.status.toUpperCase()})` : ""}`)
    .join("\n");
  const liq = p.liquidity;
  const liquidityLine = liq.totalCompositeYoy != null
    ? `${liq.totalCompositeYoy >= 0 ? "+" : ""}${liq.totalCompositeYoy.toFixed(1)}% YoY (z ${liq.zscore != null ? liq.zscore.toFixed(2) : "n/a"}σ), ${liq.direction} vs. 6 months ago`
    : "n/a";
  return `Structural regime: ${p.regimeLabel}
Market-implied regime: ${p.marketLabel ?? "unknown"}
Forward signal: ${p.fwdLabel ?? "none"}${p.fwdConf != null ? `, ${p.fwdConf}% confidence — must be described as "${p.qualifier}"` : ""}
2/10 yield curve: ${p.yieldCurveValue != null ? p.yieldCurveValue.toFixed(2) + "%" : "n/a"} — ${YIELD_CURVE_STATE_NOTE[p.yieldCurveState]}
Credit stress indicators (lead recessions; HEALTHY = no stress despite any bust narrative):
${creditLines}
Liquidity composite (leads risk appetite): ${liquidityLine}`;
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
  liquidity: LiquidityIndicator;
  today: string;
  correction?: string; // set on the one-shot retry after a failed consistency check
}): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  try {
    const {
      regimeLabel, marketLabel, fwdLabel, fwdConf, divergence,
      gdp, cpi, ppi, t10y2y, lei, breakeven,
      prevGdp, prevCpi, prevPpi, prevLei, prevBe,
      marketSnapshot, supplyChain, yieldCurveState, credit, liquidity, today, correction,
    } = params;
    const todayFormatted = new Date(today + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

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

    const liquidityLine = liquidity.totalCompositeYoy != null
      ? `${liquidity.totalCompositeYoy >= 0 ? "+" : ""}${liquidity.totalCompositeYoy.toFixed(1)}% YoY (z ${liquidity.zscore != null ? liquidity.zscore.toFixed(2) : "n/a"}σ vs. full history) — ${liquidity.direction === "unknown" ? "trend unavailable" : `${liquidity.direction} vs. 6 months ago`}`
      : "n/a";
    const liquidityConstraint = liquidity.totalCompositeYoy == null ? ""
      : liquidity.totalCompositeYoy < 0
      ? `  Constraint: liquidity is contractionary (below zero) — historically the most dangerous regime for risk assets. If your narrative leans risk-on/bullish on equities or credit, you MUST explicitly acknowledge this headwind.`
      : liquidity.direction === "decelerating"
      ? `  Constraint: liquidity is expansionary but decelerating vs. 6 months ago — a late-cycle caution signal, not an unambiguous tailwind. Do not describe it as clean risk-on without noting the deceleration.`
      : `  Constraint: liquidity is expansionary${liquidity.direction === "accelerating" ? " and accelerating — a genuine tailwind" : ""}. If your narrative is bearish on risk assets, acknowledge this counter-signal.`;

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

TODAY'S DATE: ${todayFormatted}. Use this as the actual current date for any date references, year mentions, or forward-looking horizons — do not default to your training-data cutoff or any other year.
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

SIGNAL 2c — Liquidity momentum (Fed net liquidity + private liquidity proxy, leads risk appetite by ~12-18 months; public-data approximation of the Michael Howell / GL Indexes global liquidity framework):
  Total Composite YoY: ${liquidityLine}
  Reading guide: above zero and accelerating = expansionary tailwind (risk-on historically favored); above zero but decelerating = late-cycle caution; below zero = contraction, historically the most dangerous regime for risk assets.
${liquidityConstraint}

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
(2) A paragraph: is yesterday's market action consistent with that momentum signal, or pricing a different scenario? If leaning toward a recession/bust read, address the credit-stress tension from Signal 2b if it applies. Also weigh in the liquidity signal (2c) — does it corroborate or complicate the market-pricing read on risk appetite, respecting its constraint above.
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
4. A risk-on/bullish narrative that ignores a contractionary (below-zero) liquidity composite reading, or a risk-off/bearish narrative that ignores an expansionary-and-accelerating one, per the reference's liquidity composite line.

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
  watchedHeadlines: NewsItem[];
  regimeLabel: string;
  momentumRegime: string;
  marketLabel: string | null;
  fedOdds: FedOdds | null;
  today: string;
}): Promise<string | null> {
  if (!ANTHROPIC_KEY || params.headlines.length === 0) return null;
  try {
    const { headlines, watchedHeadlines, regimeLabel, momentumRegime, marketLabel, fedOdds, today } = params;
    const todayFormatted = new Date(today + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
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

    // Watched topics (yield curve control, M2 money supply, quantitative easing)
    // are force-included above regardless of recency rank precisely because
    // they're leading debt-cycle signals RatioBo tracks closely — surface that
    // explicitly rather than letting one get folded anonymously into "growth
    // and inflation news" the way a generic CPI headline would be.
    const watchedInstruction = watchedHeadlines.length > 0
      ? `\nREQUIRED: the following headline(s) were specifically sourced because they concern yield curve control, money supply (M2) growth, or quantitative easing/Fed balance sheet policy — debt-cycle signals RatioBo tracks closely. Explicitly address their significance for the current regime and for the BW Modified real-assets sleeve (gold, TIPS, commodities), even if brief:\n${watchedHeadlines.map((h) => `  - "${h.headline}"${h.source ? ` — ${h.source}` : ""}`).join("\n")}`
      : "";

    const prompt = `You are Clio, macro analyst at RatioBo. Write 2 sharp paragraphs (under 180 words total), plain prose only. Do not use any markdown syntax: no #, no **, no bullet or numbered lists, no title line.

TODAY'S DATE: ${todayFormatted}. Use this as the actual current date for any date references, year mentions, or forward-looking horizons — do not default to your training-data cutoff or any other year.

Current regime signals:
  Structural: ${regimeLabel}
  Momentum-implied: ${momentumRegime}
  Market-implied: ${marketLabel ?? "unknown"}

Top macro headlines (last 24–48 hours):
${newsLines}
${mvInstruction}
${fedOddsBlock}
${watchedInstruction}

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

    const [{ data: macroRows }, marketSnapshot, topNews, mvItem, watchedTopics, supplyChain, yieldCurve, fedOdds, liquidity] = await Promise.all([
      sb.from("macro_indicators").select("name,current_value,previous_value,status,metadata"),
      getMarketSnapshot(),
      fetchTopNews(5),
      fetchMacroVoices(),
      fetchWatchedTopics(),
      getSupplyChainRisks(sb),
      getYieldCurveState(),
      getFedRateOdds(),
      getLiquiditySnapshot(sb),
    ]);
    const dedupedWatched = watchedTopics.filter((w) => !topNews.some((t) => t.headline === w.headline));
    const headlines: NewsItem[] = [
      ...(mvItem ? [mvItem] : []),
      ...dedupedWatched,
      ...topNews,
    ];

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
    const getPP3m = (name: string): number | null => {
      const i = (macroRows ?? []).find((x: { name: string; metadata: Record<string, unknown> | null }) => x.name === name);
      const v = i?.metadata?.change3m_pp;
      return typeof v === "number" ? v : null;
    };
    const getShortPct = (name: string): number | null => {
      const i = (macroRows ?? []).find((x: { name: string; metadata: Record<string, unknown> | null }) => x.name === name);
      const v = i?.metadata?.change_short_pct;
      return typeof v === "number" ? v : null;
    };
    const getVolShock = (name: string): boolean => {
      const i = (macroRows ?? []).find((x: { name: string; metadata: Record<string, unknown> | null }) => x.name === name);
      return !!i?.metadata?.vol_shock;
    };
    // Spread between the actual reading and its SPF consensus forecast
    // (stamped onto the indicator's own metadata by update-spf-forecasts) —
    // positive means the economy is beating what forecasters expected.
    const getSpfSpread = (name: string): number | null => {
      const i = (macroRows ?? []).find((x: { name: string; current_value: number | null; metadata: Record<string, unknown> | null }) => x.name === name);
      const actual = i?.current_value != null ? Number(i.current_value) : null;
      const consensus = i?.metadata?.spf_consensus_gdp;
      return actual != null && consensus != null ? actual - Number(consensus) : null;
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
    const { structuralKey, marketKey, fwdKey, fwdConf } = computeLiveRegimeKeys(get, getMeta3m, getPP3m, getShortPct, getVolShock, getSpfSpread);
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
      liquidity,
      today,
    };

    const [analysisFirstPass, newsMusing] = await Promise.all([
      generateAnalysis(analysisParams),
      generateNewsMusing({ headlines, watchedHeadlines: dedupedWatched, regimeLabel, momentumRegime, marketLabel, fedOdds, today }),
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
      credit, liquidity,
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
      forward_key: fwdKey,
      forward_confidence: fwdConf,
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
