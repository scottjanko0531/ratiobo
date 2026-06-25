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

// Types priced by the market data feed — quantity is transaction-driven, no manual price.
const MARKET_TYPES = new Set(["equity", "etf", "closed_end_fund", "mutual_fund", "money_market", "bond", "crypto", "metal"]);
const TV_CHART_TYPES = new Set(["equity", "etf", "closed_end_fund", "crypto", "metal"]);
// Types with no live feed — user sets current price per unit manually.
const MANUAL_PRICE_TYPES = new Set(["real_estate", "loan", "other"]);

const METAL_TV_SYMBOLS = { XAU: "TVC:GOLD", XAG: "TVC:SILVER", XPT: "TVC:PLATINUM", XPD: "TVC:PALLADIUM" };
function getTVSymbol(symbol, assetType) {
  const s = (symbol ?? "").toUpperCase();
  if (assetType === "crypto") return `COINBASE:${s}USD`;
  if (assetType === "metal") return METAL_TV_SYMBOLS[s] ?? `TVC:${s}`;
  return s;
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

const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
];

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="2.5" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="8" cy="13.5" r="1.3" />
    </svg>
  );
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState(null);
  const [totalsByAccount, setTotalsByAccount] = useState({});
  const [types, setTypes] = useState([]);
  const [assetTypes, setAssetTypes] = useState([]);
  const [txnTypes, setTxnTypes] = useState([]);
  const [form, setForm] = useState({ name: "", institution: "", account_type: "", initial_cash: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [menuOpenId, setMenuOpenId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", institution: "", account_type: "" });
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const [viewingAccount, setViewingAccount] = useState(null);
  const [accountHoldings, setAccountHoldings] = useState([]);
  const [holdingIncomeMap, setHoldingIncomeMap] = useState({});
  const [holdingReinvestedMap, setHoldingReinvestedMap] = useState({});
  const [detailBusy, setDetailBusy] = useState(false);

  const [viewingHolding, setViewingHolding] = useState(null);
  const [holdingTransactions, setHoldingTransactions] = useState([]);
  const [txnBusy, setTxnBusy] = useState(false);

  const [holdingMenuOpenId, setHoldingMenuOpenId] = useState(null);
  const [holdingMenuPos, setHoldingMenuPos] = useState({ top: 0, left: 0 });
  const [editingHolding, setEditingHolding] = useState(null);
  const [editHoldingForm, setEditHoldingForm] = useState({ symbol: "", name: "", asset_type: "", quantity: "", price_override: "" });
  const [editHoldingError, setEditHoldingError] = useState("");
  const [editHoldingBusy, setEditHoldingBusy] = useState(false);

  const [showFilter, setShowFilter] = useState(false);
  const [filterTypes, setFilterTypes] = useState([]);
  const [filterSymbols, setFilterSymbols] = useState([]);

  const [txnMenuOpenId, setTxnMenuOpenId] = useState(null);
  const [txnMenuPos, setTxnMenuPos] = useState({ top: 0, left: 0 });
  const [editingTransaction, setEditingTransaction] = useState(null);
  const [editTxnForm, setEditTxnForm] = useState({ txn_type: "", txn_date: "", quantity: "", price_per_unit: "", amount: "", fees: "" });
  const [editTxnError, setEditTxnError] = useState("");
  const [editTxnBusy, setEditTxnBusy] = useState(false);

  const [showTxnFilter, setShowTxnFilter] = useState(false);
  const [filterTxnTypes, setFilterTxnTypes] = useState([]);

  const [addingTransaction, setAddingTransaction] = useState(false);
  const [addTxnForm, setAddTxnForm] = useState({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "", reinvest: false, reinvest_quantity: "", reinvest_price: "" });
  const [addTxnError, setAddTxnError] = useState("");
  const [addTxnBusy, setAddTxnBusy] = useState(false);

  const [addingHolding, setAddingHolding] = useState(false);
  const [addHoldingForm, setAddHoldingForm] = useState({ symbol: "", name: "", asset_type: "", quantity: "", cost_basis: "", price_override: "" });
  const [addHoldingError, setAddHoldingError] = useState("");
  const [addHoldingBusy, setAddHoldingBusy] = useState(false);
  const [addHoldingLookupBusy, setAddHoldingLookupBusy] = useState(false);

  // Accounts-level add / filter / tags panel visibility
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAccountFilter, setShowAccountFilter] = useState(false);
  const [filterAccountTypes, setFilterAccountTypes] = useState([]);
  const [filterAccountTags, setFilterAccountTags] = useState([]);
  const [filterAccountInstitution, setFilterAccountInstitution] = useState("");

  // Tags
  const [tags, setTags] = useState([]);
  const [accountTagMap, setAccountTagMap] = useState({});
  const [managingTags, setManagingTags] = useState(false);
  const [newTagForm, setNewTagForm] = useState({ name: "", color: "#3b82f6" });
  const [newTagError, setNewTagError] = useState("");
  const [newTagBusy, setNewTagBusy] = useState(false);
  const [editingTag, setEditingTag] = useState(null);
  const [editTagForm, setEditTagForm] = useState({ name: "", color: "" });
  const [editTagError, setEditTagError] = useState("");
  const [editTagBusy, setEditTagBusy] = useState(false);
  const [editAccountTags, setEditAccountTags] = useState([]);

  const [holdingSnapshots, setHoldingSnapshots] = useState({});
  const [accountSnapshotTotals, setAccountSnapshotTotals] = useState({});
  const [showTVChart, setShowTVChart] = useState(true);
  const [showHoldingHistory, setShowHoldingHistory] = useState(true);
  const [holdingHistory, setHoldingHistory] = useState([]);
  const [historyRange, setHistoryRange] = useState("all");

  async function load() {
    const today = new Date().toISOString().slice(0, 10);
    const [
      { data: accts, error: aErr }, { data: t }, { data: hv }, { data: tt },
      { data: at }, { data: tgs }, { data: acctTags }, { data: snaps }
    ] = await Promise.all([
      supabase.from("accounts").select("*").order("created_at"),
      supabase.from("account_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("holdings_valued").select("account_id, asset_type, current_value, net_gain"),
      supabase.from("transaction_types").select("code, label, affects_quantity").eq("is_active", true).order("sort_order"),
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("tags").select("id, name, color").order("name"),
      supabase.from("account_tags").select("account_id, tag_id"),
      supabase.from("portfolio_snapshots").select("account_id, market_value").eq("snapshot_date", today)
    ]);
    if (aErr) setError(aErr.message);
    setAccounts(accts ?? []);
    setTypes(t ?? []);
    setTxnTypes(tt ?? []);
    setAssetTypes(at ?? []);
    setTags(tgs ?? []);
    const tagMap = {};
    for (const row of acctTags ?? []) {
      if (!tagMap[row.account_id]) tagMap[row.account_id] = [];
      tagMap[row.account_id].push(row.tag_id);
    }
    setAccountTagMap(tagMap);

    const totals = {};
    for (const h of hv ?? []) {
      if (!h.account_id) continue;
      const bucket = totals[h.account_id] ?? { cash: 0, holdings: 0, net_gain: 0 };
      if (h.asset_type === "cash") bucket.cash += Number(h.current_value ?? 0);
      else bucket.holdings += Number(h.current_value ?? 0);
      bucket.net_gain += Number(h.net_gain ?? 0);
      totals[h.account_id] = bucket;
    }
    setTotalsByAccount(totals);

    const snapTotals = {};
    for (const s of snaps ?? []) {
      if (!s.account_id) continue;
      snapTotals[s.account_id] = (snapTotals[s.account_id] ?? 0) + Number(s.market_value ?? 0);
    }
    setAccountSnapshotTotals(snapTotals);
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (menuOpenId === null) return;
    function close() { setMenuOpenId(null); }
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpenId]);

  useEffect(() => {
    if (holdingMenuOpenId === null) return;
    function close() { setHoldingMenuOpenId(null); }
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [holdingMenuOpenId]);

  useEffect(() => {
    if (txnMenuOpenId === null) return;
    function close() { setTxnMenuOpenId(null); }
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [txnMenuOpenId]);

  async function addAccount() {
    setBusy(true);
    setError("");
    const { data: { user } } = await supabase.auth.getUser();

    const { data: account, error: acctErr } = await supabase
      .from("accounts")
      .insert({
        user_id: user.id,
        name: form.name,
        institution: form.institution || null,
        account_type: form.account_type
      })
      .select()
      .single();
    if (acctErr) {
      setBusy(false);
      setError(acctErr.message);
      return;
    }

    const { data: cashHolding, error: cashErr } = await supabase
      .from("holdings")
      .insert({
        user_id: user.id,
        account_id: account.id,
        symbol: "USD",
        name: "Cash",
        asset_type: "cash",
        quantity: 0
      })
      .select()
      .single();
    if (cashErr) {
      setBusy(false);
      setError(cashErr.message);
      return;
    }

    const initialCash = form.initial_cash === "" ? 0 : Number(form.initial_cash);
    if (initialCash > 0) {
      const { error: txnErr } = await supabase.from("transactions").insert({
        user_id: user.id,
        holding_id: cashHolding.id,
        txn_type: "transfer_in",
        txn_date: new Date().toISOString().slice(0, 10),
        quantity: initialCash,
        amount: initialCash,
        fees: 0
      });
      if (txnErr) {
        setBusy(false);
        setError(txnErr.message);
        return;
      }
      await supabase
        .from("holdings")
        .update({ quantity: cashAmount("transfer_in", initialCash, 0) })
        .eq("id", cashHolding.id);
    }

    setBusy(false);
    setForm({ name: "", institution: "", account_type: "", initial_cash: "" });
    setShowAddAccount(false);
    load();
  }

  async function openDetail(account) {
    setViewingAccount(account);
    setDetailBusy(true);
    const today = new Date().toISOString().slice(0, 10);
    const [{ data }, { data: snaps }, { data: incomeTxns }] = await Promise.all([
      supabase
        .from("holdings_valued")
        .select("id, symbol, name, asset_type, quantity, price_override, cost_basis, current_value, net_gain")
        .eq("account_id", account.id)
        .order("asset_type")
        .order("symbol"),
      supabase
        .from("portfolio_snapshots")
        .select("holding_id, market_value")
        .eq("account_id", account.id)
        .eq("snapshot_date", today),
      supabase
        .from("transactions")
        .select("holding_id, txn_type, amount, is_reinvested")
        .eq("account_id", account.id)
        .in("txn_type", ["dividend", "interest"])
    ]);
    setAccountHoldings(data ?? []);
    const snapMap = {};
    for (const s of snaps ?? []) snapMap[s.holding_id] = Number(s.market_value ?? 0);
    setHoldingSnapshots(snapMap);
    const incomeMap = {};
    const reinvestedMap = {};
    for (const t of incomeTxns ?? []) {
      const amt = Number(t.amount ?? 0);
      if (t.is_reinvested) {
        reinvestedMap[t.holding_id] = (reinvestedMap[t.holding_id] ?? 0) + amt;
      } else {
        incomeMap[t.holding_id] = (incomeMap[t.holding_id] ?? 0) + amt;
      }
    }
    setHoldingIncomeMap(incomeMap);
    setHoldingReinvestedMap(reinvestedMap);
    setDetailBusy(false);
  }

  function closeDetail() {
    setViewingAccount(null);
    setAccountHoldings([]);
    setViewingHolding(null);
    setHoldingTransactions([]);
    setShowFilter(false);
    setFilterTypes([]);
    setFilterSymbols([]);
    setAddingHolding(false);
    setAddHoldingForm({ symbol: "", name: "", asset_type: "", quantity: "", cost_basis: "", price_override: "" });
    setAddHoldingError("");
    setHoldingSnapshots({});
    setHoldingIncomeMap({});
    setHoldingReinvestedMap({});
  }

  async function openHoldingDetail(holding) {
    setViewingHolding(holding);
    setTxnBusy(true);
    const [{ data: txns }, { data: fresh }, { data: hist }] = await Promise.all([
      supabase
        .from("transactions")
        .select("id, txn_type, txn_date, quantity, price_per_unit, amount, fees, cash_holding_id, holding_id, is_reinvested")
        .or(`holding_id.eq.${holding.id},cash_holding_id.eq.${holding.id}`)
        .order("txn_date", { ascending: false }),
      supabase
        .from("holdings_valued")
        .select("id, symbol, name, asset_type, quantity, price_override, cost_basis, current_value, net_gain")
        .eq("id", holding.id)
        .single(),
      supabase
        .from("portfolio_snapshots")
        .select("snapshot_date, market_value")
        .eq("holding_id", holding.id)
        .order("snapshot_date", { ascending: true })
    ]);
    setHoldingTransactions(txns ?? []);
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

  function closeHoldingDetail() {
    setViewingHolding(null);
    setHoldingTransactions([]);
    setShowTxnFilter(false);
    setFilterTxnTypes([]);
    setAddingTransaction(false);
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "", reinvest: false, reinvest_quantity: "", reinvest_price: "" });
    setAddTxnError("");
    setHoldingHistory([]);
    setShowTVChart(true);
    setShowHoldingHistory(true);
    setHistoryRange("all");
  }

  async function saveAddTransaction() {
    setAddTxnBusy(true);
    setAddTxnError("");
    const { data: { user } } = await supabase.auth.getUser();
    const isCashHolding = viewingHolding.asset_type === "cash";
    const selectedType = txnTypes.find((t) => t.code === addTxnForm.txn_type);
    const amount = addTxnForm.amount !== "" ? Number(addTxnForm.amount) : null;
    const fees = addTxnForm.fees === "" ? 0 : Number(addTxnForm.fees);
    const quantity = isCashHolding ? amount : addTxnForm.quantity === "" ? null : Number(addTxnForm.quantity);
    const cashLeg =
      !isCashHolding && viewingHolding.account_id && CASH_LEG_TYPES.has(addTxnForm.txn_type)
        ? accountHoldings.find((h) => h.asset_type === "cash" && h.account_id === viewingHolding.account_id)
        : null;

    // Dividend reinvestment: two paired transactions — dividend in, then buy back
    if (addTxnForm.txn_type === "dividend" && addTxnForm.reinvest && !isCashHolding) {
      const reinvestQty   = Number(addTxnForm.reinvest_quantity);
      const reinvestPrice = addTxnForm.reinvest_price !== "" ? Number(addTxnForm.reinvest_price) : null;

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

      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", viewingHolding.id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + reinvestQty }).eq("id", viewingHolding.id);
      // Cash net = 0 (dividend +amount, buy -amount), no cash holding update needed

    } else {
      const { error: txnErr } = await supabase.from("transactions").insert({
        user_id: user.id,
        holding_id: viewingHolding.id,
        cash_holding_id: cashLeg?.id ?? null,
        txn_type: addTxnForm.txn_type,
        txn_date: addTxnForm.txn_date,
        quantity,
        price_per_unit: addTxnForm.price_per_unit === "" ? null : Number(addTxnForm.price_per_unit),
        amount,
        fees
      });
      if (txnErr) { setAddTxnBusy(false); setAddTxnError(txnErr.message); return; }

      const delta = isCashHolding
        ? cashAmount(addTxnForm.txn_type, amount, fees)
        : (selectedType?.affects_quantity ?? 0) * (quantity ?? 0);
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
    }

    setAddTxnBusy(false);
    setAddingTransaction(false);
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "", reinvest: false, reinvest_quantity: "", reinvest_price: "" });
    load();
    await openHoldingDetail(viewingHolding);
  }

  function openEditHolding(holding) {
    setEditingHolding(holding);
    setEditHoldingForm({
      symbol: holding.symbol ?? "",
      name: holding.name ?? "",
      asset_type: holding.asset_type ?? "",
      quantity: holding.quantity != null ? String(holding.quantity) : "",
      price_override: holding.price_override != null ? String(holding.price_override) : ""
    });
    setEditHoldingError("");
    setHoldingMenuOpenId(null);
  }

  function closeEditHolding() {
    setEditingHolding(null);
  }

  async function saveEditHolding() {
    setEditHoldingBusy(true);
    setEditHoldingError("");
    const isMarket = MARKET_TYPES.has(editHoldingForm.asset_type);
    const isManual = MANUAL_PRICE_TYPES.has(editHoldingForm.asset_type);
    const updates = {
      symbol: editHoldingForm.symbol,
      name: editHoldingForm.name || null,
      asset_type: editHoldingForm.asset_type,
      price_override: isManual && editHoldingForm.price_override !== ""
        ? Number(editHoldingForm.price_override)
        : null
    };
    if (!isMarket) {
      updates.quantity = editHoldingForm.quantity === "" ? 0 : Number(editHoldingForm.quantity);
    }
    const { error } = await supabase
      .from("holdings")
      .update(updates)
      .eq("id", editingHolding.id);
    setEditHoldingBusy(false);
    if (error) {
      setEditHoldingError(error.message);
    } else {
      setEditingHolding(null);
      load();
      if (viewingAccount) await openDetail(viewingAccount);
    }
  }

  function openEdit(account) {
    setEditing(account);
    setEditForm({
      name: account.name,
      institution: account.institution ?? "",
      account_type: account.account_type
    });
    setEditAccountTags(accountTagMap[account.id] ?? []);
    setEditError("");
    setMenuOpenId(null);
  }

  function closeEdit() {
    setEditing(null);
  }

  async function saveEdit() {
    setEditBusy(true);
    setEditError("");
    const { error } = await supabase
      .from("accounts")
      .update({
        name: editForm.name,
        institution: editForm.institution || null,
        account_type: editForm.account_type
      })
      .eq("id", editing.id);
    if (error) { setEditBusy(false); setEditError(error.message); return; }

    await supabase.from("account_tags").delete().eq("account_id", editing.id);
    if (editAccountTags.length > 0) {
      await supabase.from("account_tags").insert(
        editAccountTags.map((tag_id) => ({ account_id: editing.id, tag_id }))
      );
    }

    setEditBusy(false);
    setEditing(null);
    load();
  }

  function openEditTransaction(txn) {
    setEditingTransaction(txn);
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

  function closeEditTransaction() { setEditingTransaction(null); }

  async function saveEditTransaction() {
    setEditTxnBusy(true);
    setEditTxnError("");
    const isCash = viewingHolding.asset_type === "cash";
    const oldTxn = editingTransaction;
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
    setEditingTransaction(null);
    load();
    await openHoldingDetail(viewingHolding);
  }

  async function deleteTransaction(txn) {
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
    await openHoldingDetail(viewingHolding);
  }

  async function lookupHoldingSymbol(symbol) {
    if (!symbol.trim()) return;
    setAddHoldingLookupBusy(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/lookup-symbol?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`
      );
      if (res.ok) {
        const data = await res.json();
        if (!data.error) {
          setAddHoldingForm((prev) => ({
            ...prev,
            name: prev.name || data.name || "",
            asset_type: prev.asset_type || data.asset_type || "",
          }));
        }
      }
    } catch (_) {}
    setAddHoldingLookupBusy(false);
  }

  async function saveAddHolding() {
    setAddHoldingBusy(true);
    setAddHoldingError("");
    const { data: { user } } = await supabase.auth.getUser();

    const qty = addHoldingForm.quantity === "" ? 0 : Number(addHoldingForm.quantity);
    const costBasis = addHoldingForm.cost_basis === "" ? null : Number(addHoldingForm.cost_basis);
    const isManual = MANUAL_PRICE_TYPES.has(addHoldingForm.asset_type);
    const priceOverride = isManual && addHoldingForm.price_override !== ""
      ? Number(addHoldingForm.price_override)
      : null;

    const { data: holding, error: hErr } = await supabase
      .from("holdings")
      .insert({
        user_id: user.id,
        account_id: viewingAccount.id,
        symbol: addHoldingForm.symbol.trim().toUpperCase(),
        name: addHoldingForm.name || null,
        asset_type: addHoldingForm.asset_type,
        quantity: 0,
        price_override: priceOverride
      })
      .select()
      .single();
    if (hErr) { setAddHoldingBusy(false); setAddHoldingError(hErr.message); return; }

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
      if (txnErr) { setAddHoldingBusy(false); setAddHoldingError(txnErr.message); return; }

      await supabase.from("holdings").update({ quantity: qty }).eq("id", holding.id);
    }

    setAddHoldingBusy(false);
    setAddingHolding(false);
    setAddHoldingForm({ symbol: "", name: "", asset_type: "", quantity: "", cost_basis: "", price_override: "" });
    load();
    await openDetail(viewingAccount);
  }

  async function createTag() {
    if (!newTagForm.name.trim()) return;
    setNewTagBusy(true);
    setNewTagError("");
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("tags").insert({
      user_id: user.id,
      name: newTagForm.name.trim(),
      color: newTagForm.color
    });
    setNewTagBusy(false);
    if (error) { setNewTagError(error.message); return; }
    setNewTagForm({ name: "", color: "#3b82f6" });
    load();
  }

  async function saveEditTag() {
    if (!editTagForm.name.trim()) return;
    setEditTagBusy(true);
    setEditTagError("");
    const { error } = await supabase.from("tags")
      .update({ name: editTagForm.name.trim(), color: editTagForm.color })
      .eq("id", editingTag.id);
    setEditTagBusy(false);
    if (error) { setEditTagError(error.message); return; }
    setEditingTag(null);
    load();
  }

  async function deleteTag(tag) {
    if (!confirm(`Delete tag "${tag.name}"? It will be removed from all accounts.`)) return;
    await supabase.from("tags").delete().eq("id", tag.id);
    load();
  }

  async function deleteAccount(account) {
    setMenuOpenId(null);
    if (!confirm(`Delete account "${account.name}"? Holdings linked to it will become unassigned.`)) return;
    const { error } = await supabase.from("accounts").delete().eq("id", account.id);
    if (error) setError(error.message);
    else load();
  }

  const typeLabel = (code) => types.find((t) => t.code === code)?.label ?? code;

  const uniqueInstitutions = [...new Set((accounts ?? []).map((a) => a.institution).filter(Boolean))].sort();

  const accountFiltersActive =
    filterAccountTypes.length > 0 || filterAccountTags.length > 0 || filterAccountInstitution !== "";
  const filteredAccounts = (accounts ?? []).filter((a) => {
    const typeOk = filterAccountTypes.length === 0 || filterAccountTypes.includes(a.account_type);
    const tagOk  = filterAccountTags.length === 0  || filterAccountTags.some((tid) => accountTagMap[a.id]?.includes(tid));
    const instOk = filterAccountInstitution === ""  || (a.institution ?? "").toLowerCase().includes(filterAccountInstitution.toLowerCase());
    return typeOk && tagOk && instOk;
  });

  const grandTotalCash     = filteredAccounts.reduce((s, a) => s + (totalsByAccount[a.id]?.cash     ?? 0), 0);
  const grandTotalHoldings = filteredAccounts.reduce((s, a) => s + (totalsByAccount[a.id]?.holdings ?? 0), 0);
  const grandTotalValue    = grandTotalCash + grandTotalHoldings;
  const grandTotalNetGain  = filteredAccounts.reduce((s, a) => s + (totalsByAccount[a.id]?.net_gain ?? 0), 0);
  const grandTotalDayChange = filteredAccounts.reduce((s, a) => {
    const snap = accountSnapshotTotals[a.id];
    if (snap == null) return s;
    const cur = (totalsByAccount[a.id]?.cash ?? 0) + (totalsByAccount[a.id]?.holdings ?? 0);
    return s + (cur - snap);
  }, 0);
  const hasDayChange = filteredAccounts.some((a) => accountSnapshotTotals[a.id] != null);

  const uniqueTxnTypeCodes = [...new Set(holdingTransactions.map((t) => t.txn_type))].sort();
  const filteredTransactions = filterTxnTypes.length === 0
    ? holdingTransactions
    : holdingTransactions.filter((t) => filterTxnTypes.includes(t.txn_type));
  const txnFiltersActive = filterTxnTypes.length > 0;
  const selectedAddTxnType = txnTypes.find((t) => t.code === addTxnForm.txn_type);
  const isCashHoldingAdd = viewingHolding?.asset_type === "cash";
  const isUnitAddTxn = selectedAddTxnType?.affects_quantity !== 0 && selectedAddTxnType != null && !isCashHoldingAdd;
  const isReinvestDividend = addTxnForm.txn_type === "dividend" && !isCashHoldingAdd;
  const incomeTotal = (!isCashHoldingAdd && viewingHolding)
    ? holdingTransactions.filter(t => (t.txn_type === "dividend" || t.txn_type === "interest") && !t.is_reinvested && t.holding_id === viewingHolding.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  const reinvestedDividends = (!isCashHoldingAdd && viewingHolding)
    ? holdingTransactions.filter(t => t.txn_type === "dividend" && t.is_reinvested && t.holding_id === viewingHolding.id)
        .reduce((s, t) => s + Number(t.amount ?? 0), 0)
    : 0;
  const costBasisNum = Number(viewingHolding?.cost_basis ?? 0);
  const originalCostBasis = costBasisNum - reinvestedDividends;
  // Total Gain = (MV − OCB) + non-reinvested income = net_gain + RD + income
  const totalGain = Number(viewingHolding?.net_gain ?? 0) + reinvestedDividends + incomeTotal;
  const totalReturnPct = originalCostBasis > 0 ? totalGain / originalCostBasis * 100 : null;
  const addTxnCashLeg =
    viewingHolding && !isCashHoldingAdd && viewingHolding.account_id && CASH_LEG_TYPES.has(addTxnForm.txn_type)
      ? accountHoldings.find((h) => h.asset_type === "cash" && h.account_id === viewingHolding.account_id)
      : null;

  const uniqueHoldingTypes = [...new Set(accountHoldings.map((h) => h.asset_type))].sort();
  const uniqueSymbols = [...new Set(accountHoldings.map((h) => h.symbol))].sort();
  const filteredHoldings = accountHoldings.filter((h) => {
    const typeOk = filterTypes.length === 0 || filterTypes.includes(h.asset_type);
    const symbolOk = filterSymbols.length === 0 || filterSymbols.includes(h.symbol);
    return typeOk && symbolOk;
  });
  const filtersActive = filterTypes.length > 0 || filterSymbols.length > 0;

  return (
    <Shell>
      {/* Page header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Accounts</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAccountFilter((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              showAccountFilter || accountFiltersActive
                ? "border-brass/60 text-brass-soft bg-ink-soft"
                : "border-ink-line text-paper-dim hover:text-paper"
            }`}
          >
            {accountFiltersActive ? `Filter (${filterAccountTypes.length + filterAccountTags.length + (filterAccountInstitution ? 1 : 0)})` : "Filter"}
          </button>
          <button
            onClick={() => { setShowAddAccount((v) => !v); setManagingTags(false); }}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              showAddAccount
                ? "border-brass/60 text-brass-soft bg-ink-soft"
                : "border-ink-line text-paper-dim hover:text-paper"
            }`}
          >
            + Add
          </button>
          <button
            onClick={() => { setManagingTags((v) => !v); setShowAddAccount(false); }}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              managingTags
                ? "border-brass/60 text-brass-soft bg-ink-soft"
                : "border-ink-line text-paper-dim hover:text-paper"
            }`}
          >
            Tags
          </button>
        </div>
      </div>

      {/* Summary panel */}
      <div className="card mb-4 grid grid-cols-2 sm:grid-cols-5 divide-x divide-y sm:divide-y-0 divide-ink-line">
        <div className="px-5 py-4">
          <p className="label text-xs">Cash</p>
          <p className="num text-lg font-semibold mt-1">{usd(grandTotalCash)}</p>
        </div>
        <div className="px-5 py-4">
          <p className="label text-xs">Holdings</p>
          <p className="num text-lg font-semibold mt-1">{usd(grandTotalHoldings)}</p>
        </div>
        <div className="px-5 py-4">
          <p className="label text-xs">Total value</p>
          <p className="num text-lg font-semibold mt-1">{usd(grandTotalValue)}</p>
        </div>
        <div className="px-5 py-4">
          <p className="label text-xs">Net gain</p>
          <p className={`num text-lg font-semibold mt-1 ${grandTotalNetGain > 0 ? "text-gain" : grandTotalNetGain < 0 ? "text-loss" : ""}`}>
            {usd(grandTotalNetGain)}
          </p>
        </div>
        <div className="px-5 py-4">
          <p className="label text-xs">Day change</p>
          {hasDayChange ? (
            <p className={`num text-lg font-semibold mt-1 ${grandTotalDayChange > 0 ? "text-gain" : grandTotalDayChange < 0 ? "text-loss" : ""}`}>
              {grandTotalDayChange > 0 ? "+" : ""}{usd(grandTotalDayChange)}
            </p>
          ) : (
            <p className="num text-lg font-semibold mt-1 text-paper-dim">—</p>
          )}
        </div>
      </div>

      {/* Accounts table — filter sidebar slides in on the left, same pattern as Holdings drawer */}
      <div className="card">
        <div className="flex">
          {showAccountFilter && (
            <div className="w-48 shrink-0 border-r border-ink-line p-4 space-y-5">
              <div>
                <p className="label mb-2">Account type</p>
                <div className="space-y-1.5">
                  {types.map((t) => (
                    <label key={t.code} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-brass"
                        checked={filterAccountTypes.includes(t.code)}
                        onChange={() =>
                          setFilterAccountTypes((prev) =>
                            prev.includes(t.code) ? prev.filter((c) => c !== t.code) : [...prev, t.code]
                          )
                        }
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>

              {tags.length > 0 && (
                <div>
                  <p className="label mb-2">Tags</p>
                  <div className="space-y-1.5">
                    {tags.map((tag) => {
                      const active = filterAccountTags.includes(tag.id);
                      return (
                        <label key={tag.id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            className="accent-brass"
                            checked={active}
                            onChange={() =>
                              setFilterAccountTags((prev) =>
                                active ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]
                              )
                            }
                          />
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: tag.color }}
                          />
                          {tag.name}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <p className="label mb-2">Institution</p>
                {uniqueInstitutions.length > 0 ? (
                  <div className="space-y-1.5">
                    {uniqueInstitutions.map((inst) => (
                      <label key={inst} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-brass"
                          checked={filterAccountInstitution === inst}
                          onChange={() =>
                            setFilterAccountInstitution((prev) => (prev === inst ? "" : inst))
                          }
                        />
                        {inst}
                      </label>
                    ))}
                  </div>
                ) : (
                  <input
                    className="field text-sm"
                    placeholder="Search…"
                    value={filterAccountInstitution}
                    onChange={(e) => setFilterAccountInstitution(e.target.value)}
                  />
                )}
              </div>

              {accountFiltersActive && (
                <button
                  className="text-xs text-paper-dim hover:text-paper transition-colors"
                  onClick={() => { setFilterAccountTypes([]); setFilterAccountTags([]); setFilterAccountInstitution(""); }}
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
                    {accountFiltersActive
                      ? `Accounts · ${filteredAccounts.length} of ${(accounts ?? []).length}`
                      : "Name"}
                  </th>
                  <th className="label text-left font-medium px-4 py-3">Institution</th>
                  <th className="label text-left font-medium px-4 py-3">Type</th>
                  <th className="label text-right font-medium px-4 py-3">Cash</th>
                  <th className="label text-right font-medium px-4 py-3">Holdings</th>
                  <th className="label text-right font-medium px-4 py-3">Total</th>
                  <th className="label text-right font-medium px-4 py-3">Day Chg</th>
                </tr>
              </thead>
              <tbody>
                {accounts === null && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-paper-dim">Loading…</td></tr>
                )}
                {accounts !== null && filteredAccounts.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-paper-dim">
                      {accountFiltersActive ? "No accounts match the current filters." : "No accounts yet. Use + Add to create one."}
                    </td>
                  </tr>
                )}
                {filteredAccounts.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-ink-line/60 last:border-0 cursor-pointer hover:bg-ink-soft/40 transition-colors"
                    onClick={() => openDetail(a)}
                  >
                    <td className="px-2 py-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (menuOpenId === a.id) {
                            setMenuOpenId(null);
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenuPos({ top: rect.bottom + 4, left: rect.left });
                            setMenuOpenId(a.id);
                          }
                        }}
                        className="p-1.5 rounded-lg text-paper-dim hover:text-paper hover:bg-ink-soft transition-colors"
                        aria-label={`Actions for ${a.name}`}
                      >
                        <KebabIcon />
                      </button>
                      {menuOpenId === a.id && typeof document !== "undefined" && createPortal(
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setMenuOpenId(null)} />
                          <div
                            className="fixed z-50 w-32 card p-1 shadow-lg"
                            style={{ top: menuPos.top, left: menuPos.left }}
                          >
                            <button
                              onClick={() => openEdit(a)}
                              className="w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-ink-soft transition-colors"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => deleteAccount(a)}
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
                      <div className="font-medium">{a.name}</div>
                      {(accountTagMap[a.id]?.length > 0) && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {accountTagMap[a.id].map((tid) => {
                            const tag = tags.find((t) => t.id === tid);
                            if (!tag) return null;
                            return (
                              <span
                                key={tid}
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-none"
                                style={{ backgroundColor: tag.color + "33", color: tag.color }}
                              >
                                {tag.name}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-paper-dim">{a.institution ?? "—"}</td>
                    <td className="px-4 py-3">{typeLabel(a.account_type)}</td>
                    <td className="num text-right px-4 py-3">{usd(totalsByAccount[a.id]?.cash ?? 0)}</td>
                    <td className="num text-right px-4 py-3">{usd(totalsByAccount[a.id]?.holdings ?? 0)}</td>
                    <td className="num text-right px-4 py-3 font-medium">
                      {usd((totalsByAccount[a.id]?.cash ?? 0) + (totalsByAccount[a.id]?.holdings ?? 0))}
                    </td>
                    <td className="num text-right px-4 py-3">
                      {(() => {
                        const snap = accountSnapshotTotals[a.id];
                        if (snap == null) return <span className="text-paper-dim">—</span>;
                        const cur = (totalsByAccount[a.id]?.cash ?? 0) + (totalsByAccount[a.id]?.holdings ?? 0);
                        const dc = cur - snap;
                        return (
                          <span className={dc > 0 ? "text-gain" : dc < 0 ? "text-loss" : "text-paper-dim"}>
                            {dc > 0 ? "+" : ""}{usd(dc)}
                          </span>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Add Account drawer */}
      <div className={`fixed inset-0 z-30 ${showAddAccount ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${showAddAccount ? "opacity-100" : "opacity-0"}`}
          onClick={() => setShowAddAccount(false)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            showAddAccount ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Add account</p>
            <button onClick={() => setShowAddAccount(false)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="acct-name">Name</label>
            <input
              id="acct-name"
              className="field"
              placeholder="Main brokerage"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="acct-inst">Institution (optional)</label>
            <input
              id="acct-inst"
              className="field"
              placeholder="Fidelity"
              value={form.institution}
              onChange={(e) => setForm({ ...form, institution: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="acct-type">Type</label>
            <select
              id="acct-type"
              className="field"
              value={form.account_type}
              onChange={(e) => setForm({ ...form, account_type: e.target.value })}
            >
              <option value="">Select a type…</option>
              {types.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="acct-cash">Initial cash balance (optional)</label>
            <input
              id="acct-cash"
              className="field num"
              type="number"
              step="any"
              placeholder="0.00"
              value={form.initial_cash}
              onChange={(e) => setForm({ ...form, initial_cash: e.target.value })}
            />
          </div>
          {error && <p className="text-loss text-sm">{error}</p>}
          <button
            className="btn w-full"
            onClick={addAccount}
            disabled={busy || !form.name || !form.account_type}
          >
            {busy ? "Saving…" : "Add account"}
          </button>
        </div>
      </div>

      {/* Detail drawer */}
      <div className={`fixed inset-0 z-30 ${viewingAccount ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${viewingAccount ? "opacity-100" : "opacity-0"}`}
          onClick={closeDetail}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-[1120px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${
            viewingAccount ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {viewingAccount && (
            <>
              <div className="flex items-center justify-between px-5 py-4 border-b border-ink-line">
                <div>
                  <p className="font-semibold text-base">{viewingAccount.name}</p>
                  <p className="text-xs text-paper-dim mt-0.5">
                    {typeLabel(viewingAccount.account_type)}
                    {viewingAccount.institution ? ` · ${viewingAccount.institution}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowFilter((f) => !f)}
                    className={`px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                      showFilter || filtersActive
                        ? "border-brass/60 text-brass-soft bg-ink-soft"
                        : "border-ink-line text-paper-dim hover:text-paper"
                    }`}
                  >
                    {filtersActive ? `Filter (${filterTypes.length + filterSymbols.length})` : "Filter"}
                  </button>
                  <button
                    onClick={() => setAddingHolding(true)}
                    className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors"
                  >
                    + Add
                  </button>
                  <button onClick={closeDetail} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">
                    ✕
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-px border-b border-ink-line">
                {[
                  { label: "Cash", value: totalsByAccount[viewingAccount.id]?.cash ?? 0 },
                  { label: "Holdings", value: totalsByAccount[viewingAccount.id]?.holdings ?? 0 },
                  { label: "Total", value: (totalsByAccount[viewingAccount.id]?.cash ?? 0) + (totalsByAccount[viewingAccount.id]?.holdings ?? 0) },
                ].map(({ label, value }) => (
                  <div key={label} className="px-5 py-4">
                    <p className="label mb-1">{label}</p>
                    <p className="num text-base font-medium">{usd(value)}</p>
                  </div>
                ))}
                <div className="px-5 py-4">
                  <p className="label mb-1">Income</p>
                  <p className="num text-base font-medium">
                    {usd(Object.values(holdingIncomeMap).reduce((s, v) => s + v, 0))}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <p className="label mb-1">Day Chg</p>
                  {(() => {
                    const snap = accountSnapshotTotals[viewingAccount.id];
                    if (snap == null) return <p className="num text-base font-medium text-paper-dim">—</p>;
                    const cur = (totalsByAccount[viewingAccount.id]?.cash ?? 0) + (totalsByAccount[viewingAccount.id]?.holdings ?? 0);
                    const dc = cur - snap;
                    return (
                      <p className={`num text-base font-medium ${dc > 0 ? "text-gain" : dc < 0 ? "text-loss" : ""}`}>
                        {dc > 0 ? "+" : ""}{usd(dc)}
                      </p>
                    );
                  })()}
                </div>
              </div>

              <div className="px-5 py-4">
                <div className="flex gap-5">
                {showFilter && (
                  <div className="w-44 shrink-0 border-r border-ink-line pr-5 space-y-5">
                    <div>
                      <p className="label mb-2">Holding type</p>
                      <div className="space-y-1.5">
                        {uniqueHoldingTypes.map((t) => (
                          <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              className="accent-brass"
                              checked={filterTypes.includes(t)}
                              onChange={() =>
                                setFilterTypes((prev) =>
                                  prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
                                )
                              }
                            />
                            {t}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="label mb-2">Symbol</p>
                      <div className="space-y-1.5">
                        {uniqueSymbols.map((s) => (
                          <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              className="accent-brass"
                              checked={filterSymbols.includes(s)}
                              onChange={() =>
                                setFilterSymbols((prev) =>
                                  prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
                                )
                              }
                            />
                            {s}
                          </label>
                        ))}
                      </div>
                    </div>
                    {filtersActive && (
                      <button
                        onClick={() => { setFilterTypes([]); setFilterSymbols([]); }}
                        className="text-xs text-paper-dim hover:text-paper"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                <p className="label mb-3">
                  Holdings{filtersActive ? ` · ${filteredHoldings.length} of ${accountHoldings.length}` : ""}
                </p>
                {detailBusy ? (
                  <p className="text-paper-dim text-sm">Loading…</p>
                ) : accountHoldings.length === 0 ? (
                  <p className="text-paper-dim text-sm">No holdings in this account.</p>
                ) : filteredHoldings.length === 0 ? (
                  <p className="text-paper-dim text-sm">No holdings match the current filters.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-ink-line">
                          <th className="w-8 py-2"></th>
                          <th className="label text-left font-medium py-2 pr-4">Symbol</th>
                          <th className="label text-left font-medium py-2 pr-4">Type</th>
                          <th className="label text-right font-medium py-2 pr-2">Qty</th>
                          <th className="label text-right font-medium py-2 pr-2">Value</th>
                          <th className="label text-right font-medium py-2 pr-2">Income</th>
                          <th className="label text-right font-medium py-2 pr-2">Total Gain</th>
                          <th className="label text-right font-medium py-2">Day Chg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredHoldings.map((h) => {
                          const income = holdingIncomeMap[h.id] ?? 0;
                          const reinvested = holdingReinvestedMap[h.id] ?? 0;
                          const totalGain = Number(h.net_gain ?? 0) + reinvested + income;
                          const snapVal = holdingSnapshots[h.id];
                          const dayChg = snapVal != null ? Number(h.current_value ?? 0) - snapVal : null;
                          return (
                            <tr
                              key={h.id}
                              className="border-b border-ink-line/60 last:border-0 cursor-pointer hover:bg-ink-soft/40 transition-colors"
                              onClick={() => openHoldingDetail(h)}
                            >
                              <td className="py-2.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (holdingMenuOpenId === h.id) {
                                      setHoldingMenuOpenId(null);
                                    } else {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      setHoldingMenuPos({ top: rect.bottom + 4, left: rect.left });
                                      setHoldingMenuOpenId(h.id);
                                    }
                                  }}
                                  className="p-1 rounded-lg text-paper-dim hover:text-paper hover:bg-ink-soft transition-colors"
                                  aria-label={`Actions for ${h.symbol}`}
                                >
                                  <KebabIcon />
                                </button>
                                {holdingMenuOpenId === h.id && typeof document !== "undefined" && createPortal(
                                  <>
                                    <div className="fixed inset-0 z-[70]" onClick={() => setHoldingMenuOpenId(null)} />
                                    <div
                                      className="fixed z-[80] w-32 card p-1 shadow-lg"
                                      style={{ top: holdingMenuPos.top, left: holdingMenuPos.left }}
                                    >
                                      <button
                                        onClick={(e) => { e.stopPropagation(); openEditHolding(h); }}
                                        className="w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-ink-soft transition-colors"
                                      >
                                        Edit
                                      </button>
                                    </div>
                                  </>,
                                  document.body
                                )}
                              </td>
                              <td className="py-2.5 pr-4">
                                <span className="font-medium">{h.symbol}</span>
                                {h.name && <span className="block text-xs text-paper-dim leading-tight">{h.name}</span>}
                              </td>
                              <td className="py-2.5 pr-4 label">{h.asset_type}</td>
                              <td className="num text-right py-2.5 pr-2">{Number(h.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 })}</td>
                              <td className="num text-right py-2.5 pr-2">{usd(h.current_value)}</td>
                              <td className="num text-right py-2.5 pr-2 text-paper-dim">
                                {income > 0 ? usd(income) : "—"}
                              </td>
                              <td className={`num text-right py-2.5 pr-2 ${totalGain > 0 ? "text-gain" : totalGain < 0 ? "text-loss" : "text-paper-dim"}`}>
                                {totalGain > 0 ? "+" : ""}{usd(totalGain)}
                              </td>
                              <td className={`num text-right py-2.5 ${dayChg == null ? "text-paper-dim" : dayChg > 0 ? "text-gain" : dayChg < 0 ? "text-loss" : "text-paper-dim"}`}>
                                {dayChg == null ? "—" : `${dayChg > 0 ? "+" : ""}${usd(dayChg)}`}
                              </td>
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

      {/* Holding transactions drawer */}
      <div className={`fixed inset-0 z-50 ${viewingHolding ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/50 transition-opacity ${viewingHolding ? "opacity-100" : "opacity-0"}`}
          onClick={closeHoldingDetail}
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
                  <button
                    onClick={closeHoldingDetail}
                    className="text-xs text-paper-dim hover:text-paper mb-1 flex items-center gap-1"
                  >
                    ← {viewingAccount?.name}
                  </button>
                  <p className="font-semibold text-base">
                    {viewingHolding.symbol}
                    {viewingHolding.name ? <span className="font-normal text-paper-dim ml-2">{viewingHolding.name}</span> : null}
                  </p>
                  <p className="text-xs text-paper-dim mt-0.5">{viewingHolding.asset_type}</p>
                </div>
                <div className="flex items-center gap-2">
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
                    onClick={() => setAddingTransaction(true)}
                    className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors"
                  >
                    + Add
                  </button>
                  <button onClick={closeHoldingDetail} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">
                    ✕
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-7 gap-px border-b border-ink-line">
                {[
                  { label: "Quantity", value: Number(viewingHolding.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 }) },
                  { label: "Cost Basis", value: usd(viewingHolding.cost_basis) },
                  { label: "Value", value: usd(viewingHolding.current_value) },
                  { label: "Price Gain", value: usd(viewingHolding.net_gain), gain: Number(viewingHolding.net_gain ?? 0) },
                  { label: "Income", value: incomeTotal > 0 ? `+${usd(incomeTotal)}` : usd(incomeTotal), gain: incomeTotal },
                  { label: "Total Gain", value: totalGain > 0 ? `+${usd(totalGain)}` : usd(totalGain), gain: totalGain },
                  { label: "Total Return", value: totalReturnPct == null ? "—" : `${totalReturnPct > 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`, gain: totalReturnPct },
                ].map(({ label, value, gain }) => (
                  <div key={label} className="px-3 py-3">
                    <p className="label text-[10px] mb-0.5 uppercase tracking-wide">{label}</p>
                    <p className={`num text-sm font-medium ${gain != null ? gain > 0 ? "text-gain" : gain < 0 ? "text-loss" : "" : ""}`}>
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              {/* Charts */}
              <div className="border-b border-ink-line">
                {/* TradingView price chart */}
                {TV_CHART_TYPES.has(viewingHolding.asset_type) && (
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

              <div className="px-5 py-4">
                <div className="flex gap-5">
                  {showTxnFilter && (
                    <div className="w-40 shrink-0 border-r border-ink-line pr-5 space-y-4">
                      <div>
                        <p className="label mb-2">Type</p>
                        <div className="space-y-1.5">
                          {uniqueTxnTypeCodes.map((code) => {
                            const lbl = txnTypes.find((t) => t.code === code)?.label ?? code;
                            return (
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
                                {lbl}
                              </label>
                            );
                          })}
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
                      Transactions{txnFiltersActive ? ` · ${filteredTransactions.length} of ${holdingTransactions.length}` : ""}
                    </p>
                    {txnBusy ? (
                      <p className="text-paper-dim text-sm">Loading…</p>
                    ) : holdingTransactions.length === 0 ? (
                      <p className="text-paper-dim text-sm">No transactions recorded for this holding.</p>
                    ) : filteredTransactions.length === 0 ? (
                      <p className="text-paper-dim text-sm">No transactions match the current filters.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-ink-line">
                              <th className="w-8 py-2"></th>
                              <th className="label text-left font-medium py-2 pr-4">Date</th>
                              <th className="label text-left font-medium py-2 pr-4">Type</th>
                              <th className="label text-right font-medium py-2 pr-3">Qty</th>
                              <th className="label text-right font-medium py-2 pr-3">Price</th>
                              <th className="label text-right font-medium py-2 pr-3">Amount</th>
                              <th className="label text-right font-medium py-2">Fees</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredTransactions.map((t) => {
                              const isLinked = t.holding_id !== viewingHolding?.id;
                              return (
                              <tr key={t.id} className="border-b border-ink-line/60 last:border-0">
                                <td className="py-2.5">
                                  {!isLinked && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (txnMenuOpenId === t.id) { setTxnMenuOpenId(null); }
                                      else {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setTxnMenuPos({ top: rect.bottom + 4, left: rect.left });
                                        setTxnMenuOpenId(t.id);
                                      }
                                    }}
                                    className="p-1 rounded-lg text-paper-dim hover:text-paper hover:bg-ink-soft transition-colors"
                                    aria-label="Transaction actions"
                                  >
                                    <KebabIcon />
                                  </button>
                                  )}
                                  {!isLinked && txnMenuOpenId === t.id && typeof document !== "undefined" && createPortal(
                                    <>
                                      <div className="fixed inset-0 z-[90]" onClick={() => setTxnMenuOpenId(null)} />
                                      <div className="fixed z-[100] w-32 card p-1 shadow-lg" style={{ top: txnMenuPos.top, left: txnMenuPos.left }}>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); openEditTransaction(t); }}
                                          className="w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-ink-soft transition-colors"
                                        >
                                          Edit
                                        </button>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); deleteTransaction(t); }}
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
                                <td className="py-2.5 pr-4">
                                  <span className="label px-1.5 py-0.5 rounded bg-ink-line/60">
                                    {txnTypes.find((tt) => tt.code === t.txn_type)?.label ?? t.txn_type}
                                  </span>
                                </td>
                                <td className="num text-right py-2.5 pr-3">
                                  {t.quantity != null ? Number(t.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—"}
                                </td>
                                <td className="num text-right py-2.5 pr-3">{usd(t.price_per_unit)}</td>
                                <td className="num text-right py-2.5 pr-3">{usd(t.amount)}</td>
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

      {/* Add transaction drawer */}
      <div className={`fixed inset-0 z-[70] ${addingTransaction ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/50 transition-opacity ${addingTransaction ? "opacity-100" : "opacity-0"}`}
          onClick={() => setAddingTransaction(false)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            addingTransaction ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Add transaction</p>
              {viewingHolding && (
                <p className="text-xs text-paper-dim mt-0.5">
                  {viewingHolding.symbol}{viewingHolding.name ? ` · ${viewingHolding.name}` : ""}
                </p>
              )}
            </div>
            <button onClick={() => setAddingTransaction(false)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5" htmlFor="at-type">Type</label>
              <select
                id="at-type"
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
              <label className="label block mb-1.5" htmlFor="at-date">Date</label>
              <input
                id="at-date"
                className="field"
                type="date"
                value={addTxnForm.txn_date}
                onChange={(e) => setAddTxnForm({ ...addTxnForm, txn_date: e.target.value })}
              />
            </div>
          </div>
          {addTxnCashLeg && (
            <p className="text-xs text-paper-dim">
              Cash leg: <span className="text-paper">Cash — {viewingAccount?.name}</span>
            </p>
          )}
          {isUnitAddTxn && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label block mb-1.5" htmlFor="at-qty">Quantity</label>
                <input
                  id="at-qty"
                  className="field num"
                  type="number"
                  step="any"
                  value={addTxnForm.quantity}
                  onChange={(e) => {
                    const qty = e.target.value;
                    const price = addTxnForm.price_per_unit;
                    const amount = qty && price && !isNaN(parseFloat(qty)) && !isNaN(parseFloat(price))
                      ? String(Math.round(parseFloat(qty) * parseFloat(price) * 100) / 100)
                      : addTxnForm.amount;
                    setAddTxnForm({ ...addTxnForm, quantity: qty, amount });
                  }}
                />
              </div>
              <div>
                <label className="label block mb-1.5" htmlFor="at-price">Price per unit</label>
                <input
                  id="at-price"
                  className="field num"
                  type="number"
                  step="any"
                  value={addTxnForm.price_per_unit}
                  onChange={(e) => {
                    const price = e.target.value;
                    const qty = addTxnForm.quantity;
                    const amount = qty && price && !isNaN(parseFloat(qty)) && !isNaN(parseFloat(price))
                      ? String(Math.round(parseFloat(qty) * parseFloat(price) * 100) / 100)
                      : addTxnForm.amount;
                    setAddTxnForm({ ...addTxnForm, price_per_unit: price, amount });
                  }}
                />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5" htmlFor="at-amount">Amount</label>
              <input
                id="at-amount"
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={addTxnForm.amount}
                onChange={(e) => setAddTxnForm({ ...addTxnForm, amount: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1.5" htmlFor="at-fees">Fees</label>
              <input
                id="at-fees"
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
          {(() => {
            const amt = parseFloat(addTxnForm.amount);
            const fee = parseFloat(addTxnForm.fees) || 0;
            const basis = !isNaN(amt) ? amt + fee : null;
            return basis != null ? (
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-ink border border-ink-line">
                <p className="label text-xs">Cost basis</p>
                <p className="num text-sm font-medium">
                  {basis.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                </p>
              </div>
            ) : null;
          })()}
          {addTxnError && <p className="text-loss text-sm">{addTxnError}</p>}
          <div className="flex gap-3">
            <button
              className="btn flex-1"
              onClick={saveAddTransaction}
              disabled={
                addTxnBusy ||
                !addTxnForm.txn_type ||
                !addTxnForm.txn_date ||
                (addTxnForm.reinvest && !addTxnForm.reinvest_quantity)
              }
            >
              {addTxnBusy ? "Saving…" : "Record transaction"}
            </button>
            <button className="btn-ghost flex-1" onClick={() => setAddingTransaction(false)}>Cancel</button>
          </div>
        </div>
      </div>

      {/* Edit transaction drawer */}
      <div className={`fixed inset-0 z-[80] ${editingTransaction ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/50 transition-opacity ${editingTransaction ? "opacity-100" : "opacity-0"}`}
          onClick={closeEditTransaction}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            editingTransaction ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {editingTransaction && (() => {
            const isCash = viewingHolding?.asset_type === "cash";
            const selType = txnTypes.find((t) => t.code === editTxnForm.txn_type);
            const isUnit = selType?.affects_quantity !== 0 && selType != null && !isCash;
            return (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Edit transaction</p>
                    {viewingHolding && <p className="text-xs text-paper-dim mt-0.5">{viewingHolding.symbol}</p>}
                  </div>
                  <button onClick={closeEditTransaction} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label block mb-1.5" htmlFor="et-type">Type</label>
                    <select id="et-type" className="field" value={editTxnForm.txn_type} onChange={(e) => setEditTxnForm({ ...editTxnForm, txn_type: e.target.value })}>
                      {txnTypes.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label block mb-1.5" htmlFor="et-date">Date</label>
                    <input id="et-date" className="field" type="date" value={editTxnForm.txn_date} onChange={(e) => setEditTxnForm({ ...editTxnForm, txn_date: e.target.value })} />
                  </div>
                </div>
                {isUnit && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label block mb-1.5" htmlFor="et-qty">Quantity</label>
                      <input id="et-qty" className="field num" type="number" step="any" value={editTxnForm.quantity}
                        onChange={(e) => {
                          const qty = e.target.value;
                          const price = editTxnForm.price_per_unit;
                          const amount = qty && price && !isNaN(parseFloat(qty)) && !isNaN(parseFloat(price))
                            ? String(Math.round(parseFloat(qty) * parseFloat(price) * 100) / 100)
                            : editTxnForm.amount;
                          setEditTxnForm({ ...editTxnForm, quantity: qty, amount });
                        }}
                      />
                    </div>
                    <div>
                      <label className="label block mb-1.5" htmlFor="et-price">Price per unit</label>
                      <input id="et-price" className="field num" type="number" step="any" value={editTxnForm.price_per_unit}
                        onChange={(e) => {
                          const price = e.target.value;
                          const qty = editTxnForm.quantity;
                          const amount = qty && price && !isNaN(parseFloat(qty)) && !isNaN(parseFloat(price))
                            ? String(Math.round(parseFloat(qty) * parseFloat(price) * 100) / 100)
                            : editTxnForm.amount;
                          setEditTxnForm({ ...editTxnForm, price_per_unit: price, amount });
                        }}
                      />
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label block mb-1.5" htmlFor="et-amount">Amount</label>
                    <input id="et-amount" className="field num" type="number" step="any" placeholder="0.00" value={editTxnForm.amount} onChange={(e) => setEditTxnForm({ ...editTxnForm, amount: e.target.value })} />
                  </div>
                  <div>
                    <label className="label block mb-1.5" htmlFor="et-fees">Fees</label>
                    <input id="et-fees" className="field num" type="number" step="any" placeholder="0.00" value={editTxnForm.fees} onChange={(e) => setEditTxnForm({ ...editTxnForm, fees: e.target.value })} />
                  </div>
                </div>
                {editTxnError && <p className="text-loss text-sm">{editTxnError}</p>}
                <div className="flex gap-3">
                  <button className="btn flex-1" onClick={saveEditTransaction} disabled={editTxnBusy || !editTxnForm.txn_type || !editTxnForm.txn_date}>
                    {editTxnBusy ? "Saving…" : "Save changes"}
                  </button>
                  <button className="btn-ghost flex-1" onClick={closeEditTransaction}>Cancel</button>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Edit holding drawer */}
      <div className={`fixed inset-0 z-[60] ${editingHolding ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/50 transition-opacity ${editingHolding ? "opacity-100" : "opacity-0"}`}
          onClick={closeEditHolding}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            editingHolding ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Edit holding</p>
            <button onClick={closeEditHolding} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="eh-symbol">Symbol</label>
            <input
              id="eh-symbol"
              className="field"
              value={editHoldingForm.symbol}
              onChange={(e) => setEditHoldingForm({ ...editHoldingForm, symbol: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="eh-name">Name (optional)</label>
            <input
              id="eh-name"
              className="field"
              value={editHoldingForm.name}
              onChange={(e) => setEditHoldingForm({ ...editHoldingForm, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="eh-type">Asset type</label>
            <select
              id="eh-type"
              className="field"
              value={editHoldingForm.asset_type}
              onChange={(e) => setEditHoldingForm({ ...editHoldingForm, asset_type: e.target.value })}
            >
              {assetTypes.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </div>
          {!MARKET_TYPES.has(editHoldingForm.asset_type) && (
            <div>
              <label className="label block mb-1.5" htmlFor="eh-qty">Quantity</label>
              <input
                id="eh-qty"
                className="field num"
                type="number"
                step="any"
                value={editHoldingForm.quantity}
                onChange={(e) => setEditHoldingForm({ ...editHoldingForm, quantity: e.target.value })}
              />
            </div>
          )}
          {MANUAL_PRICE_TYPES.has(editHoldingForm.asset_type) && (
            <div>
              <label className="label block mb-1.5" htmlFor="eh-price">Current price per unit</label>
              <input
                id="eh-price"
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={editHoldingForm.price_override}
                onChange={(e) => setEditHoldingForm({ ...editHoldingForm, price_override: e.target.value })}
              />
            </div>
          )}
          {editHoldingError && <p className="text-loss text-sm">{editHoldingError}</p>}
          <div className="flex gap-3">
            <button
              className="btn flex-1"
              onClick={saveEditHolding}
              disabled={editHoldingBusy || !editHoldingForm.symbol || !editHoldingForm.asset_type}
            >
              {editHoldingBusy ? "Saving…" : "Save changes"}
            </button>
            <button className="btn-ghost flex-1" onClick={closeEditHolding}>Cancel</button>
          </div>
        </div>
      </div>

      {/* Add holding drawer */}
      <div className={`fixed inset-0 z-[60] ${addingHolding ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/50 transition-opacity ${addingHolding ? "opacity-100" : "opacity-0"}`}
          onClick={() => setAddingHolding(false)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            addingHolding ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Add holding</p>
              {viewingAccount && <p className="text-xs text-paper-dim mt-0.5">{viewingAccount.name}</p>}
            </div>
            <button onClick={() => setAddingHolding(false)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="ah-symbol">Symbol</label>
            <input
              id="ah-symbol"
              className="field"
              placeholder="AAPL"
              value={addHoldingForm.symbol}
              onChange={(e) => setAddHoldingForm({ ...addHoldingForm, symbol: e.target.value })}
              onBlur={(e) => lookupHoldingSymbol(e.target.value)}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="ah-name">Name (optional)</label>
            <input
              id="ah-name"
              className="field"
              placeholder={addHoldingLookupBusy ? "Looking up…" : "Apple Inc."}
              value={addHoldingForm.name}
              onChange={(e) => setAddHoldingForm({ ...addHoldingForm, name: e.target.value })}
              disabled={addHoldingLookupBusy}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="ah-type">Asset type</label>
            <select
              id="ah-type"
              className="field"
              value={addHoldingForm.asset_type}
              onChange={(e) => setAddHoldingForm({ ...addHoldingForm, asset_type: e.target.value })}
            >
              <option value="">Select…</option>
              {assetTypes.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="ah-qty">Initial quantity (optional)</label>
            <input
              id="ah-qty"
              className="field num"
              type="number"
              step="any"
              placeholder="0"
              value={addHoldingForm.quantity}
              onChange={(e) => setAddHoldingForm({ ...addHoldingForm, quantity: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="ah-cost">Cost basis (optional)</label>
            <input
              id="ah-cost"
              className="field num"
              type="number"
              step="any"
              placeholder="0.00"
              value={addHoldingForm.cost_basis}
              onChange={(e) => setAddHoldingForm({ ...addHoldingForm, cost_basis: e.target.value })}
            />
          </div>
          {MANUAL_PRICE_TYPES.has(addHoldingForm.asset_type) && (
            <div>
              <label className="label block mb-1.5" htmlFor="ah-price">Current price per unit (optional)</label>
              <input
                id="ah-price"
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={addHoldingForm.price_override}
                onChange={(e) => setAddHoldingForm({ ...addHoldingForm, price_override: e.target.value })}
              />
            </div>
          )}
          {addHoldingError && <p className="text-loss text-sm">{addHoldingError}</p>}
          <div className="flex gap-3">
            <button
              className="btn flex-1"
              onClick={saveAddHolding}
              disabled={addHoldingBusy || !addHoldingForm.symbol || !addHoldingForm.asset_type}
            >
              {addHoldingBusy ? "Saving…" : "Add holding"}
            </button>
            <button className="btn-ghost flex-1" onClick={() => setAddingHolding(false)}>Cancel</button>
          </div>
        </div>
      </div>

      {/* Edit drawer */}
      <div className={`fixed inset-0 z-30 ${editing ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editing ? "opacity-100" : "opacity-0"}`}
          onClick={closeEdit}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            editing ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Edit account</p>
            <button onClick={closeEdit} className="text-paper-dim hover:text-paper" aria-label="Close">
              ✕
            </button>
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="edit-name">Name</label>
            <input
              id="edit-name"
              className="field"
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="edit-inst">Institution (optional)</label>
            <input
              id="edit-inst"
              className="field"
              value={editForm.institution}
              onChange={(e) => setEditForm({ ...editForm, institution: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="edit-type">Type</label>
            <select
              id="edit-type"
              className="field"
              value={editForm.account_type}
              onChange={(e) => setEditForm({ ...editForm, account_type: e.target.value })}
            >
              {types.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </div>
          {tags.length > 0 && (
            <div>
              <label className="label block mb-2">Tags</label>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => {
                  const active = editAccountTags.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() =>
                        setEditAccountTags(
                          active
                            ? editAccountTags.filter((id) => id !== tag.id)
                            : [...editAccountTags, tag.id]
                        )
                      }
                      className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all border"
                      style={
                        active
                          ? { backgroundColor: tag.color + "33", borderColor: tag.color, color: tag.color }
                          : { borderColor: "var(--color-ink-line)", color: "var(--color-paper-dim)" }
                      }
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {editError && <p className="text-loss text-sm">{editError}</p>}
          <div className="flex gap-3">
            <button
              className="btn flex-1"
              onClick={saveEdit}
              disabled={editBusy || !editForm.name || !editForm.account_type}
            >
              {editBusy ? "Saving…" : "Save changes"}
            </button>
            <button className="btn-ghost flex-1" onClick={closeEdit}>
              Cancel
            </button>
          </div>
        </div>
      </div>

      {/* Manage Tags drawer */}
      <div className={`fixed inset-0 z-30 ${managingTags ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${managingTags ? "opacity-100" : "opacity-0"}`}
          onClick={() => setManagingTags(false)}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            managingTags ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Manage tags</p>
            <button onClick={() => setManagingTags(false)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
          </div>

          {/* Existing tags */}
          <div className="space-y-1">
            {tags.length === 0 && <p className="text-sm text-paper-dim">No tags yet. Create one below.</p>}
            {tags.map((tag) => (
              <div key={tag.id} className="rounded-lg border border-ink-line p-2.5 space-y-2">
                {editingTag?.id === tag.id ? (
                  <>
                    <input
                      className="field text-sm"
                      value={editTagForm.name}
                      onChange={(e) => setEditTagForm({ ...editTagForm, name: e.target.value })}
                      autoFocus
                    />
                    <div className="flex gap-1.5 flex-wrap">
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setEditTagForm({ ...editTagForm, color: c })}
                          className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                          style={{
                            backgroundColor: c,
                            outline: editTagForm.color === c ? `2px solid ${c}` : "none",
                            outlineOffset: "2px"
                          }}
                        />
                      ))}
                    </div>
                    {editTagError && <p className="text-loss text-xs">{editTagError}</p>}
                    <div className="flex gap-2">
                      <button className="btn text-xs px-3 py-1.5 flex-1" onClick={saveEditTag} disabled={editTagBusy}>
                        {editTagBusy ? "Saving…" : "Save"}
                      </button>
                      <button className="btn-ghost text-xs px-3 py-1.5 flex-1" onClick={() => setEditingTag(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="text-sm flex-1 truncate">{tag.name}</span>
                    <button
                      onClick={() => { setEditingTag(tag); setEditTagForm({ name: tag.name, color: tag.color }); setEditTagError(""); }}
                      className="text-xs text-paper-dim hover:text-paper px-1.5 py-0.5 rounded transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteTag(tag)}
                      className="text-xs text-loss hover:text-loss/80 px-1.5 py-0.5 rounded transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Create new tag */}
          <div className="border-t border-ink-line pt-4 space-y-3">
            <p className="label">New tag</p>
            <input
              className="field text-sm"
              placeholder="Tag name"
              value={newTagForm.name}
              onChange={(e) => setNewTagForm({ ...newTagForm, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") createTag(); }}
            />
            <div className="flex gap-1.5 flex-wrap">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setNewTagForm({ ...newTagForm, color: c })}
                  className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    outline: newTagForm.color === c ? `2px solid ${c}` : "none",
                    outlineOffset: "2px"
                  }}
                />
              ))}
            </div>
            {newTagError && <p className="text-loss text-xs">{newTagError}</p>}
            <button
              className="btn w-full text-sm"
              onClick={createTag}
              disabled={newTagBusy || !newTagForm.name.trim()}
            >
              {newTagBusy ? "Saving…" : "Add tag"}
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}
