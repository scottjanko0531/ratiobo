"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabase";
import { cashAmount, CASH_LEG_TYPES } from "../../lib/cash";
import Shell from "../../components/Shell";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

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
  const [detailBusy, setDetailBusy] = useState(false);

  const [viewingHolding, setViewingHolding] = useState(null);
  const [holdingTransactions, setHoldingTransactions] = useState([]);
  const [txnBusy, setTxnBusy] = useState(false);

  const [holdingMenuOpenId, setHoldingMenuOpenId] = useState(null);
  const [holdingMenuPos, setHoldingMenuPos] = useState({ top: 0, left: 0 });
  const [editingHolding, setEditingHolding] = useState(null);
  const [editHoldingForm, setEditHoldingForm] = useState({ symbol: "", name: "", asset_type: "", quantity: "" });
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
  const [addTxnForm, setAddTxnForm] = useState({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "" });
  const [addTxnError, setAddTxnError] = useState("");
  const [addTxnBusy, setAddTxnBusy] = useState(false);

  const [addingHolding, setAddingHolding] = useState(false);
  const [addHoldingForm, setAddHoldingForm] = useState({ symbol: "", name: "", asset_type: "", quantity: "", cost_basis: "" });
  const [addHoldingError, setAddHoldingError] = useState("");
  const [addHoldingBusy, setAddHoldingBusy] = useState(false);

  async function load() {
    const [{ data: accts, error: aErr }, { data: t }, { data: hv }, { data: tt }, { data: at }] = await Promise.all([
      supabase.from("accounts").select("*").order("created_at"),
      supabase.from("account_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("holdings_valued").select("account_id, asset_type, current_value"),
      supabase.from("transaction_types").select("code, label, affects_quantity").eq("is_active", true).order("sort_order"),
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order")
    ]);
    if (aErr) setError(aErr.message);
    setAccounts(accts ?? []);
    setTypes(t ?? []);
    setTxnTypes(tt ?? []);
    setAssetTypes(at ?? []);

    const totals = {};
    for (const h of hv ?? []) {
      if (!h.account_id) continue;
      const bucket = totals[h.account_id] ?? { cash: 0, holdings: 0 };
      if (h.asset_type === "cash") bucket.cash += Number(h.current_value ?? 0);
      else bucket.holdings += Number(h.current_value ?? 0);
      totals[h.account_id] = bucket;
    }
    setTotalsByAccount(totals);
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
    load();
  }

  async function openDetail(account) {
    setViewingAccount(account);
    setDetailBusy(true);
    const { data } = await supabase
      .from("holdings_valued")
      .select("id, symbol, name, asset_type, quantity, cost_basis, current_value, net_gain")
      .eq("account_id", account.id)
      .order("asset_type")
      .order("symbol");
    setAccountHoldings(data ?? []);
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
    setAddHoldingForm({ symbol: "", name: "", asset_type: "", quantity: "", cost_basis: "" });
    setAddHoldingError("");
  }

  async function openHoldingDetail(holding) {
    setViewingHolding(holding);
    setTxnBusy(true);
    const [{ data: txns }, { data: fresh }] = await Promise.all([
      supabase
        .from("transactions")
        .select("id, txn_type, txn_date, quantity, price_per_unit, amount, fees, cash_holding_id")
        .eq("holding_id", holding.id)
        .order("txn_date", { ascending: false }),
      supabase
        .from("holdings_valued")
        .select("id, symbol, name, asset_type, quantity, cost_basis, current_value, net_gain")
        .eq("id", holding.id)
        .single()
    ]);
    setHoldingTransactions(txns ?? []);
    if (fresh) setViewingHolding(fresh);
    setTxnBusy(false);
  }

  function closeHoldingDetail() {
    setViewingHolding(null);
    setHoldingTransactions([]);
    setShowTxnFilter(false);
    setFilterTxnTypes([]);
    setAddingTransaction(false);
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "" });
    setAddTxnError("");
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

    setAddTxnBusy(false);
    setAddingTransaction(false);
    setAddTxnForm({ txn_type: "", txn_date: new Date().toISOString().slice(0, 10), quantity: "", price_per_unit: "", amount: "", fees: "" });
    load();
    await openHoldingDetail(viewingHolding);
  }

  function openEditHolding(holding) {
    setEditingHolding(holding);
    setEditHoldingForm({
      symbol: holding.symbol ?? "",
      name: holding.name ?? "",
      asset_type: holding.asset_type ?? "",
      quantity: holding.quantity != null ? String(holding.quantity) : ""
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
    const { error } = await supabase
      .from("holdings")
      .update({
        symbol: editHoldingForm.symbol,
        name: editHoldingForm.name || null,
        asset_type: editHoldingForm.asset_type,
        quantity: editHoldingForm.quantity === "" ? 0 : Number(editHoldingForm.quantity)
      })
      .eq("id", editingHolding.id);
    setEditHoldingBusy(false);
    if (error) {
      setEditHoldingError(error.message);
    } else {
      setEditingHolding(null);
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
    setEditBusy(false);
    if (error) setEditError(error.message);
    else {
      setEditing(null);
      load();
    }
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

  async function saveAddHolding() {
    setAddHoldingBusy(true);
    setAddHoldingError("");
    const { data: { user } } = await supabase.auth.getUser();

    const qty = addHoldingForm.quantity === "" ? 0 : Number(addHoldingForm.quantity);
    const costBasis = addHoldingForm.cost_basis === "" ? null : Number(addHoldingForm.cost_basis);

    const { data: holding, error: hErr } = await supabase
      .from("holdings")
      .insert({
        user_id: user.id,
        account_id: viewingAccount.id,
        symbol: addHoldingForm.symbol.trim().toUpperCase(),
        name: addHoldingForm.name || null,
        asset_type: addHoldingForm.asset_type,
        quantity: 0
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
    setAddHoldingForm({ symbol: "", name: "", asset_type: "", quantity: "", cost_basis: "" });
    load();
    await openDetail(viewingAccount);
  }

  async function deleteAccount(account) {
    setMenuOpenId(null);
    if (!confirm(`Delete account "${account.name}"? Holdings linked to it will become unassigned.`)) return;
    const { error } = await supabase.from("accounts").delete().eq("id", account.id);
    if (error) setError(error.message);
    else load();
  }

  const typeLabel = (code) => types.find((t) => t.code === code)?.label ?? code;

  const uniqueTxnTypeCodes = [...new Set(holdingTransactions.map((t) => t.txn_type))].sort();
  const filteredTransactions = filterTxnTypes.length === 0
    ? holdingTransactions
    : holdingTransactions.filter((t) => filterTxnTypes.includes(t.txn_type));
  const txnFiltersActive = filterTxnTypes.length > 0;
  const selectedAddTxnType = txnTypes.find((t) => t.code === addTxnForm.txn_type);
  const isCashHoldingAdd = viewingHolding?.asset_type === "cash";
  const isUnitAddTxn = selectedAddTxnType?.affects_quantity !== 0 && selectedAddTxnType != null && !isCashHoldingAdd;
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
      <h1 className="text-xl font-semibold tracking-tight mb-6">Accounts</h1>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-line">
                <th className="w-10 px-2 py-3"></th>
                <th className="label text-left font-medium px-4 py-3">Name</th>
                <th className="label text-left font-medium px-4 py-3">Institution</th>
                <th className="label text-left font-medium px-4 py-3">Type</th>
                <th className="label text-right font-medium px-4 py-3">Cash</th>
                <th className="label text-right font-medium px-4 py-3">Holdings</th>
                <th className="label text-right font-medium px-4 py-3">Total</th>
              </tr>
            </thead>
            <tbody>
              {accounts === null && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-paper-dim">Loading…</td></tr>
              )}
              {accounts?.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-paper-dim">
                    No accounts yet. Add one to organize your holdings.
                  </td>
                </tr>
              )}
              {accounts?.map((a) => (
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
                  <td className="px-4 py-3 font-medium">{a.name}</td>
                  <td className="px-4 py-3 text-paper-dim">{a.institution ?? "—"}</td>
                  <td className="px-4 py-3">{typeLabel(a.account_type)}</td>
                  <td className="num text-right px-4 py-3">{usd(totalsByAccount[a.id]?.cash ?? 0)}</td>
                  <td className="num text-right px-4 py-3">{usd(totalsByAccount[a.id]?.holdings ?? 0)}</td>
                  <td className="num text-right px-4 py-3 font-medium">
                    {usd((totalsByAccount[a.id]?.cash ?? 0) + (totalsByAccount[a.id]?.holdings ?? 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card p-5 space-y-4">
          <p className="font-medium">Add account</p>
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

              <div className="grid grid-cols-3 gap-px border-b border-ink-line">
                {[
                  { label: "Cash", value: totalsByAccount[viewingAccount.id]?.cash ?? 0 },
                  { label: "Holdings", value: totalsByAccount[viewingAccount.id]?.holdings ?? 0 },
                  { label: "Total", value: (totalsByAccount[viewingAccount.id]?.cash ?? 0) + (totalsByAccount[viewingAccount.id]?.holdings ?? 0) }
                ].map(({ label, value }) => (
                  <div key={label} className="px-5 py-4">
                    <p className="label mb-1">{label}</p>
                    <p className="num text-base font-medium">{usd(value)}</p>
                  </div>
                ))}
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
                          <th className="label text-left font-medium py-2 pr-4">Name</th>
                          <th className="label text-left font-medium py-2 pr-4">Type</th>
                          <th className="label text-right font-medium py-2 pr-2">Qty</th>
                          <th className="label text-right font-medium py-2 pr-2">Value</th>
                          <th className="label text-right font-medium py-2">Gain</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredHoldings.map((h) => {
                          const gain = Number(h.net_gain ?? 0);
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
                              <td className="py-2.5 pr-4 font-medium">{h.symbol}</td>
                              <td className="py-2.5 pr-4 text-paper-dim">{h.name ?? "—"}</td>
                              <td className="py-2.5 pr-4 label">{h.asset_type}</td>
                              <td className="num text-right py-2.5 pr-2">{Number(h.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 })}</td>
                              <td className="num text-right py-2.5 pr-2">{usd(h.current_value)}</td>
                              <td className={`num text-right py-2.5 ${gain > 0 ? "text-gain" : gain < 0 ? "text-loss" : "text-paper-dim"}`}>
                                {gain > 0 ? "+" : ""}{usd(gain)}
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
          className={`absolute right-0 top-0 h-full w-full max-w-[864px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${
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

              <div className="grid grid-cols-4 gap-px border-b border-ink-line">
                {[
                  { label: "Quantity", value: Number(viewingHolding.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 }) },
                  { label: "Cost basis", value: usd(viewingHolding.cost_basis) },
                  { label: "Value", value: usd(viewingHolding.current_value) },
                  { label: "Gain", value: usd(viewingHolding.net_gain), gain: Number(viewingHolding.net_gain ?? 0) }
                ].map(({ label, value, gain }) => (
                  <div key={label} className="px-5 py-4">
                    <p className="label mb-1">{label}</p>
                    <p className={`num text-base font-medium ${gain != null ? gain > 0 ? "text-gain" : gain < 0 ? "text-loss" : "" : ""}`}>
                      {gain != null && gain > 0 ? "+" : ""}{value}
                    </p>
                  </div>
                ))}
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
                            {filteredTransactions.map((t) => (
                              <tr key={t.id} className="border-b border-ink-line/60 last:border-0">
                                <td className="py-2.5">
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
                                  {txnMenuOpenId === t.id && typeof document !== "undefined" && createPortal(
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
                  onChange={(e) => setAddTxnForm({ ...addTxnForm, quantity: e.target.value })}
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
                  onChange={(e) => setAddTxnForm({ ...addTxnForm, price_per_unit: e.target.value })}
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
          {addTxnError && <p className="text-loss text-sm">{addTxnError}</p>}
          <div className="flex gap-3">
            <button
              className="btn flex-1"
              onClick={saveAddTransaction}
              disabled={addTxnBusy || !addTxnForm.txn_type || !addTxnForm.txn_date}
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
                      <input id="et-qty" className="field num" type="number" step="any" value={editTxnForm.quantity} onChange={(e) => setEditTxnForm({ ...editTxnForm, quantity: e.target.value })} />
                    </div>
                    <div>
                      <label className="label block mb-1.5" htmlFor="et-price">Price per unit</label>
                      <input id="et-price" className="field num" type="number" step="any" value={editTxnForm.price_per_unit} onChange={(e) => setEditTxnForm({ ...editTxnForm, price_per_unit: e.target.value })} />
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
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="ah-name">Name (optional)</label>
            <input
              id="ah-name"
              className="field"
              placeholder="Apple Inc."
              value={addHoldingForm.name}
              onChange={(e) => setAddHoldingForm({ ...addHoldingForm, name: e.target.value })}
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
    </Shell>
  );
}
