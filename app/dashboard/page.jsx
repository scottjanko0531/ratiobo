"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  PieChart, Pie, Cell,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const qty = (n) => {
  const x = Number(n);
  return x % 1 === 0 ? x.toLocaleString() : x.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

function GainText({ value, pct }) {
  if (value == null) return <span className="text-paper-dim">—</span>;
  const v = Number(value);
  const cls = v > 0 ? "text-gain" : v < 0 ? "text-loss" : "text-paper-dim";
  const sign = v > 0 ? "+" : "";
  return (
    <span className={cls}>
      {sign}
      {usd(v)}
      {pct != null && <span className="text-xs ml-1.5 opacity-80">{sign}{Number(pct).toFixed(1)}%</span>}
    </span>
  );
}

// Design-system colors for pie slices
const SLICE_COLORS = [
  "#C9A227", "#3FB984", "#3b82f6", "#8b5cf6",
  "#f97316", "#14b8a6", "#ec4899", "#E0635C",
];

function ChartTooltip({ active, payload, formatter }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="bg-[#1B212B] border border-[#2A3240] rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="text-[#A8ADB8] mb-0.5">{name}</p>
      <p className="text-[#F6F4EE] font-medium">{formatter ? formatter(value) : value}</p>
    </div>
  );
}

function PortfolioTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const val = payload.find((p) => p.dataKey === "value");
  const chg = payload.find((p) => p.dataKey === "change");
  const c = chg?.value ?? 0;
  const sign = c > 0 ? "+" : "";
  const chgColor = c >= 0 ? "#3FB984" : "#E0635C";
  return (
    <div className="bg-[#1B212B] border border-[#2A3240] rounded-lg px-3 py-2 text-xs shadow-lg space-y-1">
      {val && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#A8ADB8]">Value</span>
          <span className="text-[#F6F4EE] font-medium">{usd(val.value)}</span>
        </div>
      )}
      {chg && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#A8ADB8]">Change</span>
          <span className="font-medium" style={{ color: chgColor }}>{sign}{usd(c)}</span>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [rows, setRows] = useState(null);
  const [snapMap, setSnapMap] = useState({});
  const [assetTypeLabels, setAssetTypeLabels] = useState({});
  const [portfolioHistory, setPortfolioHistory] = useState([]);
  const [chartPeriod, setChartPeriod] = useState("All");
  const [error, setError] = useState("");

  const chartData = useMemo(() => {
    let filtered = portfolioHistory;
    if (chartPeriod !== "All") {
      const days = { "1D": 1, "1W": 7, "1M": 30, "1Y": 365 }[chartPeriod];
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      filtered = portfolioHistory.filter((e) => e.date >= cutoffStr);
    }
    const base = filtered[0]?.value ?? 0;
    return filtered.map((e) => ({ ...e, change: e.value - base }));
  }, [portfolioHistory, chartPeriod]);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    Promise.all([
      supabase.from("holdings_valued").select("*").order("current_value", { ascending: false }),
      supabase.from("portfolio_snapshots").select("holding_id, market_value").eq("snapshot_date", today),
      supabase.from("asset_types").select("code, label").eq("is_active", true),
      supabase.from("portfolio_snapshots").select("snapshot_date, market_value").order("snapshot_date", { ascending: true }),
    ]).then(([{ data, error: err }, { data: snaps }, { data: at }, { data: hist }]) => {
      if (err) setError(err.message);
      else setRows(data ?? []);

      const map = {};
      for (const s of snaps ?? []) map[s.holding_id] = Number(s.market_value ?? 0);
      setSnapMap(map);

      const labelMap = {};
      for (const t of at ?? []) labelMap[t.code] = t.label;
      setAssetTypeLabels(labelMap);

      // Aggregate snapshots by date → total portfolio value per day
      const byDate = {};
      for (const s of hist ?? []) {
        byDate[s.snapshot_date] = (byDate[s.snapshot_date] ?? 0) + Number(s.market_value ?? 0);
      }
      setPortfolioHistory(
        Object.entries(byDate)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, value]) => ({
            date,
            value,
            label: new Date(date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          }))
      );
    });
  }, []);

  const totals = (rows ?? []).reduce(
    (t, r) => {
      const snap = snapMap[r.id];
      const dc = snap != null ? Number(r.current_value ?? 0) - snap : null;
      return {
        value: t.value + Number(r.current_value ?? 0),
        basis: t.basis + Number(r.cost_basis ?? 0),
        gain: t.gain + Number(r.net_gain ?? 0),
        income: t.income + Number(r.total_dividends ?? 0) + Number(r.total_interest ?? 0),
        dayChange: dc != null ? (t.dayChange ?? 0) + dc : t.dayChange
      };
    },
    { value: 0, basis: 0, gain: 0, income: 0, dayChange: null }
  );

  const lastSync = (rows ?? [])
    .map((r) => r.last_price_sync)
    .filter(Boolean)
    .sort()
    .pop();

  // Aggregate current_value by asset_type for the pie chart
  const allocationData = Object.entries(
    (rows ?? []).reduce((acc, r) => {
      if (!r.asset_type || Number(r.current_value ?? 0) <= 0) return acc;
      acc[r.asset_type] = (acc[r.asset_type] ?? 0) + Number(r.current_value);
      return acc;
    }, {})
  )
    .map(([code, value]) => ({ code, name: assetTypeLabels[code] ?? code, value }))
    .sort((a, b) => b.value - a.value);

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
        {lastSync && (
          <p className="label">
            Prices as of {new Date(lastSync).toLocaleString()}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-8">
        <div className="card p-4">
          <p className="label mb-1">Total value</p>
          <p className="num text-xl">{usd(totals.value)}</p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Cost basis</p>
          <p className="num text-xl">{usd(totals.basis)}</p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Unrealized gain</p>
          <p className="num text-xl">
            <GainText value={totals.gain} pct={totals.basis ? (totals.gain / totals.basis) * 100 : null} />
          </p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Income received</p>
          <p className="num text-xl">{usd(totals.income)}</p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Day change</p>
          <p className="num text-xl">
            <GainText value={totals.dayChange} />
          </p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        {/* Allocation by type — pie / donut */}
        <div className="card p-5">
          <p className="label mb-4">Allocation by type</p>
          {allocationData.length === 0 ? (
            <p className="text-paper-dim text-sm py-8 text-center">No holdings data.</p>
          ) : (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width="55%" height={220}>
                <PieChart>
                  <Pie
                    data={allocationData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {allocationData.map((entry, i) => (
                      <Cell key={entry.code} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={<ChartTooltip formatter={(v) => usd(v)} />}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-2 min-w-0">
                {allocationData.map((entry, i) => {
                  const pct = totals.value > 0 ? (entry.value / totals.value) * 100 : 0;
                  return (
                    <div key={entry.code} className="flex items-center gap-2 text-xs">
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
                      />
                      <span className="text-paper-dim truncate flex-1">{entry.name}</span>
                      <span className="num text-paper shrink-0">{pct.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Portfolio value over time — line chart */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="label">Portfolio value over time</p>
            <div className="flex gap-0.5">
              {["1D", "1W", "1M", "1Y", "All"].map((p) => (
                <button
                  key={p}
                  onClick={() => setChartPeriod(p)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${
                    chartPeriod === p
                      ? "bg-brass/20 text-brass-soft border border-brass/40"
                      : "text-paper-dim hover:text-paper"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          {chartData.length < 2 ? (
            <div className="flex items-center justify-center h-[220px]">
              <p className="text-paper-dim text-sm text-center">
                {portfolioHistory.length === 0
                  ? "No snapshot history yet."
                  : "Collecting data — check back tomorrow."}
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 68, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#A8ADB8", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fill: "#A8ADB8", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={72}
                  tickFormatter={(v) =>
                    v >= 1_000_000
                      ? `$${(v / 1_000_000).toFixed(1)}M`
                      : v >= 1_000
                      ? `$${(v / 1_000).toFixed(0)}K`
                      : usd(v)
                  }
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
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
                <Tooltip content={<PortfolioTooltip />} />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="value"
                  stroke="#C9A227"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "#C9A227", stroke: "#1B212B", strokeWidth: 2 }}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="change"
                  stroke="#3FB984"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  activeDot={{ r: 3, fill: "#3FB984", stroke: "#1B212B", strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-line">
              <th className="label text-left font-medium px-4 py-3">Holding</th>
              <th className="label text-right font-medium px-4 py-3">Qty</th>
              <th className="label text-right font-medium px-4 py-3">Price</th>
              <th className="label text-right font-medium px-4 py-3">Cost basis</th>
              <th className="label text-right font-medium px-4 py-3">Value</th>
              <th className="label text-right font-medium px-4 py-3">Net gain</th>
              <th className="label text-right font-medium px-4 py-3">Day Chg</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-paper-dim">Loading…</td></tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-paper-dim">
                  No holdings yet. Add your first holding to start the ledger.
                </td>
              </tr>
            )}
            {error && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-loss">{error}</td></tr>
            )}
            {rows?.map((r) => {
              const snap = snapMap[r.id];
              const dayChg = snap != null ? Number(r.current_value ?? 0) - snap : null;
              return (
                <tr key={r.id} className="border-b border-ink-line/60 last:border-0">
                  <td className="px-4 py-3">
                    <span className="font-medium">{r.symbol}</span>
                    <span className="text-paper-dim ml-2">{r.name}</span>
                    <span className="label ml-2">{r.asset_type}</span>
                  </td>
                  <td className="num text-right px-4 py-3">{qty(r.quantity)}</td>
                  <td className="num text-right px-4 py-3">{usd(r.market_price)}</td>
                  <td className="num text-right px-4 py-3">{usd(r.cost_basis)}</td>
                  <td className="num text-right px-4 py-3">{usd(r.current_value)}</td>
                  <td className="num text-right px-4 py-3">
                    <GainText value={r.net_gain} pct={r.net_gain_pct} />
                  </td>
                  <td className="num text-right px-4 py-3">
                    <GainText value={dayChg} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
