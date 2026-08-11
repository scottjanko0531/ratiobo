"use client";
import { useEffect, useState, useMemo } from "react";
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { supabase } from "../lib/supabase";

const STATUS_META = {
  critical: { label: "Critical", color: "text-loss", bg: "bg-loss/10", border: "border-loss/30" },
  watch:    { label: "Watch",    color: "text-brass-soft", bg: "bg-brass/10", border: "border-brass/30" },
  healthy:  { label: "Healthy",  color: "text-gain", bg: "bg-gain/10", border: "border-gain/30" },
};

const TREND_META = {
  worsening: { icon: "↑", color: "text-loss", label: "Worsening" },
  stable:    { icon: "→", color: "text-paper-dim", label: "Stable" },
  improving: { icon: "↓", color: "text-gain", label: "Improving" },
};

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const st = STATUS_META[row.status];
  return (
    <div className="card px-3 py-2 text-xs min-w-[160px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      <div className="flex justify-between gap-4">
        <span className="text-paper-dim">Score</span>
        <span className="num font-semibold text-paper">{row.score}</span>
      </div>
      {st && (
        <div className="flex justify-between gap-4">
          <span className="text-paper-dim">Status</span>
          <span className={`font-medium ${st.color}`}>{st.label}</span>
        </div>
      )}
    </div>
  );
}

export default function SupplyChainDetailDrawer({ item, onClose }) {
  const [history, setHistory] = useState(null);

  useEffect(() => {
    if (!item) { setHistory(null); return; }
    setHistory(null);
    supabase
      .from("supply_chain_snapshots")
      .select("snapshot_date, score, status, trend, summary, concentration, primary_threat, alternatives, recent_signal")
      .eq("item_id", item.id)
      .order("snapshot_date")
      .then(({ data }) => setHistory(data ?? []));
  }, [item?.id]);

  const chartData = useMemo(
    () => (history ?? []).map((r) => ({ date: r.snapshot_date, score: Number(r.score), status: r.status })),
    [history]
  );

  if (!item) return null;

  const st = STATUS_META[item.current_status] ?? STATUS_META.watch;
  const tr = TREND_META[item.current_trend];

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/70" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-[720px] bg-ink-soft border-l border-ink-line overflow-y-auto">
        <div className="flex items-start justify-between px-5 py-4 border-b border-ink-line">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2">
              <p className="font-semibold text-base">{item.name}</p>
              {item.risk_type && (
                <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${
                  item.risk_type === "active" ? "text-loss border-loss/30 bg-loss/5" : "text-paper-dim border-ink-line"
                }`}>
                  {item.risk_type === "active" ? "Active catalyst" : "Structural risk"}
                </span>
              )}
            </div>
            <p className="text-xs text-paper-dim mt-0.5">{item.category}</p>
          </div>
          <button onClick={onClose} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
        </div>

        <div className="grid grid-cols-3 gap-px border-b border-ink-line">
          <div className="px-3 py-3">
            <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Risk score</p>
            <p className="num text-sm font-medium">{item.current_score ?? "—"}<span className="text-paper-dim">/100</span></p>
          </div>
          <div className="px-3 py-3">
            <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Status</p>
            <p className={`text-sm font-medium ${st.color}`}>{st.label}</p>
          </div>
          <div className="px-3 py-3">
            <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Trend</p>
            <p className={`text-sm font-medium ${tr?.color ?? "text-paper-dim"}`}>{tr ? `${tr.icon} ${tr.label}` : "—"}</p>
          </div>
        </div>

        <div className="px-5 py-4 border-b border-ink-line">
          <p className="text-sm text-paper leading-relaxed">{item.summary}</p>
        </div>

        <div className="px-5 py-4 border-b border-ink-line grid grid-cols-2 gap-4">
          <div>
            <p className="label text-[10px] mb-1">Concentration</p>
            <p className="text-xs text-paper-dim leading-relaxed">{item.concentration ?? "—"}</p>
          </div>
          <div>
            <p className="label text-[10px] mb-1">Primary threat</p>
            <p className="text-xs text-paper-dim leading-relaxed">{item.primary_threat ?? "—"}</p>
          </div>
          <div>
            <p className="label text-[10px] mb-1">Alternatives</p>
            <p className="text-xs text-paper-dim leading-relaxed">{item.alternatives ?? "—"}</p>
          </div>
          <div>
            <p className="label text-[10px] mb-1">Recent signal</p>
            <p className="text-xs text-paper-dim leading-relaxed">{item.recent_signal ?? "—"}</p>
          </div>
        </div>

        <div className="px-5 py-4 border-b border-ink-line">
          <p className="label text-[10px] mb-3">Risk score history</p>
          {history === null ? (
            <p className="text-xs text-paper-dim">Loading…</p>
          ) : chartData.length < 2 ? (
            <p className="text-xs text-paper-dim">Not enough history yet — check back after a few daily updates.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => v.slice(5)} />
                <YAxis domain={[0, 100]} tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} width={28} />
                <Tooltip content={<ChartTooltip />} />
                <ReferenceLine y={75} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                <ReferenceLine y={35} stroke="#22c55e" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                <Line type="monotone" dataKey="score" stroke="#C9A227" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="px-5 py-4">
          <p className="label text-[10px] mb-3">Daily readings</p>
          {history === null ? (
            <p className="text-xs text-paper-dim">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-paper-dim">No readings yet.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-2">
              {[...history].reverse().map((r) => {
                const rst = STATUS_META[r.status];
                const rtr = TREND_META[r.trend];
                return (
                  <div key={r.snapshot_date} className="flex items-start justify-between gap-3 text-xs border-b border-ink-line/40 pb-2">
                    <div className="min-w-0">
                      <p className="text-paper-dim">{r.snapshot_date}</p>
                      <p className="text-paper-dim leading-relaxed mt-0.5">{r.summary}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="num text-paper font-medium">{r.score}</p>
                      <p className={`${rst?.color ?? "text-paper-dim"}`}>{rst?.label}{rtr ? ` ${rtr.icon}` : ""}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {(item.source_note || item.updated_at) && (
          <div className="px-5 py-3 border-t border-ink-line">
            <p className="text-[10px] text-paper-dim/60">
              {item.source_note ? `Source: ${item.source_note}` : "Source: not recorded"}
              {item.updated_at ? ` · Last verified ${new Date(item.updated_at).toLocaleString()}` : ""}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
