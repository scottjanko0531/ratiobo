"use client";
import { useState, useEffect, useMemo } from "react";
import { supabase } from "../lib/supabase";
import {
  ComposedChart, Line, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

const GAUGE_META = [
  {
    key: "gauge1",
    label: "Debt Sustainability Risk",
    desc: "Debt-to-GDP + debt-to-income gap",
    yearKey: "year",
  },
  {
    key: "gauge2",
    label: "Policy Room Risk",
    desc: "Fed Funds rate inverted (low rates = less room to cut)",
  },
  {
    key: "gauge3",
    label: "Growth-Inflation Risk",
    desc: "Stagflation signal: falling real growth + elevated CPI",
  },
  {
    key: "gauge4",
    label: "Income Affordability Risk",
    desc: "Debt growth outpacing income growth",
  },
  {
    key: "gauge5",
    label: "Reserve Confidence Risk",
    desc: "CB gold buying + weakening Treasury auction demand",
  },
];

const RISK_RANGES = [
  { label: "All", from: 1952 },
  { label: "2000–", from: 2000 },
  { label: "2010–", from: 2010 },
];

function CloseIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <line x1="3" y1="3" x2="13" y2="13" />
      <line x1="13" y1="3" x2="3" y2="13" />
    </svg>
  );
}

function RiskTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => {
        if (p.value == null) return null;
        const sign = p.value >= 0 ? "+" : "";
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span style={{ color: p.fill ?? p.color }}>{p.name}</span>
            <span className="num text-paper">{sign}{Number(p.value).toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
}

function DebtSustainabilityDrawer({ open, onClose, latestGauge }) {
  const [rows, setRows] = useState(null);
  const [gaugeHistory, setGaugeHistory] = useState(null);
  const [range, setRange] = useState(1952);

  useEffect(() => {
    if (!open || rows !== null) return;
    Promise.all([
      supabase.from("macro_debt_cycle").select("year,debt_to_gdp_pct").order("year"),
      supabase.from("dalio_gauge_readings").select("year,gauge1,z_debt_gdp,z_debt_income").order("year"),
    ]).then(([debt, gauge]) => {
      setRows(debt.data ?? []);
      setGaugeHistory(gauge.data ?? []);
    });
  }, [open, rows]);

  const { chartData, mean, stddev } = useMemo(() => {
    if (!rows || rows.length === 0) return { chartData: [], mean: 0, stddev: 1 };

    const allVals = rows.filter((r) => r.debt_to_gdp_pct != null).map((r) => Number(r.debt_to_gdp_pct));
    const m = allVals.reduce((s, v) => s + v, 0) / allVals.length;
    const sd = Math.sqrt(allVals.reduce((s, v) => s + (v - m) ** 2, 0) / allVals.length);

    const byYear = Object.fromEntries(rows.filter((r) => r.debt_to_gdp_pct != null).map((r) => [r.year, Number(r.debt_to_gdp_pct)]));
    const z = (v) => (v - m) / sd;

    const filtered = rows.filter((r) => r.year >= range && r.debt_to_gdp_pct != null);
    const data = filtered.map((r) => {
      const zScore = z(Number(r.debt_to_gdp_pct));
      const prev = byYear[r.year - 1];
      return {
        year: r.year,
        zScore: Math.round(zScore * 1000) / 1000,
        change: prev != null ? Math.round((zScore - z(prev)) * 1000) / 1000 : null,
      };
    });

    return { chartData: data, mean: m, stddev: sd };
  }, [rows, range]);

  const gaugeRows = gaugeHistory?.filter((r) => r.gauge1 != null) ?? [];

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
            <h2 className="text-sm font-semibold text-paper">Debt Sustainability Risk</h2>
            <p className="text-[10px] text-paper-dim mt-0.5">Debt/GDP z-score · computed from full history 1952–present</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {latestGauge != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${latestGauge > 1 ? "text-loss" : latestGauge < -1 ? "text-gain" : "text-brass-soft"}`}>
                  {latestGauge >= 0 ? "+" : ""}{Number(latestGauge).toFixed(2)}
                </p>
                <p className="text-[10px] text-paper-dim mt-0.5">Current z</p>
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
            {RISK_RANGES.map((r) => (
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
              <p className="label text-[10px] mb-3">Debt/GDP z-score · {range}–present</p>
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
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => v.toFixed(1)}
                    width={36}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fill: "#A8ADB8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
                    width={44}
                  />
                  <Tooltip content={<RiskTooltip />} />
                  {/* Zone thresholds */}
                  <ReferenceLine yAxisId="left" y={1}  stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <ReferenceLine yAxisId="left" y={0}  stroke="#2A3240" strokeWidth={1} />
                  <ReferenceLine yAxisId="left" y={-1} stroke="#22c55e" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
                  <ReferenceLine yAxisId="right" y={0} stroke="#2A3240" strokeWidth={1} />
                  <Bar yAxisId="right" dataKey="change" name="YoY Δ" maxBarSize={12}>
                    {chartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={entry.change == null ? "transparent" : entry.change >= 0 ? "#E0635C" : "#3FB984"}
                        fillOpacity={0.6}
                      />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="zScore"
                    name="Risk z-score"
                    stroke="#C9A227"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1"><span className="inline-block w-6 h-px bg-[#ef4444] opacity-50" /> Elevated (&gt; +1)</span>
                <span className="flex items-center gap-1"><span className="inline-block w-6 h-px bg-[#22c55e] opacity-50" /> Low (&lt; −1)</span>
              </div>
            </div>
          )}

          {/* Actual gauge readings where available */}
          {gaugeRows.length > 0 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Composite Gauge Readings (actual)</p>
              <p className="text-[10px] text-paper-dim mb-2 leading-relaxed">
                Composite of Debt/GDP z-score + Debt/Income z-score. Available annually.
              </p>
              <div className="space-y-1.5">
                {gaugeRows.slice().reverse().map((r) => (
                  <div key={r.year} className="flex items-center justify-between text-xs">
                    <span className="text-paper-dim">{r.year}</span>
                    <div className="flex items-center gap-3">
                      {r.z_debt_gdp != null && (
                        <span className="text-paper-dim text-[10px]">Debt/GDP: <span className="num text-paper">{Number(r.z_debt_gdp) >= 0 ? "+" : ""}{Number(r.z_debt_gdp).toFixed(2)}</span></span>
                      )}
                      {r.z_debt_income != null && (
                        <span className="text-paper-dim text-[10px]">Debt/Inc: <span className="num text-paper">{Number(r.z_debt_income) >= 0 ? "+" : ""}{Number(r.z_debt_income).toFixed(2)}</span></span>
                      )}
                      <span className={`num font-semibold ${Number(r.gauge1) > 1 ? "text-loss" : Number(r.gauge1) < -1 ? "text-gain" : "text-brass-soft"}`}>
                        {Number(r.gauge1) >= 0 ? "+" : ""}{Number(r.gauge1).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60 leading-relaxed">
            z-score computed from full 1952–present history of Debt/GDP · <span className="font-mono">macro_debt_cycle</span>
          </p>
        </div>
      </div>
    </>
  );
}

// SVG speedometer gauge.
// Scale: z-score from -3 (low risk, green/left) to +3 (elevated risk, red/right).
// Zones: green ≤ -1, brass -1..+1, red ≥ +1.
function SpeedometerGauge({ value, label, desc, year, onClick }) {
  // cy=82 keeps the arc bottom within viewBox "20 10 160 80" (visible y: 10–90)
  const cx = 100, cy = 82, r = 68;
  const nl = 56;

  const clamped = value != null ? Math.max(-3, Math.min(3, value)) : 0;
  // Map value to angle: -3 → π (left), 0 → π/2 (top), +3 → 0 (right)
  const angle = Math.PI - ((clamped + 3) / 6) * Math.PI;
  const nx = cx + nl * Math.cos(angle);
  const ny = cy - nl * Math.sin(angle);

  // Zone boundary points on the arc
  const pt = (a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  const [lx, ly] = pt(Math.PI);            // z = -3 (left)
  const [m1x, m1y] = pt((2 * Math.PI) / 3); // z = -1
  const [m2x, m2y] = pt(Math.PI / 3);       // z = +1
  const [rx, ry] = pt(0);                   // z = +3 (right)

  const f = (n) => n.toFixed(2);

  const status =
    value == null ? "unknown" : value > 1 ? "elevated" : value < -1 ? "low" : "neutral";
  const needleColor =
    status === "elevated" ? "#ef4444" : status === "low" ? "#22c55e" : "#c9982c";
  const statusLabel =
    status === "elevated"
      ? "Elevated Risk"
      : status === "low"
      ? "Low Risk"
      : status === "neutral"
      ? "Neutral"
      : "—";
  const statusClass =
    status === "elevated"
      ? "text-loss"
      : status === "low"
      ? "text-gain"
      : "text-brass-soft";

  // Arc helper: sweep=1 (clockwise on screen = goes through top of circle)
  const arc = (x1, y1, x2, y2, color, op = 0.5) => (
    <path
      d={`M ${f(x1)},${f(y1)} A ${r},${r} 0 0,1 ${f(x2)},${f(y2)}`}
      fill="none"
      stroke={color}
      strokeWidth="9"
      strokeLinecap="butt"
      strokeOpacity={op}
    />
  );

  return (
    <div
      className={`card p-4 flex flex-col items-center ${onClick ? "cursor-pointer hover:border-brass/40 transition-colors" : ""}`}
      onClick={onClick}
    >
      <p className="text-xs font-medium text-paper text-center leading-snug mb-2 min-h-[2rem]">
        {label}
      </p>

      {/* Gauge arc + needle only — no text inside SVG to avoid clipping */}
      <svg viewBox="20 10 160 80" className="w-full max-w-[190px]">
        {/* Track background */}
        <path
          d={`M ${f(lx)},${f(ly)} A ${r},${r} 0 0,1 ${f(rx)},${f(ry)}`}
          fill="none"
          stroke="#252525"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* Green zone: -3 to -1 */}
        {arc(lx, ly, m1x, m1y, "#22c55e")}
        {/* Brass zone: -1 to +1 */}
        {arc(m1x, m1y, m2x, m2y, "#c9982c")}
        {/* Red zone: +1 to +3 */}
        {arc(m2x, m2y, rx, ry, "#ef4444")}

        {/* Needle */}
        <line
          x1={cx} y1={cy}
          x2={f(nx)} y2={f(ny)}
          stroke={needleColor}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        {/* Pivot */}
        <circle cx={cx} cy={cy} r="4.5" fill={needleColor} />
      </svg>

      {/* Value, status, and metadata rendered as HTML below the gauge */}
      <p className={`num text-xl font-bold leading-none mt-1 ${statusClass}`}>
        {value != null ? (value >= 0 ? "+" : "") + value.toFixed(2) : "—"}
      </p>
      <p className={`text-xs font-semibold mt-1 ${statusClass}`}>{statusLabel}</p>
      {year && (
        <p className="text-[9px] text-paper-dim/60 mt-0.5">As of {year}</p>
      )}
      {desc && (
        <p className="text-[10px] text-paper-dim text-center mt-1.5 leading-snug">{desc}</p>
      )}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

export default function DalioGauges() {
  const [latest, setLatest] = useState(null);
  const [wgcData, setWgcData] = useState([]);
  const [showWgc, setShowWgc] = useState(false);
  const [debtSustOpen, setDebtSustOpen] = useState(false);
  const [newYear, setNewYear] = useState("");
  const [newTonnes, setNewTonnes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    fetchReadings();
    fetchWgc();
  }, []);

  async function fetchReadings() {
    const { data } = await supabase
      .from("dalio_gauge_readings")
      .select("year,gauge1,gauge2,gauge3,gauge4,gauge5")
      .order("year", { ascending: false })
      .limit(5);

    if (!data) return;

    // Most-recent non-null value per gauge
    const result = {};
    for (const row of data) {
      for (const g of ["gauge1", "gauge2", "gauge3", "gauge4", "gauge5"]) {
        if (result[g] == null && row[g] != null) {
          result[g] = { value: Number(row[g]), year: row.year };
        }
      }
    }
    setLatest(result);
  }

  async function fetchWgc() {
    const { data } = await supabase
      .from("wgc_gold_purchases")
      .select("*")
      .order("year", { ascending: false });
    setWgcData(data ?? []);
  }

  async function saveWgcEntry() {
    const yr = parseInt(newYear, 10);
    const t = parseFloat(newTonnes);
    if (isNaN(yr) || isNaN(t)) {
      setSaveError("Enter a valid year and tonnes.");
      return;
    }
    setSaving(true);
    setSaveError("");
    const { error } = await supabase
      .from("wgc_gold_purchases")
      .upsert(
        { year: yr, tonnes: t, is_actual: true, updated_at: new Date().toISOString() },
        { onConflict: "year" }
      );
    setSaving(false);
    if (error) { setSaveError(error.message); return; }
    setNewYear("");
    setNewTonnes("");
    fetchWgc();
  }

  if (!latest) return null;

  return (
    <div className="mb-2">
      {/* Gauge grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
        {GAUGE_META.map(({ key, label, desc }) => (
          <SpeedometerGauge
            key={key}
            value={latest[key]?.value ?? null}
            year={latest[key]?.year}
            label={label}
            desc={desc}
            onClick={key === "gauge1" ? () => setDebtSustOpen(true) : undefined}
          />
        ))}
      </div>
      <DebtSustainabilityDrawer
        open={debtSustOpen}
        onClose={() => setDebtSustOpen(false)}
        latestGauge={latest?.gauge1?.value ?? null}
      />

      <p className="text-[10px] text-paper-dim/60 mb-4">
        z &gt; 1 = elevated risk · z &lt; −1 = low risk · each gauge scored against full history
      </p>

      {/* WGC data management */}
      <button
        onClick={() => setShowWgc((v) => !v)}
        className="flex items-center gap-1.5 text-[10px] text-paper-dim hover:text-paper transition-colors"
      >
        <span className="text-[8px]">{showWgc ? "▾" : "▸"}</span>
        WGC Central Bank Gold Data (Gauge 5 input)
      </button>

      {showWgc && (
        <div className="mt-3 card p-4">
          <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
            <p className="label text-xs">CB Net Gold Purchases — tonnes/year</p>
            <p className="text-[10px] text-paper-dim leading-snug max-w-xs text-right">
              WGC data released annually. Pre-2014 values are reconstructed.
              Add a new row when new data is published.
            </p>
          </div>

          {/* Add entry */}
          <div className="flex flex-wrap gap-2 mb-4 items-end">
            <div>
              <label className="label text-[10px] mb-1 block">Year</label>
              <input
                type="number"
                value={newYear}
                onChange={(e) => setNewYear(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveWgcEntry(); }}
                className="w-20 bg-ink-soft border border-ink-line rounded px-2 py-1.5 text-sm num focus:outline-none focus:border-brass/60"
                placeholder="2026"
              />
            </div>
            <div>
              <label className="label text-[10px] mb-1 block">Tonnes</label>
              <input
                type="number"
                value={newTonnes}
                onChange={(e) => setNewTonnes(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveWgcEntry(); }}
                className="w-28 bg-ink-soft border border-ink-line rounded px-2 py-1.5 text-sm num focus:outline-none focus:border-brass/60"
                placeholder="850"
              />
            </div>
            <button
              onClick={saveWgcEntry}
              disabled={saving || !newYear || !newTonnes}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brass/40 text-brass-soft hover:bg-brass/10 disabled:opacity-50 transition-colors"
            >
              <PlusIcon />
              {saving ? "Saving…" : "Save"}
            </button>
            {saveError && <p className="text-loss text-xs self-center">{saveError}</p>}
          </div>

          {/* History table */}
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-paper-dim/5">
                <tr className="border-b border-ink-line">
                  <th className="text-left text-paper-dim font-medium pb-1.5 pr-6">Year</th>
                  <th className="text-right text-paper-dim font-medium pb-1.5 pr-6">Tonnes</th>
                  <th className="text-left text-paper-dim font-medium pb-1.5">Source</th>
                </tr>
              </thead>
              <tbody>
                {wgcData.map((row) => (
                  <tr key={row.id} className="border-b border-ink-line/30 hover:bg-ink-soft/40">
                    <td className="num py-1 pr-6">{row.year}</td>
                    <td className={`num py-1 pr-6 text-right ${row.tonnes >= 0 ? "text-gain" : "text-loss"}`}>
                      {row.tonnes > 0 ? "+" : ""}{Number(row.tonnes).toLocaleString()}t
                    </td>
                    <td className="py-1 text-paper-dim">
                      {row.is_actual ? "WGC actual" : "reconstructed"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
