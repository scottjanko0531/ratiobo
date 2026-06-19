"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";

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
  watch: { text: "text-brass", bg: "bg-brass/10", border: "border-brass/20" },
  danger: { text: "text-loss", bg: "bg-loss/10", border: "border-loss/20" },
  unknown: { text: "text-paper-dim", bg: "bg-ink-soft", border: "border-ink-line" },
};

function formatValue(v, unit) {
  if (v == null) return "—";
  const n = Number(v);
  if (isNaN(n)) return "—";
  if (unit === "%") return n.toFixed(2) + "%";
  if (unit === "$B") return "$" + n.toFixed(1) + "B";
  if (unit === "$M") return "$" + (n / 1_000_000).toFixed(2) + "T";
  if (unit === "K") return n.toFixed(0) + "K";
  if (unit === "z-score") return n.toFixed(3);
  if (unit === "index") return n.toFixed(1);
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
    <span
      className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full border ${st.text} ${st.bg} ${st.border}`}
    >
      {s.toUpperCase()}
    </span>
  );
}

function IndicatorCard({ ind }) {
  return (
    <div className="card p-4 flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{ind.name}</p>
        <StatusBadge status={ind.status} />
      </div>
      <div className="flex items-baseline gap-2">
        <p className="num text-xl">{formatValue(ind.current_value, ind.unit)}</p>
        <ChangeArrow change={ind.change_value} unit={ind.unit} />
      </div>
      <p className="text-paper-dim text-xs leading-snug line-clamp-2">{ind.description}</p>
    </div>
  );
}

function QuadrantCard({ indicators }) {
  const gdp = indicators.find((i) => i.name === "Real GDP Growth");
  const cpi = indicators.find((i) => i.name === "CPI (YoY)");

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
                { name: "CPI YoY", value: cpi?.current_value, unit: "%" },
              ].map(({ name, value, unit }) => (
                <div key={name} className="bg-ink-soft rounded-lg px-3 py-1.5">
                  <p className="label text-[10px]">{name}</p>
                  <p className="num text-sm">{formatValue(value, unit)}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="label mb-2">Positioning Signal</p>
            <div className="flex flex-wrap gap-2">
              {q.assets.map((a) => (
                <span
                  key={a}
                  className="px-2.5 py-1 rounded-lg bg-brass/10 border border-brass/20 text-brass-soft text-xs font-medium"
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-paper-dim text-sm">
          {indicators.length === 0
            ? "No data yet — run the first data refresh."
            : "Quadrant signals unclear — GDP or CPI data missing."}
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

  const fetchIndicators = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("macro_indicators")
      .select("*")
      .order("sort_order", { ascending: true });
    if (err) setError(err.message);
    else setIndicators(data ?? []);
  }, []);

  useEffect(() => { fetchIndicators(); }, [fetchIndicators]);

  async function refreshData() {
    setRefreshing(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/fetch-macro-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Refresh failed (${res.status})`);
      } else {
        await fetchIndicators();
      }
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

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Macro Dashboard</h1>
          {lastFetched && (
            <p className="label mt-0.5">Updated {timeAgo(lastFetched)}</p>
          )}
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

      {indicators === null ? (
        <p className="text-paper-dim text-sm py-12 text-center">Loading…</p>
      ) : (
        <>
          <QuadrantCard indicators={indicators} />

          {/* Status summary */}
          <div className="grid grid-cols-3 gap-3 mb-8">
            {[
              { key: "healthy", label: "Healthy", style: STATUS_STYLE.healthy },
              { key: "watch", label: "Watch", style: STATUS_STYLE.watch },
              { key: "danger", label: "Danger", style: STATUS_STYLE.danger },
            ].map(({ key, label, style }) => (
              <div key={key} className={`card p-4 text-center border ${style.border}`}>
                <p className={`text-3xl font-bold ${style.text}`}>{counts[key] ?? 0}</p>
                <p className="label mt-1">{label}</p>
              </div>
            ))}
          </div>

          {/* Layers */}
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
                    <IndicatorCard key={ind.id} ind={ind} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </Shell>
  );
}
