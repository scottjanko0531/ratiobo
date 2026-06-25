"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";
import ThreeForcesChart from "../../components/ThreeForcesChart";
import { LABEL_TO_KEYS, holdingsToWeights } from "../../lib/simulatorKeys";

const LAYER_NAMES = {
  1: "Long-term Debt Cycle",
  2: "Business Cycle",
  3: "Quadrant Positioning",
  4: "Tail Risk",
};

const QUADRANTS = {
  "growing-falling": {
    label: "Q1 — Goldilocks",
    description: "Accelerating growth + Falling inflation",
    color: "text-gain",
    assets: ["Equities", "Corporate Bonds", "Real Estate"],
  },
  "growing-rising": {
    label: "Q2 — Reflation",
    description: "Accelerating growth + Rising inflation",
    color: "text-brass",
    assets: ["Commodities", "TIPS", "EM Equities", "Energy"],
  },
  "contracting-falling": {
    label: "Q3 — Deflation",
    description: "Decelerating growth + Falling inflation",
    color: "text-paper-dim",
    assets: ["Nominal Bonds", "USD", "Cash", "Gold"],
  },
  "contracting-rising": {
    label: "Q4 — Stagflation",
    description: "Decelerating growth + Rising inflation",
    color: "text-loss",
    assets: ["Gold", "Hard Assets", "TIPS", "Short Duration"],
  },
};

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

function IndicatorCard({ ind, onSave }) {
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
    <div className="card p-4 flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{ind.name}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge status={ind.status} />
          {ind.is_manual && (
            <button
              onClick={startEdit}
              className="text-paper-dim hover:text-brass transition-colors"
              title="Update value"
            >
              <PencilIcon />
            </button>
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

function QuadrantCard({ indicators, portfolioWeights }) {
  const gdp = indicators.find((i) => i.name === "Real GDP Growth");
  const cpi = indicators.find((i) => i.name === "CPI (YoY)");
  const ism = indicators.find((i) => i.name === "ISM Manufacturing PMI");

  const growing = gdp?.current_value != null ? Number(gdp.current_value) > 0 : null;
  const risingInflation = cpi?.current_value != null ? Number(cpi.current_value) > 2.5 : null;

  let quadrantKey = null;
  if (growing != null && risingInflation != null) {
    quadrantKey = `${growing ? "growing" : "contracting"}-${risingInflation ? "rising" : "falling"}`;
  }

  const q = quadrantKey ? QUADRANTS[quadrantKey] : null;

  return (
    <div className="card p-5 mb-6">
      <p className="label mb-3">Current Macro Quadrant</p>
      {q ? (
        <div className="flex items-start justify-between flex-wrap gap-6">
          <div>
            <p className={`text-2xl font-bold ${q.color}`}>{q.label}</p>
            <p className="text-paper-dim text-sm mt-1">{q.description}</p>
            <div className="mt-3 flex flex-wrap gap-2">
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
          <div className="space-y-3">
            <div>
              <p className="label mb-2">Positioning Signal</p>
              <div className="flex flex-wrap gap-2">
                {q.assets.map((a) => {
                  const keys = LABEL_TO_KEYS[a] ?? [];
                  const exposure = portfolioWeights
                    ? keys.reduce((s, k) => s + (portfolioWeights[k] ?? 0), 0)
                    : null;
                  return (
                    <div key={a} className="flex flex-col items-center px-2.5 py-1.5 rounded-lg bg-brass/10 border border-brass/20 min-w-[72px]">
                      <span className="text-brass-soft text-xs font-medium">{a}</span>
                      {exposure != null && (
                        <span className={`text-[10px] num mt-0.5 ${exposure > 0 ? "text-gain" : "text-paper-dim"}`}>
                          {exposure > 0 ? `${exposure}%` : "—"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {portfolioWeights && (
              <p className="text-[10px] text-paper-dim">% = your portfolio weight in that category</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-paper-dim text-sm">
          {indicators.length === 0
            ? "No data yet — run the first data refresh."
            : "Quadrant signals unclear — run Refresh Data to populate GDP and CPI."}
        </p>
      )}
    </div>
  );
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

export default function MacroDashboard() {
  const [indicators, setIndicators] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [portfolioWeights, setPortfolioWeights] = useState(null);

  const fetchIndicators = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("macro_indicators")
      .select("*")
      .order("sort_order", { ascending: true });
    if (err) setError(err.message);
    else setIndicators(data ?? []);
  }, []);

  useEffect(() => { fetchIndicators(); }, [fetchIndicators]);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase
        .from("holdings_valued")
        .select("simulator_key, asset_type, current_value")
        .eq("user_id", user.id);
      const weights = holdingsToWeights(data ?? []);
      if (weights) setPortfolioWeights(weights);
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
          <QuadrantCard indicators={indicators} portfolioWeights={portfolioWeights} />

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
              {byLayer[layer].length === 0 ? (
                <p className="text-paper-dim text-sm ml-9">No data yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {byLayer[layer].map((ind) => (
                    <IndicatorCard key={ind.id} ind={ind} onSave={fetchIndicators} />
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
    </Shell>
  );
}
