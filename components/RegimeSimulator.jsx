"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyNaiveRiskParity,
  computeRiskContributions,
  getLeverageMultiplier,
  solveTrueRiskParity,
} from "../lib/riskParity";
import { supabase } from "../lib/supabase";
import {
  ALT_KEYS,
  ALT_META,
  buildAltAssets,
  extendCorrMatrix,
  loadAltAssumptions,
  saveAltAssumption,
} from "../lib/altAssets";
import AltConfigPanel from "./AltConfigPanel";

// ── Constants ───────────────────────────────────────────────────────────────

const BORROW_RATE = 4.5; // assumed annual cost of the levered portion (%)

const REGIMES = {
  rg_ri: {
    label: "Reflation",
    desc: "Growth ↑ · Inflation ↑",
    why: "Economy beating growth expectations while prices also run hotter than expected. Favors cyclicals, commodities, EM — hurts nominal bonds as rates rise.",
    returns: { eq: 9, intl: 7, em: 12, nb: -3, tip: 4, com: 14, gld: 5, cash: 1 },
    color: "text-brass-soft",
    activeBg: "bg-brass/10",
  },
  rg_fi: {
    label: "Disinflationary Boom",
    desc: "Growth ↑ · Inflation ↓",
    why: '"Goldilocks" — growth beats expectations while inflation surprises to the downside. Equities and nominal bonds can both do well at once.',
    returns: { eq: 13, intl: 11, em: 8, nb: 7, tip: 2, com: -2, gld: -3, cash: 1 },
    color: "text-gain",
    activeBg: "bg-gain/10",
  },
  fg_ri: {
    label: "Stagflation",
    desc: "Growth ↓ · Inflation ↑",
    why: "Growth disappoints while inflation surprises higher — the central bank can't fix both at once. Equities and nominal bonds both get squeezed; commodities, gold, and TIPS hold up.",
    returns: { eq: -8, intl: -6, em: -4, nb: -6, tip: 3, com: 10, gld: 12, cash: 1 },
    color: "text-loss",
    activeBg: "bg-loss/10",
  },
  fg_fi: {
    label: "Deflationary Bust",
    desc: "Growth ↓ · Inflation ↓",
    why: "Demand collapses faster than expected and prices fall with it. Flight to safety — nominal bonds and cash hold up, growth-sensitive assets fall sharply.",
    returns: { eq: -18, intl: -15, em: -22, nb: 11, tip: 5, com: -12, gld: 3, cash: 1 },
    color: "text-paper-dim",
    activeBg: "bg-ink-line",
  },
};

// Grid order: [top-left, top-right, bottom-left, bottom-right]
// Top row = rising inflation, left col = falling growth.
const QUAD_ORDER = ["fg_ri", "rg_ri", "fg_fi", "rg_fi"];

const EQUITY_KEYS = new Set(["eq", "intl", "em"]);

const DEFAULT_WEIGHTS = {
  eq: 30, intl: 15, em: 5, nb: 25, tip: 10, com: 10, gld: 3, cash: 2,
  // Alt assets start at 0 so they don't affect existing allocations.
  alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Convert fractional weights (0–1) from the solvers to integer slider values summing to budget. */
function toSliderWeights(fractional, budget = 100) {
  const pct = Object.fromEntries(
    Object.entries(fractional).map(([k, v]) => [k, Math.round(v * budget)])
  );
  const drift = budget - Object.values(pct).reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    const top = Object.entries(pct).sort((a, b) => b[1] - a[1])[0][0];
    pct[top] += drift;
  }
  return pct;
}

const sign = (v) => (v > 0 ? "+" : "");

// ── Sub-components ───────────────────────────────────────────────────────────

function AssetSlider({ asset, weight, onChange, onConfigure }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset.color }} />
          <span className="text-sm truncate">{asset.name}</span>
          <span className="label text-[10px] hidden sm:inline opacity-60 shrink-0">vol {asset.vol}%</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onConfigure && (
            <button
              onClick={onConfigure}
              className="text-paper-dim hover:text-brass transition-colors text-sm leading-none"
              title="Configure assumptions"
              aria-label={`Configure ${asset.name} assumptions`}
            >
              ⚙
            </button>
          )}
          <span className="num text-sm w-10 text-right">{weight}%</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={weight}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-brass"
        style={{ height: "3px" }}
      />
    </div>
  );
}

function RiskBar({ asset, pct }) {
  const p = Math.max(0, pct);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: asset.color }} />
          <span>{asset.name}</span>
        </div>
        <span className="num text-paper-dim">{p.toFixed(0)}%</span>
      </div>
      <div className="h-1 bg-ink-line rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-200"
          style={{ width: `${p}%`, background: asset.color }}
        />
      </div>
    </div>
  );
}

function QuadrantTile({ regimeKey, isActive, onClick }) {
  const r = REGIMES[regimeKey];
  return (
    <button
      onClick={onClick}
      className={`p-4 text-left transition-colors ${
        isActive ? r.activeBg : "bg-ink-soft hover:bg-ink"
      }`}
    >
      <p className={`label text-[10px] mb-1 ${isActive ? r.color : ""}`}>{r.label}</p>
      <p className="text-xs text-paper-dim leading-snug">{r.desc}</p>
    </button>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

/**
 * Presentational risk-parity regime simulator.
 *
 * @param {{ assets: Array<{key,name,color,vol}>, corrMatrix: Record<string,Record<string,number>> }} props
 *   assets     — the 8 market assets from the DB (eq, intl, em, nb, tip, com, gld, cash)
 *   corrMatrix — 8×8 correlation matrix built from historical data
 */
export default function RegimeSimulator({ assets, corrMatrix }) {
  // ── Simulator state ──────────────────────────────────────────────────────
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS });
  const [activeRegime, setActiveRegime] = useState("rg_ri");
  const [leverageEnabled, setLeverageEnabled] = useState(false);
  const [targetVol, setTargetVol] = useState(10);

  // ── Persistence state ────────────────────────────────────────────────────
  const [userId, setUserId] = useState(null);
  const [savedAllocations, setSavedAllocations] = useState([]);
  const [currentSavedId, setCurrentSavedId] = useState(null);
  const [allocationName, setAllocationName] = useState("My Allocation");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [showLoadMenu, setShowLoadMenu] = useState(false);
  const loadMenuRef = useRef(null);

  // ── Alternative asset state ──────────────────────────────────────────────
  // Raw DB rows keyed by asset_key; empty = use per-category defaults.
  const [altAssumptions, setAltAssumptions] = useState({});
  // Key of the alt currently being configured; null = no panel open.
  const [editingAltKey, setEditingAltKey] = useState(null);

  // On mount: resolve user, auto-load most recent allocation, and load alt assumptions.
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);

      supabase
        .from("user_portfolio_allocations")
        .select("id, name, weights, leverage_enabled, target_vol, active_regime, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .then(({ data }) => {
          if (!data?.length) return;
          setSavedAllocations(data);
          applyAllocation(data[0]);
        });

      loadAltAssumptions(user.id).then(setAltAssumptions);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close load menu on outside click.
  useEffect(() => {
    if (!showLoadMenu) return;
    function handle(e) {
      if (loadMenuRef.current && !loadMenuRef.current.contains(e.target)) {
        setShowLoadMenu(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showLoadMenu]);

  function applyAllocation(alloc) {
    setWeights({ ...DEFAULT_WEIGHTS, ...alloc.weights });
    setLeverageEnabled(Boolean(alloc.leverage_enabled));
    setTargetVol(Number(alloc.target_vol));
    setActiveRegime(alloc.active_regime ?? "rg_ri");
    setCurrentSavedId(alloc.id);
    setAllocationName(alloc.name ?? "My Allocation");
  }

  async function saveAllocation() {
    setSaving(true);
    setSaveMsg("");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    const payload = {
      user_id: user.id,
      name: allocationName.trim() || "My Allocation",
      weights,
      leverage_enabled: leverageEnabled,
      target_vol: targetVol,
      active_regime: activeRegime,
      updated_at: new Date().toISOString(),
    };

    let id = currentSavedId;
    let error;

    if (id) {
      ({ error } = await supabase
        .from("user_portfolio_allocations")
        .update(payload)
        .eq("id", id)
        .eq("user_id", user.id));
    } else {
      const { data, error: err } = await supabase
        .from("user_portfolio_allocations")
        .insert(payload)
        .select("id")
        .single();
      error = err;
      if (data) { id = data.id; setCurrentSavedId(data.id); }
    }

    setSaving(false);
    if (error) {
      setSaveMsg(error.message);
    } else {
      setSaveMsg("Saved!");
      setSavedAllocations((prev) => {
        const updated = { ...payload, id };
        const exists = prev.find((a) => a.id === id);
        return exists
          ? prev.map((a) => (a.id === id ? updated : a))
          : [updated, ...prev];
      });
      setTimeout(() => setSaveMsg(""), 2500);
    }
  }

  // ── Alt asset integration ────────────────────────────────────────────────

  // Build resolved alt asset objects (vol, profile, regimeReturns) from saved assumptions + defaults.
  const altAssets = useMemo(() => buildAltAssets(altAssumptions), [altAssumptions]);

  // Combined 13-asset array: 8 market + 5 alt.
  const mergedAssets = useMemo(() => [...assets, ...altAssets], [assets, altAssets]);

  // Extend the 8×8 corrMatrix with profile-based correlations for the 5 alt assets.
  const mergedCorrMatrix = useMemo(
    () => extendCorrMatrix(corrMatrix, assets, altAssets),
    [corrMatrix, assets, altAssets]
  );

  /** Save an alt's assumptions to state and immediately persist to DB. */
  async function handleAltSave(assetKey, newAssumptions) {
    setAltAssumptions((prev) => ({
      ...prev,
      [assetKey]: {
        vol: newAssumptions.vol,
        correlation_profile: newAssumptions.correlationProfile,
        regime_returns: newAssumptions.regimeReturns,
      },
    }));
    setEditingAltKey(null);
    if (userId) {
      await saveAltAssumption(userId, assetKey, newAssumptions);
    }
  }

  // ── Derived values ───────────────────────────────────────────────────────

  const regime = REGIMES[activeRegime];
  const total = Object.values(weights).reduce((a, b) => a + b, 0);

  const equityTotal = assets
    .filter((a) => EQUITY_KEYS.has(a.key))
    .reduce((s, a) => s + (weights[a.key] ?? 0), 0);

  const altTotal = ALT_META.reduce((s, m) => s + (weights[m.key] ?? 0), 0);

  // Risk contributions use the full merged asset set so that alt allocations
  // are included in portfolio vol even when they are at a small weight.
  const { portfolioVol, contributions } = useMemo(
    () => computeRiskContributions(weights, mergedAssets, mergedCorrMatrix),
    [weights, mergedAssets, mergedCorrMatrix]
  );

  const leverageMult = useMemo(
    () => (leverageEnabled ? getLeverageMultiplier(portfolioVol, targetVol) : 1),
    [leverageEnabled, portfolioVol, targetVol]
  );

  const { blended, blendedLevered } = useMemo(() => {
    const t = total || 1;
    const b = mergedAssets.reduce((s, a) => {
      // Alt assets carry their own user-supplied regime return estimates.
      // Market assets use the research-synthesised REGIMES constant.
      const ret = ALT_KEYS.has(a.key)
        ? (a.regimeReturns?.[activeRegime] ?? 0)
        : (regime.returns[a.key] ?? 0);
      return s + (weights[a.key] / t) * ret;
    }, 0);
    return {
      blended: b,
      blendedLevered: leverageEnabled
        ? b * leverageMult - (leverageMult - 1) * BORROW_RATE
        : b,
    };
  }, [weights, total, mergedAssets, regime, activeRegime, leverageEnabled, leverageMult]);

  function updateWeight(key, val) {
    setWeights((prev) => ({ ...prev, [key]: val }));
  }

  // ── RP preset helpers ────────────────────────────────────────────────────
  // Cash and all alt assets are excluded from RP optimisation:
  //   • Cash has near-zero vol — including it would push almost all weight to cash.
  //   • Alts are illiquid or have user-estimated inputs; the user controls them manually.
  // The budget for RP is 100 minus the combined cash + alt weights.

  function rpBudget() {
    const cashPct = weights.cash ?? 0;
    const altsPct = ALT_META.reduce((s, m) => s + (weights[m.key] ?? 0), 0);
    return { cashPct, altsPct, budget: Math.max(100 - cashPct - altsPct, 0) };
  }

  function preservedOverrides(cashPct) {
    return {
      cash: cashPct,
      ...Object.fromEntries(ALT_META.map((m) => [m.key, weights[m.key] ?? 0])),
    };
  }

  function applyNaive() {
    const riskAssets = mergedAssets.filter((a) => a.key !== "cash" && !ALT_KEYS.has(a.key));
    const { cashPct, budget } = rpBudget();
    setWeights((prev) => ({
      ...prev,
      ...toSliderWeights(applyNaiveRiskParity(riskAssets), budget),
      ...preservedOverrides(cashPct),
    }));
  }

  function applyTrue() {
    const riskAssets = mergedAssets.filter((a) => a.key !== "cash" && !ALT_KEYS.has(a.key));
    const { cashPct, budget } = rpBudget();
    setWeights((prev) => ({
      ...prev,
      ...toSliderWeights(solveTrueRiskParity(riskAssets, mergedCorrMatrix), budget),
      ...preservedOverrides(cashPct),
    }));
  }

  function applyEqual() {
    const riskAssets = mergedAssets.filter((a) => a.key !== "cash" && !ALT_KEYS.has(a.key));
    const { cashPct, budget } = rpBudget();
    const base = Math.floor(budget / riskAssets.length);
    const eqW = Object.fromEntries(riskAssets.map((a) => [a.key, base]));
    eqW[riskAssets[0].key] += budget - base * riskAssets.length;
    setWeights((prev) => ({
      ...prev,
      ...eqW,
      ...preservedOverrides(cashPct),
    }));
  }

  // ── The alt being edited (null-safe) ─────────────────────────────────────
  const editingAlt = editingAltKey
    ? altAssets.find((a) => a.key === editingAltKey) ?? null
    : null;

  return (
    <div className="space-y-6">
      {/* Save / load bar */}
      <div className="card p-4 flex items-center gap-3 flex-wrap">
        <input
          value={allocationName}
          onChange={(e) => setAllocationName(e.target.value)}
          className="field flex-1 min-w-36 py-1.5 text-sm"
          placeholder="Allocation name…"
          maxLength={80}
        />
        <button
          onClick={saveAllocation}
          disabled={saving || !userId}
          className="btn py-1.5 text-sm shrink-0"
        >
          {saving ? "Saving…" : currentSavedId ? "Save" : "Save allocation"}
        </button>
        {savedAllocations.length > 0 && (
          <div className="relative shrink-0" ref={loadMenuRef}>
            <button
              onClick={() => setShowLoadMenu((v) => !v)}
              className="btn-ghost py-1.5 text-sm"
            >
              Load ▾
            </button>
            {showLoadMenu && (
              <div className="absolute right-0 top-full mt-1 z-30 bg-ink-soft border border-ink-line rounded-xl shadow-xl min-w-52 py-1 overflow-hidden">
                {savedAllocations.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => { applyAllocation(a); setShowLoadMenu(false); }}
                    className={`w-full text-left px-4 py-2.5 text-sm hover:bg-ink transition-colors ${
                      a.id === currentSavedId ? "text-brass-soft" : "text-paper"
                    }`}
                  >
                    <span className="block truncate">{a.name}</span>
                    <span className="label text-[10px] normal-case tracking-normal">
                      {new Date(a.updated_at).toLocaleDateString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                      })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!userId && (
          <span className="text-xs text-paper-dim">Sign in to save</span>
        )}
        {saveMsg && (
          <span className={`text-xs shrink-0 ${saveMsg === "Saved!" ? "text-gain" : "text-loss"}`}>
            {saveMsg}
          </span>
        )}
      </div>

      {/* Disclaimer */}
      <div className="px-4 py-3 rounded-xl bg-ink-soft border border-ink-line text-xs text-paper-dim leading-relaxed">
        Returns are illustrative regime estimates synthesized from published macro/asset-class
        research — not live market data. Use this to stress-test allocation logic and intuition,
        not as a forecasting tool.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

        {/* ── Left: allocation ─────────────────────────────────────────────── */}
        <div className="space-y-5">

          {/* Sliders */}
          <div className="card p-5">
            <p className="label mb-4">Your Allocation</p>
            <div className="space-y-4">

              {/* Equities group */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="label text-[10px]">Equities</span>
                  <span className="num text-[10px] text-paper-dim">{equityTotal}% combined</span>
                </div>
                <div className="pl-3 border-l border-ink-line space-y-4">
                  {assets.filter((a) => EQUITY_KEYS.has(a.key)).map((a) => (
                    <AssetSlider
                      key={a.key}
                      asset={a}
                      weight={weights[a.key] ?? 0}
                      onChange={(v) => updateWeight(a.key, v)}
                    />
                  ))}
                </div>
              </div>

              {/* Other market assets */}
              {assets.filter((a) => !EQUITY_KEYS.has(a.key)).map((a) => (
                <AssetSlider
                  key={a.key}
                  asset={a}
                  weight={weights[a.key] ?? 0}
                  onChange={(v) => updateWeight(a.key, v)}
                />
              ))}

              {/* Alternative Assets group */}
              <div className="space-y-4 pt-2">
                <div className="flex items-center justify-between">
                  <span className="label text-[10px]">Alternative Assets</span>
                  <span className="num text-[10px] text-paper-dim">
                    {altTotal > 0 ? `${altTotal}% combined` : "not allocated"}
                  </span>
                </div>
                <div className="pl-3 border-l border-ink-line space-y-4">
                  {altAssets.map((a) => (
                    <AssetSlider
                      key={a.key}
                      asset={a}
                      weight={weights[a.key] ?? 0}
                      onChange={(v) => updateWeight(a.key, v)}
                      onConfigure={() => setEditingAltKey(a.key)}
                    />
                  ))}
                </div>
                <p className="text-[10px] text-paper-dim leading-relaxed pl-3">
                  Click ⚙ to configure each alt's volatility, correlation profile, and regime
                  return estimates. Assumptions are saved to your account.
                </p>
              </div>
            </div>

            {/* Total */}
            <div
              className={`mt-5 pt-4 border-t border-ink-line flex items-center justify-between num text-xs ${
                total === 100 ? "text-gain" : "text-loss"
              }`}
            >
              <span className="label text-[10px]">Total weight</span>
              <span>{total}%{total !== 100 && " — weights must sum to 100"}</span>
            </div>

            {/* RP preset buttons */}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={applyNaive} className="btn-ghost py-2 text-xs">
                Naive risk parity
              </button>
              <button onClick={applyTrue} className="btn-ghost py-2 text-xs">
                True risk parity
              </button>
              <button onClick={applyEqual} className="btn-ghost py-2 text-xs col-span-2">
                Reset to equal weight
              </button>
            </div>
            <p className="mt-3 text-[10px] text-paper-dim leading-relaxed">
              <span className="text-paper-dim/80 font-medium">Naive</span> — weights ∝ 1/vol,
              ignoring correlation.{" "}
              <span className="text-paper-dim/80 font-medium">True</span> — iterative solver
              equalising marginal risk contributions (correlation-aware). Cash and alternative
              assets are excluded from all three presets — their sliders stay where you set them.
            </p>
          </div>

          {/* Risk contributions */}
          <div className="card p-5">
            <p className="label mb-1">Risk Contribution</p>
            <p className="text-[11px] text-paper-dim mb-4 leading-relaxed">
              Each asset's share of total portfolio variance — accounting for correlation, not
              just volatility. Dollar weight ≠ risk weight.
            </p>
            <div className="space-y-3">
              {mergedAssets
                .filter((a) => (weights[a.key] ?? 0) > 0)
                .map((a) => (
                  <RiskBar key={a.key} asset={a} pct={contributions[a.key] ?? 0} />
                ))}
              {mergedAssets.every((a) => (weights[a.key] ?? 0) === 0) && (
                <p className="text-xs text-paper-dim">No assets allocated.</p>
              )}
            </div>
            <p className="mt-4 text-[10px] text-paper-dim num">
              {leverageEnabled
                ? `Unlevered vol ${portfolioVol.toFixed(1)}% → levered to ${(portfolioVol * leverageMult).toFixed(1)}% (${leverageMult.toFixed(2)}x gross exposure)`
                : `Portfolio vol (correlation-adjusted): ${portfolioVol.toFixed(1)}%`}
            </p>
          </div>

          {/* Leverage */}
          <div className="card p-5">
            <p className="label mb-3">Leverage (Optional)</p>
            <p className="text-[11px] text-paper-dim mb-4 leading-relaxed">
              Risk-balancing shifts dollars toward lower-return safe assets. Bridgewater's All
              Weather restores return by leveraging the entire risk-balanced mix to a target
              volatility — optionally modelled here.
            </p>
            <label className="flex items-center gap-2.5 cursor-pointer mb-4">
              <input
                type="checkbox"
                checked={leverageEnabled}
                onChange={(e) => setLeverageEnabled(e.target.checked)}
                className="accent-brass w-4 h-4 cursor-pointer"
              />
              <span className="text-sm">Include leverage in calculations</span>
            </label>

            {leverageEnabled && (
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-paper-dim">Target volatility</span>
                  <span className="num">{targetVol}%</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={20}
                  value={targetVol}
                  onChange={(e) => setTargetVol(Number(e.target.value))}
                  className="w-full cursor-pointer accent-brass"
                  style={{ height: "3px" }}
                />
                <p className="text-[10px] text-paper-dim pt-1 leading-relaxed">
                  Multiplier:{" "}
                  <span className="text-brass-soft num">{leverageMult.toFixed(2)}x</span>
                  {" · "}Gross exposure:{" "}
                  <span className="text-brass-soft num">{(leverageMult * 100).toFixed(0)}%</span>
                  {" · "}Borrowed portion at an assumed {BORROW_RATE}%/yr cost. Capped at 4x.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Right: regime + results ───────────────────────────────────────── */}
        <div className="space-y-5">

          {/* Quadrant selector */}
          <div className="card overflow-hidden">
            <div className="p-5 pb-3">
              <p className="label mb-3">Economic Regime</p>
              <div className="flex justify-between text-[10px] text-paper-dim px-0.5 mb-1.5">
                <span>← Falling growth</span>
                <span>Rising growth →</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-px bg-ink-line mx-5 rounded-xl overflow-hidden">
              {QUAD_ORDER.map((key) => (
                <QuadrantTile
                  key={key}
                  regimeKey={key}
                  isActive={activeRegime === key}
                  onClick={() => setActiveRegime(key)}
                />
              ))}
            </div>

            <div className="flex justify-between text-[10px] text-paper-dim px-5 pt-1.5 pb-4">
              <span>↑ Rising inflation (top row)</span>
              <span>↓ Falling inflation (bottom row)</span>
            </div>

            {/* Regime explanation */}
            <div className="mx-5 mb-5 px-4 py-3 rounded-xl bg-ink-soft border border-ink-line text-xs leading-relaxed">
              <span className={`font-medium ${regime.color}`}>{regime.label}</span>
              {" — "}
              <span className="text-paper-dim">{regime.why}</span>
            </div>
          </div>

          {/* Projected behavior */}
          <div className="card p-5">
            <p className="label mb-4">Projected Behavior</p>

            {/* Headline blended return */}
            <div className="flex items-center justify-between pb-3 border-b border-ink-line">
              <span className="text-sm text-paper-dim">
                Est. blended return — {regime.label}
                {leverageEnabled && " (levered)"}
              </span>
              <span
                className={`num text-2xl font-semibold ${
                  blendedLevered >= 0 ? "text-gain" : "text-loss"
                }`}
              >
                {sign(blendedLevered)}{blendedLevered.toFixed(1)}%
              </span>
            </div>

            {/* Unlevered comparison */}
            {leverageEnabled && (
              <div className="flex items-center justify-between py-2.5 border-b border-ink-line">
                <span className="text-xs text-paper-dim">— unlevered would have been</span>
                <span
                  className={`num text-sm opacity-60 ${
                    blended >= 0 ? "text-gain" : "text-loss"
                  }`}
                >
                  {sign(blended)}{blended.toFixed(1)}%
                </span>
              </div>
            )}

            {/* Per-asset rows — show all allocated assets (market + alt) */}
            <div className="mt-1">
              {mergedAssets
                .filter((a) => (weights[a.key] ?? 0) > 0)
                .map((a) => {
                  const w = weights[a.key] ?? 0;
                  const ret = ALT_KEYS.has(a.key)
                    ? (a.regimeReturns?.[activeRegime] ?? 0)
                    : (regime.returns[a.key] ?? 0);
                  const contrib = (w / (total || 1)) * ret;
                  return (
                    <div
                      key={a.key}
                      className="flex items-center justify-between py-2.5 border-b border-ink-line last:border-0"
                    >
                      <span className="flex items-center gap-2 text-xs text-paper-dim min-w-0">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: a.color }}
                        />
                        <span className="truncate">{a.name}</span>
                        <span className="num shrink-0 opacity-60">
                          {w}% @ {sign(ret)}{ret}%
                        </span>
                      </span>
                      <span
                        className={`num text-xs shrink-0 ml-3 ${
                          contrib >= 0 ? "text-gain" : "text-loss"
                        }`}
                      >
                        {sign(contrib)}{contrib.toFixed(1)}pp
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Usage note */}
          <p className="text-[11px] text-paper-dim leading-relaxed px-1">
            Pick a regime, adjust the sliders, or click "Naive" vs "True" risk parity to compare
            a 1/vol-only allocation against one that also accounts for how assets move together.
            Try the same allocation across all four quadrants to find which regime it's most
            exposed to. Alternative assets use your configured assumptions — click ⚙ to set them.
          </p>
        </div>
      </div>

      {/* Alt configuration panel — renders as a modal overlay */}
      {editingAlt && (
        <AltConfigPanel
          asset={editingAlt}
          onSave={(assumptions) => handleAltSave(editingAlt.key, assumptions)}
          onClose={() => setEditingAltKey(null)}
        />
      )}
    </div>
  );
}
