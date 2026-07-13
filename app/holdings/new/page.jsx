"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabase";
import Shell from "../../../components/Shell";

export default function NewHoldingPage() {
  const router = useRouter();
  const [assetTypes, setAssetTypes] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState({
    symbol: "",
    name: "",
    asset_type: "",
    account_id: "",
    quantity: "",
    interest_rate: "",
    maturity_date: ""
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("accounts").select("id, name").order("name")
    ]).then(([{ data: at }, { data: ac }]) => {
      setAssetTypes(at ?? []);
      setAccounts(ac ?? []);
    });
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("holdings").insert({
      user_id: user.id,
      symbol: form.symbol.trim().toUpperCase(),
      name: form.name || null,
      asset_type: form.asset_type,
      account_id: form.account_id || null,
      quantity: form.quantity === "" ? 0 : Number(form.quantity),
      interest_rate: form.interest_rate !== "" ? Number(form.interest_rate) : null,
      maturity_date: form.maturity_date || null
    });
    setBusy(false);
    if (error) setError(error.message);
    else router.push("/dashboard");
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight mb-6">Add holding</h1>
      <div className="card p-5 max-w-md space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label block mb-1.5" htmlFor="h-symbol">Symbol</label>
            <input
              id="h-symbol"
              className="field uppercase"
              placeholder="AAPL"
              value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="h-qty">Quantity</label>
            <input
              id="h-qty"
              className="field num"
              type="number"
              step="any"
              placeholder="0"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="label block mb-1.5" htmlFor="h-name">Name (optional)</label>
          <input
            id="h-name"
            className="field"
            placeholder="Apple Inc."
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label block mb-1.5" htmlFor="h-type">Asset type</label>
          <select
            id="h-type"
            className="field"
            value={form.asset_type}
            onChange={(e) => setForm({ ...form, asset_type: e.target.value })}
          >
            <option value="">Select a type…</option>
            {assetTypes.map((t) => (
              <option key={t.code} value={t.code}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label block mb-1.5" htmlFor="h-acct">Account (optional)</label>
          <select
            id="h-acct"
            className="field"
            value={form.account_id}
            onChange={(e) => setForm({ ...form, account_id: e.target.value })}
          >
            <option value="">No account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <p className="text-xs text-paper-dim">
          Tip: quantity can also stay 0 here — buy transactions you record will tell the
          story, and the price sync picks up the symbol automatically.
        </p>
        {["bond", "loan"].includes(form.asset_type) && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label block mb-1.5" htmlFor="h-rate">Interest Rate (%)</label>
              <input
                id="h-rate"
                className="field num"
                type="number"
                step="any"
                placeholder="0.00"
                value={form.interest_rate}
                onChange={(e) => setForm({ ...form, interest_rate: e.target.value })}
              />
            </div>
            <div>
              <label className="label block mb-1.5" htmlFor="h-maturity">Maturity Date</label>
              <input
                id="h-maturity"
                className="field"
                type="date"
                value={form.maturity_date}
                onChange={(e) => setForm({ ...form, maturity_date: e.target.value })}
              />
            </div>
          </div>
        )}
        {error && <p className="text-loss text-sm">{error}</p>}
        <button
          className="btn w-full"
          onClick={save}
          disabled={busy || !form.symbol || !form.asset_type}
        >
          {busy ? "Saving…" : "Add holding"}
        </button>
      </div>
    </Shell>
  );
}
