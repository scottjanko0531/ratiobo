import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  classifyInflationRegime,
  isBorderline,
  estimateConfirmDate,
  BORDERLINE_THRESHOLD,
  type MonthlyObs,
} from "../supabase/functions/_shared/inflationRegime.ts";

function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return ay * 12 + am - (by * 12 + bm);
}

function dateAt(index: number): string {
  const y = 2000 + Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

// vals[i] = vals[i-12] * (1 + target(i)) for i >= 12, vals[0..11] = base —
// this makes the classifier's own computed YoY at index i exactly equal
// to target(i), regardless of history, so expected outcomes can be
// derived by hand rather than re-deriving the classifier's own math.
function buildByYoyTarget(n: number, target: (i: number) => number, base = 100): MonthlyObs[] {
  const vals: number[] = new Array(n);
  for (let i = 0; i < 12; i++) vals[i] = base;
  for (let i = 12; i < n; i++) vals[i] = vals[i - 12] * (1 + target(i));
  return vals.map((value, i) => ({ date: dateAt(i), value }));
}

function series(values: number[]): MonthlyObs[] {
  return values.map((value, i) => ({ date: dateAt(i), value }));
}

describe("classifyInflationRegime", () => {
  it("excludes t from its own 75th-percentile window, and confirms/breaks/re-confirms a 3-month streak", () => {
    const injected = new Set([150, 151, 153, 154, 155]);
    const cpi = buildByYoyTarget(200, (i) => (injected.has(i) ? 0.15 : 0.02));
    const ip = buildByYoyTarget(200, (i) => (injected.has(i) ? -0.10 : 0.02));
    const rows = classifyInflationRegime(cpi, ip);
    // row[p] has data-month t = p, since both series start at index 0.
    const row = (t: number) => rows[t];

    // t itself is excluded from its own percentile window: even though
    // row 150's own CPI YoY is 15%, the window (t-120..t-1) is still
    // baseline-only, so P75 stays near 2%, not pulled toward 15%.
    expect(row(150).cpiYoy).toBeCloseTo(0.15, 6);
    expect(row(150).cpiP75).toBeCloseTo(0.02, 6);
    expect(row(150).cpiMargin).toBeCloseTo(0.13, 6);
    expect(row(150).rawState).toBe("stagflation");

    // Two-month candidate run: not confirmed yet.
    expect(row(150).confirmedState).toBe("contained");
    expect(row(151).rawState).toBe("stagflation");
    expect(row(151).confirmedState).toBe("contained");

    // Streak breaks for one month (back to baseline) — resets the count.
    expect(row(152).rawState).toBe("contained");

    // Fresh 3-in-a-row: confirms on the THIRD month, not before —
    // earlier months in the run are never relabeled retroactively.
    expect(row(153).rawState).toBe("stagflation");
    expect(row(153).confirmedState).toBe("contained");
    expect(row(154).rawState).toBe("stagflation");
    expect(row(154).confirmedState).toBe("contained");
    expect(row(155).rawState).toBe("stagflation");
    expect(row(155).candidateCount).toBe(3);
    expect(row(155).confirmedState).toBe("stagflation");

    // Once confirmed, a single later month back to baseline doesn't
    // retroactively unconfirm it.
    expect(row(156).rawState).toBe("contained");
    expect(row(156).confirmedState).toBe("stagflation");
  });

  it("skips a missing month's own YoY, cascades to the YoY exactly 12 months later, but leaves the percentile window and confirmation streak otherwise unaffected", () => {
    const cpiFull = buildByYoyTarget(150, () => 0.02);
    const ipFull = buildByYoyTarget(150, () => 0.02);
    const cpiWithGap = cpiFull.filter((_, i) => i !== 100); // drop index 100 entirely
    const rows = classifyInflationRegime(cpiWithGap, ipFull);
    const row = (t: number) => rows[t];

    expect(row(99).rawState).toBe("contained");
    expect(row(99).confirmedState).toBe("contained");

    // The missing month itself: no YoY, no raw state — but the ongoing
    // "contained" confirmation is untouched by a data gap.
    expect(row(100).cpiYoy).toBeNull();
    expect(row(100).rawState).toBeNull();
    expect(row(100).confirmedState).toBe("contained");

    // 12 months later, the missing month is the YoY denominator — also null.
    expect(row(112).cpiYoy).toBeNull();
    expect(row(112).rawState).toBeNull();

    // The streak resumes exactly where it left off — the gap month is
    // skipped, not treated as a break.
    expect(row(101).rawState).toBe("contained");
    expect(row(101).candidateCount).toBe(row(99).candidateCount + 1);

    // A later month's P75 window (which spans both gap rows) still
    // computes a sane value from whichever months are actually present.
    expect(row(130).cpiP75).toBeCloseTo(0.02, 6);
  });

  it("votes accelerating when 2 of 3 horizons agree and the third is missing for lack of history", () => {
    const vals = new Array(20).fill(100);
    vals[5] = 100; // t-12
    vals[11] = 110; // t-6
    vals[14] = 100; // t-3
    vals[17] = 130; // t
    const cpi = series(vals);
    const ip = series(new Array(20).fill(100));
    const rows = classifyInflationRegime(cpi, ip);
    const row = rows[17];

    expect(row.accel3m).toBe("accelerating");
    expect(row.accel6m).toBe("accelerating");
    expect(row.accel9m).toBeNull(); // t-18 doesn't exist in a 20-month series
    expect(row.accelVote).toBe("accelerating");
  });

  it("votes mixed when the horizons split 1-1 with the third missing", () => {
    const vals = new Array(20).fill(100);
    vals[5] = 100; // t-12
    vals[11] = 120; // t-6
    vals[14] = 110; // t-3
    vals[17] = 120; // t
    const cpi = series(vals);
    const ip = series(new Array(20).fill(100));
    const rows = classifyInflationRegime(cpi, ip);
    const row = rows[17];

    expect(row.accel3m).toBe("accelerating");
    expect(row.accel6m).toBe("decelerating");
    expect(row.accel9m).toBeNull();
    expect(row.accelVote).toBe("mixed");
  });

  // Replication test, spec §3.4 — real FRED CPIAUCSL/INDPRO history
  // (snapshotted into tests/fixtures/ so this stays deterministic as
  // live data keeps extending). Confirmed runs must land within ±3
  // months of the paper's cited dates. Classifications don't start
  // until the mid-1950s (CPI's own trailing-10y window needs to fill),
  // which is well before every window checked here.
  it("replicates the paper's historical stagflation/overheating windows within ±3 months", () => {
    const fixturePath = new URL("./fixtures/inflation-regime-fred-snapshot.json", import.meta.url);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const rows = classifyInflationRegime(fixture.cpi, fixture.ip);

    const transitions: { month: string; state: string | null }[] = [];
    let prev: string | null | undefined = undefined;
    for (const r of rows) {
      if (r.confirmedState !== prev) {
        transitions.push({ month: r.month, state: r.confirmedState });
        prev = r.confirmedState;
      }
    }

    function expectWindow(expectedStart: string, expectedEnd: string, state: string) {
      const startIdx = transitions.findIndex(
        (t) => t.state === state && Math.abs(monthDiff(t.month, expectedStart)) <= 3,
      );
      expect(startIdx, `no confirmed ${state} found within 3mo of ${expectedStart}`).toBeGreaterThanOrEqual(0);
      const exit = transitions[startIdx + 1];
      expect(exit, `no exit from ${state} starting ${transitions[startIdx].month}`).toBeDefined();
      expect(Math.abs(monthDiff(exit.month, expectedEnd))).toBeLessThanOrEqual(3);
    }

    expectWindow("1969-09-01", "1971-10-01", "stagflation");
    expectWindow("1974-04-01", "1976-05-01", "stagflation");
    expectWindow("1979-10-01", "1981-06-01", "stagflation");

    // "during 2021-22" / "during 2023-24" — any confirmation inside the
    // cited window suffices; the paper doesn't give exact start/end dates.
    expect(transitions.some((t) => t.state === "overheating" && t.month >= "2021-01-01" && t.month <= "2022-12-31")).toBe(true);
    expect(transitions.some((t) => t.state === "stagflation" && t.month >= "2023-01-01" && t.month <= "2024-12-31")).toBe(true);
  });
});

// Spec §3.5 item 1 / decision D-9.
describe("isBorderline", () => {
  it("flags a reading within the threshold and not a clean confirmation either way", () => {
    expect(isBorderline(0.0024)).toBe(true);
    expect(isBorderline(-0.0024)).toBe(true);
    expect(isBorderline(BORDERLINE_THRESHOLD - 0.0001)).toBe(true);
  });
  it("does not flag a reading outside the threshold", () => {
    expect(isBorderline(0.0026)).toBe(false);
    expect(isBorderline(-0.0026)).toBe(false);
    expect(isBorderline(0.13)).toBe(false);
  });
  it("does not flag a null margin", () => {
    expect(isBorderline(null)).toBe(false);
  });
});

// Spec §3.5 item 2.
describe("estimateConfirmDate", () => {
  it("returns the 2nd Wednesday of the month after the confirming print, for candidateCount 2", () => {
    // 1 more month needed -> confirming data month = dataMonth + 1 = 2026-10;
    // BLS publishes Oct CPI in Nov -> 2nd Wednesday of Nov 2026.
    expect(estimateConfirmDate("2026-09-01", 2)).toBe("2026-11-11");
  });
  it("returns the 2nd Wednesday one month later still, for candidateCount 1", () => {
    // 2 more months needed -> confirming data month = dataMonth + 2 = 2026-11;
    // BLS publishes Nov CPI in Dec -> 2nd Wednesday of Dec 2026.
    expect(estimateConfirmDate("2026-09-01", 1)).toBe("2026-12-09");
  });
  it("returns null for a candidateCount that isn't 1 or 2", () => {
    expect(estimateConfirmDate("2026-09-01", 0)).toBeNull();
    expect(estimateConfirmDate("2026-09-01", 3)).toBeNull();
    expect(estimateConfirmDate("2026-09-01", 17)).toBeNull();
  });
});

// Spec §3.5 item 4 / decision D-0.
describe("Oct 2025 CPI interpolation (D-0)", () => {
  it("fills 2025-10 with the geometric mean of Sep/Nov 2025, scoped to that one month", () => {
    const cpi: MonthlyObs[] = [
      { date: "2024-10-01", value: 100 },
      { date: "2025-09-01", value: 108 },
      // 2025-10 deliberately omitted
      { date: "2025-11-01", value: 110 },
    ];
    const ip: MonthlyObs[] = [{ date: "2000-01-01", value: 100 }]; // irrelevant filler
    const rows = classifyInflationRegime(cpi, ip);
    // t = 2025-10 classifies in month 2025-12 (t + 2).
    const row = rows.find((r) => r.month === "2025-12-01");
    expect(row, "no row for the interpolated month").toBeDefined();
    const expectedInterpolated = Math.sqrt(108 * 110);
    expect(row!.cpiYoy).toBeCloseTo(expectedInterpolated / 100 - 1, 6);
  });

  it("does not interpolate a different missing month", () => {
    const cpi: MonthlyObs[] = [
      { date: "2022-05-01", value: 100 },
      // 2023-05 deliberately omitted — NOT the D-0 date
      { date: "2024-05-01", value: 108 },
    ];
    const ip: MonthlyObs[] = [{ date: "2000-01-01", value: 100 }];
    const rows = classifyInflationRegime(cpi, ip);
    const row = rows.find((r) => r.month === "2023-07-01"); // t = 2023-05
    expect(row, "no row for the untouched gap month").toBeDefined();
    expect(row!.cpiYoy).toBeNull();
  });

  it("is a no-op once the real print exists", () => {
    const cpi: MonthlyObs[] = [
      { date: "2024-10-01", value: 100 },
      { date: "2025-09-01", value: 108 },
      { date: "2025-10-01", value: 999 }, // real print, should win over interpolation
      { date: "2025-11-01", value: 110 },
    ];
    const ip: MonthlyObs[] = [{ date: "2000-01-01", value: 100 }];
    const rows = classifyInflationRegime(cpi, ip);
    const row = rows.find((r) => r.month === "2025-12-01");
    expect(row!.cpiYoy).toBeCloseTo(999 / 100 - 1, 6);
  });
});

// Spec §3.1's standing rule, stated explicitly: every lookup matches by
// calendar date, never by array/row position. Proof: remove one month
// (shifting every later array POSITION by one), then check a month
// whose correct date-matched prior differs numerically from whatever a
// row-offset bug would have read instead — if the code were indexing by
// row position, this would silently read the wrong year's value.
describe("date-matched (not row-offset) YoY lookups — spec §3.1", () => {
  it("still uses the calendar-correct prior-year value after a month is removed from the array", () => {
    const n = 40;
    const target = (i: number) => (i === 13 ? 0.30 : i === 25 ? 0.07 : 0.05);
    const vals: number[] = new Array(n);
    for (let i = 0; i < 12; i++) vals[i] = 100;
    for (let i = 12; i < n; i++) vals[i] = vals[i - 12] * (1 + target(i));
    const full = vals.map((value, i) => ({ date: dateAt(i), value }));
    const withGap = full.filter((_, i) => i !== 20); // remove an unrelated month
    const ip = full.map((r) => ({ ...r })); // untouched, keeps the overall month range unchanged

    const rows = classifyInflationRegime(withGap, ip);
    // row[p] has data-month t = p (see the big fixture test above for why).
    // A row-offset bug would, after the removal, read original index 12
    // as "t-12" instead of the calendar-correct index 13 — asserting
    // against target(25) (not the row-offset-wrong value) pins the fix.
    expect(rows[25].cpiYoy).toBeCloseTo(target(25), 6);
  });
});
