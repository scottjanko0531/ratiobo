"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Shell from "../../../components/Shell";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { REGIME_META, GROWTH_MIN_GAP, CPI_MIN_GAP } from "../../../lib/simulatorKeys";

// Joint Growth x Inflation quadrant, same mapping used by the Structural
// Regime drawer on the main Macro page — kept in sync by hand since this is
// a separate route, not a shared import, to avoid exporting an internal
// helper off page.jsx just for one reuse.
function regimeQuadrantKey(g, i) {
  if (g === "accelerating" && i === "accelerating") return "rg_ri";
  if (g === "accelerating" && i === "decelerating") return "rg_fi";
  if (g === "decelerating" && i === "accelerating") return "fg_ri";
  return "fg_fi";
}
const GRID_LETTER = { rg_fi: "G", rg_ri: "R", fg_ri: "I", fg_fi: "D" };
const GRID_CELL_CLASS = {
  rg_fi: "bg-gain/15 text-gain",
  rg_ri: "bg-brass/15 text-brass-soft",
  fg_ri: "bg-loss/15 text-loss",
  fg_fi: "bg-paper-dim/10 text-paper-dim",
};

const NEAR_ZERO_ACTUAL = 0.1; // pp — same floor used everywhere else on this page
const ROW_H = "h-7"; // shared row height between the fixed label column and the scrolling data grid

// Same flat/level-anchored reconstruction used by the CPI/GDP drawers'
// "Ratiobo Forecast" column (ratioboForecastFor in page.jsx): the forecast
// for any period is just the fast (crossover) line's value one horizon
// length earlier — no separate fetch or model needed, it's already in the
// same rows array. Extended here with a flat forward projection (same
// principle already used for the Structural Regime drawer's Q+2/Q+3 rows)
// so the grid can show a forward-looking horizon, not just resolved history.
function buildSeriesReconstruction(sourceRows, minGap, horizonMonths, stepMonths, forwardSteps) {
  const sorted = (sourceRows ?? []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const byDate = new Map(sorted.map((r) => [r.date, r]));
  const out = [];
  for (const row of sorted) {
    const d = new Date(row.date + "T00:00:00Z");
    const issueDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - horizonMonths, 1)).toISOString().slice(0, 10);
    const issueRow = byDate.get(issueDate);
    if (!issueRow || issueRow.fast == null || issueRow.slow == null) continue;
    const gap = issueRow.fast - issueRow.slow;
    const state = Math.abs(gap) <= minGap ? "persistence" : gap > 0 ? "accelerating" : "decelerating";
    const forecastValue = issueRow.fast;
    let hit = null, valueAcc = null;
    if (row.actual != null) {
      const delta = row.actual - forecastValue;
      hit = state === "persistence" ? Math.abs(delta) <= minGap : state === "accelerating" ? delta > minGap : delta < -minGap;
      valueAcc = Math.abs(delta);
    }
    out.push({ date: row.date, actual: row.actual, forecastValue, state, hit, valueAcc, forward: false });
  }
  const lastValid = sorted.slice().reverse().find((r) => r.fast != null && r.slow != null);
  if (lastValid) {
    const gap = lastValid.fast - lastValid.slow;
    const state = Math.abs(gap) <= minGap ? "persistence" : gap > 0 ? "accelerating" : "decelerating";
    const d = new Date(lastValid.date + "T00:00:00Z");
    for (let s = 1; s <= forwardSteps; s++) {
      const targetDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + horizonMonths + stepMonths * (s - 1), 1)).toISOString().slice(0, 10);
      if (out.some((o) => o.date === targetDate)) continue;
      out.push({ date: targetDate, actual: null, forecastValue: lastValid.fast, state, hit: null, valueAcc: null, forward: true });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Prior Qtr / YTD / Last 4 Qtr / All Time bucketing — identical pattern to
// the one shipped on the GDP/CPI/Regime drawers (see page.jsx), anchored on
// the latest COMPLETED (resolved) period rather than today's calendar date.
function summarizeValueWindows(scored) {
  if (!scored.length) return false;
  const latestDate = scored.reduce((max, x) => (x.date > max ? x.date : max), scored[0].date);
  const anchor = new Date(latestDate + "T00:00:00Z");
  const qStartMonth = Math.floor(anchor.getUTCMonth() / 3) * 3;
  const currQStart = new Date(Date.UTC(anchor.getUTCFullYear(), qStartMonth, 1)).toISOString().slice(0, 10);
  const priorQStart = new Date(Date.UTC(anchor.getUTCFullYear(), qStartMonth - 3, 1)).toISOString().slice(0, 10);
  const yearStart = `${anchor.getUTCFullYear()}-01-01`;
  const last4QStart = new Date(Date.UTC(anchor.getUTCFullYear(), qStartMonth - 12, 1)).toISOString().slice(0, 10);
  const windows = {
    "Prior Qtr": scored.filter((x) => x.date >= priorQStart && x.date < currQStart),
    "YTD": scored.filter((x) => x.date >= yearStart),
    "Last 4 Qtr": scored.filter((x) => x.date >= last4QStart && x.date < currQStart),
    "All Time": scored,
  };
  const summarize = (arr) => {
    if (arr.length === 0) return { n: 0, accuracyPct: null, directionalHitRate: null };
    const pctErrs = arr.map((x) => (Math.abs(x.actual) < NEAR_ZERO_ACTUAL ? 0 : (x.valueAcc / Math.abs(x.actual)) * 100));
    const accuracyPct = Math.round((100 - pctErrs.reduce((a, b) => a + b, 0) / pctErrs.length) * 10) / 10;
    const hits = arr.filter((x) => x.hit === true).length;
    return { n: arr.length, accuracyPct, directionalHitRate: Math.round((hits / arr.length) * 1000) / 10 };
  };
  return Object.fromEntries(Object.entries(windows).map(([label, arr]) => [label, summarize(arr)]));
}

function summarizeHitWindows(scored) {
  if (!scored.length) return false;
  const latestDate = scored.reduce((max, x) => (x.date > max ? x.date : max), scored[0].date);
  const anchor = new Date(latestDate + "T00:00:00Z");
  const qStartMonth = Math.floor(anchor.getUTCMonth() / 3) * 3;
  const currQStart = new Date(Date.UTC(anchor.getUTCFullYear(), qStartMonth, 1)).toISOString().slice(0, 10);
  const priorQStart = new Date(Date.UTC(anchor.getUTCFullYear(), qStartMonth - 3, 1)).toISOString().slice(0, 10);
  const yearStart = `${anchor.getUTCFullYear()}-01-01`;
  const last4QStart = new Date(Date.UTC(anchor.getUTCFullYear(), qStartMonth - 12, 1)).toISOString().slice(0, 10);
  const windows = {
    "Prior Qtr": scored.filter((x) => x.date >= priorQStart && x.date < currQStart),
    "YTD": scored.filter((x) => x.date >= yearStart),
    "Last 4 Qtr": scored.filter((x) => x.date >= last4QStart && x.date < currQStart),
    "All Time": scored,
  };
  return Object.fromEntries(Object.entries(windows).map(([label, arr]) => {
    if (arr.length === 0) return [label, { n: 0, accuracyPct: null }];
    const hits = arr.filter((r) => r.hit === true).length;
    return [label, { n: arr.length, accuracyPct: Math.round((hits / arr.length) * 1000) / 10 }];
  }));
}

function quarterStartOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const qMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), qMonth, 1)).toISOString().slice(0, 10);
}

function monthLabel(dateStr) {
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function AccuracyCard({ title, windows }) {
  return (
    <div className="card p-4 space-y-2">
      <p className="label text-[10px]">{title}</p>
      {windows === false ? (
        <p className="text-paper-dim text-[10px]">Not enough resolved periods yet.</p>
      ) : (
        <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-[10px] items-center">
          <span />
          <span className="text-paper-dim uppercase tracking-wide">Accuracy</span>
          {["Prior Qtr", "YTD", "Last 4 Qtr", "All Time"].map((label) => {
            const w = windows[label];
            return (
              <Fragment key={label}>
                <span className="text-paper-dim">{label}</span>
                <span className="num text-paper">{w.n === 0 ? "—" : `${w.accuracyPct.toFixed(1)}% (n=${w.n})`}</span>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function GridModelPage() {
  const [gdpRows, setGdpRows] = useState(null);
  const [cpiRows, setCpiRows] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-gdp-crossover-history`).then((r) => r.json()),
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-cpi-crossover-history`).then((r) => r.json()),
    ])
      .then(([g, c]) => {
        setGdpRows(Array.isArray(g) ? g : []);
        setCpiRows(Array.isArray(c) ? c : []);
      })
      .catch(() => { setGdpRows([]); setCpiRows([]); });
  }, []);

  const gdpRecon = useMemo(() => (gdpRows ? buildSeriesReconstruction(gdpRows, GROWTH_MIN_GAP, 3, 3, 4) : []), [gdpRows]);
  const cpiRecon = useMemo(() => (cpiRows ? buildSeriesReconstruction(cpiRows, CPI_MIN_GAP, 3, 1, 12) : []), [cpiRows]);

  // Joint regime reconstruction — same 3-case logic (both real / both
  // Persistence carry-forward / mixed near-side lean) validated on the
  // Structural Regime drawer, ported here since this route doesn't share
  // component state with page.jsx. Forward-projects Q+1..Q+4 flat from the
  // latest issue date, one quarter further than the drawer's Q+1..Q+3 so
  // the grid's forward columns reach a full 12 months out, matching GDP's
  // own forward horizon on this page.
  const regimeRecon = useMemo(() => {
    if (!gdpRows || !cpiRows || !gdpRows.length) return [];
    const sortedGdp = gdpRows.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const cpiByDate = new Map(cpiRows.map((r) => [r.date, r]));
    const stateOf = (gap, minGap) => (Math.abs(gap) <= minGap ? "persistence" : gap > 0 ? "accelerating" : "decelerating");
    const nearSideOf = (gap) => (gap > 0 ? "accelerating" : "decelerating");
    const gdpByDate = new Map(sortedGdp.map((r) => [r.date, r]));

    let lastConfirmed = null;
    let latestIssueDate = null, latestForecastKey = null;
    const out = [];
    for (const g of sortedGdp) {
      const c = cpiByDate.get(g.date);
      if (!c || g.fast == null || g.slow == null || c.fast == null || c.slow == null) continue;

      const gGap = g.fast - g.slow, iGap = c.fast - c.slow;
      const gState = stateOf(gGap, GROWTH_MIN_GAP), iState = stateOf(iGap, CPI_MIN_GAP);
      let forecastKey;
      if (gState !== "persistence" && iState !== "persistence") {
        forecastKey = regimeQuadrantKey(gState, iState);
      } else if (gState === "persistence" && iState === "persistence") {
        forecastKey = lastConfirmed;
      } else {
        const gLean = gState === "persistence" ? nearSideOf(gGap) : gState;
        const iLean = iState === "persistence" ? nearSideOf(iGap) : iState;
        forecastKey = regimeQuadrantKey(gLean, iLean);
      }
      latestIssueDate = g.date;
      latestForecastKey = forecastKey;

      const d = new Date(g.date + "T00:00:00Z");
      const targetDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)).toISOString().slice(0, 10);
      const gTarget = gdpByDate.get(targetDate);
      const cTarget = cpiByDate.get(targetDate);

      let actualKey = null, hit = null;
      if (gTarget?.actual != null && cTarget?.actual != null) {
        const gDelta = gTarget.actual - g.fast, iDelta = cTarget.actual - c.fast;
        const gDir = Math.abs(gDelta) > GROWTH_MIN_GAP ? (gDelta > 0 ? "accelerating" : "decelerating") : "flat";
        const iDir = Math.abs(iDelta) > CPI_MIN_GAP ? (iDelta > 0 ? "accelerating" : "decelerating") : "flat";
        if (gDir !== "flat" && iDir !== "flat") {
          actualKey = regimeQuadrantKey(gDir, iDir);
          lastConfirmed = actualKey;
        } else {
          actualKey = lastConfirmed;
        }
        hit = forecastKey != null && actualKey != null ? forecastKey === actualKey : null;
      }
      out.push({ date: targetDate, forecastKey, actualKey, hit, forward: false });
    }
    if (latestIssueDate && latestForecastKey != null) {
      const d = new Date(latestIssueDate + "T00:00:00Z");
      for (const h of [1, 2, 3, 4]) {
        const targetDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + h * 3, 1)).toISOString().slice(0, 10);
        if (out.some((o) => o.date === targetDate)) continue;
        out.push({ date: targetDate, forecastKey: latestForecastKey, actualKey: null, hit: null, forward: true });
      }
    }
    return out.filter((r) => r.hit !== null || r.forecastKey != null).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [gdpRows, cpiRows]);

  const gdpByQuarter = useMemo(() => new Map(gdpRecon.map((r) => [r.date, r])), [gdpRecon]);
  const cpiByMonth = useMemo(() => new Map(cpiRecon.map((r) => [r.date, r])), [cpiRecon]);
  const regimeByQuarter = useMemo(() => new Map(regimeRecon.map((r) => [r.date, r])), [regimeRecon]);

  // 24 months of history + 12 months forward, anchored on the latest month
  // with a resolved CPI actual (CPI is the highest-cadence series tracked
  // here, so its latest print is the closest thing to "today" the grid has).
  const columns = useMemo(() => {
    const resolved = cpiRecon.filter((r) => r.actual != null).map((r) => r.date).sort();
    const anchorDate = resolved.length ? resolved[resolved.length - 1] : null;
    if (!anchorDate) return [];
    const [ay, am] = anchorDate.split("-").map(Number);
    const cols = [];
    for (let i = -23; i <= 12; i++) {
      cols.push(new Date(Date.UTC(ay, am - 1 + i, 1)).toISOString().slice(0, 10));
    }
    return cols;
  }, [cpiRecon]);

  const gdpWindows = useMemo(() => summarizeValueWindows(gdpRecon.filter((r) => r.actual != null && r.valueAcc != null)), [gdpRecon]);
  const cpiWindows = useMemo(() => summarizeValueWindows(cpiRecon.filter((r) => r.actual != null && r.valueAcc != null)), [cpiRecon]);
  const regimeWindows = useMemo(() => summarizeHitWindows(regimeRecon.filter((r) => r.hit !== null)), [regimeRecon]);

  const loading = gdpRows === null || cpiRows === null;

  // Same 24mo-back / 12mo-forward window as the grid table above — the full
  // reconstructed history goes back decades (CPI to 1958, GDP to 1991),
  // which would swamp the chart and make the recent/forward detail this
  // page is actually about unreadable.
  const chartFrom = columns.length ? columns[0] : null;
  const chartTo = columns.length ? columns[columns.length - 1] : null;
  const gdpChartData = useMemo(
    () => (chartFrom ? gdpRecon.filter((r) => r.date >= quarterStartOf(chartFrom) && r.date <= chartTo).map((r) => ({ date: r.date, actual: r.actual, forecast: r.forecastValue })) : []),
    [gdpRecon, chartFrom, chartTo]
  );
  const cpiChartData = useMemo(
    () => (chartFrom ? cpiRecon.filter((r) => r.date >= chartFrom && r.date <= chartTo).map((r) => ({ date: r.date, actual: r.actual, forecast: r.forecastValue })) : []),
    [cpiRecon, chartFrom, chartTo]
  );

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-3">
        <div>
          <Link href="/macro" className="label text-[10px] hover:text-brass-soft transition-colors">&larr; Macro Dashboard</Link>
          <h1 className="text-xl font-semibold tracking-tight mt-1">GRID Model</h1>
          <p className="text-paper-dim text-sm mt-0.5">Growth &amp; Regime Indicator Dashboard — Ratiobo&rsquo;s forecast vs actual for the Structural Regime, GDP and CPI, one horizontal timeline.</p>
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <AccuracyCard title="Regime Forecast Accuracy" windows={regimeWindows} />
            <AccuracyCard title="GDP YoY Forecast Accuracy" windows={gdpWindows} />
            <AccuracyCard title="CPI YoY Forecast Accuracy" windows={cpiWindows} />
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="label text-[10px]">24 months history &middot; 12 months forward (italic = Ratiobo forward projection, flat-forecast design)</p>
              <div className="flex items-center gap-4 text-[10px] text-paper-dim">
                {Object.entries(GRID_LETTER).map(([key, letter]) => (
                  <span key={key} className="flex items-center gap-1">
                    <span className={`inline-flex items-center justify-center w-4 h-4 rounded-sm font-semibold ${GRID_CELL_CLASS[key]}`}>{letter}</span>
                    {REGIME_META[key].label}
                  </span>
                ))}
              </div>
            </div>
            {/* Two-pane layout (fixed label column + independently
               horizontally-scrolling data grid) rather than a single grid
               with a `sticky left-0` label column — CSS `position: sticky`
               on a grid item does not reliably re-pin during horizontal
               scroll of a `overflow-x-auto` ancestor in this table's grid
               structure, verified by hand: the label column scrolled away
               with the rest of the row instead of staying put. Row heights
               are kept in lockstep between the two panes via ROW_H on every
               row in both. */}
            <div className="flex">
              <div className="shrink-0 w-32">
                <div className={ROW_H} />
                <div className={`${ROW_H} px-2 flex items-center text-[10px] text-paper-dim border-b border-ink-line/50`}>Regime (Actual)</div>
                <div className={`${ROW_H} px-2 flex items-center text-[10px] text-paper-dim border-b border-ink-line/50`}>Regime (Ratiobo)</div>
                <div className={`${ROW_H} px-2 flex items-center text-[10px] text-paper-dim border-b border-ink-line/50`}>Real GDP YoY (Actual)</div>
                <div className={`${ROW_H} px-2 flex items-center text-[10px] text-paper-dim border-b border-ink-line/50`}>Real GDP YoY (Ratiobo)</div>
                <div className={`${ROW_H} px-2 flex items-center text-[10px] text-paper-dim border-b border-ink-line/50`}>CPI YoY (Actual)</div>
                <div className={`${ROW_H} px-2 flex items-center text-[10px] text-paper-dim border-b border-ink-line/50`}>CPI YoY (Ratiobo)</div>
              </div>
              <div className="overflow-x-auto flex-1">
                <div className="grid" style={{ gridTemplateColumns: `repeat(${columns.length}, 3.75rem)` }}>
                  {columns.map((col) => (
                    <div key={col} className={`${ROW_H} flex items-center justify-center text-[9px] text-paper-dim border-b border-ink-line whitespace-nowrap`}>
                      {monthLabel(col)}
                    </div>
                  ))}

                  {columns.map((col) => {
                    const r = regimeByQuarter.get(quarterStartOf(col));
                    const key = r?.actualKey ?? null;
                    return (
                      <div key={col} className={`${ROW_H} flex items-center justify-center text-[10px] font-semibold border-b border-ink-line/50 ${key ? GRID_CELL_CLASS[key] : "text-paper-dim"}`}>
                        {key ? GRID_LETTER[key] : (r?.hit === null && r ? "·" : "")}
                      </div>
                    );
                  })}

                  {columns.map((col) => {
                    const r = regimeByQuarter.get(quarterStartOf(col));
                    const key = r?.forecastKey ?? null;
                    return (
                      <div key={col} className={`${ROW_H} flex items-center justify-center text-[10px] font-semibold border-b border-ink-line/50 ${key ? GRID_CELL_CLASS[key] : "text-paper-dim"} ${r?.forward ? "italic opacity-80" : ""}`}>
                        {key ? GRID_LETTER[key] : ""}
                      </div>
                    );
                  })}

                  {columns.map((col) => {
                    const r = gdpByQuarter.get(quarterStartOf(col));
                    return (
                      <div key={col} className={`${ROW_H} flex items-center justify-center text-[10px] text-paper num border-b border-ink-line/50`}>
                        {r?.actual != null ? `${r.actual.toFixed(1)}%` : ""}
                      </div>
                    );
                  })}

                  {columns.map((col) => {
                    const r = gdpByQuarter.get(quarterStartOf(col));
                    return (
                      <div key={col} className={`${ROW_H} flex items-center justify-center text-[10px] text-brass-soft num border-b border-ink-line/50 ${r?.forward ? "italic opacity-80" : ""}`}>
                        {r?.forecastValue != null ? `${r.forecastValue.toFixed(1)}%` : ""}
                      </div>
                    );
                  })}

                  {columns.map((col) => {
                    const r = cpiByMonth.get(col);
                    return (
                      <div key={col} className={`${ROW_H} flex items-center justify-center text-[10px] text-paper num border-b border-ink-line/50`}>
                        {r?.actual != null ? `${r.actual.toFixed(1)}%` : ""}
                      </div>
                    );
                  })}

                  {columns.map((col) => {
                    const r = cpiByMonth.get(col);
                    return (
                      <div key={col} className={`${ROW_H} flex items-center justify-center text-[10px] text-brass-soft num border-b border-ink-line/50 ${r?.forward ? "italic opacity-80" : ""}`}>
                        {r?.forecastValue != null ? `${r.forecastValue.toFixed(1)}%` : ""}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Real GDP YoY — Actual vs Ratiobo Forecast</p>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={gdpChartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#A8ADB8", fontSize: 9 }} tickLine={false} axisLine={false} tickFormatter={monthLabel} minTickGap={30} />
                  <YAxis tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={38} />
                  <Tooltip
                    contentStyle={{ background: "#1A1F29", border: "1px solid #2A3240", borderRadius: 6, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    labelFormatter={monthLabel}
                    formatter={(value, name) => [value == null ? "—" : `${Number(value).toFixed(2)}%`, name]}
                  />
                  <Line type="monotone" dataKey="actual" name="Actual" stroke="#7C9CBF" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="forecast" name="Ratiobo Forecast" stroke="#C9A227" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="card p-4">
              <p className="label text-[10px] mb-3">CPI YoY — Actual vs Ratiobo Forecast</p>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={cpiChartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#A8ADB8", fontSize: 9 }} tickLine={false} axisLine={false} tickFormatter={monthLabel} minTickGap={30} />
                  <YAxis tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={38} />
                  <Tooltip
                    contentStyle={{ background: "#1A1F29", border: "1px solid #2A3240", borderRadius: 6, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    labelFormatter={monthLabel}
                    formatter={(value, name) => [value == null ? "—" : `${Number(value).toFixed(2)}%`, name]}
                  />
                  <Line type="monotone" dataKey="actual" name="Actual" stroke="#7C9CBF" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="forecast" name="Ratiobo Forecast" stroke="#C9A227" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
