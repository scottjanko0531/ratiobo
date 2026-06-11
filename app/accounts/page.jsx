"use client";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";

export default function AccountsPage() {
  const [accounts, setAccounts] = useState(null);
  const [types, setTypes] = useState([]);
  const [form, setForm] = useState({ name: "", institution: "", account_type: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [{ data: accts, error: aErr }, { data: t }] = await Promise.all([
      supabase.from("accounts").select("*").order("created_at"),
      supabase
        .from("account_types")
        .select("code, label")
        .eq("is_active", true)
        .order("sort_order")
    ]);
    if (aErr) setError(aErr.message);
    setAccounts(accts ?? []);
    setTypes(t ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function addAccount() {
    setBusy(true);
    setError("");
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("accounts").insert({
      user_id: user.id,
      name: form.name,
      institution: form.institution || null,
      account_type: form.account_type
    });
    setBusy(false);
    if (error) setError(error.message);
    else {
      setForm({ name: "", institution: "", account_type: "" });
      load();
    }
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
                <th className="label text-left font-medium px-4 py-3">Name</th>
                <th className="label text-left font-medium px-4 py-3">Institution</th>
                <th className="label text-left font-medium px-4 py-3">Type</th>
              </tr>
            </thead>
            <tbody>
              {accounts === null && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-paper-dim">Loading…</td></tr>
              )}
              {accounts?.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-paper-dim">
                    No accounts yet. Add one to organize your holdings.
                  </td>
                </tr>
              )}
              {accounts?.map((a) => (
                <tr key={a.id} className="border-b border-ink-line/60 last:border-0">
                  <td className="px-4 py-3 font-medium">{a.name}</td>
                  <td className="px-4 py-3 text-paper-dim">{a.institution ?? "—"}</td>
                  <td className="px-4 py-3">{typeLabel(a.account_type)}</td>
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
    </Shell>
  );
}
