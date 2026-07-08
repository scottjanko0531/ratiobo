"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";
import ThreeForcesChart from "../../components/ThreeForcesChart";
import DalioGauges from "../../components/DalioGauges";
import {
  ComposedChart, Line, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  SIMULATOR_KEYS,
  REGIME_DEFAULT_WEIGHTS,
  REGIME_META,
  detectRegimeKey,
  resolveSimulatorKey,
  getSignalKeys,
  toIntWeights,
} from "../../lib/simulatorKeys";
import { getAssetData } from "../../lib/data/assetReturns";
import { applyNaiveRiskParity, solveTrueRiskParity } from "../../lib/riskParity";

const LAYER_NAMES = {
  1: "Long-term Debt Cycle",
  2: "Business Cycle",
  3: "Quadrant Positioning",
  4: "Tail Risk",
};

const KEY_LABEL = Object.fromEntries(SIMULATOR_KEYS.map((s) => [s.key, s.label]));

const STATUS_STYLE = {
  healthy: { text: "text-gain", bg: "bg-gain/10", border: "border-gain/20" },
  watch:   { text: "text-brass", bg: "bg-brass/10", border: "border-brass/20" },
  danger:  { text: "text-loss", bg: "bg-loss/10", border: "border-loss/20" },
  unknown: { text: "text-paper-dim", bg: "bg-ink-soft", border: "border-ink-line" },
};

function formatValue(v, unit) {
  if (v == null) return "—";
  const n = Number(v);
  if (isNaN(n)) return "—";
  if (unit === "%")       return n.toFixed(2) + "%";
  if (unit === "$B")      return "$" + n.toFixed(1) + "B";
  if (unit === "$M")      return "$" + (n / 1_000_000).toFixed(2) + "T";
  if (unit === "K")       return n.toFixed(0) + "K";
  if (unit === "tons")    return n.toFixed(0) + "t";
  if (unit === "bps")     return n.toFixed(0) + "bps";
  if (unit === "ratio")   return n.toFixed(2) + "x";
  if (unit === "z-score") return n.toFixed(3);
  if (unit === "index")   return n.toFixed(1);
  return n.toFixed(2);
}

function ChangeArrow({ change, unit }) {
  if (change == null) return null;
  const n = Number(change);
  if (isNaN(n) || n === 0) return null;
  const up = n > 0;
  return (
    <span className={`text-xs ${up ? "text-gain" : "text-loss"}`}>
      {up ? "↑" : "↓"} {formatValue(Math.abs(n), unit)}
    </span>
  );
}

function StatusBadge({ status }) {
  const s = status ?? "unknown";
  const st = STATUS_STYLE[s] ?? STATUS_STYLE.unknown;
  return (
    <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full border ${st.text} ${st.bg} ${st.border}`}>
      {s.toUpperCase()}
    </span>
  );
}

function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
    </svg>
  );
}

function IndicatorCard({ ind, onSave, onClick }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const [editStatus, setEditStatus] = useState("unknown");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  function startEdit() {
    setEditVal(ind.current_value != null ? String(ind.current_value) : "");
    setEditStatus(ind.status ?? "unknown");
    setSaveError("");
    setEditing(true);
  }

  async function saveEdit() {
    const curr = parseFloat(editVal);
    if (isNaN(curr)) { setSaveError("Enter a valid number."); return; }
    setSaving(true);
    setSaveError("");
    const prev = ind.current_value != null ? Number(ind.current_value) : curr;
    const { error } = await supabase
      .from("macro_indicators")
      .update({
        current_value: curr,
        previous_value: prev,
        change_value: curr - prev,
        status: editStatus,
        last_fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", ind.id);
    setSaving(false);
    if (error) { setSaveError(error.message); return; }
    setEditing(false);
    onSave?.();
  }

  if (editing) {
    return (
      <div className="card p-4 border border-brass/30">
        <p className="text-sm font-medium mb-3 leading-snug">{ind.name}</p>
        <div className="space-y-2">
          <div>
            <label className="label text-[10px] mb-1 block">Value ({ind.unit})</label>
            <input
              type="number"
              value={editVal}
              onChange={(e) => setEditVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
              className="w-full bg-ink-soft border border-ink-line rounded px-2 py-1.5 text-sm num focus:outline-none focus:border-brass/60"
              placeholder={`Enter ${ind.unit}`}
              autoFocus
            />
          </div>
          <div>
            <label className="label text-[10px] mb-1 block">Signal</label>
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
              className="w-full bg-ink-soft border border-ink-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brass/60"
            >
              <option value="healthy">Healthy</option>
              <option value="watch">Watch</option>
              <option value="danger">Danger</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          {saveError && <p className="text-loss text-xs">{saveError}</p>}
          <div className="flex gap-2 pt-1">
            <button
              onClick={saveEdit}
              disabled={saving || !editVal.trim()}
              className="flex-1 py-1.5 text-xs font-medium rounded bg-brass/20 text-brass-soft border border-brass/40 hover:bg-brass/30 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="flex-1 py-1.5 text-xs rounded border border-ink-line text-paper-dim hover:text-paper transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`card p-4 flex flex-col gap-1.5 ${onClick ? "cursor-pointer hover:border-brass/40 transition-colors" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{ind.name}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge status={ind.status} />
          {ind.is_manual && (
            <button
              onClick={(e) => { e.stopPropagation(); startEdit(); }}
              className="text-paper-dim hover:text-brass transition-colors"
              title="Update value"
            >
              <PencilIcon />
            </button>
          )}
          {onClick && (
            <svg className="w-3 h-3 text-paper-dim/50" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6,3 11,8 6,13" />
            </svg>
          )}
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        {ind.current_value != null ? (
          <>
            <p className="num text-xl">{formatValue(ind.current_value, ind.unit)}</p>
            <ChangeArrow change={ind.change_value} unit={ind.unit} />
          </>
        ) : (
          <p className="text-paper-dim text-sm italic">
            {ind.is_manual ? "No data — click pencil to enter" : "Pending refresh"}
          </p>
        )}
      </div>
      <p className="text-paper-dim text-xs leading-snug line-clamp-2">{ind.description}</p>
    </div>
  );
}

// Pure: compute suggested % per market asset using the chosen allocation method.
// Default: returns weights only for signal-favored keys (regime threshold ≥10%).
// RP modes: returns weights for ALL 8 market assets — same universe as the simulator.
function computeSuggestedPcts(regimeKey, method, assetData) {
  const dw = REGIME_DEFAULT_WEIGHTS[regimeKey] ?? {};

  if (method === "default" || !assetData) {
    const sk = getSignalKeys(regimeKey);
    return Object.fromEntries(sk.map((k) => [k, dw[k] ?? 0]));
  }

  // RP modes: run on all 7 non-cash market assets, return weights for all 8
  const cashPct = dw.cash ?? 0;
  const budget = 100 - cashPct;
  const riskAssets = assetData.assets.filter((a) => a.key !== "cash");

  if (!riskAssets.length) {
    return Object.fromEntries(assetData.assets.map((a) => [a.key, dw[a.key] ?? 0]));
  }

  let fractional;
  if (method === "equal") {
    fractional = Object.fromEntries(riskAssets.map((a) => [a.key, 1 / riskAssets.length]));
  } else if (method === "naive") {
    fractional = applyNaiveRiskParity(riskAssets);
  } else {
    const subCorr = Object.fromEntries(
      riskAssets.map((a) => [
        a.key,
        Object.fromEntries(
          riskAssets.map((b) => [
            b.key,
            assetData.corrMatrix[a.key]?.[b.key] ?? (a.key === b.key ? 1 : 0),
          ])
        ),
      ])
    );
    fractional = solveTrueRiskParity(riskAssets, subCorr);
  }

  const intW = toIntWeights(fractional, budget);
  const result = Object.fromEntries(riskAssets.map((a) => [a.key, intW[a.key] ?? 0]));
  result.cash = cashPct;
  return result;
}

function QuadrantCard({ indicators, holdings, assetData }) {
  const gdp = indicators.find((i) => i.name === "Real GDP Growth");
  const cpi = indicators.find((i) => i.name === "CPI (YoY)");
  const ism = indicators.find((i) => i.name === "ISM Manufacturing PMI");

  // Detect regime from live indicator values
  const regimeKey =
    gdp?.current_value != null && cpi?.current_value != null
      ? detectRegimeKey(Number(gdp.current_value), Number(cpi.current_value))
      : null;

  const regime = regimeKey ? REGIME_META[regimeKey] : null;
  const [allocMethod, setAllocMethod] = useState("default");

  const signalKeys = regimeKey ? getSignalKeys(regimeKey) : [];
  // RP methods show all 8 market assets (same universe as simulator);
  // Default shows only regime signal-favored keys (threshold ≥10%)
  const displayKeys = regimeKey
    ? (allocMethod === "default" || !assetData
      ? signalKeys
      : assetData.assets.map((a) => a.key))
    : [];
  const favoredSet = new Set(displayKeys);
  const suggestedPcts = regimeKey
    ? computeSuggestedPcts(regimeKey, allocMethod, assetData)
    : {};

  // Group holdings by resolved simulator key
  const byKey = {};
  let grandTotal = 0;
  for (const h of holdings ?? []) {
    const val = Number(h.current_value ?? 0);
    if (val <= 0) continue;
    const key = resolveSimulatorKey(h);
    if (!key) continue;
    if (!byKey[key]) byKey[key] = { holdings: [], total: 0 };
    byKey[key].holdings.push(h);
    byKey[key].total += val;
    grandTotal += val;
  }

  const pct = (val) => (grandTotal > 0 ? Math.round((val / grandTotal) * 100) : 0);

  // Favored buckets: displayKeys (all 8 market assets for RP, signal keys for Default)
  const favoredBuckets = displayKeys.map((k) => ({
    key: k,
    label: KEY_LABEL[k] ?? k,
    total: byKey[k]?.total ?? 0,
    pct: pct(byKey[k]?.total ?? 0),
    holdings: byKey[k]?.holdings ?? [],
  }));

  // Outside-signal buckets: portfolio weight in non-favored keys, sorted by weight desc
  const outsideBuckets = Object.entries(byKey)
    .filter(([k]) => !favoredSet.has(k))
    .map(([k, data]) => ({
      key: k,
      label: KEY_LABEL[k] ?? k,
      pct: pct(data.total),
      holdings: data.holdings,
    }))
    .sort((a, b) => b.pct - a.pct);

  const alignedPct = favoredBuckets.reduce((s, b) => s + b.pct, 0);
  const outsidePct = outsideBuckets.reduce((s, b) => s + b.pct, 0);
  const hasPortfolio = holdings && holdings.length > 0;

  return (
    <div className="card p-5 mb-6">
      <p className="label mb-3">Current Macro Regime</p>
      {regime ? (
        <div className="space-y-5">

          {/* Regime label + key indicators */}
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <p className={`text-2xl font-bold ${regime.color}`}>{regime.label}</p>
              <p className="text-paper-dim text-sm mt-1">{regime.desc}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                { name: "GDP Growth", value: gdp?.current_value, unit: "%" },
                { name: "CPI YoY",    value: cpi?.current_value, unit: "%" },
                { name: "ISM PMI",    value: ism?.current_value, unit: "index" },
              ].map(({ name, value, unit }) => (
                <div key={name} className="bg-ink-soft rounded-lg px-3 py-1.5">
                  <p className="label text-[10px]">{name}</p>
                  <p className="num text-sm">{formatValue(value, unit)}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Signal categories */}
          <div>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
              <p className="label">Positioning Signal — Favored Categories</p>
              <div className="flex items-center gap-0.5">
                {[
                  { k: "default", l: "Default" },
                  { k: "equal",   l: "Equal Wt" },
                  { k: "naive",   l: "Naive RP" },
                  { k: "true",    l: "True RP" },
                ].map((m) => (
                  <button
                    key={m.k}
                    onClick={() => setAllocMethod(m.k)}
                    disabled={m.k !== "default" && !assetData}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors disabled:opacity-30 ${
                      allocMethod === m.k
                        ? "bg-brass/20 text-brass-soft border border-brass/40"
                        : "text-paper-dim hover:text-paper"
                    }`}
                  >
                    {m.l}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {favoredBuckets.map((b) => (
                <div
                  key={b.key}
                  className={`rounded-lg border p-2.5 ${b.pct > 0 ? "bg-brass/10 border-brass/20" : "bg-ink-soft border-ink-line opacity-60"}`}
                >
                  <div className="flex items-center justify-between gap-1 mb-1.5">
                    <span className={`text-xs font-medium truncate ${b.pct > 0 ? "text-brass-soft" : "text-paper-dim"}`}>{b.label}</span>
                  </div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-[10px] text-paper-dim">Suggested</span>
                    <span className="num text-[10px] text-brass-soft">{suggestedPcts[b.key] ?? 0}%</span>
                  </div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-[10px] text-paper-dim">Portfolio</span>
                    <span className={`num text-[10px] ${b.pct > 0 ? "text-gain" : "text-paper-dim"}`}>
                      {b.pct > 0 ? `${b.pct}%` : "—"}
                    </span>
                  </div>
                  <p className="text-[10px] text-paper-dim truncate">
                    {b.holdings.length > 0
                      ? [b.holdings.slice(0, 3).map((h) => h.symbol).join(", "), b.holdings.length > 3 ? `+${b.holdings.length - 3}` : ""].filter(Boolean).join(" ")
                      : "no holdings"}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Outside-signal holdings */}
          <div>
            <p className="label mb-2">
              Outside Signal{outsideBuckets.length > 0 ? ` · ${outsidePct}% of portfolio` : ""}
            </p>
            {outsideBuckets.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {outsideBuckets.map((b) => (
                  <div key={b.key} className="rounded-lg border bg-loss/10 border-loss/20 p-2.5">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-xs font-medium text-loss/80 truncate">{b.label}</span>
                      <span className="num text-xs text-loss shrink-0">{b.pct}%</span>
                    </div>
                    <p className="text-[10px] text-paper-dim truncate">
                      {[b.holdings.slice(0, 3).map((h) => h.symbol).join(", "), b.holdings.length > 3 ? `+${b.holdings.length - 3}` : ""].filter(Boolean).join(" ")}
                    </p>
                  </div>
                ))}
              </div>
            ) : hasPortfolio ? (
              <p className="text-xs text-paper-dim">All classified holdings align with the current signal.</p>
            ) : (
              <p className="text-xs text-paper-dim">
                Set a simulator bucket on your holdings to see portfolio exposure here.
              </p>
            )}
          </div>

          {/* Alignment bar */}
          {hasPortfolio && (grandTotal > 0) && (
            <div>
              <div className="flex justify-between text-[10px] text-paper-dim mb-1">
                <span>Signal aligned <span className="num text-gain">{alignedPct}%</span></span>
                <span>Outside signal <span className="num text-loss">{outsidePct}%</span></span>
              </div>
              <div className="h-1.5 rounded-full bg-ink-line overflow-hidden flex">
                <div className="h-full bg-gain/60 transition-all" style={{ width: `${alignedPct}%` }} />
                <div className="h-full bg-loss/50 transition-all" style={{ width: `${outsidePct}%` }} />
              </div>
            </div>
          )}

        </div>
      ) : (
        <p className="text-paper-dim text-sm">
          {indicators.length === 0
            ? "No data yet — run the first data refresh."
            : "Regime unclear — run Refresh Data to populate GDP and CPI."}
        </p>
      )}
    </div>
  );
}

const DEBT_RANGES = [
  { label: "All", from: 1952 },
  { label: "2000–", from: 2000 },
  { label: "2010–", from: 2010 },
];

const CPI_PRESETS = [
  { label: "All",   from: "1958-01", to: "" },
  { label: "1990–", from: "1990-01", to: "" },
  { label: "2000–", from: "2000-01", to: "" },
  { label: "2010–", from: "2010-01", to: "" },
];

const EXP_RANGES = [
  { label: "All",   from: "1978-01-01" },
  { label: "2000–", from: "2000-01-01" },
  { label: "2013–", from: "2013-01-01" },
  { label: "2020–", from: "2020-01-01" },
];

function CloseIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <line x1="3" y1="3" x2="13" y2="13" />
      <line x1="13" y1="3" x2="3" y2="13" />
    </svg>
  );
}

function DebtTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const isChange = p.dataKey === "change";
        const formatted = isChange
          ? `${p.value >= 0 ? "+" : ""}${Number(p.value).toFixed(1)} pp`
          : `${Number(p.value).toFixed(1)}%`;
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
            <span className="num text-paper">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

function CpiTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-paper mb-1">{label?.slice(0, 7)}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const isAccel = p.dataKey === "coreAccel";
        const formatted = isAccel
          ? `${p.value >= 0 ? "+" : ""}${Number(p.value).toFixed(2)} pp`
          : `${Number(p.value).toFixed(2)}%`;
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
            <span className="num text-paper">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

function ExpTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[190px]">
      <p className="font-semibold text-paper mb-1">{label?.slice(0, 7)}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const isZ = p.dataKey === "compositeZ";
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.color }}>{p.name}</span>
            <span className="num text-paper">
              {isZ
                ? `${p.value >= 0 ? "+" : ""}${Number(p.value).toFixed(2)}σ`
                : `${Number(p.value).toFixed(2)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DebtGdpDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState(1952);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("macro_debt_cycle_computed")
      .select("year,debt_to_gdp_pct")
      .order("year")
      .then(({ data }) => setRows(data ?? []));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    const byYear = Object.fromEntries(rows.map((r) => [r.year, Number(r.debt_to_gdp_pct)]));
    return rows
      .filter((r) => r.year >= range && r.debt_to_gdp_pct != null)
      .map((r) => {
        const prev = byYear[r.year - 1];
        return {
          year: r.year,
          value: Number(r.debt_to_gdp_pct),
          change: prev != null ? Number(r.debt_to_gdp_pct) - prev : null,
        };
      });
  }, [rows, range]);

  const minVal = useMemo(() => chartData.length ? Math.floor(Math.min(...chartData.map((r) => r.value)) / 10) * 10 : 0, [chartData]);
  const maxVal = useMemo(() => chartData.length ? Math.ceil(Math.max(...chartData.map((r) => r.value)) / 10) * 10 : 400, [chartData]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[520px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">Total Debt / GDP</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Total nonfinancial debt as % of nominal GDP · Annual (FRED Z.1)</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className="num text-xl font-bold text-brass-soft leading-none">{formatValue(currentValue, "%")}</p>
                <p className="text-[10px] text-paper-dim mt-0.5">Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Range selector */}
          <div className="flex items-center gap-1">
            {DEBT_RANGES.map((r) => (
              <button
                key={r.from}
                onClick={() => setRange(r.from)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.from
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Chart */}
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Debt / GDP % · {range}–present</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="year"
                    type="number"
                    domain={[range, "dataMax"]}
                    allowDecimals={false}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => String(v)}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="left"
                    domain={[minVal, maxVal]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={44}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}pp`}
                    width={44}
                  />
                  <Tooltip content={<DebtTooltip />} />
                  <ReferenceLine yAxisId="left" y={300} stroke="#2A3240" strokeDasharray="4 2" strokeWidth={1} />
                  <ReferenceLine yAxisId="right" y={0} stroke="#2A3240" strokeWidth={1} />
                  <Bar yAxisId="right" dataKey="change" name="YoY Change" maxBarSize={12}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={entry.change == null ? "transparent" : entry.change >= 0 ? "#E0635C" : "#3FB984"}
                        fillOpacity={0.65}
                      />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="value"
                    name="Debt/GDP"
                    stroke="#C9A227"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Key levels legend */}
          <div className="card p-4 space-y-2">
            <p className="label text-[10px] mb-2">Context</p>
            {[
              { pct: "~160%", label: "Pre-GFC peak (2008)" },
              { pct: "~250%", label: "Post-COVID range (2020–)" },
              { pct: "300%", label: "Reference threshold" },
            ].map(({ pct, label }) => (
              <div key={label} className="flex items-center justify-between text-xs">
                <span className="text-paper-dim">{label}</span>
                <span className="num text-paper">{pct}</span>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: Federal Reserve Z.1 Financial Accounts · <span className="font-mono">macro_debt_cycle_computed</span>
          </p>
        </div>
      </div>
    </>
  );
}

function CoreCpiDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [fromDate, setFromDate] = useState("2000-01");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    if (!open || rows !== null) return;
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-cpi-history`)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    const from = fromDate ? `${fromDate}-01` : "1958-01-01";
    const to   = toDate   ? `${toDate}-01`   : "9999-12-01";
    return rows.filter((r) => r.date >= from && r.date <= to && r.coreYoy != null);
  }, [rows, fromDate, toDate]);

  const xTicks = useMemo(() => {
    const total = chartData.length;
    const stepYears = total > 300 ? 10 : total > 150 ? 5 : total > 60 ? 2 : 1;
    return chartData
      .filter((r) => {
        const yr = parseInt(r.date.slice(0, 4));
        return r.date.slice(5, 7) === "01" && yr % stepYears === 0;
      })
      .map((r) => r.date);
  }, [chartData]);

  const [minVal, maxVal] = useMemo(() => {
    if (!chartData.length) return [0, 10];
    const allYoy = chartData.flatMap((r) => [r.coreYoy, r.headlineYoy ?? r.coreYoy]);
    return [
      Math.min(0, Math.floor(Math.min(...allYoy))),
      Math.ceil(Math.max(...allYoy)) + 1,
    ];
  }, [chartData]);

  const summaryRows = useMemo(() => {
    if (!rows?.length) return [];
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const latest = rows[rows.length - 1];
    const result = [];

    if (latest.date.slice(5, 7) !== "12") {
      const mo = parseInt(latest.date.slice(5, 7)) - 1;
      const yr = latest.date.slice(0, 4);
      result.push({ label: `${MONTHS[mo]} ${yr}`, ...latest, isLatest: true });
    }

    const seen = new Set();
    for (let i = rows.length - 1; i >= 0 && seen.size < 5; i--) {
      const r = rows[i];
      if (r.date.slice(5, 7) === "12") {
        const yr = r.date.slice(0, 4);
        if (!seen.has(yr)) {
          seen.add(yr);
          result.push({ label: `Dec ${yr}`, ...r });
        }
      }
    }

    return result;
  }, [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[520px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">CPI History</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Core &amp; Headline · Monthly (FRED CPILFESL / CPIAUCSL)</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(currentValue) > 3 ? "text-loss" : Number(currentValue) < 2 ? "text-gain" : "text-brass-soft"}`}>
                  {formatValue(currentValue, "%")}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Core · Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="space-y-2">
            {/* Date range inputs */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-6">From</label>
                <input
                  type="month"
                  value={fromDate}
                  min="1958-01"
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark]"
                />
              </div>
              <span className="text-paper-dim text-xs shrink-0">→</span>
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-4">To</label>
                <input
                  type="month"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark] placeholder:text-paper-dim/50"
                />
              </div>
              {toDate && (
                <button
                  onClick={() => setToDate("")}
                  className="text-paper-dim hover:text-paper text-[10px] shrink-0"
                  title="Clear end date"
                >
                  ✕
                </button>
              )}
            </div>
            {/* Quick presets */}
            <div className="flex items-center gap-1">
              {CPI_PRESETS.map((p) => {
                const isActive = fromDate === p.from && toDate === p.to;
                return (
                  <button
                    key={p.label}
                    onClick={() => { setFromDate(p.from); setToDate(p.to); }}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                      isActive
                        ? "bg-ink text-brass-soft border border-brass/30"
                        : "text-paper-dim hover:text-paper"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">YoY % · monthly</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    type="category"
                    ticks={xTicks}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 4)}
                    interval={0}
                  />
                  <YAxis
                    yAxisId="left"
                    domain={[minVal, maxVal]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={36}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}`}
                    width={40}
                  />
                  <Tooltip content={<CpiTooltip />} />
                  <ReferenceLine yAxisId="left" y={2} stroke="#C9A227" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <ReferenceLine yAxisId="right" y={0} stroke="#2A3240" strokeWidth={1} />
                  <Bar yAxisId="right" dataKey="coreAccel" name="Core Accel." maxBarSize={6}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={(entry.coreAccel ?? 0) >= 0 ? "#E0635C" : "#3FB984"}
                        fillOpacity={0.55}
                      />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="headlineYoy"
                    name="Headline CPI"
                    stroke="#A8ADB8"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="coreYoy"
                    name="Core CPI"
                    stroke="#C9A227"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>

              {/* Legend */}
              <div className="flex items-center justify-center gap-5 mt-3 text-[10px] text-paper-dim">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[2px] bg-[#C9A227] rounded" />
                  Core CPI
                </span>
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="4" className="overflow-visible">
                    <line x1="0" y1="2" x2="20" y2="2" stroke="#A8ADB8" strokeWidth="1.5" strokeDasharray="5 3" />
                  </svg>
                  Headline CPI
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-flex gap-0.5">
                    <span className="inline-block w-2 h-3 rounded-sm" style={{ backgroundColor: "#E0635C", opacity: 0.55 }} />
                    <span className="inline-block w-2 h-3 rounded-sm" style={{ backgroundColor: "#3FB984", opacity: 0.55 }} />
                  </span>
                  Core Accel.
                </span>
              </div>
            </div>
          )}

          {/* 5-year summary table */}
          {summaryRows.length > 0 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Year-End Summary · last 5 years</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-paper-dim text-[10px]">
                    <th className="text-left pb-2 font-medium">Period</th>
                    <th className="text-right pb-2 font-medium">Core CPI</th>
                    <th className="text-right pb-2 font-medium">Headline CPI</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((r) => (
                    <tr key={r.label} className={`border-t border-ink-line/50 ${r.isLatest ? "text-paper" : "text-paper-dim"}`}>
                      <td className="py-1.5">
                        {r.label}
                        {r.isLatest && (
                          <span className="ml-1.5 text-[9px] text-brass-soft border border-brass/30 rounded px-1 py-0.5">Latest</span>
                        )}
                      </td>
                      <td className={`py-1.5 text-right num ${Number(r.coreYoy) > 3 ? "text-loss" : Number(r.coreYoy) < 2 ? "text-gain" : "text-brass-soft"}`}>
                        {r.coreYoy != null ? `${Number(r.coreYoy).toFixed(2)}%` : "—"}
                      </td>
                      <td className={`py-1.5 text-right num ${r.headlineYoy != null ? (Number(r.headlineYoy) > 3 ? "text-loss" : Number(r.headlineYoy) < 2 ? "text-gain" : "text-brass-soft") : "text-paper-dim"}`}>
                        {r.headlineYoy != null ? `${Number(r.headlineYoy).toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: BLS · FRED <span className="font-mono">CPILFESL</span> / <span className="font-mono">CPIAUCSL</span>
          </p>
        </div>
      </div>
    </>
  );
}

function ConsumerExpectationsDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState("2013-01-01");

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("consumer_expectations")
      .select("survey_date, michigan_inf_exp_1yr, nyfed_inf_exp_1yr, nyfed_delinquency_prob, composite_stress_z")
      .order("survey_date")
      .then(({ data }) => setRows(data ?? []));
  }, [open, rows]);

  const stats = useMemo(() => {
    if (!rows?.length) return null;
    const mn = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const sd = (arr, mu) => Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1)) || 1;
    const michVals    = rows.filter(r => r.michigan_inf_exp_1yr != null && r.survey_date >= "2013-01-01").map(r => Number(r.michigan_inf_exp_1yr));
    const nyfedInfVals = rows.filter(r => r.nyfed_inf_exp_1yr     != null).map(r => Number(r.nyfed_inf_exp_1yr));
    const nyfedDVals  = rows.filter(r => r.nyfed_delinquency_prob != null).map(r => Number(r.nyfed_delinquency_prob));
    if (!michVals.length) return null;
    const muM  = mn(michVals);  const sdM  = sd(michVals, muM);
    const muNI = nyfedInfVals.length ? mn(nyfedInfVals) : 0;
    const sdNI = nyfedInfVals.length ? sd(nyfedInfVals, muNI) : 1;
    const muND = nyfedDVals.length  ? mn(nyfedDVals)   : 0;
    const sdND = nyfedDVals.length  ? sd(nyfedDVals, muND)   : 1;
    return { muM, sdM, muNI, sdNI, muND, sdND };
  }, [rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter(r => r.survey_date >= range)
      .map(r => ({
        date:       r.survey_date,
        michInf:    r.michigan_inf_exp_1yr != null ? Number(r.michigan_inf_exp_1yr) : null,
        nyfedInf:   r.nyfed_inf_exp_1yr    != null ? Number(r.nyfed_inf_exp_1yr)   : null,
        compositeZ: r.composite_stress_z   != null ? Number(r.composite_stress_z)  : null,
      }));
  }, [rows, range]);

  const xTicks = useMemo(() =>
    chartData.filter(r => r.date.slice(5, 7) === "01").map(r => r.date),
  [chartData]);

  const tableRows = useMemo(() => {
    if (!rows || !stats) return [];
    const r2 = (n) => Math.round(n * 100) / 100;
    const z  = (v, mu, s) => v != null ? r2((Number(v) - mu) / s) : null;
    return [...rows].reverse()
      .map(r => ({
        date:        r.survey_date.slice(0, 7),
        michInf:     r.michigan_inf_exp_1yr   != null ? Number(r.michigan_inf_exp_1yr)   : null,
        nyfedInf:    r.nyfed_inf_exp_1yr      != null ? Number(r.nyfed_inf_exp_1yr)      : null,
        nyfedDelinq: r.nyfed_delinquency_prob != null ? Number(r.nyfed_delinquency_prob) : null,
        composite:   r.composite_stress_z     != null ? Number(r.composite_stress_z)     : null,
        zM:  z(r.michigan_inf_exp_1yr,   stats.muM,  stats.sdM),
        zNI: z(r.nyfed_inf_exp_1yr,      stats.muNI, stats.sdNI),
        zND: z(r.nyfed_delinquency_prob, stats.muND, stats.sdND),
      }))
      .filter(r => r.michInf != null || r.nyfedInf != null || r.nyfedDelinq != null);
  }, [rows, stats]);

  const thresholds = useMemo(() => {
    if (!rows?.length) return { p50: 0, p80: 0.5 };
    const vals = rows
      .filter(r => r.composite_stress_z != null)
      .map(r => Number(r.composite_stress_z))
      .sort((a, b) => a - b);
    if (!vals.length) return { p50: 0, p80: 0.5 };
    return {
      p50: vals[Math.floor(vals.length * 0.50)],
      p80: vals[Math.floor(vals.length * 0.80)],
    };
  }, [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[580px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">Consumer Inflation Expectations</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Michigan Survey (MICH) · NY Fed SCE · 1-year ahead · delinquency probability</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(currentValue) > 3.5 ? "text-loss" : Number(currentValue) > 2.5 ? "text-brass-soft" : "text-gain"}`}>
                  {formatValue(currentValue, "%")}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Michigan · Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="flex items-center gap-1">
            {EXP_RANGES.map((r) => (
              <button
                key={r.from}
                onClick={() => setRange(r.from)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.from
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">1-Yr Inflation Expectation &amp; Delinquency Risk · monthly</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    type="category"
                    ticks={xTicks}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 4)}
                    interval={0}
                  />
                  <YAxis
                    yAxisId="inf"
                    domain={[0, "auto"]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={36}
                  />
                  <YAxis
                    yAxisId="z"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(1)}σ`}
                    width={40}
                  />
                  <Tooltip content={<ExpTooltip />} />
                  <ReferenceLine yAxisId="inf" y={2}   stroke="#C9A227" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.4} />
                  <ReferenceLine yAxisId="z" y={thresholds.p50} stroke="#3FB984" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <ReferenceLine yAxisId="z" y={thresholds.p80} stroke="#E0635C" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <Line yAxisId="inf" type="monotone" dataKey="michInf"  name="Michigan 1yr" stroke="#C9A227" strokeWidth={2}   dot={false} connectNulls />
                  <Line yAxisId="inf" type="monotone" dataKey="nyfedInf" name="NY Fed 1yr"   stroke="#A8ADB8" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
                  <Bar yAxisId="z" dataKey="compositeZ" name="Stress Index z" maxBarSize={8}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={
                          entry.compositeZ == null ? "transparent" :
                          entry.compositeZ > thresholds.p80 ? "#E0635C" :
                          entry.compositeZ > thresholds.p50 ? "#C9A227" :
                          "#3FB984"
                        }
                        fillOpacity={0.85}
                      />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center justify-center gap-5 mt-3 text-[10px] text-paper-dim flex-wrap">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[2px] bg-[#C9A227] rounded" />
                  Michigan 1yr
                </span>
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="4" className="overflow-visible">
                    <line x1="0" y1="2" x2="20" y2="2" stroke="#A8ADB8" strokeWidth="1.5" strokeDasharray="4 2" />
                  </svg>
                  NY Fed 1yr
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-4 h-3 rounded-sm bg-[#E0635C] opacity-85" />
                  <span className="inline-block w-4 h-3 rounded-sm bg-[#C9A227] opacity-85" />
                  <span className="inline-block w-4 h-3 rounded-sm bg-[#3FB984] opacity-85" />
                  Stress Index z (right)
                </span>
              </div>
            </div>
          )}

          {rows !== null && tableRows.length > 0 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Historical Readings with Z-Scores · newest first</p>
              <div className="grid text-[10px] text-paper-dim pb-1.5 mb-1.5 border-b border-ink-line pr-1" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
                <span>Date</span>
                <span className="text-right">Mich%</span>
                <span className="text-right">z(M)</span>
                <span className="text-right">NYFed%</span>
                <span className="text-right">z(NY)</span>
                <span className="text-right">Delinq%</span>
                <span className="text-right">z(D)</span>
                <span className="text-right text-[#E0635C]/80">Stress z</span>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                {tableRows.map((r) => (
                  <div key={r.date} className="grid items-center text-[10px]" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
                    <span className="text-paper-dim">{r.date}</span>
                    <span className={`num text-right ${r.michInf == null ? "text-paper-dim" : r.michInf > 3.5 ? "text-loss" : r.michInf < 2 ? "text-gain" : "text-brass-soft"}`}>
                      {r.michInf != null ? `${r.michInf.toFixed(1)}%` : "—"}
                    </span>
                    <span className={`num text-right ${r.zM == null ? "text-paper-dim" : Math.abs(r.zM) <= 1 ? "text-paper-dim" : r.zM > 1 ? "text-loss" : "text-gain"}`}>
                      {r.zM != null ? `${r.zM >= 0 ? "+" : ""}${r.zM.toFixed(2)}` : "—"}
                    </span>
                    <span className={`num text-right ${r.nyfedInf == null ? "text-paper-dim" : r.nyfedInf > 3.5 ? "text-loss" : r.nyfedInf < 2 ? "text-gain" : "text-brass-soft"}`}>
                      {r.nyfedInf != null ? `${r.nyfedInf.toFixed(1)}%` : "—"}
                    </span>
                    <span className={`num text-right ${r.zNI == null ? "text-paper-dim" : Math.abs(r.zNI) <= 1 ? "text-paper-dim" : r.zNI > 1 ? "text-loss" : "text-gain"}`}>
                      {r.zNI != null ? `${r.zNI >= 0 ? "+" : ""}${r.zNI.toFixed(2)}` : "—"}
                    </span>
                    <span className={`num text-right ${r.nyfedDelinq == null ? "text-paper-dim" : r.nyfedDelinq > 13 ? "text-loss" : r.nyfedDelinq > 11 ? "text-brass-soft" : "text-gain"}`}>
                      {r.nyfedDelinq != null ? `${r.nyfedDelinq.toFixed(1)}%` : "—"}
                    </span>
                    <span className={`num text-right ${r.zND == null ? "text-paper-dim" : Math.abs(r.zND) <= 1 ? "text-paper-dim" : r.zND > 1 ? "text-loss" : "text-gain"}`}>
                      {r.zND != null ? `${r.zND >= 0 ? "+" : ""}${r.zND.toFixed(2)}` : "—"}
                    </span>
                    <span className={`num text-right font-medium ${r.composite == null ? "text-paper-dim" : r.composite > thresholds.p80 ? "text-loss" : r.composite > thresholds.p50 ? "text-brass-soft" : "text-gain"}`}>
                      {r.composite != null ? `${r.composite >= 0 ? "+" : ""}${r.composite.toFixed(2)}` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4 space-y-2">
            <p className="label text-[10px] mb-2">Stress Index Thresholds · data-derived from full history</p>
            {[
              { label: "Watch threshold (50th pct)", val: `${thresholds.p50 >= 0 ? "+" : ""}${thresholds.p50.toFixed(2)}σ`, note: "above median → watch" },
              { label: "Danger threshold (80th pct)", val: `${thresholds.p80 >= 0 ? "+" : ""}${thresholds.p80.toFixed(2)}σ`, note: "top quintile → danger" },
              { label: "Michigan baseline avg (2013–)", val: "~3.3%", note: "modern-era anchor" },
              { label: "Fed inflation target", val: "2.0%", note: "PCE basis" },
            ].map(({ label, val, note }) => (
              <div key={label} className="flex items-center justify-between text-xs">
                <div>
                  <span className="text-paper-dim">{label}</span>
                  <span className="text-paper-dim/50 ml-1.5 text-[10px]">{note}</span>
                </div>
                <span className="num text-paper shrink-0">{val}</span>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Sources: U of Michigan / FRED <span className="font-mono">MICH</span> · NY Federal Reserve Bank Survey of Consumer Expectations
          </p>
        </div>
      </div>
    </>
  );
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

export default function MacroDashboard() {
  const [indicators, setIndicators] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [portfolioHoldings, setPortfolioHoldings] = useState([]);
  const [assetData, setAssetData] = useState(null);
  const [debtDrawerOpen, setDebtDrawerOpen] = useState(false);
  const [cpiDrawerOpen, setCpiDrawerOpen] = useState(false);
  const [consumerExpOpen, setConsumerExpOpen] = useState(false);

  const fetchIndicators = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("macro_indicators")
      .select("*")
      .order("sort_order", { ascending: true });
    if (err) setError(err.message);
    else setIndicators(data ?? []);
  }, []);

  useEffect(() => { fetchIndicators(); }, [fetchIndicators]);

  useEffect(() => { getAssetData().then(setAssetData).catch(() => {}); }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase
        .from("holdings_valued")
        .select("id, symbol, name, simulator_key, asset_type, current_value")
        .eq("user_id", user.id);
      setPortfolioHoldings(data ?? []);
    });
  }, []);

  async function refreshData() {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/fetch-macro-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? `Refresh failed (${res.status})`);
      else await fetchIndicators();
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const byLayer = [1, 2, 3, 4].reduce((acc, l) => {
    acc[l] = (indicators ?? []).filter((i) => i.layer === l);
    return acc;
  }, {});

  const counts = (indicators ?? []).reduce(
    (acc, i) => { acc[i.status ?? "unknown"] = (acc[i.status ?? "unknown"] ?? 0) + 1; return acc; },
    { healthy: 0, watch: 0, danger: 0, unknown: 0 }
  );

  const lastFetched = (indicators ?? [])
    .map((i) => i.last_fetched_at)
    .filter(Boolean)
    .sort()
    .pop();

  const timeAgo = (iso) => {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    if (h > 23) return `${Math.floor(h / 24)}d ago`;
    if (h > 0) return `${h}h ${m}m ago`;
    return `${m}m ago`;
  };

  const manualCount = (indicators ?? []).filter((i) => i.is_manual && i.current_value == null).length;

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Macro Dashboard</h1>
          {lastFetched && <p className="label mt-0.5">Updated {timeAgo(lastFetched)}</p>}
        </div>
        <button
          onClick={refreshData}
          disabled={refreshing}
          className="px-4 py-1.5 text-sm rounded-lg border border-brass/40 text-brass-soft hover:bg-brass/10 disabled:opacity-50 transition-colors"
        >
          {refreshing ? "Refreshing…" : "Refresh Data"}
        </button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-loss/10 border border-loss/20 text-loss text-sm">
          {error}
        </div>
      )}

      {manualCount > 0 && (
        <div className="mb-5 px-4 py-3 rounded-lg bg-brass/5 border border-brass/20 text-brass-soft text-sm flex items-center gap-2">
          <PencilIcon />
          <span>{manualCount} manual indicator{manualCount !== 1 ? "s" : ""} need values — click the pencil icon on those cards to enter them.</span>
        </div>
      )}

      {indicators === null ? (
        <p className="text-paper-dim text-sm py-12 text-center">Loading…</p>
      ) : (
        <>
          <QuadrantCard indicators={indicators} holdings={portfolioHoldings} assetData={assetData} />

          <div className="grid grid-cols-3 gap-3 mb-8">
            {[
              { key: "healthy", label: "Healthy", style: STATUS_STYLE.healthy },
              { key: "watch",   label: "Watch",   style: STATUS_STYLE.watch },
              { key: "danger",  label: "Danger",  style: STATUS_STYLE.danger },
            ].map(({ key, label, style }) => (
              <div key={key} className={`card p-4 text-center border ${style.border}`}>
                <p className={`text-3xl font-bold ${style.text}`}>{counts[key] ?? 0}</p>
                <p className="label mt-1">{label}</p>
              </div>
            ))}
          </div>

          {[1, 2, 3, 4].map((layer) => (
            <div key={layer} className="mb-10">
              <div className="flex items-center gap-3 mb-3">
                <span className="w-6 h-6 rounded-full bg-ink-soft flex items-center justify-center text-xs font-bold text-paper-dim">
                  {layer}
                </span>
                <h2 className="text-sm font-semibold text-paper-dim uppercase tracking-wider">
                  {LAYER_NAMES[layer]}
                </h2>
              </div>

              {/* Dalio risk gauges sit above Layer 1 indicator cards */}
              {layer === 1 && <DalioGauges />}

              {byLayer[layer].length === 0 ? (
                <p className="text-paper-dim text-sm ml-9">No data yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {byLayer[layer].map((ind) => (
                    <IndicatorCard
                      key={ind.id}
                      ind={ind}
                      onSave={fetchIndicators}
                      onClick={
                          ind.name === "Total Debt / GDP" ? () => setDebtDrawerOpen(true)
                          : ind.name === "Core CPI (YoY)" ? () => setCpiDrawerOpen(true)
                          : ind.name === "Consumer Inflation Expectations" ? () => setConsumerExpOpen(true)
                          : undefined
                        }
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Three Forces — long-cycle historical chart */}
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-6 h-6 rounded-full bg-ink-soft flex items-center justify-center text-xs font-bold text-paper-dim">
                ∞
              </span>
              <div>
                <h2 className="text-sm font-semibold text-paper-dim uppercase tracking-wider">
                  Three Forces — Long Cycle
                </h2>
                <p className="label text-[10px] mt-0.5">Debt · Productivity · Short-term Credit Cycle · 1952–2026</p>
              </div>
            </div>
            <div className="card p-5">
              <ThreeForcesChart />
            </div>
          </div>
        </>
      )}
      <DebtGdpDrawer
        open={debtDrawerOpen}
        onClose={() => setDebtDrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "Total Debt / GDP")?.current_value}
      />
      <CoreCpiDrawer
        open={cpiDrawerOpen}
        onClose={() => setCpiDrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "Core CPI (YoY)")?.current_value}
      />
      <ConsumerExpectationsDrawer
        open={consumerExpOpen}
        onClose={() => setConsumerExpOpen(false)}
        currentValue={indicators?.find((i) => i.name === "Consumer Inflation Expectations")?.current_value}
      />
    </Shell>
  );
}
