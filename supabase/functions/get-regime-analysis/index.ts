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
// Empirically recalibrated (dead-band-recalibration spec) via
// supabase/functions/growth-axis-backtest's walk-forward sweep against real
// FRED history — see that file's/lib/simulatorKeys.js's fuller rationale.
const GROWTH_MIN_GAP = 0.80;
// Dead band for the inflation crossover's up/down read. Empirically
// recalibrated the same way as GROWTH_MIN_GAP above — unlike growth, no
// plateau was found for inflation across a finer 0.80-1.10pp sweep (hit
// rate climbed steadily throughout); 1.00pp is a deliberate compromise,
// not CPI's own empirical ceiling — see lib/simulatorKeys.js's fuller
// rationale. Kept in sync with lib/simulatorKeys.js's identical constant.
const CPI_MIN_GAP = 1.00;
// The Fed's actual inflation mandate, not an arbitrary round number.
const FED_INFLATION_TARGET = 2.0;
// Kept in sync with lib/simulatorKeys.js/fetch-macro-data/run-backtest's
// identical constants — used only by detectRegimeKeyRaw below (the
// "currently confirmed regime" anchor), not by the dead-band-aware
// structuralKey/marketKey classification.
const POTENTIAL_GDP_GROWTH = 1.9;
const POTENTIAL_FLOOR_FRACTION = 0.85;

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

// Raw (non-dead-band) classifier — mirrors lib/simulatorKeys.js's
// detectRegimeKey exactly, including its use of the SAME GROWTH_MIN_GAP
// constant as the crossover (a raw-spot-vs-4Q-avg gap, not a fast/slow
// crossover gap — different comparison, same threshold). Used ONLY as the
// "currently confirmed regime" anchor for the both-Persistent case — the
// same thing app/macro/page.jsx's regimeKey fallback chain
// (majorityRegimeKey ?? structuralRegimeKey ?? detectRegimeKey(raw)) ends
// on when both of the first two are null. NOT part of the dead-band-aware
// structuralKey/marketKey classification, which stays on
// detectRegimeKeyLive/resolveAxisState. Computing this live, the same way
// the frontend does, replaces the earlier macro_regime_history DB lookback
// — that lookback could name a DIFFERENT quarter's regime than what's
// currently on screen (confirmed live: it returned "Disinflationary Boom"
// while the frontend's raw fallback said "Stagflation" for the identical
// moment), which is exactly the kind of drift Clio's narrative must not have.
function detectRegimeKeyRaw(
  gdpGrowth: number, cpiYoy: number, breakeven: number, gdp3yAvg: number,
  laborInputs?: { payrolls3mAvg: number | null; unemploymentTrend: number | null; joblessClaimsTrend: number | null },
): string {
  const growing = (gdpGrowth - gdp3yAvg > GROWTH_MIN_GAP) && (gdpGrowth > POTENTIAL_GDP_GROWTH * POTENTIAL_FLOOR_FRACTION)
    && !(laborInputs && isLaborDeteriorating(laborInputs.payrolls3mAvg, laborInputs.unemploymentTrend, laborInputs.joblessClaimsTrend));
  const risingInflation = cpiYoy > breakeven;
  if (growing && !risingInflation) return "rg_fi";
  if (growing && risingInflation) return "rg_ri";
  if (!growing && risingInflation) return "fg_ri";
  return "fg_fi";
}

// Replaces the old Direction/Level tiebreaker (resolveAxisUp) per the
// dead-band-persistence spec: a gap inside the dead band no longer
// coin-flips a direction via a secondary signal — it's an explicit
// Persistence state with its own confidence (100% at dead-band center,
// 0% at the edge) and a nearSide (which state a break would go toward).
// Mirrors resolveAxisState in lib/simulatorKeys.js — kept in sync manually.
type AxisState = { up: boolean | null; persistence: boolean; persistenceConfidence: number | null; nearSide: "Accelerating" | "Decelerating" | null };
function resolveAxisState(gap: number, minGap: number): AxisState {
  if (gap > minGap) return { up: true, persistence: false, persistenceConfidence: null, nearSide: null };
  if (gap < -minGap) return { up: false, persistence: false, persistenceConfidence: null, nearSide: null };
  const distanceFromCenter = Math.min(Math.abs(gap) / minGap, 1);
  return {
    up: null, persistence: true,
    persistenceConfidence: Math.round((1 - distanceFromCenter) * 100),
    nearSide: gap >= 0 ? "Accelerating" : "Decelerating",
  };
}

// "Always show a quadrant" follow-up (mirrors app/macro/page.jsx's
// identical helpers) — a Persistent axis's nearSide (which side of its own
// dead band its held level currently sits on) stands in for a real
// directional call when naming a QUADRANT, even though it correctly does
// NOT stand in for one in the regime-classification vote itself
// (structuralKey/marketKey/panel.key stay null on Persistence — untouched).
function leaningUp(axis: AxisState | null | undefined): boolean | null {
  if (!axis) return null;
  if (axis.persistence) return axis.nearSide === "Accelerating" ? true : axis.nearSide === "Decelerating" ? false : null;
  return axis.up;
}

function leaningQuadrantKey(growthAxis: AxisState | null | undefined, inflAxis: AxisState | null | undefined): string | null {
  const growthUp = leaningUp(growthAxis);
  const inflUp = leaningUp(inflAxis);
  if (growthUp == null || inflUp == null) return null;
  return growthUp && !inflUp ? "rg_fi" : growthUp && inflUp ? "rg_ri" : !growthUp && inflUp ? "fg_ri" : "fg_fi";
}

// Hedge text naming which axis is doing the work — only meaningful in the
// MIXED case (exactly one axis Persistent); both/neither need no hedge.
function leaningHedge(growthAxis: AxisState | null | undefined, inflAxis: AxisState | null | undefined): string | null {
  const growthPersistent = !!growthAxis?.persistence;
  const inflPersistent = !!inflAxis?.persistence;
  if (growthPersistent === inflPersistent) return null;
  if (growthPersistent) {
    const inflUp = leaningUp(inflAxis);
    return `Inflation ${inflUp ? "rising" : "falling"} is the driver; Growth persistence keeps this provisional.`;
  }
  const growthUp = leaningUp(growthAxis);
  return `Growth ${growthUp ? "expanding" : "contracting"} is the driver; Inflation persistence keeps this provisional.`;
}

// The label Clio (and the "structural_regime"/"market_regime"/forward-key
// DB columns the /macro and /portfolios badges render verbatim) actually
// sees for a lens with no real key: both-Persistent means neither axis
// moved, so the quadrant IS the already-confirmed one (lastConfirmedLabel)
// — NOT a freshly nearSide-guessed one, which can disagree with "currently
// confirmed" and read as contradictory. Mixed uses the nearSide-based
// leaning quadrant, per the dead-band-persistence "always show a quadrant"
// follow-up. Mirrors app/macro/page.jsx's identical split exactly, so
// Clio's prompt and the live page never disagree about which word to use.
function leaningLabel(
  growthPersistent: boolean, inflPersistent: boolean,
  growthAxis: AxisState | null | undefined, inflAxis: AxisState | null | undefined,
  lastConfirmedLabel: string | null,
): string {
  if (growthPersistent && inflPersistent) return lastConfirmedLabel ?? "Persistence";
  const k = leaningQuadrantKey(growthAxis, inflAxis);
  return k ? (REGIME_LABELS[k] ?? k) : "Persistence";
}

function detectRegimeKeyLive(
  gdpYoy: number, cpiYoy: number, gdp3y: number, cpi3y: number,
  laborInputs?: { payrolls3mAvg: number | null; unemploymentTrend: number | null; joblessClaimsTrend: number | null },
): string | null {
  // Growth axis: the SAME gap-vs-dead-band test the Structural Growth
  // panel displays (rateOfChangeLabel === "Accelerating"), not a
  // separately-computed test — this used to also require clearing the
  // potential-GDP floor, which the panel's own label never checked, so
  // the two could disagree on the identical fast/slow pair. The potential
  // floor is still a legitimate, separately-displayed data point on the
  // macro page — it's just no longer a silent gate on this classification.
  // See the regime-table dead-band bug fix and the follow-up request to
  // stop having an independent GDP-state read.
  const growthAxis = resolveAxisState(gdpYoy - gdp3y, GROWTH_MIN_GAP);
  // Inflation axis: same dead-band treatment as growth — a bare
  // cpiYoy > cpi3y sign test let a print separated by a hundredth of a
  // point flip the regime read. See the regime tiebreaker spec.
  const inflAxis = resolveAxisState(cpiYoy - cpi3y, CPI_MIN_GAP);
  // Dead-band-persistence spec: no forced quadrant when either axis is in
  // Persistence — null means "regime continuation," not "no signal."
  if (growthAxis.persistence || inflAxis.persistence) return null;
  const growing = growthAxis.up === true
    && !(laborInputs && isLaborDeteriorating(laborInputs.payrolls3mAvg, laborInputs.unemploymentTrend, laborInputs.joblessClaimsTrend));
  const rising = inflAxis.up === true;
  if (growing && !rising) return "rg_fi";
  if (growing && rising) return "rg_ri";
  if (!growing && rising) return "fg_ri";
  return "fg_fi";
}

type Getter = (name: string) => number | null;
type SpfGetter = (name: string, field?: string) => number | null;

function computeLiveRegimeKeys(
  get: Getter, getMeta3m: Getter, getPP3m: Getter,
  getShortPct: Getter, getVolShock: (name: string) => boolean, getSpfSpread: SpfGetter,
  getPrev: Getter, getMetaNum: (name: string, key: string) => number | null,
): {
  structuralKey: string | null; marketKey: string | null;
  structuralGrowthAxis: AxisState | null; structuralInflAxis: AxisState | null; marketGrowthAxis: AxisState | null;
  fwdKey: string | null; fwdConf: number | null; fwdConfVolMod: number;
  fwdGrowthPersistence: boolean; fwdInflPersistence: boolean;
  fwdGrowthPersistenceConfidence: number | null; fwdInflPersistenceConfidence: number | null;
  fwdGrowthAxis: AxisState; fwdInflAxis: AxisState;
  nearTermFwdKey: string | null; nearTermFwdConf: number | null;
  nearTermGrowthPersistence: boolean; nearTermInflPersistence: boolean;
  nearTermGrowthPersistenceConfidence: number | null; nearTermInflPersistenceConfidence: number | null;
  nearTermGrowthAxis: AxisState; nearTermInflAxis: AxisState;
} {
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
  // True whenever structuralKey is null specifically because an axis is in
  // Persistence (vs. null from missing data) — Clio's prompt uses this to
  // say "Persistence — continuation" instead of "Unknown."
  const structuralGrowthAxis = gdpFast != null ? resolveAxisState(gdpFast - (gdpSlow ?? 0), GROWTH_MIN_GAP) : null;
  const structuralInflAxis = cpiFast != null ? resolveAxisState(cpiFast - (cpiSlow ?? cpiFast), CPI_MIN_GAP) : null;

  // Market's growth leg reuses structuralGrowthAxis's crossover test — the
  // IDENTICAL test as Structural, not a separately-computed one (fixes the
  // earlier carryover bug where Market Expectations silently defaulted a
  // Stable read to Down instead of matching Structural's treatment).
  const marketGrowthAxis = gdpFast != null && gdpSlow != null ? resolveAxisState(gdpFast - gdpSlow, GROWTH_MIN_GAP) : null;
  const marketKey = gdpFast != null && gdpSlow != null && !marketGrowthAxis?.persistence
    ? (() => {
        const mktInflUp = (breakeven ?? FED_INFLATION_TARGET) > FED_INFLATION_TARGET;
        const mktGrowthUp = marketGrowthAxis?.up === true
          && !isLaborDeteriorating(laborInputs.payrolls3mAvg, laborInputs.unemploymentTrend, laborInputs.joblessClaimsTrend);
        return mktGrowthUp ? (mktInflUp ? "rg_ri" : "rg_fi") : (mktInflUp ? "fg_ri" : "fg_fi");
      })()
    : null;

  type Sig = {
    name: string; w: number; usePct3m?: boolean; usePP3m?: boolean; useShortPct?: boolean;
    useSpfSpread?: boolean | string; useMetaField?: string;
    shockGate?: boolean; sourceName?: string; vote: (v: number) => number;
  };
  // ── Forward Signal: Near-Term (2-3mo) & Medium-Term (6-18mo) panels ──────
  // Split per the forward-signal two-horizon spec — see the identical
  // NEARTERM_*/MEDTERM_* arrays in lib/simulatorKeys.js and fetch-macro-data.
  // Kept in sync manually.
  const NEARTERM_G: Sig[] = [
    { name: "GDPNow", w: 0.20, vote: v => v > 2.5 ? 1 : v >= 1.0 ? 0 : -1 },
    { name: "ISM Manufacturing PMI", w: 0.15, useMetaField: "new_orders", vote: v => v > 55 ? 1 : v >= 50 ? 0 : -1 },
    { name: "ISM Services PMI", w: 0.10, useMetaField: "new_orders", vote: v => v > 55 ? 1 : v >= 50 ? 0 : -1 },
    { name: "Initial Jobless Claims Trend", w: 0.15, vote: v => v < 0 ? 1 : v <= 5 ? 0 : -1 },
    { name: "Payrolls (3M Avg)", w: 0.15, vote: v => v > 100 ? 1 : v >= 0 ? 0 : -1 },
    { name: "Retail Sales (YoY)", w: 0.10, vote: v => v >= 2 ? 1 : v >= 0 ? 0 : -1 },
    { name: "Unemployment Rate Trend", w: 0.05, vote: v => v < -0.05 ? 1 : v <= 0.05 ? 0 : -1 },
    { name: "HY Credit Spread (OAS)", w: 0.05, vote: v => v < 4 ? 1 : v <= 6 ? 0 : -1 },
    { name: "US Total Liquidity Composite", w: 0.05, vote: v => v > 0 ? 1 : v > -3 ? 0 : -1 },
  ];
  const NEARTERM_I: Sig[] = [
    { name: "CPI (YoY)", w: 0.20, usePP3m: true, vote: v => v < -0.5 ? -1 : v > 0.5 ? 1 : 0 },
    { name: "PPI (YoY)", w: 0.20, usePP3m: true, vote: v => v < -1.0 ? -1 : v > 1.0 ? 1 : 0 },
    { name: "WTI Crude Oil", w: 0.10, usePct3m: true, vote: v => v > 5 ? 1 : v >= -5 ? 0 : -1 },
    { name: "WTI Crude Oil (Shock)", sourceName: "WTI Crude Oil", w: 0.15, useShortPct: true, shockGate: true, vote: v => v > 10 ? 1 : v < -10 ? -1 : 0 },
    { name: "Copper Price", w: 0.10, usePct3m: true, vote: v => v > 5 ? 1 : v >= -5 ? 0 : -1 },
    { name: "DXY", w: 0.10, usePct3m: true, vote: v => v > 5 ? -1 : v < -5 ? 1 : 0 },
    { name: "Consumer Inflation Expectations", w: 0.10, useMetaField: "umich_1yr", vote: v => v > 4 ? 1 : v >= 2.5 ? 0 : -1 },
    { name: "Tariff Inflation Impact", w: 0.05, vote: v => v > 0.30 ? 1 : v > 0.10 ? 0 : -1 },
  ];
  const NEARTERM_THRESH = 0.15;

  const MEDTERM_G: Sig[] = [
    { name: "2yr/10yr Yield Spread", w: 0.20, vote: v => v > 0.5 ? 1 : v >= 0 ? 0 : -1 },
    { name: "3mo/10yr Yield Spread", w: 0.10, vote: v => v > 1 ? 1 : v >= 0 ? 0 : -1 },
    { name: "Sr Loan Officer Survey", w: 0.15, vote: v => v < 15 ? 1 : v <= 35 ? 0 : -1 },
    { name: "Building Permits", w: 0.15, usePct3m: true, vote: v => v > 3 ? 1 : v >= -3 ? 0 : -1 },
    { name: "UMich Consumer Sentiment", w: 0.15, vote: v => v > 80 ? 1 : v >= 60 ? 0 : -1 },
    { name: "Output Gap", w: 0.10, vote: v => v > 0.5 ? 1 : v >= -0.5 ? 0 : -1 },
    { name: "C&I Loan Growth (YoY)", w: 0.10, vote: v => v > 5 ? 1 : v >= 0 ? 0 : -1 },
    { name: "Real GDP Growth", w: 0.05, useSpfSpread: "spf_consensus_gdp_fwd", vote: v => v > 0.2 ? 1 : v >= -0.2 ? 0 : -1 },
  ];
  const MEDTERM_I: Sig[] = [
    { name: "10Y Breakeven Inflation", w: 0.26, vote: v => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
    { name: "10-Year Expected Inflation", w: 0.16, vote: v => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
    { name: "Unit Labor Costs (YoY)", w: 0.21, vote: v => v > 4 ? 1 : v >= 2 ? 0 : -1 },
    { name: "M2 Growth (YoY)", w: 0.10, vote: v => v > 8 ? 1 : v >= 3 ? 0 : -1 },
    { name: "Capacity Utilization", w: 0.16, vote: v => v > 80 ? 1 : v >= 74 ? 0 : -1 },
    { name: "Tariff Inflation Impact", w: 0.11, vote: v => v > 0.30 ? 1 : v > 0.10 ? 0 : -1 },
  ];
  const MEDTERM_THRESH = 0.10;

  type Scored = { w: number; vote: number | null };
  const scoreGroup = (sigs: Sig[]): { signals: Scored[]; score: number | null } => {
    let weighted = 0, totalW = 0;
    const signals = sigs.map((s) => {
      const source = s.sourceName ?? s.name;
      if (s.shockGate && !getVolShock(source)) return { w: s.w, vote: null };
      const val = s.useSpfSpread ? getSpfSpread(source, typeof s.useSpfSpread === "string" ? s.useSpfSpread : "spf_consensus_gdp")
        : s.useMetaField ? getMetaNum(source, s.useMetaField)
        : s.useShortPct ? getShortPct(source)
        : s.usePct3m ? getMeta3m(source)
        : s.usePP3m ? getPP3m(source)
        : get(source);
      if (val == null) return { w: s.w, vote: null };
      const v = s.vote(val);
      weighted += v * s.w; totalW += s.w;
      return { w: s.w, vote: v };
    });
    return { signals, score: totalW > 0 ? weighted / totalW : null };
  };

  const computePanel = (G: Sig[], I: Sig[], THRESH: number) => {
    const growth = scoreGroup(G);
    const infl = scoreGroup(I);
    const dir = (s: number | null) => s == null ? null : s > THRESH ? "up" : s < -THRESH ? "down" : "neutral";
    const rawGDir = dir(growth.score);
    const rawIDir = dir(infl.score);
    // Dead-band-persistence spec: no sign-fallback — a neutral score is
    // Persistence, not a coin-flipped Up/Down.
    const gDir = rawGDir === "neutral" ? null : rawGDir;
    const iDir = rawIDir === "neutral" ? null : rawIDir;
    const growthPersistence = rawGDir === "neutral";
    const inflPersistence = rawIDir === "neutral";
    const persistenceConf = (s: number | null) => s == null ? null : Math.round((1 - Math.min(Math.abs(s) / THRESH, 1)) * 100);
    const growthPersistenceConfidence = growthPersistence ? persistenceConf(growth.score) : null;
    const inflPersistenceConfidence = inflPersistence ? persistenceConf(infl.score) : null;
    const key =
      gDir === "up" && iDir === "down" ? "rg_fi" :
      gDir === "up" && iDir === "up" ? "rg_ri" :
      gDir === "down" && iDir === "up" ? "fg_ri" :
      gDir === "down" && iDir === "down" ? "fg_fi" : null;

    let conf: number | null = null;
    if (key && gDir && iDir) {
      const consensus = (signals: Scored[], d: string): number | null => {
        const target = d === "up" ? 1 : -1;
        let agreed = 0, total = 0;
        for (const s of signals) { if (s.vote == null) continue; total += s.w; if (s.vote === target) agreed += s.w; }
        return total > 0 ? Math.round(agreed / total * 100) : null;
      };
      const gConf = consensus(growth.signals, gDir);
      const iConf = consensus(infl.signals, iDir);
      conf = gConf != null && iConf != null ? Math.round((gConf + iConf) / 2) : null;
    }

    // Vol-regime cross-check: VIX/MOVE are countercyclical (rise in downturns,
    // fall in expansions) — ties to the GROWTH direction specifically, kept in
    // sync with the identical logic in app/macro/page.jsx's computeForwardSignal.
    let confVolMod = 0;
    if (key && gDir) {
      const vixChg = getMeta3m("VIX");
      const moveChg = getMeta3m("MOVE Index");
      const trends = [vixChg, moveChg].filter((v): v is number => v != null);
      if (trends.length) {
        const avgTrend = trends.reduce((s, v) => s + v, 0) / trends.length;
        if (avgTrend > 5 || avgTrend < -5) {
          const volRising = avgTrend > 5;
          const confirms = (gDir === "down" && volRising) || (gDir === "up" && !volRising);
          confVolMod = confirms ? 5 : -8;
        }
      }
      if (conf != null) conf = Math.max(0, Math.min(100, conf + confVolMod));
    }
    // AxisState-shaped wrappers (with nearSide) so the handler can compute a
    // leaning quadrant for this panel's mixed-Persistence case the same way
    // Structural/Market do — see leaningQuadrantKey/leaningHedge.
    const growthAxis: AxisState = {
      up: gDir === "up" ? true : gDir === "down" ? false : null,
      persistence: growthPersistence, persistenceConfidence: growthPersistenceConfidence,
      nearSide: growth.score != null ? (growth.score >= 0 ? "Accelerating" : "Decelerating") : null,
    };
    const inflAxis: AxisState = {
      up: iDir === "up" ? true : iDir === "down" ? false : null,
      persistence: inflPersistence, persistenceConfidence: inflPersistenceConfidence,
      nearSide: infl.score != null ? (infl.score >= 0 ? "Accelerating" : "Decelerating") : null,
    };
    return {
      key, conf, confVolMod,
      growthPersistence, inflPersistence,
      growthPersistenceConfidence, inflPersistenceConfidence,
      growthAxis, inflAxis,
    };
  };

  // Medium-Term keeps the old single Forward Signal's role as the 3rd
  // tiebreak vote / Clio's prompt "forward signal" — Near-Term does not
  // vote there, but is surfaced alongside it in the API response.
  const mediumTerm = computePanel(MEDTERM_G, MEDTERM_I, MEDTERM_THRESH);
  const nearTerm = computePanel(NEARTERM_G, NEARTERM_I, NEARTERM_THRESH);

  return {
    structuralKey, marketKey,
    structuralGrowthAxis, structuralInflAxis, marketGrowthAxis,
    fwdKey: mediumTerm.key, fwdConf: mediumTerm.conf, fwdConfVolMod: mediumTerm.confVolMod,
    fwdGrowthPersistence: mediumTerm.growthPersistence, fwdInflPersistence: mediumTerm.inflPersistence,
    fwdGrowthPersistenceConfidence: mediumTerm.growthPersistenceConfidence,
    fwdInflPersistenceConfidence: mediumTerm.inflPersistenceConfidence,
    fwdGrowthAxis: mediumTerm.growthAxis, fwdInflAxis: mediumTerm.inflAxis,
    nearTermFwdKey: nearTerm.key, nearTermFwdConf: nearTerm.conf,
    nearTermGrowthPersistence: nearTerm.growthPersistence, nearTermInflPersistence: nearTerm.inflPersistence,
    nearTermGrowthPersistenceConfidence: nearTerm.growthPersistenceConfidence,
    nearTermInflPersistenceConfidence: nearTerm.inflPersistenceConfidence,
    nearTermGrowthAxis: nearTerm.growthAxis, nearTermInflAxis: nearTerm.inflAxis,
  };
}

// "Always show a quadrant" follow-up: builds the bracketed explanation
// appended after a lens's label so Clio (and the consistency checker,
// which shares this exact text via buildReferenceBlock) knows the label IS
// a real quadrant name to use directly — the already-confirmed regime when
// both axes are Persistent (a stronger continuation signal, not a fresh
// classification), or a nearSide-based LEANING quadrant with a hedge naming
// which axis is actually driving it when only one axis is. This replaces
// the prior instruction to avoid naming a quadrant at all — the live page
// now always shows one (see app/macro/page.jsx's identical leaningLabel/
// leaningHedge split), so Clio's prose must match what users see on screen
// instead of falling back to a bare, uninformative "Persistence."
function persistenceNote(
  growthAxis: AxisState | null | undefined, inflAxis: AxisState | null | undefined,
  anchorLabel: string | null, label: string,
): string {
  const growthPersistent = !!growthAxis?.persistence;
  const inflPersistent = !!inflAxis?.persistence;
  if (!growthPersistent && !inflPersistent) return "";
  const anchor = anchorLabel ? ` Last confirmed regime: ${anchorLabel}.` : "";
  if (growthPersistent && inflPersistent) {
    return ` [Regime continuation — "${label}" is the already-confirmed regime, not a fresh classification: both Growth (${growthAxis?.persistenceConfidence ?? "?"}% confidence) and Inflation (${inflAxis?.persistenceConfidence ?? "?"}% confidence) are inside their dead bands — flat readings, not missing data, and neither axis moved.${anchor}]`;
  }
  const hedge = leaningHedge(growthAxis, inflAxis);
  return ` ["${label}" is a LEANING quadrant, provisional — use the name, but hedge it: ${hedge}${anchor}]`;
}

// ── Reference block shared by the main prompt and the consistency checker ──────
// Keeping this in one place means the "ground truth" the model is constrained
// against and the "ground truth" the validator checks against never drift apart.
function buildReferenceBlock(p: {
  regimeLabel: string; marketLabel: string | null; fwdLabel: string | null; fwdConf: number | null;
  qualifier: string;
  nearTermFwdLabel: string | null; nearTermFwdConf: number | null; nearTermQualifier: string;
  structuralNote: string; marketNote: string; fwdNote: string; nearTermNote: string;
  yieldCurveValue: number | null; yieldCurveState: YieldCurveState;
  credit: CreditIndicator[]; liquidity: LiquidityIndicator;
}): string {
  const creditLines = p.credit
    .map((c) => `  ${c.name}: ${c.value != null ? c.value : "n/a"}${c.status ? ` (${c.status.toUpperCase()})` : ""}`)
    .join("\n");
  const liq = p.liquidity;
  const liquidityLine = liq.totalCompositeYoy != null
    ? `${liq.totalCompositeYoy >= 0 ? "+" : ""}${liq.totalCompositeYoy.toFixed(1)}% YoY (z ${liq.zscore != null ? liq.zscore.toFixed(2) : "n/a"}σ), ${liq.direction} vs. 6 months ago`
    : "n/a";
  return `Structural regime: ${p.regimeLabel}${p.structuralNote}
Market-implied regime: ${p.marketLabel ?? "unknown"}${p.marketNote}
Medium-Term Forward Signal (6-18mo): ${p.fwdLabel ?? "none"}${p.fwdConf != null ? `, ${p.fwdConf}% confidence — must be described as "${p.qualifier}"` : ""}${p.fwdNote}
Near-Term Forward Signal (2-3mo): ${p.nearTermFwdLabel ?? "none"}${p.nearTermFwdConf != null ? `, ${p.nearTermFwdConf}% confidence — must be described as "${p.nearTermQualifier}"` : ""}${p.nearTermNote}
2/10 yield curve: ${p.yieldCurveValue != null ? p.yieldCurveValue.toFixed(2) + "%" : "n/a"} — ${YIELD_CURVE_STATE_NOTE[p.yieldCurveState]}
Credit stress indicators (lead recessions; HEALTHY = no stress despite any bust narrative):
${creditLines}
Liquidity composite (leads risk appetite): ${liquidityLine}`;
}

// ── Main regime analysis ──────────────────────────────────────────────────────
async function generateAnalysis(params: {
  regimeLabel: string; marketLabel: string | null; fwdLabel: string | null;
  fwdConf: number | null; nearTermFwdLabel: string | null; nearTermFwdConf: number | null;
  structuralNote: string; marketNote: string; fwdNote: string; nearTermNote: string;
  divergence: boolean;
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
      regimeLabel, marketLabel, fwdLabel, fwdConf, nearTermFwdLabel, nearTermFwdConf, divergence,
      structuralNote, marketNote, fwdNote, nearTermNote,
      gdp, cpi, ppi, t10y2y, lei, breakeven,
      prevGdp, prevCpi, prevPpi, prevLei, prevBe,
      marketSnapshot, supplyChain, yieldCurveState, credit, liquidity, today, correction,
    } = params;
    const todayFormatted = new Date(today + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

    const qualifier = confidenceQualifier(fwdConf);
    const nearTermQualifier = confidenceQualifier(nearTermFwdConf);

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

CONFIDENCE LANGUAGE — HARD CONSTRAINT: When describing confidence in the structural/momentum-implied regime or the Medium-Term Forward Signal (Signal 3), use language consistent with "${qualifier}" (derived from the ${fwdConf ?? "n/a"}% Medium-Term forward-signal confidence). When describing confidence in the Near-Term Forward Signal specifically (Signal 3b), use "${nearTermQualifier}" instead (derived from its own ${nearTermFwdConf ?? "n/a"}% confidence) — the two horizons frequently carry different confidence and must not be conflated. Never use stronger language (e.g. "high confidence," "unambiguous," "clearly confirmed") than the relevant band supports for whichever signal you're describing, and never contradict either band elsewhere in the piece.

You have six signals that may conflict. Reconcile them explicitly.

PERSISTENCE — HARD CONSTRAINT: any signal above followed by a bracketed note is a lens where at least one axis is inside its dead band (a flat, level-anchored read, not missing data and not a coin-flip). The NAME given (e.g. "Reflation") is still the correct word to use — never replace it with the bare word "Persistence" or refuse to name a quadrant. Two cases: (1) "Regime continuation" notes mean BOTH axes are flat — the name is the already-confirmed regime holding steady, describe it as continuation, not a fresh classification. (2) "LEANING quadrant, provisional" notes mean ONE axis is flat — use the name, but hedge it exactly as the note says, naming which axis (Growth/Inflation) is the real driver and which is provisional.

SIGNAL 1 — Structural regime (level-based, 3Y trailing averages):
  ${regimeLabel}${structuralNote}

SIGNAL 2 — Structural momentum (direction of hard data, 15–60 day lag):
  GDP:      ${n(gdp, 2, true)}${delta(gdp, prevGdp)} ${arrow(gdp, prevGdp)}
  CPI:      ${n(cpi, 2)}${delta(cpi, prevCpi)} ${arrow(cpi, prevCpi)}
  PPI:      ${n(ppi, 2, true)}${delta(ppi, prevPpi)} ${arrow(ppi, prevPpi)}
  10Y BE:   ${n(breakeven, 2)}${delta(breakeven, prevBe)} ${arrow(breakeven, prevBe, 0.02)}
  LEI:      ${n(lei, 2, true)}${delta(lei, prevLei)} ${arrow(lei, prevLei)}
  2/10 spread: ${n(t10y2y, 2, true)} — ${YIELD_CURVE_STATE_NOTE[yieldCurveState]}
  Yield-curve framing constraint: only describe the curve as a "recession warning" if its state is normalizing_from_inversion. If never_inverted_steep, do not call it a recession signal. If inverted, call it an active inversion, not a normalization story.
  Momentum-implied regime: ${momentumRegime}${momentumDiverges ? ` ⚑ diverges from structural ${regimeLabel}${structuralNote ? " (structural's read is provisional/continuation, not a fresh classification — see note above; frame this as momentum vs. a flat structural read, not a clean regime conflict)" : ""}` : " ✓ aligns"}

SIGNAL 2b — Credit stress (leads recessions; check this before asserting a bust case):
${creditLines || "  No credit-stress data available."}
${anyCreditHealthy ? `  Constraint: at least one credit-stress indicator above is HEALTHY. If your narrative leans toward an imminent recession/deflationary-bust case, you MUST explicitly acknowledge this tension (e.g. "credit markets are not yet confirming this") rather than asserting an unhedged bust case.` : ""}

SIGNAL 2c — Liquidity momentum (Fed net liquidity + private liquidity proxy, leads risk appetite by ~12-18 months; public-data approximation of the Michael Howell / GL Indexes global liquidity framework):
  Total Composite YoY: ${liquidityLine}
  Reading guide: above zero and accelerating = expansionary tailwind (risk-on historically favored); above zero but decelerating = late-cycle caution; below zero = contraction, historically the most dangerous regime for risk assets.
${liquidityConstraint}

SIGNAL 3 — Market pricing (yesterday's action, forward-looking) and Medium-Term Forward Signal (6-18mo composite):
  Market-implied regime: ${marketLabel ?? "unknown"}${marketNote}
  ${divergence ? `⚑ Market diverges from structural regime` : "✓ Market aligns with structural regime"}
  Medium-Term Forward Signal: ${fwdLabel ?? "none"}${fwdConf != null ? ` (${fwdConf}% confidence — "${qualifier}")` : ""}${fwdNote}
  ${mktLines}

SIGNAL 3b — Near-Term Forward Signal (2-3mo composite — independently scored from Signal 3's Medium-Term one; the two can and do disagree, which is itself informative, not noise to reconcile away):
  ${nearTermFwdLabel ?? "none"}${nearTermFwdConf != null ? ` (${nearTermFwdConf}% confidence — "${nearTermQualifier}")` : ""}${nearTermNote}
  ${fwdLabel && nearTermFwdLabel && fwdLabel !== nearTermFwdLabel ? `⚑ Near-Term and Medium-Term forward signals disagree — name this explicitly, it matters for how far out any tactical call should be sized.` : fwdLabel && nearTermFwdLabel ? "✓ Near-Term and Medium-Term forward signals agree on direction (confidence levels may still differ — see above)." : ""}

SIGNAL 4 — Supply chain / structural tail risk (12 tracked chokepoints, daily AI+web-search scored, 0–100). Each is tagged [ACTIVE] (a confirmed, currently-in-progress disruption) or [STRUCTURAL] (elevated but latent — no live triggering event right now):
${scLines || "  No critical or worsening chokepoints currently flagged."}
  Framing constraint: only describe an [ACTIVE] item as a "live catalyst within N days." An [STRUCTURAL] item must be framed as an "elevated tail risk" or similar — do not describe it as an active/live/imminent catalyst on the same footing as an [ACTIVE] item, even if its score is equally high.

Structure your answer in four parts, separated by blank lines:
(1) A paragraph: what is the hard data momentum telling us — is the structural regime transitioning, and how confident should we be? (must use the "${qualifier}" language constraint above)
(2) A paragraph: is yesterday's market action consistent with that momentum signal, or pricing a different scenario? Address BOTH forward signals (3 and 3b) explicitly, using each one's own confidence-language band — if they disagree with each other per Signal 3b's flag, say so by name rather than blending them into one composite view. If leaning toward a recession/bust read, address the credit-stress tension from Signal 2b if it applies. Also weigh in the liquidity signal (2c) — does it corroborate or complicate the market-pricing read on risk appetite, respecting its constraint above.
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
  nearTermFwdLabel: string | null; nearTermFwdConf: number | null;
  fwdLabel: string | null; fwdConf: number | null;
  structuralNote: string; marketNote: string; fwdNote: string; nearTermNote: string;
  fedOdds: FedOdds | null;
  today: string;
}): Promise<string | null> {
  if (!ANTHROPIC_KEY || params.headlines.length === 0) return null;
  try {
    const {
      headlines, watchedHeadlines, regimeLabel, momentumRegime, marketLabel,
      nearTermFwdLabel, nearTermFwdConf, fwdLabel, fwdConf,
      structuralNote, marketNote, fwdNote, nearTermNote,
      fedOdds, today,
    } = params;
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

Current regime signals — all four panels tracked on this page, not just one:
  Structural: ${regimeLabel}${structuralNote}
  Momentum-implied: ${momentumRegime}
  Market-implied: ${marketLabel ?? "unknown"}${marketNote}
  Near-Term Forward Signal (2-3mo): ${nearTermFwdLabel ?? "none"}${nearTermFwdConf != null ? ` (${nearTermFwdConf}% confidence)` : ""}${nearTermNote}
  Medium-Term Forward Signal (6-18mo): ${fwdLabel ?? "none"}${fwdConf != null ? ` (${fwdConf}% confidence)` : ""}${fwdNote}
REQUIRED: your second paragraph must explicitly address whether the headline narrative is consistent with BOTH forward signals above, not just the structural/market regime — call out by name any place the Near-Term and Medium-Term panels disagree with each other, since that disagreement (a near-term wobble inside a longer uptrend, or vice versa) is itself informative, not noise to smooth over. Any signal followed by a bracketed note above is a real flat-read result on at least one axis, not missing data and not a coin-flipped direction — the name given is still correct, describe it as regime continuation or a hedged leaning quadrant exactly per its bracketed note.

Top macro headlines (last 24–48 hours):
${newsLines}
${mvInstruction}
${fedOddsBlock}
${watchedInstruction}

Assess: (1) What macro narrative are these headlines collectively signaling — growth, inflation, credit stress, risk-on, or risk-off? (2) Does that narrative align with or diverge from ALL FOUR regime signals above (structural, market-implied, near-term forward, medium-term forward) and the priced Fed odds, and what (if anything) should a BW Modified portfolio holder do differently in response?`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
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
    // Generic metadata-number reader — used by Forward Signal's
    // useMetaField signals (e.g. Consumer Inflation Expectations' umich_1yr).
    const getMetaNum = (name: string, key: string): number | null => {
      const i = (macroRows ?? []).find((x: { name: string; metadata: Record<string, unknown> | null }) => x.name === name);
      const v = i?.metadata?.[key];
      return typeof v === "number" ? v : null;
    };
    // Spread between the actual reading and its SPF consensus forecast
    // (stamped onto the indicator's own metadata by update-spf-forecasts) —
    // positive means the economy is beating what forecasters expected.
    // `field` selects nearest-available (spf_consensus_gdp) vs pure
    // multi-quarter-ahead (spf_consensus_gdp_fwd, Medium-Term's "GDP vs SPF").
    const getSpfSpread = (name: string, field: string = "spf_consensus_gdp"): number | null => {
      const i = (macroRows ?? []).find((x: { name: string; current_value: number | null; metadata: Record<string, unknown> | null }) => x.name === name);
      const actual = i?.current_value != null ? Number(i.current_value) : null;
      const consensus = (i?.metadata as Record<string, unknown> | null | undefined)?.[field];
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
    const {
      structuralKey, marketKey,
      structuralGrowthAxis, structuralInflAxis, marketGrowthAxis,
      fwdKey, fwdConf, nearTermFwdKey, nearTermFwdConf,
      fwdGrowthPersistence, fwdInflPersistence, fwdGrowthPersistenceConfidence, fwdInflPersistenceConfidence,
      fwdGrowthAxis, fwdInflAxis,
      nearTermGrowthPersistence, nearTermInflPersistence, nearTermGrowthPersistenceConfidence, nearTermInflPersistenceConfidence,
      nearTermGrowthAxis, nearTermInflAxis,
    } = computeLiveRegimeKeys(get, getMeta3m, getPP3m, getShortPct, getVolShock, getSpfSpread, getPrev, getMetaNum);

    // Dead-band-persistence spec: a null key from computeLiveRegimeKeys can
    // now mean either genuinely missing data OR a level-anchored Persistence
    // read — disambiguate via the axis-state/persistence flags above.
    const structuralPersistent = !!structuralGrowthAxis?.persistence || !!structuralInflAxis?.persistence;
    const marketPersistent = !!marketGrowthAxis?.persistence;
    const divergence = !!(structuralKey && marketKey && structuralKey !== marketKey);
    const breakevenVal = get("10Y Breakeven Inflation") ?? FED_INFLATION_TARGET;

    // "Currently confirmed regime" anchor: computed LIVE via
    // detectRegimeKeyRaw, the exact same raw fallback
    // app/macro/page.jsx's regimeKey chain (majorityRegimeKey ??
    // structuralRegimeKey ?? detectRegimeKey(raw)) ends on once both of the
    // first two are null — which is exactly the both-Persistent case this
    // anchor exists for. Previously this ran a macro_regime_history DB
    // lookback instead (the most recent quarter with a non-null
    // structural_key); confirmed live that this could name a DIFFERENT
    // regime than the frontend's own anchor for the identical moment
    // ("Disinflationary Boom" from the lookback vs. "Stagflation" from the
    // frontend's raw fallback) — exactly the drift Clio's narrative must
    // not have, so the lookback is replaced with the identical live
    // computation instead of a second, independently-drifting source.
    let lastConfirmedLabel: string | null = null;
    if (structuralPersistent || marketPersistent || fwdGrowthPersistence || fwdInflPersistence || nearTermGrowthPersistence || nearTermInflPersistence) {
      const rawGdp = get("Real GDP Growth");
      const rawCpi = get("CPI (YoY)");
      const gdp4qAvg = get("GDP Growth (4Q Avg)") ?? 0;
      if (rawGdp != null && rawCpi != null) {
        const rawLaborInputs = {
          payrolls3mAvg: get("Payrolls (3M Avg)"),
          unemploymentTrend: get("Unemployment Rate Trend"),
          joblessClaimsTrend: get("Initial Jobless Claims Trend"),
        };
        const rawKey = detectRegimeKeyRaw(rawGdp, rawCpi, breakevenVal, gdp4qAvg, rawLaborInputs);
        lastConfirmedLabel = REGIME_LABELS[rawKey] ?? rawKey;
      }
    }

    // "Always show a quadrant" follow-up (mirrors app/macro/page.jsx's
    // identical split): Clio (and the "structural_regime"/"market_regime"
    // DB columns the /macro and /portfolios badges render verbatim) now see
    // a real quadrant name — the already-confirmed one when both axes are
    // Persistent, or a nearSide-based leaning one for the mixed case — not
    // the old bare "Persistence" label that gave no quadrant word at all.
    // Market's inflation leg (breakeven vs Fed target) is a plain threshold
    // with no Persistence state of its own — wrap it so leaningQuadrantKey
    // sees it the same shape as a resolveAxisState object; Market can
    // therefore only ever land in the mixed case, never both-Persistent.
    const marketInflAxis: AxisState = { persistence: false, up: breakevenVal > FED_INFLATION_TARGET, persistenceConfidence: null, nearSide: null };
    const regimeLabel = structuralKey
      ? (REGIME_LABELS[structuralKey] ?? structuralKey)
      : structuralPersistent
        ? leaningLabel(!!structuralGrowthAxis?.persistence, !!structuralInflAxis?.persistence, structuralGrowthAxis, structuralInflAxis, lastConfirmedLabel)
        : "Unknown";
    const marketLabel = marketKey
      ? (REGIME_LABELS[marketKey] ?? marketKey)
      : marketPersistent
        ? leaningLabel(true, false, marketGrowthAxis, marketInflAxis, lastConfirmedLabel)
        : null;
    const fwdLabel = fwdKey
      ? (REGIME_LABELS[fwdKey] ?? fwdKey)
      : (fwdGrowthPersistence || fwdInflPersistence)
        ? leaningLabel(fwdGrowthPersistence, fwdInflPersistence, fwdGrowthAxis, fwdInflAxis, lastConfirmedLabel)
        : null;
    // Near-Term (2-3mo) Forward Signal — see the forward-signal two-horizon
    // spec. fwdLabel/fwdConf above are Medium-Term (6-18mo) specifically.
    const nearTermFwdLabel = nearTermFwdKey
      ? (REGIME_LABELS[nearTermFwdKey] ?? nearTermFwdKey)
      : (nearTermGrowthPersistence || nearTermInflPersistence)
        ? leaningLabel(nearTermGrowthPersistence, nearTermInflPersistence, nearTermGrowthAxis, nearTermInflAxis, lastConfirmedLabel)
        : null;

    const structuralNote = structuralKey ? "" : persistenceNote(structuralGrowthAxis, structuralInflAxis, lastConfirmedLabel, regimeLabel);
    const marketNote = marketKey ? "" : persistenceNote(marketGrowthAxis, marketInflAxis, lastConfirmedLabel, marketLabel ?? "Persistence");
    const fwdNote = fwdKey ? "" : persistenceNote(fwdGrowthAxis, fwdInflAxis, lastConfirmedLabel, fwdLabel ?? "Persistence");
    const nearTermNote = nearTermFwdKey ? "" : persistenceNote(nearTermGrowthAxis, nearTermInflAxis, lastConfirmedLabel, nearTermFwdLabel ?? "Persistence");

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
      regimeLabel, marketLabel, fwdLabel, fwdConf, nearTermFwdLabel, nearTermFwdConf,
      structuralNote, marketNote, fwdNote, nearTermNote,
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
      generateNewsMusing({
        headlines, watchedHeadlines: dedupedWatched, regimeLabel, momentumRegime, marketLabel,
        nearTermFwdLabel, nearTermFwdConf, fwdLabel, fwdConf,
        structuralNote, marketNote, fwdNote, nearTermNote,
        fedOdds, today,
      }),
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
      nearTermFwdLabel, nearTermFwdConf,
      nearTermQualifier: confidenceQualifier(nearTermFwdConf),
      structuralNote, marketNote, fwdNote, nearTermNote,
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
      nearterm_forward_key: nearTermFwdKey,
      nearterm_forward_confidence: nearTermFwdConf,
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
