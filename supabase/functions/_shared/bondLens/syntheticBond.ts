// Bond Lens overlay — synthetic 10y total-return construction, used
// wherever a real instrument doesn't cover the needed history: IEF
// (inception 2002-07-30, §4.5 trend) and the pre-1993 hedge fallback
// (§4.4, 2026-10-02 follow-up). Pure, Deno-API-free.
//
// Daily total return of a constant-maturity 10y par bond, duration-based:
// r_t ~= -Dmod(y_{t-1}) * (y_t - y_{t-1}) + y_{t-1}/252 (price return from
// the yield change, plus one trading day's worth of running yield as
// carry). Validated against real IEF: corr(synthetic, real IEF daily
// returns) = 0.962 over the full 2002-2026 overlap (sd 0.00488 vs 0.00428,
// mean 0.000111 vs 0.000141) -- computed directly in Postgres against
// live bond_raw_series/asset_price_history before this was wired in, not
// assumed.

import { modifiedDuration } from "./carry.ts";

// Cumulative total-return INDEX (base 100 at the first available point),
// walked along `dates` (expected to be DGS10's own trading calendar, same
// backbone every other module uses). Null wherever either yield in the
// pair is unavailable; the index simply holds flat across such a gap
// (DGS10 itself essentially never has a gap on its own calendar).
export function syntheticBondTotalReturnIndex(dgs10Pct: (number | null)[]): (number | null)[] {
  const n = dgs10Pct.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let base: number | null = null;
  let level = 100;
  for (let t = 0; t < n; t++) {
    const y1 = dgs10Pct[t];
    if (y1 == null) { out[t] = base == null ? null : level; continue; }
    if (base == null) { base = y1; out[t] = level; continue; }
    const y0 = dgs10Pct[t - 1];
    if (y0 == null) { out[t] = level; continue; }
    const y0d = y0 / 100, y1d = y1 / 100;
    const dmod = modifiedDuration(y0d, 10);
    const dailyReturn = -dmod * (y1d - y0d) + y0d / 252;
    level = level * (1 + dailyReturn);
    out[t] = level;
  }
  return out;
}

// Splices a real price series onto the synthetic index: synthetic wherever
// real is unavailable, rescaled by a constant factor so the join is
// continuous (no jump at the real series' own inception date), real
// thereafter. Used by trend.ts to extend IEF back to ~1963 (§4.5,
// 2026-10-02 follow-up #5).
export function spliceSyntheticBeforeReal(
  real: (number | null)[], synthetic: (number | null)[],
): (number | null)[] {
  const n = real.length;
  const firstRealIdx = real.findIndex((v) => v != null);
  if (firstRealIdx <= 0) return real; // real covers everything (or nothing to splice)
  const realAtJoin = real[firstRealIdx] as number;
  const synthAtJoin = synthetic[firstRealIdx];
  if (synthAtJoin == null || synthAtJoin === 0) return real;
  const scale = realAtJoin / synthAtJoin;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let t = 0; t < firstRealIdx; t++) {
    const s = synthetic[t];
    out[t] = s == null ? null : s * scale;
  }
  for (let t = firstRealIdx; t < n; t++) out[t] = real[t];
  return out;
}

// Month-end trading-day indices (last index of each calendar month) --
// used to resample a daily index down to monthly returns for the §4.4
// pre-1993 fallback, which only has monthly-resolution equity data
// (Shiller) to correlate against.
export function monthEndIndices(dates: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    const isLastOfMonth = i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);
    if (isLastOfMonth) out.push(i);
  }
  return out;
}

// Monthly returns (month-end to month-end) from a daily index, keyed by
// each month-end's own date string.
export function monthlyReturnsFromDailyIndex(dates: string[], index: (number | null)[]): { date: string; value: number }[] {
  const ends = monthEndIndices(dates);
  const out: { date: string; value: number }[] = [];
  for (let i = 1; i < ends.length; i++) {
    const t0 = ends[i - 1], t1 = ends[i];
    const v0 = index[t0], v1 = index[t1];
    if (v0 != null && v1 != null && v0 !== 0) out.push({ date: dates[t1], value: v1 / v0 - 1 });
  }
  return out;
}

// Rolling Pearson correlation of two monthly return series keyed by
// matching month-end date strings, over a trailing `windowMonths` window
// ending at (and including) each point in `xs`. Null (not zero) before
// `windowMonths` of OVERLAPPING history exists -- same "excluded, never a
// silent zero" convention as every other module.
export function rollingMonthlyCorrelation(
  xs: { date: string; value: number }[], ys: { date: string; value: number }[], windowMonths: number,
): { date: string; corr: number | null }[] {
  const yByDate = new Map(ys.map((r) => [r.date, r.value]));
  const paired: { date: string; x: number; y: number }[] = [];
  for (const row of xs) {
    const y = yByDate.get(row.date);
    if (y != null) paired.push({ date: row.date, x: row.value, y });
  }
  const out: { date: string; corr: number | null }[] = [];
  for (let i = 0; i < paired.length; i++) {
    if (i + 1 < windowMonths) { out.push({ date: paired[i].date, corr: null }); continue; }
    const window = paired.slice(i - windowMonths + 1, i + 1);
    const mx = window.reduce((a, r) => a + r.x, 0) / window.length;
    const my = window.reduce((a, r) => a + r.y, 0) / window.length;
    let num = 0, dx2 = 0, dy2 = 0;
    for (const r of window) {
      const dx = r.x - mx, dy = r.y - my;
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    out.push({ date: paired[i].date, corr: denom === 0 ? 0 : num / denom });
  }
  return out;
}

// Looks up the latest monthly correlation reading as of (on or before)
// `targetDate` -- the pre-1993 fallback is monthly-resolution, so a weekly
// hedge read before 1993 should see "whatever the most recently completed
// month found," not a new value every week. Binary search; `series` must
// be sorted ascending by date (rollingMonthlyCorrelation's own output
// order, which follows `xs`'s order -- callers must pass pre-sorted xs).
export function monthlyCorrAsOf(series: { date: string; corr: number | null }[], targetDate: string): number | null {
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= targetDate) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans >= 0 ? series[ans].corr : null;
}
