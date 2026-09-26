import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// AI Capex Cycle Overlay — measures whether the AI capex boom is stretching toward a
// Perez/Minsky-style bust and turns that into scenario posteriors + bucket multipliers.
//
// Pipeline (identical code path for live and walk-forward history, so no drift):
//   1. Ingest: FRED CSV (no key), SEC XBRL companyconcept (hyperscaler cash flows),
//      Yahoo recent closes (SPY/RSP/SMH/BIZD) -> capex_indicator_observations
//   2. computeAt(asOf): indicator z-scores (rolling window, only data available at asOf)
//      -> 5 pillar scores -> CCSI (Capex Cycle Stress Index)
//   3. Rate-of-change triggers -> logistic 12m peak hazard -> rule-based regime
//   4. Pre-registered evidence rules -> Bayesian scenario posteriors (recomputed from base
//      prior each run; correlated rules combined by geometric mean within group)
//   5. Posterior-weighted scenario multipliers x regime multipliers -> bucket multipliers
//
// Query params:  ?mode=probe      test data sources only
//                ?backfill=1      also recompute month-end walk-forward history
//                ?skip_ingest=1   compute from stored observations only

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

type Obs = { date: string; value: number };
type Def = {
  code: string; label: string; pillar: string; source: string; source_key: string | null;
  direction: number; weight: number; frequency: string; availability_lag_days: number;
  ref_mean: number | null; ref_std: number | null; min_obs_for_z: number; is_active: boolean;
};

const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const r4 = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

// ───────────────────────────── FRED ─────────────────────────────
async function fetchFred(id: string, cosd = "1990-01-01"): Promise<Obs[]> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const text = await res.text();
      if (!text.startsWith("observation_date") && !text.startsWith("DATE")) { lastErr = "not a FRED CSV"; continue; }
      const out: Obs[] = [];
      for (const line of text.trim().split("\n").slice(1)) {
        const [date, raw] = line.split(",");
        const v = parseFloat(raw);
        if (date && isFinite(v)) out.push({ date, value: v });
      }
      return out;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }
  throw new Error(`FRED ${id}: ${lastErr}`);
}

// Month-end sampling (last observation in each calendar month) — keeps daily series light.
function monthEndSample(obs: Obs[]): Obs[] {
  const byMonth = new Map<string, Obs>();
  for (const o of obs) byMonth.set(o.date.slice(0, 7), o);
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function yoyByLag(obs: Obs[], lag: number): Obs[] {
  const out: Obs[] = [];
  for (let i = lag; i < obs.length; i++) {
    if (obs[i - lag].value !== 0) out.push({ date: obs[i].date, value: (obs[i].value / obs[i - lag].value - 1) * 100 });
  }
  return out;
}

// ───────────────────────────── SEC XBRL ─────────────────────────────
const SEC_UA = { "User-Agent": "Ratiobo research (ratiobo.com)", "Accept": "application/json" };
const HYPERSCALERS: Record<string, string> = {
  MSFT: "0000789019", GOOGL: "0001652044", AMZN: "0001018724", META: "0001326801", ORCL: "0001341439",
};
const SEC_TAGS: Record<string, string[]> = {
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  ocf: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  lt_debt_issued: [
    "ProceedsFromIssuanceOfLongTermDebt", "ProceedsFromIssuanceOfSeniorLongTermDebt",
    "ProceedsFromDebtNetOfIssuanceCosts", "ProceedsFromIssuanceOfDebt",
    "ProceedsFromLongTermDebtAndCapitalSecuredBorrowings",
  ],
};

type SecEntry = { start: string; end: string; val: number; filed: string; form: string };
type SecQuarter = { period_end: string; value: number; derived: boolean; tag: string; filed: string };

function nearestCalQuarterEnd(d: string): string {
  const t = Date.parse(d);
  const y = parseInt(d.slice(0, 4));
  const cands = [`${y - 1}-12-31`, `${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`];
  return cands.reduce((best, c) => Math.abs(Date.parse(c) - t) < Math.abs(Date.parse(best) - t) ? c : best);
}
function prevCalQuarterEnd(q: string, n = 1): string {
  let y = parseInt(q.slice(0, 4)), m = parseInt(q.slice(5, 7));
  for (let i = 0; i < n; i++) { m -= 3; if (m <= 0) { m += 12; y--; } }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${last}`;
}

async function fetchSecConcept(cik: string, tag: string): Promise<SecEntry[] | null> {
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, { headers: SEC_UA });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SEC ${cik}/${tag}: HTTP ${res.status}`);
  const j = await res.json();
  const usd = j?.units?.USD as Record<string, unknown>[] | undefined;
  if (!usd) return null;
  return usd
    .filter((u) => u.start && u.end && typeof u.val === "number" && /^10-[QK]/.test(String(u.form)))
    .map((u) => ({ start: String(u.start), end: String(u.end), val: Number(u.val), filed: String(u.filed), form: String(u.form) }));
}

// Derive single-quarter values from a mix of 3-month and YTD cumulative filings.
function deriveQuarters(entries: SecEntry[], tag: string): SecQuarter[] {
  const latest = new Map<string, SecEntry>();
  for (const e of entries) {
    const k = `${e.start}|${e.end}`;
    const cur = latest.get(k);
    if (!cur || e.filed > cur.filed) latest.set(k, e);
  }
  const all = [...latest.values()];
  const dur = (e: SecEntry) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
  const out = new Map<string, SecQuarter>();
  for (const e of all) {
    const d = dur(e);
    if (d >= 80 && d <= 100) out.set(e.end, { period_end: e.end, value: e.val, derived: false, tag, filed: e.filed });
  }
  const byStart = new Map<string, SecEntry[]>();
  for (const e of all) {
    if (dur(e) > 100 && dur(e) < 380) {
      const arr = byStart.get(e.start) ?? [];
      arr.push(e);
      byStart.set(e.start, arr);
    }
  }
  for (const [start, arr] of byStart) {
    // include the Q1 3-month entry with the same start as the base of the YTD chain
    const q1 = all.find((e) => e.start === start && dur(e) >= 80 && dur(e) <= 100);
    const chain = [...(q1 ? [q1] : []), ...arr].sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < chain.length; i++) {
      const gap = (Date.parse(chain[i].end) - Date.parse(chain[i - 1].end)) / DAY;
      if (gap < 80 || gap > 100) continue;
      if (out.has(chain[i].end) && !out.get(chain[i].end)!.derived) continue;
      out.set(chain[i].end, {
        period_end: chain[i].end, value: chain[i].val - chain[i - 1].val, derived: true, tag, filed: chain[i].filed,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.period_end.localeCompare(b.period_end));
}

async function ingestSec(sb: SupabaseClient, errors: Record<string, string>) {
  const rows: Record<string, unknown>[] = [];
  for (const [ticker, cik] of Object.entries(HYPERSCALERS)) {
    for (const [metric, tags] of Object.entries(SEC_TAGS)) {
      // Merge RAW filings across tags first (earlier-listed tag wins per start|end), then derive
      // quarters once — so a YTD chain that switches tags mid-year (AMZN 2017) still differences.
      const raw = new Map<string, SecEntry & { tag: string }>();
      for (const tag of tags) {
        try {
          const entries = await fetchSecConcept(cik, tag);
          await new Promise((r) => setTimeout(r, 120)); // stay well under SEC's 10 req/s
          for (const e of entries ?? []) {
            const k = `${e.start}|${e.end}`;
            const cur = raw.get(k);
            if (!cur || (cur.tag === tag && e.filed > cur.filed)) raw.set(k, { ...e, tag });
          }
        } catch (e) { errors[`sec_${ticker}_${tag}`] = e instanceof Error ? e.message : String(e); }
      }
      const tagOf = new Map([...raw.values()].map((e) => [e.end, e.tag]));
      const merged = deriveQuarters([...raw.values()], "merged").map((q) => ({ ...q, tag: tagOf.get(q.period_end) ?? q.tag }));
      for (const q of merged) {
        rows.push({
          ticker, metric, period_end: q.period_end, cal_quarter_end: nearestCalQuarterEnd(q.period_end),
          value_usd: q.value, derived: q.derived, xbrl_tag: q.tag, filed: q.filed, updated_at: new Date().toISOString(),
        });
      }
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("capex_sec_financials").upsert(rows.slice(i, i + 500), { onConflict: "ticker,metric,period_end" });
    if (error) errors.sec_upsert = error.message;
  }
  return rows.length;
}

// Aggregate the 5 hyperscalers into TTM ratios by calendar quarter.
async function hyperscalerIndicators(sb: SupabaseClient): Promise<Record<string, Obs[]>> {
  // PostgREST caps each response at 1000 rows — page through.
  const data: { ticker: string; metric: string; cal_quarter_end: string; value_usd: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await sb.from("capex_sec_financials").select("ticker,metric,cal_quarter_end,value_usd")
      .order("ticker").order("metric").order("period_end").range(from, from + 999);
    if (error) throw new Error(error.message);
    data.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  const v = new Map<string, number>(); // ticker|metric|q
  const tickersWith = new Map<string, Set<string>>(); // metric -> tickers that report it at all
  for (const r of data ?? []) {
    v.set(`${r.ticker}|${r.metric}|${r.cal_quarter_end}`, Number(r.value_usd));
    if (!tickersWith.has(r.metric)) tickersWith.set(r.metric, new Set());
    tickersWith.get(r.metric)!.add(r.ticker);
  }
  const quarters: string[] = [...new Set<string>((data ?? []).map((r: { cal_quarter_end: string }) => r.cal_quarter_end))].sort();
  const tickers = Object.keys(HYPERSCALERS);

  const ttm = (metric: string, q: string, zeroIfMissing = false): number | null => {
    let sum = 0;
    for (const t of tickers) {
      if (zeroIfMissing && !tickersWith.get(metric)?.has(t)) continue;
      for (let k = 0; k < 4; k++) {
        const x = v.get(`${t}|${metric}|${prevCalQuarterEnd(q, k)}`);
        if (x == null) { if (zeroIfMissing) continue; return null; }
        sum += x;
      }
    }
    return sum;
  };

  const out: Record<string, Obs[]> = {
    hs_capex_to_ocf: [], hs_capex_yoy: [], hs_fcf_margin: [], hs_capex_to_revenue: [], hs_debt_to_capex: [],
  };
  for (const q of quarters) {
    const capex = ttm("capex", q), ocf = ttm("ocf", q), rev = ttm("revenue", q);
    if (capex == null || ocf == null || rev == null || ocf <= 0 || rev <= 0) continue;
    out.hs_capex_to_ocf.push({ date: q, value: capex / ocf });
    out.hs_fcf_margin.push({ date: q, value: ((ocf - capex) / rev) * 100 });
    out.hs_capex_to_revenue.push({ date: q, value: (capex / rev) * 100 });
    const capexYa = ttm("capex", prevCalQuarterEnd(q, 4));
    if (capexYa && capexYa > 0) out.hs_capex_yoy.push({ date: q, value: (capex / capexYa - 1) * 100 });
    const debt = ttm("lt_debt_issued", q, true);
    if (debt != null) out.hs_debt_to_capex.push({ date: q, value: debt / capex });
  }
  return out;
}

// ───────────────────────────── Yahoo / prices ─────────────────────────────
const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, */*", "Referer": "https://finance.yahoo.com/",
};
const MARKET_SYMBOLS = ["SPY", "RSP", "SMH", "BIZD"];

async function syncRecentPrices(sb: SupabaseClient, errors: Record<string, string>) {
  for (const symbol of MARKET_SYMBOLS) {
    try {
      let j: Record<string, unknown> | null = null;
      for (const host of ["query1", "query2"]) {
        const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`, { headers: YAHOO_HEADERS });
        if (res.ok) { j = await res.json(); break; }
      }
      // deno-lint-ignore no-explicit-any
      const r0 = (j as any)?.chart?.result?.[0];
      if (!r0) { errors[`yahoo_${symbol}`] = "no result"; continue; }
      const ts: number[] = r0.timestamp ?? [];
      const adj: (number | null)[] = r0.indicators?.adjclose?.[0]?.adjclose ?? r0.indicators?.quote?.[0]?.close ?? [];
      const rows = ts.map((t, i) => ({ symbol, date: new Date(t * 1000).toISOString().slice(0, 10), close: adj[i], source: "yahoo_finance" }))
        .filter((r) => r.close != null && r.close > 0)
        .map((r) => ({ ...r, close: Math.round((r.close as number) * 10000) / 10000 }));
      const { error } = await sb.from("asset_price_history").upsert(rows, { onConflict: "symbol,date" });
      if (error) errors[`yahoo_${symbol}`] = error.message;
    } catch (e) { errors[`yahoo_${symbol}`] = e instanceof Error ? e.message : String(e); }
  }
}

async function loadPrices(sb: SupabaseClient, symbol: string): Promise<Obs[]> {
  const out: Obs[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("asset_price_history").select("date,close").eq("symbol", symbol)
      .order("date", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []).map((r: { date: string; close: number }) => ({ date: r.date, value: Number(r.close) })));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// index of last obs with date <= d (binary search), -1 if none
function idxAtOrBefore(a: Obs[], d: string): number {
  let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].date <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

type PriceBook = Record<string, Obs[]>;

// Price-derived signals at a given date (no look-ahead: only closes <= asOf).
function priceSignals(p: PriceBook, asOf: string) {
  const out: Record<string, number | null> = {
    spy_rsp_ratio: null, smh_spy_rel_12m: null, bizd_drawdown: null, smh_vs_200dma: null, smh_drawdown_2y: null,
  };
  const iSpy = idxAtOrBefore(p.SPY, asOf), iRsp = idxAtOrBefore(p.RSP, asOf);
  const iSmh = idxAtOrBefore(p.SMH, asOf), iBizd = idxAtOrBefore(p.BIZD, asOf);
  if (iSpy >= 0 && iRsp >= 0) out.spy_rsp_ratio = p.SPY[iSpy].value / p.RSP[iRsp].value;
  if (iSmh >= 252 && iSpy >= 252) {
    const dateYa = p.SMH[iSmh - 252].date;
    const jSpy = idxAtOrBefore(p.SPY, dateYa);
    if (jSpy >= 0) out.smh_spy_rel_12m = ((p.SMH[iSmh].value / p.SMH[iSmh - 252].value) / (p.SPY[iSpy].value / p.SPY[jSpy].value) - 1) * 100;
  }
  if (iBizd >= 20) {
    let hi = 0;
    for (let k = Math.max(0, iBizd - 251); k <= iBizd; k++) hi = Math.max(hi, p.BIZD[k].value);
    out.bizd_drawdown = (p.BIZD[iBizd].value / hi - 1) * 100;
  }
  if (iSmh >= 199) {
    let s = 0;
    for (let k = iSmh - 199; k <= iSmh; k++) s += p.SMH[k].value;
    out.smh_vs_200dma = (p.SMH[iSmh].value / (s / 200) - 1) * 100;
    let hi = 0;
    for (let k = Math.max(0, iSmh - 503); k <= iSmh; k++) hi = Math.max(hi, p.SMH[k].value);
    out.smh_drawdown_2y = (p.SMH[iSmh].value / hi - 1) * 100;
  }
  return out;
}

// Month-end history of price-derived indicator series (for z-scores).
function priceIndicatorHistory(p: PriceBook): Record<string, Obs[]> {
  const res: Record<string, Obs[]> = { spy_rsp_ratio: [], smh_spy_rel_12m: [], bizd_drawdown: [] };
  const dates = monthEndSample(p.SPY).map((o) => o.date);
  for (const d of dates) {
    const s = priceSignals(p, d);
    for (const k of Object.keys(res)) if (s[k] != null) res[k].push({ date: d, value: s[k] as number });
  }
  return res;
}

// ───────────────────────────── ingest ─────────────────────────────
async function upsertSeries(sb: SupabaseClient, code: string, obs: Obs[], dailyTail: boolean, errors: Record<string, string>) {
  if (!obs.length) return 0;
  if (dailyTail) {
    // current month holds only the latest reading — clear stale intra-month rows first
    const monthStart = obs[obs.length - 1].date.slice(0, 7) + "-01";
    await sb.from("capex_indicator_observations").delete().eq("indicator_code", code).eq("is_manual", false).gte("obs_date", monthStart);
  }
  const rows = obs.map((o) => ({ indicator_code: code, obs_date: o.date, value: r4(o.value), is_manual: false }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await sb.from("capex_indicator_observations").upsert(rows.slice(i, i + 1000), { onConflict: "indicator_code,obs_date" });
    if (error) { errors[`upsert_${code}`] = error.message; return 0; }
  }
  return rows.length;
}

async function ingestFred(sb: SupabaseClient, defs: Def[], errors: Record<string, string>, counts: Record<string, number>) {
  const cache = new Map<string, Obs[]>();
  const get = async (id: string) => {
    if (!cache.has(id)) cache.set(id, await fetchFred(id, id === "NASDAQCOM" ? "1971-01-01" : "1990-01-01"));
    return cache.get(id)!;
  };
  for (const d of defs.filter((x) => x.source === "fred" && x.source_key && x.is_active)) {
    try {
      let series: Obs[];
      const key = d.source_key!;
      if (key.includes("/")) {
        // "A+B/C" => (A+B)/C * 100 on common dates
        const [numPart, den] = key.split("/");
        const nums = await Promise.all(numPart.split("+").map(get));
        const denS = await get(den);
        const denMap = new Map(denS.map((o) => [o.date, o.value]));
        const numMaps = nums.map((s) => new Map(s.map((o) => [o.date, o.value])));
        series = nums[0].map((o) => o.date)
          .filter((dt) => denMap.has(dt) && numMaps.every((m) => m.has(dt)))
          .map((dt) => ({ date: dt, value: (numMaps.reduce((s, m) => s + m.get(dt)!, 0) / denMap.get(dt)!) * 100 }));
      } else {
        series = await get(key);
      }
      if (d.code === "corp_bond_debt_yoy") series = yoyByLag(series, 4);
      const daily = d.frequency === "daily";
      if (daily) series = monthEndSample(series);
      counts[d.code] = await upsertSeries(sb, d.code, series, daily, errors);
    } catch (e) { errors[d.code] = e instanceof Error ? e.message : String(e); }
  }
}

// ───────────────────────────── compute ─────────────────────────────
type Config = {
  pillar_weights: Record<string, number>; z_window_years: number;
  trigger_thresholds: Record<string, number>;
  hazard_model: { intercept: number; b_ccsi: number; b_triggers: number; calibrated: boolean };
  regime_thresholds: Record<string, number>;
  regime_multipliers: Record<string, Record<string, number>>;
  multiplier_clamp: { min: number; max: number };
  shadow_mode: boolean; backfill_start: string;
};
type Scenario = { code: string; prior: number; bucket_multipliers: Record<string, number> };
type Rule = {
  code: string; label: string; signal_key: string; operator: string; threshold: number;
  likelihoods: Record<string, number>; correlation_group: string; weight: number;
};
const BUCKETS = ["equity", "ai_semis", "credit", "long_bonds", "gold", "bitcoin", "cash"];

function availableDate(d: Def, obsDate: string): string {
  const per = d.source === "fred" ? (d.frequency === "quarterly" ? 92 : d.frequency === "monthly" ? 31 : 0) : 0;
  return addDays(obsDate, per + d.availability_lag_days);
}

function valueAtOrBefore(series: Obs[], d: string): Obs | null {
  const i = idxAtOrBefore(series, d);
  return i >= 0 ? series[i] : null;
}

function computeAt(
  asOf: string, strictAvailability: boolean, defs: Def[], obsByCode: Record<string, Obs[]>,
  prices: PriceBook, cfg: Config, scenarios: Scenario[], rules: Rule[],
) {
  // Visible slice of each series at asOf
  const visible: Record<string, Obs[]> = {};
  for (const d of defs) {
    const s = obsByCode[d.code] ?? [];
    visible[d.code] = s.filter((o) => (strictAvailability ? availableDate(d, o.date) : o.date) <= asOf);
  }

  // 1. indicator z-scores
  const windowStart = addDays(asOf, -Math.round(cfg.z_window_years * 365.25));
  const indicatorZ: Record<string, { value: number; z: number | null; signed_z: number | null; obs_date: string }> = {};
  for (const d of defs.filter((x) => x.pillar !== "aux" && x.is_active)) {
    const s = visible[d.code];
    if (!s.length) continue;
    const last = s[s.length - 1];
    // stale guard: ignore series whose latest visible point is > 18 months old
    if (Date.parse(asOf) - Date.parse(last.date) > 550 * DAY) continue;
    const win = s.filter((o) => o.date >= windowStart).map((o) => o.value);
    let z: number | null = null;
    if (win.length >= d.min_obs_for_z) {
      const sd = std(win);
      if (sd > 0) z = (last.value - mean(win)) / sd;
    } else if (d.ref_mean != null && d.ref_std && d.ref_std > 0) {
      z = (last.value - d.ref_mean) / d.ref_std;
    }
    if (z != null) z = Math.max(-3, Math.min(3, z));
    indicatorZ[d.code] = { value: r4(last.value)!, z: r4(z), signed_z: z == null ? null : r4(z * d.direction), obs_date: last.date };
  }

  // 2. pillars + CCSI
  const pillars: Record<string, number | null> = {};
  const coverage: Record<string, number> = {};
  for (const p of Object.keys(cfg.pillar_weights)) {
    let ws = 0, s = 0, n = 0;
    for (const d of defs.filter((x) => x.pillar === p)) {
      const iz = indicatorZ[d.code];
      if (iz?.signed_z == null) continue;
      ws += d.weight; s += d.weight * iz.signed_z; n++;
    }
    pillars[p] = ws > 0 ? s / ws : null;
    coverage[p] = n;
  }
  let pw = 0, ps = 0;
  for (const [p, w] of Object.entries(cfg.pillar_weights)) if (pillars[p] != null) { pw += w; ps += w * (pillars[p] as number); }
  const ccsi = pw > 0 ? ps / pw : null;

  // 3. signals (levels + rate of change)
  const latest = (c: string) => visible[c]?.length ? visible[c][visible[c].length - 1] : null;
  const changeOver = (c: string, days: number): number | null => {
    const l = latest(c);
    if (!l) return null;
    const prev = valueAtOrBefore(visible[c], addDays(l.date, -days));
    return prev ? l.value - prev.value : null;
  };
  const ps2 = priceSignals(prices, asOf);
  const spyRspZ = (() => {
    const s = (obsByCode.spy_rsp_ratio ?? []).filter((o) => o.date <= asOf && o.date >= windowStart).map((o) => o.value);
    return ps2.spy_rsp_ratio != null && s.length >= 8 && std(s) > 0 ? (ps2.spy_rsp_ratio - mean(s)) / std(s) : null;
  })();
  const signals: Record<string, number | null> = {
    hs_capex_yoy: latest("hs_capex_yoy")?.value ?? null,
    hs_capex_yoy_chg_2q: changeOver("hs_capex_yoy", 182),
    hs_capex_to_ocf: latest("hs_capex_to_ocf")?.value ?? null,
    hs_fcf_margin: latest("hs_fcf_margin")?.value ?? null,
    hs_fcf_margin_chg_4q: changeOver("hs_fcf_margin", 365),
    hy_oas: latest("hy_oas")?.value ?? null,
    hy_oas_chg_3m_bp: (() => { const c = changeOver("hy_oas", 91); return c == null ? null : c * 100; })(),
    dgs10: latest("aux_dgs10")?.value ?? null,
    dgs10_chg_3m_bp: (() => { const c = changeOver("aux_dgs10", 91); return c == null ? null : c * 100; })(),
    gpu_rental_yoy: latest("gpu_rental_yoy")?.value ?? null,
    spy_rsp_z: spyRspZ,
    ...ps2,
  };

  // 4. triggers, hazard, regime
  const t = cfg.trigger_thresholds;
  const lt = (v: number | null, x: number) => v != null && v < x;
  const gt = (v: number | null, x: number) => v != null && v > x;
  const triggers: Record<string, boolean> = {
    capex_decel: lt(signals.hs_capex_yoy_chg_2q, t.capex_decel_pp),
    credit_widening: gt(signals.hy_oas_chg_3m_bp, t.hy_widen_bp),
    bdc_stress: lt(signals.bizd_drawdown, t.bdc_drawdown_pct),
    semis_trend_break: lt(signals.smh_vs_200dma, 0),
    fcf_squeeze: lt(signals.hs_fcf_margin, t.fcf_margin_floor_pct) || lt(signals.hs_fcf_margin_chg_4q, t.fcf_margin_drop_pp),
    gpu_price_drop: lt(signals.gpu_rental_yoy, t.gpu_rental_yoy_pct),
  };
  const triggerCount = Object.values(triggers).filter(Boolean).length;
  const h = cfg.hazard_model;
  const hazard = ccsi == null ? null : 1 / (1 + Math.exp(-(h.intercept + h.b_ccsi * ccsi + h.b_triggers * triggerCount)));

  const rt = cfg.regime_thresholds;
  // Capex-stall gate (from the 2012-26 walk-forward + 1971-2026 BEA history): every trigger cluster
  // while hyperscaler capex kept growing (2016, 2018, 2022, 2025) was a cyclical correction followed
  // by strong returns; in the one true capex bust (2000) capex itself rolled over. So the de-risking
  // regimes (turn/bust) require capex growth to have stalled; stress without a stall = "correction".
  const capexStalled = signals.hs_capex_yoy == null ? true : signals.hs_capex_yoy < (rt.capex_stall_yoy_pct ?? 10);
  let regime = "boom", margin = 0.5;
  if (ccsi != null) {
    const stressed = triggerCount >= rt.turn_min_triggers;
    if (stressed && capexStalled && lt(signals.smh_drawdown_2y, rt.bust_smh_drawdown_pct) && triggerCount >= rt.bust_min_triggers) {
      regime = "bust"; margin = Math.min(1, (triggerCount - rt.bust_min_triggers + 1) / 3);
    } else if (stressed && capexStalled && ccsi >= rt.turn_ccsi) {
      regime = "turn"; margin = Math.min(1, (ccsi - rt.turn_ccsi) / 0.75 + (triggerCount - rt.turn_min_triggers) * 0.2);
    } else if (stressed && !capexStalled) {
      regime = "correction"; margin = Math.min(1, 0.4 + (triggerCount - rt.turn_min_triggers) * 0.2);
    } else if (ccsi >= rt.blowoff_ccsi) {
      regime = "blowoff"; margin = Math.min(1, (ccsi - rt.blowoff_ccsi) / 0.75);
    } else if (ccsi <= rt.deployment_ccsi) {
      regime = "deployment"; margin = Math.min(1, (rt.deployment_ccsi - ccsi) / 0.75);
    } else {
      regime = "boom";
      margin = Math.min(ccsi - rt.deployment_ccsi, rt.blowoff_ccsi - ccsi) / ((rt.blowoff_ccsi - rt.deployment_ccsi) / 2);
    }
  }
  const regimeConfidence = Math.round(50 + 50 * Math.max(0, Math.min(1, margin)));

  // 5. Bayesian scenario update
  const sigAll: Record<string, number | null> = { ...signals, ccsi, trigger_count: triggerCount, peak_hazard_12m: hazard };
  const fired: { code: string; label: string; group: string; value: number }[] = [];
  const groupLogs = new Map<string, { sum: Record<string, number>; n: number }>();
  for (const r of rules) {
    const v = sigAll[r.signal_key];
    if (v == null) continue;
    const ok = r.operator === ">" ? v > r.threshold : r.operator === "<" ? v < r.threshold
      : r.operator === ">=" ? v >= r.threshold : v <= r.threshold;
    if (!ok) continue;
    fired.push({ code: r.code, label: r.label, group: r.correlation_group, value: r4(v)! });
    const g = groupLogs.get(r.correlation_group) ?? { sum: {}, n: 0 };
    for (const s of scenarios) g.sum[s.code] = (g.sum[s.code] ?? 0) + r.weight * Math.log(Math.max(1e-6, r.likelihoods[s.code] ?? 0.5));
    g.n++;
    groupLogs.set(r.correlation_group, g);
  }
  const logPost: Record<string, number> = {};
  for (const s of scenarios) {
    let lp = Math.log(s.prior);
    for (const g of groupLogs.values()) lp += g.sum[s.code] / g.n; // geometric mean within group
    logPost[s.code] = lp;
  }
  const mx = Math.max(...Object.values(logPost));
  const z = Object.values(logPost).reduce((a, v) => a + Math.exp(v - mx), 0);
  const posteriors: Record<string, number> = {};
  for (const s of scenarios) posteriors[s.code] = r4(Math.exp(logPost[s.code] - mx) / z)!;

  // 6. bucket multipliers
  const bucket: Record<string, number> = {};
  const rm = cfg.regime_multipliers[regime] ?? {};
  for (const b of BUCKETS) {
    let m = 0;
    for (const s of scenarios) m += posteriors[s.code] * (s.bucket_multipliers[b] ?? 1);
    m *= rm[b] ?? 1;
    bucket[b] = r4(Math.max(cfg.multiplier_clamp.min, Math.min(cfg.multiplier_clamp.max, m)))!;
  }

  return {
    reading_date: asOf,
    pillar_intensity: r4(pillars.intensity), pillar_financing: r4(pillars.financing), pillar_returns: r4(pillars.returns),
    pillar_overcapacity: r4(pillars.overcapacity), pillar_market: r4(pillars.market),
    ccsi: r4(ccsi),
    signals: Object.fromEntries(Object.entries(sigAll).map(([k, v]) => [k, r4(v as number)])),
    triggers, trigger_count: triggerCount,
    peak_hazard_12m: r4(hazard), regime_key: regime, regime_confidence: regimeConfidence,
    indicator_z: indicatorZ, coverage, fired_evidence: fired, posteriors,
    bucket_multipliers: bucket, equity_multiplier: bucket.equity, ai_semis_multiplier: bucket.ai_semis,
    shadow_mode: cfg.shadow_mode, computed_at: new Date().toISOString(),
  };
}

async function loadAllObs(sb: SupabaseClient): Promise<Record<string, Obs[]>> {
  const out: Record<string, Obs[]> = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("capex_indicator_observations").select("indicator_code,obs_date,value")
      .order("indicator_code").order("obs_date").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) (out[r.indicator_code] ??= []).push({ date: r.obs_date, value: Number(r.value) });
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadConfig(sb: SupabaseClient): Promise<Config> {
  const { data, error } = await sb.from("capex_model_config").select("key,value");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value])) as unknown as Config;
}

// ───────────────────────────── handler ─────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const errors: Record<string, string> = {};
  const counts: Record<string, number> = {};

  try {
    if (url.searchParams.get("mode") === "probe") {
      const ids = (url.searchParams.get("ids") ?? "Y033RC1Q027SBEA,B985RC1Q027SBEA,GDP,NCBDBIQ027S,A34SIS,DRTSCILM,BAMLH0A0HYM2,DGS10,NASDAQCOM").split(",");
      const fred: Record<string, unknown> = {};
      for (const id of ids) {
        try { const s = await fetchFred(id, "2023-01-01"); fred[id] = { n: s.length, last: s.at(-1) }; }
        catch (e) { fred[id] = { error: String(e) }; }
      }
      let sec: unknown;
      try { const e = await fetchSecConcept(HYPERSCALERS.MSFT, "PaymentsToAcquirePropertyPlantAndEquipment"); sec = { n: e?.length, last: e?.at(-1) }; }
      catch (e) { sec = { error: String(e) }; }
      return json({ fred, sec });
    }

    const [{ data: defsData }, { data: scenData }, { data: ruleData }] = await Promise.all([
      sb.from("capex_indicator_defs").select("*"),
      sb.from("capex_scenarios").select("code,prior,bucket_multipliers").eq("is_active", true).order("sort_order"),
      sb.from("capex_evidence_rules").select("*").eq("is_active", true),
    ]);
    const defs = (defsData ?? []) as Def[];
    const scenarios = (scenData ?? []) as Scenario[];
    const rules = (ruleData ?? []) as Rule[];
    const priorSum = scenarios.reduce((s, x) => s + Number(x.prior), 0);
    for (const s of scenarios) s.prior = Number(s.prior) / priorSum; // renormalize priors
    const cfg = await loadConfig(sb);

    // ── ingest
    if (url.searchParams.get("skip_ingest") !== "1") {
      await ingestFred(sb, defs, errors, counts);
      counts.sec_quarter_rows = await ingestSec(sb, errors);
      const hs = await hyperscalerIndicators(sb);
      for (const [code, series] of Object.entries(hs)) counts[code] = await upsertSeries(sb, code, series, false, errors);
      await syncRecentPrices(sb, errors);
    }
    const prices: PriceBook = {};
    for (const s of MARKET_SYMBOLS) prices[s] = await loadPrices(sb, s);
    if (url.searchParams.get("skip_ingest") !== "1") {
      const ph = priceIndicatorHistory(prices);
      for (const [code, series] of Object.entries(ph)) counts[code] = await upsertSeries(sb, code, series, true, errors);
    }

    // ── compute
    const obsByCode = await loadAllObs(sb);
    const today = new Date().toISOString().slice(0, 10);
    const live = computeAt(today, false, defs, obsByCode, prices, cfg, scenarios, rules);
    const { error: upErr } = await sb.from("capex_cycle_readings").upsert({ ...live, is_backfill: false }, { onConflict: "reading_date" });
    if (upErr) errors.readings_upsert = upErr.message;

    let backfilled = 0;
    if (url.searchParams.get("backfill") === "1") {
      const rows: Record<string, unknown>[] = [];
      let d = cfg.backfill_start;
      while (d < today) {
        rows.push({ ...computeAt(d, true, defs, obsByCode, prices, cfg, scenarios, rules), is_backfill: true });
        const [y, m] = [parseInt(d.slice(0, 4)), parseInt(d.slice(5, 7))];
        d = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10); // next month-end
      }
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await sb.from("capex_cycle_readings").upsert(rows.slice(i, i + 200), { onConflict: "reading_date" });
        if (error) errors.backfill_upsert = error.message;
      }
      backfilled = rows.length;
    }

    return json({
      reading_date: live.reading_date, ccsi: live.ccsi, regime: live.regime_key, regime_confidence: live.regime_confidence,
      peak_hazard_12m: live.peak_hazard_12m, triggers: live.triggers, posteriors: live.posteriors,
      bucket_multipliers: live.bucket_multipliers, pillars: {
        intensity: live.pillar_intensity, financing: live.pillar_financing, returns: live.pillar_returns,
        overcapacity: live.pillar_overcapacity, market: live.pillar_market,
      }, coverage: live.coverage, fired: live.fired_evidence.map((f) => f.code), backfilled, counts, errors,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), errors, counts }, 500);
  }
});
