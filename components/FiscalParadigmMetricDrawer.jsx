"use client";
import { useEffect, useState, useMemo } from "react";
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { supabase } from "../lib/supabase";

// Metric drill-down for the Fiscal Policy Paradigm scorecard — the
// "transparent math" requirement from the build spec: shows the exact FRED
// series/formula, the raw historical chart, the trailing mean/stddev the
// z-score was computed against, and the z-score formula as literal text.

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const v = payload[0]?.value;
  return (
    <div className="card px-3 py-2 text-xs min-w-[140px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      <div className="flex justify-between gap-4">
        <span className="text-paper-dim">Value</span>
        <span className="num font-semibold text-paper">{v?.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
      </div>
    </div>
  );
}

export default function FiscalParadigmMetricDrawer({ metric, score, onClose }) {
  const [history, setHistory] = useState(null);

  useEffect(() => {
    if (!metric) { setHistory(null); return; }
    setHistory(null);
    supabase
      .from("big_cycle_paradigm_raw_series")
      .select("obs_date, value")
      .eq("metric_key", metric.key)
      .order("obs_date")
      .then(({ data }) => setHistory(data ?? []));
  }, [metric?.key]);

  const chartData = useMemo(
    () => (history ?? []).map((r) => ({ date: r.obs_date, value: Number(r.value) })),
    [history]
  );

  const windowStats = useMemo(() => {
    if (!history || history.length < 2) return null;
    const tenYearsAgo = new Date();
    tenYearsAgo.setUTCFullYear(tenYearsAgo.getUTCFullYear() - 10);
    const cutoff = tenYearsAgo.toISOString().slice(0, 10);
    const window = history.filter((r) => r.obs_date >= cutoff);
    const vals = (window.length >= 2 ? window : history).map((r) => Number(r.value));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return { mean, stddev: Math.sqrt(variance), n: vals.length, usedFullSeries: window.length < 2 };
  }, [history]);

  if (!metric) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/70" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-[720px] bg-ink-soft border-l border-ink-line overflow-y-auto">
        <div className="flex items-start justify-between px-5 py-4 border-b border-ink-line">
          <div className="flex-1 min-w-0 pr-4">
            <p className="font-semibold text-base">{metric.label}</p>
            <p className="text-xs text-paper-dim mt-0.5">
              Paradigm {metric.paradigms.join(" & ")} · {metric.orientationDescription}
            </p>
          </div>
          <button onClick={onClose} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
        </div>

        {score && (
          <div className="grid grid-cols-4 gap-px border-b border-ink-line">
            <div className="px-3 py-3">
              <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Raw value</p>
              <p className="num text-sm font-medium">{score.available ? Number(score.raw_value).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}</p>
            </div>
            <div className="px-3 py-3">
              <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Z-score</p>
              <p className="num text-sm font-medium">{score.available ? Number(score.z_score).toFixed(2) : "—"}</p>
            </div>
            <div className="px-3 py-3">
              <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Oriented Z</p>
              <p className={`num text-sm font-medium ${score.available && Number(score.oriented_z) >= 0 ? "text-gain" : score.available ? "text-loss" : ""}`}>
                {score.available ? Number(score.oriented_z).toFixed(2) : "—"}
              </p>
            </div>
            <div className="px-3 py-3">
              <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Weight</p>
              <p className="num text-sm font-medium">{(Number(score.weight) * 100).toFixed(0)}%</p>
            </div>
          </div>
        )}

        {score && !score.available && (
          <div className="px-5 py-3 border-b border-loss/30 bg-loss/10">
            <p className="text-xs text-loss">Unavailable today: {score.unavailable_reason ?? "FRED fetch failed"} — excluded from the composite, weight redistributed among the remaining metrics.</p>
          </div>
        )}

        <div className="px-5 py-4 border-b border-ink-line">
          <p className="label text-[10px] mb-1">Formula</p>
          <p className="text-xs text-paper-dim leading-relaxed font-mono">{metric.formulaDescription}</p>
        </div>

        <div className="px-5 py-4 border-b border-ink-line">
          <p className="label text-[10px] mb-1">Z-score calculation</p>
          <p className="text-xs text-paper-dim leading-relaxed font-mono">
            z = (current − trailing_mean) / trailing_stddev
          </p>
          {windowStats && (
            <p className="text-[11px] text-paper-dim/70 mt-2 leading-relaxed">
              Trailing {windowStats.usedFullSeries ? "full series" : "10-year"} window: mean = {windowStats.mean.toLocaleString(undefined, { maximumFractionDigits: 4 })},
              {" "}stddev = {windowStats.stddev.toLocaleString(undefined, { maximumFractionDigits: 4 })}, n = {windowStats.n} observations.
              Re-normalized on every refresh, not a fixed all-time denominator.
            </p>
          )}
        </div>

        <div className="px-5 py-4">
          <p className="label text-[10px] mb-3">Raw historical series</p>
          {history === null ? (
            <p className="text-xs text-paper-dim">Loading…</p>
          ) : chartData.length < 2 ? (
            <p className="text-xs text-paper-dim">Not enough history yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false}
                  tickFormatter={(v) => v.slice(0, 7)} minTickGap={40} />
                <YAxis tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} width={40}
                  domain={["auto", "auto"]} />
                <Tooltip content={<ChartTooltip />} />
                {windowStats && (
                  <ReferenceLine y={windowStats.mean} stroke="#C9A227" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.6} />
                )}
                <Line type="monotone" dataKey="value" stroke="#4F8EF7" strokeWidth={1.5} dot={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="px-5 py-3 border-t border-ink-line">
          <p className="text-[10px] text-paper-dim/60">FRED series: {metric.formulaDescription}</p>
        </div>
      </div>
    </div>
  );
}
