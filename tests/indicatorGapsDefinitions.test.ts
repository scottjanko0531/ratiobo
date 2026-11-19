import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// growth-inflation-indicator-gaps spec, Phase 1: "a definition-sanity test
// asserting every new indicator has a unit, status function, source line,
// and description." fetch-macro-data/index.ts can't be imported under
// Vitest (its module-scope Deno.env.get(...)! calls throw outside the Deno
// runtime, the same reason every other _shared/ split in this codebase
// exists) -- so this reads the file as TEXT and checks each of the 18 new
// indicator object literals for the required fields, rather than importing
// a live INDICATORS array. A source-text check, not a runtime one, but it
// still catches a future edit that silently drops a required field.

const SOURCE = readFileSync(
  new URL("../supabase/functions/fetch-macro-data/index.ts", import.meta.url),
  "utf8",
);

const NEW_INDICATOR_NAMES = [
  "Labor Force Participation Rate",
  "Labor Force Growth (YoY)",
  "Nonfarm Labor Productivity (YoY)",
  "Real Nonresidential Fixed Investment (YoY)",
  "Core Capex Orders (3M Annualized)",
  "Real Retail Sales (YoY)",
  "Import Price Index (YoY)",
  "5-Year, 5-Year Forward Inflation Expectation",
  "Unemployment Gap (UNRATE − NAIRU)",
  "Job Openings per Unemployed Worker",
  "Case-Shiller National Home Price Index (YoY)",
  "Real PCE (YoY)",
  "Atlanta Fed Wage Growth Tracker",
  "Core PCE (YoY)",
  "Supercore CPI (3M Annualized)",
  "Shelter CPI (YoY)",
  "Sticky-Price Core CPI (YoY)",
  "Employment Cost Index (YoY)",
];

// Slices the object literal for one indicator out of the source: from its
// `name: "<name>"` line to the next `},` at the same (two-space-deeper)
// indent level, which is how every entry in the INDICATORS array literal
// closes.
function sliceIndicatorBlock(name: string): string {
  const nameIdx = SOURCE.indexOf(`name: "${name}"`);
  if (nameIdx === -1) throw new Error(`indicator "${name}" not found in fetch-macro-data/index.ts at all`);
  const closeIdx = SOURCE.indexOf("\n  },", nameIdx);
  if (closeIdx === -1) throw new Error(`could not find the closing "},” for indicator "${name}"`);
  return SOURCE.slice(nameIdx, closeIdx);
}

describe("growth-inflation-indicator-gaps Phase 1 — indicator definition sanity", () => {
  it("has exactly 18 new indicators", () => {
    expect(NEW_INDICATOR_NAMES.length).toBe(18);
  });

  for (const name of NEW_INDICATOR_NAMES) {
    it(`"${name}" has a unit, status function, FRED source, and description`, () => {
      const block = sliceIndicatorBlock(name);
      expect(block).toMatch(/unit:\s*"[^"]+"/);
      expect(block).toMatch(/statusFn:\s*\(?.*=>/);
      expect(block).toMatch(/fred_series_id:\s*"[^"]+"/);
      expect(block).toMatch(/data_source:\s*"fred"/);
      expect(block).toMatch(/description:\s*"[^"]+"/);
      expect(block).toMatch(/series:\s*"[^"]+"/); // every one of these pulls from a real FRED series
    });
  }

  it("every new indicator sits in layer 3 (Business Cycle) or layer 5 (Growth — Supply Side), never an unassigned layer", () => {
    for (const name of NEW_INDICATOR_NAMES) {
      const block = sliceIndicatorBlock(name);
      const m = block.match(/layer:\s*(\d+)/);
      expect(m, `${name} has no layer field`).not.toBeNull();
      expect([3, 5]).toContain(Number(m![1]));
    }
  });
});
