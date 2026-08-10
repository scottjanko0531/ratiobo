"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";
import { computeAll } from "../../lib/chinaWatchScoring";
import {
  ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ComposedChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine,
} from "recharts";

const GROUP_LABEL = { ED: "Economic Distress", WC: "Weaponizable Chokepoints", PT: "Political Timing", ER: "Escalation Readiness" };
const GROUP_ORDER = ["ED", "WC", "PT", "ER"];

const SCENARIO_META = [
  { key: "grayzone", label: "Gray-zone pressure", desc: "Status-quo coercion — drills, cable incidents, rhetoric, no kinetic escalation.", color: "text-gain", bar: "bg-gain" },
  { key: "quarantine", label: "Quarantine / customs blockade", desc: "Partial interdiction of Taiwan-bound shipping under a legal-gray pretext.", color: "text-brass-soft", bar: "bg-brass/70" },
  { key: "blockade", label: "Full blockade", desc: "Comprehensive air/sea interdiction — the scenario China Watch's drills rehearse most.", color: "text-brass-soft", bar: "bg-brass" },
  { key: "invasion", label: "Full invasion", desc: "Amphibious assault — lowest-probability, highest-consequence scenario.", color: "text-loss", bar: "bg-loss" },
];

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}
function fmtDateTime(d) {
  return d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[160px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.stroke ?? p.fill ?? p.color }}>{p.name}</span>
            <span className="num text-paper">{Number(p.value).toFixed(1)}</span>
          </div>
        );
      })}
    </div>
  );
}

function SpiBand(spi) {
  if (spi < 35) return { label: "Low pressure", color: "text-gain", border: "border-gain/30", bg: "bg-gain/10" };
  if (spi < 60) return { label: "Moderate pressure", color: "text-brass-soft", border: "border-brass/30", bg: "bg-brass/10" };
  if (spi < 80) return { label: "Elevated pressure", color: "text-loss", border: "border-loss/30", bg: "bg-loss/10" };
  return { label: "Severe pressure", color: "text-loss", border: "border-loss/40", bg: "bg-loss/15" };
}

function ConfidenceBadge({ level }) {
  const meta = level === "High" ? { color: "text-gain", bg: "bg-gain/10", border: "border-gain/30" }
    : level === "Medium" ? { color: "text-brass-soft", bg: "bg-brass/10", border: "border-brass/30" }
    : { color: "text-loss", bg: "bg-loss/10", border: "border-loss/30" };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.color} ${meta.bg} ${meta.border}`}>{level}</span>;
}

function IndicatorRow({ indicator, onScoreChange, onConfidenceChange, onNoteChange }) {
  const [note, setNote] = useState(indicator.note ?? "");
  useEffect(() => { setNote(indicator.note ?? ""); }, [indicator.id]);

  return (
    <div className="py-3 border-b border-ink-line last:border-b-0">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <p className="text-sm text-paper font-medium">{indicator.name}</p>
          <p className="text-[11px] text-paper-dim leading-relaxed mt-0.5">{indicator.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="num text-lg font-bold text-paper w-6 text-right">{indicator.score}</span>
          <select
            value={indicator.confidence}
            onChange={(e) => onConfidenceChange(indicator.id, e.target.value)}
            className="text-[10px] bg-ink border border-ink-line rounded px-1 py-1 text-paper-dim focus:outline-none focus:border-brass"
          >
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={10}
        value={indicator.score}
        onChange={(e) => onScoreChange(indicator.id, Number(e.target.value))}
        className="w-full cursor-pointer accent-brass"
        style={{ height: "3px" }}
      />
      <textarea
        value={note}
        onChange={(e) => { setNote(e.target.value); onNoteChange(indicator.id, e.target.value); }}
        rows={2}
        placeholder="Checkable claim — name the event or data point…"
        className="mt-2 w-full bg-ink border border-ink-line rounded-lg px-2.5 py-1.5 text-xs text-paper-dim placeholder:text-paper-dim/50 focus:outline-none focus:border-brass resize-none"
      />
      <div className="flex justify-end mt-1">
        <ConfidenceBadge level={indicator.confidence} />
      </div>
    </div>
  );
}

function PillarSection({ pillar, expanded, onToggle, onScoreChange, onConfidenceChange, onNoteChange, pillarAvg }) {
  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink/40 transition-colors text-left"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-paper">{pillar.name}</p>
          <p className="text-[10px] text-paper-dim mt-0.5">{GROUP_LABEL[pillar.group]} · {pillar.indicators.length} indicators</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="num text-sm text-brass-soft font-semibold">{pillarAvg.toFixed(1)}/10</span>
          <span className={`text-paper-dim transition-transform ${expanded ? "rotate-180" : ""}`}>▾</span>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-2 border-t border-ink-line">
          {pillar.indicators.map((ind) => (
            <IndicatorRow
              key={ind.id}
              indicator={ind}
              onScoreChange={onScoreChange}
              onConfidenceChange={onConfidenceChange}
              onNoteChange={onNoteChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChinaWatchPage() {
  const [indicators, setIndicators] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [refreshLog, setRefreshLog] = useState([]);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [showMethodology, setShowMethodology] = useState(false);
  const timers = useRef({});

  async function load() {
    setBusy(true);
    const [{ data: ind }, { data: snaps }, { data: log }] = await Promise.all([
      supabase.from("china_watch_indicators").select("*").order("sort_order"),
      supabase.from("china_watch_snapshots").select("*").order("snapshot_date", { ascending: true }),
      supabase.from("china_watch_refresh_log").select("*").order("run_at", { ascending: false }).limit(10),
    ]);
    setIndicators(ind ?? []);
    setSnapshots(snaps ?? []);
    setRefreshLog(log ?? []);
    setBusy(false);
  }

  useEffect(() => { load(); }, []);

  const pillars = useMemo(() => {
    if (!indicators) return [];
    const map = new Map();
    for (const ind of indicators) {
      if (!map.has(ind.pillar_id)) {
        map.set(ind.pillar_id, { id: ind.pillar_id, name: ind.pillar_name, group: ind.pillar_group, sort: ind.pillar_sort_order, indicators: [] });
      }
      map.get(ind.pillar_id).indicators.push(ind);
    }
    return [...map.values()].sort((a, b) => a.sort - b.sort);
  }, [indicators]);

  const computed = useMemo(() => {
    if (!indicators?.length) return null;
    return computeAll(indicators.map((i) => ({ pillarId: i.pillar_id, pillarGroup: i.pillar_group, score: i.score })));
  }, [indicators]);

  const radarData = useMemo(() => {
    if (!computed) return [];
    return GROUP_ORDER.map((g) => ({ group: GROUP_LABEL[g].split(" ")[0], full: GROUP_LABEL[g], value: computed[g] }));
  }, [computed]);

  const historyData = useMemo(() => {
    return snapshots.map((s) => ({ date: s.snapshot_date, spi: Number(s.spi), er: Number(s.er) }));
  }, [snapshots]);

  function updateField(id, field, value) {
    setIndicators((prev) => prev.map((i) => (i.id === id ? { ...i, [field]: value } : i)));
    const key = `${id}:${field}`;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(async () => {
      await supabase.from("china_watch_indicators").update({ [field]: value, updated_at: new Date().toISOString() }).eq("id", id);
    }, 600);
  }

  async function saveSnapshotNow() {
    if (!computed) return;
    setSavingSnapshot(true);
    await supabase.from("china_watch_snapshots").insert({
      snapshot_date: new Date().toISOString().slice(0, 10),
      ed: computed.ED, wc: computed.WC, pt: computed.PT, er: computed.ER, spi: computed.spi,
      grayzone: computed.grayzone, quarantine: computed.quarantine, blockade: computed.blockade, invasion: computed.invasion,
    });
    await load();
    setSavingSnapshot(false);
  }

  async function runRefreshNow() {
    setRefreshing(true);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/update-china-watch`, { method: "POST" });
    } catch (_) { /* best-effort */ }
    await load();
    setRefreshing(false);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ indicators, snapshots, refresh_log: refreshLog }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `china-watch-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const lastRefreshed = refreshLog[0]?.run_at ?? null;
  const band = computed ? SpiBand(computed.spi) : null;

  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold">China Watch</h1>
            <p className="text-xs text-paper-dim mt-0.5">
              China structural-risk → Taiwan scenario tracker · {lastRefreshed ? `last refreshed ${fmtDateTime(lastRefreshed)}` : "never refreshed"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={saveSnapshotNow} disabled={savingSnapshot || !computed} className="btn-ghost text-xs disabled:opacity-50">
              {savingSnapshot ? "Saving…" : "Save Snapshot"}
            </button>
            <button onClick={runRefreshNow} disabled={refreshing} className="btn-ghost text-xs disabled:opacity-50">
              {refreshing ? "Refreshing… (can take ~2 min)" : "Run Refresh Now"}
            </button>
            <button onClick={exportJson} disabled={!indicators} className="btn text-xs disabled:opacity-50">
              Export JSON
            </button>
          </div>
        </div>

        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : !computed ? (
          <div className="card p-10 text-center">
            <p className="text-paper-dim text-sm">No indicator data yet.</p>
          </div>
        ) : (
          <>
            {/* Disclaimer */}
            <div className="card p-3 mb-6 border-brass/20 bg-brass/5 flex items-start justify-between gap-3">
              <p className="text-[11px] text-paper-dim leading-relaxed">
                This is a <span className="text-paper">structured-judgment scaffold, not a calibrated forecast</span>. There is no dataset of past China/Taiwan crises large enough to estimate real probabilities. The value is in the discipline of re-scoring indicators periodically and watching the composites move — not the specific percentages on any given day.
              </p>
              <button onClick={() => setShowMethodology((v) => !v)} className="text-[10px] text-brass-soft shrink-0 whitespace-nowrap">
                {showMethodology ? "Hide" : "Methodology"}
              </button>
            </div>
            {showMethodology && (
              <div className="card p-4 mb-6 text-[11px] text-paper-dim leading-relaxed space-y-2">
                <p><span className="text-paper font-medium">Structural Pressure Index (SPI)</span> = 0.4·Economic Distress + 0.35·Weaponizable Chokepoints + 0.25·Political Timing, each a 0-100 roll-up of its pillars' 0-10 indicator averages.</p>
                <p><span className="text-paper font-medium">Scenario split</span> interpolates gray-zone/quarantine/blockade/invasion odds between fixed anchors at SPI=0 (70/20/8/2) and SPI=100 (10/15/35/40), then Escalation Readiness (ER) shifts weight between blockade and invasion — higher ER shifts probability mass from blockade toward invasion.</p>
                <p>Every indicator's note should read like a checkable claim (name the event/data point), not vague language. Scores are re-assessed monthly by an AI research pass with web search (see Refresh History below), or editable manually any time via the sliders.</p>
              </div>
            )}

            {/* SPI hero + composites */}
            <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4 mb-6">
              <div className={`card p-5 flex flex-col items-center justify-center border ${band.border} ${band.bg}`}>
                <p className="label text-[10px] mb-2">Structural Pressure Index</p>
                <p className={`num text-5xl font-bold ${band.color}`}>{computed.spi.toFixed(0)}</p>
                <p className={`text-xs font-semibold mt-1 ${band.color}`}>{band.label}</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {GROUP_ORDER.map((g) => (
                  <div key={g} className="card p-4 flex flex-col items-center justify-center text-center">
                    <p className="text-[10px] text-paper-dim mb-1 leading-tight">{GROUP_LABEL[g]}</p>
                    <p className="num text-2xl font-bold text-paper">{computed[g].toFixed(0)}</p>
                    <p className="text-[9px] text-paper-dim/60 mt-0.5">/100</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Scenario probability bars */}
            <div className="card p-4 mb-6">
              <p className="label text-[10px] mb-3">Taiwan Scenario Odds</p>
              <div className="space-y-3">
                {SCENARIO_META.map((s) => (
                  <div key={s.key}>
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-xs text-paper">{s.label}</span>
                      <span className={`num text-sm font-semibold ${s.color}`}>{computed[s.key].toFixed(1)}%</span>
                    </div>
                    <div className="h-2 w-full bg-ink rounded overflow-hidden">
                      <div className={`h-full ${s.bar}`} style={{ width: `${Math.min(100, computed[s.key])}%` }} />
                    </div>
                    <p className="text-[10px] text-paper-dim/60 mt-1">{s.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Radar + history */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="card p-4">
                <p className="label text-[10px] mb-3">Pillar Composite (0-100)</p>
                <ResponsiveContainer width="100%" height={220}>
                  <RadarChart data={radarData} outerRadius="75%">
                    <PolarGrid stroke="#2A3240" />
                    <PolarAngleAxis dataKey="group" tick={{ fill: "#A8ADB8", fontSize: 11 }} />
                    <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fill: "#A8ADB8", fontSize: 9 }} tickCount={4} />
                    <Radar name="Composite" dataKey="value" stroke="#C9A227" fill="#C9A227" fillOpacity={0.25} strokeWidth={2} />
                    <Tooltip content={<ChartTooltip />} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
              <div className="card p-4">
                <div className="flex items-baseline justify-between mb-3">
                  <p className="label text-[10px]">History — SPI &amp; Escalation Readiness</p>
                </div>
                {historyData.length === 0 ? (
                  <div className="h-[220px] flex items-center justify-center">
                    <p className="text-xs text-paper-dim">No snapshots yet — click Save Snapshot to start the history.</p>
                  </div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={190}>
                      <ComposedChart data={historyData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="date" tick={{ fill: "#A8ADB8", fontSize: 9 }} tickLine={false} axisLine={false} />
                        <YAxis domain={[0, 100]} tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} width={28} />
                        <Tooltip content={<ChartTooltip />} />
                        <ReferenceLine y={60} stroke="#E0635C" strokeDasharray="4 2" strokeOpacity={0.3} />
                        <Line type="monotone" dataKey="spi" name="SPI" stroke="#C9A227" strokeWidth={2} dot={false} connectNulls />
                        <Line type="monotone" dataKey="er" name="Escalation Readiness" stroke="#818CF8" strokeWidth={1.25} dot={false} connectNulls />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <div className="flex items-center gap-4 mt-2 text-[10px] text-paper-dim/70">
                      <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-[2px] rounded-sm bg-[#C9A227]" /> SPI</span>
                      <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-[2px] rounded-sm bg-[#818CF8]" /> Escalation Readiness</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Pillar sections */}
            <p className="label text-[10px] mb-3">Indicators — 26 total, editable</p>
            <div className="space-y-3 mb-6">
              {pillars.map((p) => (
                <PillarSection
                  key={p.id}
                  pillar={p}
                  expanded={!!expanded[p.id]}
                  onToggle={() => setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }))}
                  onScoreChange={(id, v) => updateField(id, "score", v)}
                  onConfidenceChange={(id, v) => updateField(id, "confidence", v)}
                  onNoteChange={(id, v) => updateField(id, "note", v)}
                  pillarAvg={p.indicators.reduce((s, i) => s + i.score, 0) / p.indicators.length}
                />
              ))}
            </div>

            {/* Refresh history */}
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Refresh History</p>
              {refreshLog.length === 0 ? (
                <p className="text-xs text-paper-dim py-2">No refreshes yet — click Run Refresh Now to generate the first automated pass.</p>
              ) : (
                <div className="space-y-3">
                  {refreshLog.map((r) => (
                    <div key={r.id} className="text-xs border-b border-ink-line last:border-b-0 pb-3 last:pb-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-paper-dim">{fmtDateTime(r.run_at)}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          r.status === "applied" ? "text-gain bg-gain/10 border-gain/30"
                          : r.status === "error" ? "text-loss bg-loss/10 border-loss/30"
                          : "text-paper-dim bg-ink border-ink-line"
                        }`}>
                          {r.status}
                        </span>
                      </div>
                      <p className="text-paper-dim leading-relaxed">{r.summary}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
