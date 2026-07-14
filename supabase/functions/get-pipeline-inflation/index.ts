import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const KEY = Deno.env.get("FRED_API_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchMonthly(series: string, limit = 87): Promise<{ date: string; value: number }[]> {
  const url = `${FRED}?series_id=${series}&api_key=${KEY}&sort_order=desc&limit=${limit}&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${series}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "" && !isNaN(parseFloat(o.value)))
    .map((o) => ({ date: o.date.slice(0, 7), value: parseFloat(o.value) }))
    .reverse();
}

async function fetchAsMonthly(series: string, limit = 87): Promise<{ date: string; value: number }[]> {
  const url = `${FRED}?series_id=${series}&api_key=${KEY}&sort_order=desc&limit=${limit}&file_type=json&frequency=m&aggregation_method=avg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${series}: HTTP ${res.status}`);
  const j = await res.json();
  return (j.observations as { date: string; value: string }[])
    .filter((o) => o.value !== "." && o.value !== "" && !isNaN(parseFloat(o.value)))
    .map((o) => ({ date: o.date.slice(0, 7), value: parseFloat(o.value) }))
    .reverse();
}

function pct(now: number | null, prev: number | null): number | null {
  if (now == null || prev == null || prev === 0) return null;
  return Math.round(((now / prev - 1) * 100) * 100) / 100;
}

function scoreChange(change: number | null, posT: number, negT: number): -1 | 0 | 1 {
  if (change == null) return 0;
  return change >= posT ? 1 : change <= negT ? -1 : 0;
}

// Z-score of the most recent 3M % change vs the full historical distribution of 3M % changes.
// Uses calendar date lookup (same logic as change3m) to handle gaps in monthly series.
function computeZScore(obs: { date: string; value: number }[]): number | null {
  const byDate = Object.fromEntries(obs.map((o) => [o.date, o.value]));
  const changes: number[] = [];
  for (const o of obs) {
    const d = new Date(o.date + "-01");
    const m3 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1)).toISOString().slice(0, 7);
    const prev = byDate[m3];
    if (prev != null && prev !== 0) changes.push((o.value / prev - 1) * 100);
  }
  if (changes.length < 12) return null;
  const current = changes[changes.length - 1];
  const mean = changes.reduce((s, v) => s + v, 0) / changes.length;
  const std = Math.sqrt(changes.reduce((s, v) => s + (v - mean) ** 2, 0) / changes.length);
  if (std < 0.001) return null;
  return Math.round(((current - mean) / std) * 100) / 100;
}

const COMPONENTS = [
  { key: "crude",  series: "PPIACO",     name: "PPI All Commodities", unit: "index",   posT: 3,   negT: -3,   daily: false },
  { key: "ppi",    series: "PPIFID",     name: "PPI Final Demand",    unit: "index",   posT: 0.5, negT: -0.5, daily: false },
  { key: "wti",    series: "DCOILWTICO", name: "WTI Crude Oil",       unit: "$/bbl",   posT: 5,   negT: -5,   daily: true  },
  { key: "copper", series: "PCOPPUSDM",  name: "Copper",              unit: "$/mt",    posT: 5,   negT: -5,   daily: false },
  { key: "natgas", series: "MHHNGSP",    name: "Natural Gas",         unit: "$/MMBtu", posT: 10,  negT: -10,  daily: true  },
] as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const obsArrays = await Promise.all(
      COMPONENTS.map((c) => c.daily ? fetchAsMonthly(c.series) : fetchMonthly(c.series))
    );
    const maps = obsArrays.map((obs) => Object.fromEntries(obs.map((o) => [o.date, o.value])));
    const backbone = obsArrays[0]; // PPIACO as timeline backbone

    type HistRow = { month: string; composite: number; [k: string]: number | string };
    const history: HistRow[] = [];

    for (let i = 3; i < backbone.length; i++) {
      const month = backbone[i].date;
      const d = new Date(month + "-01");
      const d3 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1));
      const m3 = d3.toISOString().slice(0, 7);

      const row: HistRow = { month, composite: 0 };
      let sum = 0;
      COMPONENTS.forEach((comp, idx) => {
        const now = maps[idx][month] ?? null;
        const prev = maps[idx][m3] ?? null;
        const s: number = scoreChange(pct(now, prev), comp.posT, comp.negT);
        row[comp.key] = s;
        sum += s;
      });
      row.composite = sum;
      history.push(row);
    }

    if (!history.length) throw new Error("No history");

    const latest = history[history.length - 1];
    const month = latest.month;
    const d = new Date(month + "-01");
    const m3 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1)).toISOString().slice(0, 7);

    const components = COMPONENTS.map((comp, idx) => {
      const now = maps[idx][month] ?? null;
      const prev = maps[idx][m3] ?? null;
      const change = pct(now, prev);
      const score = scoreChange(change, comp.posT, comp.negT);
      const zScore = computeZScore(obsArrays[idx]);
      return {
        key: comp.key,
        name: comp.name,
        unit: comp.unit,
        current: now != null ? Math.round(now * 100) / 100 : null,
        change3m: change,
        score,
        posT: comp.posT,
        negT: comp.negT,
        zScore,
      };
    });

    const composite = latest.composite as number;
    const label =
      composite >= 3 ? "Building" :
      composite >= 1 ? "Mild Pressure" :
      composite <= -3 ? "Strongly Easing" :
      composite <= -1 ? "Easing" : "Neutral";

    return new Response(JSON.stringify({
      asOf: month,
      composite,
      label,
      components,
      history: history.slice(-24),
    }), { headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
