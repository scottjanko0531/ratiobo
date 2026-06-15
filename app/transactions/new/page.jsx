"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabase";
import { CASH_LEG_TYPES, cashAmount } from "../../../lib/cash";
import Shell from "../../../components/Shell";

export default function NewTransactionPage() {
  const router = useRouter();
  const [holdings, setHoldings] = useState([]);
  const [txnTypes, setTxnTypes] = useState([]);
  const [form, setForm] = useState({
    holding_id: "",
    txn_type: "",
    txn_date: new Date().toISOString().slice(0, 10),
    quantity: "",
    price_per_unit: "",
    amount: "",
    fees: ""
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from("holdings").select("id, symbol, name, asset_type, account_id, accounts(name)").order("symbol"),
      supabase
        .from("transaction_types")
        .select("code, label, affects_quantity")
        .eq("is_active", true)
        .order("sort_order")
    ]).then(([{ data: h }, { data: t }]) => {
      setHoldings(h ?? []);
      setTxnTypes(t ?? []);
    });
  }, []);

  const selectedType = txnTypes.find((t) => t.code === form.txn_type);
  const selectedHolding = holdings.find((h) => h.id === form.holding_id);
  const isCashHolding = selectedHolding?.asset_type === "cash";
  const isUnitTxn = selectedType?.affects_quantity !== 0 && selectedType != null && !isCashHolding;

  // For a security held in an account, buy/sell/dividend/interest also move
  // money in or out of that account's cash holding — auto-resolved, not user-editable.
  const cashLeg =
    !isCashHolding && selectedHolding?.account_id && CASH_LEG_TYPES.has(form.txn_type)
      ? holdings.find((h) => h.asset_type === "cash" && h.account_id === selectedHolding.account_id)
      : null;

  const holdingLabel = (h) =>
    h.asset_type === "cash" ? `Cash — ${h.accounts?.name ?? "Unassigned"}` : `${h.symbol}${h.name ? ` — ${h.name}` : ""}`;

  // Auto-compute amount when quantity and price are present
  const computedAmount =
    form.quantity !== "" && form.price_per_unit !== ""
      ? (Number(form.quantity) * Number(form.price_per_unit)).toFixed(2)
      : "";

  async function save() {
    setBusy(true);
    setError("");
    const { data: { user } } = await supabase.auth.getUser();

    const amount =
      form.amount !== ""
        ? Number(form.amount)
        : computedAmount !== ""
        ? Number(computedAmount)
        : null;
    const fees = form.fees === "" ? 0 : Number(form.fees);
    // For a cash holding, "quantity" tracks dollars 1:1 with amount.
    const quantity = isCashHolding ? amount : form.quantity === "" ? null : Number(form.quantity);

    const txn = {
      user_id: user.id,
      holding_id: form.holding_id,
      cash_holding_id: cashLeg?.id ?? null,
      txn_type: form.txn_type,
      txn_date: form.txn_date,
      quantity,
      price_per_unit: form.price_per_unit === "" ? null : Number(form.price_per_unit),
      amount,
      fees
    };

    const { error: txnErr } = await supabase.from("transactions").insert(txn);
    if (txnErr) {
      setBusy(false);
      setError(txnErr.message);
      return;
    }

    // Keep the primary holding's quantity in step with the transaction
    const delta = isCashHolding
      ? cashAmount(form.txn_type, amount, fees)
      : (selectedType?.affects_quantity ?? 0) * (quantity ?? 0);
    if (delta !== 0) {
      const { data: h } = await supabase
        .from("holdings")
        .select("quantity")
        .eq("id", form.holding_id)
        .single();
      if (h) {
        await supabase
          .from("holdings")
          .update({ quantity: Number(h.quantity) + delta })
          .eq("id", form.holding_id);
      }
    }

    // Apply the auto-resolved cash leg, if any
    if (cashLeg) {
      const cashDelta = cashAmount(form.txn_type, amount, fees);
      if (cashDelta !== 0) {
        const { data: ch } = await supabase
          .from("holdings")
          .select("quantity")
          .eq("id", cashLeg.id)
          .single();
        if (ch) {
          await supabase
            .from("holdings")
            .update({ quantity: Number(ch.quantity) + cashDelta })
            .eq("id", cashLeg.id);
        }
      }
    }

    setBusy(false);
    router.push("/dashboard");
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight mb-6">Add transaction</h1>
      <div className="card p-5 max-w-md space-y-4">
        <div>
          <label className="label block mb-1.5" htmlFor="t-holding">Holding</label>
          <select
            id="t-holding"
            className="field"
            value={form.holding_id}
            onChange={(e) => setForm({ ...form, holding_id: e.target.value })}
          >
            <option value="">Select a holding…</option>
            {holdings.map((h) => (
              <option key={h.id} value={h.id}>
                {holdingLabel(h)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1.5" htmlFor="t-type">Type</label>
            <select
              id="t-type"
              className="field"
              value={form.txn_type}
              onChange={(e) => setForm({ ...form, txn_type: e.target.value })}
            >
              <option value="">Select…</option>
              {txnTypes.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="t-date">Date</label>
            <input
              id="t-date"
              className="field"
              type="date"
              value={form.txn_date}
              onChange={(e) => setForm({ ...form, txn_date: e.target.value })}
            />
          </div>
        </div>

        {cashLeg && (
          <p className="text-xs text-paper-dim">
            Cash leg: <span className="text-paper">{holdingLabel(cashLeg)}</span>
          </p>
        )}

        {isUnitTxn && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5" htmlFor="t-qty">Quantity</label>
              <input
                id="t-qty"
                className="field num"
                type="number"
                step="any"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1.5" htmlFor="t-price">Price per unit</label>
              <input
                id="t-price"
                className="field num"
                type="number"
                step="any"
                value={form.price_per_unit}
                onChange={(e) => setForm({ ...form, price_per_unit: e.target.value })}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1.5" htmlFor="t-amount">
              Amount {computedAmount && form.amount === "" ? `(auto: $${computedAmount})` : ""}
            </label>
            <input
              id="t-amount"
              className="field num"
              type="number"
              step="any"
              placeholder={computedAmount || "0.00"}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="t-fees">Fees</label>
            <input
              id="t-fees"
              className="field num"
              type="number"
              step="any"
              placeholder="0.00"
              value={form.fees}
              onChange={(e) => setForm({ ...form, fees: e.target.value })}
            />
          </div>
        </div>

        {error && <p className="text-loss text-sm">{error}</p>}
        <button
          className="btn w-full"
          onClick={save}
          disabled={busy || !form.holding_id || !form.txn_type || !form.txn_date}
        >
          {busy ? "Saving…" : "Record transaction"}
        </button>
      </div>
    </Shell>
  );
}
