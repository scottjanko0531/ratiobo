import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Bond Lens Phase E annual health check (docs/specs/bond-lens.md).
//
// The LIVE duration-timing rule is `duration_score = valuation_score`
// (bond_signals), mapped to bond_lens_signal.duration_multiplier via
// fixed bands: score < -0.75 -> 0.5x; -0.75..0.5 -> 1.0x; > 0.5 -> 1.3x.
// That rule was adopted on modest backtest evidence, not a proven edge,
// so it gets an annual re-check: does the live-multiplier IEF/cash
// sleeve still beat a constant-1.0x-duration baseline on Sharpe, over
// the trailing 5 years?
//
// IMPORTANT: this function has NO access to this project's git repo /
// docs/ folder -- it cannot write a markdown note. It only computes the
// check and writes one structured row per run into
// bond_lens_phase_e_rerun_log. A human (or a future Claude Code session)
// reads that table later and writes the actual
// docs/specs/bond-lens-phase-e-rerun-YYYY.md note by hand when reviewed.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type DateVal = { date: string; value: number };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addYears(d: Date, years: number): Date {
  const r = new Date(d.getTime());
  r.setUTCFullYear(r.getUTCFullYear() + years);
  return r;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

// Last calendar day of (year, monthIndex0) as a Date.
function monthEndCalendarDate(year: number, monthIndex0: number): Date {
  // day 0 of the *next* month == last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0));
}

async function fetchRange(
  supabase: ReturnType<typeof createClient>,
  table: string,
  dateCol: string,
  valueCol: string,
  extraEq: Record<string, string>,
  fromDate: string,
  toDate: string,
): Promise<DateVal[]> {
  let rows: DateVal[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase
      .from(table)
      .select(`${dateCol}, ${valueCol}`)
      .gte(dateCol, fromDate)
      .lte(dateCol, toDate)
      .order(dateCol, { ascending: true })
      .range(from, from + pageSize - 1);
    for (const [k, v] of Object.entries(extraEq)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read: ${error.message}`);
    if (!data || data.length === 0) break;
    rows = rows.concat(
      data.map((r: Record<string, unknown>) => ({
        date: r[dateCol] as string,
        value: Number(r[valueCol]),
      })),
    );
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// Latest entry in a sorted-ascending series with date <= target, within
// maxLookbackDays calendar days. Linear scan backward from a binary
// search landing point -- series here are at most a few thousand rows,
// looked up at most ~65 times per run, so simplicity wins over a real
// binary search with tie handling.
function latestAtOrBefore(series: DateVal[], targetIso: string, maxLookbackDays: number): number | null {
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= targetIso) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (ans < 0) return null;
  const row = series[ans];
  const gapDays = Math.round(
    (new Date(targetIso + "T00:00:00Z").getTime() - new Date(row.date + "T00:00:00Z").getTime()) / 86400000,
  );
  return gapDays <= maxLookbackDays ? row.value : null;
}

function latestDateAtOrBefore(series: DateVal[], targetIso: string, maxLookbackDays: number): string | null {
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= targetIso) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (ans < 0) return null;
  const row = series[ans];
  const gapDays = Math.round(
    (new Date(targetIso + "T00:00:00Z").getTime() - new Date(row.date + "T00:00:00Z").getTime()) / 86400000,
  );
  return gapDays <= maxLookbackDays ? row.date : null;
}

function duration_multiplier(score: number): number {
  if (score < -0.75) return 0.5;
  if (score > 0.5) return 1.3;
  return 1.0;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, x) => a + (x - m) * (x - m), 0);
  return Math.sqrt(ss / (xs.length - 1));
}

// Geometric-compound monthly returns into an annualized rate.
function annualizeGeometric(monthlyReturns: number[]): number {
  const n = monthlyReturns.length;
  if (n === 0) return 0;
  const compound = monthlyReturns.reduce((acc, r) => acc * (1 + r), 1);
  return Math.pow(compound, 12 / n) - 1;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = new Date().toISOString();

  try {
    const today = new Date();
    const windowEndRequested = isoDate(today);
    const windowStartRequested = isoDate(addYears(today, -5));
    // Pad the fetch window back far enough to cover the bootstrap month
    // (one calendar month before windowStartRequested's month, needed to
    // compute the first month-over-month return and the first prior-
    // month valuation_score) plus slack for weekends/holidays.
    const fetchFrom = isoDate(addDays(new Date(windowStartRequested + "T00:00:00Z"), -60));

    const [iefRows, dgs3moRows, valScoreRows] = await Promise.all([
      fetchRange(supabase, "asset_price_history", "date", "close", { symbol: "IEF" }, fetchFrom, windowEndRequested),
      fetchRange(supabase, "bond_raw_series", "obs_date", "value", { series_id: "DGS3MO" }, fetchFrom, windowEndRequested),
      fetchRange(supabase, "bond_signals", "as_of_date", "valuation_score", {}, fetchFrom, windowEndRequested),
    ]);

    if (iefRows.length === 0) throw new Error("no IEF price history in window -- check asset_price_history ingest");
    if (dgs3moRows.length === 0) throw new Error("no DGS3MO history in window -- check bond-lens-ingest?source=fred");
    if (valScoreRows.length === 0) throw new Error("no bond_signals.valuation_score in window -- run bond-lens-compute first");

    const LOOKBACK_DAYS = 10; // treasury/equity calendar gaps + holiday clusters

    const windowStartDate = new Date(windowStartRequested + "T00:00:00Z");
    const windowEndDate = new Date(windowEndRequested + "T00:00:00Z");
    // Month anchors: one month before windowStart's month, through
    // windowEnd's month, inclusive. monthsAll[0] is the bootstrap month
    // (used only to seed the first return/prior-score); window months
    // proper are monthsAll[1..].
    type MonthRow = { anchorIso: string; monthDate: string | null; iefClose: number | null; dgs3moPct: number | null; valuationScore: number | null };
    const monthsAll: MonthRow[] = [];
    let y = windowStartDate.getUTCFullYear();
    let m0 = windowStartDate.getUTCMonth() - 1; // one month before windowStart's month
    const endY = windowEndDate.getUTCFullYear();
    const endM = windowEndDate.getUTCMonth();
    while (y < endY || (y === endY && m0 <= endM)) {
      const anchor = monthEndCalendarDate(y, m0);
      const anchorIso = isoDate(anchor);
      const monthDate = latestDateAtOrBefore(iefRows, anchorIso, LOOKBACK_DAYS);
      const iefClose = monthDate ? latestAtOrBefore(iefRows, monthDate, 0) : null;
      const dgs3moPct = monthDate ? latestAtOrBefore(dgs3moRows, monthDate, LOOKBACK_DAYS) : null;
      const valuationScore = monthDate ? latestAtOrBefore(valScoreRows, monthDate, LOOKBACK_DAYS) : null;
      monthsAll.push({ anchorIso, monthDate, iefClose, dgs3moPct, valuationScore });
      m0 += 1;
      if (m0 > 11) { m0 = 0; y += 1; }
    }

    // Build the window-month return series: i runs over monthsAll[1..]
    // (the bootstrap month at index 0 only supplies iefClose[i-1] and
    // the prior-month valuation_score for i=1).
    type Row = { monthDate: string; cashRet: number; iefRet: number; liveRet: number; constantRet: number; valuationScore: number; multiplier: number };
    const rows: Row[] = [];
    for (let i = 1; i < monthsAll.length; i++) {
      const cur = monthsAll[i], prev = monthsAll[i - 1];
      if (cur.monthDate == null || cur.iefClose == null || cur.dgs3moPct == null) continue;
      if (prev.iefClose == null) continue;
      if (prev.valuationScore == null) continue;
      const cashRet = cur.dgs3moPct / 100 / 12;
      const iefRet = cur.iefClose / prev.iefClose - 1;
      const multiplier = duration_multiplier(prev.valuationScore);
      const liveRet = cashRet + multiplier * (iefRet - cashRet);
      const constantRet = iefRet;
      rows.push({
        monthDate: cur.monthDate, cashRet, iefRet, liveRet, constantRet,
        valuationScore: cur.valuationScore ?? NaN, multiplier,
      });
    }

    if (rows.length < 2) throw new Error(`insufficient aligned months in window (got ${rows.length})`);

    const n = rows.length;
    const liveRets = rows.map((r) => r.liveRet);
    const constantRets = rows.map((r) => r.constantRet);
    const cashRets = rows.map((r) => r.cashRet);

    const liveAnnReturn = annualizeGeometric(liveRets);
    const constantAnnReturn = annualizeGeometric(constantRets);
    const annCash = annualizeGeometric(cashRets);
    const liveAnnVol = sampleStdev(liveRets) * Math.sqrt(12);
    const constantAnnVol = sampleStdev(constantRets) * Math.sqrt(12);
    const liveSharpe = liveAnnVol > 0 ? (liveAnnReturn - annCash) / liveAnnVol : null;
    const constantSharpe = constantAnnVol > 0 ? (constantAnnReturn - annCash) / constantAnnVol : null;

    // live_ic: Pearson corr of month-t valuation_score against month-
    // (t+1)'s forward 1-month excess return (ief_ret - cash_ret), using
    // whichever months in the window have both. rows[] is indexed by
    // calendar order already; row i's "forward excess return" is
    // rows[i+1]'s (iefRet - cashRet) when it exists (the last window
    // month has no forward month yet -- today isn't month-end).
    const icXs: number[] = [];
    const icYs: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const score = rows[i].valuationScore;
      const fwdExcess = rows[i + 1].iefRet - rows[i + 1].cashRet;
      if (Number.isFinite(score) && Number.isFinite(fwdExcess)) {
        icXs.push(score);
        icYs.push(fwdExcess);
      }
    }
    const liveIc = pearson(icXs, icYs);

    const flagged = liveSharpe != null && constantSharpe != null ? liveSharpe < constantSharpe : false;

    const runDate = isoDate(today);
    const actualWindowStart = rows[0].monthDate;
    const actualWindowEnd = rows[n - 1].monthDate;

    const detail = {
      n_months_used: n,
      n_ic_pairs: icXs.length,
      window_start_requested: windowStartRequested,
      window_end_requested: windowEndRequested,
      window_start_actual: actualWindowStart,
      window_end_actual: actualWindowEnd,
      ann_cash_rate: annCash,
      live_sharpe: liveSharpe,
      constant_sharpe: constantSharpe,
      flagged,
      note: "Rule: duration_score = valuation_score, bands <-0.75=>0.5x, -0.75..0.5=>1.0x, >0.5=>1.3x. flagged=true means live_sharpe < constant_sharpe over trailing 5y -- a human should review and, if confirmed, write docs/specs/bond-lens-phase-e-rerun-YYYY.md by hand (this job cannot write to the repo).",
    };

    const outRow = {
      run_date: runDate,
      window_start: actualWindowStart,
      window_end: actualWindowEnd,
      live_ann_return: liveAnnReturn,
      live_ann_vol: liveAnnVol,
      live_sharpe: liveSharpe,
      constant_ann_return: constantAnnReturn,
      constant_ann_vol: constantAnnVol,
      constant_sharpe: constantSharpe,
      live_ic: liveIc,
      flagged,
      detail,
    };

    const { error: upsertError } = await supabase
      .from("bond_lens_phase_e_rerun_log")
      .upsert(outRow, { onConflict: "run_date" });
    if (upsertError) throw new Error(`bond_lens_phase_e_rerun_log upsert: ${upsertError.message}`);

    await supabase.from("bond_lens_job_runs").insert({
      job_name: "bond-lens-phase-e-rerun", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "ok", detail: outRow,
    });

    return new Response(JSON.stringify(outRow, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    await supabase.from("bond_lens_job_runs").insert({
      job_name: "bond-lens-phase-e-rerun", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "error", detail: { error: String(e) },
    });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
