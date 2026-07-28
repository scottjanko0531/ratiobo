"use client";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { supabase } from "../lib/supabase";
import { cashAmount, CASH_LEG_TYPES } from "../lib/cash";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const MARKET_TYPES = new Set(["equity", "etf", "closed_end_fund", "mutual_fund", "money_market", "bond", "crypto", "metal"]);
const TV_CHART_TYPES = new Set(["equity", "etf", "closed_end_fund", "crypto", "metal"]);
const METAL_TV_SYMBOLS = { XAU: "TVC:GOLD", XAG: "TVC:SILVER", XPT: "TVC:PLATINUM", XPD: "TVC:PALLADIUM" };

function getTVSymbol(symbol, assetType) {
  const s = (symbol ?? "").toUpperCase();
  if (assetType === "crypto") return `COINBASE:${s}USD`;
  if (assetType === "metal") return METAL_TV_SYMBOLS[s] ?? `TVC:${s}`;
  return s;
}

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="2.5" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="8" cy="13.5" r="1.3" />
    </svg>
  );
}

function EyeIcon({ open }) {
  return open ? (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M1 8c1.5-3.5 4-5 7-5s5.5 1.5 7 5c-1.5 3.5-4 5-7 5s-5.5-1.5-7-5z"/>
      <circle cx="8" cy="8" r="2"/>
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 2l12 12"/>
      <path d="M6.7 6.8A2 2 0 009.2 9.3M4.3 4.6C2.6 5.7 1.5 7 1.5 8c0 0 2 4.5 6.5 4.5 1.2 0 2.3-.3 3.2-.8M8.5 3.6C12.3 3.9 14.5 8 14.5 8s-.6 1.4-1.8 2.6"/>
    </svg>
  );
}

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="bg-[#1B212B] border border-[#2A3240] rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="text-[#A8ADB8] mb-0.5">{name}</p>
      <p className="text-[#F6F4EE] font-medium">
        {Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" })}
      </p>
    </div>
  );
}

const BLANK_ADD_FORM = () => ({
  txn_type: "", txn_date: new Date().toISOString().slice(0, 10),
  quantity: "", price_per_unit: "", amount: "", fees: "",
  reinvest: false, reinvest_quantity: "", reinvest_price: "", linked_holding_id: "",
});

export default function HoldingDetailDrawer({
  holding,       // null = closed
  onClose,
  snapMap,
  accountMap,
  assetTypes,
  txnTypes,
  holdings,      // all user holdings (for cash leg lookup)
  onRefresh,     // called after mutations
  onEditHolding, // optional: (holding) => void
}) {
  const [fresh, setFresh]               = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [txnBusy, setTxnBusy]           = useState(false);
  const [holdingHistory, setHoldingHistory] = useState([]);
  const [historyRange, setHistoryRange] = useState("all");
  const [showTVChart, setShowTVChart]   = useState(true);
  const [showHistory, setShowHistory]   = useState(true);
  const [showFilter, setShowFilter]     = useState(false);
  const [filterTypes, setFilterTypes]   = useState([]);

  const [addingTxn, setAddingTxn]       = useState(false);
  const [addForm, setAddForm]           = useState(BLANK_ADD_FORM());
  const [addError, setAddError]         = useState("");
  const [addBusy, setAddBusy]           = useState(false);

  const [menuOpenId, setMenuOpenId]     = useState(null);
  const [menuPos, setMenuPos]           = useState({ top: 0, left: 0 });
  const [editingTxn, setEditingTxn]     = useState(null);
  const [editForm, setEditForm]         = useState({ txn_type: "", txn_date: "", quantity: "", price_per_unit: "", amount: "", fees: "" });
  const [editError, setEditError]       = useState("");
  const [editBusy, setEditBusy]         = useState(false);

  const vh = fresh ?? holding;

  useEffect(() => {
    if (!holding) return;
    setFresh(null);
    setTransactions([]);
    setHoldingHistory([]);
    setShowFilter(false);
    setFilterTypes([]);
    setAddingTxn(false);
    setAddForm(BLANK_ADD_FORM());
    setEditingTxn(null);
    setShowTVChart(true);
    setShowHistory(true);
    setHistoryRange("all");
    loadDetail(holding);
  }, [holding?.id]);

  async function loadDetail(h) {
    setTxnBusy(true);
    const [{ data: txns }, { data: freshData }, { data: hist }] = await Promise.all([
      supabase.from("transactions")
        .select("id, txn_type, txn_date, quantity, price_per_unit, amount, fees, cash_holding_id, holding_id, is_reinvested")
        .or(`holding_id.eq.${h.id},cash_holding_id.eq.${h.id}`)
        .order("txn_date", { ascending: false }),
      supabase.from("holdings_valued")
        .select("id, symbol, name, asset_type, account_id, quantity, price_override, cost_basis, current_value, net_gain, net_gain_pct, market_price, simulator_key, interest_rate, maturity_date")
        .eq("id", h.id)
        .single(),
      supabase.from("portfolio_snapshots")
        .select("snapshot_date, market_value")
        .eq("holding_id", h.id)
        .order("snapshot_date", { ascending: true }),
    ]);
    setTransactions(txns ?? []);
    if (freshData) setFresh(freshData);
    setHoldingHistory(
      (hist ?? []).map((s) => ({
        date: s.snapshot_date,
        value: Number(s.market_value ?? 0),
        label: new Date(s.snapshot_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      }))
    );
    setTxnBusy(false);
  }

  async function saveAdd() {
    setAddBusy(true);
    setAddError("");
    const { data: { user } } = await supabase.auth.getUser();
    const isCash = vh.asset_type === "cash";
    const selectedType = (txnTypes ?? []).find((t) => t.code === addForm.txn_type);
    const amount = addForm.amount !== "" ? Number(addForm.amount) : null;
    const fees   = addForm.fees === "" ? 0 : Number(addForm.fees);
    const qty    = isCash ? amount : addForm.quantity === "" ? null : Number(addForm.quantity);
    const cashLeg =
      !isCash && vh.account_id && CASH_LEG_TYPES.has(addForm.txn_type)
        ? (holdings ?? []).find((h) => h.asset_type === "cash" && h.account_id === vh.account_id)
        : null;

    if (addForm.txn_type === "dividend" && addForm.reinvest && !isCash) {
      const reinvestQty   = Number(addForm.reinvest_quantity);
      const reinvestPrice = addForm.reinvest_price !== "" ? Number(addForm.reinvest_price) : null;
      const { error: divErr } = await supabase.from("transactions").insert({
        user_id: user.id, holding_id: vh.id, cash_holding_id: cashLeg?.id ?? null,
        txn_type: "dividend", txn_date: addForm.txn_date,
        quantity: null, price_per_unit: null, amount, fees: 0, is_reinvested: true,
      });
      if (divErr) { setAddBusy(false); setAddError(divErr.message); return; }
      const { error: buyErr } = await supabase.from("transactions").insert({
        user_id: user.id, holding_id: vh.id, cash_holding_id: null,
        txn_type: "buy", txn_date: addForm.txn_date,
        quantity: reinvestQty, price_per_unit: reinvestPrice, amount, fees: 0, is_reinvested: true,
      });
      if (buyErr) { setAddBusy(false); setAddError(buyErr.message); return; }
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", vh.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + reinvestQty }).eq("id", vh.id);
    } else if (addForm.txn_type === "transfer_out" || addForm.txn_type === "transfer_in") {
      const linked = addForm.linked_holding_id ? addForm.linked_holding_id : null;
      const pairedType = addForm.txn_type === "transfer_out" ? "transfer_in" : "transfer_out";
      const { error } = await supabase.from("transactions").insert({
        user_id: user.id, holding_id: vh.id, cash_holding_id: null,
        txn_type: addForm.txn_type, txn_date: addForm.txn_date,
        quantity: qty, price_per_unit: null, amount, fees,
      });
      if (error) { setAddBusy(false); setAddError(error.message); return; }
      const cashDelta = cashAmount(addForm.txn_type, amount, fees);
      if (cashDelta !== 0) {
        const { data: h } = await supabase.from("holdings").select("quantity").eq("id", vh.id).single();
        if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + cashDelta }).eq("id", vh.id);
      }
      if (linked) {
        const pairedDelta = cashAmount(pairedType, amount, 0);
        await supabase.from("transactions").insert({
          user_id: user.id, holding_id: linked, cash_holding_id: null,
          txn_type: pairedType, txn_date: addForm.txn_date,
          quantity: null, price_per_unit: null, amount, fees: 0,
        });
        const { data: lh } = await supabase.from("holdings").select("quantity").eq("id", linked).single();
        if (lh) await supabase.from("holdings").update({ quantity: Number(lh.quantity) + pairedDelta }).eq("id", linked);
      }
    } else {
      const { error } = await supabase.from("transactions").insert({
        user_id: user.id, holding_id: vh.id, cash_holding_id: cashLeg?.id ?? null,
        txn_type: addForm.txn_type, txn_date: addForm.txn_date,
        quantity: qty, price_per_unit: addForm.price_per_unit !== "" ? Number(addForm.price_per_unit) : null,
        amount, fees,
      });
      if (error) { setAddBusy(false); setAddError(error.message); return; }
      const delta = isCash ? cashAmount(addForm.txn_type, amount, fees) : (selectedType?.affects_quantity ?? 0) * (qty ?? 0);
      if (delta !== 0) {
        const { data: h } = await supabase.from("holdings").select("quantity").eq("id", vh.id).single();
        if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + delta }).eq("id", vh.id);
      }
      if (cashLeg) {
        const cashDelta = cashAmount(addForm.txn_type, amount, fees);
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", cashLeg.id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) + cashDelta }).eq("id", cashLeg.id);
      }
    }

    setAddBusy(false);
    setAddingTxn(false);
    setAddForm(BLANK_ADD_FORM());
    onRefresh?.();
    await loadDetail(vh);
  }

  function openEditTxn(txn) {
    setEditingTxn(txn);
    setEditForm({
      txn_type: txn.txn_type, txn_date: txn.txn_date,
      quantity:      txn.quantity      != null ? String(txn.quantity)      : "",
      price_per_unit: txn.price_per_unit != null ? String(txn.price_per_unit) : "",
      amount: txn.amount != null ? String(txn.amount) : "",
      fees:   txn.fees   != null ? String(txn.fees)   : "",
    });
    setEditError("");
    setMenuOpenId(null);
  }

  async function saveEdit() {
    setEditBusy(true); setEditError("");
    const isCash = vh.asset_type === "cash";
    const oldTxn = editingTxn;
    const newAmount = editForm.amount !== "" ? Number(editForm.amount) : null;
    const newFees   = editForm.fees   === "" ? 0 : Number(editForm.fees);
    const newQty    = isCash ? newAmount : editForm.quantity === "" ? null : Number(editForm.quantity);
    const affectsOld = (txnTypes ?? []).find((t) => t.code === oldTxn.txn_type)?.affects_quantity ?? 0;
    const affectsNew = (txnTypes ?? []).find((t) => t.code === editForm.txn_type)?.affects_quantity ?? 0;
    const oldDelta = isCash ? cashAmount(oldTxn.txn_type, oldTxn.amount, oldTxn.fees) : affectsOld * (Number(oldTxn.quantity) || 0);
    const newDelta = isCash ? cashAmount(editForm.txn_type, newAmount, newFees) : affectsNew * (newQty ?? 0);
    const netDelta = newDelta - oldDelta;
    if (netDelta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", vh.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + netDelta }).eq("id", vh.id);
    }
    if (oldTxn.cash_holding_id) {
      const netCash = cashAmount(editForm.txn_type, newAmount, newFees) - cashAmount(oldTxn.txn_type, oldTxn.amount, oldTxn.fees);
      if (netCash !== 0) {
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", oldTxn.cash_holding_id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) + netCash }).eq("id", oldTxn.cash_holding_id);
      }
    }
    const { error } = await supabase.from("transactions").update({
      txn_type: editForm.txn_type, txn_date: editForm.txn_date,
      quantity: newQty,
      price_per_unit: editForm.price_per_unit === "" ? null : Number(editForm.price_per_unit),
      amount: newAmount, fees: newFees,
    }).eq("id", oldTxn.id);
    setEditBusy(false);
    if (error) { setEditError(error.message); return; }
    setEditingTxn(null);
    onRefresh?.();
    await loadDetail(vh);
  }

  async function deleteTxn(txn) {
    setMenuOpenId(null);
    if (!confirm(`Delete this ${txn.txn_type} transaction from ${txn.txn_date}?`)) return;
    const isCash = vh.asset_type === "cash";
    const affects = (txnTypes ?? []).find((t) => t.code === txn.txn_type)?.affects_quantity ?? 0;
    const delta = isCash ? cashAmount(txn.txn_type, txn.amount, txn.fees) : affects * (Number(txn.quantity) || 0);
    if (delta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", vh.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) - delta }).eq("id", vh.id);
    }
    if (txn.cash_holding_id) {
      const cashDelta = cashAmount(txn.txn_type, txn.amount, txn.fees);
      if (cashDelta !== 0) {
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", txn.cash_holding_id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) - cashDelta }).eq("id", txn.cash_holding_id);
      }
    }
    await supabase.from("transactions").delete().eq("id", txn.id);
    onRefresh?.();
    await loadDetail(vh);
  }

  // Derived values
  const isCashView    = vh?.asset_type === "cash";
  const isLoan        = vh?.asset_type === "loan";
  const filteredTxns  = filterTypes.length === 0 ? transactions : transactions.filter((t) => filterTypes.includes(t.txn_type));
  const filtersActive = filterTypes.length > 0;

  const incomeTotal = (!isCashView && vh)
    ? transactions.filter((t) => (t.txn_type === "dividend" || t.txn_type === "interest") && !t.is_reinvested && t.holding_id === vh.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
      - transactions.filter((t) => t.txn_type === "fee" && t.holding_id === vh.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  const reinvestedDivs = (!isCashView && vh)
    ? transactions.filter((t) => t.txn_type === "dividend" && t.is_reinvested && t.holding_id === vh.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  const totalBuy = isLoan
    ? transactions.filter((t) => t.txn_type === "buy" && t.holding_id === vh?.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  const costBasisNum    = Number(vh?.cost_basis ?? 0);
  const origCostBasis   = costBasisNum - reinvestedDivs;
  const totalGain       = isLoan ? incomeTotal : Number(vh?.net_gain ?? 0) + reinvestedDivs + incomeTotal;
  const totalReturnPct  = isLoan
    ? (totalBuy > 0 ? totalGain / totalBuy * 100 : null)
    : (origCostBasis > 0 ? totalGain / origCostBasis * 100 : null);

  const selectedAddType = (txnTypes ?? []).find((t) => t.code === addForm.txn_type);
  const isUnitAdd       = selectedAddType?.affects_quantity !== 0 && selectedAddType != null && !isCashView;
  const isReinvestDiv   = addForm.txn_type === "dividend" && !isCashView;

  const HISTORY_RANGES = [
    { key: "1W", days: 7 }, { key: "1M", days: 30 }, { key: "3M", days: 90 },
    { key: "6M", days: 180 }, { key: "1Y", days: 365 }, { key: "all", days: null },
  ];
  const cutoffDays = HISTORY_RANGES.find((r) => r.key === historyRange)?.days;
  const cutoffDate = cutoffDays ? new Date(Date.now() - cutoffDays * 86400000).toISOString().slice(0, 10) : null;
  const visibleHistory = cutoffDate ? holdingHistory.filter((p) => p.date >= cutoffDate) : holdingHistory;

  if (!holding) return null;

  return (
    <>
      {/* Backdrop */}
      <div className={`fixed inset-0 z-30 ${holding ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${holding ? "opacity-100" : "opacity-0"}`}
          onClick={onClose}
        />
        {/* Panel */}
        <div className="absolute right-0 top-0 h-full w-full max-w-[1120px] bg-ink-soft border-l border-ink-line overflow-y-auto">
          {vh && (
            <>
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-ink-line">
                <div>
                  <p className="font-semibold text-base">
                    {vh.symbol}
                    {vh.name && <span className="font-normal text-paper-dim ml-2">{vh.name}</span>}
                  </p>
                  <p className="text-xs text-paper-dim mt-0.5">
                    {(assetTypes ?? []).find((a) => a.code === vh.asset_type)?.label ?? vh.asset_type}
                    {vh.account_id ? ` · ${(accountMap ?? {})[vh.account_id] ?? ""}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {onEditHolding && (
                    <button
                      onClick={() => onEditHolding(vh)}
                      className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    onClick={() => setShowFilter((f) => !f)}
                    className={`px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                      showFilter || filtersActive
                        ? "border-brass/60 text-brass-soft bg-ink-soft"
                        : "border-ink-line text-paper-dim hover:text-paper"
                    }`}
                  >
                    {filtersActive ? `Filter (${filterTypes.length})` : "Filter"}
                  </button>
                  <button
                    onClick={() => setAddingTxn(true)}
                    className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors"
                  >
                    + Add
                  </button>
                  <button onClick={onClose} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
                </div>
              </div>

              {/* Summary bar */}
              <div className="grid grid-cols-2 sm:grid-cols-8 gap-px border-b border-ink-line">
                {[
                  { label: "Qty",          val: Number(vh.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 }), cls: "" },
                  { label: "Cost Basis",   val: usd(vh.cost_basis), cls: "" },
                  { label: "Value",        val: usd(vh.current_value), cls: "" },
                  { label: "Price Gain",   val: `${Number(vh.net_gain ?? 0) > 0 ? "+" : ""}${usd(vh.net_gain)}`, cls: Number(vh.net_gain ?? 0) > 0 ? "text-gain" : Number(vh.net_gain ?? 0) < 0 ? "text-loss" : "" },
                  { label: "Income",       val: `${incomeTotal > 0 ? "+" : ""}${usd(incomeTotal)}`, cls: incomeTotal > 0 ? "text-gain" : "text-paper-dim" },
                  { label: "Total Gain",   val: `${totalGain > 0 ? "+" : ""}${usd(totalGain)}`, cls: totalGain > 0 ? "text-gain" : totalGain < 0 ? "text-loss" : "" },
                  { label: "Total Return", val: totalReturnPct == null ? "—" : `${totalReturnPct > 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`, cls: totalReturnPct == null ? "text-paper-dim" : totalReturnPct > 0 ? "text-gain" : totalReturnPct < 0 ? "text-loss" : "" },
                ].map(({ label, val, cls }) => (
                  <div key={label} className="px-3 py-3">
                    <p className="label text-[10px] mb-0.5 uppercase tracking-wide">{label}</p>
                    <p className={`num text-sm font-medium ${cls}`}>{val}</p>
                  </div>
                ))}
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Day Chg</p>
                  {(() => {
                    const snap = (snapMap ?? {})[vh.id];
                    if (snap == null) return <p className="num text-sm font-medium text-paper-dim">—</p>;
                    const dc = Number(vh.current_value ?? 0) - snap;
                    return <p className={`num text-sm font-medium ${dc > 0 ? "text-gain" : dc < 0 ? "text-loss" : ""}`}>{dc > 0 ? "+" : ""}{usd(dc)}</p>;
                  })()}
                </div>
              </div>

              {/* Charts */}
              <div className="border-b border-ink-line">
                {TV_CHART_TYPES.has(vh.asset_type) ? (
                  <div className="border-b border-ink-line">
                    <div className="flex items-center justify-between px-5 py-2.5">
                      <p className="label text-xs">Price chart</p>
                      <button onClick={() => setShowTVChart((v) => !v)} className={`p-1 rounded transition-colors ${showTVChart ? "text-paper hover:text-paper-dim" : "text-paper-dim hover:text-paper"}`} aria-label="Toggle chart">
                        <EyeIcon open={showTVChart} />
                      </button>
                    </div>
                    {showTVChart && (
                      <iframe
                        key={vh.symbol}
                        src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(getTVSymbol(vh.symbol, vh.asset_type))}&interval=D&theme=dark&style=1&locale=en&hide_top_toolbar=0&allow_symbol_change=0&save_image=0`}
                        width="100%" height="380" frameBorder="0" allowTransparency="true" scrolling="no"
                      />
                    )}
                  </div>
                ) : MARKET_TYPES.has(vh.asset_type) && (
                  <div className="border-b border-ink-line px-5 py-3">
                    <p className="label text-xs mb-0.5">Price chart</p>
                    <p className="text-xs text-paper-dim">Chart unavailable for this asset type.</p>
                  </div>
                )}

                {/* Value history */}
                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <p className="label text-xs">Holding value history</p>
                      <button onClick={() => setShowHistory((v) => !v)} className={`p-0.5 rounded transition-colors ${showHistory ? "text-paper hover:text-paper-dim" : "text-paper-dim hover:text-paper"}`} aria-label="Toggle history">
                        <EyeIcon open={showHistory} />
                      </button>
                    </div>
                    <div className="flex gap-0.5">
                      {HISTORY_RANGES.map((r) => (
                        <button key={r.key} onClick={() => setHistoryRange(r.key)} className={`px-2 py-0.5 text-xs rounded transition-colors ${historyRange === r.key ? "bg-ink text-brass-soft" : "text-paper-dim hover:text-paper"}`}>
                          {r.key === "all" ? "All" : r.key}
                        </button>
                      ))}
                    </div>
                  </div>
                  {showHistory && visibleHistory.length < 2 ? (
                    <p className="text-paper-dim text-xs py-4 text-center">
                      {holdingHistory.length === 0 ? "No snapshot history yet." : "No data for this range."}
                    </p>
                  ) : showHistory ? (
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={visibleHistory} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: "#A8ADB8", fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                        <YAxis tick={{ fill: "#A8ADB8", fontSize: 10 }} axisLine={false} tickLine={false} width={64}
                          tickFormatter={(v) => v >= 1_000_000 ? `$${(v/1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v/1_000).toFixed(0)}K` : `$${v}`}
                        />
                        <Tooltip content={<ChartTooltip />} />
                        <Line type="monotone" dataKey="value" name={vh.symbol} stroke="#C9A227" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#C9A227", stroke: "#1B212B", strokeWidth: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : null}
                </div>
              </div>

              {/* Transactions */}
              <div className="px-5 py-4">
                <div className="flex gap-5">
                  {showFilter && (
                    <div className="w-44 shrink-0 border-r border-ink-line pr-5 space-y-4">
                      <div>
                        <p className="label mb-2">Type</p>
                        <div className="space-y-1.5">
                          {[...new Set(transactions.map((t) => t.txn_type))].sort().map((code) => (
                            <label key={code} className="flex items-center gap-2 text-sm cursor-pointer">
                              <input type="checkbox" className="accent-brass"
                                checked={filterTypes.includes(code)}
                                onChange={() => setFilterTypes((prev) => prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code])}
                              />
                              {(txnTypes ?? []).find((t) => t.code === code)?.label ?? code}
                            </label>
                          ))}
                        </div>
                      </div>
                      {filtersActive && (
                        <button onClick={() => setFilterTypes([])} className="text-xs text-paper-dim hover:text-paper">Clear all</button>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="label mb-3">
                      Transactions{filtersActive ? ` · ${filteredTxns.length} of ${transactions.length}` : ""}
                    </p>
                    {txnBusy ? (
                      <p className="text-paper-dim text-sm">Loading…</p>
                    ) : transactions.length === 0 ? (
                      <p className="text-paper-dim text-sm">No transactions yet.</p>
                    ) : filteredTxns.length === 0 ? (
                      <p className="text-paper-dim text-sm">No transactions match the filter.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-ink-line">
                              <th className="w-8 py-2"></th>
                              <th className="label text-left font-medium py-2 pr-4">Date</th>
                              <th className="label text-left font-medium py-2 pr-4">Type</th>
                              <th className="label text-right font-medium py-2 pr-2">Qty</th>
                              <th className="label text-right font-medium py-2 pr-2">Price</th>
                              <th className="label text-right font-medium py-2 pr-2">Amount</th>
                              <th className="label text-right font-medium py-2">Fees</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredTxns.map((t) => {
                              const isLinked = t.holding_id !== vh?.id;
                              return (
                                <tr key={t.id} className="border-b border-ink-line/60 last:border-0">
                                  <td className="py-2.5">
                                    {!isLinked && (
                                      <button
                                        id={`txn-kebab-${t.id}`}
                                        onClick={() => {
                                          if (menuOpenId === t.id) { setMenuOpenId(null); return; }
                                          const rect = document.getElementById(`txn-kebab-${t.id}`)?.getBoundingClientRect();
                                          if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
                                          setMenuOpenId(t.id);
                                        }}
                                        className="p-1 rounded-lg text-paper-dim hover:text-paper hover:bg-ink-soft transition-colors"
                                      >
                                        <KebabIcon />
                                      </button>
                                    )}
                                    {!isLinked && menuOpenId === t.id && typeof document !== "undefined" && createPortal(
                                      <>
                                        <div className="fixed inset-0 z-[60]" onClick={() => setMenuOpenId(null)} />
                                        <div className="fixed z-[70] w-32 card p-1 shadow-lg" style={{ top: menuPos.top, left: menuPos.left }}>
                                          <button onClick={() => openEditTxn(t)} className="w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-ink-soft transition-colors">Edit</button>
                                          <button onClick={() => deleteTxn(t)} className="w-full text-left px-3 py-1.5 rounded-md text-sm text-loss hover:bg-ink-soft transition-colors">Delete</button>
                                        </div>
                                      </>,
                                      document.body
                                    )}
                                  </td>
                                  <td className="py-2.5 pr-4">{t.txn_date}</td>
                                  <td className="py-2.5 pr-4 label">{(txnTypes ?? []).find((tt) => tt.code === t.txn_type)?.label ?? t.txn_type}</td>
                                  <td className="num text-right py-2.5 pr-2">{t.quantity != null ? Number(t.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—"}</td>
                                  <td className="num text-right py-2.5 pr-2">{usd(t.price_per_unit)}</td>
                                  <td className="num text-right py-2.5 pr-2">{usd(t.amount)}</td>
                                  <td className="num text-right py-2.5">{usd(t.fees)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Add Transaction drawer */}
      <div className={`fixed inset-0 z-50 ${addingTxn ? "" : "pointer-events-none"}`}>
        <div className={`absolute inset-0 bg-ink/50 transition-opacity ${addingTxn ? "opacity-100" : "opacity-0"}`} onClick={() => setAddingTxn(false)} />
        <div className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${addingTxn ? "translate-x-0" : "translate-x-full"}`}>
          <div className="flex items-center justify-between">
            <p className="font-medium">Add transaction · {vh?.symbol}</p>
            <button onClick={() => setAddingTxn(false)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>
          <div>
            <label className="label block mb-1.5">Type</label>
            <select className="field" value={addForm.txn_type} onChange={(e) => setAddForm({ ...addForm, txn_type: e.target.value, linked_holding_id: "" })}>
              <option value="">Select…</option>
              {(txnTypes ?? []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </div>
          {(addForm.txn_type === "transfer_out" || addForm.txn_type === "transfer_in") && (
            <div>
              <label className="label block mb-1.5">{addForm.txn_type === "transfer_out" ? "Transfer to" : "Transfer from"}</label>
              <select className="field" value={addForm.linked_holding_id} onChange={(e) => setAddForm({ ...addForm, linked_holding_id: e.target.value })}>
                <option value="">None (manual entry only)</option>
                {(holdings ?? []).filter((h) => h.asset_type === "cash" && h.id !== vh?.id).map((h) => <option key={h.id} value={h.id}>{h.name || h.symbol}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label block mb-1.5">Date</label>
            <input className="field" type="date" value={addForm.txn_date} onChange={(e) => setAddForm({ ...addForm, txn_date: e.target.value })} />
          </div>
          {isUnitAdd && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label block mb-1.5">Quantity</label>
                <input className="field num" type="number" step="any" value={addForm.quantity} onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })} />
              </div>
              <div>
                <label className="label block mb-1.5">Price / unit</label>
                <input className="field num" type="number" step="any" value={addForm.price_per_unit} onChange={(e) => setAddForm({ ...addForm, price_per_unit: e.target.value })} />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5">Amount</label>
              <input className="field num" type="number" step="any" placeholder="0.00" value={addForm.amount} onChange={(e) => setAddForm({ ...addForm, amount: e.target.value })} />
            </div>
            <div>
              <label className="label block mb-1.5">Fees</label>
              <input className="field num" type="number" step="any" placeholder="0.00" value={addForm.fees} onChange={(e) => setAddForm({ ...addForm, fees: e.target.value })} />
            </div>
          </div>
          {isReinvestDiv && (
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" className="accent-brass w-4 h-4" checked={addForm.reinvest} onChange={(e) => setAddForm({ ...addForm, reinvest: e.target.checked })} />
                <span className="text-sm text-paper">Re-Invest dividend</span>
              </label>
              {addForm.reinvest && (
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className="label block mb-1.5">Shares purchased</label>
                    <input className="field num" type="number" step="any" placeholder="0.000" value={addForm.reinvest_quantity} onChange={(e) => setAddForm({ ...addForm, reinvest_quantity: e.target.value })} />
                  </div>
                  <div>
                    <label className="label block mb-1.5">Price / share</label>
                    <input className="field num" type="number" step="any" placeholder="optional" value={addForm.reinvest_price} onChange={(e) => setAddForm({ ...addForm, reinvest_price: e.target.value })} />
                  </div>
                </div>
              )}
            </div>
          )}
          {addError && <p className="text-loss text-sm">{addError}</p>}
          <button className="btn w-full" onClick={saveAdd} disabled={addBusy || !addForm.txn_type || !addForm.txn_date || (addForm.reinvest && !addForm.reinvest_quantity)}>
            {addBusy ? "Saving…" : "Record transaction"}
          </button>
        </div>
      </div>

      {/* Edit Transaction drawer */}
      <div className={`fixed inset-0 z-50 ${editingTxn ? "" : "pointer-events-none"}`}>
        <div className={`absolute inset-0 bg-ink/50 transition-opacity ${editingTxn ? "opacity-100" : "opacity-0"}`} onClick={() => setEditingTxn(null)} />
        <div className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${editingTxn ? "translate-x-0" : "translate-x-full"}`}>
          {editingTxn && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">Edit transaction</p>
                <button onClick={() => setEditingTxn(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>
              <div>
                <label className="label block mb-1.5">Type</label>
                <select className="field" value={editForm.txn_type} onChange={(e) => setEditForm({ ...editForm, txn_type: e.target.value })}>
                  {(txnTypes ?? []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label block mb-1.5">Date</label>
                <input className="field" type="date" value={editForm.txn_date} onChange={(e) => setEditForm({ ...editForm, txn_date: e.target.value })} />
              </div>
              {!isCashView && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label block mb-1.5">Quantity</label>
                    <input className="field num" type="number" step="any" value={editForm.quantity} onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })} />
                  </div>
                  <div>
                    <label className="label block mb-1.5">Price / unit</label>
                    <input className="field num" type="number" step="any" value={editForm.price_per_unit} onChange={(e) => setEditForm({ ...editForm, price_per_unit: e.target.value })} />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1.5">Amount</label>
                  <input className="field num" type="number" step="any" value={editForm.amount} onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })} />
                </div>
                <div>
                  <label className="label block mb-1.5">Fees</label>
                  <input className="field num" type="number" step="any" value={editForm.fees} onChange={(e) => setEditForm({ ...editForm, fees: e.target.value })} />
                </div>
              </div>
              {editError && <p className="text-loss text-sm">{editError}</p>}
              <button className="btn w-full" onClick={saveEdit} disabled={editBusy}>{editBusy ? "Saving…" : "Save changes"}</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
