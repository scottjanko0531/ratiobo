"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import {
  ResponsiveContainer, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";
import { SIMULATOR_KEYS, resolveSimulatorKey, REGIME_META, ILLIQUID_KEYS, EQUITY_KEYS, computeAllocationDeltas } from "../../lib/simulatorKeys";
import { capexMultipliersBySymbol, mergeExposureMultipliers, CAPEX_REGIME_META } from "../../lib/capexOverlay";
import { marketOverlayMultipliersBySymbol, combineAllOverlays, applyOverlayToTargets, shouldProposeRebalance } from "../../lib/marketOverlayPortfolio";
import { computeBondLensSectorTargets } from "../../lib/bondLensPortfolio";
import { TIER_META } from "../../lib/marketConditionsMeta";
import HoldingDetailDrawer from "../../components/HoldingDetailDrawer";
import StageInfoIcon from "../../components/StageInfoIcon";

const usd = (v) => {
  if (v == null || isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtPct = (v, digits = 2) => {
  if (v == null || isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
};

const gainCls = (v) =>
  v == null ? "text-paper-dim" : Number(v) > 0 ? "text-gain" : Number(v) < 0 ? "text-loss" : "text-paper-dim";

function MonthlyGainTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload;
  if (entry?.gain == null) return null;
  const color = entry.gain >= 0 ? "#3FB984" : "#E0635C";
  return (
    <div className="bg-[#1B212B] border border-[#2A3240] rounded-lg px-3 py-2 text-xs shadow-lg space-y-1">
      <div className="text-[#A8ADB8] mb-0.5">{entry.label}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[#A8ADB8]">Gain/Loss</span>
        <span className="font-medium" style={{ color }}>{entry.gain > 0 ? "+" : ""}{usd(entry.gain)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[#A8ADB8]">Value</span>
        <span className="text-[#F6F4EE] font-medium">{usd(entry.value)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[#A8ADB8]">Cost Basis</span>
        <span className="text-[#F6F4EE] font-medium">{usd(entry.costBasis)}</span>
      </div>
    </div>
  );
}

// Bond Lens (Phase D, lib/bondLensPortfolio.js) sleeve-stats/excluded-holdings/
// gap-notes rendering, shared between the always-on Bond Lens card and the
// preview-before-enable confirmation modal (§6.6) -- both show the exact same
// computeBondLensSectorTargets output, just computed against a different source
// for `use_bond_lens_overlay` (the portfolio's saved flag vs. the pending form
// value), so the rendering itself has one definition instead of two.
function BondLensSleeveDetail({ result, signalRow }) {
  return (
    <>
      {result.sleeveBefore.weight <= 0 ? (
        <p className="text-xs text-paper-dim italic mb-3">
          {result.excluded.length > 0
            ? "No in-scope bond holdings — all bond-like holdings in this portfolio are excluded (see below)."
            : "No bond holdings in scope for this portfolio."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px] mb-3">
            <div>
              <p className="text-[10px] text-paper-dim">Instrument pref <span className="text-paper-dim/50">(display-only)</span></p>
              <p className="text-paper font-medium">{signalRow?.instrument_pref ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] text-paper-dim">Maturity pref <span className="text-paper-dim/50">(display-only)</span></p>
              <p className="text-paper font-medium">{signalRow?.maturity_pref ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] text-paper-dim">Hedge reliable</p>
              <p className={signalRow?.hedge_reliable === true ? "text-gain font-medium" : signalRow?.hedge_reliable === false ? "text-loss font-medium" : "text-paper-dim font-medium"}>
                {signalRow?.hedge_reliable === true ? "Yes" : signalRow?.hedge_reliable === false ? "No" : "Unknown"}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-paper-dim">Curve regime</p>
              <p className="text-paper font-medium">{signalRow?.curve_regime ?? "—"}</p>
            </div>
          </div>

          <div className="border border-ink-line rounded-lg overflow-hidden text-[11px] mb-3">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-1.5 bg-ink-soft/50 border-b border-ink-line text-[10px] text-paper-dim">
              <span>Sleeve</span>
              <span className="text-right">Before</span>
              <span className="text-right">After</span>
            </div>
            {[
              { label: "Weight", before: usd(result.sleeveBefore.weight), after: usd(result.sleeveAfter.weight) },
              {
                label: "Weighted duration",
                before: result.sleeveBefore.weightedDuration != null ? `${result.sleeveBefore.weightedDuration.toFixed(2)}y` : "—",
                after: result.sleeveAfter.weightedDuration != null ? `${result.sleeveAfter.weightedDuration.toFixed(2)}y` : "—",
              },
              ...["nominal", "tips", "bills", "credit"].map((m) => ({
                label: `Mix — ${m}`,
                before: result.sleeveBefore.weight > 0 ? `${((result.sleeveBefore.mix[m] / result.sleeveBefore.weight) * 100).toFixed(0)}%` : "—",
                after: result.sleeveAfter.weight > 0 ? `${((result.sleeveAfter.mix[m] / result.sleeveAfter.weight) * 100).toFixed(0)}%` : "—",
              })),
            ].map((row) => (
              <div key={row.label} className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-1.5 border-b border-ink-line/50 last:border-0">
                <span className="text-paper-dim">{row.label}</span>
                <span className="num text-right text-paper-dim">{row.before}</span>
                <span className="num text-right text-paper font-medium">{row.after}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {(result.proposedNewHoldings ?? []).length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] text-paper-dim mb-1">Proposed substitute instruments</p>
          <ul className="space-y-1">
            {result.proposedNewHoldings.map((p) => (
              <li
                key={p.symbol}
                className="flex items-center justify-between gap-2 text-[11px] border border-dashed border-brass/40 rounded-lg px-2 py-1.5"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-paper font-medium italic">{p.symbol}</span>
                  <span className="text-[9px] uppercase tracking-wide text-brass-soft border border-brass/40 rounded px-1 py-0.5 shrink-0">
                    Proposed — not held
                  </span>
                </span>
                <span className="text-paper-dim shrink-0">{p.key}</span>
                <span className="num text-paper-dim shrink-0">{usd(p.targetVal)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-paper-dim/60 mt-1 leading-relaxed">
            Not held — proposed only. Bond Lens recommends target weights but never creates a holding or places a
            trade; reaching this target would require adding the instrument above manually.
          </p>
        </div>
      )}

      {result.excluded.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] text-paper-dim mb-1">Excluded holdings</p>
          <ul className="space-y-0.5">
            {result.excluded.map((e) => (
              <li key={e.holding.id} className="text-[11px] text-paper-dim">
                <span className="text-paper">{e.holding.symbol}</span> — {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!result.targetReachable && result.gapNotes.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] text-brass-soft mb-1">Target not fully reachable</p>
          <ul className="space-y-0.5">
            {result.gapNotes.map((note, i) => (
              <li key={i} className="text-[11px] text-brass-soft/90">{note}</li>
            ))}
          </ul>
        </div>
      )}

      {signalRow?.explanation?.text && (
        <p className="text-[10px] text-paper-dim/60 leading-relaxed">{signalRow.explanation.text}</p>
      )}
    </>
  );
}

export default function PortfoliosPage() {
  const [portfolios, setPortfolios]           = useState([]);
  const [phMap, setPhMap]                     = useState({}); // portfolio_id -> [holding_id]
  const [holdings, setHoldings]               = useState([]);
  const [accountMap, setAccountMap]           = useState({});
  const [snapMap, setSnapMap]                 = useState({});
  const [snapPriceMap, setSnapPriceMap]       = useState({}); // holding_id -> start-of-day price
  const [periodSnaps, setPeriodSnaps]         = useState({ month: {}, qtr: {}, year: {} });
  const [allTransactions, setAllTransactions] = useState([]);
  const [assetTypes, setAssetTypes]           = useState([]);
  const [txnTypes, setTxnTypes]               = useState([]);
  const [busy, setBusy]                       = useState(true);
  const [analysisMap, setAnalysisMap]         = useState({}); // portfolio_id -> latest analysis row
  const [analysisRunningId, setAnalysisRunningId] = useState(null);
  const [bondInstrumentMetaByHoldingId, setBondInstrumentMetaByHoldingId] = useState({}); // holding_id -> bond_instrument_meta row
  const [bondInstrumentMetaBySymbol, setBondInstrumentMetaBySymbol]       = useState({}); // symbol -> bond_instrument_meta row (held + reference-only substitutes, §6.3)
  const [latestBondLensSignal, setLatestBondLensSignal]                   = useState(null); // global, computed once (bond_lens_signal)
  const [latestBondSignalFlags, setLatestBondSignalFlags]                 = useState(null); // global, computed once (bond_signals.flags)
  const [bondLensPreview, setBondLensPreview]                             = useState(null); // computeBondLensSectorTargets result awaiting Confirm/Cancel (§6.6)
  const [bondLensInfoOpen, setBondLensInfoOpen]                           = useState(false); // honest-framing tooltip toggle

  const [detailHolding, setDetailHolding]     = useState(null);

  const [viewingPortfolio, setViewingPortfolio] = useState(null);
  const [expandedBuckets, setExpandedBuckets]   = useState(new Set()); // empty = all collapsed
  const [editingPortfolio, setEditingPortfolio] = useState(null); // "new" | portfolio obj
  const [form, setForm]     = useState({ portfolio_name: "", description: "", strategy_detail: "", target_allocations: {}, rebalance_band_pct: 5, strategy_framework: "", use_market_overlay: false, use_capex_overlay: false, use_bond_lens_overlay: false });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");

  // ── Data load ────────────────────────────────────────────────────────────────
  async function load() {
    setBusy(true);
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    const ds    = (d) => d.toISOString().slice(0, 10);
    const sub   = (d, n) => { const r = new Date(d); r.setDate(r.getDate() - n); return r; };
    const monthSnap = ds(sub(new Date(now.getFullYear(), now.getMonth(), 1), 1));
    const qtrSnap   = ds(sub(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1), 1));
    const yearSnap  = `${now.getFullYear() - 1}-12-31`;
    const toMap     = (rows) => { const m = {}; for (const r of rows ?? []) m[r.holding_id] = Number(r.market_value ?? 0); return m; };

    const [
      { data: pfData },
      { data: phData },
      { data: hvData },
      { data: acData },
      { data: snaps },
      { data: txns },
      { data: mo },
      { data: qtr },
      { data: yr },
      { data: atData },
      { data: ttData },
      { data: bimData },
      { data: blsData },
      { data: bsData },
    ] = await Promise.all([
      supabase.from("portfolios").select("*").order("portfolio_name"),
      supabase.from("portfolio_holdings").select("portfolio_id, holding_id"),
      supabase.from("holdings_valued").select("*"),
      supabase.from("accounts").select("id, name"),
      supabase.from("portfolio_snapshots").select("holding_id, market_value, price").eq("snapshot_date", today),
      supabase.from("transactions").select("holding_id, txn_type, txn_date, amount, is_reinvested"),
      supabase.rpc("snapshot_at", { snap_date: monthSnap }),
      supabase.rpc("snapshot_at", { snap_date: qtrSnap }),
      supabase.rpc("snapshot_at", { snap_date: yearSnap }),
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order"),
      supabase.from("transaction_types").select("code, label, affects_quantity").eq("is_active", true).order("sort_order"),
      // Bond Lens (Phase D, lib/bondLensPortfolio.js): bond_instrument_meta is a small
      // (31-row) global reference table, fetched once here same as asset_types/
      // transaction_types above rather than per-portfolio. bond_lens_signal's latest
      // row is likewise global and "computed once" (spec §1) -- fetched here instead
      // of per-viewingPortfolio-open (unlike latestMarketScore below) so it's a single
      // shared query across every portfolio view in this session.
      supabase.from("bond_instrument_meta").select("*"),
      supabase.from("bond_lens_signal").select("*").order("as_of_date", { ascending: false }).limit(1),
      // bond_signals.flags.term_premium_degraded is already computed server-side
      // whenever ACM term premium was more than 10 BUSINESS days old at compute
      // time (falls back to THREEFYTP10) -- the ACM-specific staleness check, on
      // top of (not a replacement for) the generic >10-CALENDAR-day signal-stale
      // check against bond_lens_signal.as_of_date above.
      supabase.from("bond_signals").select("as_of_date, flags").order("as_of_date", { ascending: false }).limit(1),
    ]);

    setPortfolios(pfData ?? []);

    const pm = {};
    for (const ph of phData ?? []) {
      if (!pm[ph.portfolio_id]) pm[ph.portfolio_id] = [];
      pm[ph.portfolio_id].push(ph.holding_id);
    }
    setPhMap(pm);
    setHoldings(hvData ?? []);

    const am = {};
    for (const a of acData ?? []) am[a.id] = a.name;
    setAccountMap(am);

    const sm = {}, sp = {};
    for (const s of snaps ?? []) {
      sm[s.holding_id] = Number(s.market_value ?? 0);
      if (s.price != null) sp[s.holding_id] = Number(s.price);
    }
    setSnapMap(sm);
    setSnapPriceMap(sp);

    setPeriodSnaps({ month: toMap(mo), qtr: toMap(qtr), year: toMap(yr) });
    setAllTransactions(txns ?? []);
    setAssetTypes(atData ?? []);
    setTxnTypes(ttData ?? []);

    const bim = {};
    for (const r of bimData ?? []) bim[r.holding_id] = r;
    setBondInstrumentMetaByHoldingId(bim);

    // bondInstrumentMetaBySymbol (§6.3 eligible-instrument substitutes, lib/bondLensPortfolio.js):
    // the same bond_instrument_meta rows already fetched above as `bimData`, re-keyed by SYMBOL
    // instead of holding_id -- no second query needed since bimData is already a `select("*")`
    // over the whole (small, 31+-row) table. Held rows (holding_id set) resolve their symbol via
    // holdings_valued (hvData, already fetched above); reference-only substitute rows (holding_id
    // null, e.g. BIL/IEF) carry their own `symbol` column directly -- equivalent to the suggested
    // `coalesce(holdings.symbol, bond_instrument_meta.symbol)` join, done client-side against data
    // already in hand rather than as a separate query.
    const holdingSymbolById = {};
    for (const h of hvData ?? []) holdingSymbolById[h.id] = h.symbol;
    const bimBySymbol = {};
    for (const r of bimData ?? []) {
      const symbol = r.holding_id != null ? holdingSymbolById[r.holding_id] : r.symbol;
      if (symbol) bimBySymbol[symbol] = r;
    }
    setBondInstrumentMetaBySymbol(bimBySymbol);

    setLatestBondLensSignal(blsData?.[0] ?? null);
    setLatestBondSignalFlags(bsData?.[0]?.flags ?? null);

    setBusy(false);
    loadAnalyses();
  }

  // Latest analysis row per portfolio — ordered desc and reduced in JS since we only
  // need the newest row per portfolio_id, not a full history.
  async function loadAnalyses() {
    const { data } = await supabase
      .from("portfolio_daily_analysis")
      .select("*")
      .order("analysis_date", { ascending: false });
    const map = {};
    for (const row of data ?? []) {
      if (!map[row.portfolio_id]) map[row.portfolio_id] = row;
    }
    setAnalysisMap(map);
  }

  async function runPortfolioAnalysis(portfolioId) {
    setAnalysisRunningId(portfolioId);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/analyze-portfolio-health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolio_id: portfolioId }),
      });
      const row = await res.json();
      if (res.ok && row?.id) {
        setAnalysisMap((prev) => ({ ...prev, [portfolioId]: row }));
      }
    } catch (_) { /* best-effort */ }
    setAnalysisRunningId(null);
  }

  useEffect(() => { load(); }, []);
  // Reset bucket expansion whenever a different portfolio is opened
  useEffect(() => { setExpandedBuckets(new Set()); }, [viewingPortfolio?.id]);

  const [regimeShifts, setRegimeShifts] = useState([]);
  useEffect(() => {
    if (!viewingPortfolio || viewingPortfolio.strategy_framework !== "regime_driven") { setRegimeShifts([]); return; }
    supabase
      .from("portfolio_regime_shifts")
      .select("*")
      .eq("portfolio_id", viewingPortfolio.id)
      .order("shifted_at", { ascending: false })
      .then(({ data }) => setRegimeShifts(data ?? []));
  }, [viewingPortfolio?.id, viewingPortfolio?.strategy_framework]);

  // VAMS-equivalent Bottom-Up resize overlay (same fetch pattern as
  // app/macro/page.jsx's QuadrantCard — duplicated per-page rather than
  // shared, matching this codebase's existing style): per-symbol risk-state
  // signal scales a portfolio's target allocations on top of its own bucket
  // targets. Fetched for both "resize_overlay" (KISS) and "regime_driven"
  // portfolios — asset_resize_rule_config/asset_resize_signals are global,
  // per-symbol tables, so any regime_driven portfolio holding a symbol that
  // already has a backtested rule (e.g. All Weather Alpha's VTI/GLD) picks
  // it up automatically; symbols with no rule just get multiplier 1 (no
  // effect), the same safe fallback used everywhere else this table is read.
  const [resizeSignals, setResizeSignals] = useState({});
  useEffect(() => {
    if (!viewingPortfolio || (viewingPortfolio.strategy_framework !== "resize_overlay" && viewingPortfolio.strategy_framework !== "regime_driven")) { setResizeSignals({}); return; }
    Promise.all([
      supabase.from("asset_resize_rule_config").select("symbol, rule_type, confidence_note"),
      supabase.from("asset_resize_signals").select("symbol, date, reduced, exposure_multiplier, indicator_value").order("date", { ascending: false }),
    ]).then(([{ data: configs }, { data: signals }]) => {
      const configBySymbol = new Map((configs ?? []).map((c) => [c.symbol, c]));
      const latestBySymbol = {};
      for (const s of signals ?? []) {
        if (latestBySymbol[s.symbol]) continue;
        latestBySymbol[s.symbol] = { ...s, ...configBySymbol.get(s.symbol) };
      }
      setResizeSignals(latestBySymbol);
    }).catch(() => setResizeSignals({}));
  }, [viewingPortfolio?.id, viewingPortfolio?.strategy_framework]);
  const resizeExposureMultipliers = useMemo(
    () => Object.fromEntries(Object.entries(resizeSignals).map(([sym, s]) => [sym, Number(s.exposure_multiplier)])),
    [resizeSignals]
  );

  // AI Capex Cycle overlay (see lib/capexOverlay.js, /ai-capex): a second, top-down
  // multiplier per symbol from capex_overlay_symbol_multipliers, merged multiplicatively
  // with the per-symbol resize overlay above. Downside-only (capped at 1). Fetched
  // whenever the portfolio's own framework already surfaces Portfolio Actions, OR it
  // has explicitly opted in via use_capex_overlay (a portfolio outside those two
  // frameworks that turns the flag on still gets the data fetched, even though there's
  // currently no Portfolio Actions block for it to feed).
  const [capexRows, setCapexRows] = useState([]);
  useEffect(() => {
    const framework = viewingPortfolio?.strategy_framework;
    const relevant = viewingPortfolio && (framework === "resize_overlay" || framework === "regime_driven" || viewingPortfolio.use_capex_overlay);
    if (!relevant) { setCapexRows([]); return; }
    supabase.from("capex_overlay_symbol_multipliers")
      .select("symbol, bucket, exposure_multiplier, regime_key, ccsi, shadow_mode, reading_date")
      .then(({ data }) => setCapexRows(data ?? []), () => setCapexRows([]));
  }, [viewingPortfolio?.id, viewingPortfolio?.strategy_framework, viewingPortfolio?.use_capex_overlay]);
  const capexOverlay = useMemo(() => capexMultipliersBySymbol(capexRows), [capexRows]);
  // Whether capex ACTUALLY affects this portfolio's own numbers: gated on this
  // portfolio's own use_capex_overlay toggle, not the global capex_model_config
  // shadow-mode kill switch — a portfolio that opts in gets capex applied to its
  // own Portfolio Actions / Market Conditions Overlay math regardless of the
  // system-wide setting, same independent-per-portfolio-control precedent as
  // use_market_overlay.
  const capexOverlayApplied = Boolean(viewingPortfolio?.use_capex_overlay) && Object.keys(capexOverlay.bySymbol).length > 0;
  const exposureMultipliers = useMemo(
    () => (capexOverlayApplied ? mergeExposureMultipliers(resizeExposureMultipliers, capexOverlay.bySymbol) : resizeExposureMultipliers),
    [resizeExposureMultipliers, capexOverlay, capexOverlayApplied]
  );

  // Regime-driven equity-sector tilt (e.g. "All Weather With Equity
  // Tilting"): a static per-regime weight table, not a live signal like the
  // resize overlay above — just looked up by whichever regime is currently
  // confirmed on the portfolio. Empty for any portfolio with no rows in
  // portfolio_sector_targets (the common case), so this is safe to always
  // query rather than gating on a specific portfolio name.
  const [sectorTargets, setSectorTargets] = useState({});
  useEffect(() => {
    if (!viewingPortfolio || viewingPortfolio.strategy_framework !== "regime_driven" || !viewingPortfolio.current_regime_key) {
      setSectorTargets({});
      return;
    }
    supabase
      .from("portfolio_sector_targets")
      .select("symbol, target_pct_of_bucket")
      .eq("portfolio_id", viewingPortfolio.id)
      .eq("regime_key", viewingPortfolio.current_regime_key)
      .then(({ data }) => {
        setSectorTargets(Object.fromEntries((data ?? []).map((r) => [r.symbol, Number(r.target_pct_of_bucket)])));
      })
      .catch(() => setSectorTargets({}));
  }, [viewingPortfolio?.id, viewingPortfolio?.strategy_framework, viewingPortfolio?.current_regime_key]);

  // Market Conditions overlay (Phase 6) — latest daily tier/exposure_multiplier
  // row, independent of strategy_framework. Fetched whenever a portfolio is
  // open (not gated on use_market_overlay) so the tier/multiplier can be shown
  // even while the flag is off, letting the user decide whether to turn it on.
  const [latestMarketScore, setLatestMarketScore] = useState(null);
  useEffect(() => {
    if (!viewingPortfolio) { setLatestMarketScore(null); return; }
    supabase
      .from("market_conditions_scores")
      .select("date, tier, exposure_multiplier")
      .order("date", { ascending: false })
      .limit(1)
      .then(({ data }) => setLatestMarketScore(data?.[0] ?? null), () => setLatestMarketScore(null));
  }, [viewingPortfolio?.id]);

  // Bond Lens per-portfolio settings (Phase D, lib/bondLensPortfolio.js) --
  // bond_lens_portfolio_settings has no rows yet for any portfolio, so a missing
  // row (maybeSingle returns null, not an error) falls back to the column
  // defaults inside bondLensSettings below rather than being treated as a fetch
  // failure. Fetched per-viewingPortfolio since, unlike the signal row above,
  // this table IS keyed by portfolio_id.
  const [bondLensSettings, setBondLensSettings] = useState(null);
  useEffect(() => {
    if (!viewingPortfolio) { setBondLensSettings(null); return; }
    supabase
      .from("bond_lens_portfolio_settings")
      .select("*")
      .eq("portfolio_id", viewingPortfolio.id)
      .maybeSingle()
      .then(({ data }) => setBondLensSettings(data ?? null), () => setBondLensSettings(null));
  }, [viewingPortfolio?.id]);

  // Overlay only proposes a rebalance on a tier change, so acknowledging it
  // is an explicit write (button click), not something that happens automatically.
  async function markOverlayRebalanced(portfolioId, tier) {
    const { error } = await supabase.from("portfolios").update({ last_rebalanced_tier: tier }).eq("id", portfolioId);
    if (error) return;
    setPortfolios((prev) => prev.map((p) => (p.id === portfolioId ? { ...p, last_rebalanced_tier: tier } : p)));
    setViewingPortfolio((prev) => (prev && prev.id === portfolioId ? { ...prev, last_rebalanced_tier: tier } : prev));
  }

  // Full per-holding snapshot history for the open portfolio, fetched on demand
  // (not part of the page's initial load, which only pulls today's row) — feeds
  // the monthly gain/loss chart below. cost_basis is pulled alongside market_value
  // so contributions/withdrawals can be netted out (see monthlyGainLoss).
  const [monthlySnapHistory, setMonthlySnapHistory] = useState([]);
  useEffect(() => {
    const ids = viewingPortfolio ? (phMap[viewingPortfolio.id] ?? []) : [];
    if (ids.length === 0) { setMonthlySnapHistory([]); return; }
    supabase
      .from("portfolio_snapshots")
      .select("holding_id, snapshot_date, market_value, cost_basis")
      .in("holding_id", ids)
      .order("snapshot_date")
      .then(({ data }) => setMonthlySnapHistory(data ?? []));
  }, [viewingPortfolio?.id, phMap]);

  // Month-end (or as-of-today for the current in-progress month) investment gain
  // checkpoints, diffed month over month for a gain/loss series. Investment gain
  // at a checkpoint = value - cost basis (unrealized P&L), not raw value — since
  // cost basis moves in lockstep with value on a pure contribution/withdrawal
  // (same $ added/removed from both), diffing this nets deposits/transfers out of
  // the bar, leaving only actual investment performance for that month.
  const monthlyGainLoss = useMemo(() => {
    if (monthlySnapHistory.length === 0) return [];
    const byHolding = {};
    for (const r of monthlySnapHistory) (byHolding[r.holding_id] ??= []).push(r);
    for (const arr of Object.values(byHolding)) arr.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

    const sumFieldAt = (field, asOf) => {
      let total = 0, found = 0;
      for (const arr of Object.values(byHolding)) {
        let v = null;
        for (const r of arr) { if (r.snapshot_date <= asOf) v = Number(r[field] ?? 0); else break; }
        if (v != null) { total += v; found++; }
      }
      return found > 0 ? total : null;
    };
    const netAt = (asOf) => {
      const value = sumFieldAt("market_value", asOf);
      const costBasis = sumFieldAt("cost_basis", asOf);
      return { value, costBasis, net: value != null && costBasis != null ? value - costBasis : null };
    };

    const minDate = new Date(monthlySnapHistory.reduce((min, r) => r.snapshot_date < min ? r.snapshot_date : min, monthlySnapHistory[0].snapshot_date));
    const today = new Date();
    const checkpoints = [];
    let cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    const lastMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    while (cursor <= lastMonth) {
      const y = cursor.getFullYear(), m = cursor.getMonth();
      const isCurrentMonth = y === today.getFullYear() && m === today.getMonth();
      const asOf = isCurrentMonth
        ? today.toISOString().slice(0, 10)
        : new Date(y, m + 1, 0).toISOString().slice(0, 10);
      checkpoints.push({ label: cursor.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), asOf });
      cursor = new Date(y, m + 1, 1);
    }

    return checkpoints.map((c, i) => {
      const cur = netAt(c.asOf);
      const prev = i === 0 ? null : netAt(checkpoints[i - 1].asOf);
      const gain = cur.net != null && prev?.net != null ? cur.net - prev.net : null;
      return { label: c.label, value: cur.value, costBasis: cur.costBasis, gain };
    });
  }, [monthlySnapHistory]);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const holdingsFor = useCallback((pfId) => {
    const ids = new Set(phMap[pfId] ?? []);
    return holdings.filter((h) => ids.has(h.id));
  }, [phMap, holdings]);

  // Bond Lens overlay (Phase D, lib/bondLensPortfolio.js) -- per-portfolio bond-sleeve
  // duration tilt driven by the global bond_lens_signal row fetched once in load()
  // above. computeBondLensSectorTargets is only ever CALLED when this portfolio's own
  // use_bond_lens_overlay flag is true -- when it's false, bondLensResult is simply
  // `null`, never "a no-op call that happens to return {}" -- so an off portfolio's
  // computeAllocationDeltas call site further below passes the exact same
  // `sectorTargets` object it always did, preserving the required "off == identical
  // to a build without Bond Lens" property (docs/specs/bond-lens.md §6.7 acceptance).
  const bondLensStale = useMemo(() => {
    const asOf = latestBondLensSignal?.as_of_date;
    if (!asOf) return false;
    const days = (Date.now() - new Date(asOf).getTime()) / 86400000;
    return days > 10;
  }, [latestBondLensSignal]);
  // ACM-specific staleness (on top of the generic >10-calendar-day check above):
  // bond_signals.flags.term_premium_degraded is already computed server-side
  // whenever ACM term premium was more than 10 BUSINESS days old at compute time
  // (falls back to THREEFYTP10) -- surfaced as its own warning, doesn't gate
  // bondLensApplied since the signal itself already degraded gracefully server-side.
  const bondLensTermPremiumDegraded = Boolean(latestBondSignalFlags?.term_premium_degraded);
  // Settings object construction factored out so the preview-before-enable flow
  // (savePortfolio, §6.6) can call computeBondLensSectorTargets the exact same way
  // the card below does, against the PENDING form value, without duplicating this.
  const bondLensSettingsForCompute = useMemo(() => ({
    benchmark_duration: bondLensSettings?.benchmark_duration ?? null,
    include_credit: bondLensSettings?.include_credit ?? false,
    min_trade_threshold: bondLensSettings?.min_trade_threshold ?? 0.005,
  }), [bondLensSettings]);
  const bondLensResult = useMemo(() => {
    if (!viewingPortfolio?.use_bond_lens_overlay) return null;
    const hs = holdingsFor(viewingPortfolio.id);
    return computeBondLensSectorTargets(hs, bondInstrumentMetaByHoldingId, latestBondLensSignal, bondLensSettingsForCompute, bondInstrumentMetaBySymbol);
  }, [viewingPortfolio?.id, viewingPortfolio?.use_bond_lens_overlay, holdingsFor, bondInstrumentMetaByHoldingId, latestBondLensSignal, bondLensSettingsForCompute, bondInstrumentMetaBySymbol]);
  // Stale signal (§6.7): hold the last targets and show a warning instead of applying a
  // possibly-stale tilt -- treated as "off" for the sectorTargets merge below, but the
  // card still renders (with the warning) rather than disappearing.
  const bondLensApplied = Boolean(viewingPortfolio?.use_bond_lens_overlay) && !bondLensStale;

  // Bond Lens preview-before-enable (§6.6): closing the preview without confirming
  // discards the WHOLE pending edit's bond-lens intent, not just this field -- the
  // user re-opens Edit and tries again rather than ending up in a partially-applied
  // state. Doesn't touch editingPortfolio/formBusy -- the edit form itself stays open.
  function cancelBondLensPreview() {
    setBondLensPreview(null);
    setForm((f) => ({ ...f, use_bond_lens_overlay: false }));
  }

  function summary(pfId) {
    const hs = holdingsFor(pfId);
    if (hs.length === 0) return { totalValue: 0, costBasis: 0, totalGain: 0, returnPct: null, dayChg: null, monthChg: null, qtrChg: null, ytdChg: null, count: 0 };

    const totalValue = hs.reduce((s, h) => s + Number(h.current_value ?? 0), 0);
    const costBasis  = hs.reduce((s, h) => s + Number(h.cost_basis  ?? 0), 0);

    // Use pre-aggregated view columns — same formula as group rows
    const totalGain = hs.reduce((s, h) =>
      s + Number(h.net_gain ?? 0) + Number(h.total_dividends ?? 0) + Number(h.total_interest ?? 0) - Number(h.total_fees ?? 0), 0);
    const returnPct = costBasis > 0 ? (totalGain / costBasis) * 100 : null;

    const periodChg = (snap) => {
      let prev = 0, found = 0;
      for (const h of hs) { if (snap[h.id] != null) { prev += snap[h.id]; found++; } }
      return found > 0 ? totalValue - prev : null;
    };

    const dayChg = (() => {
      let prev = 0, found = 0;
      for (const h of hs) { if (snapMap[h.id] != null) { prev += snapMap[h.id]; found++; } }
      return found > 0 ? totalValue - prev : null;
    })();
    const dayChgPrev = dayChg != null ? totalValue - dayChg : null;
    const dayChgPct = dayChg != null && dayChgPrev > 0 ? (dayChg / dayChgPrev) * 100 : null;

    // ROI: gain on current value, distinct from returnPct (gain on cost basis) —
    // same convention as app/holdings/page.jsx's "Gain %" vs "ROI %" split.
    const roiPct = totalValue > 0 ? (totalGain / totalValue) * 100 : null;

    return {
      totalValue, costBasis, totalGain, returnPct, roiPct, count: hs.length,
      dayChg, dayChgPct, monthChg: periodChg(periodSnaps.month), qtrChg: periodChg(periodSnaps.qtr), ytdChg: periodChg(periodSnaps.year),
    };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  function openNew() {
    setForm({ portfolio_name: "", description: "", strategy_detail: "", target_allocations: {}, rebalance_band_pct: 5, strategy_framework: "", use_market_overlay: false, use_capex_overlay: false, use_bond_lens_overlay: false });
    setFormError("");
    setEditingPortfolio("new");
  }

  function openEdit(pf) {
    setForm({
      portfolio_name:     pf.portfolio_name,
      description:        pf.description        ?? "",
      strategy_detail:    pf.strategy_detail    ?? "",
      target_allocations: pf.target_allocations ?? {},
      rebalance_band_pct: pf.rebalance_band_pct ?? 5,
      strategy_framework: pf.strategy_framework ?? "",
      use_market_overlay: pf.use_market_overlay ?? false,
      use_capex_overlay:  pf.use_capex_overlay ?? false,
      use_bond_lens_overlay: pf.use_bond_lens_overlay ?? false,
    });
    setFormError("");
    setEditingPortfolio(pf);
  }

  async function savePortfolio(opts) {
    // `opts` is the click event when called directly from the Save button's
    // onClick -- destructuring a non-matching object just falls through to the
    // default, so this stays safe called either way.
    const { bondLensConfirmed = false } = opts ?? {};
    if (!form.portfolio_name.trim()) { setFormError("Name is required."); return; }

    // Bond Lens preview-before-enable (§6.6): turning the flag ON (specifically
    // false -> true on an EXISTING portfolio -- a brand-new portfolio has no
    // holdings yet to preview, so it saves immediately like every other field)
    // blocks the save and shows a confirmation preview of the computed per-holding
    // changes instead of writing anything. Turning off, leaving it unchanged, or
    // having already confirmed this exact save (bondLensConfirmed) proceed as normal.
    const bondLensTurningOn = editingPortfolio !== "new"
      && !Boolean(editingPortfolio.use_bond_lens_overlay)
      && Boolean(form.use_bond_lens_overlay);
    if (bondLensTurningOn && !bondLensConfirmed) {
      const hs = holdingsFor(editingPortfolio.id);
      const preview = computeBondLensSectorTargets(hs, bondInstrumentMetaByHoldingId, latestBondLensSignal, bondLensSettingsForCompute, bondInstrumentMetaBySymbol);
      setBondLensPreview(preview);
      return;
    }

    setFormBusy(true); setFormError("");
    const { data: { user } } = await supabase.auth.getUser();
    const wasRegimeDriven = editingPortfolio !== "new" && editingPortfolio.strategy_framework === "regime_driven";
    const nowRegimeDriven = form.strategy_framework === "regime_driven";
    const payload = {
      portfolio_name:     form.portfolio_name.trim(),
      description:        form.description.trim()  || null,
      strategy_detail:    form.strategy_detail.trim() || null,
      target_allocations: form.target_allocations,
      rebalance_band_pct: form.rebalance_band_pct === "" || form.rebalance_band_pct == null ? 5 : Number(form.rebalance_band_pct),
      strategy_framework: form.strategy_framework || null,
      use_market_overlay: Boolean(form.use_market_overlay),
      use_capex_overlay:  Boolean(form.use_capex_overlay),
      use_bond_lens_overlay: Boolean(form.use_bond_lens_overlay),
      updated_at:         new Date().toISOString(),
      // Turning regime-driven off releases manual control of target_allocations again;
      // turning it on (or switching regimes) resets tracking so the next daily cron
      // treats it as a fresh activation rather than resuming stale state.
      ...(wasRegimeDriven && !nowRegimeDriven ? { current_regime_key: null, regime_confirmed_since: null, pending_regime_key: null, pending_regime_since: null } : {}),
    };
    let error;
    if (editingPortfolio === "new") {
      ({ error } = await supabase.from("portfolios").insert({ ...payload, user_id: user.id }));
    } else {
      ({ error } = await supabase.from("portfolios").update(payload).eq("id", editingPortfolio.id));
      if (!error && viewingPortfolio?.id === editingPortfolio.id) {
        setViewingPortfolio((p) => ({ ...p, ...payload }));
      }
      // Bond Lens toggle log (§6.6) -- only on an actual flip of the flag, compared
      // against the pre-edit portfolio object (not the just-written payload). Fire-
      // and-forget: never blocks or fails the main portfolio save, same as every
      // other read in this file that just swallows a failure (.catch(() => {})).
      if (!error) {
        const oldValue = Boolean(editingPortfolio.use_bond_lens_overlay);
        const newValue = Boolean(form.use_bond_lens_overlay);
        if (oldValue !== newValue) {
          supabase.from("bond_lens_toggle_log").insert({
            portfolio_id: editingPortfolio.id,
            action: newValue ? "enabled" : "disabled",
            old_value: { use_bond_lens_overlay: oldValue },
            new_value: { use_bond_lens_overlay: newValue },
          }).then(() => {}, () => {});
        }
      }
    }
    setFormBusy(false);
    if (error) { setFormError(error.message); return; }
    setBondLensPreview(null);
    setEditingPortfolio(null);
    await load();
  }

  async function deletePortfolio(pf) {
    if (!confirm(`Delete "${pf.portfolio_name}"? Holdings will not be deleted.`)) return;
    await supabase.from("portfolios").delete().eq("id", pf.id);
    if (viewingPortfolio?.id === pf.id) setViewingPortfolio(null);
    load();
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Strategy Portfolios</h1>
            <p className="text-xs text-paper-dim mt-0.5">Group holdings into named strategies for focused tracking</p>
          </div>
          <button onClick={openNew} className="btn text-sm">+ New Portfolio</button>
        </div>

        {/* List */}
        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : portfolios.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-paper-dim text-sm mb-4">No portfolios yet.</p>
            <button onClick={openNew} className="btn text-sm">Create your first portfolio</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {portfolios.map((pf) => {
              const s = summary(pf.id);
              return (
                <button
                  key={pf.id}
                  onClick={() => setViewingPortfolio(pf)}
                  className="card p-4 text-left hover:border-brass/40 transition-colors w-full"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="font-semibold text-sm leading-tight">{pf.portfolio_name}</p>
                    <span className="label text-[10px] shrink-0 mt-0.5">{s.count} holdings</span>
                  </div>
                  {pf.description && (
                    <p className="text-xs text-paper-dim mb-3 line-clamp-2 leading-relaxed">{pf.description}</p>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3">
                    <div>
                      <p className="label text-[10px]">Total Value</p>
                      <p className="num text-sm font-medium">{s.count > 0 ? usd(s.totalValue) : "—"}</p>
                    </div>
                    <div>
                      <p className="label text-[10px]">Total Gain</p>
                      <p className={`num text-sm font-medium ${s.count > 0 ? gainCls(s.totalGain) : "text-paper-dim"}`}>
                        {s.count > 0 ? `${s.totalGain > 0 ? "+" : ""}${usd(s.totalGain)}` : "—"}
                        {s.count > 0 && s.returnPct != null && (
                          <span className="text-[10px] font-normal ml-1">({fmtPct(s.returnPct)})</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="label text-[10px]">ROI</p>
                      <p className={`num text-sm font-medium ${s.count > 0 ? gainCls(s.roiPct) : "text-paper-dim"}`}>
                        {s.count > 0 ? fmtPct(s.roiPct) : "—"}
                      </p>
                    </div>
                    {s.dayChg != null && (
                      <div>
                        <p className="label text-[10px]">Day Chg</p>
                        <p className={`num text-xs ${gainCls(s.dayChg)}`}>
                          {s.dayChg > 0 ? "+" : ""}{usd(s.dayChg)}
                          {s.dayChgPct != null && (
                            <span className="text-[10px] ml-1">({fmtPct(s.dayChgPct)})</span>
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Detail drawer ──────────────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${viewingPortfolio ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${viewingPortfolio ? "opacity-100" : "opacity-0"}`}
          onClick={() => setViewingPortfolio(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-[1400px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${viewingPortfolio ? "translate-x-0" : "translate-x-full"}`}>
          {viewingPortfolio && (() => {
            const pf = viewingPortfolio;
            const hs = holdingsFor(pf.id);
            const s  = summary(pf.id);

            const periodPct = (chg) => {
              if (chg == null) return null;
              const base = s.totalValue - chg;
              return base > 0 ? (chg / base) * 100 : null;
            };

            return (
              <>
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-4 border-b border-ink-line">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="font-semibold text-base">{pf.portfolio_name}</p>
                    {pf.description && <p className="text-xs text-paper-dim mt-0.5">{pf.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => openEdit(pf)} className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors">Edit</button>
                    <button onClick={() => setViewingPortfolio(null)} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
                  </div>
                </div>

                {/* Strategy detail */}
                {pf.strategy_detail && (
                  <div className="px-5 py-3 border-b border-ink-line bg-ink/30">
                    <p className="label text-[10px] mb-1">Strategy</p>
                    <p className="text-xs text-paper-dim leading-relaxed whitespace-pre-wrap">{pf.strategy_detail}</p>
                  </div>
                )}

                {/* Regime-driven status */}
                {pf.strategy_framework === "regime_driven" && (() => {
                  const horizon = pf.regime_signal_horizon === "near_term" ? "near_term" : "medium_term";
                  const confirmDays = horizon === "near_term" ? 7 : 30;
                  const horizonLabel = horizon === "near_term" ? "Near-Term Forward Signal (2-3mo)" : "Medium-Term Forward Signal (6-18mo)";
                  return (
                  <div className="px-5 py-3 border-b border-ink-line bg-ink/30">
                    <p className="label text-[10px] mb-1">Regime-Driven Targets <span className="text-paper-dim/50 normal-case">· driven by {horizonLabel}</span></p>
                    {pf.current_regime_key ? (
                      <p className="text-xs text-paper-dim leading-relaxed">
                        Currently targeting <span className="text-paper font-medium">{REGIME_META[pf.current_regime_key]?.label ?? pf.current_regime_key}</span> weights
                        {pf.regime_confirmed_since && `, confirmed since ${pf.regime_confirmed_since}`}.
                        {pf.pending_regime_key && pf.pending_regime_key !== pf.current_regime_key && (
                          <span className="block mt-1 text-brass-soft">
                            Watching a shift to {REGIME_META[pf.pending_regime_key]?.label ?? pf.pending_regime_key} — confirms after {confirmDays} days if it persists (since {pf.pending_regime_since}).
                          </span>
                        )}
                      </p>
                    ) : (pf.target_allocations && Object.keys(pf.target_allocations).length > 0) ? (
                      <p className="text-xs text-paper-dim italic">Holding a neutral starting baseline — not yet tilted to a specific regime. Waiting for the Forward Signal to clear the 60% confidence floor before adopting regime-specific weights. Can sit here a while if the signal stays low-conviction.</p>
                    ) : (
                      <p className="text-xs text-paper-dim italic">Not yet activated — waiting for the Forward Signal to clear the 60% confidence floor before adopting a starting target. Can sit here a while if the signal stays low-conviction.</p>
                    )}
                    {regimeShifts.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-ink-line/50 space-y-1">
                        {regimeShifts.slice(0, 5).map((r) => (
                          <p key={r.id} className="text-[10px] text-paper-dim/70">
                            {r.shifted_at?.slice(0, 10)} — {r.from_label ? `${r.from_label} → ${r.to_label}` : `Activated at ${r.to_label}`}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })()}

                {/* Summary metrics */}
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-px border-b border-ink-line">
                  {[
                    { label: "Total Value", val: usd(s.totalValue), cls: "" },
                    { label: "Cost Basis",  val: usd(s.costBasis),  cls: "" },
                    { label: "Total Gain",  val: `${s.totalGain > 0 ? "+" : ""}${usd(s.totalGain)}`, cls: gainCls(s.totalGain) },
                    { label: "Return",      val: fmtPct(s.returnPct), cls: gainCls(s.returnPct) },
                  ].map(({ label, val, cls }) => (
                    <div key={label} className="px-3 py-3">
                      <p className="text-[10px] uppercase tracking-wide text-paper-dim mb-0.5">{label}</p>
                      <p className={`num text-sm font-medium ${cls}`}>{val}</p>
                    </div>
                  ))}
                  {[
                    { label: "Day Chg",  chg: s.dayChg },
                    { label: "Mo Chg",   chg: s.monthChg },
                    { label: "Qtr Chg",  chg: s.qtrChg },
                    { label: "YTD Chg",  chg: s.ytdChg },
                  ].map(({ label, chg }) => (
                    <div key={label} className="px-3 py-3">
                      <p className="text-[10px] uppercase tracking-wide text-paper-dim mb-0.5">{label}</p>
                      <p className={`num text-sm font-medium ${gainCls(chg)}`}>
                        {chg == null ? "—" : `${chg > 0 ? "+" : ""}${usd(chg)}`}
                      </p>
                      {chg != null && periodPct(chg) != null && (
                        <p className={`num text-[10px] ${gainCls(chg)}`}>{fmtPct(periodPct(chg))}</p>
                      )}
                    </div>
                  ))}
                </div>

                {/* Gains/Losses by Month */}
                <div className="px-5 py-4 border-b border-ink-line">
                  <p className="label text-[10px] mb-3">Investment Gains / Losses by Month</p>
                  {monthlyGainLoss.filter((m) => m.gain != null).length === 0 ? (
                    <div className="flex items-center justify-center h-[160px]">
                      <p className="text-paper-dim text-sm text-center">
                        {monthlySnapHistory.length === 0 ? "No snapshot history yet." : "Collecting data — check back next month."}
                      </p>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={monthlyGainLoss} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                        <XAxis
                          dataKey="label"
                          tick={{ fill: "#A8ADB8", fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: "#A8ADB8", fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          width={68}
                          tickFormatter={(v) => {
                            const abs = Math.abs(v);
                            const sign = v > 0 ? "+" : v < 0 ? "-" : "";
                            if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
                            if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
                            return `${sign}$${abs.toFixed(0)}`;
                          }}
                        />
                        <Tooltip content={<MonthlyGainTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                        <Bar dataKey="gain" maxBarSize={40} radius={[2, 2, 0, 0]}>
                          {monthlyGainLoss.map((entry, i) => (
                            <Cell
                              key={i}
                              fill={entry.gain == null ? "transparent" : entry.gain >= 0 ? "#3FB984" : "#E0635C"}
                              fillOpacity={0.7}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {/* Daily Analysis */}
                <div className="px-5 py-4 border-b border-ink-line">
                  {(() => {
                    const a = analysisMap[pf.id];
                    const running = analysisRunningId === pf.id;
                    const isStale = a && a.analysis_date !== new Date().toISOString().slice(0, 10);
                    return (
                      <>
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="label text-[10px]">Daily Analysis</p>
                            {a && (
                              <p className="text-[10px] text-paper-dim/60 mt-0.5">
                                {isStale ? `Last run ${a.analysis_date}` : "Updated today"}
                                {a.structural_regime && ` · ${a.structural_regime}${a.market_regime && a.market_regime !== a.structural_regime ? ` / ${a.market_regime}` : ""}`}
                                {a.nearterm_forward_confidence != null && ` · ${a.nearterm_forward_confidence}% near-term forward confidence`}
                                {a.rebalance_band_pct != null && ` · ±${a.rebalance_band_pct}pt rebalance band`}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => runPortfolioAnalysis(pf.id)}
                            disabled={running}
                            className="px-3 py-1.5 rounded-lg text-xs border border-brass/40 text-brass-soft hover:bg-brass/10 disabled:opacity-50 transition-colors shrink-0"
                          >
                            {running ? "Running…" : a ? "Run Analysis" : "Run Analysis"}
                          </button>
                        </div>
                        {a ? (
                          <div className="space-y-2.5">
                            {a.analysis.split(/\n\n+/).map((block, i) => {
                              const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
                              const bulletLines = lines.filter((l) => /^[-*]\s+/.test(l));
                              const isBulletBlock = bulletLines.length >= 2 && bulletLines.length >= lines.length - 1;
                              if (!isBulletBlock) {
                                return <p key={i} className="text-xs text-paper-dim leading-relaxed">{block.trim()}</p>;
                              }
                              const leadIn = lines.filter((l) => !/^[-*]\s+/.test(l));
                              return (
                                <div key={i}>
                                  {leadIn.map((l, j) => (
                                    <p key={`lead-${j}`} className="text-xs text-paper-dim leading-relaxed mb-1.5">{l}</p>
                                  ))}
                                  <ul className="list-disc pl-4 space-y-1">
                                    {bulletLines.map((l, j) => (
                                      <li key={j} className="text-xs text-paper-dim leading-relaxed">{l.replace(/^[-*]\s+/, "")}</li>
                                    ))}
                                  </ul>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-paper-dim italic">
                            {running ? "Generating…" : "No analysis yet — runs automatically each morning, or click Run Analysis."}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>

                {/* Market Conditions overlay (Phase 6) — per-portfolio opt-in
                   equity-exposure dial driven by market_conditions_scores'
                   daily tier/exposure_multiplier. Deliberately kept separate
                   from the resize/capex overlay below: an independent boolean
                   (use_market_overlay), its own freed-weight-to-cash math
                   scoped to EQUITY_KEYS only (lib/marketOverlayPortfolio.js),
                   shown regardless of strategy_framework. A recommendation
                   only — the only write on this page is "Mark rebalanced",
                   an explicit acknowledgment that gates the next proposal to
                   the NEXT tier change rather than every daily score move. */}
                {latestMarketScore && (() => {
                  const tier = latestMarketScore.tier;
                  const meta = TIER_META[tier] ?? TIER_META.NORMAL;
                  const mult = Number(latestMarketScore.exposure_multiplier);
                  const rebalanceDue = pf.use_market_overlay && shouldProposeRebalance(tier, pf.last_rebalanced_tier);

                  // Stack with the EXISTING resize overlay (per-symbol technical
                  // rules, e.g. GLDM's live vol-regime cut) and the AI Capex
                  // Cycle overlay (when actually applied, not shadow-mode).
                  // Resize is orthogonal to the other two -- always multiplies
                  // on top (same independent-signal relationship it already has
                  // with capex, mergeExposureMultipliers). Capex and market
                  // overlap (both broad-drawdown reads), so MIN governs there
                  // instead of multiplying -- see combineAllOverlays's own
                  // comment. Both "without" and "with" below include the live
                  // resize/capex state; "without" is what the portfolio already
                  // looks like today without the market-conditions overlay
                  // specifically, not a hypothetical zero-signal baseline --
                  // that distinction is what a portfolio with an ACTIVE
                  // resize cut on a non-equity bucket (KISS's GLDM) needs to
                  // avoid the market overlay looking like it wants the freed
                  // cash sold back into equity.
                  const capexApplied = capexOverlayApplied;
                  let rows = [];
                  if (pf.use_market_overlay) {
                    const rawTargets = pf.target_allocations || {};
                    const marketMultipliers = marketOverlayMultipliersBySymbol(hs, mult, EQUITY_KEYS);
                    const { multipliers: combinedMultipliers, binding } = combineAllOverlays(
                      resizeExposureMultipliers, capexOverlay.bySymbol, marketMultipliers, capexApplied
                    );
                    // "without" = resize x capex only (exactly today's existing
                    // Portfolio Actions state, the outer-scope exposureMultipliers
                    // used there too) -- not a bare resize-only baseline, so capex
                    // (when actually applied) is credited on both sides equally.
                    const { effectiveTargets: withoutTargets } = applyOverlayToTargets(rawTargets, hs, exposureMultipliers);
                    const { effectiveTargets: withTargets } = applyOverlayToTargets(rawTargets, hs, combinedMultipliers);

                    const without = computeAllocationDeltas(hs, withoutTargets, { illiquidKeys: ILLIQUID_KEYS, exposureMultipliers, includeZeroValueHoldings: true });
                    const withOv  = computeAllocationDeltas(hs, withTargets, { illiquidKeys: ILLIQUID_KEYS, exposureMultipliers: combinedMultipliers, includeZeroValueHoldings: true });
                    const withoutBySymbol = Object.fromEntries(without.actionRows.map((r) => [r.symbol, r]));
                    const holdingBySymbol = Object.fromEntries(hs.map((h) => [h.symbol, h]));

                    rows = withOv.actionRows
                      .filter((r) => EQUITY_KEYS.has(r.key) || r.key === "cash")
                      .map((r) => {
                        const wo = withoutBySymbol[r.symbol];
                        const h = holdingBySymbol[r.symbol];
                        const costBasis = Number(h?.cost_basis ?? 0);
                        const netGain = Number(h?.net_gain ?? 0);
                        const estGain = r.deltaVal < 0 && r.currentVal > 0 && costBasis > 0
                          ? (-r.deltaVal) * (netGain / r.currentVal)
                          : null;
                        return {
                          symbol: r.symbol, currentPct: r.currentPct,
                          withoutPct: wo?.newPct ?? r.currentPct, withPct: r.newPct,
                          tradeVal: r.deltaVal, estGain,
                          binding: binding[r.symbol] ?? null,
                        };
                      });

                    // No current cash holding — Portfolio Actions' existing pattern
                    // for "create a sleeve": surfaced as a recommendation, not a write.
                    const cashBuyWith = withOv.buyRows.find((b) => b.key === "cash");
                    if (cashBuyWith) {
                      const cashBuyWithout = without.buyRows.find((b) => b.key === "cash");
                      rows.push({
                        symbol: "Cash (new)",
                        currentPct: 0,
                        withoutPct: cashBuyWithout?.targetPct ?? (rawTargets.cash ?? 0),
                        withPct: cashBuyWith.targetPct,
                        tradeVal: cashBuyWith.targetVal,
                        estGain: null,
                        binding: null,
                      });
                    }
                  }

                  return (
                    <div className="px-5 py-4 border-b border-ink-line">
                      <div className="flex items-center justify-between mb-3 gap-3">
                        <div>
                          <p className="label text-[10px]">Market Conditions Overlay</p>
                          <p className="text-[10px] text-paper-dim/60 mt-0.5">
                            <a href="/market-conditions" className="hover:text-brass-soft">Tier</a>
                            {" "}<span className={meta.tone}>{meta.label}</span>
                            {" · "}exposure ×{isFinite(mult) ? mult.toFixed(2) : "—"}
                            {" · "}<span className={pf.use_market_overlay ? "text-gain" : "text-paper-dim"}>{pf.use_market_overlay ? "overlay on" : "overlay off"}</span>
                            {pf.use_market_overlay && capexApplied && (
                              <>{" · "}stacked with <a href="/ai-capex" className="hover:text-brass-soft">AI Capex overlay</a> (min of the two, per holding)</>
                            )}
                          </p>
                        </div>
                        {rebalanceDue && (
                          <button
                            onClick={() => markOverlayRebalanced(pf.id, tier)}
                            className="px-3 py-1.5 rounded-lg text-xs border border-brass/40 text-brass-soft hover:bg-brass/10 transition-colors shrink-0"
                          >
                            Mark rebalanced to {meta.label}
                          </button>
                        )}
                      </div>

                      {!pf.use_market_overlay ? (
                        <p className="text-xs text-paper-dim italic">Off — enable in portfolio settings to scale equity exposure with this tier.</p>
                      ) : rows.length === 0 ? (
                        <p className="text-xs text-paper-dim italic">No change at the current multiplier.</p>
                      ) : (
                        <>
                          <div className="border border-ink-line rounded-lg overflow-hidden text-[11px]">
                            <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-3 px-3 py-1.5 bg-ink-soft/50 border-b border-ink-line text-[10px] text-paper-dim">
                              <span>Holding</span>
                              <span className="text-right">Current</span>
                              <span className="text-right">No overlay</span>
                              <span className="text-right">With overlay</span>
                              <span>Trade</span>
                              <span className="text-right">Est. gain/loss</span>
                            </div>
                            {rows.map((r) => {
                              const absD = Math.abs(r.tradeVal);
                              // isNoop still dims the styling for immaterial moves
                              // (<0.5% of the portfolio), but the label always shows
                              // the real direction + dollar amount rather than a bare
                              // "Hold" -- a small amount below the materiality bar
                              // (e.g. cash absorbing a few hundred dollars from a
                              // resize cut elsewhere) should still be visible, not
                              // read as "nothing is happening here."
                              const isNoop = absD < s.totalValue * 0.005;
                              const tradeLabel = absD < 1
                                ? "Hold"
                                : `${r.tradeVal > 0 ? "Add" : "Sell"} $${absD < 1000 ? absD.toFixed(0) : (absD / 1000).toFixed(1) + "k"}`;
                              const tradeClass = isNoop ? "text-paper-dim" : r.tradeVal > 0 ? "text-gain" : "text-loss";
                              return (
                                <div key={r.symbol} className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-3 px-3 py-2 border-b border-ink-line/50 last:border-0 items-center">
                                  <span className="min-w-0">
                                    <span className="font-medium text-paper truncate block">{r.symbol}</span>
                                    {r.binding === "capex" && (
                                      <span className="text-[9px] text-brass-soft/80 block truncate">AI Capex overlay binding — tighter than the market-conditions cut</span>
                                    )}
                                  </span>
                                  <span className="num text-paper-dim text-right">{r.currentPct.toFixed(1)}%</span>
                                  <span className="num text-paper-dim text-right">{r.withoutPct.toFixed(1)}%</span>
                                  <span className={`num text-right font-medium ${isNoop ? "text-paper" : tradeClass}`}>{r.withPct.toFixed(1)}%</span>
                                  <span className={`${tradeClass} font-medium`}>{tradeLabel}</span>
                                  <span className="num text-right text-paper-dim">{r.estGain != null ? usd(r.estGain) : "—"}</span>
                                </div>
                              );
                            })}
                          </div>
                          <p className="text-[10px] text-paper-dim/60 mt-2 leading-relaxed">
                            Recommendation only — not an order. Overlay validated on broad U.S. and developed-market indexes; untested on concentrated sleeves.
                          </p>
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Bond Lens overlay (Phase D, lib/bondLensPortfolio.js) — per-portfolio
                   bond-sleeve duration tilt driven by the global weekly bond_lens_signal
                   row. v3 scope (docs/specs/bond-lens.md §0b): duration-multiplier only —
                   instrument_pref/maturity_pref are display-only here, never applied to a
                   holding. bondLensResult/bondLensApplied/bondLensStale are computed once
                   above (near holdingsFor) and shared with the Portfolio Actions
                   sectorTargets merge further below. */}
                <div className="px-5 py-4 border-b border-ink-line">
                  <div className="flex items-center justify-between mb-3 gap-3">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="label text-[10px]">Bond Lens Overlay</p>
                        <StageInfoIcon
                          active={bondLensInfoOpen}
                          onClick={() => setBondLensInfoOpen((v) => !v)}
                          label="About this signal's evidence"
                        />
                      </div>
                      {latestBondLensSignal && (
                        <p className="text-[10px] text-paper-dim/60 mt-0.5">
                          Stance <span className="text-paper font-medium">{latestBondLensSignal.duration_stance ?? "—"}</span>
                          {" · "}duration ×{isFinite(Number(latestBondLensSignal.duration_multiplier)) ? Number(latestBondLensSignal.duration_multiplier).toFixed(2) : "—"}
                          {" · "}<span className={pf.use_bond_lens_overlay ? "text-gain" : "text-paper-dim"}>{pf.use_bond_lens_overlay ? "overlay on" : "overlay off"}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Honest-framing tooltip (click-to-reveal, same StageInfoIcon pattern as
                     app/big-cycle/page.jsx's stage definitions) -- Phase E's own verdict on
                     the duration-score edge, verbatim. */}
                  {bondLensInfoOpen && (
                    <div className="mb-3 p-3 rounded-lg border border-ink-line bg-ink text-[11px] leading-relaxed text-paper-dim">
                      No variant beats constant duration by more than about 0.1 Sharpe; differences are within
                      noise. Valuation-only is adopted as a modest, economically grounded tilt, not a proven edge.
                    </div>
                  )}

                  {!pf.use_bond_lens_overlay ? (
                    <p className="text-xs text-paper-dim italic">Off — enable in portfolio settings to tilt bond-sleeve duration with this signal.</p>
                  ) : !latestBondLensSignal ? (
                    <p className="text-xs text-paper-dim italic">No Bond Lens signal available yet.</p>
                  ) : !bondLensResult ? null : (
                    <>
                      {bondLensStale && (
                        <p className="text-xs text-brass-soft mb-3 leading-relaxed">
                          Signal stale — as of {latestBondLensSignal.as_of_date}, more than 10 days old. Holding last targets; duration tilt not applied.
                        </p>
                      )}
                      {bondLensTermPremiumDegraded && (
                        <p className="text-xs text-brass-soft mb-3 leading-relaxed">
                          ACM term premium is stale (&gt;10 business days) — valuation is now the sole driver of
                          duration_score, so a stale ACM reading means a stale stance. Falling back to THREEFYTP10.
                        </p>
                      )}

                      <BondLensSleeveDetail result={bondLensResult} signalRow={latestBondLensSignal} />
                    </>
                  )}
                </div>

                {/* Portfolio Actions — resize_overlay and regime_driven
                   portfolios. Same computeAllocationDeltas call + row/badge
                   rendering already shipped on /macro's QuadrantCard, scoped
                   here to this portfolio's own holdings/target_allocations
                   instead of the global combined set. Both exposureMultipliers
                   (per-symbol resize overlay, e.g. VTI/GLD's already-backtested
                   trend/vol-regime rules) and sectorTargets (the static
                   regime-keyed equity-sector tilt for "All Weather With
                   Equity Tilting", see portfolio_sector_targets) are applied
                   unconditionally now, not gated by strategy_framework —
                   each is independently a no-op when its data is empty
                   (exposureMultipliers is only ever populated for symbols
                   with a real backtested rule; sectorTargets only for the
                   one portfolio with rows in that table), so a regime_driven
                   portfolio like All Weather Alpha correctly gets its VTI/GLD
                   resize overlay without needing its own separate framework.

                   Weight freed up by a resized leg (e.g. Gold cut to 0% of
                   its 12% target) doesn't just vanish — it needs somewhere
                   to sit, same as the kiss-portfolio-backtest's own design
                   (freed weight parks in the liquidity sleeve). Computed
                   here as each bucket's target times (1 - its holdings'
                   average exposure multiplier), summed and added to the
                   "cash" bucket target before the real computeAllocationDeltas
                   call — cash's own holdings (e.g. USFR) aren't themselves
                   resize-monitored so they keep multiplier 1 and absorb the
                   full top-up.

                   byKeyTotals intentionally includes zero-value holdings
                   (no val>0 filter) — a bucket like Gold can be entirely
                   unheld right now (GLDM already sold to $0, matching its
                   own live "Reduced" signal) while still needing its
                   multiplier known for the freed-weight sum above.

                   computeAllocationDeltas is called here with
                   includeZeroValueHoldings — a symbol linked to this
                   portfolio but currently at $0 (e.g. GLDM, resized to 0% by
                   its own live signal) still shows up as its own actionRow
                   (Reduced badge, $0/0% Hold) instead of silently vanishing.
                   buyRows is then only buckets with NO linked holding at
                   all, so there's no double-counting against the specific
                   per-symbol row above. */}
                {(pf.strategy_framework === "resize_overlay" || pf.strategy_framework === "regime_driven") && (() => {
                  const rawTargets = pf.target_allocations || {};

                  // Portfolio Actions is the single actionable recommendation for
                  // this portfolio — when the Market Conditions overlay is on for
                  // it, its equity-only cut has to be folded in here too (via the
                  // same combineAllOverlays used by the Market Conditions Overlay
                  // card above), not just resize x capex. Otherwise this table
                  // silently disagrees with what that card says the portfolio
                  // should look like, and — critically — turning the flag OFF
                  // doesn't change this table at all, so it has to be correct on
                  // its own regardless of the flag.
                  const capexAppliedHere = capexOverlayApplied;
                  const portfolioActionsMultipliers = pf.use_market_overlay && latestMarketScore
                    ? combineAllOverlays(
                        resizeExposureMultipliers, capexOverlay.bySymbol,
                        marketOverlayMultipliersBySymbol(hs, Number(latestMarketScore.exposure_multiplier), EQUITY_KEYS),
                        capexAppliedHere
                      ).multipliers
                    : exposureMultipliers;

                  const byKeyTotals = {};
                  for (const h of hs) {
                    const key = resolveSimulatorKey(h);
                    if (!key) continue;
                    const val = Number(h.current_value ?? 0);
                    const mult = portfolioActionsMultipliers[h.symbol] ?? 1;
                    if (!byKeyTotals[key]) byKeyTotals[key] = { total: 0, weightedMultSum: 0, count: 0, multSum: 0 };
                    byKeyTotals[key].total += val;
                    byKeyTotals[key].weightedMultSum += val * mult;
                    byKeyTotals[key].count += 1;
                    byKeyTotals[key].multSum += mult;
                  }
                  const avgMultFor = (key) => {
                    const bt = byKeyTotals[key];
                    if (!bt) return 1;
                    return bt.total > 0 ? bt.weightedMultSum / bt.total : (bt.count > 0 ? bt.multSum / bt.count : 1);
                  };
                  let freedPct = 0;
                  for (const [key, pct] of Object.entries(rawTargets)) {
                    if (key === "cash" || !byKeyTotals[key]) continue;
                    freedPct += pct * (1 - avgMultFor(key));
                  }
                  const effectiveTargets = freedPct > 0 ? { ...rawTargets, cash: (rawTargets.cash ?? 0) + freedPct } : rawTargets;

                  // Bond Lens (Phase D) — only merged in when ON and not stale
                  // (bondLensApplied, computed above near holdingsFor); otherwise this is
                  // the exact same `sectorTargets` object/reference as before, so an
                  // off (or stale) portfolio's action rows are byte-identical to a build
                  // without Bond Lens (docs/specs/bond-lens.md §6.7 acceptance test).
                  const sectorTargetsWithBondLens = bondLensApplied && bondLensResult
                    ? { ...sectorTargets, ...bondLensResult.sectorTargets }
                    : sectorTargets;

                  const { actionRows, buyRows: rawBuyRows } = computeAllocationDeltas(
                    hs, effectiveTargets,
                    { illiquidKeys: ILLIQUID_KEYS, exposureMultipliers: portfolioActionsMultipliers, sectorTargets: sectorTargetsWithBondLens, includeZeroValueHoldings: true }
                  );
                  // No per-row exposure-multiplier scaling needed here anymore:
                  // with includeZeroValueHoldings, buyRows only contains
                  // buckets with NO linked holding at all (a resized-to-zero
                  // bucket like Gold now surfaces as its own actionRow via
                  // GLDM instead), so avgMultFor(r.key) would always be 1.
                  const buyRows = rawBuyRows.filter((r) => r.targetPct >= 0.05);
                  if (actionRows.length === 0 && buyRows.length === 0) return null;
                  return (
                    <div className="px-5 py-4 border-b border-ink-line">
                      <p className="label mb-3">Portfolio Actions</p>
                      {pf.use_market_overlay && latestMarketScore && (() => {
                        const meta = TIER_META[latestMarketScore.tier] ?? TIER_META.NORMAL;
                        return (
                          <p className="text-[11px] text-paper-dim mb-3 leading-relaxed">
                            <a href="/market-conditions" className="text-brass-soft hover:text-brass">Market Conditions overlay</a>
                            {" · "}<span className={meta.tone}>{meta.label}</span> (×{Number(latestMarketScore.exposure_multiplier).toFixed(2)})
                            {" · included below"}
                          </p>
                        );
                      })()}
                      {capexRows.length > 0 && (() => {
                        const held = new Set(hs.map((h) => h.symbol));
                        const cuts = capexRows.filter((r) => held.has(r.symbol) && Number(r.exposure_multiplier) < 0.995);
                        const r0 = capexRows[0];
                        const meta = CAPEX_REGIME_META[r0.regime_key] ?? CAPEX_REGIME_META.boom;
                        return (
                          <p className="text-[11px] text-paper-dim mb-3 leading-relaxed">
                            <a href="/ai-capex" className="text-brass-soft hover:text-brass">AI Capex overlay</a>
                            {" · "}<span className={meta.tone}>{meta.label}</span> (CCSI {Number(r0.ccsi).toFixed(2)})
                            {" · "}{capexOverlayApplied ? "applied" : <span className="text-brass-soft">off for this portfolio</span>}
                            {" · "}{cuts.length === 0
                              ? "no cuts to this portfolio's holdings"
                              : `${capexOverlayApplied ? "cutting" : "would cut"} ${cuts.map((c) => `${c.symbol} ×${Number(c.exposure_multiplier).toFixed(2)}`).join(", ")}`}
                          </p>
                        );
                      })()}
                      <div className="border border-ink-line rounded-lg overflow-hidden text-[11px]">
                        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-1.5 bg-ink-soft/50 border-b border-ink-line text-[10px] text-paper-dim">
                          <span>Holding</span>
                          <span className="text-right">Current</span>
                          <span className="text-right">Cur %</span>
                          <span>Action</span>
                          <span className="text-right">New %</span>
                        </div>
                        {actionRows.map((r) => {
                          const delta = r.deltaVal;
                          const absD = Math.abs(delta);
                          // isNoop still dims the styling for immaterial moves
                          // (<0.5% of the portfolio); the label itself always
                          // shows the real direction + dollar amount down to $1
                          // rather than a bare "Hold" that hides where a small
                          // freed/displaced amount actually landed.
                          const isNoop = absD < s.totalValue * 0.005;
                          let actionLabel, actionClass;
                          if (r.isIlliquid && delta < 0) {
                            actionLabel = "Illiquid — hold";
                            actionClass = "text-paper-dim italic";
                          } else if (absD < 1) {
                            actionLabel = "Hold";
                            actionClass = "text-paper-dim";
                          } else if (delta > 0) {
                            actionLabel = `Add $${absD < 1000 ? absD.toFixed(0) : (absD / 1000).toFixed(1) + "k"}`;
                            actionClass = isNoop ? "text-paper-dim" : "text-gain";
                          } else {
                            actionLabel = `Sell $${absD < 1000 ? absD.toFixed(0) : (absD / 1000).toFixed(1) + "k"}`;
                            actionClass = isNoop ? "text-paper-dim" : "text-loss";
                          }
                          const resize = resizeSignals[r.symbol];
                          const isResized = resize && resize.reduced;
                          return (
                            <div key={`${r.symbol}-${r.key}`} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-2 border-b border-ink-line/50 items-center">
                              <span className="min-w-0">
                                <span className="font-medium text-paper truncate block">{r.symbol}</span>
                                {isResized && (
                                  <span
                                    className="text-[9px] text-brass-soft/80 block truncate"
                                    title={resize.confidence_note ?? undefined}
                                  >
                                    Reduced — {resize.rule_type === "trend_ma" ? "trend" : resize.rule_type === "vol_regime" ? "vol regime" : "drawdown"} · {(r.exposureMultiplier * 100).toFixed(0)}% of target
                                  </span>
                                )}
                              </span>
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
                        {buyRows.length > 0 && (
                          <>
                            <div className="px-3 py-1.5 bg-ink-soft/30 border-b border-ink-line text-[10px] text-paper-dim font-medium">
                              Recommendations — no current holding
                            </div>
                            {buyRows.map((r) => (
                              <div key={r.key} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-3 py-2 border-b border-ink-line/50 last:border-0 items-center">
                                <span className="font-medium text-paper truncate">{r.label}</span>
                                <span className="num text-paper-dim text-right">—</span>
                                <span className="num text-paper-dim text-right">0.0%</span>
                                <span className="text-gain font-medium">Add ${r.targetVal < 1000 ? r.targetVal.toFixed(0) : (r.targetVal / 1000).toFixed(1) + "k"}</span>
                                <span className="num text-right text-gain">{r.targetPct.toFixed(1)}%</span>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Holdings grouped by simulator bucket */}
                <div className="px-5 py-4">
                  <p className="label mb-3">Holdings ({hs.length})</p>
                  {hs.length === 0 ? (
                    <div className="card p-6 text-center">
                      <p className="text-paper-dim text-sm">No holdings assigned yet.</p>
                      <p className="text-xs text-paper-dim mt-1">Open a holding from the Holdings page and assign it to this portfolio.</p>
                    </div>
                  ) : (() => {
                    // Group by BW simulator bucket in canonical order
                    const byKey = {};
                    for (const h of hs) {
                      const key = resolveSimulatorKey(h) ?? "unassigned";
                      if (!byKey[key]) byKey[key] = [];
                      byKey[key].push(h);
                    }
                    const groups = [
                      ...SIMULATOR_KEYS.map(({ key, label }) => ({ key, label, items: byKey[key] ?? [] })).filter(g => g.items.length > 0),
                      ...(byKey.unassigned?.length ? [{ key: "unassigned", label: "Unassigned", items: byKey.unassigned }] : []),
                    ];

                    // Total gain per holding = cap gain + dividends + interest - fees
                    const holdingTotalGain = (h) =>
                      Number(h.net_gain ?? 0) + Number(h.total_dividends ?? 0) + Number(h.total_interest ?? 0) - Number(h.total_fees ?? 0);
                    const holdingReturnPct = (h) => {
                      const cb = Number(h.cost_basis ?? 0);
                      return cb > 0 ? (holdingTotalGain(h) / cb) * 100 : null;
                    };

                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-ink-line">
                              <th className="label text-left font-medium py-2 pr-3">Symbol</th>
                              <th className="label text-left font-medium py-2 pr-3">Account</th>
                              <th className="label text-right font-medium py-2 pr-2">Value</th>
                              <th className="label text-right font-medium py-2 pr-2">Cost Basis</th>
                              <th className="label text-right font-medium py-2 pr-2">Total Gain</th>
                              <th className="label text-right font-medium py-2 pr-2">Return %</th>
                              <th className="label text-right font-medium py-2 pr-2">Exp. Income</th>
                              <th className="label text-right font-medium py-2 pr-2">Day Chg</th>
                              <th className="label text-right font-medium py-2">Day Chg %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {groups.map(({ key, label, items }) => {
                              const groupValue     = items.reduce((sum, h) => sum + Number(h.current_value ?? 0), 0);
                              const groupCost      = items.reduce((sum, h) => sum + Number(h.cost_basis ?? 0), 0);
                              const groupPct       = s.totalValue > 0 ? (groupValue / s.totalValue) * 100 : 0;
                              const groupTotalGain = items.reduce((sum, h) => sum + holdingTotalGain(h), 0);
                              const groupReturnPct = groupCost > 0 ? (groupTotalGain / groupCost) * 100 : null;
                              const groupDayChgItems = items.filter(h => snapMap[h.id] != null);
                              const groupDayChg = groupDayChgItems.length > 0
                                ? groupDayChgItems.reduce((sum, h) => sum + Number(h.current_value ?? 0) - snapMap[h.id], 0)
                                : null;
                              const groupPrevValue = groupDayChgItems.reduce((sum, h) => sum + snapMap[h.id], 0);
                              const groupDayChgPct = groupDayChg != null && groupPrevValue > 0
                                ? (groupDayChg / groupPrevValue) * 100
                                : null;
                              const groupExpIncome = items.reduce((sum, h) => {
                                const y = h.dividend_yield ?? h.interest_rate;
                                return y != null ? sum + Number(h.current_value ?? 0) * Number(y) / 100 : sum;
                              }, 0);
                              const groupHasYield = items.some(h => h.dividend_yield != null || h.interest_rate != null);
                              const isExpanded     = expandedBuckets.has(key);
                              const toggle = () => setExpandedBuckets((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              });
                              const hasTargets = pf.target_allocations && Object.keys(pf.target_allocations).length > 0;
                              const targetPct  = hasTargets ? (Number(pf.target_allocations[key]) || 0) : null;
                              const diffPct    = targetPct != null ? groupPct - targetPct : null;
                              return [
                                /* Group header — clickable to expand/collapse */
                                <tr
                                  key={`g-${key}`}
                                  className="bg-ink/40 border-y border-ink-line cursor-pointer select-none hover:bg-ink/60 transition-colors"
                                  onClick={toggle}
                                >
                                  <td colSpan={2} className="py-1.5 pr-3">
                                    <div className="flex items-center gap-2.5">
                                      <svg
                                        className={`w-3 h-3 text-paper-dim shrink-0 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
                                        viewBox="0 0 12 12" fill="none"
                                      >
                                        <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                      </svg>
                                      <span className="label text-[11px] font-semibold text-brass-soft">{label}</span>
                                      <div className="relative flex-1 max-w-[100px] h-1.5 bg-ink-line rounded-full overflow-hidden">
                                        <div className="h-full bg-brass/60 rounded-full" style={{ width: `${Math.min(groupPct, 100)}%` }} />
                                        {targetPct != null && targetPct > 0 && (
                                          <div className="absolute inset-y-0 w-px bg-white/60" style={{ left: `${Math.min(targetPct, 100)}%` }} />
                                        )}
                                      </div>
                                      <span className="num text-[11px] font-semibold text-paper">{groupPct.toFixed(1)}%</span>
                                      {targetPct != null && (
                                        <span className={`text-[10px] tabular-nums ${
                                          diffPct >  2 ? "text-loss" :
                                          diffPct < -2 ? "text-gain" :
                                          "text-paper-dim"
                                        }`}>
                                          / {targetPct}% tgt
                                        </span>
                                      )}
                                      <span className="label text-[10px] text-paper-dim">{items.length} holding{items.length !== 1 ? "s" : ""}</span>
                                    </div>
                                  </td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] font-semibold">{usd(groupValue)}</td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] text-paper-dim">{usd(groupCost)}</td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupTotalGain)}`}>
                                    {groupTotalGain > 0 ? "+" : ""}{usd(groupTotalGain)}
                                  </td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupReturnPct)}`}>
                                    {fmtPct(groupReturnPct)}
                                  </td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] font-semibold text-brass-soft">
                                    {groupHasYield ? usd(groupExpIncome) : "—"}
                                  </td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupDayChg)}`}>
                                    {groupDayChg == null ? "—" : `${groupDayChg > 0 ? "+" : ""}${usd(groupDayChg)}`}
                                  </td>
                                  <td className={`num text-right py-1.5 text-[11px] font-semibold ${gainCls(groupDayChgPct)}`}>
                                    {groupDayChgPct == null ? "—" : `${groupDayChgPct > 0 ? "+" : ""}${groupDayChgPct.toFixed(2)}%`}
                                  </td>
                                </tr>,
                                /* Holding rows — only rendered when expanded */
                                ...(isExpanded ? items.map((h) => {
                                  const dayChg    = snapMap[h.id] != null ? Number(h.current_value ?? 0) - snapMap[h.id] : null;
                                  const snapPrice = snapPriceMap[h.id];
                                  const dayChgPct = dayChg != null && snapMap[h.id] > 0 ? (dayChg / snapMap[h.id]) * 100 : null;
                                  const tGain  = holdingTotalGain(h);
                                  const retPct = holdingReturnPct(h);
                                  const hYield = h.dividend_yield ?? h.interest_rate;
                                  const expIncome = hYield != null ? Number(h.current_value ?? 0) * Number(hYield) / 100 : null;
                                  return (
                                    <tr key={h.id} className="border-b border-ink-line/40 last:border-0 hover:bg-ink-soft/40 transition-colors cursor-pointer" onClick={() => setDetailHolding(h)}>
                                      <td className="py-2 pr-3 pl-5">
                                        <span className="font-medium">{h.symbol}</span>
                                        {h.name && <span className="block text-[10px] text-paper-dim leading-tight">{h.name}</span>}
                                      </td>
                                      <td className="py-2 pr-3 pl-3 text-paper-dim">{h.account_id ? (accountMap[h.account_id] ?? "—") : "—"}</td>
                                      <td className="num text-right py-2 pr-2">{usd(h.current_value)}</td>
                                      <td className="num text-right py-2 pr-2 text-paper-dim">{usd(h.cost_basis)}</td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(tGain)}`}>{tGain > 0 ? "+" : ""}{usd(tGain)}</td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(retPct)}`}>{fmtPct(retPct)}</td>
                                      <td className="num text-right py-2 pr-2 text-brass-soft">
                                        {expIncome != null ? usd(expIncome) : "—"}
                                      </td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(dayChg)}`}>
                                        {dayChg == null ? "—" : `${dayChg > 0 ? "+" : ""}${usd(dayChg)}`}
                                      </td>
                                      <td className={`num text-right py-2 ${gainCls(dayChgPct)}`}>
                                        {dayChgPct == null ? "—" : `${dayChgPct > 0 ? "+" : ""}${dayChgPct.toFixed(2)}%`}
                                      </td>
                                    </tr>
                                  );
                                }) : []),
                              ];
                            })}
                          </tbody>
                          <tfoot className="border-t-2 border-ink-line">
                            <tr>
                              <td colSpan={2} className="py-2 label text-[10px]">Total ({hs.length} holdings)</td>
                              <td className="num text-right py-2 pr-2 font-medium">{usd(s.totalValue)}</td>
                              <td className="num text-right py-2 pr-2 text-paper-dim">{usd(s.costBasis)}</td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.totalGain)}`}>
                                {s.totalGain > 0 ? "+" : ""}{usd(s.totalGain)}
                              </td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.returnPct)}`}>
                                {fmtPct(s.returnPct)}
                              </td>
                              <td className="num text-right py-2 pr-2 font-medium text-brass-soft">
                                {(() => {
                                  const total = hs.reduce((sum, h) => {
                                    const y = h.dividend_yield ?? h.interest_rate;
                                    return y != null ? sum + Number(h.current_value ?? 0) * Number(y) / 100 : sum;
                                  }, 0);
                                  return hs.some(h => h.dividend_yield != null || h.interest_rate != null) ? usd(total) : "—";
                                })()}
                              </td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.dayChg)}`}>
                                {s.dayChg == null ? "—" : `${s.dayChg > 0 ? "+" : ""}${usd(s.dayChg)}`}
                              </td>
                              <td className={`num text-right py-2 font-medium ${gainCls(s.dayChg)}`}>
                                {(() => {
                                  const prevTotal = hs.reduce((sum, h) => snapMap[h.id] != null ? sum + snapMap[h.id] : sum, 0);
                                  const pct = s.dayChg != null && prevTotal > 0 ? (s.dayChg / prevTotal) * 100 : null;
                                  return pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
                                })()}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* ── Create / Edit drawer ───────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-40 ${editingPortfolio ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingPortfolio ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingPortfolio(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${editingPortfolio ? "translate-x-0" : "translate-x-full"}`}>
          {editingPortfolio && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">{editingPortfolio === "new" ? "New portfolio" : "Edit portfolio"}</p>
                <button onClick={() => setEditingPortfolio(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>

              <div>
                <label className="label block mb-1.5">Portfolio name</label>
                <input
                  className="field"
                  placeholder="e.g. Dalio All Weather"
                  value={form.portfolio_name}
                  onChange={(e) => setForm((f) => ({ ...f, portfolio_name: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Description</label>
                <input
                  className="field"
                  placeholder="Short one-line summary"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Strategy detail</label>
                <textarea
                  className="field min-h-[140px] resize-y"
                  placeholder="Describe the investment thesis, allocation rules, or target weights…"
                  value={form.strategy_detail}
                  onChange={(e) => setForm((f) => ({ ...f, strategy_detail: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Strategy Framework</label>
                <select
                  className="field"
                  value={form.strategy_framework}
                  onChange={(e) => setForm((f) => ({ ...f, strategy_framework: e.target.value }))}
                >
                  <option value="">Auto-detect from strategy text (default)</option>
                  <option value="static">Static — regime-agnostic (e.g. All Weather, risk parity)</option>
                  <option value="tactical">Tactical — discretionary regime-responsive tilts</option>
                  <option value="regime_driven">Regime-driven — target allocations auto-follow the Forward Signal</option>
                  <option value="resize_overlay">Resize overlay — per-holding VAMS-style risk signal scales target allocations</option>
                </select>
                <p className="text-[10px] text-paper-dim/60 mt-1">
                  {form.strategy_framework === "regime_driven"
                    ? "Target Allocations below are managed automatically once saved — a daily job tracks the Forward Signal (6-18mo leading-indicator composite) and shifts targets only once a new regime has held 30 consecutive days AND Forward Signal confidence is at least 60% (avoids both whipsaw and low-conviction commitments). Manual edits below will be overwritten."
                    : form.strategy_framework === "resize_overlay"
                    ? "Target Allocations below are set manually (same as Static/Tactical — not auto-managed). Once saved, a Portfolio Actions section appears below showing each holding's target scaled down by its own calibrated risk-state signal (asset_resize_rule_config) when one exists for that symbol — e.g. a holding currently flagged \"Reduced\" gets a smaller effective target than the raw bucket %. Mutually exclusive with Regime-driven under the current single-framework field — a portfolio can't be both at once yet."
                    : "Determines how Daily Analysis reasons about rebalancing vs. tactical tilts. Leave on auto-detect unless you want it locked explicitly."}
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.use_market_overlay}
                    onChange={(e) => setForm((f) => ({ ...f, use_market_overlay: e.target.checked }))}
                  />
                  <span className="label">Market Conditions overlay</span>
                </label>
                <p className="text-[10px] text-paper-dim/60 mt-1">
                  Independent of Strategy Framework — works alongside any of the above. When on, the risk-parity
                  solver runs unchanged first, then every holding classified as equity (US, international, EM) is
                  multiplied by the latest daily exposure multiplier from the Market Conditions dashboard, and the
                  freed weight is added to cash. A recommendation only — never an order. Overlay validated on broad
                  U.S. and developed-market indexes; untested on concentrated sleeves.
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.use_capex_overlay}
                    onChange={(e) => setForm((f) => ({ ...f, use_capex_overlay: e.target.checked }))}
                  />
                  <span className="label">AI Capex Cycle overlay</span>
                </label>
                <p className="text-[10px] text-paper-dim/60 mt-1">
                  Per-portfolio, independent of the site-wide shadow-mode setting on{" "}
                  <a href="/ai-capex" className="text-brass-soft hover:text-brass">/ai-capex</a> — turning this on
                  applies that overlay's per-symbol cuts to THIS portfolio's own Portfolio Actions and Market
                  Conditions Overlay math regardless of whether it's globally applied yet. Downside-only (never
                  raises a target above its base) and combines multiplicatively with the resize overlay, same as
                  everywhere else it's used.
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.use_bond_lens_overlay}
                    onChange={(e) => setForm((f) => ({ ...f, use_bond_lens_overlay: e.target.checked }))}
                  />
                  <span className="label">Bond Lens overlay</span>
                </label>
                <p className="text-[10px] text-paper-dim/60 mt-1">
                  Tilts bond-sleeve duration based on valuation; display-only instrument/maturity signals — see{" "}
                  docs/specs/bond-lens.md.
                </p>
              </div>

              <div>
                <label className="label block mb-2">Target Allocations</label>
                {form.strategy_framework === "regime_driven" ? (
                  <div className="space-y-1 opacity-50 pointer-events-none">
                    {SIMULATOR_KEYS.filter(({ key }) => (form.target_allocations[key] ?? 0) > 0 || ["eq","intl","em","nb","tip","com","gld","cash"].includes(key)).map(({ key, label }) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-xs text-paper-dim flex-1">{label}</span>
                        <span className="field w-16 py-1 px-2 text-xs text-right block">{form.target_allocations[key] ?? 0}</span>
                        <span className="text-xs text-paper-dim w-3">%</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {SIMULATOR_KEYS.map(({ key, label }) => {
                      const val = form.target_allocations[key] ?? "";
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <span className="text-xs text-paper-dim flex-1">{label}</span>
                          <input
                            type="number" min="0" max="100" step="1"
                            className="field w-16 py-1 px-2 text-xs text-right"
                            placeholder="0"
                            value={val}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const n = raw === "" ? 0 : Math.max(0, Math.min(100, Number(raw)));
                              setForm((f) => ({
                                ...f,
                                target_allocations: { ...f.target_allocations, [key]: n },
                              }));
                            }}
                          />
                          <span className="text-xs text-paper-dim w-3">%</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {form.strategy_framework !== "regime_driven" && (() => {
                  const total = SIMULATOR_KEYS.reduce((s, { key }) => s + (Number(form.target_allocations[key]) || 0), 0);
                  const diff  = total - 100;
                  return (
                    <div className={`flex justify-between mt-2 pt-2 border-t border-ink-line text-xs font-medium ${Math.abs(diff) <= 1 ? "text-gain" : "text-loss"}`}>
                      <span>Total</span>
                      <span>{total}% {diff !== 0 ? `(${diff > 0 ? "+" : ""}${diff} from 100)` : "✓"}</span>
                    </div>
                  );
                })()}
              </div>

              <div>
                <label className="label block mb-1.5">Rebalance Band</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" max="50" step="0.5"
                    className="field w-20 py-1.5 px-2 text-xs"
                    value={form.rebalance_band_pct}
                    onChange={(e) => setForm((f) => ({ ...f, rebalance_band_pct: e.target.value }))}
                  />
                  <span className="text-xs text-paper-dim">points absolute, or 25% of a bucket's own target if larger — whichever tolerance is wider</span>
                </div>
                <p className="text-[10px] text-paper-dim/60 mt-1">Daily Analysis only recommends rebalancing a bucket once its drift from target exceeds this band.</p>
              </div>

              {formError && <p className="text-loss text-sm">{formError}</p>}

              <button className="btn w-full" onClick={savePortfolio} disabled={formBusy || !!bondLensPreview}>
                {formBusy ? "Saving…" : editingPortfolio === "new" ? "Create portfolio" : "Save changes"}
              </button>

              {editingPortfolio !== "new" && (
                <button
                  className="w-full px-3 py-2 text-sm rounded-lg text-paper-dim hover:text-loss border border-ink-line hover:border-loss/40 transition-colors"
                  onClick={() => { setEditingPortfolio(null); deletePortfolio(editingPortfolio); }}
                >
                  Delete portfolio
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Bond Lens preview-before-enable (§6.6) -- blocks the save of an edit that's
         turning use_bond_lens_overlay on until the user explicitly confirms the
         computed per-holding changes. Reuses BondLensSleeveDetail, the exact same
         rendering the always-on card below uses, just fed bondLensPreview (computed
         against the PENDING form state) instead of bondLensResult (computed against
         the portfolio's already-saved flag). Sits above the Create/Edit drawer
         (z-40) at z-50 since it's a confirmation step on top of that drawer, not a
         replacement for it -- Cancel returns to the still-open edit form. */}
      {bondLensPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/80" onClick={cancelBondLensPreview} />
          <div className="relative bg-ink-soft border border-ink-line rounded-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-5 space-y-3">
            <div>
              <p className="font-medium">Enable Bond Lens overlay?</p>
              <p className="text-[11px] text-paper-dim mt-1 leading-relaxed">
                Preview of the duration tilt this will apply to{" "}
                {editingPortfolio !== "new" ? editingPortfolio.portfolio_name : "this portfolio"}'s bond sleeve,
                computed against the latest signal. Nothing is saved until you confirm.
              </p>
            </div>

            <BondLensSleeveDetail result={bondLensPreview} signalRow={latestBondLensSignal} />

            <div className="flex items-center gap-2 pt-1">
              <button
                className="btn flex-1"
                onClick={() => savePortfolio({ bondLensConfirmed: true })}
                disabled={formBusy}
              >
                {formBusy ? "Saving…" : "Confirm & enable"}
              </button>
              <button
                className="w-full flex-1 px-3 py-2 text-sm rounded-lg text-paper-dim hover:text-paper border border-ink-line transition-colors"
                onClick={cancelBondLensPreview}
                disabled={formBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <HoldingDetailDrawer
        holding={detailHolding}
        onClose={() => setDetailHolding(null)}
        snapMap={snapMap}
        accountMap={accountMap}
        assetTypes={assetTypes}
        txnTypes={txnTypes}
        holdings={holdings}
        onRefresh={load}
      />
    </Shell>
  );
}
