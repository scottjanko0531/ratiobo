"use client";
import { useEffect, useState, useMemo } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from "recharts";
import { supabase } from "../lib/supabase";

const RANGES = [
  { label: "1952–", from: 1952 },
  { label: "1980–", from: 1980 },
  { label: "2000–", from: 2000 },
  { label: "2010–", from: 2010 },
];

const BASE_YEAR = 1952;

const DEBT_COLOR  = "#C9A227";
const PROD_COLOR  = "#3FB984";
const CYCLE_COLOR = "#E0635C";

const QUADRANT_FILL = {
  goldilocks:  { fill: "#3FB984", opacity: 0.08, label: "Goldilocks (Growth↑/Inflation↓)" },
  reflation:   { fill: "#C9A227", opacity: 0.09, label: "Reflation (Growth↑/Inflation↑)" },
  stagflation: { fill: "#E0635C", opacity: 0.08, label: "Stagflation (Growth↓/Inflation↑)" },
  bust:        { fill: "#A8ADB8", opacity: 0.09, label: "Deflationary Bust (Growth↓/Inflation↓)" },
};

function computeZoneBands(debtRows, fromYear) {
  const rows = debtRows
    .filter((r) => r.quadrant && r.year >= fromYear)
    .sort((a, b) => a.year - b.year);

  const bands = [];
  let current = null;

  for (const row of rows) {
    if (!current || current.quadrant !== row.quadrant) {
      if (current) bands.push(current);
      current = { quadrant: row.quadrant, x1: row.year, x2: row.year + 1 };
    } else {
      current.x2 = row.year + 1;
    }
  }
  if (current) bands.push(current);
  return bands;
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2.5 text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-paper mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="num text-paper">
            {p.value != null
              ? p.dataKey === "debtGrowthYoy"
                ? `${p.value > 0 ? "+" : ""}${Number(p.value).toFixed(1)}%`
                : Number(p.value).toFixed(1)
              : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ThreeForcesChart() {
  const [raw, setRaw] = useState(null);
  const [range, setRange] = useState(1952);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [debt, credit, prod] = await Promise.all([
        supabase.from("macro_debt_cycle_computed").select("year,debt_to_gdp_pct,quadrant").order("year"),
        supabase.from("macro_credit_cycle").select("year,total_debt_growth_yoy").order("year"),
        supabase.from("macro_productivity").select("year,labor_productivity_idx").order("year"),
      ]);
      setRaw({ debt: debt.data ?? [], credit: credit.data ?? [], prod: prod.data ?? [] });
      setLoading(false);
    }
    load();
  }, []);

  const chartData = useMemo(() => {
    if (!raw) return [];

    const debtMap   = Object.fromEntries(raw.debt.map((r) => [r.year, r.debt_to_gdp_pct]));
    const creditMap = Object.fromEntries(raw.credit.map((r) => [r.year, r.total_debt_growth_yoy]));
    const prodMap   = Object.fromEntries(raw.prod.map((r) => [r.year, r.labor_productivity_idx]));

    const baseDebt = debtMap[BASE_YEAR];
    const baseProd = prodMap[BASE_YEAR];

    const years = [...new Set([
      ...raw.debt.map((r) => r.year),
      ...raw.credit.map((r) => r.year),
      ...raw.prod.map((r) => r.year),
    ])].sort((a, b) => a - b).filter((y) => y >= range);

    return years.map((year) => ({
      year,
      debtIdx:      debtMap[year]  != null && baseDebt ? Math.round((debtMap[year]  / baseDebt) * 1000) / 10 : null,
      prodIdx:      prodMap[year]  != null && baseProd ? Math.round((prodMap[year]  / baseProd) * 1000) / 10 : null,
      debtGrowthYoy: creditMap[year] ?? null,
    }));
  }, [raw, range]);

  const zoneBands = useMemo(() => {
    if (!raw) return [];
    return computeZoneBands(raw.debt, range);
  }, [raw, range]);

  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-paper-dim text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {RANGES.map((r) => (
          <button
            key={r.from}
            onClick={() => setRange(r.from)}
            className={`px-3 py-1 rounded-lg text-xs transition-colors ${
              range === r.from
                ? "bg-ink-soft text-brass-soft"
                : "text-paper-dim hover:text-paper"
            }`}
          >
            {r.label}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {Object.entries(QUADRANT_FILL).map(([key, { fill, label }]) => (
            <span key={key} className="flex items-center gap-1 text-[10px] text-paper-dim">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: fill, opacity: 0.7 }}
              />
              {label}
            </span>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={380}>
        <ComposedChart data={chartData} margin={{ top: 4, right: 48, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="year"
            tick={{ fill: "#A8ADB8", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="idx"
            tick={{ fill: "#A8ADB8", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => v.toFixed(0)}
            label={{ value: "Index (base yr = 100)", angle: -90, position: "insideLeft", offset: 12, fill: "#A8ADB8", fontSize: 10 }}
          />
          <YAxis
            yAxisId="pct"
            orientation="right"
            tick={{ fill: "#A8ADB8", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v}%`}
            label={{ value: "Debt growth YoY %", angle: 90, position: "insideRight", offset: 12, fill: "#A8ADB8", fontSize: 10 }}
          />

          {/* Dalio quadrant zones — per-year, grouped into consecutive same-quadrant bands */}
          {zoneBands.map((z) => {
            const cfg = QUADRANT_FILL[z.quadrant];
            if (!cfg) return null;
            return (
              <ReferenceArea
                key={`${z.quadrant}-${z.x1}`}
                yAxisId="idx"
                x1={z.x1}
                x2={z.x2}
                fill={cfg.fill}
                fillOpacity={cfg.opacity}
                stroke="none"
              />
            );
          })}

          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
            formatter={(value) => <span style={{ color: "#A8ADB8" }}>{value}</span>}
          />
          <ReferenceLine yAxisId="pct" y={0} stroke="#2A3240" strokeWidth={1} />
          <Line
            yAxisId="idx"
            type="monotone"
            dataKey="debtIdx"
            name="Total Debt / GDP (indexed)"
            stroke={DEBT_COLOR}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
          <Line
            yAxisId="idx"
            type="monotone"
            dataKey="prodIdx"
            name="Labor Productivity (indexed)"
            stroke={PROD_COLOR}
            strokeWidth={2}
            strokeDasharray="5 3"
            dot={false}
            connectNulls
          />
          <Line
            yAxisId="pct"
            type="monotone"
            dataKey="debtGrowthYoy"
            name="Short-Term Debt Growth YoY %"
            stroke={CYCLE_COLOR}
            strokeWidth={1.5}
            dot={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>

      <p className="text-[10px] text-paper-dim mt-3 leading-relaxed">
        Index lines rebased to start year = 100; divergence shows relative growth regardless of unit.
        Background zones show the active Dalio quadrant per year, derived from 3-year trailing averages of real GDP growth vs. CPI.
        Red line: annual short-term credit cycle oscillations (YoY total nonfinancial debt growth).
        Sources: Federal Reserve Z.1, BLS, BEA via FRED.
      </p>
    </div>
  );
}
