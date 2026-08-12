"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";

const STATUS_META = {
  good: { color: "text-gain", bg: "bg-gain/10", border: "border-gain/30" },
  warn: { color: "text-brass-soft", bg: "bg-brass/10", border: "border-brass/30" },
  bad: { color: "text-loss", bg: "bg-loss/10", border: "border-loss/30" },
};

function fmtDateTime(d) {
  return d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

function StageTracker({ stages, color }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1 -mx-1 px-1">
      {stages.map((s, i) => (
        <div key={s.id} className="flex items-center gap-1 shrink-0">
          <div
            title={s.description}
            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap ${s.is_current ? "text-ink font-semibold" : "text-paper-dim border border-ink-line"}`}
            style={s.is_current ? { backgroundColor: color } : {}}
          >
            {s.label}
          </div>
          {i < stages.length - 1 && <span className="text-paper-dim/25 text-xs shrink-0">→</span>}
        </div>
      ))}
    </div>
  );
}

function MetricCard({ metric, editable, onSave }) {
  const [display, setDisplay] = useState(metric.value_display ?? "");
  const [note, setNote] = useState(metric.note ?? "");
  useEffect(() => { setDisplay(metric.value_display ?? ""); setNote(metric.note ?? ""); }, [metric.id, metric.value_display, metric.note]);

  const st = metric.status ? STATUS_META[metric.status] : null;

  return (
    <div className="card p-3.5 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <p className="text-xs text-paper-dim leading-snug">{metric.label}</p>
        {metric.status_label && st && (
          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0 ${st.bg} ${st.color}`}>{metric.status_label}</span>
        )}
      </div>

      {editable ? (
        <input
          value={display}
          onChange={(e) => setDisplay(e.target.value)}
          onBlur={() => onSave(metric.id, { value_display: display })}
          placeholder="e.g. 3.1%"
          className="w-full bg-ink border border-ink-line rounded px-2 py-1 text-base font-bold text-paper mb-1 focus:outline-none focus:border-brass num"
        />
      ) : (
        <p className={`num text-lg font-bold ${st?.color ?? "text-paper"}`}>{metric.value_display ?? "—"}</p>
      )}

      {editable ? (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => onSave(metric.id, { note })}
          rows={2}
          placeholder="Notes…"
          className="w-full bg-ink border border-ink-line rounded px-2 py-1 text-[10px] text-paper-dim leading-relaxed mt-1 resize-none focus:outline-none focus:border-brass"
        />
      ) : (
        metric.note && <p className="text-[10px] text-paper-dim/70 leading-relaxed mt-1">{metric.note}</p>
      )}

      <div className="flex items-center justify-between mt-auto pt-2 border-t border-ink-line/50">
        <span className="text-[9px] text-paper-dim/50 truncate">{metric.source_name}</span>
        {editable && <span className="text-[9px] text-brass-soft shrink-0 ml-2">Manual</span>}
      </div>
    </div>
  );
}

function CycleSection({ cycle, stages, metrics, editableKeys, onSaveMetric }) {
  return (
    <div className="card p-5 mb-6" style={{ borderTop: `3px solid ${cycle.color}` }}>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-base font-semibold text-paper">{cycle.name}</h2>
      </div>
      <p className="text-xs text-paper-dim/70 mb-3">{cycle.description}</p>

      <StageTracker stages={stages} color={cycle.color} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
        {metrics.map((m) => (
          <MetricCard key={m.id} metric={m} editable={editableKeys.has(m.key)} onSave={onSaveMetric} />
        ))}
      </div>
    </div>
  );
}

function DeterminantRow({ det, editable, onSave }) {
  const [reading, setReading] = useState(det.reading_text ?? "");
  const [strength, setStrength] = useState(det.strength_pct ?? 50);
  useEffect(() => { setReading(det.reading_text ?? ""); setStrength(det.strength_pct ?? 50); }, [det.id, det.reading_text, det.strength_pct]);

  const st = det.status ? STATUS_META[det.status] : null;
  const barColor = det.status === "good" ? "bg-gain" : det.status === "bad" ? "bg-loss" : "bg-brass";

  return (
    <div className="py-3 border-b border-ink-line last:border-b-0">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <p className="text-sm font-medium text-paper">{det.name}</p>
        {det.status_label ?? det.status ? (
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${st?.bg ?? ""} ${st?.color ?? "text-paper-dim"}`}>
            {det.status ?? "—"}
          </span>
        ) : null}
      </div>

      {editable ? (
        <textarea
          value={reading}
          onChange={(e) => setReading(e.target.value)}
          onBlur={() => onSave(det.id, { reading_text: reading })}
          rows={2}
          className="w-full bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper-dim leading-relaxed mb-2 resize-none focus:outline-none focus:border-brass"
        />
      ) : (
        <p className="text-xs text-paper-dim leading-relaxed mb-2">{det.reading_text ?? "—"}</p>
      )}

      <div className="flex items-center gap-3">
        <div className="flex-1 h-1.5 bg-ink rounded overflow-hidden">
          <div className={`h-full ${barColor}`} style={{ width: `${Math.max(0, Math.min(100, det.strength_pct ?? 0))}%` }} />
        </div>
        {editable ? (
          <input
            type="number" min={0} max={100} value={strength}
            onChange={(e) => setStrength(e.target.value)}
            onBlur={() => onSave(det.id, { strength_pct: strength === "" ? null : Number(strength) })}
            className="w-14 bg-ink border border-ink-line rounded px-1.5 py-0.5 text-xs text-paper num focus:outline-none focus:border-brass"
          />
        ) : (
          <span className="num text-xs text-paper-dim w-10 text-right shrink-0">{det.strength_pct != null ? `${det.strength_pct}%` : "—"}</span>
        )}
      </div>
      {det.trajectory_note && <p className="text-[10px] text-paper-dim/60 mt-1.5">{det.trajectory_note}</p>}
      <p className="text-[9px] text-paper-dim/40 mt-1">{det.source_name}</p>
    </div>
  );
}

export default function BigCyclePage() {
  const [cycles, setCycles] = useState(null);
  const [stages, setStages] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [determinants, setDeterminants] = useState([]);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const timers = useRef({});

  async function load() {
    setBusy(true);
    const [{ data: c }, { data: s }, { data: m }, { data: d }] = await Promise.all([
      supabase.from("big_cycle_cycles").select("*").order("sort_order"),
      supabase.from("big_cycle_stages").select("*").order("stage_order"),
      supabase.from("big_cycle_metrics").select("*").order("sort_order"),
      supabase.from("big_cycle_determinants").select("*").order("sort_order"),
    ]);
    setCycles(c ?? []);
    setStages(s ?? []);
    setMetrics(m ?? []);
    setDeterminants(d ?? []);
    setBusy(false);
  }

  useEffect(() => { load(); }, []);

  async function runRefreshNow() {
    setRefreshing(true);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/update-big-cycle-metrics`, { method: "POST" });
    } catch (_) { /* best-effort */ }
    await load();
    setRefreshing(false);
  }

  function saveMetric(id, patch) {
    setMetrics((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    const key = `metric:${id}`;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(async () => {
      await supabase.from("big_cycle_metrics").update({ ...patch, last_updated: new Date().toISOString() }).eq("id", id);
    }, 500);
  }

  function saveDeterminant(id, patch) {
    setDeterminants((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    const key = `det:${id}`;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(async () => {
      await supabase.from("big_cycle_determinants").update(patch).eq("id", id);
    }, 500);
  }

  const editableMetricKeys = useMemo(
    () => new Set(metrics.filter((m) => m.refresh_method === "manual").map((m) => m.key)),
    [metrics]
  );

  const lastUpdated = useMemo(() => {
    const dates = metrics.filter((m) => m.last_updated).map((m) => new Date(m.last_updated).getTime());
    return dates.length ? new Date(Math.max(...dates)) : null;
  }, [metrics]);

  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold">Big Cycle</h1>
            <p className="text-xs text-paper-dim mt-0.5">
              Dalio's three interlocking cycles — debt, internal order, external order · {lastUpdated ? `refreshed ${fmtDateTime(lastUpdated)}` : "not yet refreshed"}
            </p>
          </div>
          <button onClick={runRefreshNow} disabled={refreshing} className="btn text-xs shrink-0 disabled:opacity-50">
            {refreshing ? "Refreshing…" : "Refresh Now"}
          </button>
        </div>

        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : !cycles?.length ? (
          <div className="card p-10 text-center">
            <p className="text-paper-dim text-sm">No data yet.</p>
          </div>
        ) : (
          <>
            <div className="card p-3 mb-6 border-brass/20 bg-brass/5">
              <p className="text-[11px] text-paper-dim leading-relaxed">
                Framework and stage placement are Dalio's — <span className="text-paper">this is a structured lens, not a forecast</span>. Metrics tagged "Manual" below are hand-entered (click the value or note to edit); everything else refreshes automatically. Stage labels marked as "current" reflect an editorial judgment call given the metrics below, not an authoritative dating.
              </p>
            </div>

            {cycles.map((cycle) => (
              <CycleSection
                key={cycle.id}
                cycle={cycle}
                stages={stages.filter((s) => s.cycle_id === cycle.id)}
                metrics={metrics.filter((m) => m.cycle_id === cycle.id)}
                editableKeys={editableMetricKeys}
                onSaveMetric={saveMetric}
              />
            ))}

            <div className="card p-5">
              <p className="label text-[10px] mb-1">National Power Determinants</p>
              <p className="text-[10px] text-paper-dim/60 mb-3">Cross-cutting scorecard of relative strength — not tied to a single cycle. Bars are illustrative, not a precise index.</p>
              {determinants.map((det) => (
                <DeterminantRow
                  key={det.id}
                  det={det}
                  editable={det.refresh_method === "manual"}
                  onSave={saveDeterminant}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
