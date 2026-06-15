"use client";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";

export default function ProfilePage() {
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ first_name: "", last_name: "", phone: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      const { data, error } = await supabase
        .from("profiles")
        .select("first_name, last_name, phone")
        .eq("id", user.id)
        .maybeSingle();
      if (error) setError(error.message);
      if (data) {
        setForm({
          first_name: data.first_name ?? "",
          last_name: data.last_name ?? "",
          phone: data.phone ?? ""
        });
      }
      setLoading(false);
    }
    load();
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    setSuccess("");
    const name = `${form.first_name} ${form.last_name}`.trim();
    const { error } = await supabase.from("profiles").upsert({
      id: user.id,
      first_name: form.first_name || null,
      last_name: form.last_name || null,
      phone: form.phone || null,
      email: user.email,
      name: name || null
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSuccess("Profile updated.");
  }

  if (loading) {
    return (
      <Shell>
        <p className="text-paper-dim">Loading…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight mb-6">Profile</h1>
      <div className="card p-5 space-y-4 max-w-md">
        <div>
          <label className="label block mb-1.5" htmlFor="email">Email</label>
          <input id="email" className="field opacity-60" value={user?.email ?? ""} disabled />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label block mb-1.5" htmlFor="first-name">First name</label>
            <input
              id="first-name"
              className="field"
              value={form.first_name}
              onChange={(e) => setForm({ ...form, first_name: e.target.value })}
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="last-name">Last name</label>
            <input
              id="last-name"
              className="field"
              value={form.last_name}
              onChange={(e) => setForm({ ...form, last_name: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="label block mb-1.5" htmlFor="phone">Phone</label>
          <input
            id="phone"
            className="field"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </div>
        {error && <p className="text-loss text-sm">{error}</p>}
        {success && <p className="text-gain text-sm">{success}</p>}
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Shell>
  );
}
