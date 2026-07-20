"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";
import ThreeForcesChart from "../../components/ThreeForcesChart";
import DalioGauges from "../../components/DalioGauges";
import {
  ComposedChart, Line, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  SIMULATOR_KEYS,
  REGIME_DEFAULT_WEIGHTS,
  REGIME_META,
  REGIME_RETURNS,
  SUGGESTED_FUNDS,
  BW_ALLOC,
  detectRegimeKey,
  resolveSimulatorKey,
  getSignalKeys,
  toIntWeights,
} from "../../lib/simulatorKeys";
import { getAssetData } from "../../lib/data/assetReturns";
import { applyNaiveRiskParity, solveTrueRiskParity } from "../../lib/riskParity";

const LAYER_NAMES = {
  1: "Long-term Debt Cycle",
  2: "Short-Term Debt Cycle",
  3: "Business Cycle",
  4: "Tail Risk",
};

const KEY_LABEL = Object.fromEntries(SIMULATOR_KEYS.map((s) => [s.key, s.label]));

const ILLIQUID_KEYS = new Set(["alt_re", "alt_loan", "alt_pp", "alt_other"]);

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

function IndicatorCard({ ind, onSave, onClick }) {
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
        <p className="text-sm font-medium leading-snug">{ind.name}</p>
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

const QUADRANT_TO_REGIME = {
  goldilocks:  "rg_fi",
  reflation:   "rg_ri",
  bust:        "fg_fi",
  stagflation: "fg_ri",
};

const FWD_GROWTH_SIGNALS = [
  { label: "Yield Curve 2/10",  name: "2yr/10yr Yield Spread",     w: 0.25, vote: v => v > 0.5 ? 1 : v >= 0    ? 0 : -1 },
  { label: "Yield Curve 3m/10", name: "3mo/10yr Yield Spread",     w: 0.20, vote: v => v > 1   ? 1 : v >= 0    ? 0 : -1 },
  { label: "Loan Standards",    name: "Sr Loan Officer Survey",    w: 0.20, vote: v => v < 15  ? 1 : v <= 35   ? 0 : -1 },
  { label: "LEI",               name: "Conference Board LEI",      w: 0.15, vote: v => v > 0   ? 1 : v >= -0.3 ? 0 : -1 },
  { label: "HY Spread",         name: "HY Credit Spread (OAS)",   w: 0.10, vote: v => v < 4   ? 1 : v <= 6    ? 0 : -1 },
  { label: "C&I Loans",         name: "C&I Loan Growth (YoY)",    w: 0.10, vote: v => v > 5   ? 1 : v >= 0    ? 0 : -1 },
];
const FWD_INFL_SIGNALS = [
  { label: "Infl Expectations", name: "Consumer Inflation Expectations", w: 0.25, vote: v => v > 4   ? 1 : v >= 2.5 ? 0 : -1 },
  { label: "10Y Breakeven",     name: "10Y Breakeven Inflation",         w: 0.20, vote: v => v > 2.5 ? 1 : v >= 1.5 ? 0 : -1 },
  { label: "Copper 3M",         name: "Copper Price",   w: 0.20, getPct3m: true, vote: v => v > 5   ? 1 : v >= -5  ? 0 : -1 },
  { label: "WTI 3M",            name: "WTI Crude Oil",  w: 0.15, getPct3m: true, vote: v => v > 5   ? 1 : v >= -5  ? 0 : -1 },
  { label: "PPI",               name: "PPI (YoY)",                      w: 0.10, vote: v => v > 3   ? 1 : v >= 0   ? 0 : -1 },
  { label: "M2 Growth",         name: "M2 Growth (YoY)",                w: 0.10, vote: v => v > 8   ? 1 : v >= 3   ? 0 : -1 },
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
  const scoreGroup = (sigs) => {
    let weighted = 0, totalW = 0;
    const scored = sigs.map(s => {
      const val = s.getPct3m ? getPct3m(s.name) : get(s.name);
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
  const THRESH = 0.05;
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
  const confidence = forwardKey && gConf != null && iConf != null
    ? Math.round((gConf + iConf) / 2)
    : null;
  return { growth, infl, gDir, iDir, forwardKey, confidence };
}

// ── Daily Macro Summary ───────────────────────────────────────────────────────

function MacroSummary({ indicators, latestQuadrant }) {
  const get     = (name) => { const i = indicators.find(x => x.name === name); return i?.current_value  != null ? Number(i.current_value)  : null; };
  const getPrev = (name) => { const i = indicators.find(x => x.name === name); return i?.previous_value != null ? Number(i.previous_value) : null; };
  const stat = (name) => indicators.find(x => x.name === name)?.status ?? null;

  const gdp        = get("Real GDP Growth");
  const cpi        = get("CPI (YoY)");
  const coreCpi    = get("Core CPI (YoY)");
  const ppi        = get("PPI (YoY)");
  const breakeven  = get("10Y Breakeven Inflation");
  const gdp3yAvg   = get("GDP Growth (3Y Avg)") ?? 0;
  const unrate     = get("Unemployment Rate");
  const t10y2y     = get("2yr/10yr Yield Spread");
  const t10y3m     = get("3mo/10yr Yield Spread");
  const hySpread   = get("HY Credit Spread (OAS)");
  const lei        = get("Conference Board LEI");
  const sloos      = get("Sr Loan Officer Survey");
  const debtGdp    = get("Total Debt / GDP");
  const inflExp    = get("Consumer Inflation Expectations");
  const breakevenVal = breakeven ?? 2.5;

  const regimeKey = latestQuadrant
    ? (QUADRANT_TO_REGIME[latestQuadrant] ?? null)
    : (gdp != null && cpi != null
        ? detectRegimeKey(gdp, cpi, { breakeven: breakevenVal, gdp3yAvg })
        : null);
  const regime = regimeKey ? REGIME_META[regimeKey] : null;
  const fwd = computeForwardSignal(indicators);
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
    gdp > 2.5   ? `Growth is strong — Real GDP at +${gdp.toFixed(1)}%${gdpTrend}${gdp3yAvg ? `, above the ${gdp3yAvg.toFixed(1)}% trend` : ""}.` :
    gdp > 0.5   ? `Growth is modest — Real GDP at +${gdp.toFixed(1)}%${gdpTrend}${growthAboveTrend ? ", above trend" : ", below trend"}.` :
    gdp > 0     ? `Growth is stalling — Real GDP at +${gdp.toFixed(1)}%${gdpTrend}.` :
                  `Economy is contracting — Real GDP at ${gdp.toFixed(1)}%${gdpTrend}.`;

  // ── Inflation narrative ──
  const inflAboveExp = cpi != null && cpi > breakevenVal;
  const cpiTrend = prevCpi != null && cpi != null ? (cpi > prevCpi + 0.05 ? ", rising" : cpi < prevCpi - 0.05 ? ", easing" : "") : "";
  const inflStr =
    cpi == null ? "Inflation data unavailable." :
    cpi > 5     ? `Inflation is elevated — CPI at ${cpi.toFixed(1)}%${cpiTrend}${coreCpi != null ? `, core at ${coreCpi.toFixed(1)}%` : ""}. Well above the ${breakevenVal.toFixed(1)}% market breakeven.` :
    cpi > 3     ? `Inflation is running hot — CPI at ${cpi.toFixed(1)}%${cpiTrend}${coreCpi != null ? `, core ${coreCpi.toFixed(1)}%` : ""}${inflAboveExp ? `, surprising markets above the ${breakevenVal.toFixed(1)}% breakeven` : ""}.` :
    cpi > 2     ? `Inflation is near target — CPI at ${cpi.toFixed(1)}%${cpiTrend}${coreCpi != null ? `, core ${coreCpi.toFixed(1)}%` : ""}${inflAboveExp ? `, modestly above the ${breakevenVal.toFixed(1)}% breakeven` : ""}.` :
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
  const fwdStr = fwd.forwardKey && fwd.confidence != null
    ? `Forward signals (${fwd.confidence}% confidence) point toward ${REGIME_LABELS[fwd.forwardKey] ?? fwd.forwardKey} — growth momentum is ${fwd.gDir === "up" ? "building" : "fading"}, inflation pressure is ${fwd.iDir === "up" ? "rising" : "easing"}.`
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
          <p className={`text-sm font-semibold ${regimeTextColor}`}>{regime.label}</p>
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
          { short: "GDP",    current: gdp,       prev: prevGdp, dim: "growth",    fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
          { short: "CPI",    current: cpi,       prev: prevCpi, dim: "inflation", fmt: v => `${v.toFixed(1)}%` },
          { short: "PPI",    current: ppi,       prev: prevPpi, dim: "inflation", fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
          { short: "10Y BE", current: breakeven, prev: prevBe,  dim: "inflation", fmt: v => `${v.toFixed(2)}%` },
          { short: "LEI",    current: lei,       prev: prevLei, dim: "growth",    fmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
        ].filter(s => s.current != null && s.prev != null).map(s => {
          const delta = s.current - s.prev;
          const dir   = Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
          const aligns =
            dir === "flat" ? null :
            s.dim === "growth"    ? (dir === "up" ? !!growthRegime : !growthRegime) :
            s.dim === "inflation" ? (dir === "up" ? !!inflRegime   : !inflRegime)   : null;
          return { ...s, delta, dir, aligns };
        });

        if (SIGNALS.length === 0) return null;

        const supporting = SIGNALS.filter(s => s.aligns === true).length;
        const warning    = SIGNALS.filter(s => s.aligns === false).length;
        const scored     = SIGNALS.filter(s => s.aligns !== null).length;

        // Implied directional regime from momentum
        const growthUp  = SIGNALS.filter(s => s.dim === "growth"    && s.dir === "up").length;
        const growthDn  = SIGNALS.filter(s => s.dim === "growth"    && s.dir === "down").length;
        const inflUp    = SIGNALS.filter(s => s.dim === "inflation"  && s.dir === "up").length;
        const inflDn    = SIGNALS.filter(s => s.dim === "inflation"  && s.dir === "down").length;
        const momentumRegimeKey =
          growthUp >= growthDn && inflUp >= inflDn   ? "rg_ri" :
          growthUp >= growthDn && inflDn > inflUp    ? "rg_fi" :
          growthDn > growthUp  && inflUp >= inflDn   ? "fg_ri" : "fg_fi";
        const momentumRegimeLabel = REGIME_LABELS[momentumRegimeKey];
        const momentumDiverges = momentumRegimeKey !== regimeKey;

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
                </div>
              ))}
            </div>
            {momentumDiverges && (
              <p className="text-[10px] text-brass-soft/80">
                ⚑ Momentum points toward <span className="font-semibold">{momentumRegimeLabel}</span> — watch for structural regime shift
              </p>
            )}
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
        end = eoq(new Date(end.getTime() - 864e5)); // day before = prev quarter
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

function RegimeHistoryChart({ data }) {
  const [tooltip, setTooltip] = useState(null);

  const sorted = [...data].sort((a, b) => a.period_date.localeCompare(b.period_date));
  if (sorted.length === 0) return <p className="text-xs text-paper-dim">No history data yet.</p>;

  const concordance = sorted.filter(r => r.structural_key === r.market_key).length / sorted.length;
  const divergences = sorted.filter(r => r.structural_key !== r.market_key);
  const CELL_W = 10;

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
      </div>

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

function QuadrantCard({ indicators, holdings, assetData, latestQuadrant }) {
  const gdp        = indicators.find((i) => i.name === "Real GDP Growth");
  const cpi        = indicators.find((i) => i.name === "CPI (YoY)");
  const ism        = indicators.find((i) => i.name === "ISM Manufacturing PMI" || i.name === "ISM New Orders");
  const breakeven  = indicators.find((i) => i.name === "10Y Breakeven Inflation");
  const gdp3yAvg   = indicators.find((i) => i.name === "GDP Growth (3Y Avg)");
  const cpi3yAvg   = indicators.find((i) => i.name === "CPI Growth (3Y Avg)");

  const breakevenVal = breakeven?.current_value != null ? Number(breakeven.current_value) : 2.5;
  const gdp3yAvgVal  = gdp3yAvg?.current_value  != null ? Number(gdp3yAvg.current_value)  : 0;
  const cpi3yAvgVal  = cpi3yAvg?.current_value  != null ? Number(cpi3yAvg.current_value)  : null;

  // Use the same quadrant source as the Three Forces chart (3-yr trailing avg);
  // fall back to expectation-based detectRegimeKey only when DB data isn't ready.
  const regimeKey = latestQuadrant
    ? (QUADRANT_TO_REGIME[latestQuadrant] ?? null)
    : (gdp?.current_value != null && cpi?.current_value != null
        ? detectRegimeKey(Number(gdp.current_value), Number(cpi.current_value), {
            breakeven: breakevenVal,
            gdp3yAvg:  gdp3yAvgVal,
          })
        : null);

  const regime = regimeKey ? REGIME_META[regimeKey] : null;

  // Market-expectations regime: always computed fresh from actuals vs. T10YIE / GDP trend.
  // Separate from regimeKey (which comes from the structural 3Y-trailing DB quadrant).
  const marketRegimeKey = gdp?.current_value != null && cpi?.current_value != null
    ? detectRegimeKey(Number(gdp.current_value), Number(cpi.current_value), {
        breakeven: breakevenVal,
        gdp3yAvg:  gdp3yAvgVal,
      })
    : null;
  const marketMeta = marketRegimeKey ? REGIME_META[marketRegimeKey] : null;
  const fwd = computeForwardSignal(indicators);

  const [allocMethod, setAllocMethod] = useState("bw");

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

  // Group holdings by resolved simulator key
  const byKey = {};
  let grandTotal = 0;
  for (const h of holdings ?? []) {
    const val = Number(h.current_value ?? 0);
    if (val <= 0) continue;
    const key = resolveSimulatorKey(h);
    if (!key) continue;
    if (!byKey[key]) byKey[key] = { holdings: [], total: 0 };
    byKey[key].holdings.push(h);
    byKey[key].total += val;
    grandTotal += val;
  }

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

  // Portfolio action rows: for each holding, compute add/sell delta vs. suggested allocation.
  // Delta is distributed proportionally across holdings sharing the same bucket.
  const actionRows = hasPortfolio && regimeKey && grandTotal > 0
    ? (holdings ?? []).flatMap((h) => {
        const key = resolveSimulatorKey(h);
        if (!key) return [];
        const currentVal = Number(h.current_value ?? 0);
        if (currentVal <= 0) return [];
        const currentPct = (currentVal / grandTotal) * 100;
        const bucketTargetPct = suggestedPcts[key] ?? 0;
        const bucketTotal = byKey[key]?.total ?? 0;
        const holdingShare = bucketTotal > 0 ? currentVal / bucketTotal : 1;
        const holdingTargetPct = bucketTargetPct * holdingShare;
        const targetVal = (holdingTargetPct / 100) * grandTotal;
        const deltaVal = targetVal - currentVal;
        const isIlliquid = ILLIQUID_KEYS.has(key);
        return [{
          symbol: h.symbol ?? h.name ?? "—",
          name: h.name,
          currentVal,
          currentPct,
          newPct: holdingTargetPct,
          newVal: isIlliquid && deltaVal < 0 ? currentVal : targetVal,
          deltaVal,
          isIlliquid,
          key,
        }];
      }).sort((a, b) => Math.abs(b.deltaVal) - Math.abs(a.deltaVal))
    : [];

  // New buy recommendations: buckets with a target weight but no existing holdings
  const buyRows = hasPortfolio && regimeKey && grandTotal > 0
    ? Object.entries(suggestedPcts)
        .filter(([k, pct]) => pct > 0 && !byKey[k])
        .map(([k, pct]) => ({
          key: k,
          label: KEY_LABEL[k] ?? k,
          targetPct: pct,
          targetVal: (pct / 100) * grandTotal,
        }))
        .sort((a, b) => b.targetPct - a.targetPct)
    : [];

  return (
    <div className="card p-5 mb-6">
      <p className="label mb-3">Current Macro Regime</p>
      {regime ? (
        <div className="space-y-5">

          {/* Regime label + key indicators */}
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <p className={`text-2xl font-bold ${regime.color}`}>{regime.label}</p>
              <p className="text-paper-dim text-sm mt-1">{regime.desc}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {/* GDP: actual vs 3-year trend */}
              <div className="bg-ink-soft rounded-lg px-3 py-1.5">
                <p className="label text-[10px]">GDP Growth</p>
                <p className="num text-sm">{formatValue(gdp?.current_value, "%")}</p>
                {gdp3yAvg?.current_value != null && (
                  <p className="text-[10px] text-paper-dim mt-0.5">
                    {Number(gdp.current_value) > gdp3yAvgVal
                      ? <span className="text-gain">↑</span>
                      : <span className="text-loss">↓</span>
                    }{" "}
                    trend {gdp3yAvgVal.toFixed(1)}%
                  </p>
                )}
              </div>
              {/* CPI: actual vs 10Y breakeven */}
              <div className="bg-ink-soft rounded-lg px-3 py-1.5">
                <p className="label text-[10px]">CPI YoY</p>
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
              </div>
              {/* ISM PMI */}
              <div className="bg-ink-soft rounded-lg px-3 py-1.5">
                <p className="label text-[10px]">ISM PMI</p>
                <p className="num text-sm">{formatValue(ism?.current_value, "index")}</p>
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
                  <p className="text-[10px] text-paper-dim">3-year trailing averages</p>
                </div>
                <div className="px-3 py-2 border-l border-ink-line">
                  <p className="label text-[10px]">Market Expectations</p>
                  <p className="text-[10px] text-paper-dim">Actuals vs. market-priced levels</p>
                </div>
              </div>

              {/* Growth row */}
              <div className="grid grid-cols-3 border-b border-ink-line">
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-1">Growth</p>
                  <p className="num text-sm">{formatValue(gdp?.current_value, "%")}</p>
                </div>
                <div className="px-3 py-3 border-l border-ink-line">
                  <p className="text-[10px] text-paper-dim mb-1">3Y avg — is trend positive?</p>
                  {gdp3yAvg?.current_value != null ? (
                    <>
                      <p className={`font-medium ${gdp3yAvgVal > 0 ? "text-gain" : "text-loss"}`}>
                        {gdp3yAvgVal > 0 ? "↑ Expanding" : "↓ Contracting"}
                      </p>
                      <p className="num text-[11px] text-paper-dim mt-0.5">{gdp3yAvgVal.toFixed(2)}% 3Y avg</p>
                    </>
                  ) : <p className="text-paper-dim text-[11px]">Pending refresh</p>}
                </div>
                <div className="px-3 py-3 border-l border-ink-line">
                  <p className="text-[10px] text-paper-dim mb-1">Current vs 3Y trend — surprise?</p>
                  {gdp?.current_value != null && gdp3yAvg?.current_value != null ? (
                    <>
                      <p className={`font-medium ${Number(gdp.current_value) > gdp3yAvgVal ? "text-gain" : "text-loss"}`}>
                        {Number(gdp.current_value) > gdp3yAvgVal ? "↑ Above trend" : "↓ Below trend"}
                      </p>
                      <p className="num text-[11px] text-paper-dim mt-0.5">trend {gdp3yAvgVal.toFixed(2)}%</p>
                    </>
                  ) : <p className="text-paper-dim text-[11px]">Pending refresh</p>}
                </div>
              </div>

              {/* Inflation row */}
              <div className="grid grid-cols-3 border-b border-ink-line">
                <div className="px-3 py-3">
                  <p className="label text-[10px] mb-1">Inflation</p>
                  <p className="num text-sm">{formatValue(cpi?.current_value, "%")}</p>
                </div>
                <div className="px-3 py-3 border-l border-ink-line">
                  <p className="text-[10px] text-paper-dim mb-1">CPI 3Y avg — above 2% target?</p>
                  {cpi3yAvgVal != null ? (
                    <>
                      <p className={`font-medium ${cpi3yAvgVal > 2 ? "text-loss" : "text-gain"}`}>
                        {cpi3yAvgVal > 2 ? "↑ Above target" : "↓ Contained"}
                      </p>
                      <p className="num text-[11px] text-paper-dim mt-0.5">{cpi3yAvgVal.toFixed(2)}% 3Y avg</p>
                    </>
                  ) : <p className="text-paper-dim text-[11px]">Pending refresh</p>}
                </div>
                <div className="px-3 py-3 border-l border-ink-line">
                  <p className="text-[10px] text-paper-dim mb-1">CPI vs T10YIE — surprising markets?</p>
                  {cpi?.current_value != null && breakeven?.current_value != null ? (
                    <>
                      <p className={`font-medium ${Number(cpi.current_value) > breakevenVal ? "text-loss" : "text-gain"}`}>
                        {Number(cpi.current_value) > breakevenVal ? "↑ Surprising up" : "↓ In check"}
                      </p>
                      <p className="num text-[11px] text-paper-dim mt-0.5">T10YIE {breakevenVal.toFixed(2)}%</p>
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
                  {regime ? (
                    <>
                      <p className={`font-semibold ${regime.color}`}>{regime.label}</p>
                      <p className="text-[11px] text-paper-dim mt-0.5">{regime.desc}</p>
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

            {/* Agreement / divergence banner */}
            {regimeKey && marketRegimeKey && (
              <div className={`mt-3 rounded-lg px-3 py-2 text-xs flex items-center gap-2 ${
                regimeKey === marketRegimeKey
                  ? "bg-gain/10 text-gain border border-gain/20"
                  : "bg-brass/10 text-brass-soft border border-brass/20"
              }`}>
                {regimeKey === marketRegimeKey
                  ? "✓ Both lenses agree — regime signal is clear"
                  : "⚠ Lenses diverge — markets may be pricing a regime shift"
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
                { title: "Growth Momentum", sigs: fwd.growth.signals, dir: fwd.gDir, upLabel: "Expanding", downLabel: "Contracting" },
                { title: "Inflation Momentum", sigs: fwd.infl.signals, dir: fwd.iDir, upLabel: "Rising", downLabel: "Falling" },
              ].map(({ title, sigs, dir, upLabel, downLabel }) => (
                <div key={title} className="bg-ink-soft rounded-lg p-3">
                  <p className="label text-[10px] mb-2">{title}</p>
                  <div className="space-y-1 mb-2">
                    {sigs.map(s => (
                      <div key={s.label} className="flex items-center justify-between">
                        <span className="text-[10px] text-paper-dim">{s.label}</span>
                        <span className={`text-[10px] font-medium ${s.vote > 0 ? "text-gain" : s.vote < 0 ? "text-loss" : "text-paper-dim"}`}>
                          {s.vote == null ? "—" : s.vote > 0 ? "↑" : s.vote < 0 ? "↓" : "→"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="pt-2 border-t border-ink-line">
                    <span className={`text-xs font-semibold ${dir === "up" ? "text-gain" : dir === "down" ? "text-loss" : "text-paper-dim"}`}>
                      {dir === "up" ? `↑ ${upLabel}` : dir === "down" ? `↓ ${downLabel}` : "→ Neutral"}
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
                const changed  = prevSuggestedPcts != null && allocPct !== prevPct;
                return (
                  <div key={key} className="flex items-center gap-3">
                    <span className="text-[11px] text-paper-dim w-[104px] shrink-0 truncate">{label}</span>
                    <div className="flex-1 relative h-4 rounded overflow-hidden bg-ink-line/40">
                      {/* Ghost bar — previous regime */}
                      {prevSuggestedPcts && prevPct > 0 && (
                        <div
                          className="absolute left-0 top-0 h-full rounded transition-[width] duration-700 ease-out"
                          style={{ width: `${prevPct}%`, background: color, opacity: 0.18 }}
                        />
                      )}
                      {/* Current regime bar */}
                      <div
                        className="absolute left-0 top-0 h-full rounded transition-[width] duration-500 ease-out"
                        style={{ width: `${allocPct}%`, background: color, opacity: allocPct > 0 ? 0.75 : 0 }}
                      />
                      {/* Portfolio position marker */}
                      {portPct > 0 && (
                        <div
                          className="absolute top-0 h-full w-px bg-white/50"
                          style={{ left: `${Math.min(portPct, 99)}%` }}
                        />
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
        <p className="label mb-3">Clio Musings: Current Regime vs. Market Analysis</p>
        <p className="text-paper-dim text-sm">Generating analysis…</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className={`card p-5 mb-6 border ${alignedBorder}`}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <p className="label">Clio Musings: Current Regime vs. Market Analysis</p>
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

      {/* Analysis prose */}
      <div className="space-y-3 mb-5">
        {data.analysis.split(/\n\n+/).map((p, i) => (
          <p key={i} className="text-sm text-paper-dim leading-relaxed">{p.trim()}</p>
        ))}
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
  );
}

export default function MacroDashboard() {
  const [indicators, setIndicators] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [portfolioHoldings, setPortfolioHoldings] = useState([]);
  const [assetData, setAssetData] = useState(null);
  const [latestQuadrant, setLatestQuadrant] = useState(null);
  const [debtDrawerOpen, setDebtDrawerOpen] = useState(false);
  const [cpiDrawerOpen, setCpiDrawerOpen] = useState(false);
  const [consumerExpOpen, setConsumerExpOpen] = useState(false);
  const [goldPriceOpen, setGoldPriceOpen] = useState(false);
  const [cbGoldOpen, setCbGoldOpen] = useState(false);
  const [ppiDrawerOpen, setPpiDrawerOpen] = useState(false);
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

  useEffect(() => {
    supabase
      .from("macro_debt_cycle_computed")
      .select("year, quadrant")
      .not("quadrant", "is", null)
      .order("year", { ascending: false })
      .limit(1)
      .single()
      .then(({ data }) => { if (data?.quadrant) setLatestQuadrant(data.quadrant); })
      .catch(() => {});
  }, []);

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
    acc[l] = (indicators ?? []).filter((i) => i.layer === l);
    return acc;
  }, {});

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
          <MacroSummary indicators={indicators} latestQuadrant={latestQuadrant} />
          <StructuralRegimeCard />
          <QuadrantCard indicators={indicators} holdings={portfolioHoldings} assetData={assetData} latestQuadrant={latestQuadrant} />
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

              {layer === 1 && <DalioGauges gaugeKeys={["gauge1", "gauge5"]} />}
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
                      onClick={
                          ind.name === "Total Debt / GDP" ? () => setDebtDrawerOpen(true)
                          : ind.name === "Core CPI (YoY)" ? () => setCpiDrawerOpen(true)
                          : ind.name === "Consumer Inflation Expectations" ? () => setConsumerExpOpen(true)
                          : ind.name === "Gold Price (3M Avg)" ? () => setGoldPriceOpen(true)
                          : ind.name === "CB Gold Reserves (YoY)" ? () => setCbGoldOpen(true)
                          : ind.name === "PPI (YoY)" ? () => setPpiDrawerOpen(true)
                          : undefined
                        }
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

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
    </Shell>
  );
}
