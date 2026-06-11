"use client";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const qty = (n) => {
  const x = Number(n);
  return x % 1 === 0 ? x.toLocaleString() : x.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

function GainText({ value, pct }) {
  if (value == null) return <span className="text-paper-dim">—</span>;
  const v = Number(value);
  const cls = v > 0 ? "text-gain" : v < 0 ? "text-loss" : "text-paper-dim";
  const sign = v > 0 ? "+" : "";
  return (
    <span className={cls}>
      {sign}
      {usd(v)}
      {pct != null && <span className="text-xs ml-1.5 opacity-80">{sign}{Number(pct).toFixed(1)}%</span>}
    </span>
  );
}

export default function Dashboard() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase
      .from("holdings_valued")
      .select("*")
      .order("current_value", { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setRows(data ?? []);
      });
  }, []);

  const totals = (rows ?? []).reduce(
    (t, r) => ({
      value: t.value + Number(r.current_value ?? 0),
      basis: t.basis + Number(r.cost_basis ?? 0),
      gain: t.gain + Number(r.net_gain ?? 0),
      income:
        t.income + Number(r.total_dividends ?? 0) + Number(r.total_interest ?? 0)
    }),
    { value: 0, basis: 0, gain: 0, income: 0 }
  );

  const lastSync = (rows ?? [])
    .map((r) => r.last_price_sync)
    .filter(Boolean)
    .sort()
    .pop();

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
        {lastSync && (
          <p className="label">
            Prices as of {new Date(lastSync).toLocaleString()}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        <div className="card p-4">
          <p className="label mb-1">Total value</p>
          <p className="num text-xl">{usd(totals.value)}</p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Cost basis</p>
          <p className="num text-xl">{usd(totals.basis)}</p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Unrealized gain</p>
          <p className="num text-xl">
            <GainText value={totals.gain} pct={totals.basis ? (totals.gain / totals.basis) * 100 : null} />
          </p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Income received</p>
          <p className="num text-xl">{usd(totals.income)}</p>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-line">
              <th className="label text-left font-medium px-4 py-3">Holding</th>
              <th className="label text-right font-medium px-4 py-3">Qty</th>
              <th className="label text-right font-medium px-4 py-3">Price</th>
              <th className="label text-right font-medium px-4 py-3">Cost basis</th>
              <th className="label text-right font-medium px-4 py-3">Value</th>
              <th className="label text-right font-medium px-4 py-3">Net gain</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-paper-dim">Loading…</td></tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-paper-dim">
                  No holdings yet. Add your first holding to start the ledger.
                </td>
              </tr>
            )}
            {error && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-loss">{error}</td></tr>
            )}
            {rows?.map((r) => (
              <tr key={r.id} className="border-b border-ink-line/60 last:border-0">
                <td className="px-4 py-3">
                  <span className="font-medium">{r.symbol}</span>
                  <span className="text-paper-dim ml-2">{r.name}</span>
                  <span className="label ml-2">{r.asset_type}</span>
                </td>
                <td className="num text-right px-4 py-3">{qty(r.quantity)}</td>
                <td className="num text-right px-4 py-3">{usd(r.market_price)}</td>
                <td className="num text-right px-4 py-3">{usd(r.cost_basis)}</td>
                <td className="num text-right px-4 py-3">{usd(r.current_value)}</td>
                <td className="num text-right px-4 py-3">
                  <GainText value={r.net_gain} pct={r.net_gain_pct} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
