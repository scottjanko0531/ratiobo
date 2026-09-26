import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Independent replication of a third-party Substack strategy ("Net Liquidity
// NASDAQ Alpha," Ashna Dhuper, 2026-09-22): Net Liquidity = WALCL − TGA(8wk
// smoothed) − RRP, monthly z-scored (walk-forward, no lookahead) into a
// 0x/1x/2x position on NASDAQ-100, capped at 1x unless Net Liquidity is
// above its own 6-month MA, with a 7% intra-month stop-loss and cash-rate
// credit when flat. The published piece showed prose + chart images
// describing its own results — no raw numbers, no disclosed z-score window,
// no disclosed leverage financing cost. This is a from-scratch rebuild off
// the stated rules only, to get real numbers instead of a stranger's chart.
//
// Where the article was ambiguous, the choice made is logged in
// `methodologyNotes` in the response — treat every one of those as an
// assumption, not a fact about what the author actually did.
//
// Standalone diagnostic, same curl-invoked pattern as this repo's other
// *-backtest edge functions. Not wired into production.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Obs = { date: string; value: number };
type PriceRow = { date: string; close: number };

async function fetchFredCsv(seriesId: string, cosd: string): Promise<Obs[]> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}`);
  if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n").slice(1);
  const out: Obs[] = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    if (!date || raw === "." || raw === undefined || raw === "") continue;
    const value = parseFloat(raw);
    if (!isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

async function fetchPrices(supabase: ReturnType<typeof createClient>, symbol: string): Promise<PriceRow[]> {
  let rows: PriceRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("asset_price_history")
      .select("date, close")
      .eq("symbol", symbol)
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows = rows.concat(data.map((r: Record<string, unknown>) => ({ date: r.date as string, close: Number(r.close) })));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function mean(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdevPop(arr: number[]): number {
  // Population stdev (not sample) — matches "z-score using only past data up
  // to that point," an expanding-window calculation where a sample-vs-pop
  // correction is a rounding error next to the ambiguity in window choice.
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
}

// Last observation on or before a given date, from a date-sorted-ascending series.
function lastOnOrBefore(obs: Obs[], date: string): number | null {
  let result: number | null = null;
  for (const o of obs) {
    if (o.date <= date) result = o.value;
    else break;
  }
  return result;
}

function monthKey(date: string): string { return date.slice(0, 7); }
function addMonth(monthStr: string): string {
  const [y, m] = monthStr.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
function monthEndDate(monthStr: string): string {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function computeStats(rets: number[]) {
  const n = rets.length;
  if (n === 0) return { cagrPct: null, volPct: null, maxDrawdownPct: null, sharpe: null, calmar: null, finalMultiple: null, tradingDays: 0 };
  let value = 1, peak = 1, maxDD = 0;
  for (const r of rets) {
    value *= (1 + r);
    peak = Math.max(peak, value);
    maxDD = Math.min(maxDD, value / peak - 1);
  }
  const years = n / 252;
  const cagr = Math.pow(value, 1 / years) - 1;
  const dailyMean = mean(rets);
  const dailyVar = mean(rets.map((r) => (r - dailyMean) ** 2));
  const vol = Math.sqrt(dailyVar) * Math.sqrt(252);
  const sharpe = vol !== 0 ? cagr / vol : NaN;
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : NaN;
  return {
    cagrPct: Math.round(cagr * 10000) / 100,
    volPct: Math.round(vol * 10000) / 100,
    maxDrawdownPct: Math.round(maxDD * 10000) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    calmar: Math.round(calmar * 100) / 100,
    finalMultiple: Math.round(value * 10000) / 10000,
    tradingDays: n,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const FETCH_FROM = "2002-12-01";

    const [walclObs, tgaObs, rrpObs, rateObs, qqqRows] = await Promise.all([
      fetchFredCsv("WALCL", FETCH_FROM),
      fetchFredCsv("WTREGEN", FETCH_FROM),
      fetchFredCsv("WLRRAL", FETCH_FROM),
      fetchFredCsv("DGS3MO", FETCH_FROM),
      fetchPrices(supabase, "QQQ"),
    ]);

    // ── 1. Weekly Net Liquidity ────────────────────────────────────────
    // WALCL/WTREGEN/WLRRAL are the same H.4.1 weekly (Wednesday) release —
    // exact-date intersection, no forward-fill needed (confirmed by hand:
    // all three start 2002-12-18 on identical dates).
    const tgaByDate = new Map(tgaObs.map((o) => [o.date, o.value]));
    const rrpByDate = new Map(rrpObs.map((o) => [o.date, o.value]));
    const weekly: { date: string; walcl: number; tgaRaw: number; rrp: number }[] = [];
    for (const w of walclObs) {
      const t = tgaByDate.get(w.date);
      const r = rrpByDate.get(w.date);
      if (t == null || r == null) continue;
      weekly.push({ date: w.date, walcl: w.value, tgaRaw: t, rrp: r });
    }

    // 8-week rolling average of raw TGA (smooths debt-ceiling cash-management
    // noise, per the article's rule 1).
    const TGA_SMOOTH_WEEKS = 8;
    const netLiqWeekly: { date: string; value: number }[] = [];
    for (let i = 0; i < weekly.length; i++) {
      if (i < TGA_SMOOTH_WEEKS - 1) continue;
      const tgaSmoothed = mean(weekly.slice(i - TGA_SMOOTH_WEEKS + 1, i + 1).map((w) => w.tgaRaw));
      netLiqWeekly.push({ date: weekly[i].date, value: weekly[i].walcl - tgaSmoothed - weekly[i].rrp });
    }

    // ── 2. Monthly clean level, monthly change, walk-forward z-score ──
    const firstMonth = monthKey(netLiqWeekly[0].date);
    const lastDataDate = qqqRows[qqqRows.length - 1].date;
    const lastMonth = monthKey(lastDataDate);
    const months: string[] = [];
    for (let m = firstMonth; m <= lastMonth; m = addMonth(m)) months.push(m);

    const levelByMonth = new Map<string, number | null>();
    for (const m of months) levelByMonth.set(m, lastOnOrBefore(netLiqWeekly, monthEndDate(m)));

    const changeByMonth = new Map<string, number | null>();
    for (let i = 1; i < months.length; i++) {
      const cur = levelByMonth.get(months[i]);
      const prev = levelByMonth.get(months[i - 1]);
      changeByMonth.set(months[i], cur != null && prev != null ? cur - prev : null);
    }

    // Expanding-window z-score (article says only "using only past data up
    // to that point" — doesn't specify expanding vs. rolling window; this
    // backtest uses expanding-from-inception, the more conservative/stable
    // choice and the one requiring no extra unstated parameter). A 12-month
    // warmup of change history is required before a z-score is trusted —
    // months before that are forced flat (0x), logged as `isWarmup`.
    const Z_WARMUP_MONTHS = 12;
    const SIX_MO_MA_MONTHS = 6;

    type MonthSignal = {
      month: string; level: number | null; change: number | null; z: number | null;
      sixMoMA: number | null; trendOk: boolean | null; baseMult: number; finalMult: number;
      trendCapped: boolean; isWarmup: boolean;
    };
    const signals: MonthSignal[] = [];
    const changeHistory: number[] = [];
    for (const m of months) {
      const level = levelByMonth.get(m) ?? null;
      const change = changeByMonth.get(m) ?? null;

      let z: number | null = null;
      const isWarmup = changeHistory.length < Z_WARMUP_MONTHS || change == null;
      if (!isWarmup && change != null) {
        const std = stdevPop(changeHistory);
        z = std > 0 ? (change - mean(changeHistory)) / std : 0;
      }
      if (change != null) changeHistory.push(change);

      // 6-month MA of the LEVEL (not the change), per rule 5's trend filter.
      const idx = months.indexOf(m);
      let sixMoMA: number | null = null;
      if (idx >= SIX_MO_MA_MONTHS - 1) {
        const window: number[] = [];
        for (let k = idx - SIX_MO_MA_MONTHS + 1; k <= idx; k++) {
          const lv = levelByMonth.get(months[k]);
          if (lv == null) { window.length = 0; break; }
          window.push(lv);
        }
        sixMoMA = window.length === SIX_MO_MA_MONTHS ? mean(window) : null;
      }
      const trendOk = level != null && sixMoMA != null ? level > sixMoMA : null;

      let baseMult = 0;
      if (z != null) baseMult = z < -0.25 ? 0 : z <= 0.5 ? 1 : 2;
      let finalMult = baseMult;
      let trendCapped = false;
      if (baseMult === 2 && trendOk === false) { finalMult = 1; trendCapped = true; }

      signals.push({ month: m, level, change, z, sixMoMA, trendOk, baseMult, finalMult, trendCapped, isWarmup });
    }
    const signalByMonth = new Map(signals.map((s) => [s.month, s]));

    // ── 3. Daily simulation ────────────────────────────────────────────
    // One-month lag, always: the position applied during calendar month m
    // was decided from the signal computed as of month (m-1)'s close.
    const qqqCloses = qqqRows.map((r) => r.close);
    const dailyRet: number[] = [NaN];
    for (let i = 1; i < qqqRows.length; i++) dailyRet.push(qqqCloses[i] / qqqCloses[i - 1] - 1);

    // First month we can actually trade: the month AFTER the first
    // non-warmup signal month.
    const firstLiveSignalMonth = signals.find((s) => !s.isWarmup)?.month;
    if (!firstLiveSignalMonth) throw new Error("no live signal month found — insufficient history");
    const firstTradeMonth = addMonth(firstLiveSignalMonth);

    type DayResult = { date: string; month: string; mult: number; dayRet: number; stopLossDay: boolean };
    const days: DayResult[] = [];
    let curMonth = "";
    let monthMult = 0;
    let stoppedOut = false;
    let intraMonthValue = 1;

    for (let i = 1; i < qqqRows.length; i++) {
      const date = qqqRows[i].date;
      const m = monthKey(date);
      if (m < firstTradeMonth) continue;

      if (m !== curMonth) {
        curMonth = m;
        stoppedOut = false;
        intraMonthValue = 1;
        const decisionMonth = signalByMonth.has(monthsBack(m)) ? monthsBack(m) : null;
        const sig = decisionMonth ? signalByMonth.get(decisionMonth) : undefined;
        monthMult = sig ? sig.finalMult : 0;
      }

      const r = dailyRet[i];
      const investedToday = !stoppedOut && monthMult !== 0;
      const stopLossDayBefore = stoppedOut && monthMult !== 0; // already stopped out this month, but signal wasn't 0x
      let dayRet: number;
      if (!investedToday) {
        const rate = lastOnOrBefore(rateObs, date);
        dayRet = (rate ?? 0) / 100 / 252;
      } else {
        dayRet = monthMult * r;
        intraMonthValue *= (1 + dayRet);
        if (intraMonthValue <= 0.93) stoppedOut = true; // 7% stop-loss, effective next trading day
      }
      days.push({ date, month: m, mult: investedToday ? monthMult : 0, dayRet, stopLossDay: stopLossDayBefore });
    }

    function monthsBack(m: string): string {
      const [y, mo] = m.split("-").map(Number);
      return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
    }

    function statsForWindow(fromDate: string, toDate: string) {
      const strat = days.filter((d) => d.date >= fromDate && d.date <= toDate).map((d) => d.dayRet);
      const bh: number[] = [];
      for (let i = 1; i < qqqRows.length; i++) {
        if (qqqRows[i].date >= fromDate && qqqRows[i].date <= toDate) bh.push(dailyRet[i]);
      }
      return { strategy: computeStats(strat), buyHoldQQQ: computeStats(bh) };
    }

    const overallFrom = days[0]?.date ?? null;
    const overallTo = days[days.length - 1]?.date ?? null;

    const backtest1 = statsForWindow("2015-01-01", overallTo ?? "9999-99-99"); // matches article's "2015 to 2026"
    const backtest2 = statsForWindow(overallFrom ?? "0000-01-01", "2014-12-31"); // matches article's "2004 to 2014, never seen"
    const crisisWindow = statsForWindow("2008-01-01", "2009-06-30");

    // Position trace through the 2008 crisis, to directly check the
    // article's specific claim: "sat flat through Sept/Oct 2008 Lehman
    // collapse... went long again in December 2008."
    const crisisTrace = signals
      .filter((s) => s.month >= "2007-10" && s.month <= "2009-02")
      .map((s) => ({
        signalMonth: s.month, appliedToMonth: addMonth(s.month),
        z: s.z != null ? Math.round(s.z * 100) / 100 : null,
        finalMult: s.finalMult, trendCapped: s.trendCapped, isWarmup: s.isWarmup,
      }));

    // Multiplier distribution — sanity check on the article's "leverage
    // isn't doing all the work" claim: what fraction of days were 0x/1x/2x
    // in each window.
    function multDist(fromDate: string, toDate: string) {
      const subset = days.filter((d) => d.date >= fromDate && d.date <= toDate);
      const n = subset.length || 1;
      const at = (mult: number) => Math.round((subset.filter((d) => d.mult === mult).length / n) * 1000) / 10;
      return { pct0x: at(0), pct1x: at(1), pct2x: at(2), stopLossCashDays: subset.filter((d) => d.stopLossDay).length, totalDays: subset.length };
    }

    // Data-quality check substantiating a specific methodological caveat:
    // RRP (WLRRAL) was a trivial fraction of the Fed balance sheet before
    // the 2013 ON RRP facility existed in size — so the "2004-2014
    // out-of-sample decade" barely exercises the RRP term of the formula.
    const pre2013 = weekly.filter((w) => w.date < "2013-01-01");
    const post2021 = weekly.filter((w) => w.date >= "2021-01-01");
    const rrpWalclRatio = (rows: typeof weekly) => Math.round((mean(rows.map((r) => r.rrp)) / mean(rows.map((r) => r.walcl))) * 10000) / 100;

    return new Response(JSON.stringify({
      methodologyNotes: {
        zScoreWindow: "Expanding (inception-to-date), not specified by the source article — the conservative default given no disclosed window length.",
        zScoreWarmup: `First ${Z_WARMUP_MONTHS} months of monthly changes forced to 0x (flat) before any z-score is trusted; see firstLiveSignalMonth.`,
        monthEndConvention: "Monthly 'clean Net Liquidity' = last weekly (Wednesday H.4.1) observation on or before each month's calendar end.",
        leverageFinancingCost: "NOT modeled — 2x days simply apply 2x the daily QQQ return. The article never discloses a financing-cost assumption for its leverage; this omission is generous to the strategy, flagged here rather than silently assumed away.",
        benchmarkInstrument: "QQQ (dividend-adjusted close via Yahoo Finance), not the raw NASDAQ-100 index the article likely used — QQQ is the investable, total-return version, which should if anything make BOTH the strategy and its buy-and-hold benchmark slightly higher than an index-only replication.",
        stopLoss: "Checked once daily: once intra-month cumulative value (from the month's first trading day) closes <= 0.93, exits to cash for the remainder of that calendar month; re-evaluated fresh next month regardless.",
        cashRate: "FRED DGS3MO (3-month T-bill), most recent value on or before the date, applied as rate/100/252 — used whenever a day is flat (0x) or in stop-loss cash.",
      },
      dataRange: { fredFetchFrom: FETCH_FROM, netLiquidityWeeklyFrom: netLiqWeekly[0]?.date, qqqFrom: qqqRows[0]?.date, qqqTo: qqqRows[qqqRows.length - 1]?.date },
      firstLiveSignalMonth, firstTradeMonth,
      tradableWindow: { from: overallFrom, to: overallTo },
      results: {
        fullSample: statsForWindow(overallFrom ?? "0000-01-01", overallTo ?? "9999-99-99"),
        backtest1_2015_to_present: backtest1,
        backtest2_2004_to_2014: backtest2,
        crisisWindow_2008_01_to_2009_06: crisisWindow,
      },
      multiplierDistribution: {
        backtest1_2015_to_present: multDist("2015-01-01", overallTo ?? "9999-99-99"),
        backtest2_2004_to_2014: multDist(overallFrom ?? "0000-01-01", "2014-12-31"),
      },
      crisisTrace2008: crisisTrace,
      dailyTraceLehmanWindow: days.filter((d) => d.date >= "2008-09-01" && d.date <= "2008-12-31"),
      dataQualityCheck: {
        note: "RRP as a share of WALCL, pre-2013 (ON RRP facility didn't exist in size) vs. post-2021 (facility near its peak). If pre-2013 RRP is trivial, the 2004-2014 'out-of-sample' backtest barely tests the RRP term of the formula.",
        rrpOverWalclPct_pre2013: rrpWalclRatio(pre2013),
        rrpOverWalclPct_post2021: rrpWalclRatio(post2021),
      },
    }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: e instanceof Error ? e.stack : undefined }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
