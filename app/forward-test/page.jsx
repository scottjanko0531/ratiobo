"use client";
import { useEffect, useState, useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";

const usd = (v) => v == null || isNaN(Number(v)) ? "—" : Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (v, digits = 2) => v == null || isNaN(Number(v)) ? "—" : `${Number(v) >= 0 ? "+" : ""}${(Number(v) * 100).toFixed(digits)}%`;
const gainCls = (v) => v == null ? "text-paper-dim" : Number(v) > 0 ? "text-gain" : Number(v) < 0 ? "text-loss" : "text-paper-dim";

// P1-P6 + the 5 buy-and-hold benchmarks, in the order they should render.
// IDs match the scr_fwd_portfolios rows created when the forward test was
// built (2026-11-15) -- start_date 2026-11-30 for all of them.
const PORTFOLIOS = [
  { id: 1, key: "P1_fool_rule_breakers", label: "P1 — Fool Rule Breakers", color: "#c9a24b" },
  { id: 2, key: "P2_fool_stock_advisor", label: "P2 — Fool Stock Advisor", color: "#8a6fd1" },
  { id: 3, key: "P3_live_screen", label: "P3 — Live Screen (judgment)", color: "#5aa9e6" },
  { id: 4, key: "P4_a1_numbers_only", label: "P4 — A1 numbers-only", color: "#4caf7d" },
  { id: 5, key: "P5_profile_b", label: "P5 — Profile B", color: "#e07a5f" },
  { id: 6, key: "P6_value_momentum", label: "P6 — Value+Momentum", color: "#d4b483" },
];
const BENCHMARKS = [
  { id: 7, key: "BENCH_SPY", label: "SPY", color: "#9ca3af" },
  { id: 8, key: "BENCH_QQQ", label: "QQQ", color: "#b0b0b0" },
  { id: 9, key: "BENCH_RSP", label: "RSP", color: "#808080" },
  { id: 10, key: "BENCH_IWM", label: "IWM", color: "#6b6b6b" },
  { id: 11, key: "BENCH_BIL", label: "BIL", color: "#4d4d4d" },
];
const ALL_SERIES = [...PORTFOLIOS, ...BENCHMARKS];
const START_DATE = "2026-11-30";

export default function ForwardTestPage() {
  const [navRows, setNavRows] = useState([]);
  const [holdingsCount, setHoldingsCount] = useState({});
  const [turnoverByPortfolio, setTurnoverByPortfolio] = useState({});
  const [expanded, setExpanded] = useState(null); // portfolio id currently showing holdings/trades
  const [holdingsDetail, setHoldingsDetail] = useState([]);
  const [tradesDetail, setTradesDetail] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr(null);
      try {
        const { data: nav, error: navErr } = await supabase
          .from("scr_fwd_nav")
          .select("portfolio, date, nav, period_return, turnover")
          .order("date", { ascending: true });
        if (navErr) throw navErr;
        if (cancelled) return;
        setNavRows(nav ?? []);

        const counts = {};
        const turnovers = {};
        for (const p of PORTFOLIOS) {
          const { count } = await supabase
            .from("scr_fwd_holdings")
            .select("company_id", { count: "exact", head: true })
            .eq("portfolio", p.id)
            .gt("shares", 0)
            .eq("as_of_date", (nav ?? []).filter((n) => n.portfolio === p.id).slice(-1)[0]?.date ?? "1900-01-01");
          counts[p.id] = count ?? 0;
          const myNav = (nav ?? []).filter((n) => n.portfolio === p.id);
          turnovers[p.id] = myNav.reduce((s, r) => s + (Number(r.turnover) || 0), 0);
        }
        if (!cancelled) {
          setHoldingsCount(counts);
          setTurnoverByPortfolio(turnovers);
        }
      } catch (e) {
        if (!cancelled) setErr(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function openPortfolio(id) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    const { data: holdings } = await supabase
      .from("scr_fwd_holdings").select("symbol, shares, weight, as_of_date")
      .eq("portfolio", id).gt("shares", 0).order("as_of_date", { ascending: false }).limit(50);
    const { data: trades } = await supabase
      .from("scr_fwd_trades").select("symbol, side, shares, price, cost, reason, trade_date")
      .eq("portfolio", id).order("trade_date", { ascending: false }).limit(50);
    setHoldingsDetail(holdings ?? []);
    setTradesDetail(trades ?? []);
  }

  // Chart data: one row per date, one column per series (nav value).
  const chartData = useMemo(() => {
    const byDate = {};
    for (const row of navRows) {
      const d = row.date;
      byDate[d] ??= { date: d };
      const series = ALL_SERIES.find((s) => s.id === row.portfolio);
      if (series) byDate[d][series.key] = Number(row.nav);
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  }, [navRows]);

  const latestByPortfolio = useMemo(() => {
    const m = {};
    for (const s of ALL_SERIES) {
      const rows = navRows.filter((r) => r.portfolio === s.id).sort((a, b) => a.date.localeCompare(b.date));
      m[s.id] = rows[rows.length - 1] ?? null;
    }
    return m;
  }, [navRows]);

  function metricsFor(id) {
    const latest = latestByPortfolio[id];
    if (!latest) return null;
    const startNav = 100000;
    const nav = Number(latest.nav);
    const returnSinceStart = nav / startNav - 1;
    const startDate = new Date(START_DATE);
    const asOf = new Date(latest.date);
    const monthsLive = (asOf - startDate) / (1000 * 60 * 60 * 24 * 30.44);
    const annualized = monthsLive >= 12 ? Math.pow(nav / startNav, 12 / monthsLive) - 1 : null;
    const rows = navRows.filter((r) => r.portfolio === id).sort((a, b) => a.date.localeCompare(b.date));
    let peak = startNav, maxDd = 0;
    for (const r of rows) {
      const v = Number(r.nav);
      peak = Math.max(peak, v);
      maxDd = Math.min(maxDd, v / peak - 1);
    }
    return { nav, returnSinceStart, annualized, maxDd, monthsLive };
  }

  const spyMetrics = metricsFor(8); // index used for excess-return comparisons below (QQQ = id 8... fix: QQQ id is 8? no, SPY=7,QQQ=8)
  const spyLatest = latestByPortfolio[7];
  const qqqLatest = latestByPortfolio[8];

  return (
    <Shell>
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div>
          <h1 className="text-xl font-semibold text-paper">Forward Test</h1>
          <p className="text-sm text-paper-dim mt-1">
            Six live portfolios (P1–P6), each opened {START_DATE}, tracked against SPY/QQQ/RSP/IWM/BIL.
            Picks are recorded once, at the time, append-only — nothing here is ever backfilled or rescored.
          </p>
        </div>

        {err && (
          <div className="rounded-lg border border-loss/30 bg-loss/10 text-loss px-4 py-3 text-sm">
            Couldn&apos;t load forward-test data: {err}
          </div>
        )}

        {!err && !loading && navRows.length === 0 && (
          <div className="rounded-lg border border-ink-line bg-ink-soft px-4 py-6 text-sm text-paper-dim text-center">
            No forward-test data yet. The six portfolios open {START_DATE} — NAV curves and holdings will appear here
            once the daily job starts recording real picks and prices after that date.
          </div>
        )}

        {!loading && navRows.length > 0 && (
          <div className="rounded-lg border border-ink-line bg-ink-soft p-4">
            <h2 className="text-sm font-medium text-paper mb-3">NAV, indexed to $100,000 at inception</h2>
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v) => usd(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {ALL_SERIES.map((s) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} dot={false} strokeWidth={s.id <= 6 ? 2 : 1} strokeDasharray={s.id > 6 ? "4 2" : undefined} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="rounded-lg border border-ink-line bg-ink-soft overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-line text-left text-paper-dim">
                <th className="px-4 py-2 font-medium">Portfolio</th>
                <th className="px-4 py-2 font-medium text-right">Return since start</th>
                <th className="px-4 py-2 font-medium text-right">Annualized{" "}
                  <span className="text-xs" title="Activates once the portfolio has been live 12+ months">(≥12mo)</span>
                </th>
                <th className="px-4 py-2 font-medium text-right">Excess vs SPY</th>
                <th className="px-4 py-2 font-medium text-right">Excess vs QQQ</th>
                <th className="px-4 py-2 font-medium text-right">Max drawdown</th>
                <th className="px-4 py-2 font-medium text-right">Positions</th>
                <th className="px-4 py-2 font-medium text-right">Lifetime turnover</th>
                <th className="px-4 py-2 font-medium text-right">Details</th>
              </tr>
            </thead>
            <tbody>
              {PORTFOLIOS.map((p) => {
                const m = metricsFor(p.id);
                const spy = latestByPortfolio[7];
                const qqq = latestByPortfolio[8];
                const excessSpy = m && spy ? m.returnSinceStart - (Number(spy.nav) / 100000 - 1) : null;
                const excessQqq = m && qqq ? m.returnSinceStart - (Number(qqq.nav) / 100000 - 1) : null;
                return (
                  <>
                    <tr key={p.id} className="border-b border-ink-line/60">
                      <td className="px-4 py-2 text-paper">{p.label}</td>
                      <td className={`px-4 py-2 text-right ${gainCls(m?.returnSinceStart)}`}>{m ? pct(m.returnSinceStart) : "—"}</td>
                      <td className={`px-4 py-2 text-right ${gainCls(m?.annualized)}`}>{m?.annualized != null ? pct(m.annualized) : "not yet 12mo"}</td>
                      <td className={`px-4 py-2 text-right ${gainCls(excessSpy)}`}>{excessSpy != null ? pct(excessSpy) : "—"}</td>
                      <td className={`px-4 py-2 text-right ${gainCls(excessQqq)}`}>{excessQqq != null ? pct(excessQqq) : "—"}</td>
                      <td className="px-4 py-2 text-right text-loss">{m ? pct(m.maxDd) : "—"}</td>
                      <td className="px-4 py-2 text-right text-paper-dim">{holdingsCount[p.id] ?? "—"}</td>
                      <td className="px-4 py-2 text-right text-paper-dim">{usd(turnoverByPortfolio[p.id])}</td>
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => openPortfolio(p.id)} className="text-xs text-sky hover:underline">
                          {expanded === p.id ? "Hide" : "Holdings / Trades"}
                        </button>
                      </td>
                    </tr>
                    {expanded === p.id && (
                      <tr key={`${p.id}-detail`} className="border-b border-ink-line/60 bg-ink/40">
                        <td colSpan={9} className="px-4 py-4">
                          <div className="grid grid-cols-2 gap-6">
                            <div>
                              <h3 className="text-xs font-medium text-paper-dim mb-2">Current holdings</h3>
                              {holdingsDetail.length === 0 ? (
                                <p className="text-xs text-paper-dim">No open positions yet.</p>
                              ) : (
                                <table className="w-full text-xs">
                                  <tbody>
                                    {holdingsDetail.map((h, i) => (
                                      <tr key={i} className="border-b border-ink-line/40">
                                        <td className="py-1 text-paper">{h.symbol}</td>
                                        <td className="py-1 text-right text-paper-dim">{Number(h.shares).toFixed(2)} sh</td>
                                        <td className="py-1 text-right text-paper-dim">{h.weight != null ? pct(h.weight, 1) : "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                            <div>
                              <h3 className="text-xs font-medium text-paper-dim mb-2">Recent trades</h3>
                              {tradesDetail.length === 0 ? (
                                <p className="text-xs text-paper-dim">No trades recorded yet.</p>
                              ) : (
                                <table className="w-full text-xs">
                                  <tbody>
                                    {tradesDetail.map((t, i) => (
                                      <tr key={i} className="border-b border-ink-line/40">
                                        <td className="py-1 text-paper-dim">{t.trade_date}</td>
                                        <td className={`py-1 ${t.side === "buy" ? "text-gain" : "text-loss"}`}>{t.side}</td>
                                        <td className="py-1 text-paper">{t.symbol}</td>
                                        <td className="py-1 text-right text-paper-dim">{Number(t.shares).toFixed(2)} sh @ {usd(t.price)}</td>
                                        <td className="py-1 text-paper-dim/70 truncate max-w-[12rem]" title={t.reason}>{t.reason}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-paper-dim/70">
          Review schedule: quarterly automated summary; formal reviews at 12 months (2027-11-30, progress check only)
          and 24 months (2028-11-30, the decision point).
        </p>
      </div>
    </Shell>
  );
}
