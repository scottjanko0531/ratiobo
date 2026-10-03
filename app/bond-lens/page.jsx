"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceArea,
} from "recharts";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";

// Bond Lens — global market view (Phase D, Step 4, docs/specs/bond-lens.md §8).
// Read-only, always available regardless of any portfolio's use_bond_lens_overlay
// (same framing as /market-conditions, which this page's layout/chart conventions
// are deliberately copied from rather than shared via import — matches this
// codebase's existing per-page-duplication style for this kind of thing).

const GRID = "#2A3240", DIM = "#A8ADB8", PAPER = "#F6F4EE", BRASS = "#C9A227", GAIN = "#3FB984", LOSS = "#E0635C";
// Two extra hex values beyond the 5 named Tailwind colors (tailwind.config.js
// only defines ink/paper/brass/gain/loss) -- same approach /market-conditions
// takes for its own tier shading (e.g. DEFENSIVE's "#8a6a1a"). Picked to read as
// one coherent green->red "how bond-bullish is this regime" spectrum: steepening
// pairs lean more legible/extreme than their flattening counterparts.
const TEAL = "#2E8B8B";   // bull_flattening — bond-bullish, but the quieter of the two bull regimes
const RUST = "#B5542E";   // bear_steepening — term-premium/inflation-scare regime, the one most associated with 2022-style pain

const CURVE_REGIME_META = {
  bull_flattening: { label: "Bull flattening", fill: TEAL, swatch: TEAL, tone: "text-[#4FD1D1]" },
  bull_steepening: { label: "Bull steepening", fill: GAIN, swatch: GAIN, tone: "text-gain" },
  neutral:         { label: "Neutral",         fill: "transparent", swatch: "#444B58", tone: "text-paper-dim" },
  bear_flattening: { label: "Bear flattening", fill: BRASS, swatch: BRASS, tone: "text-brass-soft" },
  bear_steepening: { label: "Bear steepening", fill: RUST, swatch: RUST, tone: "text-[#E08A6C]" },
};
const CURVE_REGIME_OPACITY = { neutral: 0 };

const STANCE_TONE = { Short: "text-loss", Neutral: "text-paper-dim", Extend: "text-gain" };

const MATURITIES = [2, 5, 7, 10];
const LOOKBACK_YEARS = 10;

const fmtNum = (v, digits = 2) => (v == null || isNaN(Number(v)) ? "—" : Number(v).toFixed(digits));
const fmtPctVal = (v, digits = 2) => (v == null || isNaN(Number(v)) ? "—" : `${(Number(v) * 100).toFixed(digits)}%`);

// PostgREST caps a single response at 1000 rows -- a 10-year daily window (~2,600
// calendar days) blows past that for both bond_lens_signal and bond_raw_series, so
// an unpaginated .select() would silently truncate. Same page-through-in-1000s
// helper /market-conditions/page.jsx already uses for its own >1000-row queries.
async function fetchAllRows(table, columns, applyFilters, orderCol) {
  let rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await applyFilters(supabase.from(table).select(columns))
      .order(orderCol, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows = rows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function YieldChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload.find((x) => x.dataKey === "dgs10");
  if (!p) return null;
  const regime = p.payload?.curveRegime;
  const meta = regime ? CURVE_REGIME_META[regime] : null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[160px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      <div className="flex justify-between gap-4">
        <span className="text-paper-dim">DGS10</span>
        <span className="num text-paper">{Number(p.value).toFixed(2)}%</span>
      </div>
      {meta && (
        <div className="flex justify-between gap-4">
          <span className="text-paper-dim">Curve regime</span>
          <span className={`num ${meta.tone}`}>{meta.label}</span>
        </div>
      )}
    </div>
  );
}

export default function BondLensMarketPage() {
  const [signal, setSignal] = useState(null);   // latest bond_lens_signal row
  const [context, setContext] = useState(null);  // latest bond_signals row
  const [regimeHistory, setRegimeHistory] = useState([]); // [{as_of_date, curve_regime}], ~10y
  const [yieldHistory, setYieldHistory] = useState([]);   // [{obs_date, value}] DGS10, ~10y
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    async function load() {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - LOOKBACK_YEARS);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      try {
        const [{ data: sig }, { data: ctx }, hist, raw] = await Promise.all([
          supabase.from("bond_lens_signal").select("*").order("as_of_date", { ascending: false }).limit(1),
          supabase.from("bond_signals")
            .select("as_of_date, path_score, carry_score, quadrant_score, curve_score, trend_score, trend_state, flags")
            .order("as_of_date", { ascending: false }).limit(1),
          fetchAllRows("bond_lens_signal", "as_of_date, curve_regime", (q) => q.gte("as_of_date", cutoffStr), "as_of_date"),
          fetchAllRows("bond_raw_series", "obs_date, value", (q) => q.eq("series_id", "DGS10").gte("obs_date", cutoffStr), "obs_date"),
        ]);
        setSignal(sig?.[0] ?? null);
        setContext(ctx?.[0] ?? null);
        setRegimeHistory(hist);
        setYieldHistory(raw);
      } catch (e) {
        console.error("bond-lens load failed:", e);
      }
      setBusy(false);
    }
    load();
  }, []);

  // Merge DGS10 closes + curve_regime history into one chart series, keyed by date.
  const chartData = useMemo(() => {
    if (!yieldHistory.length) return [];
    const regimeByDate = new Map(regimeHistory.map((h) => [h.as_of_date, h.curve_regime]));
    return yieldHistory.map((y) => ({
      date: y.obs_date,
      dgs10: Number(y.value),
      curveRegime: regimeByDate.get(y.obs_date) ?? null,
    }));
  }, [yieldHistory, regimeHistory]);

  // Contiguous same-curve_regime date ranges for ReferenceArea shading -- same
  // "walk the series, close a zone when the value changes" approach /market-
  // conditions/page.jsx uses for its own tier zones.
  const regimeZones = useMemo(() => {
    const zones = [];
    let cur = null;
    for (const d of chartData) {
      if (!d.curveRegime) continue;
      if (!cur || cur.regime !== d.curveRegime) {
        if (cur) zones.push(cur);
        cur = { regime: d.curveRegime, from: d.date, to: d.date };
      } else {
        cur.to = d.date;
      }
    }
    if (cur) zones.push(cur);
    return zones;
  }, [chartData]);

  if (busy) {
    return (
      <Shell>
        <p className="text-paper-dim text-sm">Loading…</p>
      </Shell>
    );
  }
  if (!signal) {
    return (
      <Shell>
        <div className="card p-10 text-center"><p className="text-paper-dim text-sm">No Bond Lens signal yet.</p></div>
      </Shell>
    );
  }

  const stanceTone = STANCE_TONE[signal.duration_stance] ?? "text-paper-dim";
  const matTable = signal.explanation?.drivers?.maturity?.table ?? {};
  const termPremiumDegraded = Boolean(context?.flags?.term_premium_degraded);
  const inflationWarning = signal.inflation_regime_warning === true ? "Flagged"
    : signal.inflation_regime_warning === false ? "Clear" : "Unknown";
  const inflationTone = signal.inflation_regime_warning === true ? "text-brass-soft"
    : signal.inflation_regime_warning === false ? "text-paper-dim" : "text-paper-dim";
  const hedgeLabel = signal.hedge_reliable === true ? "Yes" : signal.hedge_reliable === false ? "No" : "Unknown";
  const hedgeTone = signal.hedge_reliable === true ? "text-gain" : signal.hedge_reliable === false ? "text-loss" : "text-paper-dim";

  return (
    <Shell>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Bond Lens</h1>
          <p className="text-xs text-paper-dim mt-0.5">
            Global duration signal · read-only market view · as of {signal.as_of_date}
          </p>
        </div>
      </div>

      {/* ACM staleness (§6.7/§8) -- same wording as the portfolio page's own
         BondLensSleeveDetail warning, for consistency between the two surfaces. */}
      {termPremiumDegraded && (
        <div className="card p-3 mb-6 border border-brass/40 bg-brass/10">
          <p className="text-xs text-brass-soft leading-relaxed">
            ACM term premium is stale (&gt;10 business days) — valuation is now the sole driver of duration_score,
            so a stale ACM reading means a stale stance. Falling back to THREEFYTP10.
          </p>
        </div>
      )}

      {/* 1. Stance gauge (valuation-only, v3) + hedge/inflation-warning badges */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div className="card p-5 flex flex-col items-center justify-center text-center">
          <p className="label text-[10px] mb-2">Duration stance <span className="text-paper-dim/50 normal-case">(valuation only, v3)</span></p>
          <p className={`text-3xl font-bold ${stanceTone}`}>{signal.duration_stance ?? "—"}</p>
          <p className="num text-sm text-paper-dim mt-1">
            score {fmtNum(signal.duration_score)} · ×{fmtNum(signal.duration_multiplier)}
          </p>
          <p className="text-[10px] text-paper-dim/60 mt-2 leading-relaxed">
            duration_score = valuation_score alone — no trend gate, no other module (§0b #1).
          </p>
        </div>

        <div className="card p-5 flex flex-col items-center justify-center text-center">
          <p className="label text-[10px] mb-2">Hedge reliable</p>
          <p className={`text-2xl font-semibold ${hedgeTone}`}>{hedgeLabel}</p>
          <p className="text-[11px] text-paper-dim mt-1">Stock-bond correlation regime</p>
        </div>

        <div className="card p-5 flex flex-col items-center justify-center text-center">
          <p className="label text-[10px] mb-2">Inflation-regime warning <span className="text-paper-dim/50 normal-case">(context)</span></p>
          <p className={`text-2xl font-semibold ${inflationTone}`}>{inflationWarning}</p>
          <p className="text-[10px] text-paper-dim/60 mt-2 leading-relaxed">
            Informational only — does NOT drive hedge_reliable or duration_score. Tested as a direct driver of
            hedge_reliable and rejected (too weak a discriminator); kept here because it would have flagged 2022
            roughly a year early.
          </p>
        </div>
      </div>

      {signal.explanation?.text && (
        <p className="card p-3 mb-6 text-[11px] text-paper-dim leading-relaxed">{signal.explanation.text}</p>
      )}

      {/* 2. Per-maturity table */}
      <div className="card p-4 mb-6">
        <p className="label text-[10px] mb-1">Per-maturity</p>
        <p className="text-[10px] text-paper-dim/60 mb-3 leading-relaxed">
          Yield / D_mod are the raw inputs. BE = breakeven yield rise (old formula, kept for reference) · EFF =
          risk-adjusted carry (Sharpe-style; the metric that actually sets <span className="text-paper-dim">maturity_pref</span> below
          — itself display-only in v3, never applied to a holding).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[420px]">
            <thead>
              <tr className="text-[10px] text-paper-dim border-b border-ink-line">
                <th className="text-left pb-2 font-normal">Maturity</th>
                <th className="text-right pb-2 font-normal">Yield</th>
                <th className="text-right pb-2 font-normal">D_mod</th>
                <th className="text-right pb-2 font-normal">BE</th>
                <th className="text-right pb-2 font-normal">EFF</th>
              </tr>
            </thead>
            <tbody>
              {MATURITIES.map((m) => {
                const row = matTable[String(m)] ?? matTable[m];
                const isPref = signal.maturity_pref === `${m}y`;
                return (
                  <tr key={m} className={`border-b border-ink-line/50 last:border-0 ${isPref ? "bg-brass/5" : ""}`}>
                    <td className="py-2 text-paper">
                      {m}y{isPref && <span className="text-[9px] text-brass-soft ml-1.5 uppercase tracking-wide">pref (display-only)</span>}
                    </td>
                    <td className="py-2 num text-right text-paper-dim">{row?.yieldPct != null ? `${Number(row.yieldPct).toFixed(2)}%` : "—"}</td>
                    <td className="py-2 num text-right text-paper-dim">{row?.Dmod != null ? Number(row.Dmod).toFixed(2) : "—"}</td>
                    <td className="py-2 num text-right text-paper-dim">{fmtPctVal(row?.BE)}</td>
                    <td className="py-2 num text-right text-paper font-medium">{row?.EFF != null ? Number(row.EFF).toFixed(2) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[9px] text-paper-dim/50 mt-2">
          Instrument preference <span className="text-paper">{signal.instrument_pref ?? "—"}</span> — also display-only (§0b #3).
        </p>
      </div>

      {/* 3. 10y yield chart, shaded by curve regime */}
      <div className="card p-4 mb-6">
        <p className="label text-[10px] mb-3">10y Treasury yield (DGS10), shaded by curve regime · last {LOOKBACK_YEARS}y</p>
        {chartData.length === 0 ? (
          <p className="text-paper-dim text-sm">No yield history loaded.</p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                {regimeZones.map((z, i) => (
                  <ReferenceArea
                    key={`${z.regime}-${z.from}-${i}`}
                    x1={z.from} x2={z.to}
                    fill={CURVE_REGIME_META[z.regime]?.fill ?? "transparent"}
                    fillOpacity={CURVE_REGIME_OPACITY[z.regime] ?? 0.14}
                    stroke="none"
                  />
                ))}
                <XAxis dataKey="date" tick={{ fill: DIM, fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={50} />
                <YAxis domain={["auto", "auto"]} tick={{ fill: DIM, fontSize: 10 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v.toFixed(1)}%`} />
                <Tooltip content={<YieldChartTooltip />} />
                <Line type="monotone" dataKey="dgs10" name="DGS10" stroke={PAPER} strokeWidth={1.25} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap items-center gap-3 mt-2 text-[10px] text-paper-dim/70">
              {Object.entries(CURVE_REGIME_META).map(([key, meta]) => (
                <span key={key} className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: meta.swatch }} />
                  {meta.label}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 5. Context — computed and shown, but carries no weight in duration_score (v3) */}
      <div className="card p-4 mb-6 opacity-70">
        <p className="label text-[10px] mb-1">Context — not used in the decision</p>
        <p className="text-[10px] text-paper-dim/60 mb-3 leading-relaxed">
          duration_score is valuation-only in v3 (§0b #1, §5.1) — path/carry/quadrant/curve/trend are still
          computed and shown here for reference, but carry zero weight in the stance above.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-[11px]">
          <div>
            <p className="text-paper-dim">Path</p>
            <p className="num text-paper-dim">{fmtNum(context?.path_score)}</p>
          </div>
          <div>
            <p className="text-paper-dim">Carry</p>
            <p className="num text-paper-dim">{fmtNum(context?.carry_score)}</p>
          </div>
          <div>
            <p className="text-paper-dim">Quadrant</p>
            <p className="num text-paper-dim">{fmtNum(context?.quadrant_score)}</p>
          </div>
          <div>
            <p className="text-paper-dim">Curve</p>
            <p className="num text-paper-dim">{fmtNum(context?.curve_score)}</p>
          </div>
          <div>
            <p className="text-paper-dim">Trend</p>
            <p className="num text-paper-dim">{fmtNum(context?.trend_score)} <span className="text-[9px]">({context?.trend_state ?? "—"})</span></p>
          </div>
        </div>
      </div>
    </Shell>
  );
}
