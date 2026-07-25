"use client";
import { useCallback, useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const pct  = (v, digits = 1) => v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
const pctS = (v, digits = 1) => v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
const f2   = (v) => v == null ? "—" : v.toFixed(2);

const PORTFOLIO_COLORS = {
  standard_gb: { label: "Standard GB",            th: "text-paper",     badge: "bg-ink-soft text-paper-dim border-ink-line" },
  hedged_gb:   { label: "Hedged GB (+DBMF)",       th: "text-brass-soft", badge: "bg-brass/10 text-brass-soft border-brass/30" },
  bw_modified: { label: "BW All Weather Mod.",     th: "text-sky",        badge: "bg-sky/10 text-sky border-sky/30" },
};

const METRIC_ROWS = [
  { key: "cagr",          label: "CAGR (ann.)",         fmt: pct,  higher: true  },
  { key: "total_return",  label: "Total Return",        fmt: pct,  higher: true  },
  { key: "volatility",    label: "Volatility",          fmt: pct,  higher: false },
  { key: "sharpe",        label: "Sharpe Ratio",        fmt: f2,   higher: true  },
  { key: "sortino",       label: "Sortino Ratio",       fmt: f2,   higher: true  },
  { key: "max_dd",        label: "Max Drawdown",        fmt: pct,  higher: false },
  { key: "max_dd_months", label: "Max DD Duration",     fmt: v => v == null ? "—" : `${v} mo`, higher: false },
  { key: "calmar",        label: "Calmar Ratio",        fmt: f2,   higher: true  },
  { key: "best_year",     label: "Best Year",           fmt: pct,  higher: true  },
  { key: "worst_year",    label: "Worst Year",          fmt: pct,  higher: false },
];

const WEIGHT_FMT = (v) => `${(v * 100).toFixed(0)}%`;

const PORTFOLIO_WEIGHTS = {
  standard_gb: { VTI: 0.20, IJS: 0.20, GLD: 0.20, TLT: 0.20, SHY: 0.20 },
  hedged_gb:   { VTI: 0.20, IJS: 0.20, GLD: 0.20, TLT: 0.15, SHY: 0.15, DBMF: 0.10 },
  bw_modified: { VTI: 0.30, TLT: 0.40, IEF: 0.15, GLD: 0.075, DBC: 0.075 },
};

function StarBadge() {
  return <span className="ml-1 text-brass text-xs">★</span>;
}

function MetricsTable({ portfolios }) {
  const keys = portfolios.map(p => p.key);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-line">
            <th className="text-left py-2 pr-4 text-paper-dim font-medium w-40">Metric</th>
            {portfolios.map(p => (
              <th key={p.key} className={`text-right py-2 px-3 font-medium ${PORTFOLIO_COLORS[p.key]?.th}`}>
                {PORTFOLIO_COLORS[p.key]?.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map(row => {
            const vals = portfolios.map(p => p.metrics?.[row.key] ?? null);
            const numeric = vals.filter(v => v != null);
            const best = numeric.length
              ? row.higher
                ? Math.max(...numeric)
                : Math.max(...numeric)  // for lower-is-better, "best" = max (least negative / lowest)
              : null;
            // For lower-is-better metrics: best = max (least negative for drawdown, lowest for vol)
            // For higher-is-better: best = max
            const isBest = (v) => {
              if (v == null || best == null) return false;
              if (row.key === "volatility" || row.key === "max_dd_months") return v === Math.min(...numeric);
              if (!row.higher) return v === Math.max(...numeric);
              return v === Math.max(...numeric);
            };
            return (
              <tr key={row.key} className="border-b border-ink-line/40 hover:bg-ink-soft/30 transition-colors">
                <td className="py-2 pr-4 text-paper-dim">{row.label}</td>
                {vals.map((v, i) => (
                  <td key={keys[i]} className="text-right py-2 px-3 font-mono tabular-nums">
                    {row.fmt(v)}
                    {isBest(v) && <StarBadge />}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AnnualReturnsTable({ portfolios }) {
  // Collect all years across portfolios
  const yearSet = new Set();
  for (const p of portfolios) {
    for (const row of p.metrics?.annual_returns ?? []) yearSet.add(row.year);
  }
  const years = [...yearSet].sort((a, b) => a - b);
  const retByKey = {};
  for (const p of portfolios) {
    retByKey[p.key] = {};
    for (const row of p.metrics?.annual_returns ?? []) retByKey[p.key][row.year] = row.ret;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-line">
            <th className="text-left py-2 pr-4 text-paper-dim font-medium w-16">Year</th>
            {portfolios.map(p => (
              <th key={p.key} className={`text-right py-2 px-3 font-medium ${PORTFOLIO_COLORS[p.key]?.th}`}>
                {PORTFOLIO_COLORS[p.key]?.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map(yr => {
            const vals = portfolios.map(p => retByKey[p.key]?.[yr] ?? null);
            const numeric = vals.filter(v => v != null);
            const best = numeric.length ? Math.max(...numeric) : null;
            return (
              <tr key={yr} className="border-b border-ink-line/40 hover:bg-ink-soft/30 transition-colors">
                <td className="py-1.5 pr-4 text-paper-dim font-mono">{yr}</td>
                {vals.map((v, i) => (
                  <td
                    key={portfolios[i].key}
                    className={`text-right py-1.5 px-3 font-mono tabular-nums ${
                      v == null ? "text-paper-dim" : v >= 0 ? "text-gain" : "text-loss"
                    }`}
                  >
                    {v == null ? "—" : pctS(v)}
                    {v != null && v === best && <StarBadge />}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DecadeTable({ decadeReturns, portfolioKeys }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-line">
            <th className="text-left py-2 pr-4 text-paper-dim font-medium">Period</th>
            {portfolioKeys.map(k => (
              <th key={k} className={`text-right py-2 px-3 font-medium ${PORTFOLIO_COLORS[k]?.th}`}>
                {PORTFOLIO_COLORS[k]?.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {decadeReturns.map(row => {
            const vals = portfolioKeys.map(k => row.portfolios?.[k] ?? null);
            const numeric = vals.filter(v => v != null);
            const best = numeric.length ? Math.max(...numeric) : null;
            return (
              <tr key={row.label} className="border-b border-ink-line/40 hover:bg-ink-soft/30 transition-colors">
                <td className="py-2 pr-4 text-paper-dim">{row.label}</td>
                {vals.map((v, i) => (
                  <td key={portfolioKeys[i]} className="text-right py-2 px-3 font-mono tabular-nums">
                    {pct(v)}
                    {v != null && v === best && <StarBadge />}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StressTable({ stressPeriods, portfolioKeys }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-line">
            <th className="text-left py-2 pr-4 text-paper-dim font-medium">Crisis Period</th>
            {portfolioKeys.map(k => (
              <th key={k} className={`text-right py-2 px-3 font-medium ${PORTFOLIO_COLORS[k]?.th}`}>
                {PORTFOLIO_COLORS[k]?.label}
              </th>
            ))}
            <th className="text-right py-2 px-3 font-medium text-paper-dim">DBMF Proxy</th>
          </tr>
        </thead>
        <tbody>
          {stressPeriods.map(row => {
            const vals = portfolioKeys.map(k => row.portfolios?.[k] ?? null);
            const numeric = vals.filter(v => v != null);
            const best = numeric.length ? Math.max(...numeric) : null;
            return (
              <tr key={row.label} className="border-b border-ink-line/40 hover:bg-ink-soft/30 transition-colors">
                <td className="py-2 pr-4 text-paper-dim">{row.label}</td>
                {vals.map((v, i) => (
                  <td
                    key={portfolioKeys[i]}
                    className={`text-right py-2 px-3 font-mono tabular-nums ${
                      v == null ? "text-paper-dim" : v >= 0 ? "text-gain" : "text-loss"
                    }`}
                  >
                    {v == null ? "—" : pctS(v)}
                    {v != null && v === best && <StarBadge />}
                  </td>
                ))}
                <td className={`text-right py-2 px-3 font-mono tabular-nums ${
                  row.dbmf_return == null ? "text-paper-dim" : row.dbmf_return >= 0 ? "text-gain" : "text-loss"
                }`}>
                  {row.dbmf_return == null ? "—" : pctS(row.dbmf_return)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WeightsCard({ portfolioKey, weights }) {
  const color = PORTFOLIO_COLORS[portfolioKey];
  return (
    <div className="rounded-lg border border-ink-line bg-ink-soft/40 p-4">
      <p className={`text-xs font-medium mb-3 ${color?.th}`}>{color?.label}</p>
      <div className="space-y-1.5">
        {Object.entries(weights).map(([ticker, w]) => (
          <div key={ticker} className="flex items-center gap-2">
            <span className="text-xs text-paper-dim w-10 font-mono">{ticker}</span>
            <div className="flex-1 bg-ink-line rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  portfolioKey === "hedged_gb" ? "bg-brass/60" :
                  portfolioKey === "bw_modified" ? "bg-sky/60" : "bg-paper/40"
                }`}
                style={{ width: `${w * 100}%` }}
              />
            </div>
            <span className="text-xs text-paper-dim font-mono w-8 text-right">{WEIGHT_FMT(w)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BacktestingPage() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError]   = useState(null);

  const loadCached = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: rows, error: err } = await supabase
      .from("backtest_cache")
      .select("results, computed_at")
      .order("computed_at", { ascending: false })
      .limit(1)
      .single();
    if (err && err.code !== "PGRST116") setError(err.message);
    else if (rows) setData({ ...rows.results, cached_at: rows.computed_at });
    setLoading(false);
  }, []);

  useEffect(() => { loadCached(); }, [loadCached]);

  async function runBacktest() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/run-backtest`,
        { method: "POST", headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${SUPABASE_ANON}` } }
      );
      if (!res.ok) throw new Error(`Edge function returned ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      // Reload from cache so we get the saved version
      await loadCached();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  const portfolioKeys = ["standard_gb", "hedged_gb", "bw_modified"];

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Backtesting</h1>
          <p className="text-paper-dim text-sm mt-0.5">
            Portfolio comparison — annual rebalancing, dividends reinvested
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {data?.cached_at && (
            <span className="text-xs text-paper-dim">
              Updated {new Date(data.cached_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          )}
          <button
            onClick={runBacktest}
            disabled={running}
            className="px-3 py-1.5 text-sm rounded-lg border border-ink-line hover:border-brass/60 text-paper-dim hover:text-paper transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running ? (
              <span className="flex items-center gap-1.5">
                <span className="bead animate-pulse w-1.5 h-1.5" />
                <span className="bead animate-pulse w-1.5 h-1.5 [animation-delay:150ms]" />
                <span className="bead animate-pulse w-1.5 h-1.5 [animation-delay:300ms]" />
              </span>
            ) : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg border border-loss/30 bg-loss/10 text-sm text-loss">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-24">
          <span className="flex items-center gap-1.5">
            <span className="bead animate-pulse" />
            <span className="bead animate-pulse [animation-delay:150ms]" />
            <span className="bead animate-pulse [animation-delay:300ms]" />
          </span>
        </div>
      )}

      {!loading && !data && !error && (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <p className="text-paper-dim text-sm">No backtest data yet.</p>
          <button
            onClick={runBacktest}
            disabled={running}
            className="px-4 py-2 text-sm rounded-lg border border-brass/40 text-brass-soft hover:bg-brass/10 transition-colors disabled:opacity-40"
          >
            Run Backtest
          </button>
        </div>
      )}

      {data && (
        <div className="space-y-8">
          {/* Window */}
          {data.window_start && (
            <p className="text-xs text-paper-dim">
              Backtest window: {data.window_start?.slice(0, 7)} → {data.window_end?.slice(0, 7)} · annual rebalancing · RF = 4%
            </p>
          )}

          {/* Portfolio compositions */}
          <section>
            <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider mb-3">Allocations</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {portfolioKeys.map(k => (
                <WeightsCard key={k} portfolioKey={k} weights={PORTFOLIO_WEIGHTS[k]} />
              ))}
            </div>
          </section>

          {/* Summary metrics */}
          <section>
            <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider mb-3">Performance Summary</h2>
            <div className="rounded-lg border border-ink-line overflow-hidden">
              <MetricsTable portfolios={data.portfolios ?? []} />
            </div>
          </section>

          {/* Decade breakdown */}
          {data.decade_returns?.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider mb-3">CAGR by Decade</h2>
              <div className="rounded-lg border border-ink-line overflow-hidden">
                <DecadeTable decadeReturns={data.decade_returns} portfolioKeys={portfolioKeys} />
              </div>
            </section>
          )}

          {/* Annual returns */}
          {data.portfolios?.[0]?.metrics?.annual_returns?.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider mb-3">Annual Returns</h2>
              <div className="rounded-lg border border-ink-line overflow-hidden">
                <AnnualReturnsTable portfolios={data.portfolios} />
              </div>
            </section>
          )}

          {/* Stress periods */}
          {data.stress_periods?.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider mb-3">Crisis Period Returns</h2>
              <div className="rounded-lg border border-ink-line overflow-hidden">
                <StressTable stressPeriods={data.stress_periods} portfolioKeys={portfolioKeys} />
              </div>
            </section>
          )}

          {/* Methodology note */}
          <section className="rounded-lg border border-ink-line/50 bg-ink-soft/30 p-4">
            <p className="text-xs text-paper-dim font-medium mb-1">Methodology</p>
            <p className="text-xs text-paper-dim leading-relaxed">{data.proxies}</p>
            {data.fetch_errors?.length > 0 && (
              <p className="text-xs text-loss mt-2">Fetch warnings: {data.fetch_errors.join(" · ")}</p>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}
