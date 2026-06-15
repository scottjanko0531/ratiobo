"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabase";
import { cashAmount } from "../../lib/cash";
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
  const [form, setForm] = useState({ name: "", institution: "", account_type: "", initial_cash: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [menuOpenId, setMenuOpenId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", institution: "", account_type: "" });
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  async function load() {
    const [{ data: accts, error: aErr }, { data: t }, { data: hv }] = await Promise.all([
      supabase.from("accounts").select("*").order("created_at"),
      supabase
        .from("account_types")
        .select("code, label")
        .eq("is_active", true)
        .order("sort_order"),
      supabase.from("holdings_valued").select("account_id, asset_type, current_value")
    ]);
    if (aErr) setError(aErr.message);
    setAccounts(accts ?? []);
    setTypes(t ?? []);

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
    function close() {
      setMenuOpenId(null);
    }
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpenId]);

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

  async function deleteAccount(account) {
    setMenuOpenId(null);
    if (!confirm(`Delete account "${account.name}"? Holdings linked to it will become unassigned.`)) return;
    const { error } = await supabase.from("accounts").delete().eq("id", account.id);
    if (error) setError(error.message);
    else load();
  }

  const typeLabel = (code) => types.find((t) => t.code === code)?.label ?? code;

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
                <tr key={a.id} className="border-b border-ink-line/60 last:border-0">
                  <td className="px-2 py-3">
                    <button
                      onClick={(e) => {
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
