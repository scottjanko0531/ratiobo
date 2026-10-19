import { describe, it, expect } from "vitest";
import {
  mapCompanies,
  mapFool,
  mapHolders13f,
  mapFundamentals,
  mapWeeklyBars,
  mapRatings,
  mapScoreHistory,
  mapTheses,
  crossCheckHoldings,
  LEGACY_IMPORT_CONFIG_VERSION,
  ArtifactCompany,
} from "../scripts/rb-import.ts";

// Synthetic 3-company fixture, obviously-fake tickers so it can never be
// mistaken for real data. TESTC is deliberately present in the artifact's
// "owned" list but absent from the fake liveOwned set, to prove the
// mismatch detector actually fires; TESTD is the reverse case.
const FIXTURE_COMPANIES: ArtifactCompany[] = [
  {
    sym: "TESTA",
    name: "Test Alpha Corp",
    sector: "Technology",
    source: "fool",
    added: "2024-01-15",
    active: true,
    fool: { f5: 92, type: "Aggressive", firstRec: "2020-01-15", recs: 3, top10: true, status: "active" },
    holders: [
      { fund: "Fund One", quarter: "2026-06-30", weight: 2.1, change: "add" },
      { fund: "Fund Two", quarter: "2026-06-30", weight: 1.4, change: "new" },
    ],
    raw: { asof: "2026-10-01", fcur: "USD", fxToUsd: 1, mcapUsd: 5_000_000_000, rev0: 1_000_000 },
    chart: [
      { weekStart: "2026-09-01", open: 10, high: 11, low: 9.5, close: 10.5, volume: 100000, vwap6a: 10.2, signal: "u" },
    ],
  },
  {
    sym: "TESTB",
    name: "Test Beta Inc",
    sector: "Healthcare",
    source: "our",
    fool: null,
    holders: [],
    raw: null,
    chart: [],
  },
  {
    sym: "TESTC",
    name: "Test Gamma Ltd",
    sector: "Technology",
    source: "fool",
    fool: null,
    holders: [],
    raw: null,
    chart: [],
  },
];

describe("mapCompanies", () => {
  it("maps symbol/name/sector/source/active for every company", () => {
    const rows = mapCompanies(FIXTURE_COMPANIES);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.symbol === "TESTA")).toMatchObject({
      name: "Test Alpha Corp",
      sector: "Technology",
      source: "fool",
      active: true,
    });
  });

  it("defaults missing optional fields rather than throwing", () => {
    const rows = mapCompanies(FIXTURE_COMPANIES);
    const testb = rows.find((r) => r.symbol === "TESTB")!;
    expect(testb.currency).toBe("USD");
    expect(testb.source).toBe("our");
    expect(testb.active).toBe(true);
  });
});

describe("mapFool", () => {
  it("only emits a row for companies with fool data", () => {
    const rows = mapFool(FIXTURE_COMPANIES);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "TESTA", f5: 92, type: "Aggressive", top10: true });
  });
});

describe("mapHolders13f", () => {
  it("produces one row per (symbol, quarter, fund), not collapsed per symbol+quarter", () => {
    const rows = mapHolders13f(FIXTURE_COMPANIES);
    expect(rows.filter((r) => r.symbol === "TESTA" && r.quarter === "2026-06-30")).toHaveLength(2);
    expect(rows.map((r) => r.fund)).toEqual(expect.arrayContaining(["Fund One", "Fund Two"]));
  });

  it("emits nothing for companies with no holders", () => {
    const rows = mapHolders13f(FIXTURE_COMPANIES);
    expect(rows.some((r) => r.symbol === "TESTB")).toBe(false);
  });
});

describe("mapFundamentals", () => {
  it("promotes asof/fcur/fxToUsd/mcapUsd to columns and keeps the rest in raw", () => {
    const rows = mapFundamentals(FIXTURE_COMPANIES);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.symbol).toBe("TESTA");
    expect(row.asof).toBe("2026-10-01");
    expect(row.fcur).toBe("USD");
    expect(row.fx_to_usd).toBe(1);
    expect(row.mcap_usd).toBe(5_000_000_000);
    expect(row.raw).toEqual({ rev0: 1_000_000 });
    expect(row.raw).not.toHaveProperty("asof");
  });

  it("skips companies with no raw fundamentals", () => {
    const rows = mapFundamentals(FIXTURE_COMPANIES);
    expect(rows.some((r) => r.symbol === "TESTB" || r.symbol === "TESTC")).toBe(false);
  });
});

describe("mapWeeklyBars", () => {
  it("maps one row per chart bar", () => {
    const rows = mapWeeklyBars(FIXTURE_COMPANIES);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "TESTA", week_start: "2026-09-01", close: 10.5, signal: "u" });
  });
});

describe("mapRatings", () => {
  it("tags every row with the given user_id", () => {
    const rows = mapRatings([{ sym: "TESTA", td: 5, moat: 4, mgmt: 5, appeal: 3 }], "user-123");
    expect(rows).toEqual([
      expect.objectContaining({ symbol: "TESTA", user_id: "user-123", td: 5, moat: 4, mgmt: 5, appeal: 3, appeal_basis: "customer" }),
    ]);
  });
});

describe("mapTheses", () => {
  it("tags theses with the given user_id and maps tags untouched", () => {
    const { theses, tags } = mapTheses(
      [{ id: "t1", name: "Robotics", note: "automation thesis" }],
      [{ symbol: "LSCC", thesisId: "t1" }, { symbol: "VPG", thesisId: "t1" }],
      "user-123",
    );
    expect(theses).toEqual([{ id: "t1", user_id: "user-123", name: "Robotics", note: "automation thesis" }]);
    expect(tags).toEqual([
      { symbol: "LSCC", thesis_id: "t1" },
      { symbol: "VPG", thesis_id: "t1" },
    ]);
  });
});

describe("mapScoreHistory", () => {
  it("tags every imported row with the legacy sentinel config_version, never a guessed real version", () => {
    const rows = mapScoreHistory([{ sym: "TESTA", date: "2026-06-05", composite: 72 }]);
    expect(rows[0].config_version).toBe(LEGACY_IMPORT_CONFIG_VERSION);
    expect(rows[0].config_version).not.toMatch(/^artifact-v/);
  });

  it("maps every scored field present on the snapshot", () => {
    const rows = mapScoreHistory([
      {
        sym: "NVDA", date: "2026-10-07", c1: true, c2: true, c3: true, c4: true, c5: true, c6: true,
        met: 6, composite: 92, score: 92, rank: 1, screen: "Rule Breaker", safety: "ok",
        action: "Buy on pullback", actionKey: "buy_pullback",
      },
    ]);
    expect(rows[0]).toMatchObject({ symbol: "NVDA", met: 6, screen: "Rule Breaker", action: "Buy on pullback" });
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

  it("ignores a live holding with zero quantity if the caller already filtered it out upstream", () => {
    // crossCheckHoldings itself is a pure diff -- the quantity > 0 filter
    // lives in fetchLiveOwnedSymbols, not here. This test documents that
    // boundary: passing a zero-quantity row through would be treated as
    // owned by this function, by design.
    const mismatches = crossCheckHoldings(["TESTA"], [{ symbol: "TESTA", quantity: 0 }]);
    expect(mismatches).toHaveLength(0);
  });
});
