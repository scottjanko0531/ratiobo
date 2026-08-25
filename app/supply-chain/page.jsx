"use client";
import { useEffect, useState, useMemo } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";
import SupplyChainDetailDrawer from "../../components/SupplyChainDetailDrawer";

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

const barColor = (status) => (status === "critical" ? "bg-loss" : status === "watch" ? "bg-brass" : "bg-gain");

export default function SupplyChainPage() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [detailItem, setDetailItem] = useState(null);

  async function load() {
    setBusy(true);
    const { data } = await supabase.from("supply_chain_items").select("*").eq("is_active", true).order("sort_order");
    setItems(data ?? []);
    setBusy(false);
  }

  useEffect(() => { load(); }, []);

  async function refreshNow() {
    setRefreshing(true);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/update-supply-chain-risk`, { method: "POST" });
    } catch (_) { /* best-effort */ }
    await load();
    setRefreshing(false);
  }

  const byCategory = useMemo(() => {
    const m = {};
    for (const it of items) {
      if (!m[it.category]) m[it.category] = [];
      m[it.category].push(it);
    }
    return m;
  }, [items]);

  const stats = useMemo(() => {
    const critical = items.filter((i) => i.current_status === "critical").length;
    const watch = items.filter((i) => i.current_status === "watch").length;
    const healthy = items.filter((i) => i.current_status === "healthy").length;
    const scores = items.filter((i) => i.current_score != null).map((i) => Number(i.current_score));
    const avg = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
    return { critical, watch, healthy, avg };
  }, [items]);

  const lastUpdated = useMemo(() => {
    const dates = items.filter((i) => i.updated_at).map((i) => new Date(i.updated_at).getTime());
    return dates.length ? new Date(Math.max(...dates)) : null;
  }, [items]);

  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-4">
          <div>
            <h1 className="text-xl font-semibold">Supply Chain Risk</h1>
            <p className="text-xs text-paper-dim mt-0.5">
              {items.length} tracked items{lastUpdated ? ` · updated ${lastUpdated.toLocaleString()}` : ""} · refreshed daily
            </p>
          </div>
          <button onClick={refreshNow} disabled={refreshing} className="btn text-sm shrink-0 disabled:opacity-50">
            {refreshing ? "Refreshing…" : "Refresh Now"}
          </button>
        </div>

        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : items.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-paper-dim text-sm">No data yet — click Refresh Now to generate the first assessment.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="card p-4">
                <p className="label text-[10px] mb-1">Critical</p>
                <p className="num text-2xl font-semibold text-loss">{stats.critical}</p>
              </div>
              <div className="card p-4">
                <p className="label text-[10px] mb-1">Watch</p>
                <p className="num text-2xl font-semibold text-brass-soft">{stats.watch}</p>
              </div>
              <div className="card p-4">
                <p className="label text-[10px] mb-1">Healthy</p>
                <p className="num text-2xl font-semibold text-gain">{stats.healthy}</p>
              </div>
              <div className="card p-4">
                <p className="label text-[10px] mb-1">Avg risk score</p>
                <p className="num text-2xl font-semibold">
                  {stats.avg ?? "—"}<span className="text-xs text-paper-dim font-normal">/100</span>
                </p>
              </div>
            </div>

            {Object.entries(byCategory).map(([category, catItems]) => (
              <div key={category} className="mb-6">
                <h2 className="text-sm font-semibold text-paper mb-3">{category}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {catItems.map((item) => {
                    const st = STATUS_META[item.current_status] ?? STATUS_META.watch;
                    const tr = TREND_META[item.current_trend];
                    return (
                      <button
                        key={item.id}
                        onClick={() => setDetailItem(item)}
                        className="card p-4 text-left hover:border-brass/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="font-medium text-sm">{item.name}</span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {item.risk_type && (
                              <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${
                                item.risk_type === "active" ? "text-loss border-loss/30 bg-loss/5" : "text-paper-dim border-ink-line"
                              }`}>
                                {item.risk_type === "active" ? "Active" : "Structural"}
                              </span>
                            )}
                            <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${st.bg} ${st.color}`}>{st.label}</span>
                          </div>
                        </div>
                        <div className="h-1.5 w-full bg-ink rounded overflow-hidden mb-2.5">
                          <div
                            className={`h-full ${barColor(item.current_status)}`}
                            style={{ width: `${Math.min(100, Math.max(0, item.current_score ?? 0))}%` }}
                          />
                        </div>
                        <p className="text-xs text-paper-dim leading-relaxed mb-2">
                          {item.summary}
                          {tr && <span className={`ml-1.5 ${tr.color}`}>{tr.icon}</span>}
                        </p>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                          <div><span className="text-paper-dim">Concentration </span><span className="text-paper">{item.concentration}</span></div>
                          <div><span className="text-paper-dim">Threat </span><span className="text-paper">{item.primary_threat}</span></div>
                          {item.tariff_cpi_impact_pp != null && (
                            <div className="col-span-2">
                              <span className="text-paper-dim">Est. CPI impact </span>
                              <span className="text-paper">{item.tariff_cpi_impact_pp >= 0 ? "+" : ""}{Number(item.tariff_cpi_impact_pp).toFixed(2)}pp</span>
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <SupplyChainDetailDrawer item={detailItem} onClose={() => setDetailItem(null)} />
    </Shell>
  );
}
