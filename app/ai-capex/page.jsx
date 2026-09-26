"use client";
import { useEffect, useMemo, useState } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";
import { CAPEX_REGIME_META, CAPEX_SCENARIO_META, CAPEX_PILLARS } from "../../lib/capexOverlay";
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, Area, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine,
} from "recharts";

// AI Capex Cycle Overlay — dashboard for supabase/functions/compute-capex-cycle.
// Reads capex_cycle_readings (daily live rows + month-end walk-forward backfill),
// capex_indicator_defs / capex_indicator_observations (incl. manual inputs), and
// capex_scenarios (priors). Manual observations are written straight to
// capex_indicator_observations with is_manual=true (RLS allows authenticated
// insert/update of manual rows only), then a fast recompute (skip_ingest=1) refreshes
// today's reading.

const FN_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/compute-capex-cycle`;
const GRID = "#2A3240", DIM = "#A8ADB8", BRASS = "#C9A227", GAIN = "#3FB984", LOSS = "#E0635C", INDIGO = "#818CF8";

const TRIGGER_META = {
  capex_decel: { label: "Capex growth rolling over", rule: "TTM capex YoY down >10pp vs 2 quarters ago" },
  credit_widening: { label: "Credit widening", rule: "HY OAS up >75bp in 3 months" },
  bdc_stress: { label: "Private-credit stress", rule: "BIZD >15% below 52-week high" },
  semis_trend_break: { label: "Semis trend break", rule: "SMH below its 200-day average" },
  fcf_squeeze: { label: "Hyperscaler FCF squeeze", rule: "FCF margin <5% or down >5pp YoY" },
  gpu_price_drop: { label: "GPU rental collapse", rule: "GPU rental prices down >30% YoY (manual)" },
};

const BUCKET_LABEL = {
  equity: "Equity", ai_semis: "AI / Semis", credit: "Credit", long_bonds: "Long bonds", gold: "Gold", bitcoin: "Bitcoin", cash: "Cash",
};

const KEY_SIGNALS = [
  { key: "hs_capex_yoy", label: "Hyperscaler capex YoY", fmt: (v) => `${v.toFixed(1)}%` },
  { key: "hs_capex_to_ocf", label: "Capex / operating cash flow", fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: "hs_fcf_margin", label: "FCF margin after capex", fmt: (v) => `${v.toFixed(1)}%` },
  { key: "hy_oas", label: "HY spread (OAS)", fmt: (v) => `${v.toFixed(2)}%` },
  { key: "dgs10", label: "10Y Treasury", fmt: (v) => `${v.toFixed(2)}%` },
  { key: "smh_spy_rel_12m", label: "Semis vs S&P, 12m", fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}pp` },
];

const fmtDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const num = (v) => (v == null || v === "" ? null : Number(v));

function zTone(z) {
  if (z == null) return "text-paper-dim";
  if (z >= 1.5) return "text-loss";
  if (z >= 0.75) return "text-brass-soft";
  if (z <= -0.75) return "text-gain";
  return "text-paper";
}

function ChartTooltip({ active, payload, label, digits = 2, pct = false }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[170px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => p.value == null ? null : (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.stroke ?? p.fill }}>{p.name}</span>
          <span className="num text-paper">{pct ? `${(Number(p.value) * 100).toFixed(0)}%` : Number(p.value).toFixed(digits)}</span>
        </div>
      ))}
    </div>
  );
}

function ManualEntry({ def, latest, onSaved }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    const v = Number(value);
    if (!isFinite(v) || value === "") { setErr("Enter a number"); return; }
    setSaving(true); setErr("");
    const { error } = await supabase.from("capex_indicator_observations").upsert({
      indicator_code: def.code, obs_date: date, value: v, is_manual: true,
      note: note || null, source_url: url || null,
    }, { onConflict: "indicator_code,obs_date" });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setValue(""); setNote(""); setUrl(""); setOpen(false);
    onSaved();
  }

  return (
    <div className="mt-2">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-[11px] text-brass-soft hover:text-brass">
          + Add value{latest ? ` (last: ${latest.value} on ${fmtDate(latest.obs_date)})` : " — none entered yet"}
        </button>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[130px_110px_1fr] gap-2 items-start">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field text-xs py-1.5" />
          <input type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} placeholder={def.unit || "value"} className="field text-xs py-1.5" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Checkable note — what the number is and where it came from" className="field text-xs py-1.5" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Source URL (optional)" className="field text-xs py-1.5 sm:col-span-2" />
          <div className="flex gap-2">
            <button onClick={save} disabled={saving} className="btn text-xs py-1.5 px-3">{saving ? "Saving…" : "Save"}</button>
            <button onClick={() => { setOpen(false); setErr(""); }} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
          </div>
          {err && <p className="text-[11px] text-loss sm:col-span-3">{err}</p>}
        </div>
      )}
    </div>
  );
}

export default function AiCapexPage() {
  const [readings, setReadings] = useState([]);
  const [defs, setDefs] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [manualObs, setManualObs] = useState([]);
  const [busy, setBusy] = useState(true);
  const [running, setRunning] = useState(null); // "full" | "quick" | null
  const [runMsg, setRunMsg] = useState("");
  const [showMethod, setShowMethod] = useState(false);
  const [expanded, setExpanded] = useState({ intensity: true });

  async function load() {
    const [{ data: r }, { data: d }, { data: s }, { data: m }] = await Promise.all([
      supabase.from("capex_cycle_readings").select("*").order("reading_date", { ascending: true }),
      supabase.from("capex_indicator_defs").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("capex_scenarios").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("capex_indicator_observations").select("indicator_code, obs_date, value, note, source_url")
        .eq("is_manual", true).order("obs_date", { ascending: false }).limit(500),
    ]);
    setReadings(r ?? []);
    setDefs(d ?? []);
    setScenarios(s ?? []);
    setManualObs(m ?? []);
    setBusy(false);
  }
  useEffect(() => { load(); }, []);

  async function runNow(quick) {
    setRunning(quick ? "quick" : "full"); setRunMsg("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FN_URL}${quick ? "?skip_ingest=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: "{}",
      });
      const j = await res.json();
      const errs = Object.keys(j?.errors ?? {});
      setRunMsg(res.ok ? `Updated · regime ${j.regime}, CCSI ${Number(j.ccsi).toFixed(2)}${errs.length ? ` · ${errs.length} source warning(s): ${errs.join(", ")}` : ""}` : `Error: ${j?.error ?? res.status}`);
    } catch (e) { setRunMsg(`Error: ${e.message}`); }
    await load();
    setRunning(null);
  }

  const live = useMemo(() => [...readings].reverse().find((r) => !r.is_backfill) ?? readings.at(-1) ?? null, [readings]);
  const latestManual = useMemo(() => {
    const map = {};
    for (const o of manualObs) if (!map[o.indicator_code]) map[o.indicator_code] = o;
    return map;
  }, [manualObs]);

  // History: month-end backfill + live rows (one point per month, live overrides its month)
  const history = useMemo(() => {
    const byMonth = new Map();
    for (const r of readings) {
      const m = String(r.reading_date).slice(0, 7);
      const prev = byMonth.get(m);
      if (!prev || !r.is_backfill || prev.is_backfill) byMonth.set(m, r);
    }
    return [...byMonth.values()].filter((r) => r.ccsi != null).map((r) => ({
      date: String(r.reading_date).slice(0, 7),
      ccsi: num(r.ccsi), hazard: num(r.peak_hazard_12m),
      H1: num(r.posteriors?.H1_BLOWOFF_THEN_BEAR), H2: num(r.posteriors?.H2_PRODUCTIVITY_BULL),
      H3: num(r.posteriors?.H3_EARLY_BUST), H4: num(r.posteriors?.H4_RATE_SHOCK),
      eq: num(r.equity_multiplier), ai: num(r.ai_semis_multiplier), regime: r.regime_key,
    }));
  }, [readings]);

  const defsByPillar = useMemo(() => {
    const map = {};
    for (const d of defs) (map[d.pillar] ??= []).push(d);
    return map;
  }, [defs]);

  const regime = live ? CAPEX_REGIME_META[live.regime_key] ?? CAPEX_REGIME_META.boom : null;
  const priorSum = scenarios.reduce((s, x) => s + Number(x.prior), 0) || 1;
  const manualDefs = defs.filter((d) => d.source === "manual");
  const manualMissing = manualDefs.filter((d) => !latestManual[d.code]).length;

  function exportJson() {
    const blob = new Blob([JSON.stringify({ latest: live, history, defs, scenarios, manual: manualObs }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-capex-cycle-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold">AI Capex Cycle</h1>
            <p className="text-xs text-paper-dim mt-0.5">
              Is the AI build-out stretching toward a capex bust? · {live ? `computed ${fmtDateTime(live.computed_at)}` : "not yet computed"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button onClick={() => runNow(true)} disabled={!!running} className="btn-ghost text-xs disabled:opacity-50" title="Recompute from stored data — use after entering manual values">
              {running === "quick" ? "Recomputing…" : "Recompute"}
            </button>
            <button onClick={() => runNow(false)} disabled={!!running} className="btn-ghost text-xs disabled:opacity-50" title="Re-pull FRED, SEC filings and prices, then recompute">
              {running === "full" ? "Refreshing… (~1–2 min)" : "Run Full Refresh"}
            </button>
            <button onClick={exportJson} disabled={!live} className="btn text-xs disabled:opacity-50">Export JSON</button>
          </div>
        </div>
        {runMsg && <p className={`text-xs mb-4 ${runMsg.startsWith("Error") ? "text-loss" : "text-paper-dim"}`}>{runMsg}</p>}

        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : !live ? (
          <div className="card p-10 text-center"><p className="text-paper-dim text-sm">No readings yet — click Run Full Refresh.</p></div>
        ) : (
          <>
            {/* Disclaimer + methodology */}
            <div className="card p-3 mb-6 border-brass/20 bg-brass/5 flex items-start justify-between gap-3">
              <p className="text-[11px] text-paper-dim leading-relaxed">
                A <span className="text-paper">regime and scenario tracker, not a timing signal</span>. The 2012–26 walk-forward contains no capex bust, and in it high stress preceded
                <span className="text-paper"> stronger</span> returns; the only full capex bust on record (2000) is a single example. The peak-hazard figure is uncalibrated and not used in any multiplier.
                {live.shadow_mode && <> The overlay is in <span className="text-brass-soft">shadow mode</span>: portfolios show what it would do but targets are unchanged.</>}
              </p>
              <button onClick={() => setShowMethod((v) => !v)} className="text-[10px] text-brass-soft shrink-0 whitespace-nowrap">{showMethod ? "Hide" : "Methodology"}</button>
            </div>
            {showMethod && (
              <div className="card p-4 mb-6 text-[11px] text-paper-dim leading-relaxed space-y-2">
                <p><span className="text-paper font-medium">CCSI (Capex Cycle Stress Index)</span> — each indicator is z-scored against its own trailing 10 years (only data published by that date), sign-adjusted so positive = more bust stress, averaged within five pillars, then weighted 25/25/20/15/15 (intensity, financing, returns, overcapacity, market). 0 = normal, +1 = one standard deviation stretched.</p>
                <p><span className="text-paper font-medium">Hyperscaler data</span> comes from SEC XBRL filings for MSFT, GOOGL, AMZN, META and ORCL (cash PP&amp;E only — excludes finance leases, so it understates true capex; off-balance-sheet SPVs need the manual financing input).</p>
                <p><span className="text-paper font-medium">Regime</span> — de-risking regimes (Turn, Bust) require hyperscaler capex growth below 10% YoY. Trigger clusters while capex is still growing are classed as Correction, because every such cluster 2016–25 was followed by strong returns.</p>
                <p><span className="text-paper font-medium">Scenarios</span> — pre-registered evidence rules (likelihoods set in advance) update your priors each day from the current evidence state, recomputed from the prior (not compounded). Correlated rules in the same group are averaged. Bucket multipliers = posterior-weighted scenario postures × regime adjustment.</p>
              </div>
            )}

            {/* Hero */}
            <div className="grid grid-cols-1 lg:grid-cols-[220px_220px_1fr] gap-4 mb-6">
              <div className={`card p-5 flex flex-col items-center justify-center border ${regime.border} ${regime.bg}`}>
                <p className="label text-[10px] mb-2">Stress index (CCSI)</p>
                <p className={`num text-5xl font-bold ${regime.tone}`}>{Number(live.ccsi).toFixed(2)}</p>
                <p className="text-[10px] text-paper-dim mt-1">σ above 10-year norm</p>
              </div>
              <div className={`card p-5 flex flex-col items-center justify-center text-center border ${regime.border}`}>
                <p className="label text-[10px] mb-2">Regime</p>
                <p className={`text-2xl font-semibold ${regime.tone}`}>{regime.label}</p>
                <p className="text-[10px] text-paper-dim mt-1">confidence {live.regime_confidence}%</p>
                <p className="text-[10px] text-paper-dim/70 mt-2 leading-snug">{regime.desc}</p>
              </div>
              <div className="card p-4">
                <p className="label text-[10px] mb-3">Key signals</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                  {KEY_SIGNALS.map((k) => {
                    const v = num(live.signals?.[k.key]);
                    return (
                      <div key={k.key}>
                        <p className="text-[10px] text-paper-dim leading-tight">{k.label}</p>
                        <p className="num text-base text-paper">{v == null ? "—" : k.fmt(v)}</p>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-paper-dim/60 mt-3">
                  12m peak hazard <span className="num">{(Number(live.peak_hazard_12m) * 100).toFixed(0)}%</span> (uncalibrated)
                </p>
              </div>
            </div>

            {/* Scenarios + pillars */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="card p-4">
                <p className="label text-[10px] mb-3">Scenario posteriors</p>
                <div className="space-y-3">
                  {CAPEX_SCENARIO_META.map((s) => {
                    const post = num(live.posteriors?.[s.code]) ?? 0;
                    const sc = scenarios.find((x) => x.code === s.code);
                    const prior = sc ? Number(sc.prior) / priorSum : null;
                    return (
                      <div key={s.code}>
                        <div className="flex items-baseline justify-between mb-1">
                          <span className="text-xs text-paper">{sc?.label ?? s.label}</span>
                          <span className="num text-sm font-semibold text-paper">{(post * 100).toFixed(0)}%
                            {prior != null && <span className="text-[10px] text-paper-dim font-normal"> · prior {(prior * 100).toFixed(0)}%</span>}
                          </span>
                        </div>
                        <div className="h-2 w-full bg-ink rounded overflow-hidden relative">
                          <div className={`h-full ${s.bar}`} style={{ width: `${Math.min(100, post * 100)}%` }} />
                          {prior != null && <div className="absolute top-0 h-full w-px bg-paper/60" style={{ left: `${prior * 100}%` }} />}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="label text-[10px] mt-5 mb-2">Evidence firing today</p>
                {(live.fired_evidence ?? []).length === 0 ? (
                  <p className="text-[11px] text-paper-dim">None — posteriors equal priors.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {live.fired_evidence.map((f) => (
                      <span key={f.code} className="text-[10px] px-1.5 py-0.5 rounded border border-ink-line text-paper-dim" title={`${f.group} · value ${f.value}`}>{f.label}</span>
                    ))}
                  </div>
                )}
              </div>

              <div className="card p-4">
                <p className="label text-[10px] mb-3">Pillar stress (z)</p>
                <div className="space-y-2.5">
                  {CAPEX_PILLARS.map((p) => {
                    const v = num(live[p.col]);
                    const n = live.coverage?.[p.key] ?? 0;
                    const total = defsByPillar[p.key]?.length ?? 0;
                    const w = v == null ? 0 : Math.min(50, Math.abs(v) / 3 * 50);
                    return (
                      <div key={p.key}>
                        <div className="flex items-baseline justify-between text-xs mb-1">
                          <span className="text-paper">{p.label} <span className="text-[10px] text-paper-dim">· {n}/{total} indicators</span></span>
                          <span className={`num ${zTone(v)}`}>{v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`}</span>
                        </div>
                        <div className="h-2 w-full bg-ink rounded relative overflow-hidden">
                          <div className="absolute top-0 h-full w-px bg-paper-dim/50 left-1/2" />
                          {v != null && <div className={`absolute top-0 h-full ${v >= 0 ? "bg-loss/70" : "bg-gain/70"}`} style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="label text-[10px] mt-5 mb-2">Triggers ({live.trigger_count}/6)</p>
                <div className="space-y-1.5">
                  {Object.entries(TRIGGER_META).map(([k, t]) => {
                    const on = live.triggers?.[k];
                    return (
                      <div key={k} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className={on ? "text-paper" : "text-paper-dim"} title={t.rule}>{t.label}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${on ? "text-loss bg-loss/10 border-loss/30" : "text-paper-dim border-ink-line"}`}>{on ? "fired" : "off"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Multipliers */}
            <div className="card p-4 mb-6">
              <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
                <p className="label text-[10px]">Bucket multipliers</p>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${live.shadow_mode ? "text-brass-soft bg-brass/10 border-brass/30" : "text-gain bg-gain/10 border-gain/30"}`}>
                  {live.shadow_mode ? "Shadow — not applied to portfolios" : "Live — cuts applied to resize-overlay & regime-driven portfolios"}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                {Object.entries(BUCKET_LABEL).map(([b, label]) => {
                  const m = num(live.bucket_multipliers?.[b]);
                  const tone = m == null ? "text-paper-dim" : m < 0.95 ? "text-loss" : m > 1.05 ? "text-gain" : "text-paper";
                  return (
                    <div key={b} className="text-center">
                      <p className="text-[10px] text-paper-dim">{label}</p>
                      <p className={`num text-lg font-semibold ${tone}`}>{m == null ? "—" : `×${m.toFixed(2)}`}</p>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-paper-dim/60 mt-3">Portfolios apply cuts only (multipliers above 1 are informational). Symbol → bucket mapping lives in capex_bucket_symbol_map.</p>
            </div>

            {/* History */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="card p-4">
                <p className="label text-[10px] mb-3">History — CCSI &amp; equity multiplier</p>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: DIM, fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={40} />
                    <YAxis yAxisId="l" tick={{ fill: DIM, fontSize: 10 }} tickLine={false} axisLine={false} width={30} />
                    <YAxis yAxisId="r" orientation="right" domain={[0.4, 1.2]} tick={{ fill: DIM, fontSize: 10 }} tickLine={false} axisLine={false} width={30} />
                    <Tooltip content={<ChartTooltip />} />
                    <ReferenceLine yAxisId="l" y={0} stroke={DIM} strokeOpacity={0.3} />
                    <ReferenceLine yAxisId="l" y={0.75} stroke={BRASS} strokeDasharray="4 2" strokeOpacity={0.4} />
                    <Line yAxisId="l" type="monotone" dataKey="ccsi" name="CCSI" stroke={BRASS} strokeWidth={2} dot={false} />
                    <Line yAxisId="r" type="stepAfter" dataKey="eq" name="Equity ×" stroke={GAIN} strokeWidth={1.25} dot={false} />
                    <Line yAxisId="r" type="stepAfter" dataKey="ai" name="AI/semis ×" stroke={INDIGO} strokeWidth={1.25} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="text-[10px] text-paper-dim/60 mt-1">Month-end walk-forward from 2012 using only data published at each date. Dashed line = blow-off threshold.</p>
              </div>
              <div className="card p-4">
                <p className="label text-[10px] mb-3">History — scenario posteriors</p>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: DIM, fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={40} />
                    <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fill: DIM, fontSize: 10 }} tickLine={false} axisLine={false} width={34} />
                    <Tooltip content={<ChartTooltip pct />} />
                    <Line type="monotone" dataKey="H1" name="Blow-off → bear" stroke={BRASS} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="H2" name="Productivity bull" stroke={GAIN} strokeWidth={1.25} dot={false} />
                    <Line type="monotone" dataKey="H3" name="Early bust" stroke={LOSS} strokeWidth={1.25} dot={false} />
                    <Line type="monotone" dataKey="H4" name="Rate shock" stroke={INDIGO} strokeWidth={1.25} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap items-center gap-3 mt-1 text-[10px] text-paper-dim/70">
                  {[["Blow-off → bear", BRASS], ["Productivity bull", GAIN], ["Early bust", LOSS], ["Rate shock", INDIGO]].map(([l, c]) => (
                    <span key={l} className="flex items-center gap-1.5"><span className="inline-block w-5 h-[2px]" style={{ background: c }} />{l}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Indicators */}
            <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
              <p className="label text-[10px]">Indicators — {defs.filter((d) => d.pillar !== "aux").length} across 5 pillars</p>
              {manualMissing > 0 && <p className="text-[11px] text-brass-soft">{manualMissing} manual input{manualMissing > 1 ? "s" : ""} still empty</p>}
            </div>
            <div className="space-y-3 mb-6">
              {CAPEX_PILLARS.map((p) => {
                const list = defsByPillar[p.key] ?? [];
                const v = num(live[p.col]);
                return (
                  <div key={p.key} className="card overflow-hidden">
                    <button onClick={() => setExpanded((e) => ({ ...e, [p.key]: !e[p.key] }))} className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink/40 transition-colors text-left">
                      <div>
                        <p className="text-sm font-semibold text-paper">{p.label}</p>
                        <p className="text-[10px] text-paper-dim mt-0.5">{live.coverage?.[p.key] ?? 0} of {list.length} indicators reporting</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`num text-sm font-semibold ${zTone(v)}`}>{v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`}</span>
                        <span className={`text-paper-dim transition-transform ${expanded[p.key] ? "rotate-180" : ""}`}>▾</span>
                      </div>
                    </button>
                    {expanded[p.key] && (
                      <div className="px-4 pb-2 border-t border-ink-line">
                        {list.map((d) => {
                          const iz = live.indicator_z?.[d.code];
                          const sz = num(iz?.signed_z);
                          return (
                            <div key={d.code} className="py-3 border-b border-ink-line last:border-b-0">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-sm text-paper font-medium">
                                    {d.label}
                                    <span className="ml-2 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border border-ink-line text-paper-dim">{d.source}</span>
                                  </p>
                                  <p className="text-[11px] text-paper-dim leading-relaxed mt-0.5">{d.description}</p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="num text-sm text-paper">{iz ? `${Number(iz.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${d.unit && d.unit.length <= 6 ? ` ${d.unit}` : ""}` : "—"}</p>
                                  <p className={`num text-[11px] ${zTone(sz)}`}>{sz == null ? (iz ? "z: need more history" : "no data") : `stress z ${sz > 0 ? "+" : ""}${sz.toFixed(2)}`}</p>
                                  {iz && <p className="text-[10px] text-paper-dim/60">{fmtDate(iz.obs_date)}</p>}
                                </div>
                              </div>
                              {d.source === "manual" && <ManualEntry def={d} latest={latestManual[d.code]} onSaved={() => runNow(true)} />}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-paper-dim/60">
              Manual series need 4 entries before they get a z-score (or set ref_mean/ref_std on the indicator for an anchored z sooner). Saving a value triggers a recompute.
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}
