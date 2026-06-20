"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { supabase } from "../../lib/supabase";
import { cashAmount, CASH_LEG_TYPES } from "../../lib/cash";
import Shell from "../../components/Shell";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const MARKET_TYPES = new Set(["equity", "etf", "mutual_fund", "money_market", "bond", "crypto", "metal"]);
const MANUAL_PRICE_TYPES = new Set(["real_estate", "loan", "other"]);

const METAL_TV_SYMBOLS = { XAU: "TVC:GOLD", XAG: "TVC:SILVER", XPT: "TVC:PLATINUM", XPD: "TVC:PALLADIUM" };

function getTVSymbol(symbol, assetType) {
  const s = (symbol ?? "").toUpperCase();
  if (assetType === "crypto") return `COINBASE:${s}USD`;
  if (assetType === "metal") return METAL_TV_SYMBOLS[s] ?? `TVC:${s}`;
  return s; // equity, etf, mutual_fund, bond — TradingView resolves by ticker
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

export default function HoldingsPage() {
  const [holdings, setHoldings] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountMap, setAccountMap] = useState({});
  const [assetTypes, setAssetTypes] = useState([]);
  const [txnTypes, setTxnTypes] = useState([]);
  const [snapMap, setSnapMap] = useState({});
  const [error, setError] = useState("");

  // Filter
  const [showFilter, setShowFilter] = useState(false);
  const [filterAssetTypes, setFilterAssetTypes] = useState([]);
  const [filterAccounts, setFilterAccounts] = useState([]);

  // Holding kebab (main list)
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  // Add holding drawer
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ symbol: "", name: "", asset_type: "", account_id: "", quantity: "", cost_basis: "", price_override: "" });
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addLookupBusy, setAddLookupBusy] = useState(false);

  // Edit holding drawer
  const [editingHolding, setEditingHolding] = useState(null);
  const [editForm, setEditForm] = useState({ symbol: "", name: "", asset_type: "", account_id: "", quantity: "", price_override: "" });
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  // Detail / transactions drawer
  const [viewingHolding, setViewingHolding] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [txnBusy, setTxnBusy] = useState(false);
  const [showTVChart, setShowTVChart] = useState(true);
  const [showHoldingHistory, setShowHoldingHistory] = useState(true);
  const [holdingHistory, setHoldingHistory] = useState([]);
  const [historyRange, setHistoryRange] = useState("all");

  // Transaction filter
  const [showTxnFilter, setShowTxnFilter] = useState(false);
  const [filterTxnTypes, setFilterTxnTypes] = useState([]);

  // Add transaction drawer
  const [addingTxn, setAddingTxn] = useState(false);
  const [addTxnForm, setAddTxnForm] = useState({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "" });
  const [addTxnError, setAddTxnError] = useState("");
  const [addTxnBusy, setAddTxnBusy] = useState(false);

  // Transaction kebab + edit
  const [txnMenuOpenId, setTxnMenuOpenId] = useState(null);
  const [txnMenuPos, setTxnMenuPos] = useState({ top: 0, left: 0 });
  const [editingTxn, setEditingTxn] = useState(null);
  const [editTxnForm, setEditTxnForm] = useState({ txn_type: "", txn_date: "", quantity: "", price_per_unit: "", amount: "", fees: "" });
  const [editTxnError, setEditTxnError] = useState("");
  const [editTxnBusy, setEditTxnBusy] = useState(false);

  async function load() {
    const today = new Date().toISOString().slice(0, 10);
    const [
      { data: hv, error: hvErr },
      { data: ac },
      { data: at },
      { data: tt },
      { data: snaps }
    ] = await Promise.all([
      supabase.from("holdings_valued").select("*").order("asset_type").order("symbol"),
      supabase.from("accounts").select("id, name").order("name"),
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("transaction_types").select("code, label, affects_quantity").eq("is_active", true).order("sort_order"),
      supabase.from("portfolio_snapshots").select("holding_id, market_value").eq("snapshot_date", today)
    ]);
    if (hvErr) setError(hvErr.message);
    setHoldings(hv ?? []);
    setAccounts(ac ?? []);
    const aMap = {};
    for (const a of ac ?? []) aMap[a.id] = a.name;
    setAccountMap(aMap);
    setAssetTypes(at ?? []);
    setTxnTypes(tt ?? []);
    const sMap = {};
    for (const s of snaps ?? []) sMap[s.holding_id] = Number(s.market_value ?? 0);
    setSnapMap(sMap);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (menuOpenId === null) return;
    const close = () => setMenuOpenId(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [menuOpenId]);

  useEffect(() => {
    if (txnMenuOpenId === null) return;
    const close = () => setTxnMenuOpenId(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [txnMenuOpenId]);

  // ── Add holding ───────────────────────────────────────────────────────────
  async function lookupAddSymbol(symbol) {
    if (!symbol.trim()) return;
    setAddLookupBusy(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/lookup-symbol?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`
      );
      if (res.ok) {
        const data = await res.json();
        if (!data.error) {
          setAddForm((prev) => ({
            ...prev,
            name: prev.name || data.name || "",
            asset_type: prev.asset_type || data.asset_type || "",
          }));
        }
      }
    } catch (_) {}
    setAddLookupBusy(false);
  }

  async function saveAdd() {
    setAddBusy(true);
    setAddError("");
    const { data: { user } } = await supabase.auth.getUser();
    const isManual = MANUAL_PRICE_TYPES.has(addForm.asset_type);
    const priceOverride = isManual && addForm.price_override !== "" ? Number(addForm.price_override) : null;
    const qty = addForm.quantity === "" ? 0 : Number(addForm.quantity);
    const costBasis = addForm.cost_basis === "" ? null : Number(addForm.cost_basis);

    const derivedSymbol = isManual && !addForm.symbol.trim()
      ? (addForm.name || addForm.asset_type).replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 12) || addForm.asset_type.toUpperCase()
      : addForm.symbol.trim().toUpperCase();

    const { data: holding, error: hErr } = await supabase
      .from("holdings")
      .insert({
        user_id: user.id,
        symbol: derivedSymbol,
        name: addForm.name || null,
        asset_type: addForm.asset_type,
        account_id: addForm.account_id || null,
        quantity: 0,
        price_override: priceOverride
      })
      .select()
      .single();
    if (hErr) { setAddBusy(false); setAddError(hErr.message); return; }

    if (qty > 0) {
      const pricePerUnit = costBasis != null && qty > 0 ? costBasis / qty : null;
      const { error: txnErr } = await supabase.from("transactions").insert({
        user_id: user.id,
        holding_id: holding.id,
        txn_type: "beg_bal",
        txn_date: new Date().toISOString().slice(0, 10),
        quantity: qty,
        price_per_unit: pricePerUnit,
        amount: costBasis,
        fees: 0
      });
      if (txnErr) { setAddBusy(false); setAddError(txnErr.message); return; }
      await supabase.from("holdings").update({ quantity: qty }).eq("id", holding.id);
    }

    setAddBusy(false);
    setShowAdd(false);
    setAddForm({ symbol: "", name: "", asset_type: "", account_id: "", quantity: "", cost_basis: "", price_override: "" });
    load();
  }

  // ── Edit holding ──────────────────────────────────────────────────────────
  function openEdit(holding) {
    setEditingHolding(holding);
    setEditForm({
      symbol: holding.symbol ?? "",
      name: holding.name ?? "",
      asset_type: holding.asset_type ?? "",
      account_id: holding.account_id ?? "",
      quantity: holding.quantity != null ? String(holding.quantity) : "",
      price_override: holding.price_override != null ? String(holding.price_override) : ""
    });
    setEditError("");
    setMenuOpenId(null);
  }

  async function saveEdit() {
    setEditBusy(true);
    setEditError("");
    const isMarket = MARKET_TYPES.has(editForm.asset_type);
    const isManual = MANUAL_PRICE_TYPES.has(editForm.asset_type);
    const derivedSymbol = isManual && !editForm.symbol.trim()
      ? (editForm.name || editForm.asset_type).replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 12) || editForm.asset_type.toUpperCase()
      : editForm.symbol.trim().toUpperCase();

    const updates = {
      symbol: derivedSymbol,
      name: editForm.name || null,
      asset_type: editForm.asset_type,
      account_id: editForm.account_id || null,
      price_override: isManual && editForm.price_override !== "" ? Number(editForm.price_override) : null
    };
    if (!isMarket) updates.quantity = editForm.quantity === "" ? 0 : Number(editForm.quantity);
    const { error } = await supabase
      .from("holdings")
      .update(updates)
      .eq("id", editingHolding.id);
    setEditBusy(false);
    if (error) { setEditError(error.message); return; }
    const prevViewing = editingHolding;
    setEditingHolding(null);
    await load();
    if (viewingHolding?.id === prevViewing.id) await openDetail(prevViewing);
  }

  // ── Delete holding ────────────────────────────────────────────────────────
  async function deleteHolding(holding) {
    setMenuOpenId(null);
    if (!confirm(`Delete holding "${holding.symbol}"? All transactions will also be deleted.`)) return;
    await supabase.from("holdings").delete().eq("id", holding.id);
    if (viewingHolding?.id === holding.id) closeDetail();
    load();
  }

  // ── Detail / transactions ─────────────────────────────────────────────────
  async function openDetail(holding) {
    setViewingHolding(holding);
    setTxnBusy(true);
    const [{ data: txns }, { data: fresh }, { data: hist }] = await Promise.all([
      supabase.from("transactions")
        .select("id, txn_type, txn_date, quantity, price_per_unit, amount, fees, cash_holding_id")
        .eq("holding_id", holding.id)
        .order("txn_date", { ascending: false }),
      supabase.from("holdings_valued")
        .select("id, symbol, name, asset_type, account_id, quantity, price_override, cost_basis, current_value, net_gain, net_gain_pct, market_price")
        .eq("id", holding.id)
        .single(),
      supabase.from("portfolio_snapshots")
        .select("snapshot_date, market_value")
        .eq("holding_id", holding.id)
        .order("snapshot_date", { ascending: true })
    ]);
    setTransactions(txns ?? []);
    if (fresh) setViewingHolding(fresh);
    setHoldingHistory(
      (hist ?? []).map((s) => ({
        date: s.snapshot_date,
        value: Number(s.market_value ?? 0),
        label: new Date(s.snapshot_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      }))
    );
    setTxnBusy(false);
  }

  function closeDetail() {
    setViewingHolding(null);
    setTransactions([]);
    setShowTxnFilter(false);
    setFilterTxnTypes([]);
    setAddingTxn(false);
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "" });
    setAddTxnError("");
    setEditingTxn(null);
    setHoldingHistory([]);
    setShowTVChart(true);
    setShowHoldingHistory(true);
    setHistoryRange("all");
  }

  // ── Add transaction ───────────────────────────────────────────────────────
  async function saveAddTxn() {
    setAddTxnBusy(true);
    setAddTxnError("");
    const { data: { user } } = await supabase.auth.getUser();
    const isCash = viewingHolding.asset_type === "cash";
    const selectedType = txnTypes.find((t) => t.code === addTxnForm.txn_type);
    const amount = addTxnForm.amount !== "" ? Number(addTxnForm.amount) : null;
    const fees = addTxnForm.fees === "" ? 0 : Number(addTxnForm.fees);
    const qty = isCash ? amount : addTxnForm.quantity === "" ? null : Number(addTxnForm.quantity);
    const cashLeg =
      !isCash && viewingHolding.account_id && CASH_LEG_TYPES.has(addTxnForm.txn_type)
        ? (holdings ?? []).find((h) => h.asset_type === "cash" && h.account_id === viewingHolding.account_id)
        : null;

    const { error: txnErr } = await supabase.from("transactions").insert({
      user_id: user.id,
      holding_id: viewingHolding.id,
      cash_holding_id: cashLeg?.id ?? null,
      txn_type: addTxnForm.txn_type,
      txn_date: addTxnForm.txn_date,
      quantity: qty,
      price_per_unit: addTxnForm.price_per_unit === "" ? null : Number(addTxnForm.price_per_unit),
      amount,
      fees
    });
    if (txnErr) { setAddTxnBusy(false); setAddTxnError(txnErr.message); return; }

    const delta = isCash
      ? cashAmount(addTxnForm.txn_type, amount, fees)
      : (selectedType?.affects_quantity ?? 0) * (qty ?? 0);
    if (delta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", viewingHolding.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + delta }).eq("id", viewingHolding.id);
    }
    if (cashLeg) {
      const cashDelta = cashAmount(addTxnForm.txn_type, amount, fees);
      if (cashDelta !== 0) {
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", cashLeg.id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) + cashDelta }).eq("id", cashLeg.id);
      }
    }

    setAddTxnBusy(false);
    setAddingTxn(false);
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "" });
    load();
    await openDetail(viewingHolding);
  }

  // ── Edit transaction ──────────────────────────────────────────────────────
  function openEditTxn(txn) {
    setEditingTxn(txn);
    setEditTxnForm({
      txn_type: txn.txn_type,
      txn_date: txn.txn_date,
      quantity: txn.quantity != null ? String(txn.quantity) : "",
      price_per_unit: txn.price_per_unit != null ? String(txn.price_per_unit) : "",
      amount: txn.amount != null ? String(txn.amount) : "",
      fees: txn.fees != null ? String(txn.fees) : ""
    });
    setEditTxnError("");
    setTxnMenuOpenId(null);
  }

  async function saveEditTxn() {
    setEditTxnBusy(true);
    setEditTxnError("");
    const isCash = viewingHolding.asset_type === "cash";
    const oldTxn = editingTxn;
    const newAmount = editTxnForm.amount !== "" ? Number(editTxnForm.amount) : null;
    const newFees = editTxnForm.fees === "" ? 0 : Number(editTxnForm.fees);
    const newQty = isCash ? newAmount : editTxnForm.quantity === "" ? null : Number(editTxnForm.quantity);
    const affectsOld = txnTypes.find((t) => t.code === oldTxn.txn_type)?.affects_quantity ?? 0;
    const affectsNew = txnTypes.find((t) => t.code === editTxnForm.txn_type)?.affects_quantity ?? 0;
    const oldDelta = isCash ? cashAmount(oldTxn.txn_type, oldTxn.amount, oldTxn.fees) : affectsOld * (Number(oldTxn.quantity) || 0);
    const newDelta = isCash ? cashAmount(editTxnForm.txn_type, newAmount, newFees) : affectsNew * (newQty ?? 0);
    const netDelta = newDelta - oldDelta;

    if (netDelta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", viewingHolding.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + netDelta }).eq("id", viewingHolding.id);
    }
    if (oldTxn.cash_holding_id) {
      const oldCashDelta = cashAmount(oldTxn.txn_type, oldTxn.amount, oldTxn.fees);
      const newCashDelta = cashAmount(editTxnForm.txn_type, newAmount, newFees);
      const netCash = newCashDelta - oldCashDelta;
      if (netCash !== 0) {
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", oldTxn.cash_holding_id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) + netCash }).eq("id", oldTxn.cash_holding_id);
      }
    }

    const { error } = await supabase.from("transactions").update({
      txn_type: editTxnForm.txn_type,
      txn_date: editTxnForm.txn_date,
      quantity: newQty,
      price_per_unit: editTxnForm.price_per_unit === "" ? null : Number(editTxnForm.price_per_unit),
      amount: newAmount,
      fees: newFees
    }).eq("id", oldTxn.id);

    setEditTxnBusy(false);
    if (error) { setEditTxnError(error.message); return; }
    setEditingTxn(null);
    load();
    await openDetail(viewingHolding);
  }

  async function deleteTxn(txn) {
    setTxnMenuOpenId(null);
    if (!confirm(`Delete this ${txn.txn_type} transaction from ${txn.txn_date}?`)) return;
    const isCash = viewingHolding.asset_type === "cash";
    const affects = txnTypes.find((t) => t.code === txn.txn_type)?.affects_quantity ?? 0;
    const delta = isCash ? cashAmount(txn.txn_type, txn.amount, txn.fees) : affects * (Number(txn.quantity) || 0);
    if (delta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", viewingHolding.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) - delta }).eq("id", viewingHolding.id);
    }
    if (txn.cash_holding_id) {
      const cashDelta = cashAmount(txn.txn_type, txn.amount, txn.fees);
      if (cashDelta !== 0) {
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", txn.cash_holding_id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) - cashDelta }).eq("id", txn.cash_holding_id);
      }
    }
    await supabase.from("transactions").delete().eq("id", txn.id);
    load();
    await openDetail(viewingHolding);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const filtersActive = filterAssetTypes.length > 0 || filterAccounts.length > 0;
  const filteredHoldings = (holdings ?? []).filter((h) => {
    const typeOk = filterAssetTypes.length === 0 || filterAssetTypes.includes(h.asset_type);
    const acctOk = filterAccounts.length === 0 || filterAccounts.includes(h.account_id);
    return typeOk && acctOk;
  });
  const uniqueAssetTypeCodes = [...new Set((holdings ?? []).map((h) => h.asset_type))].sort();
  const filteredTxns = filterTxnTypes.length === 0
    ? transactions
    : transactions.filter((t) => filterTxnTypes.includes(t.txn_type));
  const txnFiltersActive = filterTxnTypes.length > 0;
  const selectedAddTxnType = txnTypes.find((t) => t.code === addTxnForm.txn_type);
  const isCashHoldingView = viewingHolding?.asset_type === "cash";
  const isUnitAddTxn = selectedAddTxnType?.affects_quantity !== 0 && selectedAddTxnType != null && !isCashHoldingView;
  const isAddManual = MANUAL_PRICE_TYPES.has(addForm.asset_type);
  const isAddMarket = MARKET_TYPES.has(addForm.asset_type);
  const isEditManual = MANUAL_PRICE_TYPES.has(editForm.asset_type);
  const isEditMarket = MARKET_TYPES.has(editForm.asset_type);

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Holdings</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilter((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              showFilter || filtersActive
                ? "border-brass/60 text-brass-soft bg-ink-soft"
                : "border-ink-line text-paper-dim hover:text-paper"
            }`}
          >
            {filtersActive ? `Filter (${filterAssetTypes.length + filterAccounts.length})` : "Filter"}
          </button>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              showAdd
                ? "border-brass/60 text-brass-soft bg-ink-soft"
                : "border-ink-line text-paper-dim hover:text-paper"
            }`}
          >
            + Add
          </button>
        </div>
      </div>

      {/* Holdings table card */}
      <div className="card">
        <div className="flex">
          {showFilter && (
            <div className="w-48 shrink-0 border-r border-ink-line p-4 space-y-5">
              <div>
                <p className="label mb-2">Asset type</p>
                <div className="space-y-1.5">
                  {uniqueAssetTypeCodes.map((code) => (
                    <label key={code} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-brass"
                        checked={filterAssetTypes.includes(code)}
                        onChange={() =>
                          setFilterAssetTypes((prev) =>
                            prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]
                          )
                        }
                      />
                      {assetTypes.find((a) => a.code === code)?.label ?? code}
                    </label>
                  ))}
                </div>
              </div>
              {accounts.length > 0 && (
                <div>
                  <p className="label mb-2">Account</p>
                  <div className="space-y-1.5">
                    {accounts.map((a) => (
                      <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-brass"
                          checked={filterAccounts.includes(a.id)}
                          onChange={() =>
                            setFilterAccounts((prev) =>
                              prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]
                            )
                          }
                        />
                        {a.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {filtersActive && (
                <button
                  className="text-xs text-paper-dim hover:text-paper transition-colors"
                  onClick={() => { setFilterAssetTypes([]); setFilterAccounts([]); }}
                >
                  Clear all
                </button>
              )}
            </div>
          )}

          <div className="flex-1 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-line">
                  <th className="w-10 px-2 py-3"></th>
                  <th className="label text-left font-medium px-4 py-3">
                    {filtersActive
                      ? `Holdings · ${filteredHoldings.length} of ${(holdings ?? []).length}`
                      : "Symbol"}
                  </th>
                  <th className="label text-left font-medium px-4 py-3">Account</th>
                  <th className="label text-left font-medium px-4 py-3">Type</th>
                  <th className="label text-right font-medium px-4 py-3">Qty</th>
                  <th className="label text-right font-medium px-4 py-3">Value</th>
                  <th className="label text-right font-medium px-4 py-3">Gain</th>
                  <th className="label text-right font-medium px-4 py-3">Day Chg</th>
                </tr>
              </thead>
              <tbody>
                {holdings === null && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-paper-dim">Loading…</td></tr>
                )}
                {holdings !== null && filteredHoldings.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-paper-dim">
                      {filtersActive ? "No holdings match the current filters." : "No holdings yet. Use + Add to create one."}
                    </td>
                  </tr>
                )}
                {filteredHoldings.map((h) => {
                  const gain = Number(h.net_gain ?? 0);
                  const snap = snapMap[h.id];
                  const dayChg = snap != null ? Number(h.current_value ?? 0) - snap : null;
                  return (
                    <tr
                      key={h.id}
                      className="border-b border-ink-line/60 last:border-0 cursor-pointer hover:bg-ink-soft/40 transition-colors"
                      onClick={() => openDetail(h)}
                    >
                      <td className="px-2 py-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (menuOpenId === h.id) {
                              setMenuOpenId(null);
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setMenuPos({ top: rect.bottom + 4, left: rect.left });
                              setMenuOpenId(h.id);
                            }
                          }}
                          className="p-1.5 rounded-lg text-paper-dim hover:text-paper hover:bg-ink-soft transition-colors"
                          aria-label={`Actions for ${h.symbol}`}
                        >
                          <KebabIcon />
                        </button>
                        {menuOpenId === h.id && typeof document !== "undefined" && createPortal(
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setMenuOpenId(null)} />
                            <div
                              className="fixed z-50 w-32 card p-1 shadow-lg"
                              style={{ top: menuPos.top, left: menuPos.left }}
                            >
                              <button
                                onClick={(e) => { e.stopPropagation(); openEdit(h); }}
                                className="w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-ink-soft transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteHolding(h); }}
                                className="w-full text-left px-3 py-1.5 rounded-md text-sm text-loss hover:bg-ink-soft transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </>,
                          document.body
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium">{h.symbol}</span>
                        {h.name && <span className="text-paper-dim ml-2 text-xs">{h.name}</span>}
                      </td>
                      <td className="px-4 py-3 text-paper-dim">{accountMap[h.account_id] ?? "—"}</td>
                      <td className="px-4 py-3 label">{assetTypes.find((a) => a.code === h.asset_type)?.label ?? h.asset_type}</td>
                      <td className="num text-right px-4 py-3">
                        {Number(h.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 })}
                      </td>
                      <td className="num text-right px-4 py-3">{usd(h.current_value)}</td>
                      <td className={`num text-right px-4 py-3 ${gain > 0 ? "text-gain" : gain < 0 ? "text-loss" : "text-paper-dim"}`}>
                        {gain > 0 ? "+" : ""}{usd(gain)}
                      </td>
                      <td className={`num text-right px-4 py-3 ${dayChg == null ? "text-paper-dim" : dayChg > 0 ? "text-gain" : dayChg < 0 ? "text-loss" : "text-paper-dim"}`}>
                        {dayChg == null ? "—" : `${dayChg > 0 ? "+" : ""}${usd(dayChg)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Add Holding drawer ─────────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${showAdd ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${showAdd ? "opacity-100" : "opacity-0"}`}
          onClick={() => setShowAdd(false)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            showAdd ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Add holding</p>
            <button onClick={() => setShowAdd(false)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5">
                {isAddManual ? "Ticker (optional)" : "Symbol"}
              </label>
              <input
                className="field uppercase"
                placeholder={isAddManual ? "" : "AAPL"}
                value={addForm.symbol}
                onChange={(e) => setAddForm({ ...addForm, symbol: e.target.value })}
                onBlur={(e) => lookupAddSymbol(e.target.value)}
              />
            </div>
            <div>
              <label className="label block mb-1.5">Asset type</label>
              <select
                className="field"
                value={addForm.asset_type}
                onChange={(e) => setAddForm({ ...addForm, asset_type: e.target.value })}
              >
                <option value="">Select…</option>
                {assetTypes.map((t) => (
                  <option key={t.code} value={t.code}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label block mb-1.5">
              {isAddManual ? "Name" : "Name (optional)"}
            </label>
            <input
              className="field"
              placeholder={addLookupBusy ? "Looking up…" : isAddManual ? "e.g. Primary Residence" : "Apple Inc."}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
              disabled={addLookupBusy}
            />
          </div>
          <div>
            <label className="label block mb-1.5">Account (optional)</label>
            <select
              className="field"
              value={addForm.account_id}
              onChange={(e) => setAddForm({ ...addForm, account_id: e.target.value })}
            >
              <option value="">No account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          {!isAddMarket && (
            <div>
              <label className="label block mb-1.5">Starting quantity</label>
              <input
                className="field num"
                type="number"
                step="any"
                placeholder="0"
                value={addForm.quantity}
                onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })}
              />
            </div>
          )}
          {!isAddMarket && Number(addForm.quantity) > 0 && (
            <div>
              <label className="label block mb-1.5">Cost basis (optional)</label>
              <input
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={addForm.cost_basis}
                onChange={(e) => setAddForm({ ...addForm, cost_basis: e.target.value })}
              />
            </div>
          )}
          {isAddManual && (
            <div>
              <label className="label block mb-1.5">Current price per unit</label>
              <input
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={addForm.price_override}
                onChange={(e) => setAddForm({ ...addForm, price_override: e.target.value })}
              />
            </div>
          )}
          {addError && <p className="text-loss text-sm">{addError}</p>}
          <button
            className="btn w-full"
            onClick={saveAdd}
            disabled={addBusy || !addForm.asset_type || (isAddManual ? !addForm.name && !addForm.symbol : !addForm.symbol)}
          >
            {addBusy ? "Saving…" : "Add holding"}
          </button>
        </div>
      </div>

      {/* ── Edit Holding drawer ────────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-[60] ${editingHolding ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingHolding ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingHolding(null)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            editingHolding ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {editingHolding && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">Edit holding</p>
                <button onClick={() => setEditingHolding(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>
              <div>
                <label className="label block mb-1.5">
                  {isEditManual ? "Ticker (optional)" : "Symbol"}
                </label>
                <input
                  className="field uppercase"
                  value={editForm.symbol}
                  onChange={(e) => { const v = e.target.value; setEditForm((prev) => ({ ...prev, symbol: v })); }}
                />
              </div>
              <div>
                <label className="label block mb-1.5">
                  {isEditManual ? "Name" : "Name (optional)"}
                </label>
                <input
                  className="field"
                  value={editForm.name}
                  onChange={(e) => { const v = e.target.value; setEditForm((prev) => ({ ...prev, name: v })); }}
                />
              </div>
              <div>
                <label className="label block mb-1.5">Asset type</label>
                <select
                  className="field"
                  value={editForm.asset_type}
                  onChange={(e) => { const v = e.target.value; setEditForm((prev) => ({ ...prev, asset_type: v })); }}
                >
                  <option value="">Select…</option>
                  {assetTypes.map((t) => (
                    <option key={t.code} value={t.code}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label block mb-1.5">Account</label>
                <select
                  className="field"
                  value={editForm.account_id}
                  onChange={(e) => { const v = e.target.value; setEditForm((prev) => ({ ...prev, account_id: v })); }}
                >
                  <option value="">No account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              {!isEditMarket && (
                <div>
                  <label className="label block mb-1.5">Quantity</label>
                  <input
                    className="field num"
                    type="number"
                    step="any"
                    value={editForm.quantity}
                    onChange={(e) => { const v = e.target.value; setEditForm((prev) => ({ ...prev, quantity: v })); }}
                  />
                </div>
              )}
              {isEditManual && (
                <div>
                  <label className="label block mb-1.5">Current price per unit</label>
                  <input
                    className="field num"
                    type="number"
                    step="any"
                    placeholder="0.00"
                    value={editForm.price_override}
                    onChange={(e) => { const v = e.target.value; setEditForm((prev) => ({ ...prev, price_override: v })); }}
                  />
                </div>
              )}
              {editError && <p className="text-loss text-sm">{editError}</p>}
              <button
                className="btn w-full"
                onClick={saveEdit}
                disabled={editBusy || !editForm.asset_type || (isEditManual ? !editForm.name && !editForm.symbol : !editForm.symbol)}
              >
                {editBusy ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Detail / Transactions drawer ───────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${viewingHolding ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${viewingHolding ? "opacity-100" : "opacity-0"}`}
          onClick={closeDetail}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-[864px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${
            viewingHolding ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {viewingHolding && (
            <>
              <div className="flex items-center justify-between px-5 py-4 border-b border-ink-line">
                <div>
                  <p className="font-semibold text-base">
                    {viewingHolding.symbol}
                    {viewingHolding.name && (
                      <span className="font-normal text-paper-dim ml-2">{viewingHolding.name}</span>
                    )}
                  </p>
                  <p className="text-xs text-paper-dim mt-0.5">
                    {assetTypes.find((a) => a.code === viewingHolding.asset_type)?.label ?? viewingHolding.asset_type}
                    {viewingHolding.account_id ? ` · ${accountMap[viewingHolding.account_id] ?? ""}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEdit(viewingHolding)}
                    className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setShowTxnFilter((f) => !f)}
                    className={`px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                      showTxnFilter || txnFiltersActive
                        ? "border-brass/60 text-brass-soft bg-ink-soft"
                        : "border-ink-line text-paper-dim hover:text-paper"
                    }`}
                  >
                    {txnFiltersActive ? `Filter (${filterTxnTypes.length})` : "Filter"}
                  </button>
                  <button
                    onClick={() => setAddingTxn(true)}
                    className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors"
                  >
                    + Add
                  </button>
                  <button onClick={closeDetail} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
                </div>
              </div>

              {/* Summary bar */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-px border-b border-ink-line">
                <div className="px-5 py-3">
                  <p className="label mb-0.5">Qty</p>
                  <p className="num text-sm font-medium">
                    {Number(viewingHolding.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 })}
                  </p>
                </div>
                <div className="px-5 py-3">
                  <p className="label mb-0.5">Cost basis</p>
                  <p className="num text-sm font-medium">{usd(viewingHolding.cost_basis)}</p>
                </div>
                <div className="px-5 py-3">
                  <p className="label mb-0.5">Value</p>
                  <p className="num text-sm font-medium">{usd(viewingHolding.current_value)}</p>
                </div>
                <div className="px-5 py-3">
                  <p className="label mb-0.5">Gain</p>
                  <p className={`num text-sm font-medium ${Number(viewingHolding.net_gain ?? 0) > 0 ? "text-gain" : Number(viewingHolding.net_gain ?? 0) < 0 ? "text-loss" : ""}`}>
                    {Number(viewingHolding.net_gain ?? 0) > 0 ? "+" : ""}{usd(viewingHolding.net_gain)}
                    {viewingHolding.net_gain_pct != null && (
                      <span className="text-xs ml-1.5 opacity-80">
                        {Number(viewingHolding.net_gain ?? 0) > 0 ? "+" : ""}{Number(viewingHolding.net_gain_pct).toFixed(1)}%
                      </span>
                    )}
                  </p>
                </div>
                <div className="px-5 py-3">
                  <p className="label mb-0.5">Day Chg</p>
                  {(() => {
                    const snap = snapMap[viewingHolding.id];
                    if (snap == null) return <p className="num text-sm font-medium text-paper-dim">—</p>;
                    const dc = Number(viewingHolding.current_value ?? 0) - snap;
                    return (
                      <p className={`num text-sm font-medium ${dc > 0 ? "text-gain" : dc < 0 ? "text-loss" : ""}`}>
                        {dc > 0 ? "+" : ""}{usd(dc)}
                      </p>
                    );
                  })()}
                </div>
              </div>

              {/* Charts */}
              <div className="border-b border-ink-line">
                {/* TradingView price chart */}
                {MARKET_TYPES.has(viewingHolding.asset_type) && (
                  <div className="border-b border-ink-line">
                    <div className="flex items-center justify-between px-5 py-2.5">
                      <p className="label text-xs">Price chart</p>
                      <button
                        onClick={() => setShowTVChart((v) => !v)}
                        className={`p-1 rounded transition-colors ${showTVChart ? "text-paper hover:text-paper-dim" : "text-paper-dim hover:text-paper"}`}
                        aria-label={showTVChart ? "Hide price chart" : "Show price chart"}
                      >
                        <EyeIcon open={showTVChart} />
                      </button>
                    </div>
                    {showTVChart && (
                      <iframe
                        key={viewingHolding.symbol}
                        src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(getTVSymbol(viewingHolding.symbol, viewingHolding.asset_type))}&interval=D&theme=dark&style=1&locale=en&hide_top_toolbar=0&allow_symbol_change=0&save_image=0`}
                        width="100%"
                        height="380"
                        frameBorder="0"
                        allowTransparency="true"
                        scrolling="no"
                      />
                    )}
                  </div>
                )}

                {/* Holding value history */}
                {(() => {
                  const RANGES = [
                    { key: "1W", days: 7 },
                    { key: "1M", days: 30 },
                    { key: "3M", days: 90 },
                    { key: "6M", days: 180 },
                    { key: "1Y", days: 365 },
                    { key: "All", days: null },
                  ];
                  const cutoff = RANGES.find((r) => r.key === historyRange)?.days;
                  const cutoffDate = cutoff
                    ? new Date(Date.now() - cutoff * 86400000).toISOString().slice(0, 10)
                    : null;
                  const visibleHistory = cutoffDate
                    ? holdingHistory.filter((p) => p.date >= cutoffDate)
                    : holdingHistory;
                  return (
                    <div className="px-5 py-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <p className="label text-xs">Holding value history</p>
                          <button
                            onClick={() => setShowHoldingHistory((v) => !v)}
                            className={`p-0.5 rounded transition-colors ${showHoldingHistory ? "text-paper hover:text-paper-dim" : "text-paper-dim hover:text-paper"}`}
                            aria-label={showHoldingHistory ? "Hide value history" : "Show value history"}
                          >
                            <EyeIcon open={showHoldingHistory} />
                          </button>
                        </div>
                        <div className="flex gap-0.5">
                          {RANGES.map((r) => (
                            <button
                              key={r.key}
                              onClick={() => setHistoryRange(r.key)}
                              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                                historyRange === r.key
                                  ? "bg-ink text-brass-soft"
                                  : "text-paper-dim hover:text-paper"
                              }`}
                            >
                              {r.key}
                            </button>
                          ))}
                        </div>
                      </div>
                      {showHoldingHistory && visibleHistory.length < 2 ? (
                        <p className="text-paper-dim text-xs py-4 text-center">
                          {holdingHistory.length === 0 ? "No snapshot history yet." : "No data for this range."}
                        </p>
                      ) : showHoldingHistory ? (
                        <ResponsiveContainer width="100%" height={180}>
                          <LineChart data={visibleHistory} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                            <XAxis dataKey="label" tick={{ fill: "#A8ADB8", fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                            <YAxis
                              tick={{ fill: "#A8ADB8", fontSize: 10 }}
                              axisLine={false}
                              tickLine={false}
                              width={64}
                              tickFormatter={(v) =>
                                v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
                                : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K`
                                : `$${v}`
                              }
                            />
                            <Tooltip content={<ChartTooltip />} />
                            <Line
                              type="monotone"
                              dataKey="value"
                              name={viewingHolding.symbol}
                              stroke="#C9A227"
                              strokeWidth={2}
                              dot={false}
                              activeDot={{ r: 4, fill: "#C9A227", stroke: "#1B212B", strokeWidth: 2 }}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : null}
                    </div>
                  );
                })()}
              </div>

              {/* Transactions */}
              <div className="px-5 py-4">
                <div className="flex gap-5">
                  {showTxnFilter && (
                    <div className="w-44 shrink-0 border-r border-ink-line pr-5 space-y-4">
                      <div>
                        <p className="label mb-2">Type</p>
                        <div className="space-y-1.5">
                          {[...new Set(transactions.map((t) => t.txn_type))].sort().map((code) => (
                            <label key={code} className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="checkbox"
                                className="accent-brass"
                                checked={filterTxnTypes.includes(code)}
                                onChange={() =>
                                  setFilterTxnTypes((prev) =>
                                    prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]
                                  )
                                }
                              />
                              {txnTypes.find((t) => t.code === code)?.label ?? code}
                            </label>
                          ))}
                        </div>
                      </div>
                      {txnFiltersActive && (
                        <button
                          onClick={() => setFilterTxnTypes([])}
                          className="text-xs text-paper-dim hover:text-paper"
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="label mb-3">
                      Transactions{txnFiltersActive ? ` · ${filteredTxns.length} of ${transactions.length}` : ""}
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
                            {filteredTxns.map((t) => (
                              <tr key={t.id} className="border-b border-ink-line/60 last:border-0">
                                <td className="py-2.5">
                                  <button
                                    onClick={() => {
                                      if (txnMenuOpenId === t.id) {
                                        setTxnMenuOpenId(null);
                                      } else {
                                        const rect = document.getElementById(`txn-kebab-${t.id}`)?.getBoundingClientRect();
                                        if (rect) setTxnMenuPos({ top: rect.bottom + 4, left: rect.left });
                                        setTxnMenuOpenId(t.id);
                                      }
                                    }}
                                    id={`txn-kebab-${t.id}`}
                                    className="p-1 rounded-lg text-paper-dim hover:text-paper hover:bg-ink-soft transition-colors"
                                  >
                                    <KebabIcon />
                                  </button>
                                  {txnMenuOpenId === t.id && typeof document !== "undefined" && createPortal(
                                    <>
                                      <div className="fixed inset-0 z-[60]" onClick={() => setTxnMenuOpenId(null)} />
                                      <div
                                        className="fixed z-[70] w-32 card p-1 shadow-lg"
                                        style={{ top: txnMenuPos.top, left: txnMenuPos.left }}
                                      >
                                        <button
                                          onClick={() => openEditTxn(t)}
                                          className="w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-ink-soft transition-colors"
                                        >
                                          Edit
                                        </button>
                                        <button
                                          onClick={() => deleteTxn(t)}
                                          className="w-full text-left px-3 py-1.5 rounded-md text-sm text-loss hover:bg-ink-soft transition-colors"
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </>,
                                    document.body
                                  )}
                                </td>
                                <td className="py-2.5 pr-4">{t.txn_date}</td>
                                <td className="py-2.5 pr-4 label">
                                  {txnTypes.find((tt) => tt.code === t.txn_type)?.label ?? t.txn_type}
                                </td>
                                <td className="num text-right py-2.5 pr-2">
                                  {t.quantity != null ? Number(t.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—"}
                                </td>
                                <td className="num text-right py-2.5 pr-2">{usd(t.price_per_unit)}</td>
                                <td className="num text-right py-2.5 pr-2">{usd(t.amount)}</td>
                                <td className="num text-right py-2.5">{usd(t.fees)}</td>
                              </tr>
                            ))}
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

      {/* ── Add Transaction drawer ─────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-50 ${addingTxn ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/50 transition-opacity ${addingTxn ? "opacity-100" : "opacity-0"}`}
          onClick={() => setAddingTxn(false)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            addingTxn ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Add transaction · {viewingHolding?.symbol}</p>
            <button onClick={() => setAddingTxn(false)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>
          <div>
            <label className="label block mb-1.5">Type</label>
            <select
              className="field"
              value={addTxnForm.txn_type}
              onChange={(e) => setAddTxnForm({ ...addTxnForm, txn_type: e.target.value })}
            >
              <option value="">Select…</option>
              {txnTypes.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label block mb-1.5">Date</label>
            <input
              className="field"
              type="date"
              value={addTxnForm.txn_date}
              onChange={(e) => setAddTxnForm({ ...addTxnForm, txn_date: e.target.value })}
            />
          </div>
          {isUnitAddTxn && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label block mb-1.5">Quantity</label>
                <input
                  className="field num"
                  type="number"
                  step="any"
                  value={addTxnForm.quantity}
                  onChange={(e) => setAddTxnForm({ ...addTxnForm, quantity: e.target.value })}
                />
              </div>
              <div>
                <label className="label block mb-1.5">Price / unit</label>
                <input
                  className="field num"
                  type="number"
                  step="any"
                  value={addTxnForm.price_per_unit}
                  onChange={(e) => setAddTxnForm({ ...addTxnForm, price_per_unit: e.target.value })}
                />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5">Amount</label>
              <input
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={addTxnForm.amount}
                onChange={(e) => setAddTxnForm({ ...addTxnForm, amount: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1.5">Fees</label>
              <input
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={addTxnForm.fees}
                onChange={(e) => setAddTxnForm({ ...addTxnForm, fees: e.target.value })}
              />
            </div>
          </div>
          {addTxnError && <p className="text-loss text-sm">{addTxnError}</p>}
          <button
            className="btn w-full"
            onClick={saveAddTxn}
            disabled={addTxnBusy || !addTxnForm.txn_type || !addTxnForm.txn_date}
          >
            {addTxnBusy ? "Saving…" : "Record transaction"}
          </button>
        </div>
      </div>

      {/* ── Edit Transaction drawer ────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-50 ${editingTxn ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/50 transition-opacity ${editingTxn ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingTxn(null)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            editingTxn ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {editingTxn && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">Edit transaction</p>
                <button onClick={() => setEditingTxn(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>
              <div>
                <label className="label block mb-1.5">Type</label>
                <select
                  className="field"
                  value={editTxnForm.txn_type}
                  onChange={(e) => setEditTxnForm({ ...editTxnForm, txn_type: e.target.value })}
                >
                  {txnTypes.map((t) => (
                    <option key={t.code} value={t.code}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label block mb-1.5">Date</label>
                <input
                  className="field"
                  type="date"
                  value={editTxnForm.txn_date}
                  onChange={(e) => setEditTxnForm({ ...editTxnForm, txn_date: e.target.value })}
                />
              </div>
              {!isCashHoldingView && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label block mb-1.5">Quantity</label>
                    <input
                      className="field num"
                      type="number"
                      step="any"
                      value={editTxnForm.quantity}
                      onChange={(e) => setEditTxnForm({ ...editTxnForm, quantity: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="label block mb-1.5">Price / unit</label>
                    <input
                      className="field num"
                      type="number"
                      step="any"
                      value={editTxnForm.price_per_unit}
                      onChange={(e) => setEditTxnForm({ ...editTxnForm, price_per_unit: e.target.value })}
                    />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1.5">Amount</label>
                  <input
                    className="field num"
                    type="number"
                    step="any"
                    value={editTxnForm.amount}
                    onChange={(e) => setEditTxnForm({ ...editTxnForm, amount: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label block mb-1.5">Fees</label>
                  <input
                    className="field num"
                    type="number"
                    step="any"
                    value={editTxnForm.fees}
                    onChange={(e) => setEditTxnForm({ ...editTxnForm, fees: e.target.value })}
                  />
                </div>
              </div>
              {editTxnError && <p className="text-loss text-sm">{editTxnError}</p>}
              <button
                className="btn w-full"
                onClick={saveEditTxn}
                disabled={editTxnBusy}
              >
                {editTxnBusy ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
