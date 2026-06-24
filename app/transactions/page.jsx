"use client";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { cashAmount, CASH_LEG_TYPES } from "../../lib/cash";
import Shell from "../../components/Shell";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_ADD = {
  account_filter: "",
  holding_id: "",
  txn_type: "",
  txn_date: today(),
  quantity: "",
  price_per_unit: "",
  amount: "",
  fees: "",
  notes: "",
};

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="2.5" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="8" cy="13.5" r="1.3" />
    </svg>
  );
}

export default function TransactionsPage() {
  const [txns, setTxns] = useState(null);
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [txnTypes, setTxnTypes] = useState([]);

  // Filter sidebar
  const [showFilter, setShowFilter] = useState(false);
  const [filterTypes, setFilterTypes] = useState([]);
  const [filterAccounts, setFilterAccounts] = useState([]);
  const [filterHoldings, setFilterHoldings] = useState([]);
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Kebab menu
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  // Add drawer
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ ...EMPTY_ADD });
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  // Edit drawer
  const [editingTxn, setEditingTxn] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  async function load() {
    const [
      { data: t },
      { data: h },
      { data: ac },
      { data: tt },
    ] = await Promise.all([
      supabase
        .from("transactions")
        .select("*, holding:holdings!holding_id(id, symbol, name, asset_type, account_id, accounts(id, name))")
        .order("txn_date", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase.from("holdings").select("id, symbol, name, asset_type, account_id, accounts(name)").order("symbol"),
      supabase.from("accounts").select("id, name").order("name"),
      supabase.from("transaction_types").select("code, label, affects_quantity").eq("is_active", true).order("sort_order"),
    ]);
    setTxns(t ?? []);
    setHoldings(h ?? []);
    setAccounts(ac ?? []);
    setTxnTypes(tt ?? []);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (menuOpenId === null) return;
    const close = () => setMenuOpenId(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [menuOpenId]);

  // ── Add form derived values ─────────────────────────────────────────────
  const addHoldingOpts = addForm.account_filter
    ? holdings.filter((h) => h.account_id === addForm.account_filter)
    : holdings;
  const addHolding = holdings.find((h) => h.id === addForm.holding_id);
  const addIsCash = addHolding?.asset_type === "cash";
  const addType = txnTypes.find((t) => t.code === addForm.txn_type);
  const addIsUnit = addType?.affects_quantity !== 0 && addType != null && !addIsCash;
  const addCashLeg =
    !addIsCash && addHolding?.account_id && CASH_LEG_TYPES.has(addForm.txn_type)
      ? holdings.find((h) => h.asset_type === "cash" && h.account_id === addHolding.account_id)
      : null;
  const addComputedAmount =
    addForm.quantity !== "" && addForm.price_per_unit !== ""
      ? (Number(addForm.quantity) * Number(addForm.price_per_unit)).toFixed(2)
      : "";

  // ── Edit form derived values ────────────────────────────────────────────
  const editIsCash = editingTxn?.holding?.asset_type === "cash";
  const editType = txnTypes.find((t) => t.code === editForm.txn_type);
  const editIsUnit = editType?.affects_quantity !== 0 && editType != null && !editIsCash;

  // ── Filter derived values ───────────────────────────────────────────────
  const filtersActive =
    filterTypes.length + filterAccounts.length + filterHoldings.length > 0 ||
    filterDateFrom !== "" || filterDateTo !== "";
  const filtered = (txns ?? []).filter((t) => {
    if (filterTypes.length && !filterTypes.includes(t.txn_type)) return false;
    if (filterAccounts.length && !filterAccounts.includes(t.holding?.account_id ?? "none")) return false;
    if (filterHoldings.length && !filterHoldings.includes(t.holding_id)) return false;
    if (filterDateFrom && t.txn_date < filterDateFrom) return false;
    if (filterDateTo && t.txn_date > filterDateTo) return false;
    return true;
  });

  const uniqueTypes = [...new Set((txns ?? []).map((t) => t.txn_type))].sort();
  const uniqueAccountIds = [...new Set((txns ?? []).map((t) => t.holding?.account_id).filter(Boolean))];
  const uniqueHoldingIds = [...new Set((txns ?? []).map((t) => t.holding_id))];

  // ── Save add ───────────────────────────────────────────────────────────
  async function saveAdd() {
    setAddBusy(true);
    setAddError("");
    const { data: { user } } = await supabase.auth.getUser();
    const amount =
      addForm.amount !== "" ? Number(addForm.amount)
      : addComputedAmount !== "" ? Number(addComputedAmount)
      : null;
    const fees = addForm.fees === "" ? 0 : Number(addForm.fees);
    const qty = addIsCash ? amount : addForm.quantity === "" ? null : Number(addForm.quantity);

    const { error: txnErr } = await supabase.from("transactions").insert({
      user_id: user.id,
      holding_id: addForm.holding_id,
      cash_holding_id: addCashLeg?.id ?? null,
      txn_type: addForm.txn_type,
      txn_date: addForm.txn_date,
      quantity: qty,
      price_per_unit: addForm.price_per_unit === "" ? null : Number(addForm.price_per_unit),
      amount,
      fees,
      notes: addForm.notes.trim() || null,
    });
    if (txnErr) { setAddBusy(false); setAddError(txnErr.message); return; }

    const delta = addIsCash
      ? cashAmount(addForm.txn_type, amount, fees)
      : (addType?.affects_quantity ?? 0) * (qty ?? 0);
    if (delta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", addForm.holding_id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + delta }).eq("id", addForm.holding_id);
    }
    if (addCashLeg) {
      const cashDelta = cashAmount(addForm.txn_type, amount, fees);
      if (cashDelta !== 0) {
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", addCashLeg.id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) + cashDelta }).eq("id", addCashLeg.id);
      }
    }

    setAddBusy(false);
    setShowAdd(false);
    setAddForm({ ...EMPTY_ADD });
    load();
  }

  // ── Open / save / delete edit ──────────────────────────────────────────
  function openEdit(txn) {
    setEditingTxn(txn);
    setEditForm({
      txn_type: txn.txn_type,
      txn_date: txn.txn_date,
      quantity: txn.quantity != null ? String(txn.quantity) : "",
      price_per_unit: txn.price_per_unit != null ? String(txn.price_per_unit) : "",
      amount: txn.amount != null ? String(txn.amount) : "",
      fees: txn.fees != null ? String(txn.fees) : "",
      notes: txn.notes ?? "",
    });
    setEditError("");
    setMenuOpenId(null);
  }

  async function saveEdit() {
    setEditBusy(true);
    setEditError("");
    const txn = editingTxn;
    const isCash = txn.holding?.asset_type === "cash";
    const newAmount = editForm.amount !== "" ? Number(editForm.amount) : null;
    const newFees = editForm.fees === "" ? 0 : Number(editForm.fees);
    const newQty = isCash ? newAmount : editForm.quantity === "" ? null : Number(editForm.quantity);
    const affectsOld = txnTypes.find((t) => t.code === txn.txn_type)?.affects_quantity ?? 0;
    const affectsNew = txnTypes.find((t) => t.code === editForm.txn_type)?.affects_quantity ?? 0;
    const oldDelta = isCash ? cashAmount(txn.txn_type, txn.amount, txn.fees) : affectsOld * (Number(txn.quantity) || 0);
    const newDelta = isCash ? cashAmount(editForm.txn_type, newAmount, newFees) : affectsNew * (newQty ?? 0);
    const netDelta = newDelta - oldDelta;

    if (netDelta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", txn.holding_id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) + netDelta }).eq("id", txn.holding_id);
    }
    if (txn.cash_holding_id) {
      const oldCash = cashAmount(txn.txn_type, txn.amount, txn.fees);
      const newCash = cashAmount(editForm.txn_type, newAmount, newFees);
      const netCash = newCash - oldCash;
      if (netCash !== 0) {
        const { data: ch } = await supabase.from("holdings").select("quantity").eq("id", txn.cash_holding_id).single();
        if (ch) await supabase.from("holdings").update({ quantity: Number(ch.quantity) + netCash }).eq("id", txn.cash_holding_id);
      }
    }

    const { error } = await supabase.from("transactions").update({
      txn_type: editForm.txn_type,
      txn_date: editForm.txn_date,
      quantity: newQty,
      price_per_unit: editForm.price_per_unit === "" ? null : Number(editForm.price_per_unit),
      amount: newAmount,
      fees: newFees,
      notes: editForm.notes.trim() || null,
    }).eq("id", txn.id);

    setEditBusy(false);
    if (error) { setEditError(error.message); return; }
    setEditingTxn(null);
    load();
  }

  async function deleteTxn(txn) {
    setMenuOpenId(null);
    if (!confirm(`Delete this ${txn.txn_type} transaction from ${txn.txn_date}?`)) return;
    const isCash = txn.holding?.asset_type === "cash";
    const affects = txnTypes.find((t) => t.code === txn.txn_type)?.affects_quantity ?? 0;
    const delta = isCash ? cashAmount(txn.txn_type, txn.amount, txn.fees) : affects * (Number(txn.quantity) || 0);
    if (delta !== 0) {
      const { data: h } = await supabase.from("holdings").select("quantity").eq("id", txn.holding_id).single();
      if (h) await supabase.from("holdings").update({ quantity: Number(h.quantity) - delta }).eq("id", txn.holding_id);
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
  }

  // ── Label helpers ──────────────────────────────────────────────────────
  const txnTypeLabel = (code) => txnTypes.find((t) => t.code === code)?.label ?? code;
  const holdingLabel = (h) =>
    h.asset_type === "cash"
      ? `Cash — ${h.accounts?.name ?? "Unassigned"}`
      : `${h.symbol}${h.name ? ` — ${h.name}` : ""}`;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Transactions</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilter((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              showFilter || filtersActive
                ? "border-brass/60 text-brass-soft bg-ink-soft"
                : "border-ink-line text-paper-dim hover:text-paper"
            }`}
          >
            {filtersActive ? `Filter (${filterTypes.length + filterAccounts.length + filterHoldings.length})` : "Filter"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
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

      {/* Table card */}
      <div className="card">
        <div className="flex">
          {/* Filter sidebar */}
          {showFilter && (
            <div className="w-52 shrink-0 border-r border-ink-line p-4 space-y-5">
              <div>
                <p className="label mb-2">Date range</p>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] text-paper-dim block mb-1">From</label>
                    <input
                      type="date"
                      className="field py-1 text-xs"
                      value={filterDateFrom}
                      onChange={(e) => setFilterDateFrom(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-paper-dim block mb-1">To</label>
                    <input
                      type="date"
                      className="field py-1 text-xs"
                      value={filterDateTo}
                      onChange={(e) => setFilterDateTo(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              {uniqueTypes.length > 0 && (
                <div>
                  <p className="label mb-2">Type</p>
                  <div className="space-y-1.5">
                    {uniqueTypes.map((code) => (
                      <label key={code} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-brass"
                          checked={filterTypes.includes(code)}
                          onChange={() =>
                            setFilterTypes((prev) =>
                              prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]
                            )
                          }
                        />
                        {txnTypeLabel(code)}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {uniqueAccountIds.length > 0 && (
                <div>
                  <p className="label mb-2">Account</p>
                  <div className="space-y-1.5">
                    {uniqueAccountIds.map((id) => {
                      const name = accounts.find((a) => a.id === id)?.name ?? id;
                      return (
                        <label key={id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            className="accent-brass"
                            checked={filterAccounts.includes(id)}
                            onChange={() =>
                              setFilterAccounts((prev) =>
                                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                              )
                            }
                          />
                          {name}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              {uniqueHoldingIds.length > 0 && (
                <div>
                  <p className="label mb-2">Holding</p>
                  <div className="space-y-1.5">
                    {uniqueHoldingIds.map((hid) => {
                      const h = holdings.find((x) => x.id === hid);
                      if (!h) return null;
                      return (
                        <label key={hid} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            className="accent-brass"
                            checked={filterHoldings.includes(hid)}
                            onChange={() =>
                              setFilterHoldings((prev) =>
                                prev.includes(hid) ? prev.filter((x) => x !== hid) : [...prev, hid]
                              )
                            }
                          />
                          <span className="truncate">
                            {h.asset_type === "cash" ? `Cash — ${h.accounts?.name ?? "—"}` : h.symbol}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              {filtersActive && (
                <button
                  className="text-xs text-paper-dim hover:text-paper transition-colors"
                  onClick={() => { setFilterTypes([]); setFilterAccounts([]); setFilterHoldings([]); setFilterDateFrom(""); setFilterDateTo(""); }}
                >
                  Clear all
                </button>
              )}
            </div>
          )}

          {/* Table */}
          <div className="flex-1 overflow-x-auto min-w-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-line">
                  <th className="w-10 px-2 py-3"></th>
                  <th className="label text-left font-medium px-4 py-3">
                    {filtersActive
                      ? `Transactions · ${filtered.length} of ${(txns ?? []).length}`
                      : "Date"}
                  </th>
                  <th className="label text-left font-medium px-4 py-3">Type</th>
                  <th className="label text-left font-medium px-4 py-3">Holding</th>
                  <th className="label text-left font-medium px-4 py-3">Account</th>
                  <th className="label text-right font-medium px-4 py-3">Qty</th>
                  <th className="label text-right font-medium px-4 py-3">Amount</th>
                  <th className="label text-right font-medium px-4 py-3">Fees</th>
                  <th className="label text-left font-medium px-4 py-3">Notes</th>
                </tr>
              </thead>
              <tbody>
                {txns === null && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-paper-dim">Loading…</td>
                  </tr>
                )}
                {txns !== null && filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-paper-dim">
                      {filtersActive
                        ? "No transactions match the current filters."
                        : "No transactions yet. Use + Add to record one."}
                    </td>
                  </tr>
                )}
                {filtered.map((t) => {
                  const h = t.holding;
                  return (
                    <tr
                      key={t.id}
                      className="border-b border-ink-line/60 last:border-0 hover:bg-ink-soft/40 transition-colors"
                    >
                      <td className="px-2 py-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (menuOpenId === t.id) {
                              setMenuOpenId(null);
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setMenuPos({ top: rect.bottom + 4, left: rect.left });
                              setMenuOpenId(t.id);
                            }
                          }}
                          className="p-1.5 rounded-lg text-paper-dim hover:text-paper hover:bg-ink-soft transition-colors"
                          aria-label="Transaction actions"
                        >
                          <KebabIcon />
                        </button>
                        {menuOpenId === t.id && typeof document !== "undefined" && createPortal(
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setMenuOpenId(null)} />
                            <div
                              className="fixed z-50 w-32 card p-1 shadow-lg"
                              style={{ top: menuPos.top, left: menuPos.left }}
                            >
                              <button
                                onClick={() => openEdit(t)}
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
                      <td className="px-4 py-3 num text-paper-dim">{t.txn_date}</td>
                      <td className="px-4 py-3 label">{txnTypeLabel(t.txn_type)}</td>
                      <td className="px-4 py-3">
                        {h ? (
                          <>
                            <span className="font-medium">
                              {h.asset_type === "cash" ? "Cash" : h.symbol}
                            </span>
                            {h.name && h.asset_type !== "cash" && (
                              <span className="text-paper-dim ml-2 text-xs">{h.name}</span>
                            )}
                          </>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3 text-paper-dim text-xs">
                        {h?.accounts?.name ?? "—"}
                      </td>
                      <td className="num text-right px-4 py-3">
                        {t.quantity != null
                          ? Number(t.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 })
                          : "—"}
                      </td>
                      <td className="num text-right px-4 py-3">{usd(t.amount)}</td>
                      <td className="num text-right px-4 py-3 text-paper-dim">{usd(t.fees)}</td>
                      <td className="px-4 py-3 text-xs text-paper-dim max-w-[160px]">
                        {t.notes ? (
                          <span className="truncate block" title={t.notes}>{t.notes}</span>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Add Transaction drawer ─────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${showAdd ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${showAdd ? "opacity-100" : "opacity-0"}`}
          onClick={() => { setShowAdd(false); setAddForm({ ...EMPTY_ADD }); setAddError(""); }}
        />
        <div
          className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${
            showAdd ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Add transaction</p>
            <button
              onClick={() => { setShowAdd(false); setAddForm({ ...EMPTY_ADD }); setAddError(""); }}
              className="text-paper-dim hover:text-paper"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Account filter → narrows holding list */}
          <div>
            <label className="label block mb-1.5">Account</label>
            <select
              className="field"
              value={addForm.account_filter}
              onChange={(e) =>
                setAddForm((p) => ({ ...p, account_filter: e.target.value, holding_id: "" }))
              }
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* Holding */}
          <div>
            <label className="label block mb-1.5">Holding</label>
            <select
              className="field"
              value={addForm.holding_id}
              onChange={(e) => setAddForm((p) => ({ ...p, holding_id: e.target.value }))}
            >
              <option value="">Select a holding…</option>
              {addHoldingOpts.map((h) => (
                <option key={h.id} value={h.id}>{holdingLabel(h)}</option>
              ))}
            </select>
          </div>

          {/* Type + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5">Type</label>
              <select
                className="field"
                value={addForm.txn_type}
                onChange={(e) => setAddForm((p) => ({ ...p, txn_type: e.target.value }))}
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
                value={addForm.txn_date}
                onChange={(e) => setAddForm((p) => ({ ...p, txn_date: e.target.value }))}
              />
            </div>
          </div>

          {/* Qty + Price (unit transactions only) */}
          {addIsUnit && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label block mb-1.5">Quantity</label>
                <input
                  className="field num"
                  type="number"
                  step="any"
                  value={addForm.quantity}
                  onChange={(e) => setAddForm((p) => ({ ...p, quantity: e.target.value }))}
                />
              </div>
              <div>
                <label className="label block mb-1.5">Price / unit</label>
                <input
                  className="field num"
                  type="number"
                  step="any"
                  value={addForm.price_per_unit}
                  onChange={(e) => setAddForm((p) => ({ ...p, price_per_unit: e.target.value }))}
                />
              </div>
            </div>
          )}

          {/* Amount + Fees */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5">
                Amount{addComputedAmount && addForm.amount === "" ? ` (auto: $${addComputedAmount})` : ""}
              </label>
              <input
                className="field num"
                type="number"
                step="any"
                placeholder={addComputedAmount || "0.00"}
                value={addForm.amount}
                onChange={(e) => setAddForm((p) => ({ ...p, amount: e.target.value }))}
              />
            </div>
            <div>
              <label className="label block mb-1.5">Fees</label>
              <input
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={addForm.fees}
                onChange={(e) => setAddForm((p) => ({ ...p, fees: e.target.value }))}
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="label block mb-1.5">Description</label>
            <textarea
              className="field resize-none"
              rows={2}
              placeholder="Optional note…"
              value={addForm.notes}
              onChange={(e) => setAddForm((p) => ({ ...p, notes: e.target.value }))}
            />
          </div>

          {/* Cash leg note */}
          {addCashLeg && (
            <p className="text-xs text-paper-dim bg-ink rounded-lg px-3 py-2 leading-relaxed">
              Will also adjust{" "}
              <span className="text-paper">
                {addCashLeg.accounts?.name ?? "linked cash"}
              </span>{" "}
              cash balance automatically.
            </p>
          )}

          {addError && <p className="text-loss text-sm">{addError}</p>}
          <button
            className="btn w-full"
            onClick={saveAdd}
            disabled={addBusy || !addForm.holding_id || !addForm.txn_type || !addForm.txn_date}
          >
            {addBusy ? "Saving…" : "Record transaction"}
          </button>
        </div>
      </div>

      {/* ── Edit Transaction drawer ────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${editingTxn ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingTxn ? "opacity-100" : "opacity-0"}`}
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
                <div>
                  <p className="font-medium">Edit transaction</p>
                  <p className="text-xs text-paper-dim mt-0.5">
                    {editingTxn.holding?.asset_type === "cash"
                      ? `Cash — ${editingTxn.holding?.accounts?.name ?? "—"}`
                      : `${editingTxn.holding?.symbol ?? "—"}`}
                    {editingTxn.holding?.accounts?.name && editingTxn.holding?.asset_type !== "cash"
                      ? ` · ${editingTxn.holding.accounts.name}`
                      : ""}
                  </p>
                </div>
                <button onClick={() => setEditingTxn(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>

              {/* Type + Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1.5">Type</label>
                  <select
                    className="field"
                    value={editForm.txn_type}
                    onChange={(e) => setEditForm((p) => ({ ...p, txn_type: e.target.value }))}
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
                    value={editForm.txn_date}
                    onChange={(e) => setEditForm((p) => ({ ...p, txn_date: e.target.value }))}
                  />
                </div>
              </div>

              {/* Qty + Price */}
              {editIsUnit && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label block mb-1.5">Quantity</label>
                    <input
                      className="field num"
                      type="number"
                      step="any"
                      value={editForm.quantity}
                      onChange={(e) => setEditForm((p) => ({ ...p, quantity: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="label block mb-1.5">Price / unit</label>
                    <input
                      className="field num"
                      type="number"
                      step="any"
                      value={editForm.price_per_unit}
                      onChange={(e) => setEditForm((p) => ({ ...p, price_per_unit: e.target.value }))}
                    />
                  </div>
                </div>
              )}

              {/* Amount + Fees */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1.5">Amount</label>
                  <input
                    className="field num"
                    type="number"
                    step="any"
                    value={editForm.amount}
                    onChange={(e) => setEditForm((p) => ({ ...p, amount: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label block mb-1.5">Fees</label>
                  <input
                    className="field num"
                    type="number"
                    step="any"
                    value={editForm.fees}
                    onChange={(e) => setEditForm((p) => ({ ...p, fees: e.target.value }))}
                  />
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="label block mb-1.5">Description</label>
                <textarea
                  className="field resize-none"
                  rows={2}
                  placeholder="Optional note…"
                  value={editForm.notes}
                  onChange={(e) => setEditForm((p) => ({ ...p, notes: e.target.value }))}
                />
              </div>

              {editError && <p className="text-loss text-sm">{editError}</p>}
              <button
                className="btn w-full"
                onClick={saveEdit}
                disabled={editBusy}
              >
                {editBusy ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
