import { describe, it, expect } from "vitest";
import { parseGscpiSheetRows } from "../supabase/functions/_shared/gscpiParser.ts";

describe("parseGscpiSheetRows", () => {
  // The real NY Fed file's primary shape: "DD-Mon-YYYY" text cells, NOT
  // Excel date serials -- confirmed live, cellDates: true has no effect
  // on this column. This is the case that actually matters in production.
  it("parses real-shape 'DD-Mon-YYYY' text dates, sorted ascending", () => {
    const rows = [
      ["Date", "GSCPI"],
      ["30-Sep-2026", 1.1],
      ["31-Aug-2026", 0.9],
      ["31-Oct-2026", 1.2619111813086497],
    ];
    expect(parseGscpiSheetRows(rows)).toEqual([
      { date: "2026-08-31", value: 0.9 },
      { date: "2026-09-30", value: 1.1 },
      { date: "2026-10-31", value: 1.2619111813086497 },
    ]);
  });

  it("is case-insensitive on header labels", () => {
    const rows = [
      ["date", "gscpi"],
      ["31-Oct-2026", 1.262],
    ];
    expect(parseGscpiSheetRows(rows)).toEqual([{ date: "2026-10-31", value: 1.262 }]);
  });

  it("handles a real Date instance (defensive fallback, not the live file's shape)", () => {
    const rows = [
      ["Date", "GSCPI"],
      [new Date("2026-10-31T00:00:00Z"), 1.262],
    ];
    expect(parseGscpiSheetRows(rows)).toEqual([{ date: "2026-10-31", value: 1.262 }]);
  });

  it("falls back to generic ISO string parsing for a non-'DD-Mon-YYYY' string", () => {
    const rows = [
      ["Date", "GSCPI"],
      ["2026-10-31", 1.262],
    ];
    expect(parseGscpiSheetRows(rows)).toEqual([{ date: "2026-10-31", value: 1.262 }]);
  });

  it("skips rows with a null value, non-finite value, or unparseable date", () => {
    const rows = [
      ["Date", "GSCPI"],
      ["31-Oct-2026", 1.262],
      ["30-Sep-2026", null],
      ["not a date", 0.5],
      [null, null],
    ];
    expect(parseGscpiSheetRows(rows)).toEqual([{ date: "2026-10-31", value: 1.262 }]);
  });

  it("returns an empty array when Date/GSCPI headers aren't found", () => {
    const rows = [["Month", "Value"], ["31-Oct-2026", 1.262]];
    expect(parseGscpiSheetRows(rows)).toEqual([]);
  });

  it("returns an empty array for an empty sheet", () => {
    expect(parseGscpiSheetRows([])).toEqual([]);
  });
});
