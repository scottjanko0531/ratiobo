// Growth & Inflation Indicator Gaps spec, Phase 2b. Pure transform from
// a raw xlsx sheet-to-json array (header:1 shape, i.e. unknown[][]) into
// typed, sorted {date, value} points. Deliberately does NOT import
// "npm:xlsx" itself -- that's a Deno-specifier module that can't resolve
// under Vitest/Node, so the ingest-gscpi edge function does the actual
// XLSX.read()/sheet_to_json() call (with cellDates: true) and passes the
// already-decoded rows in here. This is the one part of that pipeline
// worth testing without a real xlsx fixture.

export interface GscpiPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

const MONTH_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// The NY Fed's own GSCPI file stores dates as plain text in "DD-Mon-YYYY"
// form (e.g. "31-Oct-2026"), NOT as Excel date serials -- confirmed live:
// XLSX.read's cellDates: true has no effect on this column since there's
// no underlying date type to convert. Parsed explicitly with a month-name
// lookup rather than new Date(string), whose implementation-defined
// string parsing + local-timezone midnight interpretation can roll the
// date back a day when run somewhere east of UTC. A real Date instance
// (from some other xlsx shape) is still handled as a UTC-anchored
// fallback for robustness, though it's dead code for this specific file.
function normalizeDate(raw: unknown): string | null {
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m) {
      const month = MONTH_ABBR[m[2].toLowerCase()];
      if (!month) return null;
      return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
    }
    // Fallback for any other string shape -- not expected for this file,
    // but better than silently dropping the row.
    const d = new Date(raw + "T00:00:00Z");
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  return null;
}

// `rows[0]` is the header row ("Date", "GSCPI"); every row after that is
// a data row. Case-insensitive header match since the NY Fed file's exact
// capitalization isn't a contract worth hardcoding on.
export function parseGscpiSheetRows(rows: unknown[][]): GscpiPoint[] {
  if (!rows.length) return [];
  const header = rows[0];
  const dateCol = header.findIndex((c) => typeof c === "string" && c.trim().toLowerCase() === "date");
  const valueCol = header.findIndex((c) => typeof c === "string" && c.trim().toLowerCase() === "gscpi");
  if (dateCol === -1 || valueCol === -1) return [];

  const out: GscpiPoint[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const date = normalizeDate(row[dateCol]);
    const rawValue = row[valueCol];
    if (rawValue == null) continue; // Number(null) === 0 -- don't let a blank cell become a false zero
    const value = Number(rawValue);
    if (!date || !Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
