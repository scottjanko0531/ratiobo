"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    const fn =
      mode === "signin"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { error } = await fn;
    setBusy(false);
    if (error) setError(error.message);
    else router.push("/dashboard");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-2">
          <span className="flex items-center gap-1" aria-hidden="true">
            <span className="bead" />
            <span className="bead opacity-70" />
            <span className="bead opacity-40" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Ratiobo</h1>
        </div>
        <p className="label mb-8">Portfolio intelligence</p>

        <div className="card p-6 space-y-4">
          <div>
            <label className="label block mb-1.5" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>
          <div>
            <label className="label block mb-1.5" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          {error && <p className="text-loss text-sm">{error}</p>}
          <button className="btn w-full" onClick={submit} disabled={busy || !email || !password}>
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
          <button
            className="text-sm text-paper-dim hover:text-paper w-full"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          >
            {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
