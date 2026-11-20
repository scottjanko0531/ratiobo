import { describe, it, expect } from "vitest";
import { extractIndexValue } from "../supabase/functions/_shared/ismIndexExtract.ts";

describe("extractIndexValue", () => {
  it("extracts a simple '<label> ... X.X percent' value", () => {
    const text = "The Prices Index registered 75.2 percent in October.";
    expect(extractIndexValue(text, "Prices Index", 0)).toBe(75.2);
  });

  it("skips a 'percentage points' change and finds the real index value after it", () => {
    const text = "The Prices Index increased 3.7 percentage points to 59.1 percent from last month.";
    expect(extractIndexValue(text, "Prices Index", 0)).toBe(59.1);
  });

  it("returns null when the label isn't found", () => {
    const text = "No prices mentioned here.";
    expect(extractIndexValue(text, "Prices Index", 0)).toBeNull();
  });

  it("returns null when no percent value follows within the window", () => {
    const text = "Prices Index " + "x".repeat(260) + " 75.2 percent";
    expect(extractIndexValue(text, "Prices Index", 0)).toBeNull();
  });

  it("respects the anchorIdx so an earlier, unrelated label mention is ignored", () => {
    const text = "MANUFACTURING INDEX SUMMARIES Prices Index registered 10.0 percent before the anchor. " +
      "SOME OTHER SECTION Prices Index registered 75.2 percent after the anchor.";
    const anchorIdx = text.indexOf("SOME OTHER SECTION");
    expect(extractIndexValue(text, "Prices Index", anchorIdx)).toBe(75.2);
  });
});
