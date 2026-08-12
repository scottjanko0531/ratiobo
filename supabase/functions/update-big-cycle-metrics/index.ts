import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

async function computeFredUpdates(): Promise<Update[]> {
  const updates: Update[] = [];

  const debtGdp = await fredLatest("GFDEGDQ188S");
  if (debtGdp) updates.push({
    key: "debt_to_gdp", value_numeric: debtGdp.value, value_display: pct1(debtGdp.value),
    status: debtGdp.value > 120 ? "bad" : debtGdp.value > 90 ? "warn" : "good",
    status_label: debtGdp.value > 120 ? "Elevated" : debtGdp.value > 90 ? "Rising" : "Sustainable",
  });

  const [fedFundsUpper, fedFundsLower] = await Promise.all([fredLatest("DFEDTARU"), fredLatest("DFEDTARL")]);
  if (fedFundsUpper && fedFundsLower) {
    const mid = (fedFundsUpper.value + fedFundsLower.value) / 2;
    updates.push({
      key: "fed_funds_rate", value_numeric: mid,
      value_display: `${fedFundsLower.value.toFixed(2)}–${fedFundsUpper.value.toFixed(2)}%`,
      note_suffix: `Fed funds target range; effective rate is typically near the midpoint (~${mid.toFixed(2)}%).`,
      status: "good", status_label: "MP1 intact",
    });
  } else if (fedFundsUpper) {
    updates.push({ key: "fed_funds_rate", value_numeric: fedFundsUpper.value, value_display: pct1(fedFundsUpper.value) });
  }

  const deficit = await fredLatest("FYFSGDA188S");
  if (deficit) {
    const mag = Math.abs(deficit.value);
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

  return updates;
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: metrics, error: mErr } = await sb
      .from("big_cycle_metrics")
      .select("id,key,refresh_method,fred_series_id")
      .in("refresh_method", ["api_fred", "api_treasury", "api_imf", "api_cofer", "csv_voteview"]);
    if (mErr || !metrics) return json({ error: mErr?.message ?? "no metrics" }, 500);
    const byKey = new Map((metrics as MetricRow[]).map((m) => [m.key, m]));

    const [fredUpdates, treasuryUpdate, imfUpdate, coferUpdate, voteviewUpdate] = await Promise.all([
      computeFredUpdates(),
      computeTreasuryUpdate(),
      computeImfUpdate(),
      computeCoferUpdate(sb),
      computeVoteviewUpdate(),
    ]);
    const allUpdates = [...fredUpdates, treasuryUpdate, imfUpdate, coferUpdate, voteviewUpdate].filter((u): u is Update => u != null);

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

    return json({ updated, skipped, total: allUpdates.length, timestamp: now });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
