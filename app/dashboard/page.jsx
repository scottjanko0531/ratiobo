"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, Cell,
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { supabase } from "../../lib/supabase";
import Shell from "../../components/Shell";
import NotificationBanner from "../../components/NotificationBanner";

const usd = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const qty = (n) => {
  const x = Number(n);
  return x % 1 === 0 ? x.toLocaleString() : x.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

function ChevronIcon({ collapsed }) {
  return (
    <svg
      className={`w-3.5 h-3.5 transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
      viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

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
  const entry = payload[0]?.payload;
  const c = entry?.dayChange ?? null;
  const sign = c != null && c > 0 ? "+" : "";
  const chgColor = c == null ? "#A8ADB8" : c >= 0 ? "#3FB984" : "#E0635C";
  return (
    <div className="bg-[#1B212B] border border-[#2A3240] rounded-lg px-3 py-2 text-xs shadow-lg space-y-1">
      <div className="text-[#A8ADB8] mb-0.5">{entry?.label}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[#A8ADB8]">Value</span>
        <span className="text-[#F6F4EE] font-medium">{usd(entry?.value)}</span>
      </div>
      {c != null && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#A8ADB8]">Day change</span>
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
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());

  function toggleGroup(code) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  const chartData = useMemo(() => {
    let filtered = portfolioHistory;
    if (chartPeriod !== "All") {
      const days = { "1W": 7, "1M": 30, "3M": 90, "1Y": 365 }[chartPeriod];
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      filtered = portfolioHistory.filter((e) => e.date >= cutoffStr);
    }
    return filtered.map((e, i) => ({
      ...e,
      dayChange: i === 0 ? null : e.value - filtered[i - 1].value,
    }));
  }, [portfolioHistory, chartPeriod]);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    Promise.all([
      supabase.from("holdings_valued").select("*").order("asset_type").order("current_value", { ascending: false }),
      supabase.from("portfolio_snapshots").select("holding_id, market_value").eq("snapshot_date", today),
      supabase.from("asset_types").select("code, label").eq("is_active", true),
      supabase.rpc("portfolio_daily_totals"),
    ]).then(([{ data, error: err }, { data: snaps }, { data: at }, { data: hist }]) => {
      if (err) setError(err.message);
      else {
        setRows(data ?? []);
        // Collapse all groups by default on load
        setCollapsedGroups(new Set((data ?? []).map((r) => r.asset_type).filter(Boolean)));
      }

      const map = {};
      for (const s of snaps ?? []) map[s.holding_id] = Number(s.market_value ?? 0);
      setSnapMap(map);

      const labelMap = {};
      for (const t of at ?? []) labelMap[t.code] = t.label;
      setAssetTypeLabels(labelMap);

      setPortfolioHistory(
        (hist ?? []).map((row) => ({
          date:  row.snapshot_date,
          value: Number(row.total_value ?? 0),
          label: new Date(row.snapshot_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
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
        income: t.income + Number(r.total_dividends ?? 0) + Number(r.total_interest ?? 0) - Number(r.total_fees ?? 0),
        dayChange: dc != null ? (t.dayChange ?? 0) + dc : t.dayChange
      };
    },
    { value: 0, basis: 0, gain: 0, income: 0, dayChange: null }
  );

  const totalGain = totals.gain + totals.income;
  const totalGainPct = totals.basis > 0 ? (totalGain / totals.basis) * 100 : null;

  const periodChanges = useMemo(() => {
    if (!portfolioHistory.length) return { week: null, mtd: null, ytd: null };
    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
    const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const ytdStart = new Date(now.getFullYear(), 0, 1);
    const findValue = (target) => {
      const targetStr = target.toISOString().slice(0, 10);
      // Use closest snapshot at or before target; fall back to earliest available
      return ([...portfolioHistory].reverse().find(e => e.date <= targetStr) ?? portfolioHistory[0])?.value ?? null;
    };
    const current = totals.value;
    const wv = findValue(weekAgo), mv = findValue(mtdStart), yv = findValue(ytdStart);
    return {
      week: wv != null ? current - wv : null,
      mtd:  mv != null ? current - mv : null,
      ytd:  yv != null ? current - yv : null,
    };
  }, [portfolioHistory, totals.value]);

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

      {/* Row 1 — return summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
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
          <p className="label mb-1">Income (net)</p>
          <p className="num text-xl"><GainText value={totals.income} /></p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Total gain</p>
          <p className="num text-xl">
            <GainText value={totalGain} pct={totalGainPct} />
          </p>
        </div>
      </div>

      {/* Row 2 — period changes */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        <div className="card p-4">
          <p className="label mb-1">Day change</p>
          <p className="num text-xl"><GainText value={totals.dayChange} /></p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Week change</p>
          <p className="num text-xl"><GainText value={periodChanges.week} /></p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Month to date</p>
          <p className="num text-xl"><GainText value={periodChanges.mtd} /></p>
        </div>
        <div className="card p-4">
          <p className="label mb-1">Year to date</p>
          <p className="num text-xl"><GainText value={periodChanges.ytd} /></p>
        </div>
      </div>

      {/* Notification banner */}
      <NotificationBanner />

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        {/* Allocation by type — proportion bars */}
        <div className="card p-5 flex flex-col">
          <div className="flex items-baseline justify-between mb-5">
            <p className="label">Allocation, by proportion</p>
            <span className="num text-paper text-sm">{usd(totals.value)}</span>
          </div>
          {allocationData.length === 0 ? (
            <p className="text-paper-dim text-sm py-8 text-center">No holdings data.</p>
          ) : (
            <>
              <div className="space-y-4 flex-1">
                {allocationData.map((entry) => {
                  const pct = totals.value > 0 ? (entry.value / totals.value) * 100 : 0;
                  return (
                    <div key={entry.code}>
                      <div className="flex items-baseline justify-between mb-2">
                        <span className="text-sm text-paper">{entry.name}</span>
                        <span className="text-sm num">
                          <span className="text-paper-dim">{usd(entry.value)}</span>
                          <span className="text-brass ml-2">{pct.toFixed(0)}%</span>
                        </span>
                      </div>
                      <div className="relative h-[3px] bg-ink-line rounded-full">
                        <div
                          className="absolute left-0 top-0 h-full bg-brass rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full bg-brass"
                          style={{ left: `calc(${pct}% - 5px)` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-5 pt-4 border-t border-ink-line">
                <p className="label">Unrealized gain</p>
                <span className="num text-sm">
                  <GainText value={totals.gain} />
                  {totals.basis > 0 && (
                    <span className="text-gain ml-2">
                      +{((totals.gain / totals.basis) * 100).toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Portfolio value over time — line chart */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="label">Portfolio value over time</p>
            <div className="flex gap-0.5">
              {["1W", "1M", "3M", "1Y", "All"].map((p) => (
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
              <ComposedChart data={chartData} margin={{ top: 4, right: 72, left: 0, bottom: 0 }}>
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
                <Tooltip content={<PortfolioTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar yAxisId="right" dataKey="dayChange" maxBarSize={16} radius={[2, 2, 0, 0]}>
                  {chartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.dayChange == null ? "transparent" : entry.dayChange >= 0 ? "#3FB984" : "#E0635C"}
                      fillOpacity={0.7}
                    />
                  ))}
                </Bar>
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="value"
                  stroke="#C9A227"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "#C9A227", stroke: "#1B212B", strokeWidth: 2 }}
                />
              </ComposedChart>
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
            {(() => {
              if (!rows?.length) return null;
              // Build groups in asset_type order (rows already sorted by asset_type then value desc)
              const groups = [];
              const seen = {};
              for (const r of rows) {
                if (!seen[r.asset_type]) {
                  seen[r.asset_type] = [];
                  groups.push({ code: r.asset_type, label: assetTypeLabels[r.asset_type] ?? r.asset_type, items: seen[r.asset_type] });
                }
                seen[r.asset_type].push(r);
              }
              return groups.map(({ code, label, items }) => {
                const isCollapsed = collapsedGroups.has(code);
                const gValue   = items.reduce((s, r) => s + Number(r.current_value ?? 0), 0);
                const gBasis   = items.reduce((s, r) => s + Number(r.cost_basis ?? 0), 0);
                const gGain    = items.reduce((s, r) => s + Number(r.net_gain ?? 0), 0);
                const hasDayData = items.some((r) => snapMap[r.id] != null);
                const gDayChg  = hasDayData
                  ? items.reduce((s, r) => { const sn = snapMap[r.id]; return sn != null ? s + (Number(r.current_value ?? 0) - sn) : s; }, 0)
                  : null;
                const gainPct  = gBasis > 0 ? (gGain / gBasis) * 100 : null;
                return (
                  <Fragment key={code}>
                    {/* Group header */}
                    <tr
                      className="border-b border-ink-line bg-ink-soft/50 cursor-pointer hover:bg-ink-soft transition-colors select-none"
                      onClick={() => toggleGroup(code)}
                    >
                      <td className="px-4 py-2.5" colSpan={4}>
                        <div className="flex items-center gap-2 text-paper-dim">
                          <ChevronIcon collapsed={isCollapsed} />
                          <span className="font-semibold text-paper text-sm">{label}</span>
                          <span className="text-xs">{items.length}</span>
                        </div>
                      </td>
                      <td className="num text-right px-4 py-2.5 text-sm font-medium">{usd(gValue)}</td>
                      <td className="num text-right px-4 py-2.5 text-sm font-medium">
                        <GainText value={gGain} pct={gainPct} />
                      </td>
                      <td className="num text-right px-4 py-2.5 text-sm">
                        <GainText value={gDayChg} />
                      </td>
                    </tr>
                    {/* Individual rows */}
                    {!isCollapsed && items.map((r) => {
                      const snap = snapMap[r.id];
                      const dayChg = snap != null ? Number(r.current_value ?? 0) - snap : null;
                      return (
                        <tr key={r.id} className="border-b border-ink-line/60 last:border-0 hover:bg-ink-soft/30 transition-colors">
                          <td className="px-4 py-3">
                            <span className="font-medium">{r.symbol}</span>
                            {r.name && <span className="text-paper-dim ml-2 text-xs">{r.name}</span>}
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
                  </Fragment>
                );
              });
            })()}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
