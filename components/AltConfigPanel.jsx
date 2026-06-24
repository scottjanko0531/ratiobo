"use client";
import { useState } from "react";
import { CORRELATION_PROFILES } from "../lib/altAssets";

const REGIME_ROWS = [
  { key: "rg_ri", label: "Reflation",           sub: "Growth ↑ · Inflation ↑" },
  { key: "rg_fi", label: "Disinflationary Boom", sub: "Growth ↑ · Inflation ↓" },
  { key: "fg_ri", label: "Stagflation",          sub: "Growth ↓ · Inflation ↑" },
  { key: "fg_fi", label: "Deflationary Bust",    sub: "Growth ↓ · Inflation ↓" },
];

/**
 * Modal panel for editing an alt asset's simulation assumptions.
 * Manages its own unsaved edit state; calls onSave with the new values.
 *
 * @param {{ asset, onSave, onClose }} props
 *   asset — the built alt asset object { key, name, vol, correlationProfile, regimeReturns }
 *   onSave({ vol, correlationProfile, regimeReturns }) — called on Save click
 *   onClose — called on Cancel or backdrop click
 */
export default function AltConfigPanel({ asset, onSave, onClose }) {
  const [vol, setVol] = useState(String(asset.vol));
  const [profile, setProfile] = useState(asset.correlationProfile);
  const [returns, setReturns] = useState({ ...asset.regimeReturns });

  function handleSave() {
    const parsedVol = parseFloat(vol);
    if (isNaN(parsedVol) || parsedVol <= 0) return;
    onSave({ vol: parsedVol, correlationProfile: profile, regimeReturns: returns });
  }

  function handleReturnChange(regimeKey, raw) {
    const val = raw === "" || raw === "-" ? raw : (parseFloat(raw) || 0);
    setReturns((prev) => ({ ...prev, [regimeKey]: val }));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(17,21,28,0.85)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ background: asset.color }}
            />
            <h2 className="text-base font-semibold">{asset.name}</h2>
            <span className="label font-normal text-paper-dim">assumptions</span>
          </div>
          <button
            onClick={onClose}
            className="text-paper-dim hover:text-paper text-xl leading-none transition-colors ml-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Volatility */}
        <div>
          <label className="label block mb-2">Annualized Volatility (%)</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0.1"
              max="200"
              step="0.5"
              value={vol}
              onChange={(e) => setVol(e.target.value)}
              className="field w-28 text-right"
            />
            <span className="text-paper-dim text-sm">%</span>
          </div>
          <p className="text-[10px] text-paper-dim mt-1.5 leading-relaxed">
            Historical stdev of annual returns — crypto ~75%, real estate ~15%, private equity ~30%.
          </p>
        </div>

        {/* Correlation profile */}
        <div>
          <label className="label block mb-2">Correlation Profile</label>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(CORRELATION_PROFILES).map(([key, p]) => (
              <button
                key={key}
                onClick={() => setProfile(key)}
                className={`text-left p-3 rounded-xl border text-sm transition-colors ${
                  profile === key
                    ? "border-brass bg-brass/10 text-paper"
                    : "border-ink-line text-paper-dim hover:border-brass/40 hover:text-paper"
                }`}
              >
                <div className="font-medium text-[13px]">{p.label}</div>
                <div className="text-[11px] mt-0.5 leading-snug opacity-80">{p.description}</div>
              </button>
            ))}
          </div>
          <p className="text-[10px] text-paper-dim mt-1.5 leading-relaxed">
            Describes how this holding moves relative to public market assets.
            Affects portfolio-level risk and diversification calculations.
          </p>
        </div>

        {/* Regime return estimates */}
        <div>
          <label className="label block mb-2">Expected Return by Regime (%)</label>
          <div className="space-y-3">
            {REGIME_ROWS.map((r) => (
              <div key={r.key} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-sm">{r.label}</span>
                  <span className="label text-[10px] ml-2 normal-case tracking-normal text-paper-dim">
                    {r.sub}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <input
                    type="number"
                    step="0.5"
                    value={returns[r.key] ?? 0}
                    onChange={(e) => handleReturnChange(r.key, e.target.value)}
                    className="field w-20 text-right py-1.5 text-sm"
                  />
                  <span className="text-paper-dim text-sm w-3">%</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-paper-dim mt-1.5 leading-relaxed">
            Your estimated annual return for this asset in each macro quadrant.
            Negative values allowed. These are overlaid on the public asset returns in the
            Projected Behavior panel.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-1 border-t border-ink-line">
          <button onClick={handleSave} className="btn flex-1 py-2.5">
            Save
          </button>
          <button onClick={onClose} className="btn-ghost flex-1 py-2.5">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
