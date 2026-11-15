// Shared point-in-time fundamentals derivation logic -- metric
// definitions, tag-merge-with-priority, deriveQuarters/dedupeInstant, and
// the total_liabilities / gross_profit / total_debt / free_cash_flow
// fallback derivations. Used by BOTH:
//   - load_fundamentals.mjs (per-company SEC companyconcept HTTP calls)
//   - load_fundamentals_bulk.mjs (SEC's companyfacts.zip bulk file, read
//     once and shared across all companies -- built for Phase 2b scale,
//     since per-company HTTP calls at ~8,000 companies would take ~18
//     hours at SEC's 10 req/s cap; the bulk file turns this into a local
//     JSON read with no network calls and no rate limit at all)
//
// Deliberately NOT built on SEC's frames API: frames returns one
// deduplicated value per company per period (the LATEST filed), which
// would bake restated numbers into history -- exactly the look-ahead
// bias the point-in-time design exists to prevent. companyfacts.zip
// preserves every filed vintage with its own filed date, same as the
// per-company companyconcept API, so this file's logic is IDENTICAL
// between the HTTP and bulk-file paths -- only how raw tag entries are
// fetched differs (see sec.mjs's fetchSecConcept vs this file's
// fetchTagEntriesFromCompanyFacts).

import { deriveQuarters, dedupeInstant, nearestCalQuarterEnd } from "./sec.mjs";

export const DURATION_METRICS = {
  revenue: { tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], unit: "USD" },
  gross_profit: { tags: ["GrossProfit"], unit: "USD" },
  operating_income: { tags: ["OperatingIncomeLoss"], unit: "USD" },
  net_income: { tags: ["NetIncomeLoss", "ProfitLoss"], unit: "USD" },
  eps_diluted: { tags: ["EarningsPerShareDiluted"], unit: "USD/shares" },
  shares_diluted: { tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"], unit: "shares" },
  operating_cash_flow: { tags: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], unit: "USD" },
  capex: { tags: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], unit: "USD" },
  // Added for Phase 3's point-in-time EBITDA/EBIT/effective-tax-rate --
  // none of these were extracted before (the live Rule Breaker screen
  // sources ebit/ebitda/tax/ic from Yahoo directly, which has no
  // point-in-time/filed_date history to replay). Same filed-date-per-
  // vintage convention as every other DURATION_METRICS entry; a company
  // that never tagged one of these (e.g. a REIT with no real D&A tag
  // distinct from a blended line item) simply gets no rows for it --
  // not substituted, not backfilled from a different metric.
  depreciation_amortization: { tags: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "Depreciation"], unit: "USD" },
  income_tax_expense: { tags: ["IncomeTaxExpenseBenefit"], unit: "USD" },
  pretax_income: { tags: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"], unit: "USD" },
  stock_based_compensation: { tags: ["ShareBasedCompensation"], unit: "USD" },
  // Added for Phase 3's historical rdOverGrossProfit driver (Sign 2 /
  // c2) -- confirmed absent from every prior extraction pass (no
  // research_development/rd/r_and_d metric existed in scr_fundamentals
  // at all before this). Same filed-date-per-vintage, no-substitution
  // convention as every other DURATION_METRICS entry; a company that
  // never tagged R&D (most financials, REITs, many non-tech industrials)
  // simply gets no rows for it.
  research_development: { tags: ["ResearchAndDevelopmentExpense"], unit: "USD" },
};

export const INSTANT_METRICS = {
  total_assets: { tags: ["Assets"], unit: "USD" },
  total_liabilities: { tags: ["Liabilities"], unit: "USD" },
  stockholders_equity: { tags: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], unit: "USD" },
  cash_and_equivalents: { tags: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], unit: "USD" },
  total_debt: { tags: ["DebtLongtermAndShorttermCombinedAmount", "LongTermDebt"], unit: "USD" },
  // dei:EntityCommonStockSharesOutstanding, not us-gaap -- the cover-page
  // "as of" share count every 10-K/10-Q reports specifically for filer-size
  // classification. This is the field the universe-history step needs for
  // point-in-time market cap (price x shares as of the date); shares_diluted
  // (WeightedAverageNumberOfDilutedSharesOutstanding, a DURATION metric
  // averaged over the reporting period) is not a substitute -- it's a flow
  // average, not an instant snapshot, and the wrong vintage for market cap.
  shares_outstanding: { tags: ["EntityCommonStockSharesOutstanding"], unit: "shares", namespace: "dei" },
};

export const GROSS_PROFIT_FALLBACK_INPUT = { tags: ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfServices"], unit: "USD", kind: "duration" };
export const DEBT_NONCURRENT_FALLBACK_INPUT = { tags: ["LongTermDebtNoncurrent"], unit: "USD", kind: "instant" };
export const DEBT_CURRENT_FALLBACK_INPUT = { tags: ["LongTermDebtCurrent"], unit: "USD", kind: "instant" };

export const ALL_METRICS = { ...DURATION_METRICS, ...INSTANT_METRICS };

function toRow(company, metric, unit, periodEnd, value, derived, tag, filed, form) {
  return {
    company_id: company.id, metric, period_end: periodEnd,
    cal_quarter_end: nearestCalQuarterEnd(periodEnd),
    value, unit, derived, xbrl_tag: tag, filed_date: filed, form: form ?? null,
  };
}

// Merge multiple fallback tags for one metric: an earlier-listed tag's
// entries always win over a later tag's for the same key (fallback only
// fills gaps); within the SAME tag, the earliest-filed vintage wins
// (point-in-time). fetchTagEntries(tag, opts) -> entries[]|null, sync or
// async, abstracts away HTTP vs local-file.
async function fetchMerged(fetchTagEntries, tags, opts) {
  const raw = new Map();
  for (const tag of tags) {
    let entries;
    try {
      entries = await fetchTagEntries(tag, opts);
    } catch {
      entries = null;
    }
    for (const e of entries ?? []) {
      const key = opts.kind === "instant" ? e.end : `${e.start}|${e.end}`;
      const cur = raw.get(key);
      if (!cur || (cur.tag === tag && e.filed < cur.filed)) raw.set(key, { ...e, tag });
    }
  }
  return [...raw.values()];
}

// fetchTagEntries(tag, opts) -> entries[]|null -- the only thing that
// differs between the HTTP and bulk-file callers.
export async function buildFundamentalsForCompany(company, fetchTagEntries) {
  const rows = [];
  const byMetricQuarters = {};

  for (const [metric, def] of Object.entries(DURATION_METRICS)) {
    const merged = await fetchMerged(fetchTagEntries, def.tags, { unit: def.unit, kind: "duration" });
    const tagOf = new Map(merged.map((e) => [e.end, e.tag]));
    const quarters = deriveQuarters(merged, metric);
    const qMap = new Map();
    for (const q of quarters) {
      rows.push(toRow(company, metric, def.unit, q.period_end, q.value, q.derived, tagOf.get(q.period_end) ?? q.tag, q.filed));
      qMap.set(q.period_end, { value: q.value, filed: q.filed });
    }
    byMetricQuarters[metric] = qMap;
  }

  const byMetricInstant = {};

  for (const [metric, def] of Object.entries(INSTANT_METRICS)) {
    const merged = await fetchMerged(fetchTagEntries, def.tags, { unit: def.unit, kind: "instant", namespace: def.namespace });
    const tagOf = new Map(merged.map((e) => [e.end, e.tag]));
    const deduped = dedupeInstant(merged);
    const iMap = new Map();
    for (const e of deduped) {
      rows.push(toRow(company, metric, def.unit, e.end, e.val, false, tagOf.get(e.end) ?? "merged", e.filed));
      iMap.set(e.end, { value: e.val, filed: e.filed });
    }
    byMetricInstant[metric] = iMap;
  }

  const directLiabilitiesEnds = new Set(rows.filter((r) => r.metric === "total_liabilities").map((r) => r.period_end));
  const assetsMap = byMetricInstant.total_assets;
  const equityMap = byMetricInstant.stockholders_equity;
  if (assetsMap && equityMap) {
    for (const [end, assetsE] of assetsMap) {
      if (directLiabilitiesEnds.has(end)) continue;
      const equityE = equityMap.get(end);
      if (!equityE) continue;
      const filed = assetsE.filed > equityE.filed ? assetsE.filed : equityE.filed;
      rows.push(toRow(company, "total_liabilities", "USD", end, assetsE.value - equityE.value, true, "derived:assets-equity", filed));
    }
  }

  const directGrossProfitEnds = new Set(rows.filter((r) => r.metric === "gross_profit").map((r) => r.period_end));
  const revenueMap = byMetricQuarters.revenue;
  if (revenueMap) {
    const costMerged = await fetchMerged(fetchTagEntries, GROSS_PROFIT_FALLBACK_INPUT.tags, GROSS_PROFIT_FALLBACK_INPUT);
    const costQuarters = deriveQuarters(costMerged, "cost_of_revenue");
    const costMap = new Map(costQuarters.map((q) => [q.period_end, { value: q.value, filed: q.filed }]));
    for (const [periodEnd, revQ] of revenueMap) {
      if (directGrossProfitEnds.has(periodEnd)) continue;
      const costQ = costMap.get(periodEnd);
      if (!costQ) continue;
      const filed = revQ.filed > costQ.filed ? revQ.filed : costQ.filed;
      rows.push(toRow(company, "gross_profit", "USD", periodEnd, revQ.value - costQ.value, true, "derived:revenue-cost", filed));
    }
  }

  const directDebtEnds = new Set(rows.filter((r) => r.metric === "total_debt").map((r) => r.period_end));
  const noncurrentMerged = await fetchMerged(fetchTagEntries, DEBT_NONCURRENT_FALLBACK_INPUT.tags, DEBT_NONCURRENT_FALLBACK_INPUT);
  const currentMerged = await fetchMerged(fetchTagEntries, DEBT_CURRENT_FALLBACK_INPUT.tags, DEBT_CURRENT_FALLBACK_INPUT);
  const noncurrentByEnd = new Map(dedupeInstant(noncurrentMerged).map((e) => [e.end, e]));
  const currentByEnd = new Map(dedupeInstant(currentMerged).map((e) => [e.end, e]));
  for (const end of new Set([...noncurrentByEnd.keys(), ...currentByEnd.keys()])) {
    if (directDebtEnds.has(end)) continue;
    const nc = noncurrentByEnd.get(end);
    const cur = currentByEnd.get(end);
    if (nc && cur) {
      const filed = nc.filed > cur.filed ? nc.filed : cur.filed;
      rows.push(toRow(company, "total_debt", "USD", end, nc.val + cur.val, true, "derived:noncurrent+current", filed));
    } else if (nc) {
      rows.push(toRow(company, "total_debt", "USD", end, nc.val, true, "LongTermDebtNoncurrent", nc.filed));
    } else {
      rows.push(toRow(company, "total_debt", "USD", end, cur.val, true, "LongTermDebtCurrent", cur.filed));
    }
  }

  const hasAnyDebtRow = rows.some((r) => r.metric === "total_debt");
  if (!hasAnyDebtRow && assetsMap) {
    for (const [end, assetsE] of assetsMap) {
      rows.push(toRow(company, "total_debt", "USD", end, 0, true, "derived:zero-inferred", assetsE.filed));
    }
  }

  const ocf = byMetricQuarters.operating_cash_flow;
  const capex = byMetricQuarters.capex;
  if (ocf && capex) {
    for (const [periodEnd, ocfQ] of ocf) {
      const capexQ = capex.get(periodEnd);
      if (!capexQ) continue;
      const filed = ocfQ.filed > capexQ.filed ? ocfQ.filed : capexQ.filed;
      rows.push(toRow(company, "free_cash_flow", "USD", periodEnd, ocfQ.value - capexQ.value, true, "derived:ocf-capex", filed));
    }
  }

  // EBITDA = operating_income + D&A. Only written when BOTH quarters are
  // present for the same period_end (no substitution with a partial/
  // missing input) -- a company missing D&A for a given quarter simply
  // gets no ebitda row for that quarter, same convention as every other
  // derived metric above. Profile B's growth-discipline factor prefers
  // this over operating_income once it exists for a given period, per
  // the user's explicit instruction; it is NOT a replacement for
  // operating_income itself, which keeps its own rows regardless.
  const operatingIncome = byMetricQuarters.operating_income;
  const depAmort = byMetricQuarters.depreciation_amortization;
  if (operatingIncome && depAmort) {
    for (const [periodEnd, oiQ] of operatingIncome) {
      const daQ = depAmort.get(periodEnd);
      if (!daQ) continue;
      const filed = oiQ.filed > daQ.filed ? oiQ.filed : daQ.filed;
      rows.push(toRow(company, "ebitda", "USD", periodEnd, oiQ.value + daQ.value, true, "derived:operating_income+D&A", filed));
    }
  }

  // Effective tax rate = income_tax_expense / pretax_income. Null (no row)
  // when pretax_income is zero or either input is missing -- never a
  // divide-by-zero or a guessed rate. Feeds returnOnInvestedCapital's
  // ebit*(1-tax) formula point-in-time (metrics.ts), which previously had
  // no historical tax-rate source at all.
  const incomeTaxExpense = byMetricQuarters.income_tax_expense;
  const pretaxIncome = byMetricQuarters.pretax_income;
  if (incomeTaxExpense && pretaxIncome) {
    for (const [periodEnd, taxQ] of incomeTaxExpense) {
      const preQ = pretaxIncome.get(periodEnd);
      if (!preQ || preQ.value === 0) continue;
      const filed = taxQ.filed > preQ.filed ? taxQ.filed : preQ.filed;
      rows.push(toRow(company, "effective_tax_rate", "ratio", periodEnd, taxQ.value / preQ.value, true, "derived:tax_expense/pretax_income", filed));
    }
  }

  return rows;
}
