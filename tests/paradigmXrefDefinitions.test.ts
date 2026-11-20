import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// growth-inflation-indicator-gaps spec, Phase 3: definition-sanity check
// for the three new big_cycle_paradigm_raw_series cross-references.
// Separate from indicatorGapsDefinitions.test.ts (Phase 1) since these
// have a different required shape (data_source "supabase", no
// fred_series_id, a metric_key in `series` rather than a FRED series id).
// Same text-slicing approach -- fetch-macro-data/index.ts can't be
// imported under Vitest (module-scope Deno.env.get(...)! calls).

const SOURCE = readFileSync(
  new URL("../supabase/functions/fetch-macro-data/index.ts", import.meta.url),
  "utf8",
);

const NEW_XREF_INDICATORS: { name: string; metricKey: string; layer: number }[] = [
  { name: "Corporate Profits / GDI", metricKey: "corp_profits_gdi", layer: 3 },
  { name: "Market Cap / GDP (Buffett Indicator)", metricKey: "valuation_proxy", layer: 3 },
  { name: "Trade / GDP Ratio", metricKey: "trade_gdp", layer: 5 },
];

function sliceIndicatorBlock(name: string): string {
  // Source-file string literals escape embedded double quotes (e.g. the
  // Buffett Indicator name), so match against the escaped form too.
  const escaped = name.replace(/"/g, '\\"');
  const nameIdx = SOURCE.indexOf(`name: "${escaped}"`);
  if (nameIdx === -1) throw new Error(`indicator "${name}" not found in fetch-macro-data/index.ts at all`);
  const closeIdx = SOURCE.indexOf("\n  },", nameIdx);
  if (closeIdx === -1) throw new Error(`could not find the closing "},” for indicator "${name}"`);
  return SOURCE.slice(nameIdx, closeIdx);
}

describe("growth-inflation-indicator-gaps Phase 3 — Paradigm cross-reference definition sanity", () => {
  it("has exactly 3 new cross-reference indicators", () => {
    expect(NEW_XREF_INDICATORS.length).toBe(3);
  });

  for (const { name, metricKey, layer } of NEW_XREF_INDICATORS) {
    it(`"${name}" reads metric_key "${metricKey}" from big_cycle_paradigm_raw_series, no second fetch, lands in layer ${layer}`, () => {
      const block = sliceIndicatorBlock(name);
      expect(block).toMatch(/unit:\s*"[^"]+"/);
      expect(block).toMatch(/statusFn:\s*\(?.*=>/);
      expect(block).toMatch(/fred_series_id:\s*null/);
      expect(block).toMatch(/data_source:\s*"supabase"/);
      expect(block).toMatch(/type:\s*"supabase_paradigm_xref"/);
      expect(block).toContain(`series: "${metricKey}"`);
      expect(block).toContain("Cross-referenced from Fiscal Policy Paradigm.");
      const m = block.match(/layer:\s*(\d+)/);
      expect(m, `${name} has no layer field`).not.toBeNull();
      expect(Number(m![1])).toBe(layer);
    });
  }

  it("the supabase_paradigm_xref processor case reads the right table and metric_key column, no second fetch", () => {
    const caseIdx = SOURCE.indexOf('case "supabase_paradigm_xref"');
    expect(caseIdx, "supabase_paradigm_xref case not found").toBeGreaterThan(-1);
    const caseBlock = SOURCE.slice(caseIdx, caseIdx + 800);
    expect(caseBlock).toContain("big_cycle_paradigm_raw_series");
    expect(caseBlock).toContain("metric_key");
    expect(caseBlock).not.toMatch(/fetch\(/); // no outbound HTTP fetch -- pure DB cross-reference
  });
});
