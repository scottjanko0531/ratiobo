import { describe, it, expect } from "vitest";
import { mapSecurityTermToTenor } from "../supabase/functions/_shared/auctionTenor.ts";

// v3 Phase 1b (debt-metrics-integrity-v3 spec). Every term string pinned
// here is a REAL label confirmed present in treasury_auction_results as of
// the v3 Phase 0 investigation (docs/specs/debt-metrics-integrity-decisions.md),
// not a hypothetical.
describe("mapSecurityTermToTenor", () => {
  describe("10Y family (new issue + every real reopening label)", () => {
    it("10-Year (new issue)", () => {
      expect(mapSecurityTermToTenor("10-Year")).toBe("10Y");
    });
    it("9-Year 11-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("9-Year 11-Month")).toBe("10Y");
    });
    it("9-Year 10-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("9-Year 10-Month")).toBe("10Y");
    });
    it("9-Year 9-Month (reopening, one-off label seen once in real history)", () => {
      expect(mapSecurityTermToTenor("9-Year 9-Month")).toBe("10Y");
    });
    it("9-Year 8-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("9-Year 8-Month")).toBe("10Y");
    });
  });

  describe("30Y family (new issue + every real reopening label)", () => {
    it("30-Year (new issue)", () => {
      expect(mapSecurityTermToTenor("30-Year")).toBe("30Y");
    });
    it("29-Year 11-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("29-Year 11-Month")).toBe("30Y");
    });
    it("29-Year 10-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("29-Year 10-Month")).toBe("30Y");
    });
    it("29-Year 8-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("29-Year 8-Month")).toBe("30Y");
    });
    it("29-Year 6-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("29-Year 6-Month")).toBe("30Y");
    });
    it("29-Year 4-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("29-Year 4-Month")).toBe("30Y");
    });
  });

  describe("20Y family (reference only -- out of scope for consumers, but the mapping itself must still be correct)", () => {
    it("20-Year (new issue)", () => {
      expect(mapSecurityTermToTenor("20-Year")).toBe("20Y");
    });
    it("19-Year 11-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("19-Year 11-Month")).toBe("20Y");
    });
    it("19-Year 10-Month (reopening)", () => {
      expect(mapSecurityTermToTenor("19-Year 10-Month")).toBe("20Y");
    });
  });

  describe("other real tenor families in the table -- the rule must generalize, not be a 10Y/30Y special case", () => {
    it("2-Year (new issue)", () => {
      expect(mapSecurityTermToTenor("2-Year")).toBe("2Y");
    });
    it("1-Year 11-Month (2Y reopening)", () => {
      expect(mapSecurityTermToTenor("1-Year 11-Month")).toBe("2Y");
    });
    it("1-Year 10-Month (2Y reopening)", () => {
      expect(mapSecurityTermToTenor("1-Year 10-Month")).toBe("2Y");
    });
    it("5-Year (new issue)", () => {
      expect(mapSecurityTermToTenor("5-Year")).toBe("5Y");
    });
    it("4-Year 10-Month (5Y reopening)", () => {
      expect(mapSecurityTermToTenor("4-Year 10-Month")).toBe("5Y");
    });
    it("4-Year 8-Month (5Y reopening)", () => {
      expect(mapSecurityTermToTenor("4-Year 8-Month")).toBe("5Y");
    });
    it("4-Year 6-Month (5Y reopening)", () => {
      expect(mapSecurityTermToTenor("4-Year 6-Month")).toBe("5Y");
    });
    it("4-Year 4-Month (5Y reopening)", () => {
      expect(mapSecurityTermToTenor("4-Year 4-Month")).toBe("5Y");
    });
    it("3-Year (new issue)", () => {
      expect(mapSecurityTermToTenor("3-Year")).toBe("3Y");
    });
    it("7-Year (new issue)", () => {
      expect(mapSecurityTermToTenor("7-Year")).toBe("7Y");
    });
  });

  describe("unknown/unmatched terms -- must return null, never a wrong guess", () => {
    it("Bills with week-denominated terms", () => {
      expect(mapSecurityTermToTenor("13-Week")).toBeNull();
      expect(mapSecurityTermToTenor("26-Week")).toBeNull();
      expect(mapSecurityTermToTenor("4-Week")).toBeNull();
      expect(mapSecurityTermToTenor("52-Week")).toBeNull();
    });
    it("Bills with day-denominated terms (including odd/irregular CMB-style terms)", () => {
      expect(mapSecurityTermToTenor("150-Day")).toBeNull();
      expect(mapSecurityTermToTenor("1-Day")).toBeNull();
      expect(mapSecurityTermToTenor("119-Day")).toBeNull();
    });
    it("a month count of 0 or 12 (shouldn't occur in real data, but must not be guessed)", () => {
      expect(mapSecurityTermToTenor("9-Year 0-Month")).toBeNull();
      expect(mapSecurityTermToTenor("9-Year 12-Month")).toBeNull();
    });
    it("garbage/empty input", () => {
      expect(mapSecurityTermToTenor("")).toBeNull();
      expect(mapSecurityTermToTenor("not a term")).toBeNull();
    });
  });
});
