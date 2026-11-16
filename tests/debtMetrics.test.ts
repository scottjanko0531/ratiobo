import { describe, it, expect, vi, afterEach } from "vitest";
import { findYearAgo, yoyPair, type Obs } from "../supabase/functions/_shared/yoyMath.ts";
import {
  fetchMtsTable1Trailing12,
  assertPeriodAligned,
} from "../supabase/functions/_shared/mtsFiscalData.ts";

// Builds a quarterly obs series, most-recent-first, skipping the given
// quarters (to simulate a real gap in a FRED series).
function quarterlySeries(
  values: { date: string; value: number }[],
  skip: Set<string> = new Set(),
): Obs[] {
  return values.filter((v) => !skip.has(v.date));
}

describe("nominal r - g (Phase 1a formula, date-matched YoY)", () => {
  it("DGS10 minus nominal GDP YoY, date-matched across a full series", () => {
    const dgs10 = 5.10;
    const gdpObs: Obs[] = [
      { date: "2026-07-01", value: 33010.036 },
      { date: "2026-04-01", value: 32563.030 },
      { date: "2026-01-01", value: 31906.274 },
      { date: "2025-10-01", value: 31462.523 },
      { date: "2025-07-01", value: 31180.493 },
      { date: "2025-04-01", value: 30630.174 },
      { date: "2025-01-01", value: 30171.979 },
    ];
    const yoy = yoyPair(gdpObs);
    expect(yoy).not.toBeNull();
    const rMinusG = dgs10 - yoy!.current;
    expect(rMinusG).toBeCloseTo(-0.7676, 3);
  });

  it("date-matched YoY still finds the correct year-ago row across a gap (not a positional offset)", () => {
    // Missing 2025-04-01 (an actual FRED-style gap) — a positional
    // "4 rows back" match would silently pair 2026-07-01 with 2025-07-01
    // (which happens to still be right here) but would pair 2026-04-01
    // with 2025-01-01 (WRONG — a full year early) if it just counted rows
    // instead of matching by calendar year/month.
    const gdpObsWithGap: Obs[] = [
      { date: "2026-07-01", value: 33010.036 },
      { date: "2026-04-01", value: 32563.030 },
      { date: "2026-01-01", value: 31906.274 },
      { date: "2025-10-01", value: 31462.523 },
      { date: "2025-07-01", value: 31180.493 },
      // 2025-04-01 missing
      { date: "2025-01-01", value: 30171.979 },
    ];
    // obs[1] = 2026-04-01; its true year-ago (2025-04-01) is the gap — must
    // come back undefined, not silently matched to the wrong row.
    const ya = findYearAgo(gdpObsWithGap, "2026-04-01");
    expect(ya).toBeUndefined();
    // With the second-most-recent obs's year-ago missing, yoyPair must
    // refuse to return a (silently wrong) pair rather than guess.
    expect(yoyPair(gdpObsWithGap)).toBeNull();
  });
});

describe("r_eff - g (Phase 1b formula, golden numbers from live validation)", () => {
  it("net interest / avg debt held by public - nominal GDP YoY", () => {
    // Golden inputs, independently reconciled against MTS table 9 and
    // debt_to_penny in docs/specs/debt-metrics-integrity-decisions.md Phase 1.
    const netInterestTrailing12B = 1063.95939111642;
    const avgDebtHeldPublicB = 31511.63146904291;
    const nominalGdpYoy = 5.8676; // Q3 2026 vintage
    const rEff = (netInterestTrailing12B / avgDebtHeldPublicB) * 100;
    expect(rEff).toBeCloseTo(3.376, 2);
    expect(rEff - nominalGdpYoy).toBeCloseTo(-2.491, 2);
  });
});

describe("period-mismatch assertion (Phase 2b)", () => {
  it("passes when both windows share the same start/end", () => {
    expect(() =>
      assertPeriodAligned([
        { label: "net interest", windowStart: "2025-11-30", windowEnd: "2026-10-31" },
        { label: "receipts", windowStart: "2025-11-30", windowEnd: "2026-10-31" },
      ])
    ).not.toThrow();
  });

  it("throws when windows cover different periods — intentionally misaligned dates", () => {
    expect(() =>
      assertPeriodAligned([
        { label: "net interest", windowStart: "2025-11-30", windowEnd: "2026-10-31" },
        { label: "receipts", windowStart: "2025-01-01", windowEnd: "2025-12-31" },
      ])
    ).toThrow(/period mismatch/);
  });
});

describe("MTS Table 1 trailing-12 deficit — current-vs-prior-FY duplicate-group trap", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("sums only the current-fiscal-year group (sequence_number_cd '2.x'), not the prior-year comparison group reported under the same classification_desc", () => {
    const monthEnds = [
      "2025-11-30", "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30",
      "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31",
    ];
    const monthName = (d: string) =>
      new Date(d + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" });

    // Each month gets TWO rows under the real API's actual shape: the
    // current-FY actual (sequence "2.x", receipts = 100B — the value the
    // test expects to be summed) and a prior-FY comparison row under the
    // SAME classification_desc (sequence "1.x", receipts = 999B — a decoy
    // that must be excluded). A regression test for the near-miss bug
    // documented in docs/specs/debt-metrics-integrity-decisions.md Phase 2.
    const rows = monthEnds.flatMap((d) => [
      {
        record_date: d, classification_desc: monthName(d), sequence_number_cd: "2.5",
        current_month_gross_rcpt_amt: "100000000000", current_month_gross_outly_amt: "120000000000", current_month_dfct_sur_amt: "20000000000",
      },
      {
        record_date: d, classification_desc: monthName(d), sequence_number_cd: "1.5",
        current_month_gross_rcpt_amt: "999000000000", current_month_gross_outly_amt: "999000000000", current_month_dfct_sur_amt: "999000000000",
      },
    ]);

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("record_date:eq:2026-10-31")) {
        return new Response(JSON.stringify({ data: [{ record_date: "2026-10-31" }] }), { status: 200 });
      }
      if (url.includes("record_date:in:")) {
        return new Response(JSON.stringify({ data: rows }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    return fetchMtsTable1Trailing12(new Date("2026-11-16T00:00:00Z")).then((result) => {
      expect(result.windowStart).toBe("2025-11-30");
      expect(result.windowEnd).toBe("2026-10-31");
      expect(result.rows.length).toBe(12);
      // 12 months x $100B = $1,200B — NOT 12 x ($100B + $999B) if the
      // duplicate-group bug were present.
      expect(result.receiptsB).toBeCloseTo(1200, 3);
      expect(result.outlaysB).toBeCloseTo(1440, 3);
      expect(result.deficitB).toBeCloseTo(240, 3);
    });
  });
});
