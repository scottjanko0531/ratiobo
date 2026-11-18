// Treasury Fiscal Data (MTS + Debt to the Penny) helpers — centralized here
// (not duplicated per-function) specifically because MTS Table 1 has a sharp
// correctness trap this file exists to hide: each monthly report republishes
// EVERY month of the current fiscal year under one classification group
// (sequence_number_cd "2.x") AND the *same calendar months of the prior*
// fiscal year under a second group ("1.x", shown for year-over-year
// comparison) — both groups can carry the identical classification_desc
// ("November", "February", ...). A naive "match this month's own name"
// filter silently sums both groups and roughly doubles every total. Always
// require sequence_number_cd.startsWith("2.") for "the actual current-FY
// month," never classification_desc alone. See
// docs/specs/debt-metrics-integrity-decisions.md Phase 2 for how this was
// found (a near-miss caught before it shipped).
//
// Table 9 (net interest) has no such duplication — it carries one row per
// classification per report, not a month-by-month breakdown — so
// fetchMtsNetInterestTrailing12 doesn't need the sequence_number_cd guard.

const FISCAL_DATA = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";

export interface MonthlyFiscalRow {
  date: string; // the month's own record_date (YYYY-MM-DD, last day of month)
  receiptsB: number;
  outlaysB: number;
  deficitB: number;
}

function monthName(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
}

function monthEndStr(year: number, month1to12: number): string {
  // month1to12 is 1-indexed; day 0 of the *next* month = last day of this month.
  const d = new Date(Date.UTC(year, month1to12, 0));
  return d.toISOString().slice(0, 10);
}

function addMonthsToMonthEnd(dateStr: string, months: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-indexed
  const total = (y * 12 + (m - 1)) + months;
  return monthEndStr(Math.floor(total / 12), (total % 12) + 1);
}

// Finds the most recent month-end whose MTS Table 1 report has actually been
// published (publication lag is ~3 weeks, not fixed enough to hardcode).
// Starts at last month's month-end and steps back up to 3 months.
async function findLatestPublishedMonthEnd(asOf: Date): Promise<string> {
  let candidate = monthEndStr(asOf.getUTCFullYear(), asOf.getUTCMonth()); // last day of *previous* month (getUTCMonth is 0-indexed, so this is month-1 in 1-indexed terms... see below)
  // getUTCMonth() is 0-indexed (0=Jan). monthEndStr expects 1-indexed month.
  // asOf.getUTCMonth() (0-indexed) equals "this month" in 1-indexed terms minus 1,
  // i.e. it already IS last month's 1-indexed number. Example: asOf=2026-11-16 ->
  // getUTCMonth()=10 (0-indexed Nov) -> monthEndStr(2026, 10) = Oct 2026 end. Correct.
  for (let i = 0; i < 4; i++) {
    const url = `${FISCAL_DATA}/v1/accounting/mts/mts_table_1?filter=record_date:eq:${candidate}&page[size]=1&fields=record_date`;
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      if ((j.data ?? []).length > 0) return candidate;
    }
    candidate = addMonthsToMonthEnd(candidate, -1);
  }
  throw new Error(`mtsFiscalData: no published MTS Table 1 report found in the last 4 months as of ${asOf.toISOString()}`);
}

export async function fetchMtsTable1Trailing12(asOf: Date = new Date()): Promise<{
  rows: MonthlyFiscalRow[];
  receiptsB: number;
  outlaysB: number;
  deficitB: number;
  windowStart: string;
  windowEnd: string;
}> {
  const windowEnd = await findLatestPublishedMonthEnd(asOf);
  const monthEnds: string[] = [];
  for (let i = 11; i >= 0; i--) monthEnds.push(addMonthsToMonthEnd(windowEnd, -i));
  const windowStart = monthEnds[0];

  const filterList = monthEnds.join(",");
  const url = `${FISCAL_DATA}/v1/accounting/mts/mts_table_1?filter=record_date:in:(${filterList})&page[size]=400&fields=record_date,classification_desc,current_month_gross_rcpt_amt,current_month_gross_outly_amt,current_month_dfct_sur_amt,sequence_number_cd`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mtsFiscalData: MTS table 1 trailing-12 fetch failed: HTTP ${res.status}`);
  const j = await res.json();
  const data = j.data as {
    record_date: string; classification_desc: string; sequence_number_cd: string;
    current_month_gross_rcpt_amt: string; current_month_gross_outly_amt: string; current_month_dfct_sur_amt: string;
  }[];

  const rows: MonthlyFiscalRow[] = [];
  for (const me of monthEnds) {
    const match = data.find((r) =>
      r.record_date === me &&
      r.classification_desc === monthName(me) &&
      r.sequence_number_cd.startsWith("2.")
    );
    if (!match) throw new Error(`mtsFiscalData: no current-fiscal-year row found for ${me} (month ${monthName(me)}) — data gap or format change`);
    rows.push({
      date: me,
      receiptsB: parseFloat(match.current_month_gross_rcpt_amt) / 1e9,
      outlaysB: parseFloat(match.current_month_gross_outly_amt) / 1e9,
      deficitB: parseFloat(match.current_month_dfct_sur_amt) / 1e9,
    });
  }

  return {
    rows,
    receiptsB: rows.reduce((s, r) => s + r.receiptsB, 0),
    outlaysB: rows.reduce((s, r) => s + r.outlaysB, 0),
    deficitB: rows.reduce((s, r) => s + r.deficitB, 0),
    windowStart, windowEnd,
  };
}

export async function fetchMtsNetInterestTrailing12(asOf: Date = new Date()): Promise<{
  rows: { date: string; valueB: number }[];
  netInterestB: number;
  windowStart: string;
  windowEnd: string;
}> {
  const windowEnd = await findLatestPublishedMonthEnd(asOf);
  const monthEnds: string[] = [];
  for (let i = 11; i >= 0; i--) monthEnds.push(addMonthsToMonthEnd(windowEnd, -i));
  const windowStart = monthEnds[0];

  // v2 Phase 5: was `sort=-record_date&page[size]=24` (the latest 24 rows,
  // full stop) -- correct for asOf=now (the 12 needed month-ends are always
  // within the newest 24), but silently wrong for any asOf more than ~1
  // year in the past, since the needed historical month-ends simply aren't
  // in "the latest 24" at all (byDate.get(me) would be undefined and throw).
  // Filtering by the exact month-end list instead (same approach
  // fetchMtsTable1Trailing12 already used) fixes backfill without changing
  // anything for the live/current-asOf case -- same 12 dates, same values,
  // confirmed via Phase 5's live comparison before this was relied on for
  // historical months.
  const filterList = monthEnds.join(",");
  const url = `${FISCAL_DATA}/v1/accounting/mts/mts_table_9?filter=line_code_nbr:eq:320,record_date:in:(${filterList})&page[size]=24&fields=record_date,current_month_rcpt_outly_amt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mtsFiscalData: MTS table 9 net interest fetch failed: HTTP ${res.status}`);
  const j = await res.json();
  const byDate = new Map(
    (j.data as { record_date: string; current_month_rcpt_outly_amt: string }[])
      .map((r) => [r.record_date, parseFloat(r.current_month_rcpt_outly_amt) / 1e9])
  );

  const rows = monthEnds.map((me) => {
    const v = byDate.get(me);
    if (v == null) throw new Error(`mtsFiscalData: no net-interest row found for ${me}`);
    return { date: me, valueB: v };
  });

  return { rows, netInterestB: rows.reduce((s, r) => s + r.valueB, 0), windowStart, windowEnd };
}

// Average daily debt held by the public over [windowStart, windowEnd] (inclusive),
// pulled by date filter rather than a fixed row count (holds across weekends/
// holidays and calendar-length differences between months).
export async function fetchDebtHeldPublicTrailing12Avg(windowStart: string, windowEnd: string): Promise<{
  avgB: number;
  dailyRows: { date: string; valueB: number }[];
}> {
  const url = `${FISCAL_DATA}/v2/accounting/od/debt_to_penny?filter=record_date:gte:${windowStart},record_date:lte:${windowEnd}&sort=-record_date&page[size]=400&fields=record_date,debt_held_public_amt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mtsFiscalData: debt_to_penny trailing-12 fetch failed: HTTP ${res.status}`);
  const j = await res.json();
  const dailyRows = (j.data as { record_date: string; debt_held_public_amt: string }[])
    .map((r) => ({ date: r.record_date, valueB: parseFloat(r.debt_held_public_amt) / 1e9 }))
    .filter((r) => !isNaN(r.valueB));
  if (dailyRows.length === 0) throw new Error(`mtsFiscalData: no debt_to_penny rows in [${windowStart}, ${windowEnd}]`);
  return { avgB: dailyRows.reduce((s, r) => s + r.valueB, 0) / dailyRows.length, dailyRows };
}

// Latest single debt_to_penny reading (for Debt Added and r_eff convergence-gap style cards).
export async function fetchDebtHeldPublicLatest(): Promise<{ date: string; grossB: number; heldByPublicB: number }> {
  const url = `${FISCAL_DATA}/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=1&fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mtsFiscalData: debt_to_penny latest fetch failed: HTTP ${res.status}`);
  const j = await res.json();
  const r = (j.data as { record_date: string; tot_pub_debt_out_amt: string; debt_held_public_amt: string }[])[0];
  if (!r) throw new Error("mtsFiscalData: debt_to_penny returned no rows");
  return { date: r.record_date, grossB: parseFloat(r.tot_pub_debt_out_amt) / 1e9, heldByPublicB: parseFloat(r.debt_held_public_amt) / 1e9 };
}

// Debt added over the trailing N days, pulled by date filter (not row count) so
// weekends/holidays with no new record never shrink the window.
export async function fetchDebtAddedTrailing(days: number): Promise<{
  addedB: number; startDate: string; endDate: string; startB: number; endB: number;
}> {
  const endRes = await fetchDebtHeldPublicLatest();
  const endDate = endRes.date;
  const startCutoff = new Date(endDate + "T00:00:00Z");
  startCutoff.setUTCDate(startCutoff.getUTCDate() - days);
  const startCutoffStr = startCutoff.toISOString().slice(0, 10);

  const url = `${FISCAL_DATA}/v2/accounting/od/debt_to_penny?filter=record_date:lte:${startCutoffStr}&sort=-record_date&page[size]=1&fields=record_date,tot_pub_debt_out_amt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mtsFiscalData: debt_to_penny trailing-window start fetch failed: HTTP ${res.status}`);
  const j = await res.json();
  const startRow = (j.data as { record_date: string; tot_pub_debt_out_amt: string }[])[0];
  if (!startRow) throw new Error(`mtsFiscalData: no debt_to_penny row on or before ${startCutoffStr}`);

  const startB = parseFloat(startRow.tot_pub_debt_out_amt) / 1e9;
  return { addedB: endRes.grossB - startB, startDate: startRow.record_date, endDate, startB, endB: endRes.grossB };
}

// Trailing-4-quarter NOMINAL GDP in actual annual dollars (not the SAAR rate
// FRED's `GDP` series itself reports) — sum of each quarter's SAAR value / 4.
// Shared (not reimplemented per-file) so every "% of GDP" ratio in Phase 2
// (deficit, net interest) divides by the exact same figure; FRED-sourced, not
// Treasury, but kept here since both current consumers (2a, 2b) also pull
// from this module and need the same quarters their MTS trailing-12 window
// covers.
export async function fetchTrailingNominalGdp4Q(fredApiKey: string, asOf: Date = new Date()): Promise<{
  gdpB: number;
  quarters: { quarter: string; saarB: number }[];
}> {
  // v2 Phase 5: was `sort_order=desc&limit=6` with NO date bound on the
  // fetch itself -- correct for asOf=now (the 4 needed quarters are always
  // in "the latest 6"), but the exact same silent-for-historical-asOf bug
  // fetchMtsNetInterestTrailing12 had: for any asOf more than ~1.5 years in
  // the past, "the latest 6" from TODAY doesn't contain any quarter <=
  // asOf at all, so the old post-fetch `.filter(o => o.quarter <= asOf)`
  // could leave zero usable quarters and throw. `observation_end` bounds
  // the FETCH itself to asOf, matching the pattern fetch-macro-data's own
  // output_gap case already uses for the same reason.
  const asOfStr = asOf.toISOString().slice(0, 10);
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=GDP&api_key=${fredApiKey}&sort_order=desc&observation_end=${asOfStr}&limit=6&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mtsFiscalData: FRED GDP fetch failed: HTTP ${res.status}`);
  const j = await res.json();
  const obs = (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ quarter: o.date, saarB: parseFloat(o.value) }))
    .filter((o) => !isNaN(o.saarB));
  const usable = obs.slice(0, 4);
  if (usable.length < 4) throw new Error(`mtsFiscalData: fewer than 4 usable nominal-GDP quarters as of ${asOf.toISOString()}`);
  return { gdpB: usable.reduce((s, o) => s + o.saarB, 0) / 4, quarters: usable };
}

// Throws if the given windows don't share the same end date — the spec's
// "period mismatch" guard for any ratio whose numerator and denominator must
// cover the same trailing-12-month period (e.g. net interest / receipts).
export function assertPeriodAligned(windows: { label: string; windowStart: string; windowEnd: string }[]): void {
  if (windows.length < 2) return;
  const [first, ...rest] = windows;
  for (const w of rest) {
    if (w.windowStart !== first.windowStart || w.windowEnd !== first.windowEnd) {
      throw new Error(
        `period mismatch: "${first.label}" covers [${first.windowStart}, ${first.windowEnd}] but ` +
        `"${w.label}" covers [${w.windowStart}, ${w.windowEnd}]`
      );
    }
  }
}
