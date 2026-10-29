// Inflation-level classifier — Bera, Harvey & Hooper, "Stagflation and
// Asset Management" (Man Group / Duke, Oct 2026). Classifies the LEVEL
// of inflation relative to its own trailing 10-year history (not its
// direction), confirmed with a lag, into Overheating / Stagflation /
// Contained. Pure, Deno-API-free — single source of truth (no lib/
// mirror: nothing client-side recomputes this, the macro page just
// reads the latest row `update-inflation-regime` writes to the DB).
//
// Spec: docs/specs/regime-tilt-recalibration.md §3.2.

export interface MonthlyObs {
  date: string; // any parseable date within the month; normalized to the 1st
  value: number;
}

export type InflLevelState = "stagflation" | "overheating" | "contained";
export type AccelState = "accelerating" | "decelerating" | null;
export type AccelVote = "accelerating" | "decelerating" | "mixed";

export interface InflationRegimeRow {
  month: string; // "YYYY-MM-01", the month being classified (m)
  cpiYoy: number | null;
  cpiP75: number | null;
  cpiMargin: number | null; // cpiYoy - cpiP75, spec §3.5 item 1
  ipYoy: number | null;
  ipCagr10: number | null;
  rawState: InflLevelState | null;
  confirmedState: InflLevelState | null;
  candidateState: InflLevelState | null;
  candidateCount: number;
  accel3m: AccelState;
  accel6m: AccelState;
  accel9m: AccelState;
  accelVote: AccelVote | null;
}

function toMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7) + "-01";
}

export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

// Linear-interpolation percentile over whatever values are present —
// gaps (missing months) are simply absent from `values`, never filled,
// per spec 3.1's gap-handling rule.
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function classifyInflationRegime(
  cpiSeries: MonthlyObs[],
  ipSeries: MonthlyObs[],
): InflationRegimeRow[] {
  const cpi = new Map<string, number>();
  for (const r of cpiSeries) cpi.set(toMonthKey(r.date), r.value);
  const ip = new Map<string, number>();
  for (const r of ipSeries) ip.set(toMonthKey(r.date), r.value);

  // D-0 (docs/specs/regime-tilt-recalibration-decisions.md): CPIAUCSL is
  // missing Oct 2025 (government shutdown). One-off interpolation for
  // this classifier's own internal use only — geometric mean of the
  // surrounding two months — never written back to bond_raw_series.
  // Hardcoded to this one known date, not a general gap-filling policy;
  // a no-op once/if the real print ever backfills.
  const GAP_MONTH = "2025-10-01";
  if (!cpi.has(GAP_MONTH)) {
    const before = cpi.get("2025-09-01");
    const after = cpi.get("2025-11-01");
    if (before != null && after != null) {
      cpi.set(GAP_MONTH, Math.sqrt(before * after));
    }
  }

  const yoyAt = (series: Map<string, number>, month: string): number | null => {
    const cur = series.get(month);
    const prior = series.get(addMonths(month, -12));
    if (cur == null || prior == null) return null;
    return cur / prior - 1;
  };

  const ipCagr10At = (month: string): number | null => {
    const cur = ip.get(month);
    const prior = ip.get(addMonths(month, -120));
    if (cur == null || prior == null || cur <= 0 || prior <= 0) return null;
    return Math.pow(cur / prior, 1 / 10) - 1;
  };

  // Trailing 10y of CPI YoY, excluding t itself (spec 3.2).
  const cpiP75At = (month: string): number | null => {
    const values: number[] = [];
    for (let k = 1; k <= 120; k++) {
      const y = yoyAt(cpi, addMonths(month, -k));
      if (y != null) values.push(y);
    }
    return percentile(values, 0.75);
  };

  const accelAt = (month: string, h: number): AccelState => {
    const a = cpi.get(month);
    const b = cpi.get(addMonths(month, -h));
    const c = cpi.get(addMonths(month, -2 * h));
    if (a == null || b == null || c == null) return null;
    const recent = a / b - 1;
    const prior = b / c - 1;
    return recent > prior ? "accelerating" : "decelerating";
  };

  const allMonths = new Set<string>([...cpi.keys(), ...ip.keys()]);
  if (allMonths.size === 0) return [];
  const sorted = [...allMonths].sort();
  const firstM = addMonths(sorted[0], 2); // m's data month t = m-2
  const lastM = addMonths(sorted[sorted.length - 1], 2);

  const rows: InflationRegimeRow[] = [];
  let confirmedState: InflLevelState | null = null;
  let candidateState: InflLevelState | null = null;
  let candidateCount = 0;

  for (let m = firstM; m <= lastM; m = addMonths(m, 1)) {
    const t = addMonths(m, -2);
    const cpiYoy = yoyAt(cpi, t);
    const ipYoy = yoyAt(ip, t);
    const ipCagr10 = ipCagr10At(t);
    const cpiP75 = cpiP75At(t);
    const cpiMargin = cpiYoy != null && cpiP75 != null ? cpiYoy - cpiP75 : null;

    let rawState: InflLevelState | null = null;
    if (cpiYoy != null && cpiP75 != null) {
      if (cpiYoy <= cpiP75) {
        rawState = "contained";
      } else if (ipYoy != null && ipCagr10 != null) {
        rawState = ipYoy < ipCagr10 ? "stagflation" : "overheating";
      }
      // else: high inflation but the growth leg isn't computable this
      // month — leave rawState null (unclassifiable), don't guess.
    }

    if (rawState != null) {
      if (rawState === candidateState) {
        candidateCount += 1;
      } else {
        candidateState = rawState;
        candidateCount = 1;
      }
      if (candidateCount >= 3) confirmedState = candidateState;
    }
    // A month with no rawState (data gap) leaves the candidate streak
    // untouched rather than breaking it — only a genuine conflicting
    // reading resets the streak.

    const accel3m = accelAt(t, 3);
    const accel6m = accelAt(t, 6);
    const accel9m = accelAt(t, 9);
    const votes = [accel3m, accel6m, accel9m];
    const accelerating = votes.filter((v) => v === "accelerating").length;
    const decelerating = votes.filter((v) => v === "decelerating").length;
    const accelVote: AccelVote = accelerating >= 2 ? "accelerating" : decelerating >= 2 ? "decelerating" : "mixed";

    rows.push({
      month: m, cpiYoy, cpiP75, cpiMargin, ipYoy, ipCagr10,
      rawState, confirmedState, candidateState, candidateCount,
      accel3m, accel6m, accel9m, accelVote,
    });
  }

  return rows;
}

// Spec §3.5 item 1 / decision D-9: a reading within a quarter-point of
// its own threshold is "borderline" — Clio and the tile should hedge,
// not call it a firm crossing.
export const BORDERLINE_THRESHOLD = 0.0025; // 0.25 percentage points

export function isBorderline(margin: number | null): boolean {
  return margin != null && Math.abs(margin) < BORDERLINE_THRESHOLD;
}

// Spec §3.5 item 2: when a candidate run hasn't confirmed yet, estimate
// the calendar date of the CPI print that WOULD confirm it (if the
// level holds). `dataMonth` is the current row's data month (t = m-2).
// Only meaningful for candidateCount 1 or 2 — the caller is responsible
// for also checking candidateState !== confirmedState (a long-settled
// streak isn't "pending" even though its count keeps climbing).
// Estimate only (no BLS release-calendar data source in this repo):
// BLS publishes CPI for month D roughly 2 weeks into month D+1, so the
// 2nd Wednesday of the month after the confirming data month is a
// reasonable stand-in — always label it "est." in any display of it.
export function estimateConfirmDate(dataMonth: string, candidateCount: number): string | null {
  if (candidateCount !== 1 && candidateCount !== 2) return null;
  const confirmingDataMonth = addMonths(dataMonth, 3 - candidateCount);
  const releaseMonth = addMonths(confirmingDataMonth, 1);
  const [y, mo] = releaseMonth.split("-").map(Number);
  let wednesdaysSeen = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(y, mo - 1, day));
    if (d.getUTCMonth() !== mo - 1) break; // ran past the end of the month
    if (d.getUTCDay() === 3) {
      wednesdaysSeen += 1;
      if (wednesdaysSeen === 2) return d.toISOString().slice(0, 10);
    }
  }
  return releaseMonth; // defensive fallback; every real month has 2 Wednesdays
}
