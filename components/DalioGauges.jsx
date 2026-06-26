"use client";
import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

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

// SVG speedometer gauge.
// Scale: z-score from -3 (low risk, green/left) to +3 (elevated risk, red/right).
// Zones: green ≤ -1, brass -1..+1, red ≥ +1.
function SpeedometerGauge({ value, label, desc, year }) {
  const cx = 100, cy = 88, r = 68;
  const nl = 58;

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
    <div className="card p-4 flex flex-col items-center">
      <p className="text-xs font-medium text-paper text-center leading-snug mb-2 min-h-[2rem]">
        {label}
      </p>
      <svg viewBox="20 10 160 92" className="w-full max-w-[190px]">
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

        {/* Z-score value */}
        <text
          x={cx} y={cy + 16}
          textAnchor="middle"
          fill="rgba(232,228,220,0.9)"
          fontSize="13"
          fontWeight="bold"
          fontFamily="ui-monospace,monospace"
        >
          {value != null ? (value >= 0 ? "+" : "") + value.toFixed(2) : "—"}
        </text>
      </svg>

      <p className={`text-xs font-semibold mt-0 ${statusClass}`}>{statusLabel}</p>
      {year && (
        <p className="text-[9px] text-paper-dim/60 mt-0.5">As of {year}</p>
      )}
      {desc && (
        <p className="text-[10px] text-paper-dim text-center mt-1 leading-snug">{desc}</p>
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
          />
        ))}
      </div>

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
