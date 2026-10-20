// Rule Breaker Screener — shared types. Pure, Deno-API-free (same
// convention as marketConditions/bondLens). Deliberately NOT unified with
// scripts/rb-import.ts's RbScoreRow -- that one is the importer's literal
// upsert payload shape (a DB row read back from the artifact's own export);
// this is this module's own computation output, a different concern even
// though the fields look almost identical.

// rb_fundamentals.raw's actual fields, confirmed field-by-field against the
// real 2026-10-19 export this session (abbreviated Yahoo-style keys, not
// renamed -- matching the DB column verbatim makes cross-referencing the
// real data trivial). Every field is optional/nullable: Yahoo's own data
// can be missing per-symbol (e.g. a profitability-null biotech, a
// dividend-null growth stock).
export interface RbFundamentalsRaw {
  assets?: [number, number] | null; // [latest FY, prior FY]
  cash?: number | null;
  cfo?: [number, number] | null;
  debt?: number | null;
  div?: number | null;
  ebit?: number | null;
  ebitda?: number | null;
  eq?: number | null;
  evEbitda?: number | null; // raw Yahoo field -- NOT used for c6 "EV/sales" (that's recomputed, see metrics.ts)
  evRev?: number | null; // same -- raw field, superseded by the recomputed EV/sales driver
  fcur?: string | null;
  fpe?: number | null;
  fxF?: number | null;
  fy?: string | null;
  gmTTM?: number | null;
  gp?: [number, number] | null;
  ic?: number | null; // invested capital
  ins?: number | null; // insider ownership
  insBuyN?: number | null;
  insNet6m?: number | null;
  insSellN?: number | null;
  inst?: number | null; // institutional ownership
  liqCV?: number | null;
  liqTrend?: number | null;
  mcapUSD?: number | null;
  mdd1y?: number | null;
  mom12_1?: number | null;
  mom3?: number | null;
  mom6?: number | null;
  n?: number | null;
  ni?: number | null; // net income
  ps?: number | null; // price/sales
  qgp?: number[] | null; // last 5 quarters, oldest first
  qni?: number[] | null;
  qoi?: number[] | null; // quarterly operating income
  qrev?: number[] | null;
  rd?: number | null; // R&D expense
  rep?: number | null; // repurchases (negative = buybacks)
  ret1y?: number | null;
  rev?: [number, number, number] | null; // [latest FY, FY-1, FY-2]
  rgQ?: number | null; // latest quarter revenue growth YoY
  rv?: number | null; // realized volatility (1y)
  sbc?: number | null; // stock-based compensation
  tax?: number | null; // effective tax rate
}

export interface RbFundamentalsInput {
  symbol: string;
  asof: string;
  mcap_usd: number | null;
  fx_to_usd: number | null;
  raw: RbFundamentalsRaw;
}

export interface RbWeeklyBarInput {
  symbol: string;
  week_start: string;
  close: number | null;
  vwap6_a: number | null; // 6-week VWAP
  vwap6_sigma: number | null;
  vwap12_b: number | null; // 12-week VWAP
  signal: "u" | "d" | null;
}

export interface RbCompanyInput {
  symbol: string;
  sector: string | null;
}

export interface RbFoolInput {
  symbol: string;
  f5: number | null;
  type: "Cautious" | "Moderate" | "Aggressive" | null;
  top10: boolean;
  closed_on: string | null;
}

export interface RbRatingInput {
  symbol: string;
  td: number | null;
  moat: number | null;
  mgmt: number | null;
  appeal: number | null;
}

// One sub-metric's full trail, matching the real export's `drivers` JSON
// shape exactly (confirmed field-by-field this session) -- `value` is the
// metric's own raw computed value, `pct` is its cross-sectional percentile
// (0-100) within the live universe.
export interface DriverEntry {
  name: string;
  value: number | null;
  pct: number | null;
}

export type DriverGroup = "c1" | "c2" | "c3" | "c4" | "c6" | "safety" | "prof" | "cash" | "trend";

export type Drivers = Record<DriverGroup, DriverEntry[]>;

// This module's own computation output -- see header comment on why this
// isn't unified with rb-import.ts's RbScoreRow.
export interface ComputedRbScore {
  symbol: string;
  date: string;
  config_version: string;
  c1: number | null;
  c2: number | null;
  c3: number | null;
  c4: number | null;
  c5: number | null;
  c6: number | null;
  met: number | null;
  composite: number | null;
  score: number | null;
  rank: number | null;
  screen: string | null;
  safety: number | null;
  quality: number | null;
  qgroup: string | null;
  weak_pillar: string | null;
  risk_type: string | null;
  action: string | null;
  action_key: string | null;
  action_why: string | null;
  vwap_state: string | null;
  vwap_z: number | null;
  drivers: Drivers;
}
