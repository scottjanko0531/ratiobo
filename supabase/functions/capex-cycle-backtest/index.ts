import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Historical verification for the AI Capex Cycle Overlay.
// Stateless: pulls FRED directly and returns a JSON report (writes nothing).
//
// Question: in past tech-capex cycles, what happened to equities after economy-wide
// IT investment growth rolled over? Uses BEA private fixed investment in information
// processing equipment + software (quarterly, 1947+) and the NASDAQ Composite (1971+).
//
// Tests:
//  A. Episode table: every NASDAQ bear (>= 30% drawdown) vs the nearest prior IT-capex
//     growth peak and level peak, with lead/lag in months.
//  B. Trigger test: the overlay's capex_decel rule (YoY growth down >10pp over 2 quarters),
//     evaluated with a 120-day publication lag, vs forward 12m NASDAQ return and max
//     drawdown, compared with the unconditional baseline.
//  C. Intensity test: IT investment share of GDP at a 10y z-score > 1 vs forward outcomes.

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
type Obs = { date: string; value: number };
const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const r2 = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const monthsBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / (DAY * 30.44));

async function fred(id: string, cosd: string): Promise<Obs[]> {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`);
    if (!res.ok) continue;
    const t = await res.text();
    return t.trim().split("\n").slice(1).map((l) => l.split(",")).filter(([d, v]) => d && isFinite(parseFloat(v)))
      .map(([d, v]) => ({ date: d, value: parseFloat(v) }));
  }
  throw new Error(`FRED ${id} failed`);
}

function idxAtOrBefore(a: Obs[], d: string) {
  let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].date <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

// forward 12m return and max drawdown (from the start date's close) of a daily/monthly series
function forward12(px: Obs[], d: string) {
  const i = idxAtOrBefore(px, d);
  if (i < 0) return null;
  const end = addDays(d, 365);
  if (px[px.length - 1].date < end) return null;
  const j = idxAtOrBefore(px, end);
  let minV = px[i].value;
  for (let k = i; k <= j; k++) minV = Math.min(minV, px[k].value);
  return { ret: (px[j].value / px[i].value - 1) * 100, mdd: (minV / px[i].value - 1) * 100 };
}

function summarize(rows: { ret: number; mdd: number }[]) {
  if (!rows.length) return { n: 0 };
  return {
    n: rows.length,
    avg_fwd12m_return_pct: r2(mean(rows.map((r) => r.ret))),
    median_fwd12m_return_pct: r2([...rows.map((r) => r.ret)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]),
    avg_fwd12m_max_drawdown_pct: r2(mean(rows.map((r) => r.mdd))),
    pct_with_drawdown_ge_20: r2(100 * rows.filter((r) => r.mdd <= -20).length / rows.length),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const [equip, soft, gdp, nasdaqDaily] = await Promise.all([
      fred("Y033RC1Q027SBEA", "1965-01-01"), fred("B985RC1Q027SBEA", "1965-01-01"),
      fred("GDP", "1965-01-01"), fred("NASDAQCOM", "1971-01-01"),
    ]);
    // month-end NASDAQ
    const byM = new Map<string, Obs>();
    for (const o of nasdaqDaily) byM.set(o.date.slice(0, 7), o);
    const ndx = [...byM.values()].sort((a, b) => a.date.localeCompare(b.date));

    // quarterly IT investment (equipment + software), YoY growth, 2q change, share of GDP
    const sMap = new Map(soft.map((o) => [o.date, o.value]));
    const gMap = new Map(gdp.map((o) => [o.date, o.value]));
    const it = equip.filter((o) => sMap.has(o.date) && gMap.has(o.date))
      .map((o) => ({ date: o.date, level: o.value + sMap.get(o.date)!, share: (o.value + sMap.get(o.date)!) / gMap.get(o.date)! * 100 }));
    const q = it.map((o, i) => {
      const yoy = i >= 4 ? (o.level / it[i - 4].level - 1) * 100 : null;
      return { ...o, yoy };
    }).map((o, i, arr) => ({ ...o, chg2q: i >= 2 && o.yoy != null && arr[i - 2].yoy != null ? o.yoy - (arr[i - 2].yoy as number) : null }));
    // publication date: FRED dates quarters at quarter start; BEA advance estimate ~30d after quarter end
    const avail = (d: string) => addDays(d, 92 + 30); // quarter end + ~30d advance GDP release

    // A. NASDAQ bears >= 30%: find peak -> trough episodes
    const bears: { peak: string; peakV: number; trough: string; troughV: number }[] = [];
    let peakI = 0, inBear = false, troughI = 0;
    for (let i = 1; i < ndx.length; i++) {
      if (!inBear) {
        if (ndx[i].value > ndx[peakI].value) peakI = i;
        else if (ndx[i].value / ndx[peakI].value - 1 <= -0.30) { inBear = true; troughI = i; }
      } else {
        if (ndx[i].value < ndx[troughI].value) troughI = i;
        if (ndx[i].value >= ndx[peakI].value) {
          bears.push({ peak: ndx[peakI].date, peakV: ndx[peakI].value, trough: ndx[troughI].date, troughV: ndx[troughI].value });
          inBear = false; peakI = i;
        }
      }
    }
    if (inBear) bears.push({ peak: ndx[peakI].date, peakV: ndx[peakI].value, trough: ndx[troughI].date, troughV: ndx[troughI].value });

    // local peaks of IT capex YoY growth (max within +/- 4 quarters, growth > 5%)
    const growthPeaks = q.filter((o, i) => o.yoy != null && o.yoy > 5 &&
      q.slice(Math.max(0, i - 4), i + 5).every((x) => x.yoy == null || x.yoy <= (o.yoy as number))).map((o) => o.date);
    const levelPeaks = q.filter((o, i) => i + 1 < q.length && q.slice(Math.max(0, i - 6), i + 7).every((x) => x.level <= o.level) &&
      q.slice(i + 1, i + 7).some((x) => x.level < o.level * 0.97)).map((o) => o.date);

    const episodes = bears.map((b) => {
      const gp = growthPeaks.filter((d) => d <= addDays(b.peak, 400)).at(-1) ?? null; // allow growth peak up to ~1y after equity peak
      const lp = levelPeaks.filter((d) => d <= addDays(b.peak, 800) && d >= addDays(b.peak, -800)).at(-1) ?? null;
      const qi = q.findIndex((x) => x.date === (gp ?? ""));
      return {
        nasdaq_peak: b.peak, nasdaq_trough: b.trough, drawdown_pct: r2((b.troughV / b.peakV - 1) * 100),
        months_peak_to_trough: monthsBetween(b.peak, b.trough),
        it_growth_peak_quarter: gp, it_growth_at_peak_pct: qi >= 0 ? r2(q[qi].yoy) : null,
        months_growth_peak_to_equity_peak: gp ? monthsBetween(addDays(gp, 45), b.peak) : null,
        it_level_peak_quarter: lp, months_equity_peak_to_level_peak: lp ? monthsBetween(b.peak, addDays(lp, 45)) : null,
      };
    });

    // B. capex_decel trigger (as the overlay defines it), first-fire dates with 12m cooldown
    const trig = q.filter((o) => o.chg2q != null && o.chg2q < -10);
    const fires: string[] = [];
    for (const o of trig) { const a = avail(o.date); if (!fires.length || Date.parse(a) - Date.parse(fires.at(-1)!) > 365 * DAY) fires.push(a); }
    const trigRows = fires.map((d) => ({ date: d, f: forward12(ndx, d) })).filter((x) => x.f);
    const allQ = q.filter((o) => o.date >= "1971-06-01").map((o) => forward12(ndx, avail(o.date))).filter(Boolean) as { ret: number; mdd: number }[];

    // C. intensity: share-of-GDP 10y z-score > 1 (quarterly observations)
    const intRows: { ret: number; mdd: number }[] = [];
    const intHits: string[] = [];
    for (let i = 40; i < q.length; i++) {
      const win = q.slice(i - 39, i + 1).map((x) => x.share);
      const z = (q[i].share - mean(win)) / std(win);
      if (z > 1) { const f = forward12(ndx, avail(q[i].date)); if (f) { intRows.push(f); intHits.push(q[i].date); } }
    }
    // D. combo: intensity high AND decel (the "turn" condition)
    const comboRows: { ret: number; mdd: number }[] = [];
    const comboHits: string[] = [];
    for (let i = 40; i < q.length; i++) {
      const win = q.slice(i - 39, i + 1).map((x) => x.share);
      const z = (q[i].share - mean(win)) / std(win);
      if (z > 0.5 && q[i].chg2q != null && (q[i].chg2q as number) < -5) {
        const f = forward12(ndx, avail(q[i].date)); if (f) { comboRows.push(f); comboHits.push(q[i].date); }
      }
    }

    const latest = q.at(-1)!;
    return new Response(JSON.stringify({
      data: { it_quarters: q.length, first: q[0].date, last: latest.date, nasdaq_months: ndx.length },
      current: { quarter: latest.date, it_invest_bn: r2(latest.level), yoy_pct: r2(latest.yoy), chg2q_pp: r2(latest.chg2q), share_gdp_pct: r2(latest.share) },
      A_episodes: episodes,
      B_capex_decel_trigger: {
        rule: "IT investment YoY growth down >10pp over 2 quarters; dated at quarter end + 30d; 12m cooldown",
        fire_dates: fires, after_fire: summarize(trigRows.map((x) => x.f!)), unconditional: summarize(allQ),
      },
      C_intensity_high: { rule: "IT share of GDP 10y z > 1", n_quarters: intHits.length, first_last: [intHits[0], intHits.at(-1)], after: summarize(intRows) },
      D_turn_combo: { rule: "IT share z > 0.5 AND growth down >5pp over 2q", hits: comboHits, after: summarize(comboRows) },
      growth_peaks: growthPeaks, level_peaks: levelPeaks,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
