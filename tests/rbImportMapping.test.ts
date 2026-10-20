import { describe, it, expect } from "vitest";
import {
  mapCompanies,
  mapFool,
  mapHolders13f,
  mapFundamentals,
  mapWeeklyBars,
  mapRatings,
  mapScoreHistory,
  mapScoreBaseline,
  mapTheses,
  mapThesisTags,
  crossCheckHoldings,
  ExportCompanyRow,
  ExportFoolRow,
  ExportHolder13fRow,
  ExportFundamentalsRow,
  ExportWeeklyBarRow,
  ExportScoreBaselineRow,
} from "../scripts/rb-import.ts";

// Synthetic fixtures shaped exactly like the real export (confirmed against
// rule-breaker-ratiobo-import.zip, 2026-10-19) -- obviously-fake tickers so
// they can never be mistaken for real data.

describe("mapCompanies", () => {
  const rows: ExportCompanyRow[] = [
    {
      symbol: "TESTA", yahoo: "TESTA", name: "Test Alpha Corp", sector: "Technology",
      industry: "Software", quote_currency: "USD", source: "fool", added: null, note: null, active: true,
    },
  ];

  it("maps yahoo -> yahoo_symbol and quote_currency -> currency", () => {
    const [row] = mapCompanies(rows);
    expect(row).toMatchObject({
      symbol: "TESTA", yahoo_symbol: "TESTA", name: "Test Alpha Corp",
      sector: "Technology", source: "fool", currency: "USD", active: true,
    });
  });

  it("handles a yahoo symbol that differs from the canonical symbol (e.g. share-class suffixes)", () => {
    const [row] = mapCompanies([{ ...rows[0], symbol: "BRKB", yahoo: "BRK-B" }]);
    expect(row.symbol).toBe("BRKB");
    expect(row.yahoo_symbol).toBe("BRK-B");
  });
});

describe("mapFool", () => {
  it("passes through a bare-year first_rec string untouched (not parsed as a date)", () => {
    const rows: ExportFoolRow[] = [
      { symbol: "TESTA", f5: 64.25, type: "Moderate", first_rec: "2022", recs: 2, top10: false, status: "active", closed_on: null },
    ];
    const [row] = mapFool(rows);
    expect(row.first_rec).toBe("2022");
    expect(row).toMatchObject({ symbol: "TESTA", f5: 64.25, type: "Moderate", top10: false, status: "active" });
  });
});

describe("mapHolders13f", () => {
  it("passes through the free-text quarter label untouched (not parsed as a date)", () => {
    const rows: ExportHolder13fRow[] = [
      { symbol: "TESTA", quarter: "Jun 30, 2026 13F (filed Aug 2026)", fund: "Fund One", weight_pct: 2.1, change: "add" },
      { symbol: "TESTA", quarter: "Jun 30, 2026 13F (filed Aug 2026)", fund: "Fund Two", weight_pct: 1.4, change: "new" },
    ];
    const mapped = mapHolders13f(rows);
    expect(mapped).toHaveLength(2);
    expect(mapped[0].quarter).toBe("Jun 30, 2026 13F (filed Aug 2026)");
    // multiple funds for the same symbol+quarter must not collapse
    expect(new Set(mapped.map((r) => r.fund)).size).toBe(2);
  });
});

describe("mapFundamentals", () => {
  it("stores the separately-provided fcur/fx_to_usd/mcap_usd and folds price/price_asof into raw", () => {
    const rows: ExportFundamentalsRow[] = [
      {
        symbol: "TESTA", asof: "2026-10-19", fcur: "USD", fx_to_usd: 1, mcap_usd: 5_000_000_000,
        price: 175.46, price_asof: "2026-10-19 close", raw: { rev: [1000, 900], gmTTM: 0.5 },
      },
    ];
    const [row] = mapFundamentals(rows);
    expect(row.fcur).toBe("USD");
    expect(row.fx_to_usd).toBe(1);
    expect(row.mcap_usd).toBe(5_000_000_000);
    expect(row.raw).toMatchObject({ rev: [1000, 900], gmTTM: 0.5, price: 175.46, price_asof: "2026-10-19 close" });
  });

  it("omits price/price_asof from raw when the export doesn't provide them", () => {
    const [row] = mapFundamentals([
      { symbol: "TESTB", asof: "2026-10-19", fcur: "USD", fx_to_usd: 1, mcap_usd: null, raw: { ni: 100 } },
    ]);
    expect(row.raw).toEqual({ ni: 100 });
  });
});

describe("mapWeeklyBars", () => {
  it("renames vwap6/vwap6_sd/vwap12 to the DB's vwap6_a/vwap6_sigma/vwap12_b", () => {
    const rows: ExportWeeklyBarRow[] = [
      {
        symbol: "TESTA", week_start: "2026-09-01", open: 10, high: 11, low: 9.5, close: 10.5,
        volume: 100000, vwap6: 10.2, vwap6_sd: 0.3, vwap12: 9.9, signal: "u",
      },
    ];
    const [row] = mapWeeklyBars(rows);
    expect(row).toMatchObject({ symbol: "TESTA", week_start: "2026-09-01", close: 10.5, vwap6_a: 10.2, vwap6_sigma: 0.3, vwap12_b: 9.9, signal: "u" });
  });
});

describe("mapRatings", () => {
  it("tags every row with the given user_id and keeps rated_by as free text", () => {
    const rows = mapRatings(
      [{ symbol: "TESTA", td: 5, moat: 4, mgmt: 5, appeal: 3, founder: true, why: null, appeal_why: null, appeal_basis: "customer", rated_by: "Claude", rated_on: "2026-09-24", appeal_rated_on: "2026-09-30", source_url: null }],
      "user-123",
    );
    expect(rows).toEqual([
      expect.objectContaining({ symbol: "TESTA", user_id: "user-123", td: 5, rated_by: "Claude", appeal_rated_on: "2026-09-30" }),
    ]);
  });
});

describe("mapScoreHistory", () => {
  it("passes through config_version from the file verbatim (the spec's own 'artifact-v15', not a guessed sentinel)", () => {
    const rows = mapScoreHistory([{ symbol: "TESTA", date: "2026-09-21", score: 78, config_version: "artifact-v15", partial: true }]);
    expect(rows[0]).toMatchObject({ symbol: "TESTA", date: "2026-09-21", score: 78, config_version: "artifact-v15", partial: true });
    expect(rows[0].met).toBeNull();
    expect(rows[0].c1).toBeNull();
  });
});

describe("mapScoreBaseline", () => {
  const baselineRow: ExportScoreBaselineRow = {
    symbol: "TESTA", date: "2026-10-19", config_version: "artifact-v15", rank: 1, score: 100, met: 5,
    c1: 92, c2: 79, c3: null, c4: 80, c5: 100, c6: 96, composite: 89.4, screen: "Watchlist",
    safety: 13, quality: 14, qgroup: null, weak_pillar: "Safety 13", risk_type: "Aggressive",
    owned: true, vwap_state: "Below VWAP: exit / stay out", vwap_z: -0.85,
    action: "No new money", action_key: "nonew", action_why: "Safety veto: debt or volatility too high (13).",
    drivers: { c1: [{ name: "Revenue growth", value: 0.33, pct: 75.8 }] },
  };

  it("maps every scored field and never stores the owned flag", () => {
    const [row] = mapScoreBaseline([baselineRow]);
    expect(row).not.toHaveProperty("owned");
    expect(row).toMatchObject({
      symbol: "TESTA", met: 5, c1: 92, c3: null, safety: 13, screen: "Watchlist",
      vwap_state: "Below VWAP: exit / stay out", vwap_z: -0.85, action: "No new money",
    });
    expect(row.drivers).toEqual(baselineRow.drivers);
    expect(row.partial).toBe(false);
  });
});

describe("mapTheses / mapThesisTags", () => {
  it("tags theses with the given user_id and renames created -> created_at", () => {
    const [thesis] = mapTheses([{ id: "robotics", name: "Robotics", note: "automation thesis", created: "2026-10-09" }], "user-123");
    expect(thesis).toEqual({ id: "robotics", user_id: "user-123", name: "Robotics", note: "automation thesis", created_at: "2026-10-09" });
  });

  it("passes thesis tags through untouched, preserving slug ids", () => {
    const tags = mapThesisTags([{ symbol: "LSCC", thesis_id: "robotics" }, { symbol: "VPG", thesis_id: "robotics" }]);
    expect(tags).toEqual([{ symbol: "LSCC", thesis_id: "robotics" }, { symbol: "VPG", thesis_id: "robotics" }]);
  });
});

describe("crossCheckHoldings", () => {
  it("flags a symbol the artifact says is owned but isn't live (artifact_owned_not_live)", () => {
    const mismatches = crossCheckHoldings(["TESTA", "TESTC"], [{ symbol: "TESTA", quantity: 10 }]);
    expect(mismatches).toContainEqual({ kind: "artifact_owned_not_live", symbol: "TESTC" });
  });

  it("flags a symbol that's live-owned but the artifact never marked owned (live_not_in_artifact)", () => {
    const mismatches = crossCheckHoldings(["TESTA"], [
      { symbol: "TESTA", quantity: 10 },
      { symbol: "TESTD", quantity: 5 },
    ]);
    expect(mismatches).toContainEqual({ kind: "live_not_in_artifact", symbol: "TESTD" });
  });

  it("reports clean when every artifact-owned symbol matches live data exactly", () => {
    expect(crossCheckHoldings(["TESTA"], [{ symbol: "TESTA", quantity: 5 }])).toHaveLength(0);
  });
});
