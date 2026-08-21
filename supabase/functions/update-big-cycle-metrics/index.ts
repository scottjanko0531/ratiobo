import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY = Deno.env.get("FRED_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface MetricRow {
  id: string; key: string; refresh_method: string; fred_series_id: string | null;
}

interface Update {
  key: string;
  value_numeric: number;
  value_display: string;
  status?: "good" | "warn" | "bad" | null;
  status_label?: string | null;
  note_suffix?: string; // appended context, e.g. "as of 2026 Q2"
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function fredLatest(seriesId: string): Promise<{ value: number; date: string } | null> {
  try {
    const res = await fetch(`${FRED}?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`);
    if (!res.ok) return null;
    const j = await res.json();
    const obs = j.observations?.[0];
    const v = obs ? parseFloat(obs.value) : NaN;
    return obs && !isNaN(v) ? { value: v, date: obs.date } : null;
  } catch { return null; }
}

const pct1 = (v: number) => `${v.toFixed(1)}%`;

interface FredUpdatesResult {
  updates: Update[];
  fedFundsMid: number | null;
  deficitAbs: number | null;
}

async function computeFredUpdates(): Promise<FredUpdatesResult> {
  const updates: Update[] = [];
  let fedFundsMid: number | null = null;
  let deficitAbs: number | null = null;

  // debt_to_gdp is cross-referenced from the Macro dashboard's Layer 1 (total
  // nonfinancial debt, not just federal) — see computeMacroCrossRefUpdates.

  const [fedFundsUpper, fedFundsLower] = await Promise.all([fredLatest("DFEDTARU"), fredLatest("DFEDTARL")]);
  if (fedFundsUpper && fedFundsLower) {
    const mid = (fedFundsUpper.value + fedFundsLower.value) / 2;
    fedFundsMid = mid;
    updates.push({
      key: "fed_funds_rate", value_numeric: mid,
      value_display: `${fedFundsLower.value.toFixed(2)}–${fedFundsUpper.value.toFixed(2)}%`,
      note_suffix: `Fed funds target range; effective rate is typically near the midpoint (~${mid.toFixed(2)}%).`,
      status: "good", status_label: "MP1 intact",
    });
  } else if (fedFundsUpper) {
    fedFundsMid = fedFundsUpper.value;
    updates.push({ key: "fed_funds_rate", value_numeric: fedFundsUpper.value, value_display: pct1(fedFundsUpper.value) });
  }

  const deficit = await fredLatest("FYFSGDA188S");
  if (deficit) {
    const mag = Math.abs(deficit.value);
    deficitAbs = mag;
    updates.push({
      key: "deficit_pct_gdp", value_numeric: mag, value_display: pct1(mag),
      note_suffix: `Federal deficit as % of GDP (annual). FRED series is signed; displayed here as positive magnitude.`,
      status: mag > 6 ? "bad" : mag > 3 ? "warn" : "good",
      status_label: mag > 6 ? "Wide" : mag > 3 ? "Structural" : "Contained",
    });
  }

  const top1 = await fredLatest("WFRBST01134");
  if (top1) updates.push({
    key: "top1_wealth_share", value_numeric: top1.value, value_display: pct1(top1.value),
    status: top1.value > 35 ? "bad" : top1.value > 28 ? "warn" : "good",
    status_label: top1.value > 35 ? "Wide" : top1.value > 28 ? "Elevated" : "Moderate",
  });

  const [interest, defense] = await Promise.all([fredLatest("A091RC1Q027SBEA"), fredLatest("FDEFX")]);
  if (interest && defense && defense.value > 0) {
    const ratio = (interest.value / defense.value) * 100;
    const fmtT = (v: number) => `$${(v / 1000).toFixed(2)}T`;
    updates.push({
      key: "interest_vs_defense", value_numeric: ratio, value_display: `${fmtT(interest.value)} vs ${fmtT(defense.value)}`,
      note_suffix: `Interest on federal debt vs. defense spending (SAAR). Interest overtook defense in FY2024 and the gap is widening.`,
      status: ratio > 100 ? "bad" : ratio > 70 ? "warn" : "good",
      status_label: ratio > 100 ? "Crossed over" : ratio > 70 ? "Approaching defense spending" : "Below defense spending",
    });
  }

  // home_price_income_ratio is manual (Redfin-sourced) — FRED has no equivalent series
  // for the existing-home-price methodology Redfin uses, so this is hand-entered.

  return { updates, fedFundsMid, deficitAbs };
}

// Redfin's public Data Center publishes a genuine national-level file (not just
// metro-level) — small enough (~1.3MB decompressed, ~1900 rows) to fetch and parse
// directly, no streaming/aggregation needed. This is the same underlying source
// Redfin's own affordability figures are built from, unlike FRED's MSPUS (new homes
// only) or Zillow's ZHVI (a smoothed "typical value" index, not a straight median).
// It still won't exactly reproduce Redfin's own published ratio, which pairs against
// a median *family* income series, not Census household income.
async function computeRedfinHomePriceUpdate(): Promise<Update | null> {
  try {
    const res = await fetch(
      "https://redfin-public-data.s3-us-west-2.amazonaws.com/redfin_market_tracker/us_national_market_tracker.tsv000.gz",
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok || !res.body) return null;

    const decompressed = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const lines = decompressed.split("\n");
    const header = lines[0].split("\t").map((s) => s.replace(/^"|"$/g, ""));
    const iPeriodEnd = header.indexOf("PERIOD_END");
    const iPropType = header.indexOf("PROPERTY_TYPE");
    const iSA = header.indexOf("IS_SEASONALLY_ADJUSTED");
    const iPrice = header.indexOf("MEDIAN_SALE_PRICE");
    if ([iPeriodEnd, iPropType, iSA, iPrice].some((i) => i === -1)) return null;

    let latestPeriod = "";
    let latestPrice: number | null = null;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = lines[i].split("\t");
      if (cols[iPropType]?.replace(/"/g, "") !== "All Residential") continue;
      if (cols[iSA]?.replace(/"/g, "") !== "false") continue; // raw, not seasonally adjusted — matches how Redfin quotes its headline median
      const period = cols[iPeriodEnd]?.replace(/"/g, "");
      const price = parseFloat(cols[iPrice]);
      if (!period || !isFinite(price)) continue;
      if (period > latestPeriod) { latestPeriod = period; latestPrice = price; }
    }
    if (latestPrice == null) return null;

    const income = await fredLatest("MEHOINUSA646N");
    if (!income) return null;
    const ratio = latestPrice / income.value;

    return {
      key: "home_price_income_ratio", value_numeric: ratio, value_display: `${ratio.toFixed(2)}x`,
      note_suffix: `National median sale price ($${Math.round(latestPrice).toLocaleString()}, period ending ${latestPeriod}) from Redfin's public national-level data, divided by Census median household income ($${income.value.toLocaleString()}, ${income.date}). Approximates but won't exactly match Redfin's own published affordability ratio, which uses a median family income denominator instead of household income.`,
      status: ratio > 5.5 ? "bad" : ratio > 4.5 ? "warn" : "good",
      status_label: ratio > 5.5 ? "Stretched" : ratio > 4.5 ? "Elevated" : "Historically normal",
    };
  } catch (e) { console.error("[big-cycle] redfin home price:", e); return null; }
}

// NY Fed publishes the Household Debt and Credit Report's full underlying data as a
// plain xlsx at a predictable per-quarter URL — no auth, no scraping. "Page 12 Data"
// is "Percent of Balance 90+ Days Delinquent by Loan Type", with a STUDENT LOAN
// column; this is the exact series the dashboard's figure was originally sourced
// from by hand (confirmed: Q2 2026 = 10.6%, an exact match to the prior manual entry).
// Reports publish ~6-8 weeks after quarter-end, so this tries the current calendar
// quarter first and steps back up to 3 quarters until a file actually resolves.
async function computeNyFedStudentLoanUpdate(): Promise<Update | null> {
  const now = new Date();
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1; // 1-4

  for (let attempt = 0; attempt < 4; attempt++) {
    const url = `https://www.newyorkfed.org/medialibrary/interactives/householdcredit/data/xls/HHD_C_Report_${y}Q${q}.xlsx`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://www.newyorkfed.org/microeconomics/hhdc",
          "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
        },
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const ws = wb.Sheets["Page 12 Data"];
        if (!ws) { q--; if (q < 1) { q = 4; y--; } continue; }
        const data = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });

        let studentCol = -1;
        for (const row of data) {
          const idx = (row as unknown[]).findIndex((c) => typeof c === "string" && c.trim().toUpperCase() === "STUDENT LOAN");
          if (idx !== -1) { studentCol = idx; break; }
        }
        if (studentCol === -1) return null;

        // Last row matching a "YY:QN" quarter label in column 0 is the latest observation.
        let latestLabel: string | null = null;
        let latestVal: number | null = null;
        for (const row of data) {
          const r = row as unknown[];
          const label = r[0];
          if (typeof label !== "string" || !/^\d{2}:Q[1-4]$/.test(label)) continue;
          const v = Number(r[studentCol]);
          if (!isFinite(v)) continue;
          latestLabel = label; latestVal = v;
        }
        if (latestVal == null) return null;

        const rounded = Math.round(latestVal * 10) / 10;
        return {
          key: "student_loan_delinquency", value_numeric: rounded, value_display: `${rounded.toFixed(1)}%`,
          note_suffix: `Percent of balance 90+ days delinquent, student loans (${latestLabel}). NY Fed Consumer Credit Panel/Equifax, Quarterly Report on Household Debt and Credit.`,
          status: rounded > 12 ? "bad" : rounded > 8 ? "warn" : "good",
          status_label: rounded > 12 ? "Elevated" : rounded > 8 ? "Rebounded post-forbearance" : "Contained",
        };
      }
    } catch (e) { console.error(`[big-cycle] nyfed student loan (${y}Q${q}):`, e); }
    q--; if (q < 1) { q = 4; y--; }
  }
  return null;
}

async function computeTreasuryUpdate(): Promise<Update | null> {
  try {
    // Treasury publishes on business days only — 22 records ≈ one calendar month.
    const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=22";
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const rows = (j.data ?? []) as { record_date: string; tot_pub_debt_out_amt: string }[];
    if (rows.length < 2) return null;
    const latest = parseFloat(rows[0].tot_pub_debt_out_amt);
    const monthAgo = parseFloat(rows[rows.length - 1].tot_pub_debt_out_amt);
    if (isNaN(latest) || isNaN(monthAgo)) return null;
    const added = latest - monthAgo;
    const addedB = added / 1e9;
    return {
      key: "debt_added_period", value_numeric: addedB, value_display: `$${addedB >= 0 ? "+" : ""}${addedB.toFixed(0)}B`,
      note_suffix: `${rows[rows.length - 1].record_date} → ${rows[0].record_date}. Total debt: $${(latest / 1e12).toFixed(2)}T.`,
    };
  } catch { return null; }
}

async function computeImfUpdate(): Promise<Update | null> {
  try {
    // Nominal GDP share (not PPP-adjusted) — matches Dalio's "share of world GDP" framing.
    // NGDPD/WEOWORLD is IMF's own world-aggregate pseudo-country code.
    const res = await fetch("https://www.imf.org/external/datamapper/api/v1/NGDPD/USA/WEOWORLD");
    if (!res.ok) return null;
    const j = await res.json();
    const usa = j?.values?.NGDPD?.USA as Record<string, number> | undefined;
    const world = j?.values?.NGDPD?.WEOWORLD as Record<string, number> | undefined;
    if (!usa || !world) return null;
    // IMF WEO includes forward-looking projection years; cap at the current year so
    // this never cites a future-year forecast as if it were an observed figure.
    const currentYear = new Date().getUTCFullYear();
    const years = Object.keys(usa).map(Number).filter((y) => y <= currentYear && world[String(y)] != null).sort((a, b) => b - a);
    if (!years.length) return null;
    const y = years[0];
    const share = (usa[String(y)] / world[String(y)]) * 100;
    return {
      key: "gdp_share_world", value_numeric: share, value_display: pct1(share),
      note_suffix: `${y} figure, nominal GDP basis (IMF WEO; recent years may be IMF estimates, not final actuals).`,
      status: "good", status_label: "Leading",
    };
  } catch { return null; }
}

async function computeCoferUpdate(sb: ReturnType<typeof createClient>): Promise<Update | null> {
  try {
    const { data } = await sb
      .from("fx_reserves_observations")
      .select("period_year,period_quarter,share_pct")
      .eq("currency_code", "USD")
      .order("period_year", { ascending: false })
      .order("period_quarter", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.share_pct) return null;
    const v = Number(data.share_pct);
    return {
      key: "usd_reserve_share", value_numeric: v, value_display: pct1(v),
      note_suffix: `${data.period_year} Q${data.period_quarter} (IMF COFER, via RatioBo's existing pipeline).`,
      status: v > 60 ? "good" : v > 50 ? "warn" : "bad",
      status_label: v > 60 ? "Dominant" : v > 50 ? "Eroding" : "Challenged",
    };
  } catch { return null; }
}

async function computeVoteviewUpdate(): Promise<Update | null> {
  try {
    const res = await fetch("https://voteview.com/static/data/out/members/HSall_members.csv");
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split("\n");
    const header = lines[0].split(",");
    const idx = (name: string) => header.indexOf(name);
    const iCongress = idx("congress"), iChamber = idx("chamber"), iParty = idx("party_code"), iDim1 = idx("nominate_dim1");
    if ([iCongress, iChamber, iParty, iDim1].some((i) => i === -1)) return null;

    // Simple CSV split — bioname field contains commas but is quoted; skip lines that fail to parse cleanly.
    const parseLine = (line: string): string[] | null => {
      const out: string[] = [];
      let cur = "", inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inQuotes = !inQuotes;
        else if (c === "," && !inQuotes) { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur);
      return out;
    };

    let maxCongress = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = parseLine(lines[i]);
      if (!cols) continue;
      const c = parseInt(cols[iCongress], 10);
      if (!isNaN(c) && c > maxCongress) maxCongress = c;
    }
    if (!maxCongress) return null;

    // House only — Senate has a different size/institutional dynamic, and Voteview's
    // own published polarization series reports the two chambers separately.
    let demSum = 0, demN = 0, repSum = 0, repN = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = parseLine(lines[i]);
      if (!cols) continue;
      const c = parseInt(cols[iCongress], 10);
      if (c !== maxCongress) continue;
      if (cols[iChamber] !== "House") continue;
      const party = cols[iParty];
      const dim1 = parseFloat(cols[iDim1]);
      if (isNaN(dim1)) continue;
      if (party === "100") { demSum += dim1; demN++; }
      else if (party === "200") { repSum += dim1; repN++; }
    }
    if (demN === 0 || repN === 0) return null;
    const demMean = demSum / demN, repMean = repSum / repN;
    const polarization = Math.abs(repMean - demMean);
    return {
      key: "elite_polarization", value_numeric: polarization, value_display: polarization.toFixed(3),
      note_suffix: `Congress ${maxCongress}: mean DW-NOMINATE dim1 distance between House Democrats (n=${demN}) and Republicans (n=${repN}). Includes anyone who served during this Congress, so counts can exceed 435 with mid-term replacements.`,
    };
  } catch { return null; }
}

// Cross-references the Macro dashboard's Layer 1 ("Long-term Debt Cycle") indicators
// and Dalio gauge composites instead of re-deriving them from FRED independently —
// keeps Big Cycle's debt panel consistent with /macro rather than a parallel,
// narrower slice of the same underlying data.
const MACRO_STATUS_MAP: Record<string, "good" | "warn" | "bad"> = { healthy: "good", watch: "warn", danger: "bad" };

async function computeMacroCrossRefUpdates(sb: ReturnType<typeof createClient>): Promise<Update[]> {
  const updates: Update[] = [];
  try {
    const { data } = await sb
      .from("macro_indicators")
      .select("name, current_value, status")
      .in("name", ["Total Debt / GDP", "Fed Balance Sheet % GDP", "Rate vs. GDP Growth Spread", "Fed SOMA Long-Duration Holdings (Δ)", "Foreign Official Share of UST Holdings (YoY Δ)", "Treasury Convenience Yield (10Y)", "Foreign Official Custody Holdings", "Interest Expense % of Federal Revenue", "Treasury Bid-to-Cover", "Indirect Bidder Share (10Y/30Y)"]);
    const byName = new Map((data ?? []).map((r: { name: string }) => [r.name, r]));

    const totalDebt = byName.get("Total Debt / GDP") as { current_value: number; status: string } | undefined;
    if (totalDebt?.current_value != null) {
      const v = Number(totalDebt.current_value);
      const status = MACRO_STATUS_MAP[totalDebt.status] ?? null;
      updates.push({
        key: "debt_to_gdp", value_numeric: v, value_display: pct1(v),
        status, status_label: status === "bad" ? "High" : status === "warn" ? "Elevated" : "Sustainable",
        note_suffix: "Total nonfinancial debt (household + corporate + government) as % of GDP — matches Dalio's aggregate-debt framing. Cross-referenced from the Macro dashboard's Long-Term Debt Cycle layer, not re-derived here.",
      });
    }

    const walcl = byName.get("Fed Balance Sheet % GDP") as { current_value: number; status: string } | undefined;
    if (walcl?.current_value != null) {
      const v = Number(walcl.current_value);
      const status = MACRO_STATUS_MAP[walcl.status] ?? null;
      updates.push({
        key: "fed_balance_sheet_gdp", value_numeric: v, value_display: pct1(v),
        status, status_label: status === "bad" ? "MP2 — QE-driven" : status === "warn" ? "Watch" : "MP1 — no active QE",
        note_suffix: "Fed total assets as % of GDP — the direct empirical signal for whether QE (MP2) is active, i.e. the evidence behind the debt-cycle stage call above. Cross-referenced from Macro.",
      });
    }

    const rg = byName.get("Rate vs. GDP Growth Spread") as { current_value: number; status: string } | undefined;
    if (rg?.current_value != null) {
      const v = Number(rg.current_value);
      const status = MACRO_STATUS_MAP[rg.status] ?? null;
      updates.push({
        key: "rate_growth_spread", value_numeric: v, value_display: pct1(v),
        status, status_label: status === "bad" ? "r > g — unsustainable trajectory" : status === "warn" ? "r ≈ g — borderline" : "r < g — sustainable",
        note_suffix: "10Y Treasury yield minus real GDP growth (r−g) — the classic debt-sustainability test. Cross-referenced from Macro.",
      });
    }

    const somaDuration = byName.get("Fed SOMA Long-Duration Holdings (Δ)") as { current_value: number; status: string } | undefined;
    if (somaDuration?.current_value != null) {
      const v = Number(somaDuration.current_value);
      const status = MACRO_STATUS_MAP[somaDuration.status] ?? null;
      updates.push({
        key: "soma_long_duration_delta", value_numeric: v, value_display: `${v >= 0 ? "+" : ""}$${v.toFixed(1)}B`,
        status, status_label: status === "bad" ? "Absorbing duration" : status === "warn" ? "Watch" : "No absorption",
        note_suffix: "Weekly change in Fed SOMA Treasury holdings, 5Y+ remaining maturity — a composition signal distinct from the balance-sheet-size test above; not yet used to classify the MP-stage itself, since a single week's reading isn't a trend. Cross-referenced from Macro.",
      });
    }

    const ticOfficial = byName.get("Foreign Official Share of UST Holdings (YoY Δ)") as { current_value: number; status: string } | undefined;
    if (ticOfficial?.current_value != null) {
      const v = Number(ticOfficial.current_value);
      const status = MACRO_STATUS_MAP[ticOfficial.status] ?? null;
      updates.push({
        key: "tic_foreign_official_share_yoy", value_numeric: v, value_display: `${v >= 0 ? "+" : ""}${v.toFixed(2)}pts`,
        status, status_label: status === "bad" ? "Official retreat" : status === "warn" ? "Watch" : "Stable",
        note_suffix: "12-month change in foreign central banks' share of total foreign-held US Treasuries (Treasury TIC data) — a declining official share means private buyers, the Fed (QE), or banks (regulatory pressure) must absorb more of the slack; not yet used to classify the MP-stage itself. Cross-referenced from Macro.",
      });
    }

    const convenienceYield = byName.get("Treasury Convenience Yield (10Y)") as { current_value: number; status: string } | undefined;
    if (convenienceYield?.current_value != null) {
      const v = Number(convenienceYield.current_value);
      const status = MACRO_STATUS_MAP[convenienceYield.status] ?? null;
      updates.push({
        key: "convenience_yield_10y", value_numeric: v, value_display: `${v >= 0 ? "+" : ""}${v.toFixed(1)}bp`,
        status, status_label: status === "bad" ? "Subsidy inverted" : status === "warn" ? "Watch" : "Privilege intact",
        note_suffix: "10Y SOFR swap rate minus 10Y Treasury yield — the market-priced nonpecuniary premium the world pays to hold Treasuries; positive means the US borrows below the true risk-free rate, negative means the subsidy has inverted. Not yet used to classify the MP-stage itself — this is a single market price, not yet a validated trend. Cross-referenced from Macro's Sovereign Risk panel.",
      });
    }

    const custody = byName.get("Foreign Official Custody Holdings") as { current_value: number; status: string } | undefined;
    if (custody?.current_value != null) {
      const v = Number(custody.current_value);
      const status = MACRO_STATUS_MAP[custody.status] ?? null;
      updates.push({
        key: "foreign_custody_holdings", value_numeric: v, value_display: `${v >= 0 ? "+" : ""}$${v.toFixed(0)}B`,
        status, status_label: status === "bad" ? "Custody falling" : status === "warn" ? "Watch" : "Custody stable/rising",
        note_suffix: "52-week change in marketable Treasuries held in custody at the NY Fed for foreign official accounts — a weekly, ~1-day-lag leading indicator for the Foreign Official Share of UST Holdings card above, which runs on TIC data with a ~2-month lag. Does not tie to that card's level (custody covers only FRBNY-held securities); track the trend, not the level. Cross-referenced from Macro.",
      });
    }

    // The three classic Dalio big-debt-cycle monitors: (1) debt service vs.
    // revenue — "plaque in the circulatory system"; (2) auction supply vs.
    // demand — "plaque breaking off"; (3) the Fed printing to cover the
    // shortfall — already covered above via fed_balance_sheet_gdp /
    // soma_long_duration_delta. All three now sit explicitly on this panel
    // instead of #1 and #2 being inferred from adjacent proxies.
    const interestRevenue = byName.get("Interest Expense % of Federal Revenue") as { current_value: number; status: string } | undefined;
    if (interestRevenue?.current_value != null) {
      const v = Number(interestRevenue.current_value);
      const status = MACRO_STATUS_MAP[interestRevenue.status] ?? null;
      updates.push({
        key: "interest_expense_revenue_pct", value_numeric: v, value_display: pct1(v),
        status, status_label: status === "bad" ? "Debt service straining revenue" : status === "warn" ? "Watch" : "Manageable",
        note_suffix: "Federal interest payments as % of federal tax receipts — Dalio's debt-service-relative-to-revenue test (\"plaque in the circulatory system\"): how much of what the government collects is already spoken for by servicing debt already issued. Cross-referenced from Macro.",
      });
    }

    const bidToCover = byName.get("Treasury Bid-to-Cover") as { current_value: number; status: string } | undefined;
    if (bidToCover?.current_value != null) {
      const v = Number(bidToCover.current_value);
      const status = MACRO_STATUS_MAP[bidToCover.status] ?? null;
      updates.push({
        key: "treasury_bid_to_cover", value_numeric: v, value_display: v.toFixed(2),
        status, status_label: status === "bad" ? "Weak demand" : status === "warn" ? "Watch" : "Adequate demand",
        note_suffix: "10-Year Treasury auction bid-to-cover ratio — direct read on demand for new government debt relative to the amount being sold. Dalio's \"selling vs. demand\" test (\"plaque breaking off\"). Cross-referenced from Macro.",
      });
    }

    const indirectBidder = byName.get("Indirect Bidder Share (10Y/30Y)") as { current_value: number; status: string } | undefined;
    if (indirectBidder?.current_value != null) {
      const v = Number(indirectBidder.current_value);
      const status = MACRO_STATUS_MAP[indirectBidder.status] ?? null;
      updates.push({
        key: "indirect_bidder_share", value_numeric: v, value_display: `${v.toFixed(1)}%`,
        status, status_label: status === "bad" ? "Dealers absorbing supply" : status === "warn" ? "Watch" : "Price-insensitive demand holding",
        note_suffix: "Trailing 6-auction average share of accepted bids from indirect bidders on 10Y/30Y Treasury auctions — the standard proxy for foreign official and price-insensitive demand; a falling share means primary dealers must absorb more supply. Cross-referenced from Macro.",
      });
    }

    const { data: gaugeRow } = await sb
      .from("dalio_gauge_readings")
      .select("year, gauge1, gauge5, gauge7")
      .order("year", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (gaugeRow) {
      const g1 = gaugeRow.gauge1 != null ? Number(gaugeRow.gauge1) : null;
      const g5 = gaugeRow.gauge5 != null ? Number(gaugeRow.gauge5) : null;
      const g7 = gaugeRow.gauge7 != null ? Number(gaugeRow.gauge7) : null;
      // Mirrors the exact band thresholds/labels from debtSustAssessment() and
      // reserveConfAssessment() in components/DalioGauges.jsx — must stay in sync
      // with that file so the same z-score never shows two different verdicts.
      const debtSustAssessment = (g: number) => {
        if (g > 2.0) return { status: "bad" as const, label: "Critical Risk" };
        if (g > 1.5) return { status: "bad" as const, label: "Elevated Risk" };
        if (g > 1.0) return { status: "bad" as const, label: "Elevated — Watch" };
        if (g > 0.0) return { status: "warn" as const, label: "Mild Pressure" };
        return { status: "good" as const, label: "Sustainable" };
      };
      const reserveConfAssessment = (g: number) => {
        if (g > 1.5) return { status: "bad" as const, label: "Critical" };
        if (g > 1.0) return { status: "bad" as const, label: "Elevated Risk" };
        if (g > 0.25) return { status: "warn" as const, label: "Watch" };
        if (g > -0.25) return { status: "good" as const, label: "Neutral" };
        return { status: "good" as const, label: "Low Risk" };
      };
      // Mirrors privilegeErosionAssessment() in components/DalioGauges.jsx —
      // same reasoning as the two assessments above: keep in sync so the same
      // z-score never shows two different verdicts across pages.
      const privilegeErosionAssessment = (g: number) => {
        if (g > 1.5) return { status: "bad" as const, label: "Critical" };
        if (g > 1.0) return { status: "bad" as const, label: "Elevated Risk" };
        if (g > 0.25) return { status: "warn" as const, label: "Watch" };
        if (g > -0.25) return { status: "good" as const, label: "Neutral" };
        return { status: "good" as const, label: "Low Risk" };
      };
      if (g1 != null) {
        const a = debtSustAssessment(g1);
        updates.push({
          key: "debt_sustainability_gauge", value_numeric: g1, value_display: `${g1 >= 0 ? "+" : ""}${g1.toFixed(2)}`,
          status: a.status, status_label: a.label,
          note_suffix: `${gaugeRow.year} composite z-score (debt-to-GDP + debt-to-income gap, annual). See Macro dashboard, Gauge 1 — Debt Sustainability Risk.`,
        });
      }
      if (g5 != null) {
        const a = reserveConfAssessment(g5);
        updates.push({
          key: "reserve_confidence_gauge", value_numeric: g5, value_display: `${g5 >= 0 ? "+" : ""}${g5.toFixed(2)}`,
          status: a.status, status_label: a.label,
          note_suffix: `${gaugeRow.year} composite z-score (CB gold buying + declining USD reserve share, annual). See Macro dashboard, Gauge 5 — Reserve Confidence Risk.`,
        });
      }
      if (g7 != null) {
        const a = privilegeErosionAssessment(g7);
        updates.push({
          key: "privilege_erosion_gauge", value_numeric: g7, value_display: `${g7 >= 0 ? "+" : ""}${g7.toFixed(2)}`,
          status: a.status, status_label: a.label,
          note_suffix: `${gaugeRow.year} grouped composite z-score (convenience yield + foreign demand + gold/real-yield regime tell, updated daily). See Macro dashboard, Gauge 7 — Privilege Erosion.`,
        });
      }
    }
  } catch (e) { console.error("[big-cycle] macro cross-ref:", e); }
  return updates;
}

const DEBT_CYCLE_ID = "da204e3f-ae22-47dd-95bb-2844d4f75685";

// Classifies the debt cycle's current stage (MP1 / MP1 (strained) / MP2 / MP3) from live
// data instead of a fixed editorial flag. Criteria per Dalio's Principles for Navigating
// Big Debt Crises, with "MP1 (strained)" as an interim marker for the late-MP1 phase:
//   MP1              — rates well above zero; deficit not structurally elevated; r <= g.
//   MP1 (strained)    — rates still well above zero (MP1's tool still works), but the
//                        deficit is elevated even without a recession, and/or r > g —
//                        i.e. fiscal dominance building before the tool runs out.
//   MP2               — rates at/near the zero lower bound — conventional rate cuts are
//                        exhausted, forcing QE (balance-sheet expansion) as the tool.
//   MP3               — MP2 conditions (near-zero rates) plus a large, sustained Fed
//                        balance-sheet footprint AND a very large deficit — the proxy for
//                        QE no longer reaching the real economy, forcing direct monetary-
//                        fiscal coordination. This is inherently an approximation: MP3 is
//                        a policy-regime call (yield-curve control, direct deficit
//                        financing), not something four thresholds can fully capture.
function classifyDebtCycleStage(
  fedFundsMid: number, walclPctGdp: number, deficitAbs: number, rateGrowthSpread: number,
): string {
  const nearZero = fedFundsMid < 0.5;
  const qeFootprintHigh = walclPctGdp >= 30;
  const deficitElevated = deficitAbs >= 4;
  const rGreaterG = rateGrowthSpread >= 2;

  if (nearZero && qeFootprintHigh && deficitElevated) return "MP3";
  if (nearZero) return "MP2";
  if (deficitElevated || rGreaterG) return "MP1 (strained)";
  return "MP1";
}

async function updateDebtCycleStage(
  sb: ReturnType<typeof createClient>, fedFundsMid: number | null, deficitAbs: number | null,
): Promise<{ stage: string; inputs: Record<string, number> } | null> {
  try {
    if (fedFundsMid == null || deficitAbs == null) return null;
    const { data: macroRows } = await sb
      .from("macro_indicators")
      .select("name, current_value")
      .in("name", ["Fed Balance Sheet % GDP", "Rate vs. GDP Growth Spread"]);
    const byName = new Map((macroRows ?? []).map((r: { name: string; current_value: number }) => [r.name, Number(r.current_value)]));
    const walcl = byName.get("Fed Balance Sheet % GDP");
    const rateGrowthSpread = byName.get("Rate vs. GDP Growth Spread");
    if (walcl == null || rateGrowthSpread == null) return null;

    const stage = classifyDebtCycleStage(fedFundsMid, walcl, deficitAbs, rateGrowthSpread);

    await sb.from("big_cycle_stages").update({ is_current: false }).eq("cycle_id", DEBT_CYCLE_ID);
    const { error } = await sb.from("big_cycle_stages").update({ is_current: true }).eq("cycle_id", DEBT_CYCLE_ID).eq("label", stage);
    if (error) { console.error("[big-cycle] stage write:", error); return null; }

    return { stage, inputs: { fedFundsMid, walclPctGdp: walcl, deficitAbs, rateGrowthSpread } };
  } catch (e) { console.error("[big-cycle] stage classification:", e); return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: metrics, error: mErr } = await sb
      .from("big_cycle_metrics")
      .select("id,key,refresh_method,fred_series_id")
      .in("refresh_method", ["api_fred", "api_treasury", "api_imf", "api_cofer", "csv_voteview", "api_macro_xref", "api_redfin", "api_nyfed"]);
    if (mErr || !metrics) return json({ error: mErr?.message ?? "no metrics" }, 500);
    const byKey = new Map((metrics as MetricRow[]).map((m) => [m.key, m]));

    const [fredResult, treasuryUpdate, imfUpdate, coferUpdate, voteviewUpdate, macroXrefUpdates, redfinUpdate, nyFedUpdate] = await Promise.all([
      computeFredUpdates(),
      computeTreasuryUpdate(),
      computeImfUpdate(),
      computeCoferUpdate(sb),
      computeVoteviewUpdate(),
      computeMacroCrossRefUpdates(sb),
      computeRedfinHomePriceUpdate(),
      computeNyFedStudentLoanUpdate(),
    ]);
    const allUpdates = [...fredResult.updates, treasuryUpdate, imfUpdate, coferUpdate, voteviewUpdate, ...macroXrefUpdates, redfinUpdate, nyFedUpdate].filter((u): u is Update => u != null);
    const stageResult = await updateDebtCycleStage(sb, fredResult.fedFundsMid, fredResult.deficitAbs);

    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    let updated = 0;
    const skipped: string[] = [];

    for (const u of allUpdates) {
      const metric = byKey.get(u.key);
      if (!metric) { skipped.push(u.key); continue; }

      const noteAppend = u.note_suffix ? { note: u.note_suffix } : {};
      const { error: updErr } = await sb.from("big_cycle_metrics").update({
        value_numeric: u.value_numeric, value_display: u.value_display,
        ...(u.status !== undefined ? { status: u.status, status_label: u.status_label ?? null } : {}),
        ...noteAppend,
        last_updated: now,
      }).eq("id", metric.id);
      if (updErr) { console.error(`[big-cycle] update ${u.key}:`, updErr); skipped.push(u.key); continue; }

      await sb.from("big_cycle_snapshots").upsert({
        metric_id: metric.id, value_numeric: u.value_numeric, recorded_at: today,
      }, { onConflict: "metric_id,recorded_at" });

      updated++;
    }

    // Propagate live metrics into their corresponding determinant row's reading_text
    // (strength_pct/status on those rows are fixed editorial scores, not touched here).
    const determinantSync: { metricKey: string; determinantName: string }[] = [
      { metricKey: "gdp_share_world", determinantName: "Economic Output" },
    ];
    for (const { metricKey, determinantName } of determinantSync) {
      const u = allUpdates.find((x) => x.key === metricKey);
      if (!u) continue;
      await sb.from("big_cycle_determinants").update({
        reading_text: `${u.value_display}${u.note_suffix ? ` — ${u.note_suffix}` : ""}`,
      }).eq("name", determinantName);
    }

    return json({ updated, skipped, total: allUpdates.length, debtCycleStage: stageResult, timestamp: now });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
