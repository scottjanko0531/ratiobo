"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";
import ThreeForcesChart from "../../components/ThreeForcesChart";
import DalioGauges from "../../components/DalioGauges";
import ProvenanceBadge from "../../components/ProvenanceBadge";
import {
  ComposedChart, Line, Bar, Area, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  SIMULATOR_KEYS,
  REGIME_DEFAULT_WEIGHTS,
  REGIME_META,
  REGIME_RETURNS,
  SUGGESTED_FUNDS,
  BW_ALLOC,
  ILLIQUID_KEYS,
  detectRegimeKey,
  isGrowthExpanding,
  isLaborDeteriorating,
  rateOfChangeLabel,
  CPI_MIN_GAP,
  GROWTH_MIN_GAP,
  POTENTIAL_GDP_GROWTH,
  POTENTIAL_FLOOR_FRACTION,
  FED_INFLATION_TARGET,
  resolveSimulatorKey,
  getSignalKeys,
  toIntWeights,
  computeAllocationDeltas,
} from "../../lib/simulatorKeys";
import { getAssetData } from "../../lib/data/assetReturns";
import { applyNaiveRiskParity, solveTrueRiskParity } from "../../lib/riskParity";

const LAYER_NAMES = {
  1: "Long-term Debt Cycle",
  2: "Short-Term Debt Cycle",
  3: "Business Cycle",
  4: "Tail Risk",
};

// Cards that live under layer 1/2 in the data model (for cross-referencing
// and regime-signal reuse) but are pulled out of the generic byLayer grids
// and shown together in the dedicated Sovereign Risk section instead, per
// the Macro Measurement Upgrade Spec.
const SOVEREIGN_RISK_NAMES = [
  "Treasury Convenience Yield (10Y)",
  "Foreign Official Custody Holdings",
  "Indirect Bidder Share (10Y/30Y)",
  "Gold / Real Yield Correlation (90d)",
  "Stock/Bond Correlation (90d)",
];

const KEY_LABEL = Object.fromEntries(SIMULATOR_KEYS.map((s) => [s.key, s.label]));

const STATUS_STYLE = {
  healthy: { text: "text-gain", bg: "bg-gain/10", border: "border-gain/20" },
  watch:   { text: "text-brass", bg: "bg-brass/10", border: "border-brass/20" },
  danger:  { text: "text-loss", bg: "bg-loss/10", border: "border-loss/20" },
  unknown: { text: "text-paper-dim", bg: "bg-ink-soft", border: "border-ink-line" },
};

function formatValue(v, unit) {
  if (v == null) return "—";
  const n = Number(v);
  if (isNaN(n)) return "—";
  if (unit === "%")       return n.toFixed(2) + "%";
  if (unit === "$B")      return "$" + n.toFixed(1) + "B";
  if (unit === "$M")      return "$" + (n / 1_000_000).toFixed(2) + "T";
  if (unit === "K")       return n.toFixed(0) + "K";
  if (unit === "tons")    return n.toFixed(0) + "t";
  if (unit === "bps")     return n.toFixed(0) + "bps";
  if (unit === "ratio")   return n.toFixed(2) + "x";
  if (unit === "z-score") return n.toFixed(3);
  if (unit === "index")   return n.toFixed(1);
  if (unit === "$/bbl")   return "$" + n.toFixed(0) + "/bbl";
  if (unit === "Kbbl")    return (n / 1000).toFixed(1) + "M bbl";
  if (unit === "$/gal")   return "$" + n.toFixed(2) + "/gal";
  if (unit === "$/mt")    return "$" + Math.round(n).toLocaleString("en-US") + "/mt";
  if (unit === "$/oz")    return "$" + Math.round(n).toLocaleString("en-US") + "/oz";
  if (unit === "$/lb")    return "$" + n.toFixed(2) + "/lb";
  if (unit === "% YoY")  return n.toFixed(2) + "% YoY";
  return n.toFixed(2);
}

function ChangeArrow({ change, unit }) {
  if (change == null) return null;
  const n = Number(change);
  if (isNaN(n) || n === 0) return null;
  const up = n > 0;
  return (
    <span className={`text-xs ${up ? "text-gain" : "text-loss"}`}>
      {up ? "↑" : "↓"} {formatValue(Math.abs(n), unit)}
    </span>
  );
}

function StatusBadge({ status }) {
  const s = status ?? "unknown";
  const st = STATUS_STYLE[s] ?? STATUS_STYLE.unknown;
  return (
    <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full border ${st.text} ${st.bg} ${st.border}`}>
      {s.toUpperCase()}
    </span>
  );
}

function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
    </svg>
  );
}

function IndicatorCard({ ind, onSave, onClick, note }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const [editStatus, setEditStatus] = useState("unknown");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  function startEdit() {
    setEditVal(ind.current_value != null ? String(ind.current_value) : "");
    setEditStatus(ind.status ?? "unknown");
    setSaveError("");
    setEditing(true);
  }

  async function saveEdit() {
    const curr = parseFloat(editVal);
    if (isNaN(curr)) { setSaveError("Enter a valid number."); return; }
    setSaving(true);
    setSaveError("");
    const prev = ind.current_value != null ? Number(ind.current_value) : curr;
    const { error } = await supabase
      .from("macro_indicators")
      .update({
        current_value: curr,
        previous_value: prev,
        change_value: curr - prev,
        status: editStatus,
        last_fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", ind.id);
    setSaving(false);
    if (error) { setSaveError(error.message); return; }
    setEditing(false);
    onSave?.();
  }

  if (editing) {
    return (
      <div className="card p-4 border border-brass/30">
        <p className="text-sm font-medium mb-3 leading-snug">{ind.name}</p>
        <div className="space-y-2">
          <div>
            <label className="label text-[10px] mb-1 block">Value ({ind.unit})</label>
            <input
              type="number"
              value={editVal}
              onChange={(e) => setEditVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
              className="w-full bg-ink-soft border border-ink-line rounded px-2 py-1.5 text-sm num focus:outline-none focus:border-brass/60"
              placeholder={`Enter ${ind.unit}`}
              autoFocus
            />
          </div>
          <div>
            <label className="label text-[10px] mb-1 block">Signal</label>
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
              className="w-full bg-ink-soft border border-ink-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-brass/60"
            >
              <option value="healthy">Healthy</option>
              <option value="watch">Watch</option>
              <option value="danger">Danger</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          {saveError && <p className="text-loss text-xs">{saveError}</p>}
          <div className="flex gap-2 pt-1">
            <button
              onClick={saveEdit}
              disabled={saving || !editVal.trim()}
              className="flex-1 py-1.5 text-xs font-medium rounded bg-brass/20 text-brass-soft border border-brass/40 hover:bg-brass/30 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="flex-1 py-1.5 text-xs rounded border border-ink-line text-paper-dim hover:text-paper transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`card p-4 flex flex-col gap-1.5 ${onClick ? "cursor-pointer hover:border-brass/40 transition-colors" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-1 min-w-0">
          <p className="text-sm font-medium leading-snug">{ind.name}</p>
          {note && (
            <div className="relative group shrink-0 mt-0.5" onClick={e => e.stopPropagation()}>
              <svg className="w-3.5 h-3.5 text-paper-dim/50 hover:text-brass-soft transition-colors cursor-default" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm-.25 3.75h.5a.75.75 0 0 1 .75.75v3a.25.25 0 0 0 .25.25h.25a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1h.25a.25.25 0 0 0 .25-.25v-3H7a.5.5 0 0 1 0-1h.75z"/>
              </svg>
              <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-56 bg-ink border border-ink-line rounded-lg px-3 py-2 text-[11px] text-paper-dim leading-relaxed shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 z-50">
                {note}
                <span className="absolute left-1/2 -translate-x-1/2 top-full w-2 h-2 bg-ink border-r border-b border-ink-line rotate-45 -mt-1" />
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge status={ind.status} />
          {ind.is_manual && (
            <button
              onClick={(e) => { e.stopPropagation(); startEdit(); }}
              className="text-paper-dim hover:text-brass transition-colors"
              title="Update value"
            >
              <PencilIcon />
            </button>
          )}
          {onClick && (
            <svg className="w-3 h-3 text-paper-dim/50" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6,3 11,8 6,13" />
            </svg>
          )}
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        {ind.current_value != null ? (
          <>
            <p className="num text-xl">{formatValue(ind.current_value, ind.unit)}</p>
            <ChangeArrow change={ind.change_value} unit={ind.unit} />
          </>
        ) : (
          <p className="text-paper-dim text-sm italic">
            {ind.is_manual ? "No data — click pencil to enter" : "Pending refresh"}
          </p>
        )}
      </div>
      {ind.metadata?.spot_price != null && (
        <p className="text-paper-dim text-xs">
          Spot <span className="num text-paper">${Math.round(ind.metadata.spot_price).toLocaleString("en-US")}/oz</span>
          <span className="mx-1 opacity-40">·</span>
          3M avg <span className="num text-paper">${Math.round(Number(ind.current_value)).toLocaleString("en-US")}/oz</span>
        </p>
      )}
      {ind.metadata?.zscore != null && (
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] num px-1.5 py-0.5 rounded-md border ${
            Math.abs(Number(ind.metadata.zscore)) > 2
              ? "bg-loss/10 border-loss/30 text-loss"
              : Math.abs(Number(ind.metadata.zscore)) > 1
              ? "bg-brass/10 border-brass/30 text-brass-soft"
              : "bg-ink border-ink-line text-paper-dim"
          }`}>
            z {Number(ind.metadata.zscore) >= 0 ? "+" : ""}{Number(ind.metadata.zscore).toFixed(2)}σ
          </span>
          <span className="text-[10px] text-paper-dim/50">10yr</span>
        </div>
      )}
      <p className="text-paper-dim text-xs leading-snug line-clamp-2">{ind.description}</p>
    </div>
  );
}

// Pure: compute suggested % per market asset using the chosen allocation method.
// Default: returns weights only for signal-favored keys (regime threshold ≥10%).
// RP modes: returns weights for ALL 8 market assets — same universe as the simulator.
// Bridgewater-implied All Weather modification (structural, not regime-dependent).
// Source: Bridgewater 2025-2026 research — reduce long nominal bonds, add TIPS/inflation-linked,
// increase gold + commodities, diversify away from US-only equity book.

function computeSuggestedPcts(regimeKey, method, assetData) {
  const dw = REGIME_DEFAULT_WEIGHTS[regimeKey] ?? {};

  if (method === "bw") {
    return { ...BW_ALLOC };
  }

  if (method === "default" || !assetData) {
    const sk = getSignalKeys(regimeKey);
    return Object.fromEntries(sk.map((k) => [k, dw[k] ?? 0]));
  }

  // RP modes: run on all 7 non-cash market assets, return weights for all 8
  const cashPct = dw.cash ?? 0;
  const budget = 100 - cashPct;
  const riskAssets = assetData.assets.filter((a) => a.key !== "cash");

  if (!riskAssets.length) {
    return Object.fromEntries(assetData.assets.map((a) => [a.key, dw[a.key] ?? 0]));
  }

  let fractional;
  if (method === "equal") {
    fractional = Object.fromEntries(riskAssets.map((a) => [a.key, 1 / riskAssets.length]));
  } else if (method === "naive") {
    fractional = applyNaiveRiskParity(riskAssets);
  } else {
    // Regime RP: run true risk parity only on regime-favored assets (Default weight ≥ 10%).
    // Non-favored assets receive 0. This combines regime signal (which assets)
    // with risk-parity math (how much), requiring no leverage.
    const favoredKeys = new Set(getSignalKeys(regimeKey, 10));
    const regimeAssets = riskAssets.filter((a) => favoredKeys.has(a.key));
    const solverAssets = regimeAssets.length >= 2 ? regimeAssets : riskAssets;
    const subCorr = Object.fromEntries(
      solverAssets.map((a) => [
        a.key,
        Object.fromEntries(
          solverAssets.map((b) => [
            b.key,
            assetData.corrMatrix[a.key]?.[b.key] ?? (a.key === b.key ? 1 : 0),
          ])
        ),
      ])
    );
    const solved = solveTrueRiskParity(solverAssets, subCorr);
    fractional = Object.fromEntries(riskAssets.map((a) => [a.key, solved[a.key] ?? 0]));
  }

  const intW = toIntWeights(fractional, budget);
  const result = Object.fromEntries(riskAssets.map((a) => [a.key, intW[a.key] ?? 0]));
  result.cash = cashPct;
  return result;
}

const FWD_GROWTH_SIGNALS = [
  { label: "Yield Curve 2/10",  name: "2yr/10yr Yield Spread",     w: 0.25, vote: v => v > 0.5 ? 1 : v >= 0    ? 0 : -1 },
  { label: "Yield Curve 3m/10", name: "3mo/10yr Yield Spread",     w: 0.20, vote: v => v > 1   ? 1 : v >= 0    ? 0 : -1 },
  { label: "Loan Standards",    name: "Sr Loan Officer Survey",    w: 0.20, vote: v => v < 15  ? 1 : v <= 35   ? 0 : -1 },
  { label: "LEI",               name: "Conference Board LEI",      w: 0.15, vote: v => v > 0   ? 1 : v >= -0.3 ? 0 : -1 },
  { label: "HY Spread",         name: "HY Credit Spread (OAS)",   w: 0.10, vote: v => v < 4   ? 1 : v <= 6    ? 0 : -1 },
  { label: "C&I Loans",         name: "C&I Loan Growth (YoY)",    w: 0.10, vote: v => v > 5   ? 1 : v >= 0    ? 0 : -1 },
  // Liquidity leads growth by ~12-18mo (banding matches the card's own healthy/watch/danger thresholds)
  { label: "Liquidity",         name: "US Total Liquidity Composite", w: 0.15, vote: v => v > 0 ? 1 : v > -3 ? 0 : -1 },
  // Consumer spending, ~2/3 of GDP by expenditure (banding matches the card's own thresholds)
  { label: "Retail Sales",      name: "Retail Sales (YoY)", w: 0.15, vote: v => v >= 2 ? 1 : v >= 0 ? 0 : -1 },
  // Above/below-trend growth LEVEL (Investment Clock's own growth-axis definition),
  // distinct from the momentum signals above. Quarterly — lower weight, slow-moving anchor
  { label: "Output Gap",        name: "Output Gap", w: 0.10, vote: v => v > 0.5 ? 1 : v >= -0.5 ? 0 : -1 },
  // Labor data — previously absent from the growth axis entirely. Kept in
  // sync with the identical G arrays in fetch-macro-data and get-regime-analysis.
  { label: "Payrolls (3M Avg)", name: "Payrolls (3M Avg)", w: 0.20, vote: v => v > 100 ? 1 : v >= 0 ? 0 : -1 },
  { label: "Unemployment Trend", name: "Unemployment Rate Trend", w: 0.15, vote: v => v < -0.05 ? 1 : v <= 0.05 ? 0 : -1 },
  { label: "Jobless Claims",    name: "Initial Jobless Claims Trend", w: 0.15, vote: v => v < 0 ? 1 : v <= 5 ? 0 : -1 },
];
const FWD_INFL_SIGNALS = [
  // 3-month pp-change signals, in raw percentage points (not relative % — CPI/PPI
  // YoY are already rates, so a relative-%-change would invert sensitivity: the
  // same absolute pp move reads huge when the rate is low, trivial when it's
  // high). PPI's threshold is wider since it's the noisier series (also why
  // it's weighted lower here).
  { label: "CPI Trend",         name: "CPI (YoY)",      w: 0.20, getPP3m: true,  vote: v => v < -0.5 ? -1 : v > 0.5 ? 1 : 0 },
  { label: "PPI Trend",         name: "PPI (YoY)",      w: 0.10, getPP3m: true,  vote: v => v < -1.0 ? -1 : v > 1.0 ? 1 : 0 },
  { label: "10Y Breakeven",     name: "10Y Breakeven Inflation",         w: 0.20, vote: v => v > FED_INFLATION_TARGET ? 1 : v >= 1.5 ? 0 : -1 },
  // Threshold raised: readings below 5.5% may reflect one-time tariff shock, not structural inflation
  { label: "Infl Expectations", name: "Consumer Inflation Expectations", w: 0.15, vote: v => v > 5.5 ? 1 : v >= 2.5 ? 0 : -1 },
  { label: "Copper 3M",         name: "Copper Price",   w: 0.15, getPct3m: true, vote: v => v > 5   ? 1 : v >= -5  ? 0 : -1 },
  { label: "WTI 3M",            name: "WTI Crude Oil",  w: 0.10, getPct3m: true, vote: v => v > 5   ? 1 : v >= -5  ? 0 : -1 },
  // Explicit shock override — only scores while WTI's realized vol is
  // flagged (level_with_shock's vol_shock, >55% annualized); silent otherwise.
  { label: "WTI Shock", name: "WTI Crude Oil (Shock)", sourceName: "WTI Crude Oil", w: 0.15, useShortPct: true, shockGate: true, vote: v => v > 10 ? 1 : v < -10 ? -1 : 0 },
  { label: "M2 Growth",         name: "M2 Growth (YoY)",w: 0.10, vote: v => v > 8   ? 1 : v >= 3   ? 0 : -1 },
  // Leads realized inflation by ~6-12mo (Merrill Lynch Investment Clock) — tight
  // capacity is genuinely forward-looking, unlike CPI/PPI trend which are coincident
  { label: "Capacity Utilization", name: "Capacity Utilization", w: 0.15, vote: v => v > 80 ? 1 : v >= 74 ? 0 : -1 },
  // Dollar strength lags into LOWER future inflation (~2mo, cheaper imports) — vote
  // is inverted relative to a normal "rising = inflationary" reading
  { label: "Dollar (3M, lagged)", name: "DXY", w: 0.10, getPct3m: true, vote: v => v > 5 ? -1 : v < -5 ? 1 : 0 },
  // Unlike CPI/PPI, this has no FRED backfill — macro_snapshots only starts
  // accumulating from launch, so its 3-month trend (change3m_pp) can't exist
  // for ~90 days and would vote null the whole time. Votes on the current
  // LEVEL instead (how much tariffs are adding to CPI right now), which is
  // itself informative from day one — thresholds match the danger/watch/
  // healthy bands update-supply-chain-risk already derives for this composite.
  { label: "Tariff Impact", name: "Tariff Inflation Impact", w: 0.10, vote: v => v > 0.30 ? 1 : v > 0.10 ? 0 : -1 },
];

function computeForwardSignal(indicators) {
  const get = (name) => {
    const ind = indicators.find(i => i.name === name);
    return ind?.current_value != null ? Number(ind.current_value) : null;
  };
  const getPct3m = (name) => {
    const ind = indicators.find(i => i.name === name);
    return ind?.metadata?.change3m_pct != null ? Number(ind.metadata.change3m_pct) : null;
  };
  // 3-month percentage-POINT change in a YoY rate (CPI/PPI) — distinct from
  // getPct3m above, which is a relative % change appropriate for price LEVELS.
  const getPP3m = (name) => {
    const ind = indicators.find(i => i.name === name);
    return ind?.metadata?.change3m_pp != null ? Number(ind.metadata.change3m_pp) : null;
  };
  // ~3-week momentum and the shock-vol flag, stored in metadata by
  // fetch-macro-data's level_with_shock processor (WTI) — see #4 in the
  // regime-calc work order.
  const getShortPct = (name) => {
    const ind = indicators.find(i => i.name === name);
    return ind?.metadata?.change_short_pct != null ? Number(ind.metadata.change_short_pct) : null;
  };
  const getVolShock = (name) => {
    const ind = indicators.find(i => i.name === name);
    return !!ind?.metadata?.vol_shock;
  };
  const scoreGroup = (sigs) => {
    let weighted = 0, totalW = 0;
    const scored = sigs.map(s => {
      const source = s.sourceName ?? s.name;
      if (s.shockGate && !getVolShock(source)) return { ...s, val: null, vote: null };
      const val = s.useShortPct ? getShortPct(source) : s.getPct3m ? getPct3m(source) : s.getPP3m ? getPP3m(source) : get(source);
      if (val == null) return { ...s, val: null, vote: null };
      const v = s.vote(val);
      weighted += v * s.w;
      totalW += s.w;
      return { ...s, val, vote: v };
    });
    return { signals: scored, score: totalW > 0 ? weighted / totalW : null };
  };
  const growth = scoreGroup(FWD_GROWTH_SIGNALS);
  const infl   = scoreGroup(FWD_INFL_SIGNALS);
  const THRESH = 0.10; // dead band — see #8 in the regime-calc work order
  const dir = s => s == null ? null : s > THRESH ? "up" : s < -THRESH ? "down" : "neutral";
  const rawGDir = dir(growth.score);
  const rawIDir = dir(infl.score);
  // fall back to sign when score is in the neutral band
  const gDir = rawGDir === "neutral" ? (growth.score >= 0 ? "up" : "down") : rawGDir;
  const iDir = rawIDir === "neutral" ? (infl.score >= 0 ? "up" : "down") : rawIDir;
  const forwardKey =
    gDir === "up"   && iDir === "down" ? "rg_fi" :
    gDir === "up"   && iDir === "up"   ? "rg_ri" :
    gDir === "down" && iDir === "up"   ? "fg_ri" :
    gDir === "down" && iDir === "down" ? "fg_fi" : null;
  // Confidence: weighted % of signals aligned with the composite direction
  const consensus = (signals, d) => {
    if (!d || d === "neutral") return null;
    const target = d === "up" ? 1 : -1;
    let agreed = 0, total = 0;
    for (const s of signals) {
      if (s.vote == null) continue;
      total += s.w;
      if (s.vote === target) agreed += s.w;
    }
    return total > 0 ? Math.round(agreed / total * 100) : null;
  };
  const gConf = consensus(growth.signals, gDir);
  const iConf = consensus(infl.signals, iDir);
  const baseConfidence = forwardKey && gConf != null && iConf != null
    ? Math.round((gConf + iConf) / 2)
    : null;
  // Vol-regime cross-check: VIX/MOVE are famously countercyclical (rise in
  // downturns, fall in expansions) — a well-established relationship, unlike
  // more speculative per-quadrant vol claims. Ties to the GROWTH direction
  // specifically, not the full quadrant. Confirming vol behavior gives a small
  // confidence boost; contradicting behavior (vol falling while growth signals
  // say "down", or rising while they say "up") is treated as a bigger red flag,
  // since it suggests the growth read may be about to reverse.
  const volMod = (() => {
    if (!gDir || gDir === "neutral") return 0;
    const vixChg = getPct3m("VIX");
    const moveChg = getPct3m("MOVE Index");
    const trends = [vixChg, moveChg].filter(v => v != null);
    if (!trends.length) return 0;
    const avgTrend = trends.reduce((s, v) => s + v, 0) / trends.length;
    if (avgTrend <= 5 && avgTrend >= -5) return 0; // roughly flat, no signal
    const volRising = avgTrend > 5;
    const confirms = (gDir === "down" && volRising) || (gDir === "up" && !volRising);
    return confirms ? 5 : -8;
  })();
  const confidence = baseConfidence != null ? Math.max(0, Math.min(100, baseConfidence + volMod)) : null;
  return { growth, infl, gDir, iDir, rawGDir, rawIDir, forwardKey, confidence, baseConfidence, volMod };
}

// ── Daily Macro Summary ───────────────────────────────────────────────────────

function MacroSummary({ indicators }) {
  const get     = (name) => { const i = indicators.find(x => x.name === name); return i?.current_value  != null ? Number(i.current_value)  : null; };
  const getPrev = (name) => { const i = indicators.find(x => x.name === name); return i?.previous_value != null ? Number(i.previous_value) : null; };
  const stat = (name) => indicators.find(x => x.name === name)?.status ?? null;

  const gdp        = get("Real GDP Growth");
  const cpi        = get("CPI (YoY)");
  const coreCpi    = get("Core CPI (YoY)");
  const ppi        = get("PPI (YoY)");
  const breakeven  = get("10Y Breakeven Inflation");
  const gdp3yAvg   = get("GDP Growth (4Q Avg)") ?? 0;
  const gdpFastVal = get("GDP Growth (2Q Avg)");
  const cpiFastVal = get("CPI Growth (3M Avg)");
  const cpiSlowVal = get("CPI Growth (9M Avg)");
  const unrate     = get("Unemployment Rate");
  const t10y2y     = get("2yr/10yr Yield Spread");
  const t10y3m     = get("3mo/10yr Yield Spread");
  const hySpread   = get("HY Credit Spread (OAS)");
  const lei        = get("Conference Board LEI");
  const sloos      = get("Sr Loan Officer Survey");
  const debtGdp    = get("Total Debt / GDP");
  const inflExp    = get("Consumer Inflation Expectations");
  const breakevenVal = breakeven ?? FED_INFLATION_TARGET;

  // Labor veto inputs for the growth axis (see isLaborDeteriorating) — a
  // GDP crossover that would otherwise read "Expanding" gets pulled down
  // when payrolls/unemployment/claims are cracking, so labor deterioration
  // can move the headline read directly, not just the Forward Signal score.
  const payrolls3mAvg      = get("Payrolls (3M Avg)");
  const unemploymentTrend  = get("Unemployment Rate Trend");
  const joblessClaimsTrend = get("Initial Jobless Claims Trend");
  const laborDeteriorating = isLaborDeteriorating(payrolls3mAvg, unemploymentTrend, joblessClaimsTrend);

  // Fast/slow moving-average crossover — same computation as QuadrantCard's
  // Regime Signal Comparison table, so the banner always agrees with it.
  // GDP: 2-quarter avg (fast) vs 4-quarter avg (slow). CPI: 3-month avg
  // (fast) vs 9-month avg (slow). Falls back to a raw-reading comparison
  // only when the crossover indicators aren't loaded yet.
  const structuralRegimeKey = gdpFastVal != null
    ? (() => {
        const growthUp = isGrowthExpanding(gdpFastVal, gdp3yAvg) && !laborDeteriorating;
        const inflUp   = cpiFastVal != null && cpiSlowVal != null && cpiFastVal > cpiSlowVal;
        if (growthUp && !inflUp) return "rg_fi";
        if (growthUp && inflUp)  return "rg_ri";
        if (!growthUp && inflUp) return "fg_ri";
        return "fg_fi";
      })()
    : null;
  // Same market-expectations leg as QuadrantCard, so this card's headline
  // resolves via the identical 2-of-3 majority rather than structural alone.
  const marketRegimeKey = gdpFastVal != null
    ? (() => {
        const growthUp = isGrowthExpanding(gdpFastVal, gdp3yAvg) && !laborDeteriorating;
        const inflUp   = breakevenVal > FED_INFLATION_TARGET;
        if (growthUp && !inflUp) return "rg_fi";
        if (growthUp && inflUp)  return "rg_ri";
        if (!growthUp && inflUp) return "fg_ri";
        return "fg_fi";
      })()
    : null;
  const fwd = computeForwardSignal(indicators);
  const majorityRegimeKey = resolveHeadlineRegime(structuralRegimeKey, marketRegimeKey, fwd.forwardKey);
  const isTransitional = structuralRegimeKey != null && marketRegimeKey != null && majorityRegimeKey == null;
  const incompleteRegimeInputs = getStaleOrMissingRegimeInputs(indicators);
  const regimeKey = majorityRegimeKey
    ?? structuralRegimeKey
    ?? (gdp != null && cpi != null
        ? detectRegimeKey(gdp, cpi, { breakeven: breakevenVal, gdp3yAvg })
        : null);
  const regime = regimeKey ? REGIME_META[regimeKey] : null;
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // ── Momentum helpers ──
  const prevGdp = getPrev("Real GDP Growth");
  const prevCpi = getPrev("CPI (YoY)");
  const prevPpi = getPrev("PPI (YoY)");
  const prevLei = getPrev("Conference Board LEI");
  const prevBe  = getPrev("10Y Breakeven Inflation");
  const trendTag = (curr, prev, up = "↑", dn = "↓") =>
    prev == null ? "" : curr > prev + 0.05 ? ` ${up}` : curr < prev - 0.05 ? ` ${dn}` : "";

  // ── Growth narrative ──
  const growthAboveTrend = gdp != null && gdp > gdp3yAvg;
  const gdpTrend = prevGdp != null && gdp != null ? (gdp > prevGdp + 0.05 ? " and accelerating" : gdp < prevGdp - 0.05 ? " but decelerating" : "") : "";
  const growthStr =
    gdp == null ? "Growth data unavailable." :
    gdp > 2.5   ? `Growth is strong — Real GDP at +${gdp.toFixed(1)}%${gdpTrend}${gdp3yAvg ? `, above the 4-quarter trend of ${gdp3yAvg.toFixed(1)}%` : ""}.` :
    gdp > 0.5   ? `Growth is modest — Real GDP at +${gdp.toFixed(1)}%${gdpTrend}${growthAboveTrend ? ", above the 4-quarter trend" : ", below the 4-quarter trend"}.` :
    gdp > 0     ? `Growth is stalling — Real GDP at +${gdp.toFixed(1)}%${gdpTrend}.` :
                  `Economy is contracting — Real GDP at ${gdp.toFixed(1)}%${gdpTrend}.`;

  // ── Inflation narrative ──
  const inflAboveExp = cpi != null && cpi > breakevenVal;
  const cpiTrend = prevCpi != null && cpi != null ? (cpi > prevCpi + 0.05 ? ", rising" : cpi < prevCpi - 0.05 ? ", easing" : "") : "";
  const inflStr =
    cpi == null ? "Inflation data unavailable." :
    cpi > 5     ? `Inflation is elevated — CPI at ${cpi.toFixed(1)}%${cpiTrend}${coreCpi != null ? `, core CPI at ${coreCpi.toFixed(1)}%` : ""}. Well above the ${breakevenVal.toFixed(1)}% market breakeven.` :
    cpi > 3     ? `Inflation is running hot — CPI at ${cpi.toFixed(1)}%${cpiTrend}${coreCpi != null ? `, core CPI ${coreCpi.toFixed(1)}%` : ""}${inflAboveExp ? `, surprising markets above the ${breakevenVal.toFixed(1)}% breakeven` : ""}.` :
    cpi > 2     ? `Inflation is near target — CPI at ${cpi.toFixed(1)}%${cpiTrend}${coreCpi != null ? `, core CPI ${coreCpi.toFixed(1)}%` : ""}${inflAboveExp ? `, modestly above the ${breakevenVal.toFixed(1)}% breakeven` : ""}.` :
    cpi > 0     ? `Inflation is contained — CPI at ${cpi.toFixed(1)}%${cpiTrend}, below the ${breakevenVal.toFixed(1)}% market expectation.` :
                  `Deflationary pressure — CPI at ${cpi.toFixed(1)}%.`;

  // ── Pipeline inflation sentence ──
  const ppiStr = ppi != null
    ? `PPI is ${ppi > 3 ? "elevated" : ppi > 0 ? "positive" : "negative"} at ${ppi > 0 ? "+" : ""}${ppi.toFixed(1)}% YoY, ${ppi > cpi ? "running ahead of consumer prices — upstream pressure remains" : "running below CPI — pipeline easing"}.`
    : null;

  // ── Credit / financial conditions ──
  const yieldCurveStr =
    t10y2y == null ? null :
    t10y2y > 1    ? `Yield curve is steep (+${t10y2y.toFixed(2)}%), signaling growth optimism.` :
    t10y2y > 0    ? `Yield curve is normalizing (+${t10y2y.toFixed(2)}%), cautiously positive.` :
    t10y2y > -0.5 ? `Yield curve is flat (${t10y2y.toFixed(2)}%), near inversion.` :
                    `Yield curve is inverted (${t10y2y.toFixed(2)}%), a historical recession signal.`;

  const creditStr =
    hySpread == null ? null :
    hySpread < 3.5  ? `HY credit spreads are tight at ${hySpread.toFixed(1)}% — markets pricing low default risk.` :
    hySpread < 6    ? `HY credit spreads at ${hySpread.toFixed(1)}% — contained but worth watching.` :
                      `HY credit spreads are wide at ${hySpread.toFixed(1)}% — elevated distress risk.`;

  // ── Leading indicators ──
  const leadStr =
    lei == null ? null :
    lei > 0.5   ? `LEI is positive at +${lei.toFixed(1)}%, consistent with expansion.` :
    lei > -0.3  ? `LEI is flat at ${lei.toFixed(1)}% — neither expanding nor contracting.` :
                  `LEI is negative at ${lei.toFixed(1)}% — leading indicators point to slowdown.`;

  // ── Forward signal sentence ──
  // Notes when the underlying score is actually within the dead band (see
  // #8) rather than always saying "building"/"fading" — gDir/iDir have
  // already collapsed a flat score to a sign for the regime-key computation.
  const fwdStr = fwd.forwardKey && fwd.confidence != null
    ? `Forward signals (${fwd.confidence}% confidence) point toward ${REGIME_LABELS[fwd.forwardKey] ?? fwd.forwardKey} — growth momentum is ${fwd.rawGDir === "neutral" ? "flat" : fwd.gDir === "up" ? "building" : "fading"}, inflation pressure is ${fwd.rawIDir === "neutral" ? "flat" : fwd.iDir === "up" ? "rising" : "easing"}.`
    : null;

  // ── Debt sentence ──
  const debtStr = debtGdp != null
    ? `Total debt at ${debtGdp.toFixed(0)}% of GDP — ${debtGdp > 120 ? "structurally elevated, limiting policy flexibility" : debtGdp > 90 ? "high but manageable" : "within historical norms"}.`
    : null;

  // ── Key watch items ──
  const watches = [];
  if (sloos != null && sloos > 40) watches.push("Bank lending standards are tightening sharply");
  if (t10y3m != null && t10y3m < 0) watches.push(`3m/10y curve inverted at ${t10y3m.toFixed(2)}%`);
  if (inflExp != null && inflExp > 4.5) watches.push(`Consumer inflation expectations elevated at ${inflExp.toFixed(1)}%`);
  if (unrate != null && unrate > 5.5) watches.push(`Unemployment rising at ${unrate.toFixed(1)}%`);
  if (hySpread != null && hySpread > 6) watches.push("Credit spreads signaling stress");
  const watchStr = watches.length > 0 ? `Watch: ${watches.join("; ")}.` : null;

  if (!regime) return null;

  const regimeBg = {
    rg_fi: "bg-gain/5   border-gain/20",
    rg_ri: "bg-brass-soft/5 border-brass-soft/20",
    fg_ri: "bg-loss/5   border-loss/20",
    fg_fi: "bg-paper-dim/5 border-paper-dim/20",
  }[regimeKey] ?? "bg-ink-soft border-ink-line";

  const regimeTextColor = {
    rg_fi: "text-gain",
    rg_ri: "text-brass-soft",
    fg_ri: "text-loss",
    fg_fi: "text-paper-dim",
  }[regimeKey] ?? "text-paper";

  return (
    <div className={`card p-5 mb-6 border ${regimeBg}`}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="label mb-0.5">Daily Macro Summary</p>
          <p className="text-[10px] text-paper-dim/60">{today}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-center justify-end gap-1.5">
            <p className={`text-sm font-semibold ${isTransitional ? "text-brass-soft" : regimeTextColor}`}>
              {isTransitional ? "Transitional" : regime.label}
            </p>
            {incompleteRegimeInputs.length > 0 && (
              <span
                className="text-[9px] px-1 py-0.5 rounded bg-loss/15 text-loss border border-loss/30 font-semibold"
                title={`Missing or stale (>30d) manual input${incompleteRegimeInputs.length !== 1 ? "s" : ""}: ${incompleteRegimeInputs.map((i) => i.name).join(", ")}`}
              >
                !
              </span>
            )}
          </div>
          {fwd.forwardKey && fwd.forwardKey !== regimeKey && (
            <p className="text-[10px] text-paper-dim mt-0.5">
              → <span className={REGIME_META[fwd.forwardKey]?.color ?? "text-paper"}>{REGIME_LABELS[fwd.forwardKey]}</span>
            </p>
          )}
        </div>
      </div>

      {/* ── Momentum Signals panel ── */}
      {(() => {
        const growthRegime = regimeKey?.startsWith("rg");
        const inflRegime   = regimeKey?.endsWith("ri");
        const SIGNALS = [
          { short: "GDP",    name: "Real GDP Growth",        current: gdp,       prev: prevGdp, dim: "growth",    fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
          { short: "CPI",    name: "CPI (YoY)",               current: cpi,       prev: prevCpi, dim: "inflation", fmt: v => `${v.toFixed(1)}%` },
          { short: "PPI",    name: "PPI (YoY)",               current: ppi,       prev: prevPpi, dim: "inflation", fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
          { short: "10Y BE", name: "10Y Breakeven Inflation", current: breakeven, prev: prevBe,  dim: "inflation", fmt: v => `${v.toFixed(2)}%` },
          { short: "LEI",    name: "Conference Board LEI",    current: lei,       prev: prevLei, dim: "growth",    fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
        ].filter(s => s.current != null && s.prev != null).map(s => {
          const delta = s.current - s.prev;
          const dir   = Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
          const aligns =
            dir === "flat" ? null :
            s.dim === "growth"    ? (dir === "up" ? !!growthRegime : !growthRegime) :
            s.dim === "inflation" ? (dir === "up" ? !!inflRegime   : !inflRegime)   : null;
          const vintage = vintageLabel(indicators.find(i => i.name === s.name));
          return { ...s, delta, dir, aligns, vintage };
        });

        if (SIGNALS.length === 0) return null;

        const supporting = SIGNALS.filter(s => s.aligns === true).length;
        const warning    = SIGNALS.filter(s => s.aligns === false).length;
        const scored     = SIGNALS.filter(s => s.aligns !== null).length;

        return (
          <div className="mb-4 border-t border-ink-line/50 pt-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-paper-dim/50">Momentum Signals</p>
              <p className={`text-[10px] font-medium ${warning > supporting ? "text-brass-soft" : "text-paper-dim/60"}`}>
                {supporting}/{scored} supporting {regime?.label}
              </p>
            </div>
            <div className="grid grid-cols-5 gap-1.5 mb-2">
              {SIGNALS.map(s => (
                <div key={s.short} className="text-center">
                  <p className="text-[9px] text-paper-dim/50 uppercase tracking-wide mb-0.5">{s.short}</p>
                  <p className="num text-xs font-semibold text-paper">{s.fmt(s.current)}</p>
                  <div className="flex items-center justify-center gap-0.5 mt-0.5">
                    <span className={`text-[10px] font-bold ${s.dir === "up" ? "text-gain" : s.dir === "down" ? "text-loss" : "text-paper-dim/30"}`}>
                      {s.dir === "up" ? "↑" : s.dir === "down" ? "↓" : "→"}
                    </span>
                    <span className="num text-[9px] text-paper-dim/50">{s.fmt(s.prev)}</span>
                  </div>
                  {s.aligns !== null && (
                    <p className={`text-[9px] mt-0.5 ${s.aligns ? "text-gain/60" : "text-loss/60"}`}>
                      {s.aligns ? "✓" : "⚑"}
                    </p>
                  )}
                  {s.vintage && (
                    <p className="text-[8px] text-paper-dim/40 mt-0.5">{s.vintage}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="space-y-1.5 text-[11px] leading-relaxed text-paper-dim">
        <p><span className="text-paper font-medium">Growth — </span>{growthStr}</p>
        <p><span className="text-paper font-medium">Inflation — </span>{inflStr}{ppiStr ? ` ${ppiStr}` : ""}</p>
        {yieldCurveStr && <p><span className="text-paper font-medium">Credit — </span>{yieldCurveStr}{creditStr ? ` ${creditStr}` : ""}</p>}
        {leadStr && <p><span className="text-paper font-medium">Leading — </span>{leadStr}</p>}
        {fwdStr && <p><span className="text-paper font-medium">Outlook — </span>{fwdStr}</p>}
        {debtStr && <p><span className="text-paper font-medium">Debt — </span>{debtStr}</p>}
        {watchStr && <p className="text-brass-soft/80"><span className="font-medium">⚑ </span>{watchStr}</p>}
      </div>
    </div>
  );
}

// ── Bridgewater Structural Thesis ─────────────────────────────────────────────
// Content derived from Bridgewater 2025–2026 published research.
// Update quarterly or when new Bridgewater research materially shifts the thesis.

const BW_FORCES = [
  {
    title: "Modern Mercantilism",
    text: "The globalization era is over — tariffs, industrial policy, and national self-interest replace open trade. US capital exceptionalism is at risk; geographic diversification is no longer optional.",
  },
  {
    title: "AI Transformation",
    text: "AI capex \"significantly supports US growth\" but is inflationary near-term — straining electricity grids and driving a resource grab in copper, silver, uranium, and energy. Productivity payoff is real but too speculative to front-run.",
  },
  {
    title: "Portfolio Concentration Risk",
    text: "Most portfolios reflect winners of the past paradigm: US-heavy, equity-heavy, illiquid, with little inflation protection. Bridgewater's loudest message: today's typical allocation is \"not resilient.\"",
  },
];

const BW_CALLS = [
  { label: "Inflation floor", text: "2% is a floor, not a ceiling — structurally higher, with an upside-skewed cone of outcomes. Drivers: ~7% US deficits in mid-cycle, threats to Fed independence, deglobalization." },
  { label: "Stock/bond correlation", text: "Negative S/B correlation was a statistical artifact of the low-inflation era. Higher inflation volatility flips it positive — exactly what destroyed 60/40 in 2022." },
  { label: "Dollar de-rating", text: "Gold above $4,000/oz (+50% YTD at publication) and commodity strength signal dollar devaluation and mercantilist resource competition, not just risk-off." },
  { label: "Inflation hedges are cheap", text: "TIPS and real assets offer inflation protection at relatively low cost right now — the argument for rebalancing sooner rather than later." },
];

const BW_TILTS = [
  { asset: "US Equities",        textbook: "~30%", direction: "↓ Trim",    note: "Diversify globally; end of US capital exceptionalism risk" },
  { asset: "Nominal Bonds",      textbook: "~55%", direction: "↓↓ Reduce", note: "Most punished when inflation forces tightening; hedge fails" },
  { asset: "TIPS / Infl-Linked", textbook: "0%",   direction: "↑ Add",     note: "Core thesis; inflation protection currently relatively cheap" },
  { asset: "Gold",               textbook: "7.5%", direction: "↑ Increase",note: "Dollar de-rating + mercantilism; de-dollarization signal" },
  { asset: "Commodities",        textbook: "7.5%", direction: "↑ Increase",note: "Energy + AI metals (copper, silver, uranium) resource grab" },
  { asset: "International / EM", textbook: "0%",   direction: "↑ Add",     note: "Key missing ingredient; Asia diversification specifically cited" },
];

function StructuralRegimeCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card p-5 mb-6 border border-amber-800/30 bg-amber-950/10">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="label mb-0.5 text-amber-400/80">Bridgewater Structural Thesis</p>
          <p className="text-[10px] text-paper-dim/60">Derived from 2025–2026 published research · Updated Jul 2026</p>
        </div>
        <button
          onClick={() => setOpen(v => !v)}
          className="text-[10px] text-paper-dim hover:text-amber-400 transition-colors shrink-0 mt-0.5"
        >
          {open ? "Collapse ▲" : "Expand ▼"}
        </button>
      </div>

      {/* Three forces — always visible */}
      <div className="space-y-2 mb-4">
        {BW_FORCES.map(f => (
          <div key={f.title} className="flex gap-2.5">
            <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-amber-500/60 mt-1.5" />
            <p className="text-[11px] leading-relaxed text-paper-dim">
              <span className="text-amber-300/80 font-semibold">{f.title} — </span>{f.text}
            </p>
          </div>
        ))}
      </div>

      {/* Expandable detail */}
      {open && (
        <>
          {/* Key calls */}
          <div className="mb-4 pt-3 border-t border-amber-800/20">
            <p className="label text-[10px] text-amber-400/70 mb-2">Key Market Calls</p>
            <div className="space-y-1.5">
              {BW_CALLS.map(c => (
                <p key={c.label} className="text-[11px] leading-relaxed text-paper-dim">
                  <span className="text-paper font-medium">{c.label} — </span>{c.text}
                </p>
              ))}
            </div>
          </div>

          {/* Allocation tilt table */}
          <div className="pt-3 border-t border-amber-800/20">
            <p className="label text-[10px] text-amber-400/70 mb-2">Implied Allocation Tilts vs. Textbook All Weather</p>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-ink-line/40">
                    <th className="text-left text-paper-dim font-normal pb-1.5 pr-4">Asset</th>
                    <th className="text-right text-paper-dim font-normal pb-1.5 pr-4">Textbook</th>
                    <th className="text-left text-paper-dim font-normal pb-1.5 pr-4">Direction</th>
                    <th className="text-left text-paper-dim font-normal pb-1.5">Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {BW_TILTS.map(t => {
                    const isUp = t.direction.startsWith("↑");
                    const isDown = t.direction.startsWith("↓");
                    return (
                      <tr key={t.asset} className="border-b border-ink-line/20">
                        <td className="py-1.5 pr-4 text-paper whitespace-nowrap">{t.asset}</td>
                        <td className="py-1.5 pr-4 text-right num text-paper-dim">{t.textbook}</td>
                        <td className={`py-1.5 pr-4 font-medium whitespace-nowrap ${isUp ? "text-gain" : isDown ? "text-loss" : "text-paper-dim"}`}>{t.direction}</td>
                        <td className="py-1.5 text-paper-dim/70 leading-snug">{t.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[9px] text-paper-dim/40 mt-2">
              BW Modified allocation in the positioning panel uses: EQ 20% · INTL 8% · EM 5% · Nom Bonds 20% · TIPS 20% · Commodities 12% · Gold 12% · Cash 3%
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function MacroNews() {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-macro-news`)
      .then(r => r.json())
      .then(data => setItems(Array.isArray(data) ? data : []))
      .catch(() => setItems([]));
  }, []);

  function tsAgo(unix) {
    if (!unix) return "";
    const diff = Date.now() - unix * 1000;
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    if (h > 23) return `${Math.floor(h / 24)}d ago`;
    if (h > 0) return `${h}h ago`;
    return `${m}m ago`;
  }

  const filtered =
    items == null ? [] :
    filter === "all" ? items :
    items.filter(i => i.category === filter);

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <p className="label">Macro Research & News</p>
          <p className="text-[10px] text-paper-dim/60 mt-0.5">Bridgewater · Fed · Growth · Inflation · Commodities</p>
        </div>
        <div className="flex gap-1">
          {[["all", "All"], ["bridgewater", "Bridgewater"], ["macro", "Macro"]].map(([val, lbl]) => (
            <button key={val} onClick={() => setFilter(val)}
              className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${
                filter === val
                  ? "bg-brass/15 border-brass/30 text-brass-soft"
                  : "border-ink-line text-paper-dim hover:border-brass/20 hover:text-paper"
              }`}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {items === null ? (
        <p className="text-paper-dim text-sm py-6 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-paper-dim text-sm py-6 text-center">No items found.</p>
      ) : (
        <div className="divide-y divide-ink-line/50">
          {filtered.slice(0, 20).map(item => (
            <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer"
              className="flex items-start gap-3 py-3 group hover:bg-ink-soft/40 -mx-2 px-2 rounded transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] leading-snug text-paper group-hover:text-white transition-colors line-clamp-2">
                  {item.headline}
                </p>
                <p className="text-[11px] text-paper-dim/60 mt-0.5">{item.source}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0 pt-0.5">
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold tracking-wide ${
                  item.category === "bridgewater"
                    ? "bg-brass/20 text-brass-soft"
                    : "bg-sky-900/40 text-sky-400"
                }`}>
                  {item.category === "bridgewater" ? "BW" : "Macro"}
                </span>
                <span className="text-[10px] text-paper-dim/40">{tsAgo(item.publishedAt)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const REGIME_COLORS = {
  rg_fi: "#4ade80",
  rg_ri: "#C9A227",
  fg_ri: "#f87171",
  fg_fi: "#6b7280",
};
const REGIME_SHORT  = { rg_fi: "Boom", rg_ri: "Refl", fg_ri: "Stag", fg_fi: "Bust" };

// Three-way growth-axis read: Expanding requires clearing isGrowthExpanding's
// magnitude/potential-relative bar; Contracting means outright negative
// growth; anything in between (including a positive-but-marginal crossover
// like 2.39% vs 2.28%) reads as Decelerating — the middle state the old
// binary "is the trend positive" test couldn't express.
function growthStateLabel(fast, slow) {
  if (fast <= 0) return { label: "↓ Contracting", color: "text-loss" };
  if (isGrowthExpanding(fast, slow)) return { label: "↑ Expanding", color: "text-gain" };
  return { label: "→ Decelerating", color: "text-brass-soft" };
}

// Data vintage: which FRED release period a reading actually corresponds
// to, and whether it's a hard government release vs. a survey/composite
// index (LEI/ISM) — NOT the same as a "nowcast" (a model-based estimate
// standing in for a not-yet-released hard number, e.g. GDPNow). LEI/ISM
// are real, finalized monthly releases; mislabeling them "nowcast" would
// make solid data look provisional, exactly the kind of mislabeling #6
// was meant to prevent. Scoped to the regime-driving indicators shown in
// the Regime Signal Comparison / Forward Signal panels and the Daily
// Macro Summary, not every indicator card site-wide.
function vintageLabel(ind) {
  const period = ind?.metadata?.reference_period;
  if (!period) return null;
  const d = new Date(period + "T00:00:00Z");
  const formatted = d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return ind.metadata.is_survey ? `${formatted} · survey` : formatted;
}

// 2-of-3 majority across Structural / Market Expectations / Forward Signal.
// A single confident regime word is only justified when at least 2 of the 3
// lenses agree — showing "Reflation" when only 1 of 3 actually points there
// (as happened live) overstates certainty. Returns null when no 2 keys
// match (3-way split), which the headline renders as "Transitional."
function resolveHeadlineRegime(structural, market, forward) {
  const keys = [structural, market, forward].filter(Boolean);
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  const majority = Object.entries(counts).find(([, c]) => c >= 2);
  return majority ? majority[0] : null;
}

// Every indicator name that actually feeds the growth/inflation composite
// scores (derived from the same arrays the scoring itself uses, so this
// never drifts out of sync with what's really driving the regime call) plus
// the crossover indicators shown directly in the comparison table.
const REGIME_INPUT_NAMES = new Set([
  ...FWD_GROWTH_SIGNALS.map((s) => s.sourceName ?? s.name),
  ...FWD_INFL_SIGNALS.map((s) => s.sourceName ?? s.name),
  "GDP Growth (2Q Avg)", "GDP Growth (4Q Avg)",
  "CPI Growth (3M Avg)", "CPI Growth (9M Avg)",
]);

// A regime label computed on a missing or stale manual input looks identical
// to one computed on complete data — the user has no way to know from the
// headline alone. Returns the list of regime-driving indicators that are
// manually-sourced AND either unset or older than staleDays, so the headline
// can flag itself directly rather than relying only on the separate,
// site-wide "N manual indicators need values" banner.
function getStaleOrMissingRegimeInputs(indicators, staleDays = 30) {
  const cutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  return (indicators ?? []).filter((i) => {
    if (!REGIME_INPUT_NAMES.has(i.name) || !i.is_manual) return false;
    if (i.current_value == null) return true;
    const updatedMs = i.updated_at ? new Date(i.updated_at).getTime() : null;
    return updatedMs != null && updatedMs < cutoffMs;
  });
}
const REGIME_LABELS = {
  rg_fi: "Disinflationary Boom",
  rg_ri: "Reflation",
  fg_ri: "Stagflation",
  fg_fi: "Deflationary Bust",
};

// ── Econ Release Calendar ─────────────────────────────────────────────────────

const RELEASE_DEFS = [
  // cadence: "monthly"|"quarterly"|"daily"  lagDays: days after period-end before release
  { key: "gdp",   display: "GDP (Real, Advance)",       source: "BEA",   group: "regime",    cadence: "quarterly", lagDays: 28 },
  { key: "cpi",   display: "CPI Inflation",              source: "BLS",   group: "inflation", cadence: "monthly",   lagDays: 14 },
  { key: "ppi",   display: "PPI",                        source: "BLS",   group: "inflation", cadence: "monthly",   lagDays: 13 },
  { key: "sloos", display: "Sr Loan Officer Survey",     source: "Fed",   group: "growth",    cadence: "quarterly", lagDays: 14 },
  { key: "lei",   display: "Conference Board LEI",       source: "CB",    group: "growth",    cadence: "monthly",   lagDays: 21 },
  { key: "mich",  display: "UMich Inflation Expectations", source: "UMich", group: "inflation", cadence: "monthly", lagDays: 14 },
  { key: "m2",    display: "M2 Money Supply",            source: "Fed",   group: "inflation", cadence: "monthly",   lagDays: 25 },
  { key: "ci",    display: "C&I Loan Growth",            source: "Fed",   group: "growth",    cadence: "monthly",   lagDays: 14 },
];

const FOMC_2026 = [
  "2026-01-28", "2026-03-18", "2026-05-06", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];

const GROUP_META = {
  fomc:      { label: "FOMC",      color: "text-brass-soft",  dot: "bg-brass-soft" },
  regime:    { label: "Regime",    color: "text-sky-400",     dot: "bg-sky-400" },
  inflation: { label: "Inflation", color: "text-loss",        dot: "bg-loss" },
  growth:    { label: "Growth",    color: "text-gain",        dot: "bg-gain" },
};

function econCalUtils() {
  const eom = (y, m) => new Date(Date.UTC(y, m + 1, 0));       // end of month (m 0-indexed)
  const eoq = (d) => {                                          // end of quarter containing d
    const qm = Math.floor(d.getUTCMonth() / 3) * 3 + 2;
    return new Date(Date.UTC(d.getUTCFullYear(), qm + 1, 0));
  };
  const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
  const fmtMon = (d) => d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const fmtQ   = (d) => `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;

  const lastReleasedPeriod = (cadence, lagDays, today) => {
    if (cadence === "daily") return "Real-time";
    if (cadence === "monthly") {
      let y = today.getUTCFullYear(), m = today.getUTCMonth();
      for (let i = 0; i < 6; i++) {
        const end = eom(y, m);
        if (addDays(end, lagDays) <= today) return fmtMon(end);
        if (--m < 0) { m = 11; y--; }
      }
    } else {
      let end = eoq(today);
      for (let i = 0; i < 4; i++) {
        if (addDays(end, lagDays) <= today) return fmtQ(end);
        // Step to the end of the PREVIOUS quarter. Subtracting 1 day from
        // `end` (always a quarter-end date) and re-running eoq() on that
        // doesn't actually cross the quarter boundary — day 29 of a
        // 30-day quarter-end month is still inside the same quarter, so
        // eoq() maps it right back to `end`, making this loop never
        // advance and always fall through to "—". Instead, go 2 months
        // back from the quarter-end month (to the quarter's start month)
        // and take day 0, which rolls back to the last day of the prior
        // quarter directly.
        end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 0));
      }
    }
    return "—";
  };

  const upcomingEvents = (today, days = 90) => {
    const cutoff = addDays(today, days);
    const events = [];

    for (const def of RELEASE_DEFS) {
      if (def.cadence === "daily") continue;
      let periodEnd = def.cadence === "monthly"
        ? eom(today.getUTCFullYear(), today.getUTCMonth())
        : eoq(today);

      for (let iter = 0; iter < 5; iter++) {
        const releaseDate = addDays(periodEnd, def.lagDays);
        if (releaseDate > today && releaseDate <= cutoff) {
          events.push({
            date: releaseDate,
            display: def.display,
            source: def.source,
            group: def.group,
            period: def.cadence === "monthly" ? fmtMon(periodEnd) : fmtQ(periodEnd),
            daysAway: Math.ceil((releaseDate - today) / 864e5),
          });
        }
        if (releaseDate > cutoff) break;
        // advance to next period
        if (def.cadence === "monthly") {
          const nm = periodEnd.getUTCMonth() === 11 ? 0 : periodEnd.getUTCMonth() + 1;
          const ny = periodEnd.getUTCMonth() === 11 ? periodEnd.getUTCFullYear() + 1 : periodEnd.getUTCFullYear();
          periodEnd = eom(ny, nm);
        } else {
          periodEnd = eoq(new Date(periodEnd.getTime() + 864e5));
        }
      }
    }

    for (const ds of FOMC_2026) {
      const date = new Date(ds + "T12:00:00Z");
      if (date > today && date <= cutoff) {
        events.push({
          date, display: "FOMC Rate Decision", source: "Fed", group: "fomc",
          period: date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
          daysAway: Math.ceil((date - today) / 864e5),
        });
      }
    }

    return events.sort((a, b) => a.date - b.date);
  };

  return { lastReleasedPeriod, upcomingEvents, eom, eoq, addDays, fmtMon, fmtQ };
}

function EconCalendar() {
  const today = new Date();
  const { lastReleasedPeriod, upcomingEvents } = econCalUtils();
  const events = upcomingEvents(today, 90);

  return (
    <div>
      {/* Current data window */}
      <div className="mb-5">
        <p className="label mb-2">Current Data Window</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
          {RELEASE_DEFS.map(def => {
            const thru = lastReleasedPeriod(def.cadence, def.lagDays, today);
            const gm = GROUP_META[def.group];
            return (
              <div key={def.key} className="flex items-baseline justify-between text-[11px] py-0.5 border-b border-ink-line/40">
                <span className="text-paper-dim">{def.display}</span>
                <span className="flex items-center gap-1.5 text-paper">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${gm.dot}`} />
                  {thru}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Upcoming events */}
      <div className="flex items-center justify-between mb-2">
        <p className="label">Upcoming Releases <span className="font-normal text-paper-dim/60 ml-1">next 90 days</span></p>
        <a
          href="https://xuutmtfrpaxrzhwwokpk.supabase.co/functions/v1/macro-calendar"
          title="Subscribe in Google Calendar, Thunderbird, or any iCal client"
          className="flex items-center gap-1 text-[10px] text-paper-dim hover:text-brass-soft transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="3" width="14" height="12" rx="1.5" />
            <line x1="1" y1="7" x2="15" y2="7" />
            <line x1="5" y1="1" x2="5" y2="5" />
            <line x1="11" y1="1" x2="11" y2="5" />
          </svg>
          Subscribe
        </a>
      </div>
      {events.length === 0
        ? <p className="text-xs text-paper-dim">No releases scheduled in window.</p>
        : (
          <div className="space-y-0">
            {events.map((ev, i) => {
              const gm = GROUP_META[ev.group];
              const urgent = ev.daysAway <= 7;
              const soon   = ev.daysAway <= 30;
              return (
                <div key={i} className={`flex items-center gap-3 py-1.5 border-b border-ink-line/40 ${urgent ? "bg-brass-soft/5 -mx-2 px-2 rounded" : ""}`}>
                  <span className={`num text-[11px] w-16 shrink-0 ${urgent ? "text-brass-soft font-medium" : soon ? "text-paper" : "text-paper-dim"}`}>
                    {ev.date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                  </span>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${gm.dot}`} />
                  <span className="text-[11px] text-paper flex-1 min-w-0">
                    {ev.display}
                    <span className="text-paper-dim ml-1.5">({ev.period})</span>
                  </span>
                  <span className="text-[10px] text-paper-dim/60 shrink-0">{ev.source}</span>
                  <span className={`text-[10px] shrink-0 ${gm.color}`}>{gm.label}</span>
                  <span className={`num text-[10px] w-12 text-right shrink-0 ${urgent ? "text-brass-soft font-medium" : "text-paper-dim/60"}`}>
                    {ev.daysAway === 0 ? "today" : `${ev.daysAway}d`}
                  </span>
                </div>
              );
            })}
          </div>
        )
      }

      <p className="text-[10px] text-paper-dim/40 mt-3">
        Daily market data (yield curves, breakevens, credit spreads, crude, copper) updates continuously and is not shown.
        FOMC dates are 2026 scheduled meetings; confirm at federalreserve.gov.
      </p>
    </div>
  );
}

// Local-extrema peak/trough detection with a minimum-prominence deadband, so
// quarter-to-quarter noise in GDP/CPI YoY doesn't register as a false cyclical
// turn. A point qualifies as a peak/trough only if it's the highest/lowest
// value within `window` quarters on both sides AND the swing versus the
// nearest opposing extreme within that window clears `minProminence` points —
// same spirit as scipy's find_peaks prominence filter, no library needed.
function findPeaksTroughs(series, minProminence = 0.5, window = 2) {
  const peaks = [];
  const troughs = [];
  for (let i = window; i < series.length - window; i++) {
    const v = series[i].value;
    const left = series.slice(i - window, i).map((s) => s.value);
    const right = series.slice(i + 1, i + 1 + window).map((s) => s.value);
    if (left.every((x) => x <= v) && right.every((x) => x <= v)) {
      const localMin = Math.min(...left, ...right);
      if (v - localMin >= minProminence) peaks.push(series[i]);
    }
    if (left.every((x) => x >= v) && right.every((x) => x >= v)) {
      const localMax = Math.max(...left, ...right);
      if (localMax - v >= minProminence) troughs.push(series[i]);
    }
  }
  return { peaks, troughs };
}

function RegimeHistoryChart({ data }) {
  const [tooltip, setTooltip] = useState(null);

  const sorted = [...data].sort((a, b) => a.period_date.localeCompare(b.period_date));
  if (sorted.length === 0) return <p className="text-xs text-paper-dim">No history data yet.</p>;

  const concordance = sorted.filter(r => r.structural_key === r.market_key).length / sorted.length;
  const divergences = sorted.filter(r => r.structural_key !== r.market_key);
  const CELL_W = 10;

  // Cycle-phase context: where are we relative to the last growth/inflation
  // turning point, on top of the static quadrant classification above.
  const growthSeries = sorted.filter(r => r.gdp_yoy != null).map(r => ({ date: r.period_date, value: Number(r.gdp_yoy) }));
  const inflSeries = sorted.filter(r => r.cpi_yoy != null).map(r => ({ date: r.period_date, value: Number(r.cpi_yoy) }));
  const growthTurns = findPeaksTroughs(growthSeries);
  const inflTurns = findPeaksTroughs(inflSeries);
  const quartersSince = (dateA, dateB) => {
    const [ya, ma] = dateA.split("-").map(Number), [yb, mb] = dateB.split("-").map(Number);
    return Math.round(((yb - ya) * 12 + (mb - ma)) / 3);
  };
  const lastTurn = (turns, latestDate) => {
    const all = [...turns.peaks.map(t => ({ ...t, type: "peak" })), ...turns.troughs.map(t => ({ ...t, type: "trough" }))]
      .sort((a, b) => b.date.localeCompare(a.date));
    return all[0] ? { ...all[0], quartersSince: quartersSince(all[0].date, latestDate) } : null;
  };
  const latestDate = sorted[sorted.length - 1].period_date;
  const lastGrowthTurn = growthSeries.length ? lastTurn(growthTurns, latestDate) : null;
  const lastInflTurn = inflSeries.length ? lastTurn(inflTurns, latestDate) : null;
  const turnMarkerType = new Map([
    ...growthTurns.peaks.map(t => [t.date, "peak"]),
    ...growthTurns.troughs.map(t => [t.date, "trough"]),
  ]);

  const rows = [
    { key: "structural_key", label: "Structural" },
    { key: "market_key",     label: "Mkt Expect" },
  ];

  return (
    <div>
      {/* Summary stats */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mb-3 text-[11px]">
        <span className="text-paper-dim">
          Structural / Market concordance{" "}
          <span className={`num font-medium ${concordance >= 0.7 ? "text-gain" : "text-brass-soft"}`}>
            {Math.round(concordance * 100)}%
          </span>
        </span>
        <span className="text-paper-dim">
          Divergence periods{" "}
          <span className="num text-paper">{divergences.length}</span>
          {" "}of{" "}
          <span className="num text-paper">{sorted.length}</span>
          {" "}quarters
        </span>
        <span className="text-paper-dim">
          {sorted[0].period_date.slice(0, 4)}–{sorted[sorted.length - 1].period_date.slice(0, 4)}
        </span>
        {lastGrowthTurn && (
          <span className="text-paper-dim">
            Growth cycle:{" "}
            <span className="num text-paper">{lastGrowthTurn.quartersSince}q</span>
            {" "}since last {lastGrowthTurn.type === "peak" ? "peak ↓" : "trough ↑"}
          </span>
        )}
        {lastInflTurn && (
          <span className="text-paper-dim">
            Inflation cycle:{" "}
            <span className="num text-paper">{lastInflTurn.quartersSince}q</span>
            {" "}since last {lastInflTurn.type === "peak" ? "peak ↓" : "trough ↑"}
          </span>
        )}
      </div>
      <p className="text-[10px] text-paper-dim/60 mb-3">
        Cycle-phase context from local-extrema detection on GDP/CPI YoY (min. 0.5pt prominence, ±2 quarter window) — a slower-moving complement to the quadrant classification above, not a substitute for it.
      </p>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
        {Object.entries(REGIME_LABELS).map(([key, label]) => (
          <span key={key} className="flex items-center gap-1.5 text-[10px] text-paper-dim">
            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: REGIME_COLORS[key] }} />
            {label}
          </span>
        ))}
      </div>

      {/* Timeline */}
      <div className="overflow-x-auto pb-1">
        <div style={{ minWidth: sorted.length * (CELL_W + 1) + 72 }}>
          {/* Year labels */}
          <div className="flex mb-0.5 ml-[72px]">
            {sorted.map((r, i) => {
              const yr = r.period_date.slice(0, 4);
              const isFirst = i === 0 || yr !== sorted[i - 1].period_date.slice(0, 4);
              return (
                <div key={r.period_date} style={{ width: CELL_W + 1, flexShrink: 0 }}>
                  {isFirst && <span className="text-[9px] text-paper-dim/60 leading-none">{yr.slice(2)}</span>}
                </div>
              );
            })}
          </div>

          {/* Growth cycle turning-point markers */}
          <div className="flex mb-0.5 ml-[72px]">
            {sorted.map((r) => {
              const turnType = turnMarkerType.get(r.period_date);
              return (
                <div key={r.period_date} style={{ width: CELL_W + 1, flexShrink: 0 }} className="flex justify-center" title={turnType ? `Growth ${turnType} — ${r.period_date.slice(0, 7)}` : undefined}>
                  {turnType === "peak" && <span className="text-loss text-[9px] leading-none">▼</span>}
                  {turnType === "trough" && <span className="text-gain text-[9px] leading-none">▲</span>}
                </div>
              );
            })}
          </div>

          {/* Regime rows */}
          {rows.map(({ key, label }) => (
            <div key={key} className="flex items-center mb-0.5">
              <span className="text-[10px] text-paper-dim w-[72px] shrink-0">{label}</span>
              <div className="flex gap-px">
                {sorted.map((r) => {
                  const rk = r[key];
                  const isDivergent = key !== "structural_key" && rk && rk !== r.structural_key;
                  return (
                    <div
                      key={r.period_date}
                      style={{ width: CELL_W, height: 18, background: rk ? REGIME_COLORS[rk] : "transparent", opacity: rk ? (isDivergent ? 1 : 0.75) : 1, flexShrink: 0 }}
                      className="rounded-sm cursor-default relative"
                      onMouseEnter={() => setTooltip({ r, key })}
                      onMouseLeave={() => setTooltip(null)}
                    >
                      {isDivergent && (
                        <div className="absolute inset-0 rounded-sm border border-white/40" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-ink-soft border border-ink-line text-[11px] text-paper-dim">
          <span className="text-paper font-medium mr-2">{tooltip.r.period_date.slice(0, 7)}</span>
          <span style={{ color: REGIME_COLORS[tooltip.r[tooltip.key]] }}>{REGIME_LABELS[tooltip.r[tooltip.key]] ?? "—"}</span>
          <span className="mx-2">·</span>
          GDP <span className="num text-paper">{tooltip.r.gdp_yoy}%</span>
          <span className="mx-1">/</span>
          CPI <span className="num text-paper">{tooltip.r.cpi_yoy}%</span>
          {tooltip.r.breakeven && (
            <><span className="mx-1">/</span>T10YIE <span className="num text-paper">{tooltip.r.breakeven}%</span></>
          )}
          {tooltip.r.structural_key !== tooltip.r.market_key && (
            <span className="ml-2 text-brass-soft">
              ↕ divergence: {REGIME_SHORT[tooltip.r.structural_key]} vs {REGIME_SHORT[tooltip.r.market_key]}
            </span>
          )}
        </div>
      )}

      {/* Recent divergence table */}
      {divergences.length > 0 && (
        <div className="mt-4">
          <p className="label mb-2">Recent Structural / Market Divergences</p>
          <div className="space-y-1">
            {divergences.slice(-8).reverse().map(r => (
              <div key={r.period_date} className="flex items-center gap-2 text-[11px]">
                <span className="text-paper-dim w-16 shrink-0">{r.period_date.slice(0, 7)}</span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: REGIME_COLORS[r.structural_key] }} />
                  <span className="text-paper-dim">{REGIME_SHORT[r.structural_key]}</span>
                </span>
                <span className="text-paper-dim">vs</span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: REGIME_COLORS[r.market_key] }} />
                  <span className="text-paper-dim">{REGIME_SHORT[r.market_key]}</span>
                </span>
                <span className="text-paper-dim/60 text-[10px]">
                  GDP {r.gdp_yoy}% · CPI {r.cpi_yoy}%
                  {r.breakeven ? ` · T10YIE ${r.breakeven}%` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ALLOC_ASSET_META = [
  { key: "eq",   label: "US Equities",   color: "#C9A227" },
  { key: "intl", label: "International", color: "#A8832A" },
  { key: "em",   label: "EM Equities",   color: "#7A6020" },
  { key: "nb",   label: "Nominal Bonds", color: "#5B8DB8" },
  { key: "tip",  label: "TIPS",          color: "#7BA7CC" },
  { key: "com",  label: "Commodities",   color: "#CC7B2E" },
  { key: "gld",  label: "Gold",          color: "#F0C040" },
  { key: "cash", label: "Cash",          color: "#A8ADB8" },
];

function QuadrantCard({ indicators, holdings, assetData }) {
  const gdp        = indicators.find((i) => i.name === "Real GDP Growth");
  const cpi        = indicators.find((i) => i.name === "CPI (YoY)");
  // Prefer the real, currently-updated indicator over a legacy/orphaned
  // "ISM New Orders" row with no metadata (a stale name from before ISM
  // New Orders was folded into "ISM Manufacturing PMI"'s own metadata) —
  // .find()'s array-order fallback was silently picking the metadata-less
  // one, which also meant the #6 vintage/nowcast tag never had data to show.
  const ism        = indicators.find((i) => i.name === "ISM Manufacturing PMI")
                   ?? indicators.find((i) => i.name === "ISM New Orders");
  const breakeven  = indicators.find((i) => i.name === "10Y Breakeven Inflation");
  const gdp3yAvg   = indicators.find((i) => i.name === "GDP Growth (4Q Avg)");
  const gdpFastInd = indicators.find((i) => i.name === "GDP Growth (2Q Avg)");
  const cpi3yAvg   = indicators.find((i) => i.name === "CPI Growth (9M Avg)");
  const cpiFastInd = indicators.find((i) => i.name === "CPI Growth (3M Avg)");
  const payrollsInd  = indicators.find((i) => i.name === "Payrolls (3M Avg)");
  const unrateTrendInd = indicators.find((i) => i.name === "Unemployment Rate Trend");
  const claimsTrendInd = indicators.find((i) => i.name === "Initial Jobless Claims Trend");
  // GDP & Inflation Regime Metrics spec (G1/G3 and I1/I2/I3/I4) — see
  // gdpRegimeStats/cpiRegimeStats below, passed to the extended crossover
  // drawers.
  const coreCpiInd     = indicators.find((i) => i.name === "Core CPI (YoY)");
  const coreCpiFastInd = indicators.find((i) => i.name === "Core CPI Growth (3M Avg)");
  const coreCpiSlowInd = indicators.find((i) => i.name === "Core CPI Growth (9M Avg)");
  const consumerExpInd = indicators.find((i) => i.name === "Consumer Inflation Expectations");

  const breakevenVal = breakeven?.current_value != null ? Number(breakeven.current_value) : FED_INFLATION_TARGET;
  const gdp3yAvgVal  = gdp3yAvg?.current_value  != null ? Number(gdp3yAvg.current_value)  : 0;
  const cpi3yAvgVal  = cpi3yAvg?.current_value  != null ? Number(cpi3yAvg.current_value)  : null;
  const gdpFastVal   = gdpFastInd?.current_value != null ? Number(gdpFastInd.current_value) : null;
  const cpiFastVal   = cpiFastInd?.current_value != null ? Number(cpiFastInd.current_value) : null;
  // Labor veto inputs for the growth axis (see isLaborDeteriorating in
  // lib/simulatorKeys.js) — lets payrolls/unemployment/claims deterioration
  // pull a marginal GDP-crossover "Expanding" read down directly, instead of
  // only ever showing up in the separate Forward Signal composite score.
  const payrolls3mAvg      = payrollsInd?.current_value != null ? Number(payrollsInd.current_value) : null;
  const unemploymentTrend  = unrateTrendInd?.current_value != null ? Number(unrateTrendInd.current_value) : null;
  const joblessClaimsTrend = claimsTrendInd?.current_value != null ? Number(claimsTrendInd.current_value) : null;
  const laborDeteriorating = isLaborDeteriorating(payrolls3mAvg, unemploymentTrend, joblessClaimsTrend);

  // Structural regime: fast/slow moving-average crossover, not raw-reading-
  // vs-baseline. GDP: 2-quarter avg (fast) vs 4-quarter avg (slow). CPI:
  // 3-month avg (fast) vs 9-month avg (slow). A regime flip only fires when
  // the fast line actually crosses the slow line — a real, sustained shift,
  // not just one noisy print poking through a single threshold the way the
  // prior current-vs-baseline test (and the debt-cycle annual quadrant this
  // used to fall back to) could produce.
  const structuralRegimeKey = gdpFastVal != null && gdp3yAvg?.current_value != null
    ? (() => {
        const growthUp = isGrowthExpanding(gdpFastVal, gdp3yAvgVal) && !laborDeteriorating;
        const inflUp   = cpiFastVal != null && cpi3yAvgVal != null && cpiFastVal > cpi3yAvgVal;
        if (growthUp && !inflUp) return "rg_fi";
        if (growthUp && inflUp)  return "rg_ri";
        if (!growthUp && inflUp) return "fg_ri";
        return "fg_fi";
      })()
    : null;
  const structuralMeta = structuralRegimeKey ? REGIME_META[structuralRegimeKey] : null;

  // Market-expectations regime: is the market pricing sustained inflation above
  // the Fed's own 2% target (FED_INFLATION_TARGET)? CPI > breakeven means the
  // market expects disinflation, NOT that inflation is surprising upside. The
  // threshold used to be a hardcoded 2.5% — an arbitrary round number that
  // called a 2.31% breakeven "below threshold" when it's actually still above
  // the Fed's real mandate. Growth leg reuses the same fast/slow crossover as
  // the structural regime above.
  const marketRegimeKey = gdpFastVal != null
    ? (() => {
        const growthUp = isGrowthExpanding(gdpFastVal, gdp3yAvgVal ?? 0) && !laborDeteriorating;
        const inflUp   = breakevenVal > FED_INFLATION_TARGET;
        if (growthUp && !inflUp) return "rg_fi";
        if (growthUp && inflUp)  return "rg_ri";
        if (!growthUp && inflUp) return "fg_ri";
        return "fg_fi";
      })()
    : null;
  const marketMeta = marketRegimeKey ? REGIME_META[marketRegimeKey] : null;

  const fwd = computeForwardSignal(indicators);

  // Headline/allocation key: 2-of-3 majority across Structural / Market /
  // Forward when at least 2 are available and 2 agree; otherwise falls back
  // to the structural read (a stable anchor for portfolio weights even when
  // the lenses are split) so allocation logic never goes fully unset.
  const majorityRegimeKey = resolveHeadlineRegime(structuralRegimeKey, marketRegimeKey, fwd.forwardKey);
  const isTransitional = structuralRegimeKey != null && marketRegimeKey != null && majorityRegimeKey == null;
  const incompleteRegimeInputs = getStaleOrMissingRegimeInputs(indicators);
  const regimeKey = majorityRegimeKey
    ?? structuralRegimeKey
    ?? (gdp?.current_value != null && cpi?.current_value != null
        ? detectRegimeKey(Number(gdp.current_value), Number(cpi.current_value), {
            breakeven: breakevenVal,
            gdp3yAvg:  gdp3yAvgVal,
          })
        : null);

  const regime = regimeKey ? REGIME_META[regimeKey] : null;

  const [allocMethod, setAllocMethod] = useState("bw");
  // Regime Signal Comparison table cells open a side-drawer chart of the two
  // lines behind that cell's read. Growth's Structural and Market Expectations
  // cells share one drawer since both derive from the same GDP fast/slow
  // crossover (there's no independent market-priced growth series to show).
  const [gdpDrawerOpen, setGdpDrawerOpen] = useState(false);
  const [cpiCrossoverDrawerOpen, setCpiCrossoverDrawerOpen] = useState(false);
  const [inflExpDrawerOpen, setInflExpDrawerOpen] = useState(false);

  // GDP & Inflation Regime Metrics spec — G1 (z-score vs 10yr window, from
  // fetch-macro-data's computeRollingZScore, stored on "Real GDP Growth"'s
  // metadata), G2 (Accelerating/Decelerating/Stable via rateOfChangeLabel,
  // reusing the same fast/slow crossover the Structural lens already uses),
  // G3 (direction — the 2Q-avg indicator's own current vs. previous value
  // already IS MA_2q(t) vs MA_2q(t-1), so no new data is needed).
  const gdpRegimeStats = {
    zscore: gdp?.metadata?.zscore_10y ?? null,
    windowMean: gdp?.metadata?.window_mean ?? null,
    windowMin: gdp?.metadata?.window_min ?? null,
    windowMax: gdp?.metadata?.window_max ?? null,
    rateLabel: gdpFastVal != null && gdp3yAvg?.current_value != null
      ? rateOfChangeLabel(gdpFastVal, gdp3yAvgVal, GROWTH_MIN_GAP) : null,
    direction: gdpFastInd?.current_value != null && gdpFastInd?.previous_value != null
      ? Math.sign(Number(gdpFastInd.current_value) - Number(gdpFastInd.previous_value)) : null,
    currentValue: gdp?.current_value != null ? Number(gdp.current_value) : null,
  };
  // I1 (z-score vs 18yr window, on Core CPI — see computeRollingZScore's
  // guard on "Core CPI (YoY)"), I2 (Accelerating/Decelerating/Stable on
  // Core CPI's own 3M/9M crossover, wider CPI_MIN_GAP dead band), I3
  // (direction on the existing HEADLINE CPI 3M-avg indicator — I3 is
  // deliberately headline, unlike I1/I2's core basis), I4's consumer-
  // expectations attribution (umich_1yr/nyfed_1yr, set alongside the
  // existing blended composite_stress_z).
  const coreCpiFastVal = coreCpiFastInd?.current_value != null ? Number(coreCpiFastInd.current_value) : null;
  const coreCpiSlowVal = coreCpiSlowInd?.current_value != null ? Number(coreCpiSlowInd.current_value) : null;
  const cpiRegimeStats = {
    zscore: coreCpiInd?.metadata?.zscore_18y ?? null,
    windowMean: coreCpiInd?.metadata?.window_mean ?? null,
    windowMin: coreCpiInd?.metadata?.window_min ?? null,
    windowMax: coreCpiInd?.metadata?.window_max ?? null,
    rateLabel: coreCpiFastVal != null && coreCpiSlowVal != null
      ? rateOfChangeLabel(coreCpiFastVal, coreCpiSlowVal, CPI_MIN_GAP) : null,
    direction: cpiFastInd?.current_value != null && cpiFastInd?.previous_value != null
      ? Math.sign(Number(cpiFastInd.current_value) - Number(cpiFastInd.previous_value)) : null,
    umich1yr: consumerExpInd?.metadata?.umich_1yr ?? null,
    nyfed1yr: consumerExpInd?.metadata?.nyfed_1yr ?? null,
    currentValue: coreCpiInd?.current_value != null ? Number(coreCpiInd.current_value) : null,
  };

  const signalKeys = regimeKey ? getSignalKeys(regimeKey) : [];
  // BW Modified and RP methods show all 8 market assets; Default shows regime-favored only
  const displayKeys = regimeKey
    ? (allocMethod === "default" || (!assetData && allocMethod !== "bw")
      ? signalKeys
      : allocMethod === "bw"
        ? Object.keys(BW_ALLOC)
        : assetData.assets.map((a) => a.key))
    : [];
  const favoredSet = new Set(displayKeys);
  const suggestedPcts = regimeKey
    ? computeSuggestedPcts(regimeKey, allocMethod, assetData)
    : {};

  const regimeReturns = regimeKey ? (REGIME_RETURNS[regimeKey] ?? {}) : {};
  const blendedReturn = regimeKey
    ? Object.entries(suggestedPcts).reduce((s, [k, w]) => s + (w / 100) * (regimeReturns[k] ?? 0), 0)
    : null;

  const [actionsOpen, setActionsOpen] = useState(false);

  const prevRegimeKeyRef = useRef(null);
  const [prevRegimeKey, setPrevRegimeKey] = useState(null);
  const [regimeChangedAt, setRegimeChangedAt] = useState(null);

  useEffect(() => {
    if (!regimeKey) return;
    if (prevRegimeKeyRef.current && prevRegimeKeyRef.current !== regimeKey) {
      setPrevRegimeKey(prevRegimeKeyRef.current);
      setRegimeChangedAt(new Date());
    }
    prevRegimeKeyRef.current = regimeKey;
  }, [regimeKey]);

  const prevSuggestedPcts = prevRegimeKey
    ? computeSuggestedPcts(prevRegimeKey, allocMethod, assetData)
    : null;

  // Actual-vs-suggested allocation delta math lives in lib/simulatorKeys.js
  // (computeAllocationDeltas) so it's shared with the Debt Cycle Position
  // Check panel instead of duplicated. suggestedPcts is already gated on
  // regimeKey at its own definition above.
  const { byKey, grandTotal, actionRows, buyRows } = computeAllocationDeltas(
    holdings, suggestedPcts, { illiquidKeys: ILLIQUID_KEYS }
  );

  const pct = (val) => (grandTotal > 0 ? Math.round((val / grandTotal) * 100) : 0);

  // Favored buckets: displayKeys (all 8 market assets for RP, signal keys for Default)
  const favoredBuckets = displayKeys.map((k) => ({
    key: k,
    label: KEY_LABEL[k] ?? k,
    total: byKey[k]?.total ?? 0,
    pct: pct(byKey[k]?.total ?? 0),
    holdings: byKey[k]?.holdings ?? [],
  }));

  // Outside-signal buckets: portfolio weight in non-favored keys, sorted by weight desc
  const outsideBuckets = Object.entries(byKey)
    .filter(([k]) => !favoredSet.has(k))
    .map(([k, data]) => ({
      key: k,
      label: KEY_LABEL[k] ?? k,
      pct: pct(data.total),
      holdings: data.holdings,
    }))
    .sort((a, b) => b.pct - a.pct);

  const alignedRaw = favoredBuckets.reduce((s, b) => s + (byKey[b.key]?.total ?? 0), 0);
  const alignedPct = grandTotal > 0 ? Math.round((alignedRaw / grandTotal) * 100) : 0;
  const outsideRaw = outsideBuckets.reduce((s, b) => s + (byKey[b.key]?.total ?? 0), 0);
  const outsidePct = grandTotal > 0 ? Math.round((outsideRaw / grandTotal) * 100) : 0;
  const hasPortfolio = holdings && holdings.length > 0;

  return (
    <div className="card p-5 mb-6">
      <p className="label mb-3">Current Macro Regime</p>
      {regime ? (
        <div className="space-y-5">

          {/* Regime label + key indicators */}
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <div className="flex items-center gap-2">
                {isTransitional ? (
                  <p className="text-2xl font-bold text-brass-soft">Transitional</p>
                ) : (
                  <p className={`text-2xl font-bold ${regime.color}`}>{regime.label}</p>
                )}
                {incompleteRegimeInputs.length > 0 && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded bg-loss/15 text-loss border border-loss/30 font-semibold tracking-wide"
                    title={`Missing or stale (>30d) manual input${incompleteRegimeInputs.length !== 1 ? "s" : ""}: ${incompleteRegimeInputs.map((i) => i.name).join(", ")}`}
                  >
                    Incomplete
                  </span>
                )}
              </div>
              {isTransitional ? (
                <p className="text-paper-dim text-sm mt-1">
                  Lenses diverging — Structural: {structuralMeta?.label ?? "n/a"} · Market: {marketMeta?.label ?? "n/a"} · Forward: {fwd.forwardKey ? (REGIME_META[fwd.forwardKey]?.label ?? "n/a") : "n/a"}
                </p>
              ) : (
                <p className="text-paper-dim text-sm mt-1">{regime.desc}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {/* GDP: actual vs 4-quarter trend */}
              <div className="bg-ink-soft rounded-lg px-3 py-1.5">
                <p className="label text-[10px]">GDP Growth</p>
                <p className="num text-sm">{formatValue(gdp?.current_value, "%")}</p>
                {gdp3yAvg?.current_value != null && (
                  <p className="text-[10px] text-paper-dim mt-0.5">
                    {Number(gdp.current_value) > gdp3yAvgVal
                      ? <span className="text-gain">↑</span>
                      : <span className="text-loss">↓</span>
                    }{" "}
                    4Q avg {gdp3yAvgVal.toFixed(1)}%
                  </p>
                )}
                {vintageLabel(gdp) && (
                  <p className="text-[9px] text-paper-dim/50 mt-0.5">as of {vintageLabel(gdp)}</p>
                )}
              </div>
              {/* CPI: actual vs 10Y breakeven */}
              <div className="bg-ink-soft rounded-lg px-3 py-1.5">
                <p className="label text-[10px]">Headline CPI YoY</p>
                <p className="num text-sm">{formatValue(cpi?.current_value, "%")}</p>
                {breakeven?.current_value != null && (
                  <p className="text-[10px] text-paper-dim mt-0.5">
                    {Number(cpi.current_value) > breakevenVal
                      ? <span className="text-loss">↑</span>
                      : <span className="text-gain">↓</span>
                    }{" "}
                    mkt exp {breakevenVal.toFixed(2)}%
                  </p>
                )}
                {vintageLabel(cpi) && (
                  <p className="text-[9px] text-paper-dim/50 mt-0.5">as of {vintageLabel(cpi)}</p>
                )}
              </div>
              {/* ISM PMI */}
              <div className="bg-ink-soft rounded-lg px-3 py-1.5">
                <p className="label text-[10px]">ISM PMI</p>
                <p className="num text-sm">{formatValue(ism?.current_value, "index")}</p>
                {vintageLabel(ism) && (
                  <p className="text-[9px] text-paper-dim/50 mt-0.5">as of {vintageLabel(ism)}</p>
                )}
              </div>
            </div>
          </div>

          {/* ── Regime Signal Comparison ──────────────────────────────── */}
          <div>
            <p className="label mb-3">Regime Signal Comparison</p>
            <div className="border border-ink-line rounded-lg overflow-hidden text-sm">

              {/* Column headers */}
              <div className="grid grid-cols-3 bg-ink-soft/50 border-b border-ink-line">
                <div className="px-3 py-2" />
                <div className="px-3 py-2 border-l border-ink-line">
                  <p className="label text-[10px]">Structural</p>
                  <p className="text-[10px] text-paper-dim">Fast/slow moving-average crossover</p>
                </div>
                <div className="px-3 py-2 border-l border-ink-line">
                  <p className="label text-[10px]">Market Expectations</p>
                  <p className="text-[10px] text-paper-dim">Is market pricing sustained growth / inflation?</p>
                </div>
              </div>

              {/* Growth row */}
              <div className="grid grid-cols-3 border-b border-ink-line">
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-1">Growth</p>
                  <p className="num text-sm">{formatValue(gdp?.current_value, "%")}</p>
                </div>
                <div
                  onClick={() => setGdpDrawerOpen(true)}
                  className="px-3 py-3 border-l border-ink-line cursor-pointer hover:bg-ink/40 transition-colors group"
                >
                  <p className="text-[10px] text-paper-dim mb-1 flex items-center gap-1">
                    Fast vs slow vs potential — trend read
                    <ChartIcon />
                  </p>
                  {gdpFastVal != null && gdp3yAvg?.current_value != null ? (() => {
                    const state = growthStateLabel(gdpFastVal, gdp3yAvgVal);
                    return (
                      <>
                        <p className={`font-medium ${state.color}`}>{state.label}</p>
                        <p className="num text-[11px] text-paper-dim mt-0.5">
                          {gdpFastVal.toFixed(2)}% vs {gdp3yAvgVal.toFixed(2)}% (min gap 0.15pp, potential floor {(POTENTIAL_GDP_GROWTH * POTENTIAL_FLOOR_FRACTION).toFixed(2)}%)
                        </p>
                        {vintageLabel(gdpFastInd) && (
                          <p className="text-[9px] text-paper-dim/50 mt-0.5">as of {vintageLabel(gdpFastInd)}</p>
                        )}
                      </>
                    );
                  })() : <p className="text-paper-dim text-[11px]">Pending refresh</p>}
                </div>
                <div
                  onClick={() => setGdpDrawerOpen(true)}
                  className="px-3 py-3 border-l border-ink-line cursor-pointer hover:bg-ink/40 transition-colors group"
                >
                  <p className="text-[10px] text-paper-dim mb-1 flex items-center gap-1">
                    2Q vs 4Q avg — crossover?
                    <ChartIcon />
                  </p>
                  {gdpFastVal != null && gdp3yAvg?.current_value != null ? (() => {
                    const state = growthStateLabel(gdpFastVal, gdp3yAvgVal);
                    return (
                      <>
                        <p className={`font-medium ${state.color}`}>{state.label}</p>
                        <p className="num text-[11px] text-paper-dim mt-0.5">{gdpFastVal.toFixed(2)}% vs {gdp3yAvgVal.toFixed(2)}%</p>
                      </>
                    );
                  })() : <p className="text-paper-dim text-[11px]">Pending refresh</p>}
                </div>
              </div>

              {/* Inflation row */}
              <div className="grid grid-cols-3 border-b border-ink-line">
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-1">Inflation (Headline CPI)</p>
                  <p className="num text-sm">{formatValue(cpi?.current_value, "%")}</p>
                </div>
                <div
                  onClick={() => setCpiCrossoverDrawerOpen(true)}
                  className="px-3 py-3 border-l border-ink-line cursor-pointer hover:bg-ink/40 transition-colors group"
                >
                  <p className="text-[10px] text-paper-dim mb-1 flex items-center gap-1">
                    3M vs 9M avg — crossover?
                    <ChartIcon />
                  </p>
                  {cpiFastVal != null && cpi3yAvgVal != null ? (
                    <>
                      <p className={`font-medium ${cpiFastVal > cpi3yAvgVal ? "text-loss" : "text-gain"}`}>
                        {cpiFastVal > cpi3yAvgVal ? "↑ Fast > slow" : "↓ Fast < slow"}
                      </p>
                      <p className="num text-[11px] text-paper-dim mt-0.5">{cpiFastVal.toFixed(2)}% vs {cpi3yAvgVal.toFixed(2)}%</p>
                      {vintageLabel(cpiFastInd) && (
                        <p className="text-[9px] text-paper-dim/50 mt-0.5">as of {vintageLabel(cpiFastInd)}</p>
                      )}
                    </>
                  ) : <p className="text-paper-dim text-[11px]">Pending refresh</p>}
                </div>
                <div
                  onClick={() => setInflExpDrawerOpen(true)}
                  className="px-3 py-3 border-l border-ink-line cursor-pointer hover:bg-ink/40 transition-colors group"
                >
                  <p className="text-[10px] text-paper-dim mb-1 flex items-center gap-1" title={`vs. the Fed's ${FED_INFLATION_TARGET}% target, not an arbitrary round number`}>
                    T10YIE vs Fed {FED_INFLATION_TARGET}% target
                    <ChartIcon />
                  </p>
                  {breakeven?.current_value != null ? (
                    <>
                      <p className={`font-medium ${breakevenVal > FED_INFLATION_TARGET ? "text-loss" : "text-gain"}`}>
                        {breakevenVal > FED_INFLATION_TARGET ? "↑ Pricing above target" : "↓ At/below target"}
                      </p>
                      <p className="num text-[11px] text-paper-dim mt-0.5">T10YIE {breakevenVal.toFixed(2)}% vs {FED_INFLATION_TARGET}%</p>
                    </>
                  ) : <p className="text-paper-dim text-[11px]">—</p>}
                </div>
              </div>

              {/* Regime row */}
              <div className="grid grid-cols-3 bg-ink-soft/30">
                <div className="px-3 py-3">
                  <p className="label text-[10px]">Regime Read</p>
                </div>
                <div className="px-3 py-3 border-l border-ink-line">
                  {structuralMeta ? (
                    <>
                      <p className={`font-semibold ${structuralMeta.color}`}>{structuralMeta.label}</p>
                      <p className="text-[11px] text-paper-dim mt-0.5">{structuralMeta.desc}</p>
                    </>
                  ) : <p className="text-paper-dim text-[11px]">—</p>}
                </div>
                <div className="px-3 py-3 border-l border-ink-line">
                  {marketMeta ? (
                    <>
                      <p className={`font-semibold ${marketMeta.color}`}>{marketMeta.label}</p>
                      <p className="text-[11px] text-paper-dim mt-0.5">{marketMeta.desc}</p>
                    </>
                  ) : <p className="text-paper-dim text-[11px]">—</p>}
                </div>
              </div>

            </div>

            {/* Agreement / divergence banner — the headline above already shows
                the full 3-way breakdown when Transitional, so this stays terse
                and doesn't repeat that detail. */}
            {structuralRegimeKey && marketRegimeKey && (
              <div className={`mt-3 rounded-lg px-3 py-2 text-xs flex items-center gap-2 ${
                isTransitional
                  ? "bg-loss/10 text-loss border border-loss/20"
                  : structuralRegimeKey === marketRegimeKey
                    ? "bg-gain/10 text-gain border border-gain/20"
                    : "bg-brass/10 text-brass-soft border border-brass/20"
              }`}>
                {isTransitional
                  ? "⚠ No 2-of-3 majority across Structural/Market/Forward — see \"Transitional\" read above"
                  : structuralRegimeKey === marketRegimeKey
                    ? "✓ Structural and Market lenses agree — regime signal is clear"
                    : `⚠ Structural/Market diverge — Forward Signal breaks the tie toward ${regime?.label ?? "n/a"}`
                }
              </div>
            )}
          </div>

          {/* Forward Signal */}
          <div>
            <p className="label mb-3">
              Forward Signal
              <span className="text-paper-dim font-normal ml-2 text-[10px] normal-case tracking-normal">6–18 month horizon</span>
            </p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              {[
                // dir uses the RAW pre-fallback direction (rawGDir/rawIDir),
                // not gDir/iDir — those already collapse "neutral" to a sign
                // for the regime-key computation, which made the "Flat /
                // Uncertain" branch below unreachable before this fix (see #8
                // in the regime-calc work order: a near-zero composite score
                // was labeled "Rising," inviting over-reading noise as signal).
                { title: "Growth Momentum", sigs: fwd.growth.signals, dir: fwd.rawGDir, score: fwd.growth.score, upLabel: "Expanding", downLabel: "Contracting" },
                { title: "Inflation Momentum", sigs: fwd.infl.signals, dir: fwd.rawIDir, score: fwd.infl.score, upLabel: "Rising", downLabel: "Falling" },
              ].map(({ title, sigs, dir, score, upLabel, downLabel }) => (
                <div key={title} className="bg-ink-soft rounded-lg p-3">
                  <p className="label text-[10px] mb-2">{title}</p>
                  <div className="space-y-1 mb-2">
                    {sigs.map(s => (
                      <div key={s.label} className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-paper-dim truncate">{s.label}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          <span className="num text-[9px] text-paper-dim/50">w{s.w.toFixed(2)}</span>
                          <span className={`text-[10px] font-medium ${s.vote > 0 ? "text-gain" : s.vote < 0 ? "text-loss" : "text-paper-dim"}`}>
                            {s.vote == null ? "—" : s.vote > 0 ? "↑" : s.vote < 0 ? "↓" : "→"}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="pt-2 border-t border-ink-line flex items-center justify-between">
                    <span className={`text-xs font-semibold ${dir === "up" ? "text-gain" : dir === "down" ? "text-loss" : "text-paper-dim"}`}>
                      {dir === "up" ? `↑ ${upLabel}` : dir === "down" ? `↓ ${downLabel}` : "→ Flat / Uncertain"}
                    </span>
                    <span className="num text-[10px] text-paper-dim">
                      score {score == null ? "—" : `${score >= 0 ? "+" : ""}${score.toFixed(2)}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {fwd.forwardKey ? (
              <div className="flex items-center gap-3 bg-ink-soft/50 rounded-lg px-4 py-3">
                <div>
                  <p className="text-[10px] text-paper-dim mb-0.5">Current</p>
                  <p className={`text-sm font-semibold ${regime?.color ?? "text-paper"}`}>{regime?.label ?? "—"}</p>
                </div>
                <svg className="w-6 h-4 text-paper-dim shrink-0" viewBox="0 0 24 16" fill="none">
                  <path d="M1 8h18M13 2l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div>
                  <p className="text-[10px] text-paper-dim mb-0.5">Forward Signal</p>
                  <p className={`text-sm font-semibold ${REGIME_META[fwd.forwardKey]?.color ?? "text-paper"}`}>
                    {REGIME_META[fwd.forwardKey]?.label}
                  </p>
                  <p className="text-[10px] text-paper-dim">{REGIME_META[fwd.forwardKey]?.desc}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="text-[10px] text-paper-dim mb-0.5">Signal strength</p>
                  <p className="num text-sm">{fwd.confidence}%</p>
                  <p className="text-[10px] text-paper-dim">
                    {fwd.confidence >= 60 ? "Strong" : fwd.confidence >= 30 ? "Moderate" : "Weak"}
                  </p>
                </div>
              </div>
            ) : (
              <div className="bg-ink-soft/50 rounded-lg px-4 py-3 text-xs text-paper-dim">
                Forward signal inconclusive — growth and inflation momentum point in the same or unclear direction.
              </div>
            )}
          </div>

          {/* Allocation bars */}
          <div>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
              <div className="flex items-center gap-3">
                <p className="label">Positioning Signal — Favored Categories</p>
                {blendedReturn !== null && (
                  <span className={`text-xs font-medium tabular-nums ${blendedReturn >= 0 ? "text-gain" : "text-loss"}`}>
                    {blendedReturn >= 0 ? "+" : ""}{blendedReturn.toFixed(1)}% exp. return
                  </span>
                )}
              </div>
              <div className="flex items-center gap-0.5">
                {[
                  { k: "default", l: "Default" },
                  { k: "equal",   l: "Equal Wt" },
                  { k: "naive",   l: "Naive RP" },
                  { k: "true",    l: "Regime RP" },
                  { k: "bw",      l: "BW Modified" },
                ].map((m) => (
                  <button
                    key={m.k}
                    onClick={() => setAllocMethod(m.k)}
                    disabled={m.k !== "default" && m.k !== "bw" && !assetData}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors disabled:opacity-30 ${
                      allocMethod === m.k
                        ? m.k === "bw"
                          ? "bg-amber-900/30 text-amber-400 border border-amber-700/40"
                          : "bg-brass/20 text-brass-soft border border-brass/40"
                        : "text-paper-dim hover:text-paper"
                    }`}
                  >
                    {m.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Regime transition callout */}
            {prevRegimeKey && regimeChangedAt && (
              <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-brass/10 border border-brass/20 text-xs">
                <span className="text-brass-soft shrink-0">⟳</span>
                <span className="text-paper-dim">
                  Shifted from{" "}
                  <span className={REGIME_META[prevRegimeKey]?.color ?? "text-paper"}>
                    {REGIME_META[prevRegimeKey]?.label}
                  </span>
                  {" → "}
                  <span className={regime?.color ?? "text-paper"}>{regime?.label}</span>
                  {" · allocation updated"}
                </span>
              </div>
            )}

            {/* Animated allocation bars */}
            <div className="space-y-2">
              {ALLOC_ASSET_META.map(({ key, label, color }) => {
                const allocPct = suggestedPcts[key] ?? 0;
                const prevPct  = prevSuggestedPcts?.[key] ?? 0;
                const portPct  = pct(byKey[key]?.total ?? 0);
                const portVal  = byKey[key]?.total ?? 0;
                const changed  = prevSuggestedPcts != null && allocPct !== prevPct;
                const portValFmt = portVal >= 1_000_000
                  ? `$${(portVal / 1_000_000).toFixed(1)}M`
                  : portVal >= 1_000
                    ? `$${Math.round(portVal / 1_000)}K`
                    : portVal > 0 ? `$${Math.round(portVal)}` : null;
                const markerLeft = Math.min(portPct, 96);
                return (
                  <div key={key} className="flex items-center gap-3">
                    <span className="text-[11px] text-paper-dim w-[104px] shrink-0 truncate">{label}</span>
                    {/* Bar track — outer div has no overflow-hidden so marker label can bleed */}
                    <div className="flex-1 relative h-4">
                      {/* Clipped colored bars */}
                      <div className="absolute inset-0 rounded overflow-hidden bg-ink-line/40">
                        {prevSuggestedPcts && prevPct > 0 && (
                          <div
                            className="absolute left-0 top-0 h-full rounded transition-[width] duration-700 ease-out"
                            style={{ width: `${prevPct}%`, background: color, opacity: 0.18 }}
                          />
                        )}
                        <div
                          className="absolute left-0 top-0 h-full rounded transition-[width] duration-500 ease-out"
                          style={{ width: `${allocPct}%`, background: color, opacity: allocPct > 0 ? 0.75 : 0 }}
                        />
                      </div>
                      {/* Portfolio marker + label (outside clip context) */}
                      {portPct > 0 && portValFmt && (
                        <div
                          className="absolute top-0 h-full flex items-center"
                          style={{ left: `${markerLeft}%` }}
                        >
                          <div className="w-px h-full bg-white/60" />
                          <span className="ml-1 text-[9px] num text-paper/70 whitespace-nowrap leading-none">
                            {portPct}% - {portValFmt}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 w-20 justify-end">
                      {changed && (
                        <span className={`text-[10px] num ${allocPct > prevPct ? "text-gain" : "text-loss"}`}>
                          {allocPct > prevPct ? "+" : ""}{allocPct - prevPct}%
                        </span>
                      )}
                      <span className={`num text-[11px] w-8 text-right ${allocPct === 0 ? "text-paper-dim/40" : "text-paper"}`}>
                        {allocPct > 0 ? `${allocPct}%` : "—"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 mt-3 text-[10px] text-paper-dim">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-8 h-2.5 rounded bg-brass/70" />
                Suggested
              </span>
              {prevSuggestedPcts && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-8 h-2.5 rounded bg-brass/20" />
                  Prior regime
                </span>
              )}
              {hasPortfolio && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-px h-3 bg-white/50" />
                  Your portfolio
                </span>
              )}
            </div>
          </div>

          {/* Outside-signal summary + alignment bar */}
          {hasPortfolio && grandTotal > 0 && (
            <div>
              <div className="flex justify-between text-[10px] text-paper-dim mb-1.5">
                <span>Signal aligned <span className="num text-gain">{alignedPct}%</span></span>
                {outsideBuckets.length > 0 && (
                  <span>
                    Outside signal <span className="num text-loss">{outsidePct}%</span>
                    {" · "}{outsideBuckets.map((b) => b.label).join(", ")}
                  </span>
                )}
              </div>
              <div className="h-1.5 rounded-full bg-ink-line overflow-hidden flex">
                <div className="h-full bg-gain/60 transition-all" style={{ width: `${alignedPct}%` }} />
                <div className="h-full bg-loss/50 transition-all" style={{ width: `${outsidePct}%` }} />
              </div>
            </div>
          )}

          {/* Portfolio Actions */}
          {hasPortfolio && regimeKey && grandTotal > 0 && (actionRows.length > 0 || buyRows.length > 0) && (
            <div>
              <button
                onClick={() => setActionsOpen((o) => !o)}
                className="flex items-center gap-2 w-full text-left"
              >
                <p className="label">Portfolio Actions</p>
                <svg
                  className={`w-3 h-3 text-paper-dim transition-transform ${actionsOpen ? "rotate-90" : ""}`}
                  viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  <polyline points="6,3 11,8 6,13" />
                </svg>
              </button>

              {actionsOpen && (
                <div className="mt-2 border border-ink-line rounded-lg overflow-hidden text-[11px]">
                  {/* Table header */}
                  <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-1.5 bg-ink-soft/50 border-b border-ink-line text-[10px] text-paper-dim">
                    <span>Holding</span>
                    <span className="text-right">Current</span>
                    <span className="text-right">Cur %</span>
                    <span>Action</span>
                    <span className="text-right">New %</span>
                  </div>

                  {/* Existing holding rows */}
                  {actionRows.map((r) => {
                    const delta = r.deltaVal;
                    const absD = Math.abs(delta);
                    const isNoop = absD < grandTotal * 0.005;
                    let actionLabel, actionClass;
                    if (r.isIlliquid && delta < 0) {
                      actionLabel = "Illiquid — hold";
                      actionClass = "text-paper-dim italic";
                    } else if (isNoop) {
                      actionLabel = "Hold";
                      actionClass = "text-paper-dim";
                    } else if (delta > 0) {
                      actionLabel = `Add $${absD < 1000 ? absD.toFixed(0) : (absD / 1000).toFixed(1) + "k"}`;
                      actionClass = "text-gain";
                    } else {
                      actionLabel = `Sell $${absD < 1000 ? absD.toFixed(0) : (absD / 1000).toFixed(1) + "k"}`;
                      actionClass = "text-loss";
                    }
                    return (
                      <div key={`${r.symbol}-${r.key}`} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-2 border-b border-ink-line/50 items-center">
                        <span className="font-medium text-paper truncate">{r.symbol}</span>
                        <span className="num text-paper-dim text-right">
                          {r.currentVal < 1000 ? `$${r.currentVal.toFixed(0)}` : `$${(r.currentVal / 1000).toFixed(1)}k`}
                        </span>
                        <span className="num text-paper-dim text-right">{r.currentPct.toFixed(1)}%</span>
                        <span className={`${actionClass} font-medium`}>{actionLabel}</span>
                        <span className={`num text-right ${isNoop || (r.isIlliquid && delta < 0) ? "text-paper-dim" : delta > 0 ? "text-gain" : "text-loss"}`}>
                          {(r.isIlliquid && delta < 0 ? r.currentPct : r.newPct).toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}

                  {/* Divider + Recommendations header */}
                  {buyRows.length > 0 && (
                    <>
                      <div className="px-3 py-1.5 bg-ink-soft/30 border-b border-ink-line text-[10px] text-paper-dim font-medium">
                        Recommendations — no current holding
                      </div>
                      {buyRows.map((r) => {
                        const funds = SUGGESTED_FUNDS[r.key] ?? [];
                        return (
                          <div key={r.key} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-2 border-b border-ink-line/50 items-start">
                            <div>
                              <span className="font-medium text-paper">{r.label}</span>
                              {funds.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {funds.map((f) => (
                                    <span key={f} className="px-1.5 py-0.5 rounded bg-ink-line text-[9px] text-paper-dim font-mono">{f}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <span className="num text-paper-dim text-right">$0</span>
                            <span className="num text-paper-dim text-right">0.0%</span>
                            <span className="text-gain font-medium">
                              Buy ${r.targetVal < 1000 ? r.targetVal.toFixed(0) : (r.targetVal / 1000).toFixed(1) + "k"}
                            </span>
                            <span className="num text-gain text-right">{r.targetPct.toFixed(1)}%</span>
                          </div>
                        );
                      })}
                    </>
                  )}

                  {/* Totals row */}
                  <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-2 bg-ink-soft/50 text-[10px] font-medium">
                    <span className="text-paper-dim">Total</span>
                    <span className="num text-right">
                      {grandTotal < 1000 ? `$${grandTotal.toFixed(0)}` : `$${(grandTotal / 1000).toFixed(1)}k`}
                    </span>
                    <span className="num text-right">100%</span>
                    <span />
                    <span className="num text-right">100%</span>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      ) : (
        <p className="text-paper-dim text-sm">
          {indicators.length === 0
            ? "No data yet — run the first data refresh."
            : "Regime unclear — run Refresh Data to populate GDP and CPI."}
        </p>
      )}

      <TwoLineHistoryDrawer
        open={gdpDrawerOpen}
        onClose={() => setGdpDrawerOpen(false)}
        title="Real GDP Growth — Fast vs Slow"
        subtitle="2-quarter avg (fast) vs 4-quarter avg (slow) · quarterly YoY, FRED GDPC1"
        fetchUrl={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-gdp-crossover-history`}
        series={[
          { key: "fast", label: "2Q Avg (fast)", shortLabel: "2Q", color: "#C9A227" },
          { key: "slow", label: "4Q Avg (slow)", shortLabel: "4Q", color: "#A8ADB8", dash: "5 3" },
        ]}
        regimeStats={gdpRegimeStats}
        zscoreLabel="vs. 10yr (40Q) window"
        consensusVar="RGDP"
        consensusLabel="Real GDP"
      />
      <TwoLineHistoryDrawer
        open={cpiCrossoverDrawerOpen}
        onClose={() => setCpiCrossoverDrawerOpen(false)}
        title="CPI Inflation — Fast vs Slow"
        subtitle="3-month avg (fast) vs 9-month avg (slow) · monthly YoY, FRED CPIAUCSL"
        fetchUrl={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-cpi-crossover-history`}
        series={[
          { key: "fast", label: "3M Avg (fast)", shortLabel: "3M", color: "#E0635C" },
          { key: "slow", label: "9M Avg (slow)", shortLabel: "9M", color: "#A8ADB8", dash: "5 3" },
        ]}
        regimeStats={cpiRegimeStats}
        zscoreLabel="Core CPI vs. 18yr window"
        consensusVar="CORECPI"
        consensusLabel="Core CPI"
      />
      <TwoLineHistoryDrawer
        open={inflExpDrawerOpen}
        onClose={() => setInflExpDrawerOpen(false)}
        title="Realized CPI vs Market-Priced Inflation"
        subtitle="Headline CPI YoY vs 10Y breakeven (T10YIE) · monthly, FRED"
        fetchUrl={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-inflation-expectations-history`}
        series={[
          { key: "cpiYoy", label: "CPI YoY (realized)", shortLabel: "CPI", color: "#E0635C" },
          { key: "breakeven", label: "10Y Breakeven (market)", shortLabel: "T10YIE", color: "#3FB984", dash: "5 3" },
        ]}
      />
    </div>
  );
}

const DEBT_RANGES = [
  { label: "All", from: 1952 },
  { label: "2000–", from: 2000 },
  { label: "2010–", from: 2010 },
];

const CPI_PRESETS = [
  { label: "All",   from: "1958-01", to: "" },
  { label: "1990–", from: "1990-01", to: "" },
  { label: "2000–", from: "2000-01", to: "" },
  { label: "2010–", from: "2010-01", to: "" },
];

const PPI_PRESETS = [
  { label: "All",   from: "1947-01", to: "" },
  { label: "1990–", from: "1990-01", to: "" },
  { label: "2000–", from: "2000-01", to: "" },
  { label: "2010–", from: "2010-01", to: "" },
];

const EXP_RANGES = [
  { label: "All",   from: "1978-01-01" },
  { label: "2000–", from: "2000-01-01" },
  { label: "2013–", from: "2013-01-01" },
  { label: "2020–", from: "2020-01-01" },
];

function CloseIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <line x1="3" y1="3" x2="13" y2="13" />
      <line x1="13" y1="3" x2="3" y2="13" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg className="w-2.5 h-2.5 text-paper-dim/40 group-hover:text-brass-soft transition-colors shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 13V9M6 13V6M10 13V3M14 13V8" />
    </svg>
  );
}

const CROSSOVER_PRESETS = [
  { label: "All",   from: "1948-01", to: "" },
  { label: "1990–", from: "1990-01", to: "" },
  { label: "2000–", from: "2000-01", to: "" },
  { label: "2010–", from: "2010-01", to: "" },
];

// Reusable side-drawer chart for any "two tracked lines over time" cell —
// backs the Regime Signal Comparison table's clickable Growth/Inflation cells
// (fast vs slow crossover lines, or realized vs market-priced inflation).
function TwoLineHistoryDrawer({
  open, onClose, title, subtitle, fetchUrl, series, unit = "%",
  regimeStats, zscoreLabel, consensusVar, consensusLabel,
}) {
  const [rows, setRows] = useState(null);
  const [fromDate, setFromDate] = useState("2000-01");
  const [toDate, setToDate] = useState("");
  // GDP & Inflation Regime Metrics spec, G4/I4 "Forward Consensus" — SPF
  // median forecast, fetched lazily on open (like the chart rows) rather
  // than up front, since it's only needed when this drawer is actually
  // viewed. horizon_quarters=1 is the SPF's own "current quarter" read;
  // 2-5 averaged is the closest match to the spec's "next 4 quarters".
  const [consensus, setConsensus] = useState(null);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    fetch(fetchUrl)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [open, fetchUrl]);

  useEffect(() => {
    if (!open || !consensusVar) return;
    setConsensus(null);
    supabase
      .from("spf_forecasts")
      .select("vintage_label, horizon_quarters, value")
      .eq("variable_code", consensusVar)
      .order("vintage_label", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (!data || !data.length) { setConsensus(false); return; }
        const latestVintage = data[0].vintage_label;
        const latest = data.filter((r) => r.vintage_label === latestVintage);
        const h1 = latest.find((r) => r.horizon_quarters === 1)?.value ?? null;
        const next4 = latest.filter((r) => r.horizon_quarters >= 2 && r.horizon_quarters <= 5).map((r) => Number(r.value));
        setConsensus({
          vintage: latestVintage,
          currentQuarter: h1 != null ? Number(h1) : null,
          next4qAvg: next4.length ? Math.round((next4.reduce((a, b) => a + b, 0) / next4.length) * 100) / 100 : null,
        });
      })
      .catch(() => setConsensus(false));
  }, [open, consensusVar]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    const from = fromDate ? `${fromDate}-01` : "1900-01-01";
    const to   = toDate   ? `${toDate}-01`   : "9999-12-01";
    return rows.filter((r) => r.date >= from && r.date <= to);
  }, [rows, fromDate, toDate]);

  const xTicks = useMemo(() => {
    const total = chartData.length;
    const stepYears = total > 300 ? 10 : total > 150 ? 5 : total > 60 ? 2 : 1;
    return chartData
      .filter((r) => {
        const yr = parseInt(r.date.slice(0, 4));
        return r.date.slice(5, 7) === "01" && yr % stepYears === 0;
      })
      .map((r) => r.date);
  }, [chartData]);

  const [minVal, maxVal] = useMemo(() => {
    if (!chartData.length) return [0, 10];
    const allVals = chartData.flatMap((r) => series.map((s) => r[s.key]).filter((v) => v != null));
    if (!allVals.length) return [0, 10];
    return [Math.floor(Math.min(...allVals, 0)), Math.ceil(Math.max(...allVals)) + 1];
  }, [chartData, series]);

  const latest = rows && rows.length ? rows[rows.length - 1] : null;
  const summaryRows = useMemo(() => (rows?.length ? rows.slice(-8).reverse() : []), [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[520px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">{title}</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">{subtitle}</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {latest && (
              <div className="text-right space-y-0.5">
                {series.map((s) => (
                  <p key={s.key} className="num text-sm font-bold leading-tight" style={{ color: s.color }}>
                    {latest[s.key] != null ? `${latest[s.key].toFixed(2)}${unit}` : "—"}
                    <span className="text-[9px] text-paper-dim font-normal ml-1">{s.shortLabel ?? s.label}</span>
                  </p>
                ))}
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-6">From</label>
                <input
                  type="month"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark]"
                />
              </div>
              <span className="text-paper-dim text-xs shrink-0">→</span>
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-4">To</label>
                <input
                  type="month"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark] placeholder:text-paper-dim/50"
                />
              </div>
              {toDate && (
                <button
                  onClick={() => setToDate("")}
                  className="text-paper-dim hover:text-paper text-[10px] shrink-0"
                  title="Clear end date"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              {CROSSOVER_PRESETS.map((p) => {
                const isActive = fromDate === p.from && toDate === p.to;
                return (
                  <button
                    key={p.label}
                    onClick={() => { setFromDate(p.from); setToDate(p.to); }}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                      isActive
                        ? "bg-ink text-brass-soft border border-brass/30"
                        : "text-paper-dim hover:text-paper"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {regimeStats && (
            <div className="card p-4 space-y-3">
              <p className="label text-[10px]">Regime Metrics</p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-paper-dim text-[10px] uppercase tracking-wide mb-0.5">Level {zscoreLabel ? `(${zscoreLabel})` : ""}</p>
                  {regimeStats.zscore != null ? (
                    <>
                      <p className="num font-semibold text-paper">{regimeStats.zscore >= 0 ? "+" : ""}{regimeStats.zscore.toFixed(2)}σ</p>
                      <p className="text-paper-dim text-[10px]">
                        mean {regimeStats.windowMean?.toFixed(1)}% · range {regimeStats.windowMin?.toFixed(1)}–{regimeStats.windowMax?.toFixed(1)}%
                      </p>
                    </>
                  ) : <p className="text-paper-dim">—</p>}
                </div>
                <div>
                  <p className="text-paper-dim text-[10px] uppercase tracking-wide mb-0.5">Rate of Change</p>
                  <p className={`font-semibold ${regimeStats.rateLabel === "Accelerating" ? "text-gain" : regimeStats.rateLabel === "Decelerating" ? "text-loss" : "text-paper-dim"}`}>
                    {regimeStats.rateLabel === "Accelerating" ? "Increasing" : regimeStats.rateLabel === "Decelerating" ? "Decreasing" : regimeStats.rateLabel ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-paper-dim text-[10px] uppercase tracking-wide mb-0.5">Direction</p>
                  <p className={`font-semibold ${regimeStats.direction > 0 ? "text-gain" : regimeStats.direction < 0 ? "text-loss" : "text-paper-dim"}`}>
                    {regimeStats.direction == null ? "—" : regimeStats.direction > 0 ? "↑ Up" : regimeStats.direction < 0 ? "↓ Down" : "→ Flat"}
                  </p>
                </div>
                <div>
                  <p className="text-paper-dim text-[10px] uppercase tracking-wide mb-0.5">Forward Consensus (SPF)</p>
                  {consensus === null ? (
                    <p className="text-paper-dim">Loading…</p>
                  ) : consensus === false || (consensus.currentQuarter == null && consensus.next4qAvg == null) || regimeStats.currentValue == null ? (
                    <p className="text-paper-dim">—</p>
                  ) : (() => {
                    // Compare the actual current reading against the nearest
                    // available SPF forecast — "this qtr" (horizon 1) when
                    // present, else the "next 4Q" average (RGDP's file has no
                    // horizon-1 row, see update-spf-forecasts, so GDP always
                    // falls back to next4qAvg here).
                    const consensusVal = consensus.currentQuarter ?? consensus.next4qAvg;
                    const delta = regimeStats.currentValue - consensusVal;
                    const dir = Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "above" : "below";
                    return (
                      <>
                        <p className={`font-semibold ${dir === "above" ? "text-gain" : dir === "below" ? "text-loss" : "text-paper-dim"}`}>
                          {dir === "above" ? "↑ Above Consensus" : dir === "below" ? "↓ Below Consensus" : "→ In Line"}
                        </p>
                        <p className="text-paper-dim text-[10px]">
                          {regimeStats.currentValue.toFixed(1)}% actual vs {consensusVal.toFixed(1)}% {consensusLabel} · SPF {consensus.vintage}
                        </p>
                      </>
                    );
                  })()}
                </div>
              </div>
              {(regimeStats.umich1yr != null || regimeStats.nyfed1yr != null) && (
                <div className="pt-2 border-t border-ink-line/50">
                  <p className="text-paper-dim text-[10px] uppercase tracking-wide mb-1">Consumer Inflation Expectations (1yr, attributed)</p>
                  <div className="flex gap-4 text-xs">
                    <p className="text-paper">
                      {regimeStats.umich1yr != null ? `${regimeStats.umich1yr.toFixed(1)}%` : "—"}
                      <span className="text-[9px] text-paper-dim ml-1">UMich</span>
                    </p>
                    <p className="text-paper">
                      {regimeStats.nyfed1yr != null ? `${regimeStats.nyfed1yr.toFixed(1)}%` : "—"}
                      <span className="text-[9px] text-paper-dim ml-1">NY Fed SCE</span>
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">{unit} · monthly</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    type="category"
                    ticks={xTicks}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 4)}
                    interval={0}
                  />
                  <YAxis
                    domain={[minVal, maxVal]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}${unit}`}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A1F29", border: "1px solid #2A3240", borderRadius: 6, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={(value, name) => [`${Number(value).toFixed(2)}${unit}`, name]}
                  />
                  {series.map((s, i) => (
                    <Line
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      name={s.label}
                      stroke={s.color}
                      strokeWidth={i === 0 ? 2 : 1.5}
                      strokeDasharray={s.dash}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>

              <div className="flex items-center justify-center gap-5 mt-3 text-[10px] text-paper-dim">
                {series.map((s) => (
                  <span key={s.key} className="flex items-center gap-1.5">
                    {s.dash ? (
                      <svg width="20" height="4" className="overflow-visible">
                        <line x1="0" y1="2" x2="20" y2="2" stroke={s.color} strokeWidth="1.5" strokeDasharray={s.dash} />
                      </svg>
                    ) : (
                      <span className="inline-block w-5 h-[2px] rounded" style={{ backgroundColor: s.color }} />
                    )}
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {rows !== null && summaryRows.length > 0 && (
            <div>
              <p className="label text-[10px] mb-2">Recent readings</p>
              <div className="border border-ink-line rounded-lg overflow-hidden text-xs">
                <div
                  className="grid gap-px bg-ink-line"
                  style={{ gridTemplateColumns: `1fr repeat(${series.length}, 1fr)` }}
                >
                  <div className="bg-ink-soft px-2 py-1.5 text-[10px] text-paper-dim">Date</div>
                  {series.map((s) => (
                    <div key={s.key} className="bg-ink-soft px-2 py-1.5 text-[10px] text-paper-dim text-right">
                      {s.shortLabel ?? s.label}
                    </div>
                  ))}
                  {summaryRows.map((r) => (
                    <Fragment key={r.date}>
                      <div className="bg-ink px-2 py-1.5 text-paper-dim">
                        {new Date(r.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}
                      </div>
                      {series.map((s) => (
                        <div key={s.key} className="bg-ink px-2 py-1.5 text-right num" style={{ color: s.color }}>
                          {r[s.key] != null ? `${r[s.key].toFixed(2)}${unit}` : "—"}
                        </div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function DebtTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const isChange = p.dataKey === "change";
        const formatted = isChange
          ? `${p.value >= 0 ? "+" : ""}${Number(p.value).toFixed(1)} pp`
          : `${Number(p.value).toFixed(1)}%`;
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
            <span className="num text-paper">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

function CpiTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-paper mb-1">{label?.slice(0, 7)}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const isAccel = p.dataKey === "coreAccel";
        const formatted = isAccel
          ? `${p.value >= 0 ? "+" : ""}${Number(p.value).toFixed(2)} pp`
          : `${Number(p.value).toFixed(2)}%`;
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
            <span className="num text-paper">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

function PpiTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[170px]">
      <p className="font-semibold text-paper mb-1">{label?.slice(0, 7)}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const isAccel = p.dataKey === "ppiAccel";
        const formatted = isAccel
          ? `${p.value >= 0 ? "+" : ""}${Number(p.value).toFixed(2)} pp`
          : `${Number(p.value).toFixed(2)}%`;
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
            <span className="num text-paper">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

function ExpTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[190px]">
      <p className="font-semibold text-paper mb-1">{label?.slice(0, 7)}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const isZ = p.dataKey === "compositeZ";
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.color }}>{p.name}</span>
            <span className="num text-paper">
              {isZ
                ? `${p.value >= 0 ? "+" : ""}${Number(p.value).toFixed(2)}σ`
                : `${Number(p.value).toFixed(2)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DebtGdpDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState(1952);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("macro_debt_cycle_computed")
      .select("year,debt_to_gdp_pct")
      .order("year")
      .then(({ data }) => setRows(data ?? []));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    const byYear = Object.fromEntries(rows.map((r) => [r.year, Number(r.debt_to_gdp_pct)]));
    return rows
      .filter((r) => r.year >= range && r.debt_to_gdp_pct != null)
      .map((r) => {
        const prev = byYear[r.year - 1];
        return {
          year: r.year,
          value: Number(r.debt_to_gdp_pct),
          change: prev != null ? Number(r.debt_to_gdp_pct) - prev : null,
        };
      });
  }, [rows, range]);

  const minVal = useMemo(() => chartData.length ? Math.floor(Math.min(...chartData.map((r) => r.value)) / 10) * 10 : 0, [chartData]);
  const maxVal = useMemo(() => chartData.length ? Math.ceil(Math.max(...chartData.map((r) => r.value)) / 10) * 10 : 400, [chartData]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[520px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">Total Debt / GDP</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Total nonfinancial debt as % of nominal GDP · Annual (FRED Z.1)</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className="num text-xl font-bold text-brass-soft leading-none">{formatValue(currentValue, "%")}</p>
                <p className="text-[10px] text-paper-dim mt-0.5">Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Range selector */}
          <div className="flex items-center gap-1">
            {DEBT_RANGES.map((r) => (
              <button
                key={r.from}
                onClick={() => setRange(r.from)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.from
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Chart */}
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Debt / GDP % · {range}–present</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="year"
                    type="number"
                    domain={[range, "dataMax"]}
                    allowDecimals={false}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => String(v)}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="left"
                    domain={[minVal, maxVal]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={44}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}pp`}
                    width={44}
                  />
                  <Tooltip content={<DebtTooltip />} />
                  <ReferenceLine yAxisId="left" y={300} stroke="#2A3240" strokeDasharray="4 2" strokeWidth={1} />
                  <ReferenceLine yAxisId="right" y={0} stroke="#2A3240" strokeWidth={1} />
                  <Bar yAxisId="right" dataKey="change" name="YoY Change" maxBarSize={12}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={entry.change == null ? "transparent" : entry.change >= 0 ? "#E0635C" : "#3FB984"}
                        fillOpacity={0.65}
                      />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="value"
                    name="Debt/GDP"
                    stroke="#C9A227"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Key levels legend */}
          <div className="card p-4 space-y-2">
            <p className="label text-[10px] mb-2">Context</p>
            {[
              { pct: "~160%", label: "Pre-GFC peak (2008)" },
              { pct: "~250%", label: "Post-COVID range (2020–)" },
              { pct: "300%", label: "Reference threshold" },
            ].map(({ pct, label }) => (
              <div key={label} className="flex items-center justify-between text-xs">
                <span className="text-paper-dim">{label}</span>
                <span className="num text-paper">{pct}</span>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: Federal Reserve Z.1 Financial Accounts · <span className="font-mono">macro_debt_cycle_computed</span>
          </p>
        </div>
      </div>
    </>
  );
}

function CoreCpiDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [fromDate, setFromDate] = useState("2000-01");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    if (!open || rows !== null) return;
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-cpi-history`)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    const from = fromDate ? `${fromDate}-01` : "1958-01-01";
    const to   = toDate   ? `${toDate}-01`   : "9999-12-01";
    return rows.filter((r) => r.date >= from && r.date <= to && r.coreYoy != null);
  }, [rows, fromDate, toDate]);

  const xTicks = useMemo(() => {
    const total = chartData.length;
    const stepYears = total > 300 ? 10 : total > 150 ? 5 : total > 60 ? 2 : 1;
    return chartData
      .filter((r) => {
        const yr = parseInt(r.date.slice(0, 4));
        return r.date.slice(5, 7) === "01" && yr % stepYears === 0;
      })
      .map((r) => r.date);
  }, [chartData]);

  const [minVal, maxVal] = useMemo(() => {
    if (!chartData.length) return [0, 10];
    const allYoy = chartData.flatMap((r) => [r.coreYoy, r.headlineYoy ?? r.coreYoy]);
    return [
      Math.min(0, Math.floor(Math.min(...allYoy))),
      Math.ceil(Math.max(...allYoy)) + 1,
    ];
  }, [chartData]);

  const summaryRows = useMemo(() => {
    if (!rows?.length) return [];
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const latest = rows[rows.length - 1];
    const result = [];

    if (latest.date.slice(5, 7) !== "12") {
      const mo = parseInt(latest.date.slice(5, 7)) - 1;
      const yr = latest.date.slice(0, 4);
      result.push({ label: `${MONTHS[mo]} ${yr}`, ...latest, isLatest: true });
    }

    const seen = new Set();
    for (let i = rows.length - 1; i >= 0 && seen.size < 5; i--) {
      const r = rows[i];
      if (r.date.slice(5, 7) === "12") {
        const yr = r.date.slice(0, 4);
        if (!seen.has(yr)) {
          seen.add(yr);
          result.push({ label: `Dec ${yr}`, ...r });
        }
      }
    }

    return result;
  }, [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[520px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">CPI History</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Core &amp; Headline · Monthly (FRED CPILFESL / CPIAUCSL)</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(currentValue) > 3 ? "text-loss" : Number(currentValue) < 2 ? "text-gain" : "text-brass-soft"}`}>
                  {formatValue(currentValue, "%")}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Core · Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="space-y-2">
            {/* Date range inputs */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-6">From</label>
                <input
                  type="month"
                  value={fromDate}
                  min="1958-01"
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark]"
                />
              </div>
              <span className="text-paper-dim text-xs shrink-0">→</span>
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-4">To</label>
                <input
                  type="month"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark] placeholder:text-paper-dim/50"
                />
              </div>
              {toDate && (
                <button
                  onClick={() => setToDate("")}
                  className="text-paper-dim hover:text-paper text-[10px] shrink-0"
                  title="Clear end date"
                >
                  ✕
                </button>
              )}
            </div>
            {/* Quick presets */}
            <div className="flex items-center gap-1">
              {CPI_PRESETS.map((p) => {
                const isActive = fromDate === p.from && toDate === p.to;
                return (
                  <button
                    key={p.label}
                    onClick={() => { setFromDate(p.from); setToDate(p.to); }}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                      isActive
                        ? "bg-ink text-brass-soft border border-brass/30"
                        : "text-paper-dim hover:text-paper"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">YoY % · monthly</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    type="category"
                    ticks={xTicks}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 4)}
                    interval={0}
                  />
                  <YAxis
                    yAxisId="left"
                    domain={[minVal, maxVal]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={36}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}`}
                    width={40}
                  />
                  <Tooltip content={<CpiTooltip />} />
                  <ReferenceLine yAxisId="left" y={2} stroke="#C9A227" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <ReferenceLine yAxisId="right" y={0} stroke="#2A3240" strokeWidth={1} />
                  <Bar yAxisId="right" dataKey="coreAccel" name="Core Accel." maxBarSize={6}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={(entry.coreAccel ?? 0) >= 0 ? "#E0635C" : "#3FB984"}
                        fillOpacity={0.55}
                      />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="headlineYoy"
                    name="Headline CPI"
                    stroke="#A8ADB8"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="coreYoy"
                    name="Core CPI"
                    stroke="#C9A227"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>

              {/* Legend */}
              <div className="flex items-center justify-center gap-5 mt-3 text-[10px] text-paper-dim">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[2px] bg-[#C9A227] rounded" />
                  Core CPI
                </span>
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="4" className="overflow-visible">
                    <line x1="0" y1="2" x2="20" y2="2" stroke="#A8ADB8" strokeWidth="1.5" strokeDasharray="5 3" />
                  </svg>
                  Headline CPI
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-flex gap-0.5">
                    <span className="inline-block w-2 h-3 rounded-sm" style={{ backgroundColor: "#E0635C", opacity: 0.55 }} />
                    <span className="inline-block w-2 h-3 rounded-sm" style={{ backgroundColor: "#3FB984", opacity: 0.55 }} />
                  </span>
                  Core Accel.
                </span>
              </div>
            </div>
          )}

          {/* 5-year summary table */}
          {summaryRows.length > 0 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Year-End Summary · last 5 years</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-paper-dim text-[10px]">
                    <th className="text-left pb-2 font-medium">Period</th>
                    <th className="text-right pb-2 font-medium">Core CPI</th>
                    <th className="text-right pb-2 font-medium">Headline CPI</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((r) => (
                    <tr key={r.label} className={`border-t border-ink-line/50 ${r.isLatest ? "text-paper" : "text-paper-dim"}`}>
                      <td className="py-1.5">
                        {r.label}
                        {r.isLatest && (
                          <span className="ml-1.5 text-[9px] text-brass-soft border border-brass/30 rounded px-1 py-0.5">Latest</span>
                        )}
                      </td>
                      <td className={`py-1.5 text-right num ${Number(r.coreYoy) > 3 ? "text-loss" : Number(r.coreYoy) < 2 ? "text-gain" : "text-brass-soft"}`}>
                        {r.coreYoy != null ? `${Number(r.coreYoy).toFixed(2)}%` : "—"}
                      </td>
                      <td className={`py-1.5 text-right num ${r.headlineYoy != null ? (Number(r.headlineYoy) > 3 ? "text-loss" : Number(r.headlineYoy) < 2 ? "text-gain" : "text-brass-soft") : "text-paper-dim"}`}>
                        {r.headlineYoy != null ? `${Number(r.headlineYoy).toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: BLS · FRED <span className="font-mono">CPILFESL</span> / <span className="font-mono">CPIAUCSL</span>
          </p>
        </div>
      </div>
    </>
  );
}

function PpiDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [fromDate, setFromDate] = useState("2000-01");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    if (!open || rows !== null) return;
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-ppi-history`)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    const from = fromDate ? `${fromDate}-01` : "1947-01-01";
    const to   = toDate   ? `${toDate}-01`   : "9999-12-01";
    return rows.filter((r) => r.date >= from && r.date <= to && r.ppiYoy != null);
  }, [rows, fromDate, toDate]);

  const xTicks = useMemo(() => {
    const total = chartData.length;
    const stepYears = total > 400 ? 10 : total > 200 ? 5 : total > 80 ? 2 : 1;
    return chartData
      .filter((r) => {
        const yr = parseInt(r.date.slice(0, 4));
        return r.date.slice(5, 7) === "01" && yr % stepYears === 0;
      })
      .map((r) => r.date);
  }, [chartData]);

  const [minVal, maxVal] = useMemo(() => {
    if (!chartData.length) return [-5, 20];
    const vals = chartData.map((r) => r.ppiYoy);
    return [
      Math.min(0, Math.floor(Math.min(...vals)) - 1),
      Math.ceil(Math.max(...vals)) + 1,
    ];
  }, [chartData]);

  const summaryRows = useMemo(() => {
    if (!rows?.length) return [];
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const latest = rows[rows.length - 1];
    const result = [];

    if (latest.date.slice(5, 7) !== "12") {
      const mo = parseInt(latest.date.slice(5, 7)) - 1;
      const yr = latest.date.slice(0, 4);
      result.push({ label: `${MONTHS[mo]} ${yr}`, ...latest, isLatest: true });
    }

    const seen = new Set();
    for (let i = rows.length - 1; i >= 0 && seen.size < 5; i--) {
      const r = rows[i];
      if (r.date.slice(5, 7) === "12") {
        const yr = r.date.slice(0, 4);
        if (!seen.has(yr)) {
          seen.add(yr);
          result.push({ label: `Dec ${yr}`, ...r });
        }
      }
    }
    return result;
  }, [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[520px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">PPI History</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">All Commodities · Monthly (FRED PPIACO)</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(currentValue) > 3 ? "text-loss" : Number(currentValue) < 0 ? "text-gain" : "text-brass-soft"}`}>
                  {formatValue(currentValue, "%")}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">YoY · Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-6">From</label>
                <input
                  type="month"
                  value={fromDate}
                  min="1947-01"
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark]"
                />
              </div>
              <span className="text-paper-dim text-xs shrink-0">→</span>
              <div className="flex items-center gap-1.5 flex-1">
                <label className="text-[10px] text-paper-dim shrink-0 w-4">To</label>
                <input
                  type="month"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="flex-1 bg-ink border border-ink-line rounded px-2 py-1 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark]"
                />
              </div>
              {toDate && (
                <button
                  onClick={() => setToDate("")}
                  className="text-paper-dim hover:text-paper text-[10px] shrink-0"
                  title="Clear end date"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              {PPI_PRESETS.map((p) => {
                const isActive = fromDate === p.from && toDate === p.to;
                return (
                  <button
                    key={p.label}
                    onClick={() => { setFromDate(p.from); setToDate(p.to); }}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                      isActive
                        ? "bg-ink text-brass-soft border border-brass/30"
                        : "text-paper-dim hover:text-paper"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">YoY % · monthly</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    type="category"
                    ticks={xTicks}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 4)}
                    interval={0}
                  />
                  <YAxis
                    yAxisId="left"
                    domain={[minVal, maxVal]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={36}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}`}
                    width={40}
                  />
                  <Tooltip content={<PpiTooltip />} />
                  <ReferenceLine yAxisId="left" y={0} stroke="#2A3240" strokeWidth={1} />
                  <ReferenceLine yAxisId="left" y={3} stroke="#C9A227" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <Bar yAxisId="right" dataKey="ppiAccel" name="Acceleration" maxBarSize={6}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={(entry.ppiAccel ?? 0) >= 0 ? "#E0635C" : "#3FB984"}
                        fillOpacity={0.55}
                      />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="ppiYoy"
                    name="PPI YoY"
                    stroke="#C9A227"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>

              <div className="flex items-center justify-center gap-5 mt-3 text-[10px] text-paper-dim">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[2px] bg-[#C9A227] rounded" />
                  PPI YoY
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-flex gap-0.5">
                    <span className="inline-block w-2 h-3 rounded-sm" style={{ backgroundColor: "#E0635C", opacity: 0.55 }} />
                    <span className="inline-block w-2 h-3 rounded-sm" style={{ backgroundColor: "#3FB984", opacity: 0.55 }} />
                  </span>
                  MoM Accel.
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[1px] bg-[#C9A227] opacity-50" style={{ borderTop: "1px dashed #C9A227" }} />
                  3% threshold
                </span>
              </div>
            </div>
          )}

          {summaryRows.length > 0 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Year-End Summary · last 5 years</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-paper-dim text-[10px]">
                    <th className="text-left pb-2 font-medium">Period</th>
                    <th className="text-right pb-2 font-medium">PPI YoY</th>
                    <th className="text-right pb-2 font-medium">MoM Accel.</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((r) => (
                    <tr key={r.label} className={`border-t border-ink-line/50 ${r.isLatest ? "text-paper" : "text-paper-dim"}`}>
                      <td className="py-1.5">
                        {r.label}
                        {r.isLatest && (
                          <span className="ml-1.5 text-[9px] text-brass-soft border border-brass/30 rounded px-1 py-0.5">Latest</span>
                        )}
                      </td>
                      <td className={`py-1.5 text-right num ${Number(r.ppiYoy) > 3 ? "text-loss" : Number(r.ppiYoy) < 0 ? "text-gain" : "text-brass-soft"}`}>
                        {r.ppiYoy != null ? `${Number(r.ppiYoy).toFixed(2)}%` : "—"}
                      </td>
                      <td className={`py-1.5 text-right num ${r.ppiAccel != null ? (Number(r.ppiAccel) > 0 ? "text-loss" : "text-gain") : "text-paper-dim"}`}>
                        {r.ppiAccel != null ? `${Number(r.ppiAccel) >= 0 ? "+" : ""}${Number(r.ppiAccel).toFixed(2)} pp` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: BLS · FRED <span className="font-mono">PPIACO</span> (All Commodities, not seasonally adjusted)
          </p>
        </div>
      </div>
    </>
  );
}

function ConsumerExpectationsDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState("2013-01-01");

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("consumer_expectations")
      .select("survey_date, michigan_inf_exp_1yr, nyfed_inf_exp_1yr, nyfed_delinquency_prob, composite_stress_z")
      .order("survey_date")
      .then(({ data }) => setRows(data ?? []));
  }, [open, rows]);

  const stats = useMemo(() => {
    if (!rows?.length) return null;
    const mn = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const sd = (arr, mu) => Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1)) || 1;
    const michVals    = rows.filter(r => r.michigan_inf_exp_1yr != null && r.survey_date >= "2013-01-01").map(r => Number(r.michigan_inf_exp_1yr));
    const nyfedInfVals = rows.filter(r => r.nyfed_inf_exp_1yr     != null).map(r => Number(r.nyfed_inf_exp_1yr));
    const nyfedDVals  = rows.filter(r => r.nyfed_delinquency_prob != null).map(r => Number(r.nyfed_delinquency_prob));
    if (!michVals.length) return null;
    const muM  = mn(michVals);  const sdM  = sd(michVals, muM);
    const muNI = nyfedInfVals.length ? mn(nyfedInfVals) : 0;
    const sdNI = nyfedInfVals.length ? sd(nyfedInfVals, muNI) : 1;
    const muND = nyfedDVals.length  ? mn(nyfedDVals)   : 0;
    const sdND = nyfedDVals.length  ? sd(nyfedDVals, muND)   : 1;
    return { muM, sdM, muNI, sdNI, muND, sdND };
  }, [rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter(r => r.survey_date >= range)
      .map(r => ({
        date:       r.survey_date,
        michInf:    r.michigan_inf_exp_1yr != null ? Number(r.michigan_inf_exp_1yr) : null,
        nyfedInf:   r.nyfed_inf_exp_1yr    != null ? Number(r.nyfed_inf_exp_1yr)   : null,
        compositeZ: r.composite_stress_z   != null ? Number(r.composite_stress_z)  : null,
      }));
  }, [rows, range]);

  const xTicks = useMemo(() =>
    chartData.filter(r => r.date.slice(5, 7) === "01").map(r => r.date),
  [chartData]);

  const tableRows = useMemo(() => {
    if (!rows || !stats) return [];
    const r2 = (n) => Math.round(n * 100) / 100;
    const z  = (v, mu, s) => v != null ? r2((Number(v) - mu) / s) : null;
    return [...rows].reverse()
      .map(r => ({
        date:        r.survey_date.slice(0, 7),
        michInf:     r.michigan_inf_exp_1yr   != null ? Number(r.michigan_inf_exp_1yr)   : null,
        nyfedInf:    r.nyfed_inf_exp_1yr      != null ? Number(r.nyfed_inf_exp_1yr)      : null,
        nyfedDelinq: r.nyfed_delinquency_prob != null ? Number(r.nyfed_delinquency_prob) : null,
        composite:   r.composite_stress_z     != null ? Number(r.composite_stress_z)     : null,
        zM:  z(r.michigan_inf_exp_1yr,   stats.muM,  stats.sdM),
        zNI: z(r.nyfed_inf_exp_1yr,      stats.muNI, stats.sdNI),
        zND: z(r.nyfed_delinquency_prob, stats.muND, stats.sdND),
      }))
      .filter(r => r.michInf != null || r.nyfedInf != null || r.nyfedDelinq != null);
  }, [rows, stats]);

  const thresholds = useMemo(() => {
    if (!rows?.length) return { p50: 0, p80: 0.5 };
    const vals = rows
      .filter(r => r.composite_stress_z != null)
      .map(r => Number(r.composite_stress_z))
      .sort((a, b) => a - b);
    if (!vals.length) return { p50: 0, p80: 0.5 };
    return {
      p50: vals[Math.floor(vals.length * 0.50)],
      p80: vals[Math.floor(vals.length * 0.80)],
    };
  }, [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[580px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">Consumer Inflation Expectations</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Michigan Survey (MICH) · NY Fed SCE · 1-year ahead · delinquency probability</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(currentValue) > 3.5 ? "text-loss" : Number(currentValue) > 2.5 ? "text-brass-soft" : "text-gain"}`}>
                  {formatValue(currentValue, "%")}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Michigan · Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="flex items-center gap-1">
            {EXP_RANGES.map((r) => (
              <button
                key={r.from}
                onClick={() => setRange(r.from)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.from
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">1-Yr Inflation Expectation &amp; Delinquency Risk · monthly</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    type="category"
                    ticks={xTicks}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 4)}
                    interval={0}
                  />
                  <YAxis
                    yAxisId="inf"
                    domain={[0, "auto"]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={36}
                  />
                  <YAxis
                    yAxisId="z"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(1)}σ`}
                    width={40}
                  />
                  <Tooltip content={<ExpTooltip />} />
                  <ReferenceLine yAxisId="inf" y={2}   stroke="#C9A227" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.4} />
                  <ReferenceLine yAxisId="z" y={thresholds.p50} stroke="#3FB984" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <ReferenceLine yAxisId="z" y={thresholds.p80} stroke="#E0635C" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <Line yAxisId="inf" type="monotone" dataKey="michInf"  name="Michigan 1yr" stroke="#C9A227" strokeWidth={2}   dot={false} connectNulls />
                  <Line yAxisId="inf" type="monotone" dataKey="nyfedInf" name="NY Fed 1yr"   stroke="#A8ADB8" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
                  <Bar yAxisId="z" dataKey="compositeZ" name="Stress Index z" maxBarSize={8}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={
                          entry.compositeZ == null ? "transparent" :
                          entry.compositeZ > thresholds.p80 ? "#E0635C" :
                          entry.compositeZ > thresholds.p50 ? "#C9A227" :
                          "#3FB984"
                        }
                        fillOpacity={0.85}
                      />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center justify-center gap-5 mt-3 text-[10px] text-paper-dim flex-wrap">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[2px] bg-[#C9A227] rounded" />
                  Michigan 1yr
                </span>
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="4" className="overflow-visible">
                    <line x1="0" y1="2" x2="20" y2="2" stroke="#A8ADB8" strokeWidth="1.5" strokeDasharray="4 2" />
                  </svg>
                  NY Fed 1yr
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-4 h-3 rounded-sm bg-[#E0635C] opacity-85" />
                  <span className="inline-block w-4 h-3 rounded-sm bg-[#C9A227] opacity-85" />
                  <span className="inline-block w-4 h-3 rounded-sm bg-[#3FB984] opacity-85" />
                  Stress Index z (right)
                </span>
              </div>
            </div>
          )}

          {rows !== null && tableRows.length > 0 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Historical Readings with Z-Scores · newest first</p>
              <div className="grid text-[10px] text-paper-dim pb-1.5 mb-1.5 border-b border-ink-line pr-1" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
                <span>Date</span>
                <span className="text-right">Mich%</span>
                <span className="text-right">z(M)</span>
                <span className="text-right">NYFed%</span>
                <span className="text-right">z(NY)</span>
                <span className="text-right">Delinq%</span>
                <span className="text-right">z(D)</span>
                <span className="text-right text-[#E0635C]/80">Stress z</span>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                {tableRows.map((r) => (
                  <div key={r.date} className="grid items-center text-[10px]" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
                    <span className="text-paper-dim">{r.date}</span>
                    <span className={`num text-right ${r.michInf == null ? "text-paper-dim" : r.michInf > 3.5 ? "text-loss" : r.michInf < 2 ? "text-gain" : "text-brass-soft"}`}>
                      {r.michInf != null ? `${r.michInf.toFixed(1)}%` : "—"}
                    </span>
                    <span className={`num text-right ${r.zM == null ? "text-paper-dim" : Math.abs(r.zM) <= 1 ? "text-paper-dim" : r.zM > 1 ? "text-loss" : "text-gain"}`}>
                      {r.zM != null ? `${r.zM >= 0 ? "+" : ""}${r.zM.toFixed(2)}` : "—"}
                    </span>
                    <span className={`num text-right ${r.nyfedInf == null ? "text-paper-dim" : r.nyfedInf > 3.5 ? "text-loss" : r.nyfedInf < 2 ? "text-gain" : "text-brass-soft"}`}>
                      {r.nyfedInf != null ? `${r.nyfedInf.toFixed(1)}%` : "—"}
                    </span>
                    <span className={`num text-right ${r.zNI == null ? "text-paper-dim" : Math.abs(r.zNI) <= 1 ? "text-paper-dim" : r.zNI > 1 ? "text-loss" : "text-gain"}`}>
                      {r.zNI != null ? `${r.zNI >= 0 ? "+" : ""}${r.zNI.toFixed(2)}` : "—"}
                    </span>
                    <span className={`num text-right ${r.nyfedDelinq == null ? "text-paper-dim" : r.nyfedDelinq > 13 ? "text-loss" : r.nyfedDelinq > 11 ? "text-brass-soft" : "text-gain"}`}>
                      {r.nyfedDelinq != null ? `${r.nyfedDelinq.toFixed(1)}%` : "—"}
                    </span>
                    <span className={`num text-right ${r.zND == null ? "text-paper-dim" : Math.abs(r.zND) <= 1 ? "text-paper-dim" : r.zND > 1 ? "text-loss" : "text-gain"}`}>
                      {r.zND != null ? `${r.zND >= 0 ? "+" : ""}${r.zND.toFixed(2)}` : "—"}
                    </span>
                    <span className={`num text-right font-medium ${r.composite == null ? "text-paper-dim" : r.composite > thresholds.p80 ? "text-loss" : r.composite > thresholds.p50 ? "text-brass-soft" : "text-gain"}`}>
                      {r.composite != null ? `${r.composite >= 0 ? "+" : ""}${r.composite.toFixed(2)}` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4 space-y-2">
            <p className="label text-[10px] mb-2">Stress Index Thresholds · data-derived from full history</p>
            {[
              { label: "Watch threshold (50th pct)", val: `${thresholds.p50 >= 0 ? "+" : ""}${thresholds.p50.toFixed(2)}σ`, note: "above median → watch" },
              { label: "Danger threshold (80th pct)", val: `${thresholds.p80 >= 0 ? "+" : ""}${thresholds.p80.toFixed(2)}σ`, note: "top quintile → danger" },
              { label: "Michigan baseline avg (2013–)", val: "~3.3%", note: "modern-era anchor" },
              { label: "Fed inflation target", val: "2.0%", note: "PCE basis" },
            ].map(({ label, val, note }) => (
              <div key={label} className="flex items-center justify-between text-xs">
                <div>
                  <span className="text-paper-dim">{label}</span>
                  <span className="text-paper-dim/50 ml-1.5 text-[10px]">{note}</span>
                </div>
                <span className="num text-paper shrink-0">{val}</span>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Sources: U of Michigan / FRED <span className="font-mono">MICH</span> · NY Federal Reserve Bank Survey of Consumer Expectations
          </p>
        </div>
      </div>
    </>
  );
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

function GoldPriceDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState("1Y");

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("gold_daily_prices")
      .select("date, close_price, avg_90d")
      .order("date", { ascending: true })
      .then(({ data }) => setRows(data ?? []));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows?.length) return [];
    const cutoff = range === "1Y"
      ? new Date(Date.now() - 366 * 24 * 3600 * 1000).toISOString().slice(0, 10)
      : new Date(Date.now() - 732 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return rows
      .filter(r => r.date >= cutoff)
      .map(r => ({
        date: r.date,
        spot: Number(r.close_price),
        avg90: r.avg_90d != null ? Number(r.avg_90d) : null,
      }));
  }, [rows, range]);

  const spotPrice = ind?.metadata?.spot_price != null ? Number(ind.metadata.spot_price) : null;
  const avg3m = ind?.current_value != null ? Number(ind.current_value) : null;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[560px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">Gold Price (COMEX GC=F)</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Daily futures close · 90-day rolling average · Yahoo Finance</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {spotPrice != null && (
              <div className="text-right">
                <p className="num text-xl font-bold text-brass-soft leading-none">${Math.round(spotPrice).toLocaleString("en-US")}</p>
                <p className="text-[10px] text-paper-dim mt-0.5">Spot /oz</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="flex items-center gap-1">
            {["1Y", "2Y"].map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${range === r ? "bg-ink text-brass-soft border border-brass/30" : "text-paper-dim hover:text-paper"}`}
              >
                {r}
              </button>
            ))}
          </div>

          {spotPrice != null && avg3m != null && (
            <div className="card p-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="num text-lg text-paper">${Math.round(spotPrice).toLocaleString("en-US")}</p>
                <p className="label text-[10px] mt-0.5">Spot /oz</p>
              </div>
              <div>
                <p className="num text-lg text-brass-soft">${Math.round(avg3m).toLocaleString("en-US")}</p>
                <p className="label text-[10px] mt-0.5">3M Average</p>
              </div>
              <div>
                <p className={`num text-lg ${spotPrice < avg3m ? "text-gain" : "text-loss"}`}>
                  {spotPrice < avg3m ? "▼" : "▲"} {Math.abs((spotPrice / avg3m - 1) * 100).toFixed(1)}%
                </p>
                <p className="label text-[10px] mt-0.5">Spot vs Avg</p>
              </div>
            </div>
          )}

          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : chartData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">No data</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Gold Futures Price ($/oz) · {range}</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.slice(0, 7)}
                    interval={Math.floor(chartData.length / 6)}
                  />
                  <YAxis
                    domain={["auto", "auto"]}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `$${Math.round(v).toLocaleString()}`}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={(v, name) => [`$${Math.round(v).toLocaleString()}/oz`, name === "spot" ? "Spot" : "90D Avg"]}
                  />
                  <Line type="monotone" dataKey="spot" stroke="#C8A96E" strokeWidth={1.5} dot={false} name="spot" />
                  <Line type="monotone" dataKey="avg90" stroke="#A8ADB8" strokeWidth={1} dot={false} strokeDasharray="4 2" name="avg90" />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-2">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-4 h-px bg-brass-soft" style={{ height: 2 }} />
                  <span className="text-[10px] text-paper-dim">Spot</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-4 border-t border-dashed border-paper-dim" />
                  <span className="text-[10px] text-paper-dim">90D Avg</span>
                </div>
              </div>
            </div>
          )}

          {rows !== null && rows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-line">
                <p className="label text-[10px]">Daily Price History</p>
              </div>
              <div className="overflow-y-auto max-h-64">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="border-b border-ink-line">
                      <th className="px-4 py-2 text-left label text-[10px]">Date</th>
                      <th className="px-4 py-2 text-right label text-[10px]">Close</th>
                      <th className="px-4 py-2 text-right label text-[10px]">90D Avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows].reverse().map(r => (
                      <tr key={r.date} className="border-b border-ink-line/40 hover:bg-ink/30">
                        <td className="px-4 py-1.5 text-paper-dim">{r.date}</td>
                        <td className="px-4 py-1.5 text-right num text-paper">${Math.round(Number(r.close_price)).toLocaleString()}</td>
                        <td className="px-4 py-1.5 text-right num text-paper-dim">
                          {r.avg_90d != null ? `$${Math.round(Number(r.avg_90d)).toLocaleString()}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60">Source: COMEX GC=F via Yahoo Finance · Updated daily</p>
        </div>
      </div>
    </>
  );
}

const LEI_RANGES = [
  { label: "2Y",  months: 24 },
  { label: "5Y",  months: 60 },
  { label: "10Y", months: 120 },
  { label: "20Y", months: 240 },
  { label: "All", months: 9999 },
];

const LEI_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">Conference Board LEI</p>
      <p className="text-paper-dim">The Leading Economic Index is a composite of 10 forward-looking components — average weekly manufacturing hours, initial jobless claims, ISM new orders, manufacturers' new orders, building permits, stock prices (S&amp;P 500), the leading credit index, the interest rate spread, and consumer expectations — combined into a single index designed to move ahead of turning points in the broader economy, before they show up in GDP or employment data.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Reading it</p>
      <p className="text-paper-dim">The headline number tracked here is the month-over-month % change. A single negative month is common noise and not by itself a recession signal — the Conference Board's own rule of thumb is <b>3 consecutive monthly declines</b>, or a meaningfully negative 6-month annualized rate, before treating it as a genuine deceleration signal.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Thresholds</p>
      <p className="text-paper-dim">Card status and the Forward Signal vote both use the same bands (coincidentally aligned, not derived from one another — they're separate pieces of code): <b>&gt; 0%</b> healthy / up · <b>-0.3% to 0%</b> watch / neutral · <b>&lt; -0.3%</b> danger / down. The -0.3 floor is a deadband — small negative prints within it are treated as noise rather than a real signal, consistent with the "3 consecutive declines" convention above.</p>
    </div>
    <p className="text-[10px] text-paper-dim/50 italic">Source: The Conference Board, Leading Economic Index for the U.S.</p>
  </div>
);

function LeiDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState("5Y");
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("lei_history")
      .select("period_date, level, mom_pct, published_at")
      .order("period_date", { ascending: true })
      .then(({ data }) => setRows(data ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const monthLimit = LEI_RANGES.find(r => r.label === range)?.months ?? 60;

  const chartData = useMemo(() => {
    if (!rows?.length) return [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthLimit);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return rows
      .filter(r => r.period_date >= cutoffStr)
      .map(r => ({ date: r.period_date, mom_pct: Number(r.mom_pct), level: r.level != null ? Number(r.level) : null }));
  }, [rows, monthLimit]);

  const latest = rows?.length ? rows[rows.length - 1] : null;

  const streak = useMemo(() => {
    if (!rows?.length) return null;
    const recent = [...rows].reverse();
    const firstVal = Number(recent[0].mom_pct);
    const declining = firstVal < 0;
    let count = 0;
    for (const r of recent) {
      if (declining ? Number(r.mom_pct) < 0 : Number(r.mom_pct) >= 0) count++;
      else break;
    }
    return { count, direction: declining ? "decline" : "growth" };
  }, [rows]);

  const tableRows = useMemo(() => (rows?.length ? [...rows].reverse().slice(0, 60) : []), [rows]);

  const momColor = (v) => v > 0 ? "#4ade80" : v >= -0.3 ? "#C9A227" : "#f87171";
  const currentVal = ind?.current_value != null ? Number(ind.current_value) : null;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[560px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">Conference Board LEI</h2>
              <button
                onClick={() => setInfoOpen((v) => !v)}
                className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                title="About this indicator"
              >
                i
              </button>
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">Leading Economic Index · MoM % change · 3 consecutive declines = recession signal</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentVal != null && (
              <div className="text-right">
                <p className="num text-xl font-bold leading-none" style={{ color: momColor(currentVal) }}>
                  {currentVal >= 0 ? "+" : ""}{currentVal.toFixed(2)}%
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">MoM (latest)</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {LEI_INFO}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="flex items-center gap-1">
            {LEI_RANGES.map(r => (
              <button
                key={r.label}
                onClick={() => setRange(r.label)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.label
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {latest && (
            <div className="card p-4 grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">Latest MoM</p>
                <p className="num text-lg font-bold" style={{ color: momColor(Number(latest.mom_pct)) }}>
                  {Number(latest.mom_pct) >= 0 ? "+" : ""}{Number(latest.mom_pct).toFixed(2)}%
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">{latest.period_date.slice(0, 7)}</p>
              </div>
              <div className="border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">LEI Level</p>
                <p className="num text-lg font-bold text-paper">
                  {latest.level != null ? Number(latest.level).toFixed(1) : "—"}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">2016 = 100</p>
              </div>
              <div className="border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">Streak</p>
                <p className="num text-lg font-bold" style={{ color: streak?.direction === "decline" ? "#f87171" : "#4ade80" }}>
                  {streak ? streak.count : "—"}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">
                  {streak ? `mo. ${streak.direction}` : ""}
                </p>
              </div>
              <div className="border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">Published</p>
                <p className="num text-lg font-bold text-paper" style={{ fontSize: "12px", paddingTop: "4px" }}>
                  {latest.published_at ? latest.published_at.slice(0, 7) : "—"}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">release date</p>
              </div>
            </div>
          )}

          {rows === null ? (
            <div className="h-56 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : chartData.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-paper-dim text-sm">No data</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">MoM % Change · {range}</p>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 7)}
                    interval={Math.max(0, Math.floor(chartData.length / 6))}
                  />
                  <YAxis
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={(v) => [`${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`, "MoM"]}
                  />
                  <ReferenceLine y={0} stroke="#4B5563" />
                  <ReferenceLine y={-0.3} stroke="#C9A227" strokeDasharray="4 2" strokeOpacity={0.6} label={{ value: "−0.3% watch", fill: "#C9A227", fontSize: 9, position: "insideTopRight" }} />
                  <Bar dataKey="mom_pct" name="MoM %" radius={[1, 1, 0, 0]}>
                    {chartData.map((r, i) => (
                      <Cell key={i} fill={r.mom_pct > 0 ? "#4ade80" : r.mom_pct >= -0.3 ? "#C9A227" : "#f87171"} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-paper-dim/60 mt-2">Green = expansion, Yellow = mild contraction (0 to −0.3%), Red = contraction. 3 consecutive red bars = recession warning.</p>
            </div>
          )}

          {rows !== null && tableRows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-line">
                <p className="label text-[10px]">Monthly History (most recent 60)</p>
              </div>
              <div className="overflow-y-auto max-h-64">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="border-b border-ink-line">
                      <th className="px-4 py-2 text-left label text-[10px]">Period</th>
                      <th className="px-4 py-2 text-right label text-[10px]">MoM %</th>
                      <th className="px-4 py-2 text-right label text-[10px]">Level</th>
                      <th className="px-4 py-2 text-right label text-[10px]">Published</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.period_date} className="border-b border-ink-line/40 hover:bg-ink/30">
                        <td className="px-4 py-1.5 text-paper-dim">{r.period_date.slice(0, 7)}</td>
                        <td className="px-4 py-1.5 text-right num" style={{ color: momColor(Number(r.mom_pct)) }}>
                          {Number(r.mom_pct) >= 0 ? "+" : ""}{Number(r.mom_pct).toFixed(2)}%
                        </td>
                        <td className="px-4 py-1.5 text-right num text-paper">
                          {r.level != null ? Number(r.level).toFixed(1) : "—"}
                        </td>
                        <td className="px-4 py-1.5 text-right text-paper-dim">
                          {r.published_at ? r.published_at.slice(0, 7) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60">Source: Conference Board (current readings) · FRED USSLIND (1982–2020 history). Index level available only for CB-scraped readings.</p>
        </div>
      </div>
    </>
  );
}

const T30_RANGES = [
  { label: "1Y",  months: 12 },
  { label: "2Y",  months: 24 },
  { label: "5Y",  months: 60 },
  { label: "10Y", months: 120 },
  { label: "All", months: 9999 },
];

function T30Drawer({ open, onClose, currentValue }) {
  const [data, setData]   = useState(null); // { rows, latestDaily }
  const [range, setRange] = useState("5Y");

  useEffect(() => {
    if (!open || data !== null) return;
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-t30-history`)
      .then(r => r.json())
      .then(d => setData(d?.rows ? d : null))
      .catch(() => setData({ rows: [], latestDaily: null }));
  }, [open, data]);

  const rows = data?.rows ?? null;
  const latestDaily = data?.latestDaily ?? null;

  const monthLimit = T30_RANGES.find(r => r.label === range)?.months ?? 60;

  const chartData = useMemo(() => {
    if (!rows?.length) return [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthLimit);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return rows.filter(r => r.date >= cutoffStr);
  }, [rows, monthLimit]);

  const latest = rows?.length ? rows[rows.length - 1] : null;
  const prev   = rows?.length > 1 ? rows[rows.length - 2] : null;

  const t30Zscore = useMemo(() => {
    if (!rows?.length || !latest) return null;
    const vals = rows.map(r => r.value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    return std > 0 ? Math.round((latest.value - mean) / std * 100) / 100 : null;
  }, [rows, latest]);

  const yDomain = useMemo(() => {
    if (!chartData.length) return [1, 7];
    const vals = chartData.map(r => r.value);
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.1 || 0.5;
    return [Math.floor((lo - pad) * 4) / 4, Math.ceil((hi + pad) * 4) / 4];
  }, [chartData]);

  const tableRows = useMemo(() => rows?.length ? [...rows].reverse().slice(0, 60) : [], [rows]);

  const yieldColor = (v) => v > 5 ? "#f87171" : v > 4 ? "#C9A227" : "#4ade80";
  const ppColor    = (v) => v == null ? "#6B7280" : v > 0 ? "#f87171" : "#4ade80";

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[600px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">30-Year Treasury Yield</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">^TYX (CBOE) · Monthly avg · Prior-day close · YoY/MoM in percentage points</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            <div className="text-right">
              {latestDaily && (
                <>
                  <p className={`num text-xl font-bold leading-none`} style={{ color: yieldColor(latestDaily.value) }}>
                    {latestDaily.value.toFixed(3)}%
                  </p>
                  <p className="text-[10px] text-paper-dim mt-0.5">{latestDaily.date} close</p>
                </>
              )}
              {!latestDaily && currentValue != null && (
                <>
                  <p className="num text-xl font-bold leading-none" style={{ color: yieldColor(Number(currentValue)) }}>
                    {Number(currentValue).toFixed(3)}%
                  </p>
                  <p className="text-[10px] text-paper-dim mt-0.5">Current</p>
                </>
              )}
            </div>
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Range */}
          <div className="flex items-center gap-1">
            {T30_RANGES.map(r => (
              <button
                key={r.label}
                onClick={() => setRange(r.label)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.label
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Summary stats */}
          {latest && (
            <div className="card p-4 grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">Monthly Avg</p>
                <p className="num text-lg font-bold" style={{ color: yieldColor(latest.value) }}>
                  {latest.value.toFixed(3)}%
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">{latest.date.slice(0, 7)}</p>
              </div>
              <div className="border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">YoY Change</p>
                <p className="num text-lg font-bold" style={{ color: ppColor(latest.yoy) }}>
                  {latest.yoy != null ? `${latest.yoy >= 0 ? "+" : ""}${latest.yoy.toFixed(2)}pp` : "—"}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">{latest.yoy != null ? (latest.yoy > 0 ? "Rising" : "Falling") : ""}</p>
              </div>
              <div className="border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">MoM Change</p>
                <p className="num text-lg font-bold" style={{ color: ppColor(latest.mom) }}>
                  {latest.mom != null ? `${latest.mom >= 0 ? "+" : ""}${latest.mom.toFixed(2)}pp` : "—"}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">{prev ? `vs ${prev.value.toFixed(3)}%` : ""}</p>
              </div>
              <div className="border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest mb-2">Z-Score</p>
                <p className="num text-lg font-bold" style={{ color: t30Zscore == null ? "#6B7280" : Math.abs(t30Zscore) > 2 ? "#f87171" : Math.abs(t30Zscore) > 1 ? "#C9A227" : "#4ade80" }}>
                  {t30Zscore != null ? `${t30Zscore >= 0 ? "+" : ""}${t30Zscore.toFixed(2)}σ` : "—"}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">vs full history</p>
              </div>
            </div>
          )}

          {/* Yield level chart */}
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : chartData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">No data</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Yield Level · {range} · monthly avg</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.slice(0, 7)}
                    interval={Math.max(0, Math.floor(chartData.length / 6))}
                  />
                  <YAxis
                    domain={yDomain}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `${v.toFixed(1)}%`}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={v => [`${Number(v).toFixed(3)}%`, "30Y Yield"]}
                  />
                  <ReferenceLine y={3} stroke="#4B5563" strokeDasharray="3 2" label={{ value: "3%", fill: "#6B7280", fontSize: 9, position: "right" }} />
                  <ReferenceLine y={4} stroke="#C9A227" strokeDasharray="3 2" strokeOpacity={0.5} label={{ value: "4%", fill: "#C9A227", fontSize: 9, position: "right" }} />
                  <ReferenceLine y={5} stroke="#f87171" strokeDasharray="3 2" strokeOpacity={0.5} label={{ value: "5%", fill: "#f87171", fontSize: 9, position: "right" }} />
                  <Line type="monotone" dataKey="value" stroke="#5B8DB8" strokeWidth={2} dot={false} name="value" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* MoM change bar chart */}
          {rows !== null && chartData.length > 2 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-1">Month-over-Month Change (pp) · {range}</p>
              <p className="text-[10px] text-paper-dim/60 mb-3">Red = yield rising (tightening), Green = yield falling (easing)</p>
              <ResponsiveContainer width="100%" height={150}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.slice(0, 7)}
                    interval={Math.max(0, Math.floor(chartData.length / 6))}
                  />
                  <YAxis
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(1)}pp`}
                    width={52}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={v => [`${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(3)}pp`, "MoM"]}
                  />
                  <ReferenceLine y={0} stroke="#4B5563" />
                  <Bar dataKey="mom" radius={[1, 1, 0, 0]} maxBarSize={12}>
                    {chartData.map((r, i) => (
                      <Cell key={i} fill={r.mom == null ? "#2A3240" : r.mom > 0 ? "#f87171" : "#4ade80"} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* History table */}
          {rows !== null && tableRows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-line">
                <p className="label text-[10px]">Monthly History (most recent 60) · pp = percentage points</p>
              </div>
              <div className="overflow-y-auto max-h-72">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="border-b border-ink-line">
                      <th className="px-4 py-2 text-left label text-[10px]">Date</th>
                      <th className="px-4 py-2 text-right label text-[10px]">Yield</th>
                      <th className="px-4 py-2 text-right label text-[10px]">YoY (pp)</th>
                      <th className="px-4 py-2 text-right label text-[10px]">MoM (pp)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(r => (
                      <tr key={r.date} className="border-b border-ink-line/40 hover:bg-ink/30">
                        <td className="px-4 py-1.5 text-paper-dim">{r.date.slice(0, 7)}</td>
                        <td className="px-4 py-1.5 text-right num" style={{ color: yieldColor(r.value) }}>
                          {r.value.toFixed(3)}%
                        </td>
                        <td className="px-4 py-1.5 text-right num" style={{ color: ppColor(r.yoy) }}>
                          {r.yoy != null ? `${r.yoy >= 0 ? "+" : ""}${r.yoy.toFixed(3)}pp` : "—"}
                        </td>
                        <td className="px-4 py-1.5 text-right num" style={{ color: ppColor(r.mom) }}>
                          {r.mom != null ? `${r.mom >= 0 ? "+" : ""}${r.mom.toFixed(3)}pp` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60">Source: Yahoo Finance ^TYX (CBOE 30-Year Treasury Bond Yield Index) · Monthly averages from daily closes · Current month is a partial-period average</p>
        </div>
      </div>
    </>
  );
}

const DXY_RANGES = [
  { label: "1Y",  months: 12 },
  { label: "2Y",  months: 24 },
  { label: "5Y",  months: 60 },
  { label: "10Y", months: 120 },
  { label: "All", months: 9999 },
];

function DxyDrawer({ open, onClose, currentValue }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState("5Y");

  useEffect(() => {
    if (!open || rows !== null) return;
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-dxy-history`)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const monthLimit = DXY_RANGES.find((r) => r.label === range)?.months ?? 60;

  const chartData = useMemo(() => {
    if (!rows?.length) return [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthLimit);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return rows.filter((r) => r.date >= cutoffStr);
  }, [rows, monthLimit]);

  const latest = rows?.length ? rows[rows.length - 1] : null;
  const oneYearAgo = useMemo(() => {
    if (!rows?.length) return null;
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    const key = d.toISOString().slice(0, 7);
    return rows.find((r) => r.date.startsWith(key)) ?? null;
  }, [rows]);

  const dxyZscore = useMemo(() => {
    if (!rows?.length || !latest) return null;
    const vals = rows.map(r => r.value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    return std > 0 ? Math.round((latest.value - mean) / std * 100) / 100 : null;
  }, [rows, latest]);

  const yDomain = useMemo(() => {
    if (!chartData.length) return [85, 120];
    const vals = chartData.map((r) => r.value);
    const lo = Math.floor(Math.min(...vals) / 5) * 5 - 2;
    const hi = Math.ceil(Math.max(...vals) / 5) * 5 + 2;
    return [lo, hi];
  }, [chartData]);

  const tableRows = useMemo(() => {
    if (!rows?.length) return [];
    return [...rows].reverse().slice(0, 60);
  }, [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[540px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">US Dollar Index (DXY)</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Nominal Broad Dollar Index · Monthly avg (FRED DTWEXBGS)</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(currentValue) > 104 ? "text-loss" : Number(currentValue) > 100 ? "text-brass-soft" : "text-gain"}`}>
                  {Number(currentValue).toFixed(1)}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Current</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Range selector */}
          <div className="flex items-center gap-1">
            {DXY_RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => setRange(r.label)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.label
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Summary stats */}
          {latest && (
            <div className="card p-4 grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="num text-lg text-paper">{latest.value.toFixed(2)}</p>
                <p className="label text-[10px] mt-0.5">Level</p>
              </div>
              <div className="border-l border-ink-line">
                <p className={`num text-lg ${latest.yoy == null ? "text-paper-dim" : latest.yoy < 0 ? "text-gain" : "text-loss"}`}>
                  {latest.yoy != null ? `${latest.yoy >= 0 ? "+" : ""}${latest.yoy.toFixed(1)}%` : "—"}
                </p>
                <p className="label text-[10px] mt-0.5">YoY</p>
              </div>
              <div className="border-l border-ink-line">
                <p className={`num text-lg ${latest.mom == null ? "text-paper-dim" : latest.mom < 0 ? "text-gain" : "text-loss"}`}>
                  {latest.mom != null ? `${latest.mom >= 0 ? "+" : ""}${latest.mom.toFixed(2)}%` : "—"}
                </p>
                <p className="label text-[10px] mt-0.5">MoM</p>
              </div>
              <div className="border-l border-ink-line">
                <p className={`num text-lg ${dxyZscore == null ? "text-paper-dim" : Math.abs(dxyZscore) > 2 ? "text-loss" : Math.abs(dxyZscore) > 1 ? "text-brass-soft" : "text-gain"}`}>
                  {dxyZscore != null ? `${dxyZscore >= 0 ? "+" : ""}${dxyZscore.toFixed(2)}σ` : "—"}
                </p>
                <p className="label text-[10px] mt-0.5">Z-Score</p>
              </div>
            </div>
          )}

          {/* Chart */}
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : chartData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">No data</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">DXY Index Level · {range}</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 7)}
                    interval={Math.max(0, Math.floor(chartData.length / 6))}
                  />
                  <YAxis
                    domain={yDomain}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.toFixed(0)}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={(v, name) => [
                      name === "value" ? v.toFixed(2) : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`,
                      name === "value" ? "DXY" : "YoY %",
                    ]}
                  />
                  <ReferenceLine y={100} stroke="#4B5563" strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="value" stroke="#5B8DB8" strokeWidth={2} dot={false} name="value" />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-paper-dim/60 mt-2">Dashed line at 100 = long-run average. Above 104 = strong dollar headwind for gold, EM, commodities.</p>
            </div>
          )}

          {/* YoY chart */}
          {rows !== null && chartData.length > 12 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">YoY % Change · {range}</p>
              <ResponsiveContainer width="100%" height={160}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.slice(0, 7)}
                    interval={Math.max(0, Math.floor(chartData.length / 6))}
                  />
                  <YAxis
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={(v) => [`${v >= 0 ? "+" : ""}${v.toFixed(2)}%`, "YoY"]}
                  />
                  <ReferenceLine y={0} stroke="#4B5563" />
                  <Bar dataKey="yoy" name="yoy" radius={[1, 1, 0, 0]}>
                    {chartData.map((r, i) => (
                      <Cell key={i} fill={r.yoy == null ? "#2A3240" : r.yoy < 0 ? "#4ade80" : "#f87171"} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-paper-dim/60 mt-1">Green = dollar weakening (positive for gold/EM/commodities), Red = dollar strengthening.</p>
            </div>
          )}

          {/* History table */}
          {rows !== null && tableRows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-line">
                <p className="label text-[10px]">Monthly History (most recent 60)</p>
              </div>
              <div className="overflow-y-auto max-h-64">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="border-b border-ink-line">
                      <th className="px-4 py-2 text-left label text-[10px]">Date</th>
                      <th className="px-4 py-2 text-right label text-[10px]">Level</th>
                      <th className="px-4 py-2 text-right label text-[10px]">YoY</th>
                      <th className="px-4 py-2 text-right label text-[10px]">MoM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.date} className="border-b border-ink-line/40 hover:bg-ink/30">
                        <td className="px-4 py-1.5 text-paper-dim">{r.date.slice(0, 7)}</td>
                        <td className="px-4 py-1.5 text-right num text-paper">{r.value.toFixed(2)}</td>
                        <td className={`px-4 py-1.5 text-right num ${r.yoy == null ? "text-paper-dim" : r.yoy < 0 ? "text-gain" : "text-loss"}`}>
                          {r.yoy != null ? `${r.yoy >= 0 ? "+" : ""}${r.yoy.toFixed(1)}%` : "—"}
                        </td>
                        <td className={`px-4 py-1.5 text-right num ${r.mom == null ? "text-paper-dim" : r.mom < 0 ? "text-gain" : "text-loss"}`}>
                          {r.mom != null ? `${r.mom >= 0 ? "+" : ""}${r.mom.toFixed(2)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60">Source: FRED DTWEXBGS (Nominal Broad Dollar Index) · Monthly average · Updated monthly</p>
        </div>
      </div>
    </>
  );
}

const DBC_RANGES = [
  { label: "1Y",  months: 12  },
  { label: "2Y",  months: 24  },
  { label: "5Y",  months: 60  },
  { label: "10Y", months: 120 },
  { label: "All", months: 9999 },
];

function DbcDrawer({ open, onClose, currentValue }) {
  const [rows, setRows]   = useState(null);
  const [range, setRange] = useState("5Y");

  useEffect(() => {
    if (!open || rows !== null) return;
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-dbc-history`)
      .then(r => r.json())
      .then(data => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const monthLimit = DBC_RANGES.find(r => r.label === range)?.months ?? 60;

  const chartData = useMemo(() => {
    if (!rows?.length) return [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthLimit);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return rows.filter(r => r.date >= cutoffStr);
  }, [rows, monthLimit]);

  const latest   = rows?.length ? rows[rows.length - 1] : null;
  const prevRow  = rows?.length > 1 ? rows[rows.length - 2] : null;
  const spreadDir = (latest?.spread != null && prevRow?.spread != null)
    ? (latest.spread > prevRow.spread ? "wide" : latest.spread < prevRow.spread ? "tight" : "flat")
    : null;

  const dbcZscore = useMemo(() => {
    if (!rows?.length || !latest?.dbcIndex) return null;
    const vals = rows.map(r => r.dbcIndex).filter(v => v != null);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    return std > 0 ? Math.round((latest.dbcIndex - mean) / std * 100) / 100 : null;
  }, [rows, latest]);

  // Shared left-axis domain for DBC index + DXY (both ~100 scale)
  const [idxDomain, spreadDomain] = useMemo(() => {
    if (!chartData.length) return [[60, 160], [-60, 60]];
    const idxVals    = chartData.flatMap(r => [r.dbcIndex, r.dxy]).filter(v => v != null);
    const spreadVals = chartData.map(r => r.spread).filter(v => v != null);
    const pad = (vals, pct = 0.08) => {
      const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      return [Math.floor(lo - span * pct), Math.ceil(hi + span * pct)];
    };
    return [pad(idxVals), pad(spreadVals)];
  }, [chartData]);

  // For table: rows newest-first, carry prior-month spread for direction arrow
  const tableRows = useMemo(() => {
    if (!rows?.length) return [];
    return [...rows].reverse().slice(0, 60).map((r, i, arr) => {
      const prior = arr[i + 1]; // older month (next in reversed array)
      const dir = (r.spread != null && prior?.spread != null)
        ? (r.spread > prior.spread ? "wide" : r.spread < prior.spread ? "tight" : "flat")
        : null;
      return { ...r, dir };
    });
  }, [rows]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[620px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">DBC Commodity Index</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">DBC rebased to 100 at inception (Feb 2006) · DXY overlay · Spread = DBC Index − DXY</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(currentValue) > 21 ? "text-gain" : Number(currentValue) > 16 ? "text-brass-soft" : "text-loss"}`}>
                  ${Number(currentValue).toFixed(2)}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Price</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Range */}
          <div className="flex items-center gap-1">
            {DBC_RANGES.map(r => (
              <button
                key={r.label}
                onClick={() => setRange(r.label)}
                className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                  range === r.label
                    ? "bg-ink text-brass-soft border border-brass/30"
                    : "text-paper-dim hover:text-paper"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Summary stats */}
          {latest && (
            <div className="card p-4 grid grid-cols-4 gap-3">
              <div className="space-y-2 text-center">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest">DBC Index</p>
                <p className={`num text-lg font-bold ${latest.dbcIndex > 100 ? "text-gain" : latest.dbcIndex > 70 ? "text-brass-soft" : "text-loss"}`}>
                  {latest.dbcIndex?.toFixed(1) ?? "—"}
                </p>
                <p className={`num text-xs ${latest.dbcYoy == null ? "text-paper-dim" : latest.dbcYoy >= 0 ? "text-loss" : "text-gain"}`}>
                  {latest.dbcYoy != null ? `${latest.dbcYoy >= 0 ? "+" : ""}${latest.dbcYoy.toFixed(1)}% YoY` : "—"}
                </p>
              </div>
              <div className="space-y-2 text-center border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest">DXY</p>
                <p className={`num text-lg font-bold ${latest.dxy == null ? "text-paper-dim" : latest.dxy > 104 ? "text-loss" : latest.dxy > 100 ? "text-brass-soft" : "text-gain"}`}>
                  {latest.dxy?.toFixed(1) ?? "—"}
                </p>
                <p className={`num text-xs ${latest.dxyYoy == null ? "text-paper-dim" : latest.dxyYoy < 0 ? "text-gain" : "text-loss"}`}>
                  {latest.dxyYoy != null ? `${latest.dxyYoy >= 0 ? "+" : ""}${latest.dxyYoy.toFixed(1)}% YoY` : "—"}
                </p>
              </div>
              <div className="space-y-2 text-center border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest">Spread</p>
                <p className={`num text-lg font-bold ${latest.spread == null ? "text-paper-dim" : latest.spread > 0 ? "text-gain" : "text-loss"}`}>
                  {latest.spread != null ? `${latest.spread >= 0 ? "+" : ""}${latest.spread.toFixed(1)}` : "—"}
                </p>
                <p className={`num text-xs ${spreadDir === "wide" ? "text-gain" : spreadDir === "tight" ? "text-loss" : "text-paper-dim"}`}>
                  {spreadDir === "wide" ? "↑ Widening" : spreadDir === "tight" ? "↓ Tightening" : spreadDir === "flat" ? "→ Flat" : "—"}
                </p>
              </div>
              <div className="space-y-2 text-center border-l border-ink-line">
                <p className="label text-[10px] text-paper-dim/60 uppercase tracking-widest">Z-Score</p>
                <p className={`num text-lg font-bold ${dbcZscore == null ? "text-paper-dim" : Math.abs(dbcZscore) > 2 ? "text-loss" : Math.abs(dbcZscore) > 1 ? "text-brass-soft" : "text-gain"}`}>
                  {dbcZscore != null ? `${dbcZscore >= 0 ? "+" : ""}${dbcZscore.toFixed(2)}σ` : "—"}
                </p>
                <p className="num text-xs text-paper-dim">DBC Index</p>
              </div>
            </div>
          )}

          {/* Main chart: DBC Index + DXY lines (left axis) + Spread bars (right axis) */}
          {rows === null ? (
            <div className="h-72 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : chartData.length === 0 ? (
            <div className="h-72 flex items-center justify-center text-paper-dim text-sm">No data</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-1">DBC Index vs DXY · {range} · monthly avg</p>
              <p className="text-[10px] text-paper-dim/60 mb-3">Spread bars (right axis) = DBC Index − DXY · Green = widening · Red = tightening</p>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 52, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.slice(0, 7)}
                    interval={Math.max(0, Math.floor(chartData.length / 6))}
                  />
                  <YAxis
                    yAxisId="idx"
                    domain={idxDomain}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.toFixed(0)}
                    width={36}
                  />
                  <YAxis
                    yAxisId="spread"
                    orientation="right"
                    domain={spreadDomain}
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v.toFixed(0)}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={(v, name) => [
                      Number(v).toFixed(1),
                      name === "dbcIndex" ? "DBC Index" : name === "dxy" ? "DXY" : "Spread",
                    ]}
                  />
                  <ReferenceLine yAxisId="idx" y={100} stroke="#4B5563" strokeDasharray="4 2" />
                  <ReferenceLine yAxisId="spread" y={0} stroke="#4B5563" strokeDasharray="4 2" />
                  {/* Spread bars behind the lines */}
                  <Bar yAxisId="spread" dataKey="spread" radius={[1, 1, 0, 0]} maxBarSize={8}>
                    {chartData.map((r, i) => {
                      const prev = chartData[i - 1];
                      const widening = prev?.spread != null && r.spread != null && r.spread > prev.spread;
                      const tightening = prev?.spread != null && r.spread != null && r.spread < prev.spread;
                      return (
                        <Cell
                          key={i}
                          fill={r.spread == null ? "#2A3240" : widening ? "#4ade80" : tightening ? "#f87171" : "#4B5563"}
                          fillOpacity={0.7}
                        />
                      );
                    })}
                  </Bar>
                  <Line yAxisId="idx" type="monotone" dataKey="dbcIndex" stroke="#4ade80" strokeWidth={2} dot={false} name="dbcIndex" />
                  <Line yAxisId="idx" type="monotone" dataKey="dxy" stroke="#C9A227" strokeWidth={1.5} dot={false} strokeDasharray="5 2" name="dxy" />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 mt-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-4 bg-gain" style={{ height: 2 }} />
                  <span className="text-[10px] text-paper-dim">DBC Index (base 100)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-4 border-t border-dashed border-brass-soft" />
                  <span className="text-[10px] text-paper-dim">DXY (left axis)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-gain opacity-70" />
                  <span className="text-[10px] text-paper-dim">Spread widening</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-loss opacity-70" />
                  <span className="text-[10px] text-paper-dim">Spread tightening</span>
                </div>
              </div>
            </div>
          )}

          {/* History table */}
          {rows !== null && tableRows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-line">
                <p className="label text-[10px]">Monthly History (most recent 60) · Spread = DBC Index − DXY</p>
              </div>
              <div className="overflow-y-auto max-h-72">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="border-b border-ink-line">
                      <th className="px-3 py-2 text-left label text-[10px]">Date</th>
                      <th className="px-3 py-2 text-right label text-[10px]">DBC Idx</th>
                      <th className="px-3 py-2 text-right label text-[10px]">DBC YoY</th>
                      <th className="px-3 py-2 text-right label text-[10px]">DXY</th>
                      <th className="px-3 py-2 text-right label text-[10px]">Spread</th>
                      <th className="px-3 py-2 text-center label text-[10px]">Dir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(r => (
                      <tr key={r.date} className="border-b border-ink-line/40 hover:bg-ink/30">
                        <td className="px-3 py-1.5 text-paper-dim">{r.date.slice(0, 7)}</td>
                        <td className={`px-3 py-1.5 text-right num ${r.dbcIndex > 100 ? "text-gain" : r.dbcIndex > 70 ? "text-brass-soft" : "text-loss"}`}>
                          {r.dbcIndex?.toFixed(1) ?? "—"}
                        </td>
                        <td className={`px-3 py-1.5 text-right num ${r.dbcYoy == null ? "text-paper-dim" : r.dbcYoy >= 0 ? "text-loss" : "text-gain"}`}>
                          {r.dbcYoy != null ? `${r.dbcYoy >= 0 ? "+" : ""}${r.dbcYoy.toFixed(1)}%` : "—"}
                        </td>
                        <td className={`px-3 py-1.5 text-right num ${r.dxy == null ? "text-paper-dim" : r.dxy > 104 ? "text-loss" : r.dxy > 100 ? "text-brass-soft" : "text-gain"}`}>
                          {r.dxy?.toFixed(1) ?? "—"}
                        </td>
                        <td className={`px-3 py-1.5 text-right num ${r.spread == null ? "text-paper-dim" : r.spread > 0 ? "text-gain" : "text-loss"}`}>
                          {r.spread != null ? `${r.spread >= 0 ? "+" : ""}${r.spread.toFixed(1)}` : "—"}
                        </td>
                        <td className={`px-3 py-1.5 text-center text-base leading-none ${r.dir === "wide" ? "text-gain" : r.dir === "tight" ? "text-loss" : "text-paper-dim"}`}>
                          {r.dir === "wide" ? "↑" : r.dir === "tight" ? "↓" : r.dir === "flat" ? "→" : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60">DBC: Yahoo Finance (rebased 100 = Feb 2006) · DXY: FRED DTWEXBGS · Monthly averages · Positive spread = commodities outperforming dollar on indexed basis</p>
        </div>
      </div>
    </>
  );
}

function CbGoldDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("wgc_gold_purchases")
      .select("year, tonnes, is_actual")
      .order("year", { ascending: true })
      .then(({ data }) => setRows(data ?? []));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows?.length) return [];
    return rows.map(r => ({ year: r.year, tonnes: Number(r.tonnes), isActual: r.is_actual }));
  }, [rows]);

  const currentValue = ind?.current_value != null ? Number(ind.current_value) : null;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-[560px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-paper">Central Bank Gold Purchases</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Annual net purchases in metric tonnes · World Gold Council</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {currentValue != null && (
              <div className="text-right">
                <p className="num text-xl font-bold text-brass-soft leading-none">{currentValue.toFixed(1)}%</p>
                <p className="text-[10px] text-paper-dim mt-0.5">Gold YoY</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Net CB Gold Purchases (metric tonnes / year)</p>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="year"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `${v}t`}
                    width={52}
                  />
                  <ReferenceLine y={0} stroke="#3A4458" strokeWidth={1} />
                  <Tooltip
                    contentStyle={{ background: "#1A2030", border: "1px solid #2A3240", borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: "#A8ADB8" }}
                    formatter={(v, _n, props) => [
                      `${v >= 0 ? "+" : ""}${v}t${props.payload.isActual ? "" : " (est.)"}`,
                      "Net purchases",
                    ]}
                  />
                  <Bar dataKey="tonnes" radius={[2, 2, 0, 0]}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={entry.tonnes >= 0 ? "#C8A96E" : "#E0635C"}
                        fillOpacity={entry.isActual ? 1 : 0.5}
                      />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-2">
                <div className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-brass-soft" /><span className="text-[10px] text-paper-dim">WGC actual</span></div>
                <div className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-brass-soft opacity-50" /><span className="text-[10px] text-paper-dim">Reconstructed</span></div>
                <div className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-loss" /><span className="text-[10px] text-paper-dim">Net selling</span></div>
              </div>
            </div>
          )}

          {rows !== null && rows.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-ink-line">
                <p className="label text-[10px]">Annual Data</p>
              </div>
              <div className="overflow-y-auto max-h-72">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="border-b border-ink-line">
                      <th className="px-4 py-2 text-left label text-[10px]">Year</th>
                      <th className="px-4 py-2 text-right label text-[10px]">Net Purchases</th>
                      <th className="px-4 py-2 text-right label text-[10px]">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows].reverse().map(r => (
                      <tr key={r.year} className="border-b border-ink-line/40 hover:bg-ink/30">
                        <td className="px-4 py-1.5 text-paper-dim">{r.year}</td>
                        <td className={`px-4 py-1.5 text-right num ${Number(r.tonnes) >= 0 ? "text-brass-soft" : "text-loss"}`}>
                          {Number(r.tonnes) >= 0 ? "+" : ""}{Number(r.tonnes).toLocaleString()}t
                        </td>
                        <td className="px-4 py-1.5 text-right text-paper-dim">{r.is_actual ? "WGC actual" : "reconstructed"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60">Source: World Gold Council · Pre-2014 values reconstructed from IMF IFS</p>
        </div>
      </div>
    </>
  );
}

// ── US Total Liquidity Composite ──────────────────────────────────────────────

const LIQUIDITY_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">US Total Liquidity Composite</p>
      <p className="text-paper-dim">Measures the momentum of money available to US financial markets, combining two channels: <i>official liquidity</i> (the Fed's balance sheet net of the Treasury's cash account and reverse-repo drains) and <i>private liquidity</i> (repo-market funding volumes, commercial paper outstanding, and the M2 money stock). All components are expressed as year-over-year growth and averaged; the z-score positions today's reading against the indicator's own history (0 ≈ normal, ±2σ ≈ historical extremes).</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Why it matters</p>
      <p className="text-paper-dim">Asset prices are driven less by the level of liquidity than by its rate of change. Rising liquidity has historically supported equities, credit, and crypto; falling liquidity pressures long-duration bonds and equity valuations while favoring cash, defensives, and — late in the cycle — commodities, as money migrates from financial markets into the real economy. Liquidity cycles have historically run roughly five to six years and lead the real economy by 12–18 months.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Reading it</p>
      <p className="text-paper-dim">Above zero and rising = expansionary regime (risk-on historically favored). Above zero but falling = late-cycle deceleration (reduce beta, watch commodities). Below zero = contraction (historically the most dangerous regime for risk assets). The dashed line shows the same concept weighted by dollar size, which moves more slowly because M2 dominates it.</p>
    </div>
    <p className="text-[10px] text-paper-dim/50 italic">Public-data approximation inspired by the Cross-Border Capital / GL Indexes global liquidity framework. Not investment advice. Sources: Federal Reserve (FRED), US Office of Financial Research.</p>
  </div>
);

function LiquidityTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[200px]">
      <p className="font-semibold text-paper mb-1">
        {label}
        {row?.is_partial && <span className="text-paper-dim font-normal"> (partial)</span>}
      </p>
      {payload.map((p) => p.value == null ? null : (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.stroke ?? p.color }}>{p.name}</span>
          <span className="num text-paper">
            {p.dataKey === "composite_zscore"
              ? `${Number(p.value) >= 0 ? "+" : ""}${Number(p.value).toFixed(2)}σ`
              : `${Number(p.value) >= 0 ? "+" : ""}${Number(p.value).toFixed(1)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

function LiquidityDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("liquidity_monthly")
      .select("*")
      .order("month", { ascending: true })
      .then(({ data }) => setRows(data ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter((r) => r.month >= "2019-01-01")
      .map((r) => ({
        month: r.month,
        net_liq_yoy: r.net_liq_yoy != null ? Number(r.net_liq_yoy) : null,
        private_composite_yoy: r.private_composite_yoy != null ? Number(r.private_composite_yoy) : null,
        total_composite_yoy: r.total_composite_yoy != null ? Number(r.total_composite_yoy) : null,
        stock_yoy: r.stock_yoy != null ? Number(r.stock_yoy) : null,
        composite_zscore: r.composite_zscore != null ? Number(r.composite_zscore) : null,
        is_partial: r.is_partial,
      }));
  }, [rows]);

  const xTicks = useMemo(() => chartData.filter((r) => r.month.slice(5, 7) === "01").map((r) => r.month), [chartData]);

  const tableRows = useMemo(() => {
    if (!rows) return [];
    const sorted = [...rows].sort((a, b) => b.month.localeCompare(a.month));
    return showFullHistory ? sorted : sorted.slice(0, 24);
  }, [rows, showFullHistory]);

  function fmtPct(v) { return v == null ? "—" : `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`; }
  function fmtTn(v) { return v == null ? "—" : `$${Number(v).toFixed(2)}T`; }
  function fmtBn(v) { return v == null ? "—" : `$${Number(v).toFixed(0)}B`; }
  function pctColor(v) { return v == null ? "text-paper-dim" : Number(v) >= 0 ? "text-gain" : "text-loss"; }

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div className={`fixed right-0 top-0 h-full w-[780px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">US Total Liquidity Composite</h2>
              <button
                onClick={() => setInfoOpen((v) => !v)}
                className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                title="About this indicator"
              >
                i
              </button>
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">Fed net liquidity + private liquidity proxy · YoY momentum · Monthly</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {ind?.current_value != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(ind.current_value) > 0 ? "text-gain" : "text-loss"}`}>
                  {formatValue(ind.current_value, "%")}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Total Composite YoY</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {LIQUIDITY_INFO}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f38" vertical={false} />
                  <XAxis
                    dataKey="month"
                    ticks={xTicks}
                    tickFormatter={(d) => d.slice(0, 4)}
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                    tickFormatter={(v) => `${v}σ`}
                  />
                  <ReferenceLine yAxisId="left" y={0} stroke="#8a8f98" strokeOpacity={0.5} />
                  <Tooltip content={<LiquidityTooltip />} />
                  <Line yAxisId="left" type="monotone" dataKey="net_liq_yoy" name="Net Liquidity YoY" stroke="#4472C4" strokeWidth={1.5} dot={false} connectNulls />
                  <Line yAxisId="left" type="monotone" dataKey="private_composite_yoy" name="Private Liquidity YoY" stroke="#ED7D31" strokeWidth={1.5} dot={false} connectNulls />
                  <Line yAxisId="left" type="monotone" dataKey="total_composite_yoy" name="Total Composite YoY" stroke="#1F4E78" strokeWidth={3} dot={false} connectNulls />
                  <Line yAxisId="left" type="monotone" dataKey="stock_yoy" name="Stock-Weighted YoY" stroke="#7030A0" strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls />
                  <Line yAxisId="right" type="monotone" dataKey="composite_zscore" name="Composite Z-Score" stroke="#00B050" strokeWidth={1.5} strokeDasharray="2 2" dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[1.5px] rounded-sm" style={{ backgroundColor: "#4472C4" }} />Net Liquidity</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[1.5px] rounded-sm" style={{ backgroundColor: "#ED7D31" }} />Private Liquidity</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2.5px] rounded-sm" style={{ backgroundColor: "#1F4E78" }} />Total Composite</span>
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="4" className="overflow-visible"><line x1="0" y1="2" x2="20" y2="2" stroke="#7030A0" strokeWidth="2" strokeDasharray="5 3" /></svg>
                  Stock-Weighted
                </span>
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="4" className="overflow-visible"><line x1="0" y1="2" x2="20" y2="2" stroke="#00B050" strokeWidth="1.5" strokeDasharray="2 2" /></svg>
                  Z-Score (right axis)
                </span>
              </div>
            </div>
          )}

          {tableRows.length > 0 && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="label text-[10px]">Monthly Detail{showFullHistory ? "" : " · last 24 months"}</p>
                <button
                  onClick={() => setShowFullHistory((v) => !v)}
                  className="text-[10px] text-brass-soft hover:text-brass transition-colors"
                >
                  {showFullHistory ? "Show last 24 months" : "Show full history"}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] min-w-[640px]">
                  <thead>
                    <tr className="text-paper-dim text-[10px]">
                      <th className="text-left pb-2 font-medium pr-2">Month</th>
                      <th className="text-right pb-2 font-medium px-2">Net Liq.</th>
                      <th className="text-right pb-2 font-medium px-2">Repo Avg</th>
                      <th className="text-right pb-2 font-medium px-2">CP</th>
                      <th className="text-right pb-2 font-medium px-2">M2</th>
                      <th className="text-right pb-2 font-medium px-2">Net Liq YoY</th>
                      <th className="text-right pb-2 font-medium px-2">Private YoY</th>
                      <th className="text-right pb-2 font-medium px-2">Total Composite YoY</th>
                      <th className="text-right pb-2 font-medium px-2">Stock YoY</th>
                      <th className="text-right pb-2 font-medium pl-2">Z-Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.month} className="border-t border-ink-line/50">
                        <td className="py-1.5 pr-2 text-paper-dim whitespace-nowrap">
                          {new Date(r.month + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                          {r.is_partial && <span className="ml-1 text-[9px] text-brass-soft">(partial)</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right num text-paper">{fmtTn(r.net_liquidity_tn)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtBn(r.repo_avg_bn)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtBn(r.cp_avg_bn)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtBn(r.m2_bn)}</td>
                        <td className={`py-1.5 px-2 text-right num ${pctColor(r.net_liq_yoy)}`}>{fmtPct(r.net_liq_yoy)}</td>
                        <td className={`py-1.5 px-2 text-right num ${pctColor(r.private_composite_yoy)}`}>{fmtPct(r.private_composite_yoy)}</td>
                        <td className={`py-1.5 px-2 text-right num font-semibold ${pctColor(r.total_composite_yoy)}`}>{fmtPct(r.total_composite_yoy)}</td>
                        <td className={`py-1.5 px-2 text-right num ${pctColor(r.stock_yoy)}`}>{fmtPct(r.stock_yoy)}</td>
                        <td className="py-1.5 pl-2 text-right num text-paper-dim">
                          {r.composite_zscore != null ? `${Number(r.composite_zscore) >= 0 ? "+" : ""}${Number(r.composite_zscore).toFixed(2)}σ` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Sources: Federal Reserve H.4.1 via FRED (WALCL, WTREGEN, WLRRAL), FRED (COMPOUT, M2SL), OFR Short-term Funding Monitor (tri-party repo). Updated weekdays. M2 publishes with a ~2-month lag.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Fed SOMA Long-Duration Holdings ─────────────────────────────────────────────

const SOMA_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">Fed SOMA Long-Duration Holdings</p>
      <p className="text-paper-dim">Tracks the Federal Reserve's SOMA (System Open Market Account) Treasury holdings, bucketed by remaining maturity, with weekly change in the 5Y+ buckets (5-10Y and &gt;10Y combined) as the headline figure. This is a <i>composition</i> signal, distinct from the Fed Balance Sheet % GDP indicator above it, which only measures total <i>size</i>. The Fed can quietly absorb long-duration Treasury supply — a precursor to formal QE or yield-curve control — while the total balance sheet stays roughly flat; a pure size measure can't see that shift happening.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Methodology</p>
      <p className="text-paper-dim">Source: NY Fed's public Markets Data API (CUSIP-level SOMA holdings, updated weekly). Each week's full snapshot is bucketed by remaining maturity as of that snapshot's own date, and bucket totals are diffed week-over-week. The per-security "change from prior week" field NY Fed publishes is not used directly — Treasury bill CUSIPs roll over into new CUSIPs on every auction, so per-CUSIP diffing silently misses that churn. Diffing full bucket totals avoids this.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Reading it</p>
      <p className="text-paper-dim">A single week's reading is noise. What matters is a sustained run of positive weekly changes in the 5Y+ buckets — that would indicate the Fed is genuinely absorbing long-duration supply, not just rolling short-term bills. This indicator is tracked here as a leading, informational signal; it does not yet feed the Big Cycle debt-cycle MP1/MP2/MP3 stage classification, since one week's data isn't a trend to act on.</p>
    </div>
    <p className="text-[10px] text-paper-dim/50 italic">Source: Federal Reserve Bank of New York, Markets Data API (SOMA holdings).</p>
  </div>
);

function SomaTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[200px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => p.value == null ? null : (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.stroke ?? p.fill ?? p.color }}>{p.name}</span>
          <span className="num text-paper">
            {p.dataKey === "long_level" ? `$${Number(p.value).toFixed(0)}B` : `${Number(p.value) >= 0 ? "+" : ""}${Number(p.value).toFixed(2)}B`}
          </span>
        </div>
      ))}
    </div>
  );
}

function SomaDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("soma_holdings_by_maturity")
      .select("*")
      .order("as_of_date", { ascending: true })
      .then(({ data }) => setRows(data ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  // Pivot bucket rows into one wide row per week, then compute week-over-week
  // deltas for the combined long-duration (5-10Y + >10Y) and short-end
  // (16-90D + 91D-1Y) series — the raw table only stores levels per bucket.
  const weeklyRows = useMemo(() => {
    if (!rows) return [];
    const byDate = new Map();
    for (const r of rows) {
      if (!byDate.has(r.as_of_date)) byDate.set(r.as_of_date, {});
      byDate.get(r.as_of_date)[r.bucket] = Number(r.par_value_bn);
    }
    const dates = [...byDate.keys()].sort();
    return dates.map((d, i) => {
      const b = byDate.get(d);
      const longLevel = (b["5-10Y"] ?? 0) + (b[">10Y"] ?? 0);
      const shortLevel = (b["16-90D"] ?? 0) + (b["91D-1Y"] ?? 0);
      const prev = i > 0 ? byDate.get(dates[i - 1]) : null;
      const prevLong = prev ? (prev["5-10Y"] ?? 0) + (prev[">10Y"] ?? 0) : null;
      const prevShort = prev ? (prev["16-90D"] ?? 0) + (prev["91D-1Y"] ?? 0) : null;
      return {
        as_of_date: d,
        b510: b["5-10Y"] ?? null, bOver10: b[">10Y"] ?? null,
        long_level: longLevel,
        long_delta: prevLong != null ? longLevel - prevLong : null,
        short_delta: prevShort != null ? shortLevel - prevShort : null,
      };
    });
  }, [rows]);

  const xTicks = useMemo(() => {
    const total = weeklyRows.length;
    const step = total > 40 ? 8 : total > 16 ? 4 : 2;
    return weeklyRows.filter((_, i) => i % step === 0).map((r) => r.as_of_date);
  }, [weeklyRows]);

  const tableRows = useMemo(() => {
    const sorted = [...weeklyRows].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date));
    return showFullHistory ? sorted : sorted.slice(0, 24);
  }, [weeklyRows, showFullHistory]);

  function fmtBn(v) { return v == null ? "—" : `${Number(v) >= 0 ? "+" : ""}$${Number(v).toFixed(2)}B`; }
  function fmtLevel(v) { return v == null ? "—" : `$${Number(v).toFixed(0)}B`; }
  function pctColor(v) { return v == null ? "text-paper-dim" : Number(v) >= 0 ? "text-loss" : "text-gain"; }
  const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div className={`fixed right-0 top-0 h-full w-[780px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">Fed SOMA Long-Duration Holdings</h2>
              <button
                onClick={() => setInfoOpen((v) => !v)}
                className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                title="About this indicator"
              >
                i
              </button>
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">5-10Y + &gt;10Y SOMA Treasury holdings · Weekly Δ · NY Fed</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {ind?.current_value != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(ind.current_value) > 1 ? "text-loss" : "text-gain"}`}>
                  {Number(ind.current_value) >= 0 ? "+" : ""}${Number(ind.current_value).toFixed(1)}B
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Weekly Δ, 5Y+</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {SOMA_INFO}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={weeklyRows} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f38" vertical={false} />
                  <XAxis
                    dataKey="as_of_date"
                    ticks={xTicks}
                    tickFormatter={fmtDate}
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                    tickFormatter={(v) => `$${v}B`}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    domain={["dataMin - 20", "dataMax + 20"]}
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                    tickFormatter={(v) => `$${Math.round(v)}B`}
                  />
                  <ReferenceLine yAxisId="left" y={0} stroke="#8a8f98" strokeOpacity={0.5} />
                  <Tooltip content={<SomaTooltip />} labelFormatter={fmtDate} />
                  <Bar yAxisId="left" dataKey="long_delta" name="Weekly Δ (5Y+)" maxBarSize={10}>
                    {weeklyRows.map((r, i) => (
                      <Cell key={i} fill={r.long_delta == null ? "transparent" : r.long_delta >= 0 ? "#E0635C" : "#3FB984"} fillOpacity={0.7} />
                    ))}
                  </Bar>
                  <Line yAxisId="right" type="monotone" dataKey="long_level" name="Total 5Y+ Level" stroke="#7030A0" strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#E0635C", opacity: 0.7 }} />Absorbing (+Δ)</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#3FB984", opacity: 0.7 }} />Reducing (−Δ)</span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[2px] rounded-sm" style={{ backgroundColor: "#7030A0" }} />
                  Total 5Y+ level (right axis)
                </span>
              </div>
            </div>
          )}

          {tableRows.length > 0 && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="label text-[10px]">Weekly Detail{showFullHistory ? "" : " · last 24 weeks"}</p>
                <button
                  onClick={() => setShowFullHistory((v) => !v)}
                  className="text-[10px] text-brass-soft hover:text-brass transition-colors"
                >
                  {showFullHistory ? "Show last 24 weeks" : "Show full history"}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] min-w-[560px]">
                  <thead>
                    <tr className="text-paper-dim text-[10px]">
                      <th className="text-left pb-2 font-medium pr-2">Week</th>
                      <th className="text-right pb-2 font-medium px-2">5-10Y</th>
                      <th className="text-right pb-2 font-medium px-2">&gt;10Y</th>
                      <th className="text-right pb-2 font-medium px-2">Combined 5Y+</th>
                      <th className="text-right pb-2 font-medium px-2">Weekly Δ (5Y+)</th>
                      <th className="text-right pb-2 font-medium pl-2">Short-End Δ (≤1Y)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.as_of_date} className="border-t border-ink-line/50">
                        <td className="py-1.5 pr-2 text-paper-dim whitespace-nowrap">{fmtDate(r.as_of_date)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtLevel(r.b510)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtLevel(r.bOver10)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper font-semibold">{fmtLevel(r.long_level)}</td>
                        <td className={`py-1.5 px-2 text-right num font-semibold ${pctColor(r.long_delta)}`}>{fmtBn(r.long_delta)}</td>
                        <td className={`py-1.5 pl-2 text-right num ${pctColor(r.short_delta)}`}>{fmtBn(r.short_delta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: Federal Reserve Bank of New York, Markets Data API (SOMA holdings by CUSIP). Data as of each Wednesday, published Thursday.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Foreign Official Share of UST Holdings ──────────────────────────────────────

const TIC_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">Foreign Official Share of UST Holdings</p>
      <p className="text-paper-dim">Splits total foreign holdings of US Treasury securities into <i>Foreign Official</i> (central banks and other official reserve managers) vs. the private-sector residual (Grand Total minus Foreign Official). This is distinct from the Reserve Confidence gauge above, which tracks the USD's share of <i>global FX reserves</i> broadly — this tracks the official/private split specifically within US Treasury holdings. A declining official share means private buyers, the Fed (via QE), or banks (via regulatory pressure) have to absorb more of the slack central banks leave behind.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Methodology</p>
      <p className="text-paper-dim">Source: US Treasury's TIC "Table 5: Major Foreign Holders of Treasury Securities" — a monthly <i>stock</i> (level) figure, not a net-transaction flow, so it isn't noisy the way monthly buy/sell figures can be. Combines the live rolling 13-month file with Treasury's separate historical archive (year-blocks back to March 2000), giving 26+ years of monthly history. The headline number is the 12-month change in official share (percentage points). The z-score in the chart and table is computed against the mean/standard deviation of official share across that full history.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Reading it</p>
      <p className="text-paper-dim">The z-score reflects a real, decades-long structural decline — the official share was consistently 60-90% through the 2000s and 2010s and sits in the low 40s now, so recent readings run persistently negative (roughly -2 to -2.5σ) against that long-run mean. Read the z-score as "how stretched is the current level relative to history," and the 12-month change as the tactical, near-term momentum — a negative YoY change on top of an already-negative z-score means central banks are actively accelerating away from an already-low base, not just sitting at a structurally new normal. This indicator is tracked here as a leading, informational signal; it does not yet feed the Big Cycle debt-cycle MP1/MP2/MP3 stage classification.</p>
    </div>
    <p className="text-[10px] text-paper-dim/50 italic">Source: US Department of the Treasury, Treasury International Capital (TIC) System.</p>
  </div>
);

function TicTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[200px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => p.value == null ? null : (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.stroke ?? p.fill ?? p.color }}>{p.name}</span>
          <span className="num text-paper">
            {p.dataKey === "share_pct" ? `${Number(p.value).toFixed(2)}%` : `${Number(p.value) >= 0 ? "+" : ""}${Number(p.value).toFixed(2)}σ`}
          </span>
        </div>
      ))}
    </div>
  );
}

function TicHoldingsDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("tic_foreign_official_holdings")
      .select("*")
      .order("as_of_month", { ascending: true })
      .then(({ data }) => setRows(data ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  // Derive share%, YoY point-change (needs 12 months of lookback), and a
  // z-score of the share level against the full history this table has
  // accumulated so far (grows over time — see TIC_INFO for why).
  const monthlyRows = useMemo(() => {
    if (!rows?.length) return [];
    const sorted = [...rows].sort((a, b) => a.as_of_month.localeCompare(b.as_of_month));
    const shares = sorted.map((r) => Number(r.foreign_official_bn) / Number(r.grand_total_bn) * 100);
    const mean = shares.reduce((s, v) => s + v, 0) / shares.length;
    const sd = Math.sqrt(shares.reduce((s, v) => s + (v - mean) ** 2, 0) / shares.length) || 1;
    return sorted.map((r, i) => ({
      as_of_month: r.as_of_month,
      grand_total_bn: Number(r.grand_total_bn),
      foreign_official_bn: Number(r.foreign_official_bn),
      private_bn: Number(r.grand_total_bn) - Number(r.foreign_official_bn),
      share_pct: Math.round(shares[i] * 100) / 100,
      yoy_change_pts: i >= 12 ? Math.round((shares[i] - shares[i - 12]) * 100) / 100 : null,
      z_score: Math.round(((shares[i] - mean) / sd) * 100) / 100,
    }));
  }, [rows]);

  const xTicks = useMemo(() => {
    const total = monthlyRows.length;
    const step = total > 36 ? 6 : total > 12 ? 3 : 1;
    return monthlyRows.filter((_, i) => i % step === 0).map((r) => r.as_of_month);
  }, [monthlyRows]);

  const tableRows = useMemo(() => {
    const sorted = [...monthlyRows].sort((a, b) => b.as_of_month.localeCompare(a.as_of_month));
    return showFullHistory ? sorted : sorted.slice(0, 24);
  }, [monthlyRows, showFullHistory]);

  function fmtBn(v) { return v == null ? "—" : `$${Number(v).toFixed(0)}B`; }
  function fmtPts(v) { return v == null ? "—" : `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}pts`; }
  function fmtZ(v) { return v == null ? "—" : `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}`; }
  function trendColor(v) { return v == null ? "text-paper-dim" : Number(v) >= 0 ? "text-gain" : "text-loss"; }
  function zColor(v) { return v == null ? "text-paper-dim" : Number(v) <= -1 ? "text-loss" : Number(v) >= 1 ? "text-gain" : "text-brass-soft"; }
  const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" });

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div className={`fixed right-0 top-0 h-full w-[780px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">Foreign Official Share of UST Holdings</h2>
              <button
                onClick={() => setInfoOpen((v) => !v)}
                className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                title="About this indicator"
              >
                i
              </button>
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">Central bank vs. private share of foreign-held Treasuries · Monthly · TIC</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {ind?.current_value != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(ind.current_value) < 0 ? "text-loss" : "text-gain"}`}>
                  {Number(ind.current_value) >= 0 ? "+" : ""}{Number(ind.current_value).toFixed(2)}pts
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">
                  12-Mo Δ{ind?.metadata?.latest_share_pct != null ? ` · now ${Number(ind.metadata.latest_share_pct).toFixed(1)}%` : ""}
                </p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {TIC_INFO}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={monthlyRows} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f38" vertical={false} />
                  <XAxis
                    dataKey="as_of_month"
                    ticks={xTicks}
                    tickFormatter={fmtDate}
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="left"
                    domain={["dataMin - 0.5", "dataMax + 0.5"]}
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                    tickFormatter={(v) => `${v}σ`}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    domain={["dataMin - 2", "dataMax + 2"]}
                    tick={{ fontSize: 10, fill: "#8a8f98" }}
                    axisLine={{ stroke: "#2a2f38" }}
                    tickLine={false}
                    tickFormatter={(v) => `${Math.round(v)}%`}
                  />
                  <ReferenceLine yAxisId="left" y={0} stroke="#8a8f98" strokeOpacity={0.5} />
                  <Tooltip content={<TicTooltip />} labelFormatter={fmtDate} />
                  <Bar yAxisId="left" dataKey="z_score" name="Official Share Z-Score" maxBarSize={16}>
                    {monthlyRows.map((r, i) => (
                      <Cell key={i} fill={r.z_score == null ? "transparent" : r.z_score >= 0 ? "#3FB984" : "#E0635C"} fillOpacity={0.7} />
                    ))}
                  </Bar>
                  <Line yAxisId="right" type="monotone" dataKey="share_pct" name="Official Share Level" stroke="#7030A0" strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#3FB984", opacity: 0.7 }} />Above own historical average (+σ)</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#E0635C", opacity: 0.7 }} />Below own historical average (−σ)</span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-[2px] rounded-sm" style={{ backgroundColor: "#7030A0" }} />
                  Official share level (right axis)
                </span>
              </div>
            </div>
          )}

          {tableRows.length > 0 && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="label text-[10px]">Monthly Detail{showFullHistory ? "" : " · last 24 months"}</p>
                <button
                  onClick={() => setShowFullHistory((v) => !v)}
                  className="text-[10px] text-brass-soft hover:text-brass transition-colors"
                >
                  {showFullHistory ? "Show last 24 months" : "Show full history"}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] min-w-[640px]">
                  <thead>
                    <tr className="text-paper-dim text-[10px]">
                      <th className="text-left pb-2 font-medium pr-2">Month</th>
                      <th className="text-right pb-2 font-medium px-2">Grand Total</th>
                      <th className="text-right pb-2 font-medium px-2">Official</th>
                      <th className="text-right pb-2 font-medium px-2">Official Share</th>
                      <th className="text-right pb-2 font-medium px-2">12-Mo Δ</th>
                      <th className="text-right pb-2 font-medium pl-2">Z-Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.as_of_month} className="border-t border-ink-line/50">
                        <td className="py-1.5 pr-2 text-paper-dim whitespace-nowrap">{fmtDate(r.as_of_month)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtBn(r.grand_total_bn)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtBn(r.foreign_official_bn)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper font-semibold">{r.share_pct.toFixed(2)}%</td>
                        <td className={`py-1.5 px-2 text-right num font-semibold ${trendColor(r.yoy_change_pts)}`}>{fmtPts(r.yoy_change_pts)}</td>
                        <td className={`py-1.5 pl-2 text-right num ${zColor(r.z_score)}`}>{fmtZ(r.z_score)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: US Department of the Treasury, Treasury International Capital (TIC) System — Table 5, Major Foreign Holders of Treasury Securities. Published monthly with a ~6-week lag.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Treasury Convenience Yield (10Y) ────────────────────────────────────────

const CY_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">Treasury Convenience Yield</p>
      <p className="text-paper-dim">10Y SOFR swap rate minus 10Y Treasury yield — the nonpecuniary premium the world pays to hold Treasuries (Krishnamurthy &amp; Vissing-Jorgensen, JPE 2012; the St. Louis Fed uses this same SOFR-based construction). <b>Positive</b> = the US borrows below the true risk-free rate (exorbitant privilege intact). <b>Negative</b> = Treasuries trade cheap to swaps — the subsidy has inverted.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Falsifiability</p>
      <p className="text-paper-dim">A sustained return above zero would falsify the privilege-erosion thesis this card and Gauge 7 are built around. This is a market price, not a debt ratio — unlike debt/GDP, it can move the other way and prove itself wrong.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Methodology</p>
      <p className="text-paper-dim">Source: Pensford's public forward-curve data feed (pensford.com/forward-curve) — both legs from the same feed, same dates, to avoid any date-alignment risk. Chatham Financial (this dashboard's first-choice source) publishes a matching feed but is blocked by Cloudflare bot-detection specifically at this project's server infrastructure. 2Y and 5Y are also tracked (see the underlying data) but not shown as their own cards. 30Y is not available from either source — neither carries a 30Y SOFR swap rate — so the CY Slope (30Y−2Y) card from the original spec isn't built.</p>
    </div>
    <p className="text-[10px] text-paper-dim/50 italic">Source: Pensford forward-curve data (SOFR swaps + Treasury yields), daily since 2007.</p>
  </div>
);

function ConvenienceYieldDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("convenience_yield_observations")
      .select("obs_date, swap_rate_pct, treasury_yield_pct, convenience_bp, is_proxy")
      .eq("tenor_years", 10)
      .order("obs_date", { ascending: true })
      .then(({ data }) => setRows(data ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const xTicks = useMemo(() => {
    if (!rows?.length) return [];
    const step = Math.max(1, Math.floor(rows.length / 10));
    return rows.filter((_, i) => i % step === 0).map((r) => r.obs_date);
  }, [rows]);

  const tableRows = useMemo(() => {
    if (!rows) return [];
    const sorted = [...rows].sort((a, b) => b.obs_date.localeCompare(a.obs_date));
    return showFullHistory ? sorted : sorted.slice(0, 60);
  }, [rows, showFullHistory]);

  const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  const fmtBp = (v) => v == null ? "—" : `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)}bp`;
  const bpColor = (v) => v == null ? "text-paper-dim" : Number(v) >= 0 ? "text-gain" : "text-loss";

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div className={`fixed right-0 top-0 h-full w-[780px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">Treasury Convenience Yield (10Y)</h2>
              <button
                onClick={() => setInfoOpen((v) => !v)}
                className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                title="About this indicator"
              >
                i
              </button>
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">10Y SOFR swap − 10Y Treasury yield · Daily · Pensford</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {ind?.current_value != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(ind.current_value) > 10 ? "text-gain" : Number(ind.current_value) >= -25 ? "text-brass-soft" : "text-loss"}`}>
                  {Number(ind.current_value) >= 0 ? "+" : ""}{Number(ind.current_value).toFixed(1)}bp
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Convenience Yield</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {CY_INFO}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f38" vertical={false} />
                  <XAxis dataKey="obs_date" ticks={xTicks} tickFormatter={fmtDate} tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} tickFormatter={(v) => `${v}%`} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} tickFormatter={(v) => `${v}bp`} />
                  <ReferenceLine yAxisId="right" y={0} stroke="#8a8f98" strokeOpacity={0.5} />
                  <Tooltip
                    labelFormatter={fmtDate}
                    formatter={(v, name) => [name === "Spread (right)" ? fmtBp(v) : `${Number(v).toFixed(2)}%`, name]}
                    contentStyle={{ background: "#1a1d24", border: "1px solid #2a2f38", borderRadius: 6, fontSize: 11 }}
                  />
                  <Area yAxisId="right" type="monotone" dataKey="convenience_bp" name="Spread (right)" stroke="#7030A0" fill="#7030A0" fillOpacity={0.15} strokeWidth={1} />
                  <Line yAxisId="left" type="monotone" dataKey="swap_rate_pct" name="SOFR Swap" stroke="#4A9EFF" strokeWidth={1.5} dot={false} connectNulls />
                  <Line yAxisId="left" type="monotone" dataKey="treasury_yield_pct" name="Treasury Yield" stroke="#E0635C" strokeWidth={1.5} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2px] rounded-sm" style={{ backgroundColor: "#4A9EFF" }} />SOFR Swap</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2px] rounded-sm" style={{ backgroundColor: "#E0635C" }} />Treasury Yield</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#7030A0", opacity: 0.3 }} />Spread = Convenience Yield (right axis)</span>
              </div>
            </div>
          )}

          {tableRows.length > 0 && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="label text-[10px]">Daily Detail{showFullHistory ? "" : " · last 60 days"}</p>
                <button onClick={() => setShowFullHistory((v) => !v)} className="text-[10px] text-brass-soft hover:text-brass transition-colors">
                  {showFullHistory ? "Show last 60 days" : "Show full history"}
                </button>
              </div>
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-[11px] min-w-[560px]">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="text-paper-dim text-[10px]">
                      <th className="text-left pb-2 font-medium pr-2">Date</th>
                      <th className="text-right pb-2 font-medium px-2">SOFR Swap</th>
                      <th className="text-right pb-2 font-medium px-2">Treasury Yield</th>
                      <th className="text-right pb-2 font-medium pl-2">Convenience Yield</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.obs_date} className="border-t border-ink-line/50">
                        <td className="py-1.5 pr-2 text-paper-dim whitespace-nowrap">{fmtDate(r.obs_date)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{Number(r.swap_rate_pct).toFixed(3)}%</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{Number(r.treasury_yield_pct).toFixed(3)}%</td>
                        <td className={`py-1.5 pl-2 text-right num font-semibold ${bpColor(r.convenience_bp)}`}>{fmtBp(r.convenience_bp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: Pensford forward-curve data feed. Daily, no material publication lag.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Foreign Official Custody Holdings ───────────────────────────────────────

const CUSTODY_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">Foreign Official Custody Holdings</p>
      <p className="text-paper-dim">Marketable Treasuries held in custody at the NY Fed for foreign official and international accounts — weekly Wednesday level from the Fed H.4.1 release, ~1-day lag. A leading indicator for the Foreign Official Share of UST Holdings card, which runs on TIC data with a ~2-month publication lag.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Do not reconcile the level</p>
      <p className="text-paper-dim">Custody holdings will never tie to TIC foreign official holdings — custody only captures securities held at FRBNY, not the whole foreign official universe. Track the 13-week and 52-week rate of change; the trend is the signal, not the level.</p>
    </div>
    <p className="text-[10px] text-paper-dim/50 italic">Source: FRED WMTSECL1 (H.4.1 release). Not WMTSECL — that series was discontinued in 2012.</p>
  </div>
);

function CustodyDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("foreign_custody_holdings")
      .select("obs_date, treasury_bn, change_13w_bn, change_52w_bn")
      .order("obs_date", { ascending: true })
      .then(({ data }) => setRows(data ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  const xTicks = useMemo(() => {
    if (!rows?.length) return [];
    const step = Math.max(1, Math.floor(rows.length / 10));
    return rows.filter((_, i) => i % step === 0).map((r) => r.obs_date);
  }, [rows]);

  const tableRows = useMemo(() => {
    if (!rows) return [];
    const sorted = [...rows].sort((a, b) => b.obs_date.localeCompare(a.obs_date));
    return showFullHistory ? sorted : sorted.slice(0, 26);
  }, [rows, showFullHistory]);

  const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  const fmtBn = (v) => v == null ? "—" : `$${Number(v).toFixed(0)}B`;
  const fmtDeltaBn = (v) => v == null ? "—" : `${Number(v) >= 0 ? "+" : ""}$${Number(v).toFixed(1)}B`;
  const deltaColor = (v) => v == null ? "text-paper-dim" : Number(v) >= 0 ? "text-gain" : "text-loss";

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div className={`fixed right-0 top-0 h-full w-[780px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">Foreign Official Custody Holdings</h2>
              <button
                onClick={() => setInfoOpen((v) => !v)}
                className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                title="About this indicator"
              >
                i
              </button>
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">FRBNY custody, Treasuries · Weekly · FRED WMTSECL1</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {ind?.current_value != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(ind.current_value) > 50 ? "text-gain" : Number(ind.current_value) >= -50 ? "text-brass-soft" : "text-loss"}`}>
                  {Number(ind.current_value) >= 0 ? "+" : ""}${Number(ind.current_value).toFixed(0)}B
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">52-Week Δ</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {CUSTODY_INFO}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={rows} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f38" vertical={false} />
                  <XAxis dataKey="obs_date" ticks={xTicks} tickFormatter={fmtDate} tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} tickFormatter={(v) => `$${v}B`} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} tickFormatter={(v) => `$${v}B`} />
                  <ReferenceLine yAxisId="right" y={0} stroke="#8a8f98" strokeOpacity={0.5} />
                  <Tooltip
                    labelFormatter={fmtDate}
                    formatter={(v, name) => [name === "Level (left)" ? fmtBn(v) : fmtDeltaBn(v), name]}
                    contentStyle={{ background: "#1a1d24", border: "1px solid #2a2f38", borderRadius: 6, fontSize: 11 }}
                  />
                  <Bar yAxisId="right" dataKey="change_52w_bn" name="52w Δ" maxBarSize={4}>
                    {rows.map((r, i) => (
                      <Cell key={i} fill={r.change_52w_bn == null ? "transparent" : r.change_52w_bn >= 0 ? "#3FB984" : "#E0635C"} fillOpacity={0.5} />
                    ))}
                  </Bar>
                  <Line yAxisId="left" type="monotone" dataKey="treasury_bn" name="Level (left)" stroke="#7030A0" strokeWidth={1.5} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2px] rounded-sm" style={{ backgroundColor: "#7030A0" }} />Custody level (left axis)</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#3FB984", opacity: 0.5 }} />52w Δ rising (right)</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#E0635C", opacity: 0.5 }} />52w Δ falling (right)</span>
              </div>
            </div>
          )}

          {tableRows.length > 0 && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="label text-[10px]">Weekly Detail{showFullHistory ? "" : " · last 26 weeks"}</p>
                <button onClick={() => setShowFullHistory((v) => !v)} className="text-[10px] text-brass-soft hover:text-brass transition-colors">
                  {showFullHistory ? "Show last 26 weeks" : "Show full history"}
                </button>
              </div>
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-[11px] min-w-[560px]">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="text-paper-dim text-[10px]">
                      <th className="text-left pb-2 font-medium pr-2">Week</th>
                      <th className="text-right pb-2 font-medium px-2">Level</th>
                      <th className="text-right pb-2 font-medium px-2">13w Δ</th>
                      <th className="text-right pb-2 font-medium pl-2">52w Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={r.obs_date} className="border-t border-ink-line/50">
                        <td className="py-1.5 pr-2 text-paper-dim whitespace-nowrap">{fmtDate(r.obs_date)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper font-semibold">{fmtBn(r.treasury_bn)}</td>
                        <td className={`py-1.5 px-2 text-right num ${deltaColor(r.change_13w_bn)}`}>{fmtDeltaBn(r.change_13w_bn)}</td>
                        <td className={`py-1.5 pl-2 text-right num font-semibold ${deltaColor(r.change_52w_bn)}`}>{fmtDeltaBn(r.change_52w_bn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: Federal Reserve Bank of New York / H.4.1 release, via FRED (WMTSECL1). Weekly, Wednesday level.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Indirect Bidder Share (Auction Internals) ───────────────────────────────

const INDIRECT_BIDDER_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">Indirect Bidder Share</p>
      <p className="text-paper-dim">Share of accepted bids from indirect bidders at 10Y and 30Y Treasury auctions — the standard proxy for foreign official and central-bank demand. A falling share means primary dealers are absorbing more of the supply, the price-insensitive-to-price-sensitive substitution this panel exists to track. Shown as a trailing 6-auction average per tenor, then averaged across 10Y and 30Y.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Proxy caveats</p>
      <p className="text-paper-dim">Indirect bidders are a proxy for foreign official demand, not a direct measurement — the category includes any bidder submitting through a primary dealer, broader than just central banks. Dispersion (high yield minus average/median yield, shown in the table) is a bid-dispersion proxy, <b>not the auction tail</b> — a true tail needs the when-issued yield at the bid deadline, which this data source does not carry.</p>
    </div>
    <p className="text-[10px] text-paper-dim/50 italic">Source: US Department of the Treasury, Fiscal Data API (auctions_query). This also now sources the Treasury Bid-to-Cover card, replacing its prior TreasuryDirect path — cross-checked to match exactly on the same auction.</p>
  </div>
);

function IndirectBidderDrawer({ open, onClose, ind }) {
  const [rows, setRows] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    supabase
      .from("treasury_auction_results")
      .select("auction_date, security_term, indirect_share_pct, dealer_share_pct, bid_to_cover_ratio, dispersion_bp")
      .in("security_term", ["10-Year", "30-Year"])
      .not("indirect_share_pct", "is", null)
      .order("auction_date", { ascending: true })
      .then(({ data }) => setRows(data ?? []))
      .catch(() => setRows([]));
  }, [open, rows]);

  // Trailing 6-auction average per term, computed separately (spec: "do not
  // pool tenors"), then merged onto one chart series per term.
  const chartData = useMemo(() => {
    if (!rows) return [];
    const byTerm = { "10-Year": [], "30-Year": [] };
    for (const r of rows) byTerm[r.security_term]?.push(r);
    const avg6 = (arr) => arr.map((r, i) => {
      const w = arr.slice(Math.max(0, i - 5), i + 1);
      return { auction_date: r.auction_date, avg: w.reduce((s, x) => s + Number(x.indirect_share_pct), 0) / w.length };
    });
    const a10 = avg6(byTerm["10-Year"]);
    const a30 = avg6(byTerm["30-Year"]);
    const byDate = new Map();
    for (const r of a10) byDate.set(r.auction_date, { auction_date: r.auction_date, avg10: r.avg });
    for (const r of a30) {
      const existing = byDate.get(r.auction_date) ?? { auction_date: r.auction_date };
      existing.avg30 = r.avg;
      byDate.set(r.auction_date, existing);
    }
    return [...byDate.values()].sort((a, b) => a.auction_date.localeCompare(b.auction_date));
  }, [rows]);

  const tableRows = useMemo(() => {
    if (!rows) return [];
    const sorted = [...rows].sort((a, b) => b.auction_date.localeCompare(a.auction_date));
    return showFullHistory ? sorted : sorted.slice(0, 24);
  }, [rows, showFullHistory]);

  const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  const fmtPct = (v) => v == null ? "—" : `${Number(v).toFixed(1)}%`;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      <div className={`fixed right-0 top-0 h-full w-[780px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">Indirect Bidder Share (10Y/30Y)</h2>
              <button
                onClick={() => setInfoOpen((v) => !v)}
                className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                title="About this indicator"
              >
                i
              </button>
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">Trailing 6-auction average · Treasury Fiscal Data API</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {ind?.current_value != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${Number(ind.current_value) > 65 ? "text-gain" : Number(ind.current_value) >= 55 ? "text-brass-soft" : "text-loss"}`}>
                  {Number(ind.current_value).toFixed(1)}%
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">10Y/30Y avg</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5">
              <CloseIcon />
            </button>
          </div>
        </div>

        {infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {INDIRECT_BIDDER_INFO}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {rows === null ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f38" vertical={false} />
                  <XAxis dataKey="auction_date" tickFormatter={fmtDate} tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10, fill: "#8a8f98" }} axisLine={{ stroke: "#2a2f38" }} tickLine={false} tickFormatter={(v) => `${v}%`} domain={[30, 90]} />
                  <ReferenceLine y={65} stroke="#3FB984" strokeOpacity={0.3} strokeDasharray="3 3" />
                  <ReferenceLine y={55} stroke="#E0635C" strokeOpacity={0.3} strokeDasharray="3 3" />
                  <Tooltip
                    labelFormatter={fmtDate}
                    formatter={(v, name) => [fmtPct(v), name]}
                    contentStyle={{ background: "#1a1d24", border: "1px solid #2a2f38", borderRadius: 6, fontSize: 11 }}
                  />
                  <Line type="monotone" dataKey="avg10" name="10Y (6-auction avg)" stroke="#4A9EFF" strokeWidth={1.5} dot={false} connectNulls />
                  <Line type="monotone" dataKey="avg30" name="30Y (6-auction avg)" stroke="#E0A85C" strokeWidth={1.5} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2px] rounded-sm" style={{ backgroundColor: "#4A9EFF" }} />10Y</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2px] rounded-sm" style={{ backgroundColor: "#E0A85C" }} />30Y</span>
                <span className="text-paper-dim/50">Dashed: healthy ≥65% (green) / danger &lt;55% (red)</span>
              </div>
            </div>
          )}

          {tableRows.length > 0 && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="label text-[10px]">Auction Detail{showFullHistory ? "" : " · last 24"}</p>
                <button onClick={() => setShowFullHistory((v) => !v)} className="text-[10px] text-brass-soft hover:text-brass transition-colors">
                  {showFullHistory ? "Show last 24" : "Show full history"}
                </button>
              </div>
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-[11px] min-w-[620px]">
                  <thead className="sticky top-0 bg-ink-soft">
                    <tr className="text-paper-dim text-[10px]">
                      <th className="text-left pb-2 font-medium pr-2">Date</th>
                      <th className="text-left pb-2 font-medium px-2">Term</th>
                      <th className="text-right pb-2 font-medium px-2">Indirect</th>
                      <th className="text-right pb-2 font-medium px-2">Dealer</th>
                      <th className="text-right pb-2 font-medium px-2">Bid/Cover</th>
                      <th className="text-right pb-2 font-medium pl-2">Dispersion (proxy)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={`${r.auction_date}-${r.security_term}`} className="border-t border-ink-line/50">
                        <td className="py-1.5 pr-2 text-paper-dim whitespace-nowrap">{fmtDate(r.auction_date)}</td>
                        <td className="py-1.5 px-2 text-paper-dim">{r.security_term}</td>
                        <td className="py-1.5 px-2 text-right num text-paper font-semibold">{fmtPct(r.indirect_share_pct)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{fmtPct(r.dealer_share_pct)}</td>
                        <td className="py-1.5 px-2 text-right num text-paper-dim">{r.bid_to_cover_ratio != null ? Number(r.bid_to_cover_ratio).toFixed(2) : "—"}</td>
                        <td className="py-1.5 pl-2 text-right num text-paper-dim">{r.dispersion_bp != null ? `${Number(r.dispersion_bp).toFixed(1)}bp` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            Source: US Department of the Treasury, Fiscal Data API (auctions_query). Dispersion = high yield − average/median yield, a bid-dispersion proxy, not the true auction tail.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Regime vs. Market Analysis ────────────────────────────────────────────────
function RegimeAnalysisCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(refresh = false) {
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-regime-analysis${refresh ? "?refresh=true" : ""}`;
      const res = await fetch(url);
      const j = await res.json();
      if (!j.error) setData(j);
    } catch { /* silent */ }
    setLoading(false);
    setRefreshing(false);
  }

  useEffect(() => { load(); }, []);

  const alignedColor = data?.alignment === "divergent" ? "text-brass-soft" : "text-gain";
  const alignedBorder = data?.alignment === "divergent" ? "border-brass/20" : "border-gain/20";
  const alignedLabel = data?.alignment === "divergent"
    ? `⚑ Divergence · ${data.structural_regime} vs ${data.market_regime}`
    : `✓ Aligned · ${data?.structural_regime ?? ""}`;

  const snapshot = data?.market_snapshot ?? [];
  const generatedAt = data?.generated_at
    ? new Date(data.generated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  if (loading) {
    return (
      <div className="card p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <p className="label">Clio Musings: Current Regime vs. Market Analysis</p>
          <ProvenanceBadge />
        </div>
        <p className="text-paper-dim text-sm">Generating analysis…</p>
      </div>
    );
  }

  if (!data) return null;

  const newsHeadlines = data?.news_headlines ?? [];
  const newsMusing = data?.news_musing ?? null;

  return (
    <>
      <div className={`card p-5 mb-6 border ${alignedBorder}`}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <p className="label">Clio Musings: Current Regime vs. Market Analysis</p>
            <ProvenanceBadge />
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`text-[11px] font-semibold ${alignedColor}`}>{alignedLabel}</span>
            <button
              onClick={() => load(true)}
              disabled={refreshing}
              className="text-[10px] text-paper-dim/50 hover:text-paper-dim transition-colors disabled:opacity-40"
            >
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>
        </div>

        {/* Analysis prose — the "Concrete moves" section renders as a bullet list, the rest as paragraphs */}
        <div className="space-y-3 mb-5">
          {data.analysis.split(/\n\n+/).map((block, i) => {
            const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
            const bulletLines = lines.filter((l) => /^[-*]\s+/.test(l));
            const isBulletBlock = bulletLines.length >= 2 && bulletLines.length >= lines.length - 1;
            if (!isBulletBlock) {
              return <p key={i} className="text-sm text-paper-dim leading-relaxed">{block.trim()}</p>;
            }
            const leadIn = lines.filter((l) => !/^[-*]\s+/.test(l));
            return (
              <div key={i}>
                {leadIn.map((l, j) => (
                  <p key={`lead-${j}`} className="text-sm text-paper-dim leading-relaxed mb-2">{l}</p>
                ))}
                <ul className="list-disc pl-5 space-y-1.5">
                  {bulletLines.map((l, j) => (
                    <li key={j} className="text-sm text-paper-dim leading-relaxed">{l.replace(/^[-*]\s+/, "")}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {/* Market snapshot */}
        {snapshot.length > 0 && (
          <div className="border-t border-ink-line pt-4">
            <p className="label text-[10px] mb-2">Yesterday's Market</p>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              {snapshot.map((m) => (
                <div key={m.name} className="text-center">
                  <p className="text-[10px] text-paper-dim/60 leading-none mb-0.5">{m.name}</p>
                  <p className={`num text-xs font-semibold ${m.changePct >= 0 ? "text-gain" : "text-loss"}`}>
                    {m.changePct >= 0 ? "+" : ""}{m.changePct.toFixed(1)}%
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {generatedAt && (
          <p className="text-[10px] text-paper-dim/40 mt-3">Analysis by Claude · {generatedAt}</p>
        )}
      </div>

      {/* Clio on the News */}
      {(newsHeadlines.length > 0 || newsMusing) && (
        <div className="card p-5 mb-6 border border-ink-line">
          <div className="flex items-center gap-2 mb-4">
            <p className="label">Clio Musings: What the News Is Saying</p>
            <ProvenanceBadge />
          </div>

          {/* Headlines */}
          {newsHeadlines.length > 0 && (
            <div className="space-y-1.5 mb-4">
              {newsHeadlines.map((h, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-[10px] text-paper-dim/40 num mt-0.5 shrink-0">{i + 1}.</span>
                  <div>
                    <span className="text-[11px] text-paper-dim leading-snug">{h.headline}</span>
                    {h.source && (
                      <span className="text-[10px] text-paper-dim/40 ml-1.5">— {h.source}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* News musing prose */}
          {newsMusing && (
            <div className="border-t border-ink-line pt-4 space-y-3">
              {newsMusing.split(/\n\n+/).map((p, i) => (
                <p key={i} className="text-sm text-paper-dim leading-relaxed">{p.trim()}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function MacroDashboard() {
  const [indicators, setIndicators] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [portfolioHoldings, setPortfolioHoldings] = useState([]);
  const [assetData, setAssetData] = useState(null);
  const [debtDrawerOpen, setDebtDrawerOpen] = useState(false);
  const [cpiDrawerOpen, setCpiDrawerOpen] = useState(false);
  const [consumerExpOpen, setConsumerExpOpen] = useState(false);
  const [goldPriceOpen, setGoldPriceOpen] = useState(false);
  const [cbGoldOpen, setCbGoldOpen] = useState(false);
  const [ppiDrawerOpen, setPpiDrawerOpen] = useState(false);
  const [leiDrawerOpen, setLeiDrawerOpen] = useState(false);
  const [t30DrawerOpen, setT30DrawerOpen] = useState(false);
  const [dxyDrawerOpen, setDxyDrawerOpen] = useState(false);
  const [dbcDrawerOpen, setDbcDrawerOpen] = useState(false);
  const [liquidityDrawerOpen, setLiquidityDrawerOpen] = useState(false);
  const [somaDrawerOpen, setSomaDrawerOpen] = useState(false);
  const [ticDrawerOpen, setTicDrawerOpen] = useState(false);
  const [cyDrawerOpen, setCyDrawerOpen] = useState(false);
  const [custodyDrawerOpen, setCustodyDrawerOpen] = useState(false);
  const [indirectBidderDrawerOpen, setIndirectBidderDrawerOpen] = useState(false);
  const [regimeHistory, setRegimeHistory] = useState([]);

  const fetchIndicators = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("macro_indicators")
      .select("*")
      .order("sort_order", { ascending: true });
    if (err) setError(err.message);
    else setIndicators(data ?? []);
  }, []);

  useEffect(() => { fetchIndicators(); }, [fetchIndicators]);

  useEffect(() => { getAssetData().then(setAssetData).catch(() => {}); }, []);

  useEffect(() => {
    supabase
      .from("macro_regime_history")
      .select("period_date,gdp_yoy,cpi_yoy,breakeven,gdp_3y_avg,cpi_3y_avg,structural_key,market_key,forward_key,forward_confidence")
      .order("period_date", { ascending: true })
      .then(({ data }) => { if (data) setRegimeHistory(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase
        .from("holdings_valued")
        .select("id, symbol, name, simulator_key, asset_type, current_value")
        .eq("user_id", user.id);
      setPortfolioHoldings(data ?? []);
    });
  }, []);

  async function refreshData() {
    setRefreshing(true);
    setError("");
    try {
      const { error: fnErr } = await supabase.functions.invoke("fetch-macro-data", {
        method: "POST",
        body: {},
      });
      if (fnErr) setError(fnErr.message ?? "Refresh failed");
      else await fetchIndicators();
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const byLayer = [1, 2, 3, 4].reduce((acc, l) => {
    acc[l] = (indicators ?? []).filter((i) => i.layer === l && !SOVEREIGN_RISK_NAMES.includes(i.name));
    return acc;
  }, {});
  const sovereignRiskIndicators = (indicators ?? [])
    .filter((i) => SOVEREIGN_RISK_NAMES.includes(i.name))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const counts = (indicators ?? []).reduce(
    (acc, i) => { acc[i.status ?? "unknown"] = (acc[i.status ?? "unknown"] ?? 0) + 1; return acc; },
    { healthy: 0, watch: 0, danger: 0, unknown: 0 }
  );

  const lastFetched = (indicators ?? [])
    .map((i) => i.last_fetched_at)
    .filter(Boolean)
    .sort()
    .pop();

  const timeAgo = (iso) => {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    if (h > 23) return `${Math.floor(h / 24)}d ago`;
    if (h > 0) return `${h}h ${m}m ago`;
    return `${m}m ago`;
  };

  const manualCount = (indicators ?? []).filter((i) => i.is_manual && i.current_value == null).length;

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Macro Dashboard</h1>
          {lastFetched && <p className="label mt-0.5">Updated {timeAgo(lastFetched)}</p>}
        </div>
        <button
          onClick={refreshData}
          disabled={refreshing}
          className="px-4 py-1.5 text-sm rounded-lg border border-brass/40 text-brass-soft hover:bg-brass/10 disabled:opacity-50 transition-colors"
        >
          {refreshing ? "Refreshing…" : "Refresh Data"}
        </button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-loss/10 border border-loss/20 text-loss text-sm">
          {error}
        </div>
      )}

      {manualCount > 0 && (
        <div className="mb-5 px-4 py-3 rounded-lg bg-brass/5 border border-brass/20 text-brass-soft text-sm flex items-center gap-2">
          <PencilIcon />
          <span>{manualCount} manual indicator{manualCount !== 1 ? "s" : ""} need values — click the pencil icon on those cards to enter them.</span>
        </div>
      )}

      {indicators === null ? (
        <p className="text-paper-dim text-sm py-12 text-center">Loading…</p>
      ) : (
        <>
          <MacroSummary indicators={indicators} />
          <StructuralRegimeCard />
          <QuadrantCard indicators={indicators} holdings={portfolioHoldings} assetData={assetData} />
          <RegimeAnalysisCard />

          {regimeHistory.length > 0 && (
            <div className="card p-5 mb-6">
              <p className="label mb-4">Regime History — Structural vs Market Expectations</p>
              <RegimeHistoryChart data={regimeHistory} />
            </div>
          )}

          <div className="card p-5 mb-6">
            <p className="label mb-4">Economic Release Calendar</p>
            <EconCalendar />
          </div>

          <div className="grid grid-cols-3 gap-3 mb-8">
            {[
              { key: "healthy", label: "Healthy", style: STATUS_STYLE.healthy },
              { key: "watch",   label: "Watch",   style: STATUS_STYLE.watch },
              { key: "danger",  label: "Danger",  style: STATUS_STYLE.danger },
            ].map(({ key, label, style }) => (
              <div key={key} className={`card p-4 text-center border ${style.border}`}>
                <p className={`text-3xl font-bold ${style.text}`}>{counts[key] ?? 0}</p>
                <p className="label mt-1">{label}</p>
              </div>
            ))}
          </div>

          {[1, 2, 3, 4].map((layer) => (
            <div key={layer} className="mb-10">
              <div className="flex items-center gap-3 mb-3">
                <span className="w-6 h-6 rounded-full bg-ink-soft flex items-center justify-center text-xs font-bold text-paper-dim">
                  {layer}
                </span>
                <h2 className="text-sm font-semibold text-paper-dim uppercase tracking-wider">
                  {LAYER_NAMES[layer]}
                </h2>
              </div>

              {layer === 1 && <DalioGauges gaugeKeys={["gauge1", "gauge5", "gauge6"]} />}
              {layer === 2 && <DalioGauges gaugeKeys={["gauge2"]} />}
              {layer === 3 && <DalioGauges gaugeKeys={["gauge3", "pipeline"]} />}
              {layer === 4 && <DalioGauges gaugeKeys={["gauge4"]} />}

              {byLayer[layer].length === 0 ? (
                <p className="text-paper-dim text-sm ml-9">No data yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {byLayer[layer].map((ind) => (
                    <IndicatorCard
                      key={ind.id}
                      ind={ind}
                      onSave={fetchIndicators}
                      note={
                        ind.name === "DBC Commodity Index"
                          ? "A rising dollar = falling commodities = higher bond prices. A falling dollar = rising commodities = lower bond prices."
                          : undefined
                      }
                      onClick={
                          ind.name === "Total Debt / GDP" ? () => setDebtDrawerOpen(true)
                          : ind.name === "Core CPI (YoY)" ? () => setCpiDrawerOpen(true)
                          : ind.name === "Consumer Inflation Expectations" ? () => setConsumerExpOpen(true)
                          : ind.name === "Gold Price (3M Avg)" ? () => setGoldPriceOpen(true)
                          : ind.name === "CB Gold Reserves (YoY)" ? () => setCbGoldOpen(true)
                          : ind.name === "PPI (YoY)" ? () => setPpiDrawerOpen(true)
                          : ind.name === "Conference Board LEI" ? () => setLeiDrawerOpen(true)
                          : ind.name === "30Y Treasury Yield" ? () => setT30DrawerOpen(true)
                          : ind.name === "DXY" ? () => setDxyDrawerOpen(true)
                          : ind.name === "DBC Commodity Index" ? () => setDbcDrawerOpen(true)
                          : ind.name === "US Total Liquidity Composite" ? () => setLiquidityDrawerOpen(true)
                          : ind.name === "Fed SOMA Long-Duration Holdings (Δ)" ? () => setSomaDrawerOpen(true)
                          : ind.name === "Foreign Official Share of UST Holdings (YoY Δ)" ? () => setTicDrawerOpen(true)
                          : undefined
                        }
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Sovereign Risk — Market-Priced (Macro Measurement Upgrade Spec, Phase 1) */}
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-3">
              <span className="w-6 h-6 rounded-full bg-ink-soft flex items-center justify-center text-xs font-bold text-paper-dim">
                7
              </span>
              <div>
                <h2 className="text-sm font-semibold text-paper-dim uppercase tracking-wider">
                  Sovereign Risk — Market-Priced
                </h2>
                <p className="label text-[10px] mt-0.5">Falsifiable, market-priced instruments for privilege erosion — distinct from the level-ratio cards above</p>
              </div>
            </div>

            <DalioGauges gaugeKeys={["gauge7"]} />

            {sovereignRiskIndicators.length === 0 ? (
              <p className="text-paper-dim text-sm ml-9">No data yet.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {sovereignRiskIndicators.map((ind) => (
                  <IndicatorCard
                    key={ind.id}
                    ind={ind}
                    onSave={fetchIndicators}
                    onClick={
                        ind.name === "Treasury Convenience Yield (10Y)" ? () => setCyDrawerOpen(true)
                        : ind.name === "Foreign Official Custody Holdings" ? () => setCustodyDrawerOpen(true)
                        : ind.name === "Indirect Bidder Share (10Y/30Y)" ? () => setIndirectBidderDrawerOpen(true)
                        : undefined
                      }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Three Forces — long-cycle historical chart */}
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-6 h-6 rounded-full bg-ink-soft flex items-center justify-center text-xs font-bold text-paper-dim">
                ∞
              </span>
              <div>
                <h2 className="text-sm font-semibold text-paper-dim uppercase tracking-wider">
                  Three Forces — Long Cycle
                </h2>
                <p className="label text-[10px] mt-0.5">Debt · Productivity · Short-term Credit Cycle · 1952–2026</p>
              </div>
            </div>
            <div className="card p-5">
              <ThreeForcesChart />
            </div>
          </div>

          <MacroNews />

        </>
      )}
      <DebtGdpDrawer
        open={debtDrawerOpen}
        onClose={() => setDebtDrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "Total Debt / GDP")?.current_value}
      />
      <CoreCpiDrawer
        open={cpiDrawerOpen}
        onClose={() => setCpiDrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "Core CPI (YoY)")?.current_value}
      />
      <ConsumerExpectationsDrawer
        open={consumerExpOpen}
        onClose={() => setConsumerExpOpen(false)}
        currentValue={indicators?.find((i) => i.name === "Consumer Inflation Expectations")?.current_value}
      />
      <GoldPriceDrawer
        open={goldPriceOpen}
        onClose={() => setGoldPriceOpen(false)}
        ind={indicators?.find((i) => i.name === "Gold Price (3M Avg)")}
      />
      <CbGoldDrawer
        open={cbGoldOpen}
        onClose={() => setCbGoldOpen(false)}
        ind={indicators?.find((i) => i.name === "CB Gold Reserves (YoY)")}
      />
      <PpiDrawer
        open={ppiDrawerOpen}
        onClose={() => setPpiDrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "PPI (YoY)")?.current_value}
      />
      <LeiDrawer
        open={leiDrawerOpen}
        onClose={() => setLeiDrawerOpen(false)}
        ind={indicators?.find((i) => i.name === "Conference Board LEI")}
      />
      <T30Drawer
        open={t30DrawerOpen}
        onClose={() => setT30DrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "30Y Treasury Yield")?.current_value}
      />
      <DxyDrawer
        open={dxyDrawerOpen}
        onClose={() => setDxyDrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "DXY")?.current_value}
      />
      <DbcDrawer
        open={dbcDrawerOpen}
        onClose={() => setDbcDrawerOpen(false)}
        currentValue={indicators?.find((i) => i.name === "DBC Commodity Index")?.current_value}
      />
      <LiquidityDrawer
        open={liquidityDrawerOpen}
        onClose={() => setLiquidityDrawerOpen(false)}
        ind={indicators?.find((i) => i.name === "US Total Liquidity Composite")}
      />
      <SomaDrawer
        open={somaDrawerOpen}
        onClose={() => setSomaDrawerOpen(false)}
        ind={indicators?.find((i) => i.name === "Fed SOMA Long-Duration Holdings (Δ)")}
      />
      <TicHoldingsDrawer
        open={ticDrawerOpen}
        onClose={() => setTicDrawerOpen(false)}
        ind={indicators?.find((i) => i.name === "Foreign Official Share of UST Holdings (YoY Δ)")}
      />
      <ConvenienceYieldDrawer
        open={cyDrawerOpen}
        onClose={() => setCyDrawerOpen(false)}
        ind={indicators?.find((i) => i.name === "Treasury Convenience Yield (10Y)")}
      />
      <CustodyDrawer
        open={custodyDrawerOpen}
        onClose={() => setCustodyDrawerOpen(false)}
        ind={indicators?.find((i) => i.name === "Foreign Official Custody Holdings")}
      />
      <IndirectBidderDrawer
        open={indirectBidderDrawerOpen}
        onClose={() => setIndirectBidderDrawerOpen(false)}
        ind={indicators?.find((i) => i.name === "Indirect Bidder Share (10Y/30Y)")}
      />
    </Shell>
  );
}
