"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import {
  ResponsiveContainer, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";
import { SIMULATOR_KEYS, resolveSimulatorKey, REGIME_META } from "../../lib/simulatorKeys";
import HoldingDetailDrawer from "../../components/HoldingDetailDrawer";

const usd = (v) => {
  if (v == null || isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtPct = (v, digits = 2) => {
  if (v == null || isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
};

const gainCls = (v) =>
  v == null ? "text-paper-dim" : Number(v) > 0 ? "text-gain" : Number(v) < 0 ? "text-loss" : "text-paper-dim";

function MonthlyGainTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload;
  if (entry?.gain == null) return null;
  const color = entry.gain >= 0 ? "#3FB984" : "#E0635C";
  return (
    <div className="bg-[#1B212B] border border-[#2A3240] rounded-lg px-3 py-2 text-xs shadow-lg space-y-1">
      <div className="text-[#A8ADB8] mb-0.5">{entry.label}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[#A8ADB8]">Gain/Loss</span>
        <span className="font-medium" style={{ color }}>{entry.gain > 0 ? "+" : ""}{usd(entry.gain)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[#A8ADB8]">Value</span>
        <span className="text-[#F6F4EE] font-medium">{usd(entry.value)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[#A8ADB8]">Cost Basis</span>
        <span className="text-[#F6F4EE] font-medium">{usd(entry.costBasis)}</span>
      </div>
    </div>
  );
}

export default function PortfoliosPage() {
  const [portfolios, setPortfolios]           = useState([]);
  const [phMap, setPhMap]                     = useState({}); // portfolio_id -> [holding_id]
  const [holdings, setHoldings]               = useState([]);
  const [accountMap, setAccountMap]           = useState({});
  const [snapMap, setSnapMap]                 = useState({});
  const [snapPriceMap, setSnapPriceMap]       = useState({}); // holding_id -> start-of-day price
  const [periodSnaps, setPeriodSnaps]         = useState({ month: {}, qtr: {}, year: {} });
  const [allTransactions, setAllTransactions] = useState([]);
  const [assetTypes, setAssetTypes]           = useState([]);
  const [txnTypes, setTxnTypes]               = useState([]);
  const [busy, setBusy]                       = useState(true);
  const [analysisMap, setAnalysisMap]         = useState({}); // portfolio_id -> latest analysis row
  const [analysisRunningId, setAnalysisRunningId] = useState(null);

  const [detailHolding, setDetailHolding]     = useState(null);

  const [viewingPortfolio, setViewingPortfolio] = useState(null);
  const [expandedBuckets, setExpandedBuckets]   = useState(new Set()); // empty = all collapsed
  const [editingPortfolio, setEditingPortfolio] = useState(null); // "new" | portfolio obj
  const [form, setForm]     = useState({ portfolio_name: "", description: "", strategy_detail: "", target_allocations: {}, rebalance_band_pct: 5, strategy_framework: "" });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");

  // ── Data load ────────────────────────────────────────────────────────────────
  async function load() {
    setBusy(true);
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    const ds    = (d) => d.toISOString().slice(0, 10);
    const sub   = (d, n) => { const r = new Date(d); r.setDate(r.getDate() - n); return r; };
    const monthSnap = ds(sub(new Date(now.getFullYear(), now.getMonth(), 1), 1));
    const qtrSnap   = ds(sub(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1), 1));
    const yearSnap  = `${now.getFullYear() - 1}-12-31`;
    const toMap     = (rows) => { const m = {}; for (const r of rows ?? []) m[r.holding_id] = Number(r.market_value ?? 0); return m; };

    const [
      { data: pfData },
      { data: phData },
      { data: hvData },
      { data: acData },
      { data: snaps },
      { data: txns },
      { data: mo },
      { data: qtr },
      { data: yr },
      { data: atData },
      { data: ttData },
    ] = await Promise.all([
      supabase.from("portfolios").select("*").order("portfolio_name"),
      supabase.from("portfolio_holdings").select("portfolio_id, holding_id"),
      supabase.from("holdings_valued").select("*"),
      supabase.from("accounts").select("id, name"),
      supabase.from("portfolio_snapshots").select("holding_id, market_value, price").eq("snapshot_date", today),
      supabase.from("transactions").select("holding_id, txn_type, txn_date, amount, is_reinvested"),
      supabase.rpc("snapshot_at", { snap_date: monthSnap }),
      supabase.rpc("snapshot_at", { snap_date: qtrSnap }),
      supabase.rpc("snapshot_at", { snap_date: yearSnap }),
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("transaction_types").select("code, label, affects_quantity").eq("is_active", true).order("sort_order"),
    ]);

    setPortfolios(pfData ?? []);

    const pm = {};
    for (const ph of phData ?? []) {
      if (!pm[ph.portfolio_id]) pm[ph.portfolio_id] = [];
      pm[ph.portfolio_id].push(ph.holding_id);
    }
    setPhMap(pm);
    setHoldings(hvData ?? []);

    const am = {};
    for (const a of acData ?? []) am[a.id] = a.name;
    setAccountMap(am);

    const sm = {}, sp = {};
    for (const s of snaps ?? []) {
      sm[s.holding_id] = Number(s.market_value ?? 0);
      if (s.price != null) sp[s.holding_id] = Number(s.price);
    }
    setSnapMap(sm);
    setSnapPriceMap(sp);

    setPeriodSnaps({ month: toMap(mo), qtr: toMap(qtr), year: toMap(yr) });
    setAllTransactions(txns ?? []);
    setAssetTypes(atData ?? []);
    setTxnTypes(ttData ?? []);
    setBusy(false);
    loadAnalyses();
  }

  // Latest analysis row per portfolio — ordered desc and reduced in JS since we only
  // need the newest row per portfolio_id, not a full history.
  async function loadAnalyses() {
    const { data } = await supabase
      .from("portfolio_daily_analysis")
      .select("*")
      .order("analysis_date", { ascending: false });
    const map = {};
    for (const row of data ?? []) {
      if (!map[row.portfolio_id]) map[row.portfolio_id] = row;
    }
    setAnalysisMap(map);
  }

  async function runPortfolioAnalysis(portfolioId) {
    setAnalysisRunningId(portfolioId);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/analyze-portfolio-health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolio_id: portfolioId }),
      });
      const row = await res.json();
      if (res.ok && row?.id) {
        setAnalysisMap((prev) => ({ ...prev, [portfolioId]: row }));
      }
    } catch (_) { /* best-effort */ }
    setAnalysisRunningId(null);
  }

  useEffect(() => { load(); }, []);
  // Reset bucket expansion whenever a different portfolio is opened
  useEffect(() => { setExpandedBuckets(new Set()); }, [viewingPortfolio?.id]);

  const [regimeShifts, setRegimeShifts] = useState([]);
  useEffect(() => {
    if (!viewingPortfolio || viewingPortfolio.strategy_framework !== "regime_driven") { setRegimeShifts([]); return; }
    supabase
      .from("portfolio_regime_shifts")
      .select("*")
      .eq("portfolio_id", viewingPortfolio.id)
      .order("shifted_at", { ascending: false })
      .then(({ data }) => setRegimeShifts(data ?? []));
  }, [viewingPortfolio?.id, viewingPortfolio?.strategy_framework]);

  // Full per-holding snapshot history for the open portfolio, fetched on demand
  // (not part of the page's initial load, which only pulls today's row) — feeds
  // the monthly gain/loss chart below. cost_basis is pulled alongside market_value
  // so contributions/withdrawals can be netted out (see monthlyGainLoss).
  const [monthlySnapHistory, setMonthlySnapHistory] = useState([]);
  useEffect(() => {
    const ids = viewingPortfolio ? (phMap[viewingPortfolio.id] ?? []) : [];
    if (ids.length === 0) { setMonthlySnapHistory([]); return; }
    supabase
      .from("portfolio_snapshots")
      .select("holding_id, snapshot_date, market_value, cost_basis")
      .in("holding_id", ids)
      .order("snapshot_date")
      .then(({ data }) => setMonthlySnapHistory(data ?? []));
  }, [viewingPortfolio?.id, phMap]);

  // Month-end (or as-of-today for the current in-progress month) investment gain
  // checkpoints, diffed month over month for a gain/loss series. Investment gain
  // at a checkpoint = value - cost basis (unrealized P&L), not raw value — since
  // cost basis moves in lockstep with value on a pure contribution/withdrawal
  // (same $ added/removed from both), diffing this nets deposits/transfers out of
  // the bar, leaving only actual investment performance for that month.
  const monthlyGainLoss = useMemo(() => {
    if (monthlySnapHistory.length === 0) return [];
    const byHolding = {};
    for (const r of monthlySnapHistory) (byHolding[r.holding_id] ??= []).push(r);
    for (const arr of Object.values(byHolding)) arr.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

    const sumFieldAt = (field, asOf) => {
      let total = 0, found = 0;
      for (const arr of Object.values(byHolding)) {
        let v = null;
        for (const r of arr) { if (r.snapshot_date <= asOf) v = Number(r[field] ?? 0); else break; }
        if (v != null) { total += v; found++; }
      }
      return found > 0 ? total : null;
    };
    const netAt = (asOf) => {
      const value = sumFieldAt("market_value", asOf);
      const costBasis = sumFieldAt("cost_basis", asOf);
      return { value, costBasis, net: value != null && costBasis != null ? value - costBasis : null };
    };

    const minDate = new Date(monthlySnapHistory.reduce((min, r) => r.snapshot_date < min ? r.snapshot_date : min, monthlySnapHistory[0].snapshot_date));
    const today = new Date();
    const checkpoints = [];
    let cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    const lastMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    while (cursor <= lastMonth) {
      const y = cursor.getFullYear(), m = cursor.getMonth();
      const isCurrentMonth = y === today.getFullYear() && m === today.getMonth();
      const asOf = isCurrentMonth
        ? today.toISOString().slice(0, 10)
        : new Date(y, m + 1, 0).toISOString().slice(0, 10);
      checkpoints.push({ label: cursor.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), asOf });
      cursor = new Date(y, m + 1, 1);
    }

    return checkpoints.map((c, i) => {
      const cur = netAt(c.asOf);
      const prev = i === 0 ? null : netAt(checkpoints[i - 1].asOf);
      const gain = cur.net != null && prev?.net != null ? cur.net - prev.net : null;
      return { label: c.label, value: cur.value, costBasis: cur.costBasis, gain };
    });
  }, [monthlySnapHistory]);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const holdingsFor = useCallback((pfId) => {
    const ids = new Set(phMap[pfId] ?? []);
    return holdings.filter((h) => ids.has(h.id));
  }, [phMap, holdings]);

  function summary(pfId) {
    const hs = holdingsFor(pfId);
    if (hs.length === 0) return { totalValue: 0, costBasis: 0, totalGain: 0, returnPct: null, dayChg: null, monthChg: null, qtrChg: null, ytdChg: null, count: 0 };

    const totalValue = hs.reduce((s, h) => s + Number(h.current_value ?? 0), 0);
    const costBasis  = hs.reduce((s, h) => s + Number(h.cost_basis  ?? 0), 0);

    // Use pre-aggregated view columns — same formula as group rows
    const totalGain = hs.reduce((s, h) =>
      s + Number(h.net_gain ?? 0) + Number(h.total_dividends ?? 0) + Number(h.total_interest ?? 0) - Number(h.total_fees ?? 0), 0);
    const returnPct = costBasis > 0 ? (totalGain / costBasis) * 100 : null;

    const periodChg = (snap) => {
      let prev = 0, found = 0;
      for (const h of hs) { if (snap[h.id] != null) { prev += snap[h.id]; found++; } }
      return found > 0 ? totalValue - prev : null;
    };

    const dayChg = (() => {
      let prev = 0, found = 0;
      for (const h of hs) { if (snapMap[h.id] != null) { prev += snapMap[h.id]; found++; } }
      return found > 0 ? totalValue - prev : null;
    })();
    const dayChgPrev = dayChg != null ? totalValue - dayChg : null;
    const dayChgPct = dayChg != null && dayChgPrev > 0 ? (dayChg / dayChgPrev) * 100 : null;

    // ROI: gain on current value, distinct from returnPct (gain on cost basis) —
    // same convention as app/holdings/page.jsx's "Gain %" vs "ROI %" split.
    const roiPct = totalValue > 0 ? (totalGain / totalValue) * 100 : null;

    return {
      totalValue, costBasis, totalGain, returnPct, roiPct, count: hs.length,
      dayChg, dayChgPct, monthChg: periodChg(periodSnaps.month), qtrChg: periodChg(periodSnaps.qtr), ytdChg: periodChg(periodSnaps.year),
    };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  function openNew() {
    setForm({ portfolio_name: "", description: "", strategy_detail: "", target_allocations: {}, rebalance_band_pct: 5, strategy_framework: "" });
    setFormError("");
    setEditingPortfolio("new");
  }

  function openEdit(pf) {
    setForm({
      portfolio_name:     pf.portfolio_name,
      description:        pf.description        ?? "",
      strategy_detail:    pf.strategy_detail    ?? "",
      target_allocations: pf.target_allocations ?? {},
      rebalance_band_pct: pf.rebalance_band_pct ?? 5,
      strategy_framework: pf.strategy_framework ?? "",
    });
    setFormError("");
    setEditingPortfolio(pf);
  }

  async function savePortfolio() {
    if (!form.portfolio_name.trim()) { setFormError("Name is required."); return; }
    setFormBusy(true); setFormError("");
    const { data: { user } } = await supabase.auth.getUser();
    const wasRegimeDriven = editingPortfolio !== "new" && editingPortfolio.strategy_framework === "regime_driven";
    const nowRegimeDriven = form.strategy_framework === "regime_driven";
    const payload = {
      portfolio_name:     form.portfolio_name.trim(),
      description:        form.description.trim()  || null,
      strategy_detail:    form.strategy_detail.trim() || null,
      target_allocations: form.target_allocations,
      rebalance_band_pct: form.rebalance_band_pct === "" || form.rebalance_band_pct == null ? 5 : Number(form.rebalance_band_pct),
      strategy_framework: form.strategy_framework || null,
      updated_at:         new Date().toISOString(),
      // Turning regime-driven off releases manual control of target_allocations again;
      // turning it on (or switching regimes) resets tracking so the next daily cron
      // treats it as a fresh activation rather than resuming stale state.
      ...(wasRegimeDriven && !nowRegimeDriven ? { current_regime_key: null, regime_confirmed_since: null, pending_regime_key: null, pending_regime_since: null } : {}),
    };
    let error;
    if (editingPortfolio === "new") {
      ({ error } = await supabase.from("portfolios").insert({ ...payload, user_id: user.id }));
    } else {
      ({ error } = await supabase.from("portfolios").update(payload).eq("id", editingPortfolio.id));
      if (!error && viewingPortfolio?.id === editingPortfolio.id) {
        setViewingPortfolio((p) => ({ ...p, ...payload }));
      }
    }
    setFormBusy(false);
    if (error) { setFormError(error.message); return; }
    setEditingPortfolio(null);
    await load();
  }

  async function deletePortfolio(pf) {
    if (!confirm(`Delete "${pf.portfolio_name}"? Holdings will not be deleted.`)) return;
    await supabase.from("portfolios").delete().eq("id", pf.id);
    if (viewingPortfolio?.id === pf.id) setViewingPortfolio(null);
    load();
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Strategy Portfolios</h1>
            <p className="text-xs text-paper-dim mt-0.5">Group holdings into named strategies for focused tracking</p>
          </div>
          <button onClick={openNew} className="btn text-sm">+ New Portfolio</button>
        </div>

        {/* List */}
        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : portfolios.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-paper-dim text-sm mb-4">No portfolios yet.</p>
            <button onClick={openNew} className="btn text-sm">Create your first portfolio</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {portfolios.map((pf) => {
              const s = summary(pf.id);
              return (
                <button
                  key={pf.id}
                  onClick={() => setViewingPortfolio(pf)}
                  className="card p-4 text-left hover:border-brass/40 transition-colors w-full"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="font-semibold text-sm leading-tight">{pf.portfolio_name}</p>
                    <span className="label text-[10px] shrink-0 mt-0.5">{s.count} holdings</span>
                  </div>
                  {pf.description && (
                    <p className="text-xs text-paper-dim mb-3 line-clamp-2 leading-relaxed">{pf.description}</p>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3">
                    <div>
                      <p className="label text-[10px]">Total Value</p>
                      <p className="num text-sm font-medium">{s.count > 0 ? usd(s.totalValue) : "—"}</p>
                    </div>
                    <div>
                      <p className="label text-[10px]">Total Gain</p>
                      <p className={`num text-sm font-medium ${s.count > 0 ? gainCls(s.totalGain) : "text-paper-dim"}`}>
                        {s.count > 0 ? `${s.totalGain > 0 ? "+" : ""}${usd(s.totalGain)}` : "—"}
                        {s.count > 0 && s.returnPct != null && (
                          <span className="text-[10px] font-normal ml-1">({fmtPct(s.returnPct)})</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="label text-[10px]">ROI</p>
                      <p className={`num text-sm font-medium ${s.count > 0 ? gainCls(s.roiPct) : "text-paper-dim"}`}>
                        {s.count > 0 ? fmtPct(s.roiPct) : "—"}
                      </p>
                    </div>
                    {s.dayChg != null && (
                      <div>
                        <p className="label text-[10px]">Day Chg</p>
                        <p className={`num text-xs ${gainCls(s.dayChg)}`}>
                          {s.dayChg > 0 ? "+" : ""}{usd(s.dayChg)}
                          {s.dayChgPct != null && (
                            <span className="text-[10px] ml-1">({fmtPct(s.dayChgPct)})</span>
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Detail drawer ──────────────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${viewingPortfolio ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${viewingPortfolio ? "opacity-100" : "opacity-0"}`}
          onClick={() => setViewingPortfolio(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-[1400px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${viewingPortfolio ? "translate-x-0" : "translate-x-full"}`}>
          {viewingPortfolio && (() => {
            const pf = viewingPortfolio;
            const hs = holdingsFor(pf.id);
            const s  = summary(pf.id);

            const periodPct = (chg) => {
              if (chg == null) return null;
              const base = s.totalValue - chg;
              return base > 0 ? (chg / base) * 100 : null;
            };

            return (
              <>
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-4 border-b border-ink-line">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="font-semibold text-base">{pf.portfolio_name}</p>
                    {pf.description && <p className="text-xs text-paper-dim mt-0.5">{pf.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => openEdit(pf)} className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors">Edit</button>
                    <button onClick={() => setViewingPortfolio(null)} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
                  </div>
                </div>

                {/* Strategy detail */}
                {pf.strategy_detail && (
                  <div className="px-5 py-3 border-b border-ink-line bg-ink/30">
                    <p className="label text-[10px] mb-1">Strategy</p>
                    <p className="text-xs text-paper-dim leading-relaxed whitespace-pre-wrap">{pf.strategy_detail}</p>
                  </div>
                )}

                {/* Regime-driven status */}
                {pf.strategy_framework === "regime_driven" && (
                  <div className="px-5 py-3 border-b border-ink-line bg-ink/30">
                    <p className="label text-[10px] mb-1">Regime-Driven Targets</p>
                    {pf.current_regime_key ? (
                      <p className="text-xs text-paper-dim leading-relaxed">
                        Currently targeting <span className="text-paper font-medium">{REGIME_META[pf.current_regime_key]?.label ?? pf.current_regime_key}</span> weights
                        {pf.regime_confirmed_since && `, confirmed since ${pf.regime_confirmed_since}`}.
                        {pf.pending_regime_key && pf.pending_regime_key !== pf.current_regime_key && (
                          <span className="block mt-1 text-brass-soft">
                            Watching a shift to {REGIME_META[pf.pending_regime_key]?.label ?? pf.pending_regime_key} — confirms after 30 days if it persists (since {pf.pending_regime_since}).
                          </span>
                        )}
                      </p>
                    ) : (pf.target_allocations && Object.keys(pf.target_allocations).length > 0) ? (
                      <p className="text-xs text-paper-dim italic">Holding a neutral starting baseline — not yet tilted to a specific regime. Waiting for the Forward Signal to clear the 60% confidence floor before adopting regime-specific weights. Can sit here a while if the signal stays low-conviction.</p>
                    ) : (
                      <p className="text-xs text-paper-dim italic">Not yet activated — waiting for the Forward Signal to clear the 60% confidence floor before adopting a starting target. Can sit here a while if the signal stays low-conviction.</p>
                    )}
                    {regimeShifts.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-ink-line/50 space-y-1">
                        {regimeShifts.slice(0, 5).map((r) => (
                          <p key={r.id} className="text-[10px] text-paper-dim/70">
                            {r.shifted_at?.slice(0, 10)} — {r.from_label ? `${r.from_label} → ${r.to_label}` : `Activated at ${r.to_label}`}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Summary metrics */}
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-px border-b border-ink-line">
                  {[
                    { label: "Total Value", val: usd(s.totalValue), cls: "" },
                    { label: "Cost Basis",  val: usd(s.costBasis),  cls: "" },
                    { label: "Total Gain",  val: `${s.totalGain > 0 ? "+" : ""}${usd(s.totalGain)}`, cls: gainCls(s.totalGain) },
                    { label: "Return",      val: fmtPct(s.returnPct), cls: gainCls(s.returnPct) },
                  ].map(({ label, val, cls }) => (
                    <div key={label} className="px-3 py-3">
                      <p className="text-[10px] uppercase tracking-wide text-paper-dim mb-0.5">{label}</p>
                      <p className={`num text-sm font-medium ${cls}`}>{val}</p>
                    </div>
                  ))}
                  {[
                    { label: "Day Chg",  chg: s.dayChg },
                    { label: "Mo Chg",   chg: s.monthChg },
                    { label: "Qtr Chg",  chg: s.qtrChg },
                    { label: "YTD Chg",  chg: s.ytdChg },
                  ].map(({ label, chg }) => (
                    <div key={label} className="px-3 py-3">
                      <p className="text-[10px] uppercase tracking-wide text-paper-dim mb-0.5">{label}</p>
                      <p className={`num text-sm font-medium ${gainCls(chg)}`}>
                        {chg == null ? "—" : `${chg > 0 ? "+" : ""}${usd(chg)}`}
                      </p>
                      {chg != null && periodPct(chg) != null && (
                        <p className={`num text-[10px] ${gainCls(chg)}`}>{fmtPct(periodPct(chg))}</p>
                      )}
                    </div>
                  ))}
                </div>

                {/* Gains/Losses by Month */}
                <div className="px-5 py-4 border-b border-ink-line">
                  <p className="label text-[10px] mb-3">Investment Gains / Losses by Month</p>
                  {monthlyGainLoss.filter((m) => m.gain != null).length === 0 ? (
                    <div className="flex items-center justify-center h-[160px]">
                      <p className="text-paper-dim text-sm text-center">
                        {monthlySnapHistory.length === 0 ? "No snapshot history yet." : "Collecting data — check back next month."}
                      </p>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={monthlyGainLoss} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                        <XAxis
                          dataKey="label"
                          tick={{ fill: "#A8ADB8", fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: "#A8ADB8", fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          width={68}
                          tickFormatter={(v) => {
                            const abs = Math.abs(v);
                            const sign = v > 0 ? "+" : v < 0 ? "-" : "";
                            if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
                            if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
                            return `${sign}$${abs.toFixed(0)}`;
                          }}
                        />
                        <Tooltip content={<MonthlyGainTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                        <Bar dataKey="gain" maxBarSize={40} radius={[2, 2, 0, 0]}>
                          {monthlyGainLoss.map((entry, i) => (
                            <Cell
                              key={i}
                              fill={entry.gain == null ? "transparent" : entry.gain >= 0 ? "#3FB984" : "#E0635C"}
                              fillOpacity={0.7}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {/* Daily Analysis */}
                <div className="px-5 py-4 border-b border-ink-line">
                  {(() => {
                    const a = analysisMap[pf.id];
                    const running = analysisRunningId === pf.id;
                    const isStale = a && a.analysis_date !== new Date().toISOString().slice(0, 10);
                    return (
                      <>
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="label text-[10px]">Daily Analysis</p>
                            {a && (
                              <p className="text-[10px] text-paper-dim/60 mt-0.5">
                                {isStale ? `Last run ${a.analysis_date}` : "Updated today"}
                                {a.structural_regime && ` · ${a.structural_regime}${a.market_regime && a.market_regime !== a.structural_regime ? ` / ${a.market_regime}` : ""}`}
                                {a.nearterm_forward_confidence != null && ` · ${a.nearterm_forward_confidence}% near-term forward confidence`}
                                {a.rebalance_band_pct != null && ` · ±${a.rebalance_band_pct}pt rebalance band`}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => runPortfolioAnalysis(pf.id)}
                            disabled={running}
                            className="px-3 py-1.5 rounded-lg text-xs border border-brass/40 text-brass-soft hover:bg-brass/10 disabled:opacity-50 transition-colors shrink-0"
                          >
                            {running ? "Running…" : a ? "Run Analysis" : "Run Analysis"}
                          </button>
                        </div>
                        {a ? (
                          <div className="space-y-2.5">
                            {a.analysis.split(/\n\n+/).map((block, i) => {
                              const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
                              const bulletLines = lines.filter((l) => /^[-*]\s+/.test(l));
                              const isBulletBlock = bulletLines.length >= 2 && bulletLines.length >= lines.length - 1;
                              if (!isBulletBlock) {
                                return <p key={i} className="text-xs text-paper-dim leading-relaxed">{block.trim()}</p>;
                              }
                              const leadIn = lines.filter((l) => !/^[-*]\s+/.test(l));
                              return (
                                <div key={i}>
                                  {leadIn.map((l, j) => (
                                    <p key={`lead-${j}`} className="text-xs text-paper-dim leading-relaxed mb-1.5">{l}</p>
                                  ))}
                                  <ul className="list-disc pl-4 space-y-1">
                                    {bulletLines.map((l, j) => (
                                      <li key={j} className="text-xs text-paper-dim leading-relaxed">{l.replace(/^[-*]\s+/, "")}</li>
                                    ))}
                                  </ul>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-paper-dim italic">
                            {running ? "Generating…" : "No analysis yet — runs automatically each morning, or click Run Analysis."}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>

                {/* Holdings grouped by simulator bucket */}
                <div className="px-5 py-4">
                  <p className="label mb-3">Holdings ({hs.length})</p>
                  {hs.length === 0 ? (
                    <div className="card p-6 text-center">
                      <p className="text-paper-dim text-sm">No holdings assigned yet.</p>
                      <p className="text-xs text-paper-dim mt-1">Open a holding from the Holdings page and assign it to this portfolio.</p>
                    </div>
                  ) : (() => {
                    // Group by BW simulator bucket in canonical order
                    const byKey = {};
                    for (const h of hs) {
                      const key = resolveSimulatorKey(h) ?? "unassigned";
                      if (!byKey[key]) byKey[key] = [];
                      byKey[key].push(h);
                    }
                    const groups = [
                      ...SIMULATOR_KEYS.map(({ key, label }) => ({ key, label, items: byKey[key] ?? [] })).filter(g => g.items.length > 0),
                      ...(byKey.unassigned?.length ? [{ key: "unassigned", label: "Unassigned", items: byKey.unassigned }] : []),
                    ];

                    // Total gain per holding = cap gain + dividends + interest - fees
                    const holdingTotalGain = (h) =>
                      Number(h.net_gain ?? 0) + Number(h.total_dividends ?? 0) + Number(h.total_interest ?? 0) - Number(h.total_fees ?? 0);
                    const holdingReturnPct = (h) => {
                      const cb = Number(h.cost_basis ?? 0);
                      return cb > 0 ? (holdingTotalGain(h) / cb) * 100 : null;
                    };

                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-ink-line">
                              <th className="label text-left font-medium py-2 pr-3">Symbol</th>
                              <th className="label text-left font-medium py-2 pr-3">Account</th>
                              <th className="label text-right font-medium py-2 pr-2">Value</th>
                              <th className="label text-right font-medium py-2 pr-2">Cost Basis</th>
                              <th className="label text-right font-medium py-2 pr-2">Total Gain</th>
                              <th className="label text-right font-medium py-2 pr-2">Return %</th>
                              <th className="label text-right font-medium py-2 pr-2">Exp. Income</th>
                              <th className="label text-right font-medium py-2 pr-2">Day Chg</th>
                              <th className="label text-right font-medium py-2">Day Chg %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {groups.map(({ key, label, items }) => {
                              const groupValue     = items.reduce((sum, h) => sum + Number(h.current_value ?? 0), 0);
                              const groupCost      = items.reduce((sum, h) => sum + Number(h.cost_basis ?? 0), 0);
                              const groupPct       = s.totalValue > 0 ? (groupValue / s.totalValue) * 100 : 0;
                              const groupTotalGain = items.reduce((sum, h) => sum + holdingTotalGain(h), 0);
                              const groupReturnPct = groupCost > 0 ? (groupTotalGain / groupCost) * 100 : null;
                              const groupDayChgItems = items.filter(h => snapMap[h.id] != null);
                              const groupDayChg = groupDayChgItems.length > 0
                                ? groupDayChgItems.reduce((sum, h) => sum + Number(h.current_value ?? 0) - snapMap[h.id], 0)
                                : null;
                              const groupPrevValue = groupDayChgItems.reduce((sum, h) => sum + snapMap[h.id], 0);
                              const groupDayChgPct = groupDayChg != null && groupPrevValue > 0
                                ? (groupDayChg / groupPrevValue) * 100
                                : null;
                              const groupExpIncome = items.reduce((sum, h) => {
                                const y = h.dividend_yield ?? h.interest_rate;
                                return y != null ? sum + Number(h.current_value ?? 0) * Number(y) / 100 : sum;
                              }, 0);
                              const groupHasYield = items.some(h => h.dividend_yield != null || h.interest_rate != null);
                              const isExpanded     = expandedBuckets.has(key);
                              const toggle = () => setExpandedBuckets((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              });
                              const hasTargets = pf.target_allocations && Object.keys(pf.target_allocations).length > 0;
                              const targetPct  = hasTargets ? (Number(pf.target_allocations[key]) || 0) : null;
                              const diffPct    = targetPct != null ? groupPct - targetPct : null;
                              return [
                                /* Group header — clickable to expand/collapse */
                                <tr
                                  key={`g-${key}`}
                                  className="bg-ink/40 border-y border-ink-line cursor-pointer select-none hover:bg-ink/60 transition-colors"
                                  onClick={toggle}
                                >
                                  <td colSpan={2} className="py-1.5 pr-3">
                                    <div className="flex items-center gap-2.5">
                                      <svg
                                        className={`w-3 h-3 text-paper-dim shrink-0 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
                                        viewBox="0 0 12 12" fill="none"
                                      >
                                        <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                      </svg>
                                      <span className="label text-[11px] font-semibold text-brass-soft">{label}</span>
                                      <div className="relative flex-1 max-w-[100px] h-1.5 bg-ink-line rounded-full overflow-hidden">
                                        <div className="h-full bg-brass/60 rounded-full" style={{ width: `${Math.min(groupPct, 100)}%` }} />
                                        {targetPct != null && targetPct > 0 && (
                                          <div className="absolute inset-y-0 w-px bg-white/60" style={{ left: `${Math.min(targetPct, 100)}%` }} />
                                        )}
                                      </div>
                                      <span className="num text-[11px] font-semibold text-paper">{groupPct.toFixed(1)}%</span>
                                      {targetPct != null && (
                                        <span className={`text-[10px] tabular-nums ${
                                          diffPct >  2 ? "text-loss" :
                                          diffPct < -2 ? "text-gain" :
                                          "text-paper-dim"
                                        }`}>
                                          / {targetPct}% tgt
                                        </span>
                                      )}
                                      <span className="label text-[10px] text-paper-dim">{items.length} holding{items.length !== 1 ? "s" : ""}</span>
                                    </div>
                                  </td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] font-semibold">{usd(groupValue)}</td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] text-paper-dim">{usd(groupCost)}</td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupTotalGain)}`}>
                                    {groupTotalGain > 0 ? "+" : ""}{usd(groupTotalGain)}
                                  </td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupReturnPct)}`}>
                                    {fmtPct(groupReturnPct)}
                                  </td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] font-semibold text-brass-soft">
                                    {groupHasYield ? usd(groupExpIncome) : "—"}
                                  </td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupDayChg)}`}>
                                    {groupDayChg == null ? "—" : `${groupDayChg > 0 ? "+" : ""}${usd(groupDayChg)}`}
                                  </td>
                                  <td className={`num text-right py-1.5 text-[11px] font-semibold ${gainCls(groupDayChgPct)}`}>
                                    {groupDayChgPct == null ? "—" : `${groupDayChgPct > 0 ? "+" : ""}${groupDayChgPct.toFixed(2)}%`}
                                  </td>
                                </tr>,
                                /* Holding rows — only rendered when expanded */
                                ...(isExpanded ? items.map((h) => {
                                  const dayChg    = snapMap[h.id] != null ? Number(h.current_value ?? 0) - snapMap[h.id] : null;
                                  const snapPrice = snapPriceMap[h.id];
                                  const dayChgPct = dayChg != null && snapMap[h.id] > 0 ? (dayChg / snapMap[h.id]) * 100 : null;
                                  const tGain  = holdingTotalGain(h);
                                  const retPct = holdingReturnPct(h);
                                  const hYield = h.dividend_yield ?? h.interest_rate;
                                  const expIncome = hYield != null ? Number(h.current_value ?? 0) * Number(hYield) / 100 : null;
                                  return (
                                    <tr key={h.id} className="border-b border-ink-line/40 last:border-0 hover:bg-ink-soft/40 transition-colors cursor-pointer" onClick={() => setDetailHolding(h)}>
                                      <td className="py-2 pr-3 pl-5">
                                        <span className="font-medium">{h.symbol}</span>
                                        {h.name && <span className="block text-[10px] text-paper-dim leading-tight">{h.name}</span>}
                                      </td>
                                      <td className="py-2 pr-3 pl-3 text-paper-dim">{h.account_id ? (accountMap[h.account_id] ?? "—") : "—"}</td>
                                      <td className="num text-right py-2 pr-2">{usd(h.current_value)}</td>
                                      <td className="num text-right py-2 pr-2 text-paper-dim">{usd(h.cost_basis)}</td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(tGain)}`}>{tGain > 0 ? "+" : ""}{usd(tGain)}</td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(retPct)}`}>{fmtPct(retPct)}</td>
                                      <td className="num text-right py-2 pr-2 text-brass-soft">
                                        {expIncome != null ? usd(expIncome) : "—"}
                                      </td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(dayChg)}`}>
                                        {dayChg == null ? "—" : `${dayChg > 0 ? "+" : ""}${usd(dayChg)}`}
                                      </td>
                                      <td className={`num text-right py-2 ${gainCls(dayChgPct)}`}>
                                        {dayChgPct == null ? "—" : `${dayChgPct > 0 ? "+" : ""}${dayChgPct.toFixed(2)}%`}
                                      </td>
                                    </tr>
                                  );
                                }) : []),
                              ];
                            })}
                          </tbody>
                          <tfoot className="border-t-2 border-ink-line">
                            <tr>
                              <td colSpan={2} className="py-2 label text-[10px]">Total ({hs.length} holdings)</td>
                              <td className="num text-right py-2 pr-2 font-medium">{usd(s.totalValue)}</td>
                              <td className="num text-right py-2 pr-2 text-paper-dim">{usd(s.costBasis)}</td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.totalGain)}`}>
                                {s.totalGain > 0 ? "+" : ""}{usd(s.totalGain)}
                              </td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.returnPct)}`}>
                                {fmtPct(s.returnPct)}
                              </td>
                              <td className="num text-right py-2 pr-2 font-medium text-brass-soft">
                                {(() => {
                                  const total = hs.reduce((sum, h) => {
                                    const y = h.dividend_yield ?? h.interest_rate;
                                    return y != null ? sum + Number(h.current_value ?? 0) * Number(y) / 100 : sum;
                                  }, 0);
                                  return hs.some(h => h.dividend_yield != null || h.interest_rate != null) ? usd(total) : "—";
                                })()}
                              </td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.dayChg)}`}>
                                {s.dayChg == null ? "—" : `${s.dayChg > 0 ? "+" : ""}${usd(s.dayChg)}`}
                              </td>
                              <td className={`num text-right py-2 font-medium ${gainCls(s.dayChg)}`}>
                                {(() => {
                                  const prevTotal = hs.reduce((sum, h) => snapMap[h.id] != null ? sum + snapMap[h.id] : sum, 0);
                                  const pct = s.dayChg != null && prevTotal > 0 ? (s.dayChg / prevTotal) * 100 : null;
                                  return pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
                                })()}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* ── Create / Edit drawer ───────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-40 ${editingPortfolio ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingPortfolio ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingPortfolio(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${editingPortfolio ? "translate-x-0" : "translate-x-full"}`}>
          {editingPortfolio && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">{editingPortfolio === "new" ? "New portfolio" : "Edit portfolio"}</p>
                <button onClick={() => setEditingPortfolio(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>

              <div>
                <label className="label block mb-1.5">Portfolio name</label>
                <input
                  className="field"
                  placeholder="e.g. Dalio All Weather"
                  value={form.portfolio_name}
                  onChange={(e) => setForm((f) => ({ ...f, portfolio_name: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Description</label>
                <input
                  className="field"
                  placeholder="Short one-line summary"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Strategy detail</label>
                <textarea
                  className="field min-h-[140px] resize-y"
                  placeholder="Describe the investment thesis, allocation rules, or target weights…"
                  value={form.strategy_detail}
                  onChange={(e) => setForm((f) => ({ ...f, strategy_detail: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Strategy Framework</label>
                <select
                  className="field"
                  value={form.strategy_framework}
                  onChange={(e) => setForm((f) => ({ ...f, strategy_framework: e.target.value }))}
                >
                  <option value="">Auto-detect from strategy text (default)</option>
                  <option value="static">Static — regime-agnostic (e.g. All Weather, risk parity)</option>
                  <option value="tactical">Tactical — discretionary regime-responsive tilts</option>
                  <option value="regime_driven">Regime-driven — target allocations auto-follow the Forward Signal</option>
                </select>
                <p className="text-[10px] text-paper-dim/60 mt-1">
                  {form.strategy_framework === "regime_driven"
                    ? "Target Allocations below are managed automatically once saved — a daily job tracks the Forward Signal (6-18mo leading-indicator composite) and shifts targets only once a new regime has held 30 consecutive days AND Forward Signal confidence is at least 60% (avoids both whipsaw and low-conviction commitments). Manual edits below will be overwritten."
                    : "Determines how Daily Analysis reasons about rebalancing vs. tactical tilts. Leave on auto-detect unless you want it locked explicitly."}
                </p>
              </div>

              <div>
                <label className="label block mb-2">Target Allocations</label>
                {form.strategy_framework === "regime_driven" ? (
                  <div className="space-y-1 opacity-50 pointer-events-none">
                    {SIMULATOR_KEYS.filter(({ key }) => (form.target_allocations[key] ?? 0) > 0 || ["eq","intl","em","nb","tip","com","gld","cash"].includes(key)).map(({ key, label }) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-xs text-paper-dim flex-1">{label}</span>
                        <span className="field w-16 py-1 px-2 text-xs text-right block">{form.target_allocations[key] ?? 0}</span>
                        <span className="text-xs text-paper-dim w-3">%</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {SIMULATOR_KEYS.map(({ key, label }) => {
                      const val = form.target_allocations[key] ?? "";
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <span className="text-xs text-paper-dim flex-1">{label}</span>
                          <input
                            type="number" min="0" max="100" step="1"
                            className="field w-16 py-1 px-2 text-xs text-right"
                            placeholder="0"
                            value={val}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const n = raw === "" ? 0 : Math.max(0, Math.min(100, Number(raw)));
                              setForm((f) => ({
                                ...f,
                                target_allocations: { ...f.target_allocations, [key]: n },
                              }));
                            }}
                          />
                          <span className="text-xs text-paper-dim w-3">%</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {form.strategy_framework !== "regime_driven" && (() => {
                  const total = SIMULATOR_KEYS.reduce((s, { key }) => s + (Number(form.target_allocations[key]) || 0), 0);
                  const diff  = total - 100;
                  return (
                    <div className={`flex justify-between mt-2 pt-2 border-t border-ink-line text-xs font-medium ${Math.abs(diff) <= 1 ? "text-gain" : "text-loss"}`}>
                      <span>Total</span>
                      <span>{total}% {diff !== 0 ? `(${diff > 0 ? "+" : ""}${diff} from 100)` : "✓"}</span>
                    </div>
                  );
                })()}
              </div>

              <div>
                <label className="label block mb-1.5">Rebalance Band</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" max="50" step="0.5"
                    className="field w-20 py-1.5 px-2 text-xs"
                    value={form.rebalance_band_pct}
                    onChange={(e) => setForm((f) => ({ ...f, rebalance_band_pct: e.target.value }))}
                  />
                  <span className="text-xs text-paper-dim">points absolute, or 25% of a bucket's own target if larger — whichever tolerance is wider</span>
                </div>
                <p className="text-[10px] text-paper-dim/60 mt-1">Daily Analysis only recommends rebalancing a bucket once its drift from target exceeds this band.</p>
              </div>

              {formError && <p className="text-loss text-sm">{formError}</p>}

              <button className="btn w-full" onClick={savePortfolio} disabled={formBusy}>
                {formBusy ? "Saving…" : editingPortfolio === "new" ? "Create portfolio" : "Save changes"}
              </button>

              {editingPortfolio !== "new" && (
                <button
                  className="w-full px-3 py-2 text-sm rounded-lg text-paper-dim hover:text-loss border border-ink-line hover:border-loss/40 transition-colors"
                  onClick={() => { setEditingPortfolio(null); deletePortfolio(editingPortfolio); }}
                >
                  Delete portfolio
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <HoldingDetailDrawer
        holding={detailHolding}
        onClose={() => setDetailHolding(null)}
        snapMap={snapMap}
        accountMap={accountMap}
        assetTypes={assetTypes}
        txnTypes={txnTypes}
        holdings={holdings}
        onRefresh={load}
      />
    </Shell>
  );
}
