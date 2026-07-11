"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { supabase } from "../../lib/supabase";
import { cashAmount, CASH_LEG_TYPES } from "../../lib/cash";
import { SIMULATOR_KEYS, defaultSimulatorKey } from "../../lib/simulatorKeys";
import Shell from "../../components/Shell";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const MARKET_TYPES = new Set(["equity", "etf", "closed_end_fund", "mutual_fund", "money_market", "bond", "crypto", "metal"]);
const TV_CHART_TYPES = new Set(["equity", "etf", "closed_end_fund", "crypto", "metal"]);
const MANUAL_PRICE_TYPES = new Set(["real_estate", "loan", "other"]);

const METAL_TV_SYMBOLS = { XAU: "TVC:GOLD", XAG: "TVC:SILVER", XPT: "TVC:PLATINUM", XPD: "TVC:PALLADIUM" };

function getTVSymbol(symbol, assetType) {
  const s = (symbol ?? "").toUpperCase();
  if (assetType === "crypto") return `COINBASE:${s}USD`;
  if (assetType === "metal") return METAL_TV_SYMBOLS[s] ?? `TVC:${s}`;
  return s; // equity, etf, mutual_fund, bond — TradingView resolves by ticker
}

function ChevronIcon({ collapsed }) {
  return (
    <svg
      className={`w-3.5 h-3.5 transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
      viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
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
  const [periodSnaps, setPeriodSnaps] = useState({});
  const [allTransactions, setAllTransactions] = useState([]);
  const [error, setError] = useState("");

  // Filter
  const [showFilter, setShowFilter] = useState(false);
  const [filterSearch, setFilterSearch] = useState("");
  const [filterSymbols, setFilterSymbols] = useState([]);
  const [filterAssetTypes, setFilterAssetTypes] = useState([]);
  const [filterAccounts, setFilterAccounts] = useState([]);

  // Collapsible asset-type groups
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  function toggleGroup(code) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

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
  const [editForm, setEditForm] = useState({ symbol: "", name: "", asset_type: "", account_id: "", quantity: "", price_override: "", simulator_key: "" });
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
  const [addTxnForm, setAddTxnForm] = useState({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "", reinvest: false, reinvest_quantity: "", reinvest_price: "", linked_holding_id: "" });
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
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yearStart = `${now.getFullYear()}-01-01`;
    const ds = (d) => d.toISOString().slice(0, 10);
    const subDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() - n); return r; };
    const weekSnapDate  = ds(subDays(now, 7));
    const monthSnapDate = ds(subDays(new Date(now.getFullYear(), now.getMonth(), 1), 1));
    const qtrSnapDate   = ds(subDays(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1), 1));
    const yearSnapDate  = `${now.getFullYear() - 1}-12-31`;

    const snapToMap = (rows) => {
      const m = {};
      for (const r of rows ?? []) m[r.holding_id] = Number(r.market_value ?? 0);
      return m;
    };

    const [
      { data: hv, error: hvErr },
      { data: ac },
      { data: at },
      { data: tt },
      { data: snaps },
      { data: allTxns },
      { data: weekSnap },
      { data: monthSnap },
      { data: qtrSnap },
      { data: yearSnap },
    ] = await Promise.all([
      supabase.from("holdings_valued").select("*").order("asset_type").order("symbol"),
      supabase.from("accounts").select("id, name").order("name"),
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("transaction_types").select("code, label, affects_quantity").eq("is_active", true).order("sort_order"),
      supabase.from("portfolio_snapshots").select("holding_id, market_value").eq("snapshot_date", today),
      supabase.from("transactions").select("holding_id, txn_type, txn_date, amount, is_reinvested").gte("txn_date", yearStart),
      supabase.rpc("snapshot_at", { snap_date: weekSnapDate }),
      supabase.rpc("snapshot_at", { snap_date: monthSnapDate }),
      supabase.rpc("snapshot_at", { snap_date: qtrSnapDate }),
      supabase.rpc("snapshot_at", { snap_date: yearSnapDate }),
    ]);
    if (hvErr) setError(hvErr.message);
    setHoldings(hv ?? []);
    setCollapsedGroups(new Set((hv ?? []).map((h) => h.asset_type).filter(Boolean)));
    setAccounts(ac ?? []);
    const aMap = {};
    for (const a of ac ?? []) aMap[a.id] = a.name;
    setAccountMap(aMap);
    setAssetTypes(at ?? []);
    setTxnTypes(tt ?? []);
    const sMap = {};
    for (const s of snaps ?? []) sMap[s.holding_id] = Number(s.market_value ?? 0);
    setSnapMap(sMap);
    setPeriodSnaps({
      week:  snapToMap(weekSnap),
      month: snapToMap(monthSnap),
      qtr:   snapToMap(qtrSnap),
      year:  snapToMap(yearSnap),
    });
    setAllTransactions(allTxns ?? []);
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

    // Establish a zero-value baseline snapshot so daily-change offsets the cash decrease correctly.
    await supabase.rpc("seed_holding_snapshot", { p_holding_id: holding.id });

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
      price_override: holding.price_override != null ? String(holding.price_override) : "",
      simulator_key: holding.simulator_key ?? "",
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
      price_override: isManual && editForm.price_override !== "" ? Number(editForm.price_override) : null,
      simulator_key: editForm.simulator_key || null,
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
        .select("id, txn_type, txn_date, quantity, price_per_unit, amount, fees, cash_holding_id, holding_id, is_reinvested")
        .or(`holding_id.eq.${holding.id},cash_holding_id.eq.${holding.id}`)
        .order("txn_date", { ascending: false }),
      supabase.from("holdings_valued")
        .select("id, symbol, name, asset_type, account_id, quantity, price_override, cost_basis, current_value, net_gain, net_gain_pct, market_price, simulator_key")
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
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "", reinvest: false, reinvest_quantity: "", reinvest_price: "", linked_holding_id: "" });
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

    // Dividend reinvestment: two paired transactions — dividend in, then buy back
    if (addTxnForm.txn_type === "dividend" && addTxnForm.reinvest && !isCash) {
      const reinvestQty   = Number(addTxnForm.reinvest_quantity);
      const reinvestPrice = addTxnForm.reinvest_price !== "" ? Number(addTxnForm.reinvest_price) : null;

      // 1) Dividend receipt — cash +amount, holding qty unchanged
      const { error: divErr } = await supabase.from("transactions").insert({
        user_id: user.id,
        holding_id: viewingHolding.id,
        cash_holding_id: cashLeg?.id ?? null,
        txn_type: "dividend",
        txn_date: addTxnForm.txn_date,
        quantity: null,
        price_per_unit: null,
        amount,
        fees: 0,
        is_reinvested: true,
      });
      if (divErr) { setAddTxnBusy(false); setAddTxnError(divErr.message); return; }

      // 2) Reinvest buy — cash -amount, holding qty +reinvestQty
      const { error: buyErr } = await supabase.from("transactions").insert({
        user_id: user.id,
        holding_id: viewingHolding.id,
        cash_holding_id: cashLeg?.id ?? null,
        txn_type: "buy",
        txn_date: addTxnForm.txn_date,
        quantity: reinvestQty,
        price_per_unit: reinvestPrice,
        amount,
        fees: 0,
      });
      if (buyErr) { setAddTxnBusy(false); setAddTxnError(buyErr.message); return; }

      // Holding qty: +reinvestQty from the buy
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", viewingHolding.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + reinvestQty }).eq("id", viewingHolding.id);

      // Cash leg: +amount (dividend) then -amount (buy) → net 0, no cash update needed
      await supabase.rpc("seed_holding_snapshot", { p_holding_id: viewingHolding.id });

    } else {
      // Normal single-transaction path
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

      // Seed snapshot for this holding if it's brand new (no prior snapshot history)
      if ((selectedType?.affects_quantity ?? 0) > 0) {
        await supabase.rpc("seed_holding_snapshot", { p_holding_id: viewingHolding.id });
      }

      // Paired transfer: auto-create the offsetting leg on the linked holding
      if (addTxnForm.linked_holding_id && (addTxnForm.txn_type === "transfer_out" || addTxnForm.txn_type === "transfer_in")) {
        const pairedType = addTxnForm.txn_type === "transfer_out" ? "transfer_in" : "transfer_out";
        const { error: pairErr } = await supabase.from("transactions").insert({
          user_id: user.id,
          holding_id: addTxnForm.linked_holding_id,
          cash_holding_id: null,
          txn_type: pairedType,
          txn_date: addTxnForm.txn_date,
          quantity: amount,
          price_per_unit: null,
          amount,
          fees: 0,
        });
        if (pairErr) { setAddTxnBusy(false); setAddTxnError(pairErr.message); return; }

        const pairedDelta = cashAmount(pairedType, amount, 0);
        if (pairedDelta !== 0) {
          const { data: lh } = await supabase.from("holdings").select("quantity").eq("id", addTxnForm.linked_holding_id).single();
          if (lh) await supabase.from("holdings").update({ quantity: Number(lh.quantity) + pairedDelta }).eq("id", addTxnForm.linked_holding_id);
        }
      }
    }

    setAddTxnBusy(false);
    setAddingTxn(false);
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "", reinvest: false, reinvest_quantity: "", reinvest_price: "", linked_holding_id: "" });
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

  // ── Portfolio metrics grid ────────────────────────────────────────────────
  const portfolioMetrics = useMemo(() => {
    if (!holdings || holdings.length === 0) return null;

    // Exclude pure cash (USD transfers) — money market is kept to capture interest income
    const CASH_LIKE = new Set(["cash"]);
    const investmentHoldings = holdings.filter((h) => !CASH_LIKE.has(h.asset_type));
    if (investmentHoldings.length === 0) return null;

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const ds = (d) => d.toISOString().slice(0, 10);

    const sub = (d, days) => { const r = new Date(d); r.setDate(r.getDate() - days); return r; };
    const monthStart  = new Date(today.getFullYear(), today.getMonth(), 1);
    const qtrStart    = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
    const yearStart   = new Date(today.getFullYear(), 0, 1);

    // Unrealized gain change using a pre-fetched period snapshot map { holdingId: marketValue }
    function unrealizedChange(snapForPeriod) {
      if (!snapForPeriod || Object.keys(snapForPeriod).length === 0) return null;
      let total = 0; let winners = 0; let losers = 0; let found = 0;
      for (const h of investmentHoldings) {
        const prev = snapForPeriod[h.id];
        if (prev == null) continue;
        found++;
        const d = Number(h.current_value ?? 0) - prev;
        total += d;
        if (d > 0.005) winners++;
        else if (d < -0.005) losers++;
      }
      return found > 0 ? { total, winners, losers } : null;
    }

    // Income and realized gains from transactions in a date range (from inclusive, to = today)
    // Only count transactions on investment holdings (not cash/money_market)
    const investmentHoldingIds = new Set(investmentHoldings.map((h) => h.id));
    function incomeIn(fromDateStr) {
      let income = 0; let realized = 0;
      for (const t of allTransactions) {
        if (!investmentHoldingIds.has(t.holding_id)) continue;
        if (fromDateStr && t.txn_date < fromDateStr) continue;
        if (t.txn_date > todayStr) continue;
        if ((t.txn_type === "dividend" || t.txn_type === "interest") && !t.is_reinvested) income += Number(t.amount ?? 0);
        if (t.txn_type === "fee") income -= Number(t.amount ?? 0);
        if (t.txn_type === "sell") realized += Number(t.amount ?? 0);
      }
      return { income, realized };
    }

    // Day: use snapMap directly — same source as the holdings table Day CHG column
    const dayIncome = incomeIn(todayStr);
    let dayUnrealized = 0; let dayWinners = 0; let dayLosers = 0; let dayFound = 0;
    for (const h of investmentHoldings) {
      const prev = snapMap[h.id];
      if (prev == null) continue;
      dayFound++;
      const d = Number(h.current_value ?? 0) - prev;
      dayUnrealized += d;
      if (d > 0.005) dayWinners++;
      else if (d < -0.005) dayLosers++;
    }

    const PERIODS = [
      { key: "week",  incomeFrom: ds(sub(today, 7)) },
      { key: "month", incomeFrom: ds(monthStart) },
      { key: "qtr",   incomeFrom: ds(qtrStart) },
      { key: "year",  incomeFrom: ds(yearStart) },
    ];

    const cols = {
      day: {
        unrealized: dayFound > 0 ? dayUnrealized : null,
        realized:   dayIncome.realized,
        income:     dayIncome.income,
        total:      dayFound > 0 ? dayUnrealized + dayIncome.realized + dayIncome.income : null,
        winners:    dayFound > 0 ? dayWinners : null,
        losers:     dayFound > 0 ? dayLosers  : null,
      },
    };
    for (const p of PERIODS) {
      const unr = unrealizedChange(periodSnaps[p.key]);
      const { income, realized } = incomeIn(p.incomeFrom);
      cols[p.key] = {
        unrealized: unr?.total ?? null,
        realized,
        income,
        total: (realized !== 0 || income !== 0 || unr != null) ? (unr?.total ?? 0) + realized + income : null,
        winners: unr?.winners ?? null,
        losers: unr?.losers ?? null,
      };
    }

    // ALL: unrealized = net_gain from view; income = pre-aggregated totals from holdings_valued
    // (transactions are filtered to current year so can't be used for all-time income)
    const totalNetGain = investmentHoldings.reduce((s, h) => s + Number(h.net_gain ?? 0), 0);
    const allTimeIncome = investmentHoldings.reduce((s, h) =>
      s + Number(h.total_interest ?? 0) + Number(h.total_dividends ?? 0) - Number(h.total_fees ?? 0), 0);
    const allTimeRealized = incomeIn(null).realized;
    cols.all = {
      label: "ALL",
      unrealized: totalNetGain,
      realized: allTimeRealized,
      income: allTimeIncome,
      total: totalNetGain + allTimeRealized + allTimeIncome,
      winners: investmentHoldings.filter((h) => Number(h.net_gain ?? 0) > 0.005).length,
      losers:  investmentHoldings.filter((h) => Number(h.net_gain ?? 0) < -0.005).length,
    };

    return cols;
  }, [holdings, snapMap, periodSnaps, allTransactions]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const filtersActive = filterSearch.trim() !== "" || filterSymbols.length > 0 || filterAssetTypes.length > 0 || filterAccounts.length > 0;
  const filterCount = (filterSearch.trim() ? 1 : 0) + filterSymbols.length + filterAssetTypes.length + filterAccounts.length;
  const filteredHoldings = (holdings ?? []).filter((h) => {
    const q = filterSearch.trim().toLowerCase();
    const searchOk = q === "" || (h.symbol ?? "").toLowerCase().includes(q) || (h.name ?? "").toLowerCase().includes(q);
    const symbolOk = filterSymbols.length === 0 || filterSymbols.includes(h.symbol);
    const typeOk = filterAssetTypes.length === 0 || filterAssetTypes.includes(h.asset_type);
    const acctOk = filterAccounts.length === 0 || filterAccounts.includes(h.account_id);
    return searchOk && symbolOk && typeOk && acctOk;
  });
  const uniqueAssetTypeCodes = [...new Set((holdings ?? []).map((h) => h.asset_type))].sort();
  const uniqueSymbols = [...new Set((holdings ?? []).map((h) => h.symbol).filter(Boolean))].sort();

  // Group filteredHoldings by asset_type (DB already orders by asset_type then symbol)
  const holdingGroups = (() => {
    const groups = [];
    const seen = {};
    for (const h of filteredHoldings) {
      if (!seen[h.asset_type]) {
        seen[h.asset_type] = [];
        groups.push({
          code: h.asset_type,
          label: assetTypes.find((a) => a.code === h.asset_type)?.label ?? h.asset_type,
          items: seen[h.asset_type],
        });
      }
      seen[h.asset_type].push(h);
    }
    return groups;
  })();
  const filteredTxns = filterTxnTypes.length === 0
    ? transactions
    : transactions.filter((t) => filterTxnTypes.includes(t.txn_type));
  const txnFiltersActive = filterTxnTypes.length > 0;
  const selectedAddTxnType = txnTypes.find((t) => t.code === addTxnForm.txn_type);
  const isCashHoldingView = viewingHolding?.asset_type === "cash";
  const isUnitAddTxn = selectedAddTxnType?.affects_quantity !== 0 && selectedAddTxnType != null && !isCashHoldingView;
  const isReinvestDividend = addTxnForm.txn_type === "dividend" && !isCashHoldingView;
  const incomeTotal = (!isCashHoldingView && viewingHolding)
    ? transactions.filter(t => (t.txn_type === "dividend" || t.txn_type === "interest") && !t.is_reinvested && t.holding_id === viewingHolding.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
      - transactions.filter(t => t.txn_type === "fee" && t.holding_id === viewingHolding.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  const reinvestedDividends = (!isCashHoldingView && viewingHolding)
    ? transactions.filter(t => t.txn_type === "dividend" && t.is_reinvested && t.holding_id === viewingHolding.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  const costBasisNum = Number(viewingHolding?.cost_basis ?? 0);
  const originalCostBasis = costBasisNum - reinvestedDividends;
  const isLoan = viewingHolding?.asset_type === "loan";
  const totalBuy = isLoan
    ? transactions.filter(t => t.txn_type === "buy" && t.holding_id === viewingHolding?.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  // Loans: gain = interest − fees; return = gain / total invested
  // Others: gain = price appreciation + reinvested divs + income
  const totalGain = isLoan
    ? incomeTotal
    : Number(viewingHolding?.net_gain ?? 0) + reinvestedDividends + incomeTotal;
  const totalReturnPct = isLoan
    ? (totalBuy > 0 ? totalGain / totalBuy * 100 : null)
    : (originalCostBasis > 0 ? totalGain / originalCostBasis * 100 : null);
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
            onClick={() => {
              const allCodes = holdingGroups.map((g) => g.code);
              const allCollapsed = allCodes.every((c) => collapsedGroups.has(c));
              setCollapsedGroups(allCollapsed ? new Set() : new Set(allCodes));
            }}
            title={holdingGroups.every((g) => collapsedGroups.has(g.code)) ? "Expand all" : "Collapse all"}
            className="p-1.5 rounded-lg border border-ink-line text-paper-dim hover:text-paper transition-colors"
          >
            {holdingGroups.every((g) => collapsedGroups.has(g.code)) ? (
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5h12M2 8h8M2 11h5" />
                <path d="M12 9l2 2-2 2" />
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5h12M2 8h8M2 11h5" />
                <path d="M14 9l-2 2 2 2" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setShowFilter((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              showFilter || filtersActive
                ? "border-brass/60 text-brass-soft bg-ink-soft"
                : "border-ink-line text-paper-dim hover:text-paper"
            }`}
          >
            {filtersActive ? `Filter (${filterCount})` : "Filter"}
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

      {/* Portfolio metrics grid */}
      {portfolioMetrics && (() => {
        const COLS = ["day", "week", "month", "qtr", "year", "all"];
        const COL_LABELS = { day: "Day", week: "Week", month: "Curr Month", qtr: "Qtr", year: "Year", all: "ALL" };
        const fmt = (n) => {
          if (n == null) return <span className="text-paper-dim">—</span>;
          const abs = Math.abs(n);
          const s = abs >= 1_000_000 ? `$${(abs / 1_000_000).toFixed(2)}M`
                  : abs >= 1_000    ? `$${(abs / 1_000).toFixed(1)}k`
                  : `$${abs.toFixed(0)}`;
          if (Math.abs(n) < 0.005) return <span className="text-paper-dim num">$0</span>;
          return <span className={`num ${n > 0 ? "text-gain" : "text-loss"}`}>{n > 0 ? "+" : "-"}{s}</span>;
        };
        const ROWS = [
          { key: "unrealized", label: "Unrealized Gains" },
          { key: "realized",   label: "Realized Gains" },
          { key: "income",     label: "Income" },
          { key: "total",      label: "Total" },
        ];
        return (
          <div className="card mb-4 overflow-x-auto">
            <table className="w-full text-xs min-w-[520px]">
              <thead>
                <tr className="border-b border-ink-line">
                  <th className="text-left px-4 py-2 text-paper-dim font-normal w-36" />
                  {COLS.map((c) => (
                    <th key={c} className="text-right px-3 py-2 text-paper-dim font-medium">{COL_LABELS[c]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, ri) => (
                  <tr key={row.key} className={`border-b ${row.key === "total" ? "border-ink-line font-semibold" : "border-ink-line/40"}`}>
                    <td className={`px-4 py-2 ${row.key === "total" ? "text-paper" : "text-paper-dim"}`}>{row.label}</td>
                    {COLS.map((c) => (
                      <td key={c} className="text-right px-3 py-2">{fmt(portfolioMetrics[c]?.[row.key])}</td>
                    ))}
                  </tr>
                ))}
                {/* Spacer */}
                <tr className="h-2" />
                <tr className="border-t border-ink-line/40">
                  <td className="px-4 py-1.5 text-paper-dim">Winners</td>
                  {COLS.map((c) => {
                    const v = portfolioMetrics[c]?.winners;
                    return <td key={c} className={`text-right px-3 py-1.5 num ${v == null ? "text-paper-dim" : "text-gain"}`}>{v ?? "—"}</td>;
                  })}
                </tr>
                <tr>
                  <td className="px-4 py-1.5 text-paper-dim">Losers</td>
                  {COLS.map((c) => {
                    const v = portfolioMetrics[c]?.losers;
                    return <td key={c} className={`text-right px-3 py-1.5 num ${v == null ? "text-paper-dim" : v > 0 ? "text-loss" : "text-paper-dim"}`}>{v ?? "—"}</td>;
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* Holdings table card */}
      <div className="card">
        <div className="flex">
          {showFilter && (
            <div className="w-56 shrink-0 border-r border-ink-line p-4 space-y-5 overflow-y-auto max-h-[70vh]">
              <div>
                <p className="label mb-2">Search</p>
                <input
                  type="text"
                  className="field text-sm w-full"
                  placeholder="Symbol or name…"
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                />
              </div>
              {uniqueSymbols.length > 0 && (
                <div>
                  <p className="label mb-2">Symbol</p>
                  <div className="space-y-1.5">
                    {uniqueSymbols.map((sym) => (
                      <label key={sym} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-brass"
                          checked={filterSymbols.includes(sym)}
                          onChange={() =>
                            setFilterSymbols((prev) =>
                              prev.includes(sym) ? prev.filter((x) => x !== sym) : [...prev, sym]
                            )
                          }
                        />
                        {sym}
                      </label>
                    ))}
                  </div>
                </div>
              )}
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
                  onClick={() => { setFilterSearch(""); setFilterSymbols([]); setFilterAssetTypes([]); setFilterAccounts([]); }}
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
                  <th className="label text-right font-medium px-4 py-3">Qty</th>
                  <th className="label text-right font-medium px-4 py-3">Value</th>
                  <th className="label text-right font-medium px-4 py-3">Gain</th>
                  <th className="label text-right font-medium px-4 py-3">Day Chg</th>
                </tr>
              </thead>
              <tbody>
                {holdings === null && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-paper-dim">Loading…</td></tr>
                )}
                {holdings !== null && filteredHoldings.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-paper-dim">
                      {filtersActive ? "No holdings match the current filters." : "No holdings yet. Use + Add to create one."}
                    </td>
                  </tr>
                )}
                {holdingGroups.map(({ code, label, items }) => {
                  const isCollapsed = collapsedGroups.has(code);
                  const groupValue = items.reduce((s, h) => s + Number(h.current_value ?? 0), 0);
                  const groupGain  = items.reduce((s, h) => {
                    const netIncome = Number(h.total_interest ?? 0) + Number(h.total_dividends ?? 0) - Number(h.total_fees ?? 0);
                    return s + (h.asset_type === "loan" ? netIncome : Number(h.net_gain ?? 0) + netIncome);
                  }, 0);
                  const hasDayData = items.some((h) => snapMap[h.id] != null);
                  const groupDayChg = hasDayData
                    ? items.reduce((s, h) => {
                        const snap = snapMap[h.id];
                        return snap != null ? s + (Number(h.current_value ?? 0) - snap) : s;
                      }, 0)
                    : null;
                  return (
                    <Fragment key={code}>
                      {/* Group header — click to toggle */}
                      <tr
                        className="border-b border-ink-line bg-ink-soft/50 cursor-pointer hover:bg-ink-soft transition-colors select-none"
                        onClick={() => toggleGroup(code)}
                      >
                        <td className="px-2 py-2.5 text-paper-dim">
                          <ChevronIcon collapsed={isCollapsed} />
                        </td>
                        <td className="px-4 py-2.5 font-semibold text-sm" colSpan={2}>
                          {label}
                          <span className="text-paper-dim ml-2 text-xs font-normal">{items.length}</span>
                        </td>
                        <td className="num text-right px-4 py-2.5 text-paper-dim text-xs">—</td>
                        <td className="num text-right px-4 py-2.5 text-sm font-medium">{usd(groupValue)}</td>
                        <td className={`num text-right px-4 py-2.5 text-sm font-medium ${groupGain > 0 ? "text-gain" : groupGain < 0 ? "text-loss" : "text-paper-dim"}`}>
                          {groupGain > 0 ? "+" : ""}{usd(groupGain)}
                        </td>
                        <td className={`num text-right px-4 py-2.5 text-sm ${groupDayChg == null ? "text-paper-dim" : groupDayChg > 0 ? "text-gain" : groupDayChg < 0 ? "text-loss" : "text-paper-dim"}`}>
                          {groupDayChg == null ? "—" : `${groupDayChg > 0 ? "+" : ""}${usd(groupDayChg)}`}
                        </td>
                      </tr>

                      {/* Individual holding rows */}
                      {!isCollapsed && items.map((h) => {
                        const netIncome = Number(h.total_interest ?? 0) + Number(h.total_dividends ?? 0) - Number(h.total_fees ?? 0);
                        const gain = h.asset_type === "loan" ? netIncome : Number(h.net_gain ?? 0) + netIncome;
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
                            <td className="px-4 py-3 text-paper-dim text-sm">{accountMap[h.account_id] ?? "—"}</td>
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
                    </Fragment>
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
                <label className="label block mb-1.5">Simulator bucket</label>
                <select
                  className="field"
                  value={editForm.simulator_key}
                  onChange={(e) => { const v = e.target.value; setEditForm((prev) => ({ ...prev, simulator_key: v })); }}
                >
                  <option value="">Auto ({defaultSimulatorKey(editForm.asset_type) ?? "unclassified"})</option>
                  {SIMULATOR_KEYS.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
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
          className={`absolute right-0 top-0 h-full w-full max-w-[1120px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${
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
              <div className="grid grid-cols-2 sm:grid-cols-8 gap-px border-b border-ink-line">
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Qty</p>
                  <p className="num text-sm font-medium">
                    {Number(viewingHolding.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 })}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Cost Basis</p>
                  <p className="num text-sm font-medium">{usd(viewingHolding.cost_basis)}</p>
                </div>
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Value</p>
                  <p className="num text-sm font-medium">{usd(viewingHolding.current_value)}</p>
                </div>
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Price Gain</p>
                  <p className={`num text-sm font-medium ${Number(viewingHolding.net_gain ?? 0) > 0 ? "text-gain" : Number(viewingHolding.net_gain ?? 0) < 0 ? "text-loss" : ""}`}>
                    {Number(viewingHolding.net_gain ?? 0) > 0 ? "+" : ""}{usd(viewingHolding.net_gain)}
                    {viewingHolding.net_gain_pct != null && (
                      <span className="text-xs ml-1.5 opacity-80">
                        {Number(viewingHolding.net_gain ?? 0) > 0 ? "+" : ""}{Number(viewingHolding.net_gain_pct).toFixed(1)}%
                      </span>
                    )}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Income</p>
                  <p className={`num text-sm font-medium ${incomeTotal > 0 ? "text-gain" : "text-paper-dim"}`}>
                    {incomeTotal > 0 ? "+" : ""}{usd(incomeTotal)}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Total Gain</p>
                  <p className={`num text-sm font-medium ${totalGain > 0 ? "text-gain" : totalGain < 0 ? "text-loss" : ""}`}>
                    {totalGain > 0 ? "+" : ""}{usd(totalGain)}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Total Return</p>
                  <p className={`num text-sm font-medium ${totalReturnPct == null ? "text-paper-dim" : totalReturnPct > 0 ? "text-gain" : totalReturnPct < 0 ? "text-loss" : ""}`}>
                    {totalReturnPct == null ? "—" : `${totalReturnPct > 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`}
                  </p>
                </div>
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-0.5 uppercase tracking-wide">Day Chg</p>
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
                {/* TradingView price chart — only for exchange-traded asset types */}
                {TV_CHART_TYPES.has(viewingHolding.asset_type) ? (
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
                ) : MARKET_TYPES.has(viewingHolding.asset_type) && (
                  <div className="border-b border-ink-line px-5 py-3">
                    <p className="label text-xs mb-0.5">Price chart</p>
                    <p className="text-xs text-paper-dim">
                      {viewingHolding.asset_type === "mutual_fund" || viewingHolding.asset_type === "money_market"
                        ? "Chart unavailable — NAV-priced funds are not listed on exchanges."
                        : "Chart unavailable for this asset type."}
                    </p>
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
                            {filteredTxns.map((t) => {
                              const isLinked = t.holding_id !== viewingHolding?.id;
                              return (
                              <tr key={t.id} className="border-b border-ink-line/60 last:border-0">
                                <td className="py-2.5">
                                  {!isLinked && (
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
                                  )}
                                  {!isLinked && txnMenuOpenId === t.id && typeof document !== "undefined" && createPortal(
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
              onChange={(e) => setAddTxnForm({ ...addTxnForm, txn_type: e.target.value, linked_holding_id: "" })}
            >
              <option value="">Select…</option>
              {txnTypes.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </div>
          {(addTxnForm.txn_type === "transfer_out" || addTxnForm.txn_type === "transfer_in") && (
            <div>
              <label className="label block mb-1.5">
                {addTxnForm.txn_type === "transfer_out" ? "Transfer to" : "Transfer from"}
              </label>
              <select
                className="field"
                value={addTxnForm.linked_holding_id}
                onChange={(e) => setAddTxnForm({ ...addTxnForm, linked_holding_id: e.target.value })}
              >
                <option value="">None (manual entry only)</option>
                {(holdings ?? [])
                  .filter((h) => h.asset_type === "cash" && h.id !== viewingHolding?.id)
                  .map((h) => (
                    <option key={h.id} value={h.id}>{h.name || h.symbol}</option>
                  ))}
              </select>
              {addTxnForm.linked_holding_id && (
                <p className="text-xs text-paper-dim mt-1">
                  The offsetting {addTxnForm.txn_type === "transfer_out" ? "Transfer In" : "Transfer Out"} will be recorded automatically.
                </p>
              )}
            </div>
          )}
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
          {isReinvestDividend && (
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-brass w-4 h-4"
                  checked={addTxnForm.reinvest}
                  onChange={(e) => setAddTxnForm({ ...addTxnForm, reinvest: e.target.checked })}
                />
                <span className="text-sm text-paper">Re-Invest dividend</span>
              </label>
              {addTxnForm.reinvest && (
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className="label block mb-1.5">Shares purchased</label>
                    <input
                      className="field num"
                      type="number"
                      step="any"
                      placeholder="0.000"
                      value={addTxnForm.reinvest_quantity}
                      onChange={(e) => setAddTxnForm({ ...addTxnForm, reinvest_quantity: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="label block mb-1.5">Price / share</label>
                    <input
                      className="field num"
                      type="number"
                      step="any"
                      placeholder="optional"
                      value={addTxnForm.reinvest_price}
                      onChange={(e) => setAddTxnForm({ ...addTxnForm, reinvest_price: e.target.value })}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          {addTxnError && <p className="text-loss text-sm">{addTxnError}</p>}
          <button
            className="btn w-full"
            onClick={saveAddTxn}
            disabled={
              addTxnBusy ||
              !addTxnForm.txn_type ||
              !addTxnForm.txn_date ||
              (addTxnForm.reinvest && !addTxnForm.reinvest_quantity)
            }
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
