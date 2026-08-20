"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

function DeltaText({ value }) {
  if (value == null) return <span className="text-paper-dim">—</span>;
  const v = Number(value);
  const cls = v > 0 ? "text-gain" : v < 0 ? "text-loss" : "text-paper-dim";
  return <span className={cls}>{v > 0 ? "+" : ""}{usd(v)}</span>;
}

function fmtDate(d) {
  return d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

// Shows the per-holding records that sum to one of the Dashboard's period-change
// cards (currently just "Month to date"). Reuses the exact refDate the card's own
// total was computed against, so each row's delta plus the "no snapshot yet" rows
// add up to the same number shown on the card.
export default function PeriodChangeDrawer({ open, onClose, label, total, refDate, rows, assetTypeLabels }) {
  const [snapMap, setSnapMap] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !refDate) { setSnapMap(null); return; }
    setBusy(true);
    supabase
      .from("portfolio_snapshots")
      .select("holding_id, market_value")
      .eq("snapshot_date", refDate)
      .then(({ data }) => {
        const map = {};
        for (const s of data ?? []) map[s.holding_id] = Number(s.market_value ?? 0);
        setSnapMap(map);
        setBusy(false);
      });
  }, [open, refDate]);

  const drivers = (snapMap == null ? [] : (rows ?? []))
    .map((r) => {
      const valueAtRef = snapMap[r.id] ?? null;
      const current = Number(r.current_value ?? 0);
      const delta = current - (valueAtRef ?? 0);
      return { ...r, valueAtRef, current, delta };
    })
    .filter((r) => Math.abs(r.delta) >= 0.005)
    .sort((a, b) => b.delta - a.delta);

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}>
      <div
        className={`absolute inset-0 bg-ink/70 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div className={`absolute right-0 top-0 h-full w-full max-w-[720px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}>
        {open && (
          <>
            <div className="flex items-center justify-between px-5 py-4 border-b border-ink-line">
              <div>
                <p className="font-semibold text-base">{label}</p>
                <p className="text-xs text-paper-dim mt-0.5">
                  {refDate ? `${fmtDate(refDate)} → today` : "—"} · <span className="num"><DeltaText value={total} /></span>
                </p>
              </div>
              <button onClick={onClose} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
            </div>

            <div className="px-5 py-4">
              {busy ? (
                <p className="text-paper-dim text-sm">Loading…</p>
              ) : !refDate ? (
                <p className="text-paper-dim text-sm">No snapshot history yet.</p>
              ) : drivers.length === 0 ? (
                <p className="text-paper-dim text-sm">No holdings changed value over this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-line">
                        <th className="label text-left font-medium py-2 pr-4">Holding</th>
                        <th className="label text-left font-medium py-2 pr-4">Type</th>
                        <th className="label text-right font-medium py-2 pr-4">{fmtDate(refDate)}</th>
                        <th className="label text-right font-medium py-2 pr-4">Today</th>
                        <th className="label text-right font-medium py-2">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drivers.map((r) => (
                        <tr key={r.id} className="border-b border-ink-line/60 last:border-0">
                          <td className="py-2.5 pr-4">
                            <span className="font-medium">{r.symbol}</span>
                            {r.name && <span className="text-paper-dim ml-2 text-xs">{r.name}</span>}
                          </td>
                          <td className="py-2.5 pr-4 label">{assetTypeLabels?.[r.asset_type] ?? r.asset_type}</td>
                          <td className="num text-right py-2.5 pr-4">{r.valueAtRef == null ? <span className="text-paper-dim text-xs">new</span> : usd(r.valueAtRef)}</td>
                          <td className="num text-right py-2.5 pr-4">{usd(r.current)}</td>
                          <td className="num text-right py-2.5"><DeltaText value={r.delta} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
