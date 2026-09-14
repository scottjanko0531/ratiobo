"use client";
import { useEffect, useMemo, useState } from "react";
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";
import { supabase } from "../lib/supabase";
import { PARADIGM_METRICS, PARADIGM_NAMES, metricsForParadigm } from "../lib/paradigmMetrics";
import FiscalParadigmMetricDrawer from "./FiscalParadigmMetricDrawer";

// Fiscal Policy Paradigm scorecard (42 Macro's Paradigm A-E sovereign-debt-
// resolution framework) — complements the Long Term Debt Cycle section
// directly above it. Every number here is FRED-derived and computed
// (update-big-cycle-paradigm-metrics, daily cron) -- no manual-entry field
// anywhere on this page, per the build spec's own acceptance criteria.

const LABEL_META = {
  "Not Active":   { color: "text-paper-dim", bg: "bg-ink-soft",  border: "border-ink-line" },
  "Emerging":     { color: "text-brass-soft", bg: "bg-brass/10", border: "border-brass/30" },
  "Active":       { color: "text-gain",      bg: "bg-gain/10",   border: "border-gain/30" },
  "Dominant":     { color: "text-gain",      bg: "bg-gain/20",   border: "border-gain/50" },
  "Confirmed":    { color: "text-gain",      bg: "bg-gain/10",   border: "border-gain/30" },
  "Not Confirmed":{ color: "text-paper-dim", bg: "bg-ink-soft",  border: "border-ink-line" },
};

const PARADIGM_LINE_COLOR = { A: "#A8ADB8", B: "#4F8EF7", C: "#22c55e", D: "#ef4444", E: "#C9A227" };
const RANGE_OPTIONS = [
  { key: "1y", label: "1yr", days: 365 },
  { key: "5y", label: "5yr", days: 365 * 5 },
  { key: "max", label: "Max", days: null },
];

function Badge({ label }) {
  const meta = LABEL_META[label] ?? LABEL_META["Not Active"];
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded border ${meta.bg} ${meta.color} ${meta.border}`}>
      {label}
    </span>
  );
}

function MetricRow({ def, score, onClick }) {
  const oz = score?.available ? Number(score.oriented_z) : null;
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 py-1.5 border-b border-ink-line/40 last:border-b-0 text-left hover:bg-ink-soft/40 transition-colors"
    >
      <span className="text-[11px] text-paper-dim truncate">{def.label}</span>
      <span className="flex items-center gap-2 shrink-0">
        {!score?.available && <span className="text-[9px] text-loss">stale</span>}
        <span className={`num text-[11px] font-medium ${oz == null ? "text-paper-dim" : oz >= 0 ? "text-gain" : "text-loss"}`}>
          {oz == null ? "—" : oz.toFixed(2)}
        </span>
      </span>
    </button>
  );
}

function TrendChart({ history }) {
  const [range, setRange] = useState("1y");

  const chartData = useMemo(() => {
    const byDate = {};
    for (const r of history) {
      if (!byDate[r.recorded_at]) byDate[r.recorded_at] = { date: r.recorded_at };
      byDate[r.recorded_at][r.paradigm] = Number(r.composite_score);
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  }, [history]);

  const filtered = useMemo(() => {
    const opt = RANGE_OPTIONS.find((o) => o.key === range);
    if (!opt?.days) return chartData;
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - opt.days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return chartData.filter((r) => r.date >= cutoffStr);
  }, [chartData, range]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="label text-[10px]">Composite Score Trend</p>
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((o) => (
            <button
              key={o.key}
              onClick={() => setRange(o.key)}
              className={`text-[10px] px-2 py-0.5 rounded ${range === o.key ? "bg-brass/20 text-brass-soft" : "text-paper-dim hover:text-paper"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {filtered.length < 2 ? (
        <p className="text-xs text-paper-dim">Not enough history yet — check back after a few daily refreshes.</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={filtered} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false}
              tickFormatter={(v) => v.slice(0, 7)} minTickGap={40} />
            <YAxis tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} width={32} />
            <Tooltip contentStyle={{ background: "#161B22", border: "1px solid #2A3240", fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => `${v}: ${PARADIGM_NAMES[v]}`} />
            <ReferenceLine y={0.5} stroke="#4b5563" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
            {["A", "B", "C", "D", "E"].map((p) => (
              <Line key={p} type="monotone" dataKey={p} stroke={PARADIGM_LINE_COLOR[p]} strokeWidth={1.5} dot={false} connectNulls />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export default function FiscalParadigmSection() {
  const [latest, setLatest] = useState(null);   // { A: paradigmScoreRow, ... }
  const [metricScores, setMetricScores] = useState({}); // key `${metric_key}_${paradigm}` -> row
  const [history, setHistory] = useState([]);
  const [lastRunAt, setLastRunAt] = useState(null);
  const [openMetric, setOpenMetric] = useState(null); // { def, score }

  useEffect(() => {
    supabase
      .from("big_cycle_paradigm_scores")
      .select("*")
      .order("recorded_at", { ascending: true })
      .then(({ data }) => {
        const rows = data ?? [];
        setHistory(rows);
        if (rows.length === 0) return;
        const latestDate = rows[rows.length - 1].recorded_at;
        const latestRows = rows.filter((r) => r.recorded_at === latestDate);
        setLatest(Object.fromEntries(latestRows.map((r) => [r.paradigm, r])));
        setLastRunAt(latestRows[0]?.run_at ?? null);

        supabase
          .from("big_cycle_paradigm_metric_scores")
          .select("*")
          .eq("recorded_at", latestDate)
          .then(({ data: mData }) => {
            setMetricScores(Object.fromEntries((mData ?? []).map((r) => [`${r.metric_key}_${r.paradigm}`, r])));
          });
      });
  }, []);

  if (!latest) {
    return (
      <div className="card p-5 mb-6">
        <p className="label text-[10px] mb-1">Fiscal Policy Paradigm</p>
        <p className="text-xs text-paper-dim">No data yet — the daily refresh hasn't run.</p>
      </div>
    );
  }

  const bcdScores = ["B", "C", "D"].map((p) => latest[p]).filter(Boolean);
  const dominant = bcdScores.length
    ? bcdScores.reduce((a, b) => (Number(b.composite_score) > Number(a.composite_score) ? b : a))
    : null;
  const dominantConfirmed = dominant && dominant.label !== "Not Active" && dominant.label !== "Emerging";

  const openDrawerFor = (metricKey, paradigm) => {
    const def = PARADIGM_METRICS.find((m) => m.key === metricKey);
    const score = metricScores[`${metricKey}_${paradigm}`];
    if (def) setOpenMetric({ def, score });
  };

  return (
    <div className="card p-5 mb-6" style={{ borderTop: "3px solid #C9A227" }}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h2 className="text-base font-semibold text-paper">Fiscal Policy Paradigm</h2>
          <p className="text-xs text-paper-dim/70 mt-0.5">
            42 Macro's sovereign-debt-resolution sequence: Cut → Grow → Print → [War]. Every metric is FRED-derived and
            computed daily — z-score, orientation, and weighting are fixed, deterministic rules (see any metric's drill-down),
            never a manual override.
          </p>
        </div>
        {lastRunAt && (
          <span className="text-[10px] text-paper-dim shrink-0">
            Updated {new Date(lastRunAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
      </div>

      <div className="mt-3 mb-4 p-3 rounded-lg border border-ink-line bg-ink-soft/40">
        <p className="text-sm font-medium text-paper">
          {dominantConfirmed
            ? <>Currently Dominant: <span style={{ color: PARADIGM_LINE_COLOR[dominant.paradigm] }}>Paradigm {dominant.paradigm} — {PARADIGM_NAMES[dominant.paradigm]}</span></>
            : "No paradigm currently dominant"}
        </p>
      </div>

      {/* Paradigm A — background condition, not a competing response path */}
      <div className="mb-4 p-3 rounded-lg border border-ink-line">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-paper">Paradigm A — {PARADIGM_NAMES.A}</p>
          <Badge label={latest.A?.label ?? "Not Confirmed"} />
        </div>
        <p className="text-[11px] text-paper-dim/70 mb-2">
          The originating condition B/C/D respond to, not a competing paradigm — composite {Number(latest.A?.composite_score ?? 0).toFixed(2)}.
        </p>
        {metricsForParadigm("A").map((def) => (
          <MetricRow key={def.key} def={def} score={metricScores[`${def.key}_A`]} onClick={() => openDrawerFor(def.key, "A")} />
        ))}
      </div>

      {/* B / C / D */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {["B", "C", "D"].map((p) => {
          const row = latest[p];
          const isDominant = dominantConfirmed && dominant.paradigm === p;
          return (
            <div key={p} className={`p-3 rounded-lg border ${isDominant ? "border-gain/50 bg-gain/5" : "border-ink-line"}`}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-paper">{p} — {PARADIGM_NAMES[p]}</p>
                <Badge label={row?.label ?? "Not Active"} />
              </div>
              <p className="text-[11px] text-paper-dim/70 mb-2">
                Composite {Number(row?.composite_score ?? 0).toFixed(2)} · coverage {Number(row?.coverage_pct ?? 0).toFixed(0)}%
              </p>
              {metricsForParadigm(p).map((def) => (
                <MetricRow key={def.key} def={def} score={metricScores[`${def.key}_${p}`]} onClick={() => openDrawerFor(def.key, p)} />
              ))}
            </div>
          );
        })}
      </div>

      {/* Paradigm E — structurally low coverage */}
      <div className="mb-4 p-3 rounded-lg border border-loss/30 bg-loss/5">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-paper">E — {PARADIGM_NAMES.E}</p>
          <span className="flex items-center gap-1.5">
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded border border-loss/30 text-loss bg-loss/10">Low Coverage</span>
            <Badge label={latest.E?.label ?? "Not Active"} />
          </span>
        </div>
        <p className="text-[11px] text-paper-dim/70 mb-2">
          Only 2 of the original 3 signals have a FRED equivalent (war deaths and immigration flow are dropped, not
          proxied) — one of the two is reused unmodified from Paradigm B. Structurally the least observable paradigm
          from public fiscal/monetary data alone; shown here with less evidentiary weight than B/C/D by design, not as
          a data outage. Composite {Number(latest.E?.composite_score ?? 0).toFixed(2)}.
        </p>
        {metricsForParadigm("E").map((def) => (
          <MetricRow key={def.key} def={def} score={metricScores[`${def.key}_E`]} onClick={() => openDrawerFor(def.key, "E")} />
        ))}
      </div>

      <TrendChart history={history} />

      {openMetric && (
        <FiscalParadigmMetricDrawer
          metric={openMetric.def}
          score={openMetric.score}
          onClose={() => setOpenMetric(null)}
        />
      )}
    </div>
  );
}
