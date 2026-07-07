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

// ─── Shared utilities ─────────────────────────────────────────────────────────

function buildZScoreData(rows, valueKey, range, invert = false) {
  if (!rows?.length) return [];
  const vals = rows.filter((r) => r[valueKey] != null).map((r) => Number(r[valueKey]));
  if (!vals.length) return [];
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length) || 1;
  const byYear = Object.fromEntries(
    rows.filter((r) => r[valueKey] != null).map((r) => [r.year, Number(r[valueKey])])
  );
  const z = (v) => (invert ? -1 : 1) * (v - m) / sd;
  return rows
    .filter((r) => r.year >= range && r[valueKey] != null)
    .map((r) => {
      const zs = z(Number(r[valueKey]));
      const prev = byYear[r.year - 1];
      return {
        year: r.year,
        zScore: Math.round(zs * 1000) / 1000,
        change: prev != null ? Math.round((zs - z(prev)) * 1000) / 1000 : null,
      };
    });
}

function StandardZScoreChart({ chartData, lineName = "Risk z-score" }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={chartData} margin={{ top: 4, right: 44, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#2A3240" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="year"
          type="number"
          domain={["dataMin", "dataMax"]}
          allowDecimals={false}
          tick={{ fill: "#A8ADB8", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => String(v)}
          interval="preserveStartEnd"
        />
        <YAxis yAxisId="left" tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => v.toFixed(1)} width={36} />
        <YAxis yAxisId="right" orientation="right" tick={{ fill: "#A8ADB8", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`} width={44} />
        <Tooltip content={<RiskTooltip />} />
        <ReferenceLine yAxisId="left" y={1}  stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
        <ReferenceLine yAxisId="left" y={0}  stroke="#2A3240" strokeWidth={1} />
        <ReferenceLine yAxisId="left" y={-1} stroke="#22c55e" strokeDasharray="4 2" strokeWidth={1} strokeOpacity={0.5} />
        <ReferenceLine yAxisId="right" y={0} stroke="#2A3240" strokeWidth={1} />
        <Bar yAxisId="right" dataKey="change" name="YoY Δ" maxBarSize={12}>
          {chartData.map((entry, i) => (
            <Cell key={i} fill={entry.change == null ? "transparent" : entry.change >= 0 ? "#E0635C" : "#3FB984"} fillOpacity={0.6} />
          ))}
        </Bar>
        <Line yAxisId="left" type="monotone" dataKey="zScore" name={lineName} stroke="#C9A227" strokeWidth={2} dot={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function BaseGaugeDrawer({ open, onClose, title, desc, source, latestGauge, range, setRange, loading, renderChart, gaugeHistory, gaugeKey, subComponents = [], renderTable, infoContent, assessment, currentZLabel }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const gaugeRows = (gaugeHistory ?? []).filter((r) => r[gaugeKey] != null);
  const gaugeColor = latestGauge == null ? "text-paper-dim" : latestGauge > 1 ? "text-loss" : latestGauge < -1 ? "text-gain" : "text-brass-soft";

  return (
    <>
      <div className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`} onClick={onClose} />
      <div className={`fixed right-0 top-0 h-full w-[650px] max-w-[95vw] bg-ink-soft border-l border-ink-line z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-line shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-paper">{title}</h2>
              {infoContent && (
                <button
                  onClick={() => setInfoOpen((v) => !v)}
                  className={`w-[18px] h-[18px] rounded-full border text-[10px] font-bold flex items-center justify-center flex-shrink-0 transition-colors ${infoOpen ? "border-brass text-brass bg-brass/10" : "border-paper-dim/40 text-paper-dim hover:border-paper hover:text-paper"}`}
                  title="About this metric"
                >
                  i
                </button>
              )}
            </div>
            <p className="text-[10px] text-paper-dim mt-0.5">{desc}</p>
          </div>
          <div className="flex items-start gap-4 shrink-0">
            {latestGauge != null && (
              <div className="text-right">
                <p className={`num text-xl font-bold leading-none ${gaugeColor}`}>{latestGauge >= 0 ? "+" : ""}{Number(latestGauge).toFixed(2)}</p>
                <p className="text-[10px] text-paper-dim mt-0.5">{currentZLabel ?? "Current z"}</p>
              </div>
            )}
            <button onClick={onClose} className="text-paper-dim hover:text-paper transition-colors mt-0.5"><CloseIcon /></button>
          </div>
        </div>

        {infoContent && infoOpen && (
          <div className="px-5 py-4 border-b border-ink-line bg-ink shrink-0 overflow-y-auto max-h-[45vh]">
            {infoContent}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="flex items-center gap-1">
            {RISK_RANGES.map((r) => (
              <button key={r.from} onClick={() => setRange(r.from)} className={`px-3 py-1 rounded-lg text-xs transition-colors ${range === r.from ? "bg-ink text-brass-soft border border-brass/30" : "text-paper-dim hover:text-paper"}`}>
                {r.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="h-64 flex items-center justify-center text-paper-dim text-sm">Loading…</div>
          ) : (
            <div className="card p-4">
              {renderChart()}
              <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-paper-dim/70">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-6 h-[2px] rounded-sm bg-[#C9A227]" />
                  z-score
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-flex gap-0.5">
                    <span className="inline-block w-1.5 h-3 rounded-sm bg-[#E0635C] opacity-70" />
                    <span className="inline-block w-1.5 h-3 rounded-sm bg-[#3FB984] opacity-70" />
                  </span>
                  YoY Δ
                </span>
                <span className="flex items-center gap-1"><span className="inline-block w-6 h-px bg-[#ef4444] opacity-50" /> Elevated (&gt; +1)</span>
                <span className="flex items-center gap-1"><span className="inline-block w-6 h-px bg-[#22c55e] opacity-50" /> Low (&lt; −1)</span>
              </div>
            </div>
          )}

          {assessment && assessment}

          {renderTable ? renderTable() : gaugeRows.length > 0 && (
            <div className="card p-4">
              <p className="label text-[10px] mb-3">Gauge Readings (actual)</p>
              <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                {gaugeRows.slice().reverse().map((r) => (
                  <div key={r.year} className="flex items-center justify-between text-xs">
                    <span className="text-paper-dim">{r.year}</span>
                    <div className="flex items-center gap-3">
                      {subComponents.map(({ key, label }) => r[key] != null && (
                        <span key={key} className="text-paper-dim text-[10px]">{label}: <span className="num text-paper">{Number(r[key]) >= 0 ? "+" : ""}{Number(r[key]).toFixed(2)}</span></span>
                      ))}
                      <span className={`num font-semibold ${Number(r[gaugeKey]) > 1 ? "text-loss" : Number(r[gaugeKey]) < -1 ? "text-gain" : "text-brass-soft"}`}>
                        {Number(r[gaugeKey]) >= 0 ? "+" : ""}{Number(r[gaugeKey]).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-paper-dim/60">Source: <span className="font-mono">{source}</span></p>
        </div>
      </div>
    </>
  );
}

// ─── Gauge 1: Debt Sustainability Risk ───────────────────────────────────────

const DEBT_SUST_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">What this measures</p>
      <p className="text-paper-dim">Debt Sustainability Risk tracks the total debt burden of the economy relative to two key benchmarks: gross domestic product (Debt/GDP) and income (Debt/Income). When debt grows faster than the economy's ability to generate output and income, the burden of servicing that debt becomes progressively harder to bear. This gauge captures both dimensions simultaneously, giving a composite view of how stretched the debt load is relative to historical norms going back to 1952.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">How it's calculated</p>
      <p className="text-paper-dim">Two separate z-scores are computed — one for the Debt/GDP ratio and one for the Debt/Income ratio — each measured against the full available history. A z-score reflects how many standard deviations the current reading sits above or below the long-run mean. The two z-scores are then averaged to produce the composite gauge reading. A positive composite means debt is elevated relative to historical norms across both measures; a negative composite means it is below average.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Why it matters</p>
      <p className="text-paper-dim">In Ray Dalio's long-term debt cycle framework, unsustainable debt is the central driver of deleveraging crises. When the debt burden becomes too heavy — typically after decades of credit expansion — debt service costs crowd out productive spending. Borrowers are forced to reduce debt faster than it can be grown away, triggering deflationary downturns. Historically, the peak of the long-term debt cycle has been followed by painful multi-year deleveragings. The higher this gauge, the closer the economy is to conditions that have historically preceded such cycles.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Thresholds</p>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2"><span className="text-loss font-mono w-16">&gt; +2.0</span><span className="text-paper-dim">Critical — debt at historic extremes, structural deleveraging likely</span></div>
        <div className="flex gap-2"><span className="text-loss font-mono w-16">&gt; +1.5</span><span className="text-paper-dim">Elevated Risk — significantly above historical norms, structural vulnerability building</span></div>
        <div className="flex gap-2"><span className="text-loss font-mono w-16">&gt; +1.0</span><span className="text-paper-dim">Elevated — Watch — above average, monitor for acceleration</span></div>
        <div className="flex gap-2"><span className="text-brass-soft font-mono w-16">0 to +1</span><span className="text-paper-dim">Mild pressure — modestly elevated, not yet alarming</span></div>
        <div className="flex gap-2"><span className="text-gain font-mono w-16">&lt; 0</span><span className="text-paper-dim">Sustainable — debt levels at or below historical average</span></div>
      </div>
    </div>
  </div>
);

function debtSustAssessment(gauge1) {
  if (gauge1 == null) return null;
  if (gauge1 > 2.0) return {
    label: "Critical Risk",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "Debt/GDP and Debt/Income ratios are at or near their most extreme levels in the full historical record. Conditions at this level mirror the late stages of historical long-term debt cycles. The probability of a forced deleveraging — where debt is reduced not by growth but by defaults, inflation, or austerity — is meaningfully elevated. This is the highest-risk zone in Dalio's framework, where the structural imbalance is severe enough that a shock could trigger a self-reinforcing contraction.",
  };
  if (gauge1 > 1.5) return {
    label: "Elevated Risk",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "Debt levels are significantly above their historical average across both the GDP and income dimensions, placing the economy in structurally vulnerable territory. Debt service costs are high relative to income, leaving households, corporations, and government with less flexibility to absorb economic shocks. Historical episodes at this level have been followed by extended periods of credit contraction. While an immediate crisis is not inevitable, the structural conditions are fragile — a negative shock could accelerate the deleveraging dynamic faster than in a healthier debt environment.",
  };
  if (gauge1 > 1.0) return {
    label: "Elevated — Watch",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "The composite debt burden is above its long-run historical average, meaning debt as a share of GDP and income has grown beyond typical norms. The situation is not at crisis levels, but the trajectory matters — continued credit expansion without commensurate income growth will push this gauge higher. Monitor the rate of change: a gauge reading that is rising quickly is more concerning than a stable elevated reading, since it signals that the structural imbalance is still widening.",
  };
  if (gauge1 > 0.0) return {
    label: "Mild Pressure",
    color: "text-brass-soft", border: "border-brass/20", bg: "bg-brass/5",
    text: "Debt levels are modestly above their historical average — above the long-run norm but not at extremes. This is a relatively common mid-cycle condition that does not, by itself, signal imminent stress. The economy retains meaningful capacity to service debt and absorb shocks. The risk to monitor is whether the trend continues higher: moving from mild pressure to elevated risk can occur gradually over several years before becoming apparent in economic data.",
  };
  return {
    label: "Sustainable",
    color: "text-gain", border: "border-gain/20", bg: "bg-gain/5",
    text: "Debt/GDP and Debt/Income ratios are at or below their long-run historical average, consistent with a debt load the economy can comfortably service. Debt sustainability is not a binding constraint on growth at these levels. Households, corporations, and government retain the balance sheet capacity to borrow and spend if needed, and debt service costs are not crowding out productive activity.",
  };
}

function DebtSustainabilityDrawer({ open, onClose, latestGauge, latestGaugeYear }) {
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

  const chartData = useMemo(() => buildZScoreData(rows, "debt_to_gdp_pct", range), [rows, range]);

  const tableRows = useMemo(() => {
    const gdpMap = Object.fromEntries(
      (rows ?? []).filter((r) => r.debt_to_gdp_pct != null).map((r) => [r.year, Number(r.debt_to_gdp_pct)])
    );
    const gaugeMap = Object.fromEntries((gaugeHistory ?? []).map((r) => [r.year, r]));
    const allYears = [...new Set([
      ...(rows ?? []).map((r) => r.year),
      ...(gaugeHistory ?? []).map((r) => r.year),
    ])].sort((a, b) => b - a);
    return allYears
      .map((year) => ({
        year,
        debtGdp: gdpMap[year] ?? null,
        zDebtGdp: gaugeMap[year]?.z_debt_gdp != null ? Number(gaugeMap[year].z_debt_gdp) : null,
        zDebtInc: gaugeMap[year]?.z_debt_income != null ? Number(gaugeMap[year].z_debt_income) : null,
        composite: gaugeMap[year]?.gauge1 != null ? Number(gaugeMap[year].gauge1) : null,
      }))
      .filter((r) => r.debtGdp != null || r.zDebtGdp != null || r.composite != null);
  }, [rows, gaugeHistory]);

  const assessed = debtSustAssessment(latestGauge);
  const assessment = assessed ? (
    <div className={`card p-4 border ${assessed.border} ${assessed.bg}`}>
      <p className="label text-[10px] mb-2">Current Assessment</p>
      <p className={`text-xs font-semibold mb-2 ${assessed.color}`}>{assessed.label}</p>
      <p className="text-[11px] text-paper-dim leading-relaxed">{assessed.text}</p>
    </div>
  ) : null;

  return (
    <BaseGaugeDrawer
      open={open} onClose={onClose}
      title="Debt Sustainability Risk"
      desc="Composite z-score · Debt/GDP + Debt/Income vs full history 1952–present"
      source="macro_debt_cycle · debt_to_gdp_pct"
      latestGauge={latestGauge}
      currentZLabel={latestGaugeYear ? `Composite · ${latestGaugeYear}` : "Current z"}
      range={range} setRange={setRange}
      loading={rows === null}
      renderChart={() => <StandardZScoreChart chartData={chartData} lineName="Debt/GDP z" />}
      gaugeHistory={gaugeHistory}
      gaugeKey="gauge1"
      infoContent={DEBT_SUST_INFO}
      assessment={assessment}
      renderTable={() => (
        <div className="card p-4">
          <p className="label text-[10px] mb-3">Composite Gauge Readings</p>
          <div className="grid text-[10px] text-paper-dim pb-1.5 mb-1.5 border-b border-ink-line pr-1" style={{ gridTemplateColumns: "1fr repeat(4, 68px)" }}>
            <span>Year</span>
            <span className="text-right">Debt/GDP%</span>
            <span className="text-right">D/GDP z</span>
            <span className="text-right">D/Inc z</span>
            <span className="text-right">Composite</span>
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
            {tableRows.map((r) => {
              const isPartial = r.composite == null;
              return (
                <div key={r.year} className="grid items-center text-xs" style={{ gridTemplateColumns: "1fr repeat(4, 68px)" }}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-paper-dim">{r.year}</span>
                    {isPartial && <span className="text-[9px] text-brass/60 border border-brass/20 rounded px-1">partial</span>}
                  </div>
                  <span className="num text-right text-paper">{r.debtGdp != null ? `${r.debtGdp.toFixed(1)}%` : "—"}</span>
                  <span className="num text-right text-paper-dim">{r.zDebtGdp != null ? `${r.zDebtGdp >= 0 ? "+" : ""}${r.zDebtGdp.toFixed(2)}` : "—"}</span>
                  <span className="num text-right text-paper-dim">{r.zDebtInc != null ? `${r.zDebtInc >= 0 ? "+" : ""}${r.zDebtInc.toFixed(2)}` : "—"}</span>
                  <span className={`num text-right font-semibold ${r.composite == null ? "text-paper-dim" : r.composite > 1 ? "text-loss" : r.composite < -1 ? "text-gain" : "text-brass-soft"}`}>
                    {r.composite != null ? `${r.composite >= 0 ? "+" : ""}${r.composite.toFixed(2)}` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    />
  );
}

// ─── Gauge 2: Policy Room Risk ────────────────────────────────────────────────

const POLICY_ROOM_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">What this measures</p>
      <p className="text-paper-dim">Policy Room Risk quantifies how much capacity the Federal Reserve has to cut interest rates in response to an economic slowdown. When rates are near zero, the Fed's primary monetary tool is largely exhausted — it cannot provide its usual stimulus by cutting further. This structural constraint amplifies downturns because debt becomes harder to service in real terms and there is no rate relief available.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">How it's calculated</p>
      <p className="text-paper-dim">The metric is an <span className="text-paper">inverted z-score</span> of the annual average Fed Funds rate measured against its full history (1954–present). A z-score shows how many standard deviations a reading sits above or below the long-run mean. Inverting the sign means a low rate (less room to cut) produces a high risk score, and a high rate (more room to cut) produces a low risk score.</p>
    </div>
    <div className="grid grid-cols-2 gap-2 text-[10px]">
      <div className="bg-ink-soft rounded-lg p-2.5 border border-ink-line">
        <p className="text-loss font-semibold mb-1">High z-score → Elevated Risk</p>
        <p className="text-paper-dim">Rate is below historical average. Fed has limited room to cut. Easing capacity is constrained.</p>
      </div>
      <div className="bg-ink-soft rounded-lg p-2.5 border border-ink-line">
        <p className="text-gain font-semibold mb-1">Low z-score → Low Risk</p>
        <p className="text-paper-dim">Rate is above historical average. Fed has ample room to cut. Strong easing capacity available.</p>
      </div>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Why it matters</p>
      <p className="text-paper-dim">In Dalio's framework, a central bank without room to ease cannot break a debt deflation spiral. When households and businesses simultaneously deleverage, economic activity contracts sharply. If the Fed cannot cut rates — or if cuts lose effectiveness near zero — the downturn deepens and debt burdens become more severe. High policy room risk means the Fed is a weaker safety net against economic stress.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Thresholds</p>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2"><span className="text-loss font-mono w-16">&gt; +1.0</span><span className="text-paper-dim">Elevated — historically constrained, limited easing capacity</span></div>
        <div className="flex gap-2"><span className="text-brass-soft font-mono w-16">0 to +1.0</span><span className="text-paper-dim">Neutral to mild — some constraint, monitor direction of travel</span></div>
        <div className="flex gap-2"><span className="text-gain font-mono w-16">&lt; 0</span><span className="text-paper-dim">Low risk — rates above average, meaningful room to cut</span></div>
      </div>
    </div>
  </div>
);

function policyRoomAssessment(gauge2, latestRate) {
  if (gauge2 == null) return null;
  const rateStr = latestRate != null ? `${Number(latestRate).toFixed(2)}%` : "the current rate";
  const bps = latestRate != null ? Math.round(Number(latestRate) * 100) : null;
  const bpsStr = bps != null ? `${bps} basis points` : "meaningful room";

  if (gauge2 > 1.5) {
    return {
      label: "Severely Constrained", color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
      text: `At ${rateStr}, the Fed Funds rate is far below its long-run historical average — conditions similar to 2009–2015 and 2020–2021. The Fed has almost no conventional room to cut further. Any economic shock from here would require reliance on unconventional tools such as quantitative easing and forward guidance, which are slower and less certain in their effect. This is the highest-risk configuration for policy room.`,
    };
  }
  if (gauge2 > 1.0) {
    return {
      label: "Elevated Risk", color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
      text: `At ${rateStr}, the Fed Funds rate is below its historical average, leaving less-than-normal easing capacity. While not at the zero bound, a sustained economic downturn could exhaust this buffer quickly. The Fed retains some conventional tools but would need to move aggressively and early to preserve them. Watch for further rate cuts that would push this score higher.`,
    };
  }
  if (gauge2 > 0.25) {
    return {
      label: "Mild Risk — Watch", color: "text-brass-soft", border: "border-brass/20", bg: "bg-brass/5",
      text: `At ${rateStr} the Fed Funds rate sits modestly below its long-run historical average. The Fed retains ${bpsStr} of conventional cutting room above zero — meaningful capacity, but not a position of exceptional strength. Recent rate cuts from the 2023 peak of 5.33% have consumed roughly 170 basis points of headroom. The reading is not alarming, but the direction matters: continued cuts without an offsetting improvement in growth would push this score toward elevated territory.`,
    };
  }
  if (gauge2 > -0.25) {
    return {
      label: "Neutral", color: "text-paper", border: "border-ink-line", bg: "bg-ink/40",
      text: `At ${rateStr}, the Fed Funds rate is near its long-run historical average, placing policy room in a balanced position. The Fed has a reasonable buffer to respond to economic weakness without approaching the zero lower bound. This reading does not flag policy space as a primary risk driver — the Fed retains conventional tools in sufficient quantity to respond to a moderate slowdown.`,
    };
  }
  if (gauge2 > -1.0) {
    return {
      label: "Ample Room", color: "text-gain", border: "border-gain/20", bg: "bg-gain/5",
      text: `At ${rateStr}, the Fed Funds rate is above its long-run historical average, indicating the Fed has significant room to cut if needed. A meaningful economic slowdown could be met with aggressive conventional easing before the zero bound becomes a constraint. Policy room risk is not a binding concern at this level.`,
    };
  }
  return {
    label: "Maximum Policy Room", color: "text-gain", border: "border-gain/20", bg: "bg-gain/5",
    text: `At ${rateStr}, the Fed Funds rate is well above its long-run historical average — historically a high-rate environment. The Fed has exceptional capacity to cut rates aggressively in response to economic stress. This is the most favorable configuration for policy room: monetary easing is a powerful and available tool, and the zero lower bound presents no near-term constraint.`,
  };
}

function PolicyRoomDrawer({ open, onClose, latestGauge }) {
  const [rows, setRows] = useState(null);
  const [gaugeHistory, setGaugeHistory] = useState(null);
  const [range, setRange] = useState(1954);

  useEffect(() => {
    if (!open || rows !== null) return;
    Promise.all([
      supabase.from("macro_credit_cycle").select("year,fed_funds_rate,updated_at").order("year"),
      supabase.from("dalio_gauge_readings").select("year,gauge2,z_fed_funds").order("year"),
    ]).then(([credit, gauge]) => { setRows(credit.data ?? []); setGaugeHistory(gauge.data ?? []); });
  }, [open, rows]);

  const chartData = useMemo(() => buildZScoreData(rows, "fed_funds_rate", range, true), [rows, range]);

  const tableRows = useMemo(() => {
    if (!rows?.length) return [];
    const gaugeMap = Object.fromEntries((gaugeHistory ?? []).map((r) => [r.year, r]));
    const maxYear = Math.max(...rows.map((r) => r.year));
    const desc = rows.slice().reverse();
    return desc.map((r, i) => {
      const prev = desc[i + 1];
      const rate = r.fed_funds_rate != null ? Number(r.fed_funds_rate) : null;
      const prevRate = prev?.fed_funds_rate != null ? Number(prev.fed_funds_rate) : null;
      const netChange = rate != null && prevRate != null ? rate - prevRate : null;
      const g = gaugeMap[r.year];
      let yearLabel = String(r.year);
      if (r.year === maxYear && r.updated_at) {
        const d = new Date(r.updated_at);
        d.setUTCMonth(d.getUTCMonth() - 1);
        yearLabel = `${r.year} · ${d.toLocaleString("default", { month: "short" })}`;
      }
      return { year: r.year, yearLabel, rate, netChange, gauge2: g?.gauge2 != null ? Number(g.gauge2) : null };
    });
  }, [rows, gaugeHistory]);

  const latestRate = rows?.length ? rows[rows.length - 1]?.fed_funds_rate : null;
  const assessed = latestGauge != null ? policyRoomAssessment(latestGauge, latestRate) : null;

  const assessment = assessed ? (
    <div className={`card p-4 border ${assessed.border} ${assessed.bg}`}>
      <p className="label text-[10px] mb-2">Current Assessment</p>
      <p className={`text-xs font-semibold mb-2 ${assessed.color}`}>{assessed.label}</p>
      <p className="text-[11px] text-paper-dim leading-relaxed">{assessed.text}</p>
    </div>
  ) : null;

  return (
    <BaseGaugeDrawer
      open={open} onClose={onClose}
      title="Policy Room Risk"
      desc="Fed Funds rate z-score · inverted — low rates = less room to cut = higher risk"
      source="macro_credit_cycle · fed_funds_rate"
      latestGauge={latestGauge}
      range={range} setRange={setRange}
      loading={rows === null}
      renderChart={() => <StandardZScoreChart chartData={chartData} lineName="Policy Room Risk z" />}
      gaugeHistory={gaugeHistory}
      gaugeKey="gauge2"
      infoContent={POLICY_ROOM_INFO}
      assessment={assessment}
      renderTable={() => (
        <div className="card p-4">
          <p className="label text-[10px] mb-3">Gauge Readings (actual)</p>
          <div className="grid text-[10px] text-paper-dim pb-1.5 mb-1.5 border-b border-ink-line pr-1" style={{ gridTemplateColumns: "1fr repeat(3, 72px)" }}>
            <span>Period</span>
            <span className="text-right">Rate</span>
            <span className="text-right">Net Δ</span>
            <span className="text-right">Z-score</span>
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
            {tableRows.map((r) => (
              <div key={r.year} className="grid items-center text-xs" style={{ gridTemplateColumns: "1fr repeat(3, 72px)" }}>
                <span className="text-paper-dim">{r.yearLabel}</span>
                <span className="num text-right text-paper">
                  {r.rate != null ? `${r.rate.toFixed(2)}%` : "—"}
                </span>
                <span className={`num text-right ${r.netChange == null ? "text-paper-dim" : r.netChange > 0 ? "text-loss" : r.netChange < 0 ? "text-gain" : "text-paper-dim"}`}>
                  {r.netChange != null ? `${r.netChange >= 0 ? "+" : ""}${r.netChange.toFixed(2)}%` : "—"}
                </span>
                <span className={`num text-right font-semibold ${r.gauge2 == null ? "text-paper-dim" : r.gauge2 > 1 ? "text-loss" : r.gauge2 < -1 ? "text-gain" : "text-brass-soft"}`}>
                  {r.gauge2 != null ? `${r.gauge2 >= 0 ? "+" : ""}${r.gauge2.toFixed(2)}` : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    />
  );
}

// ─── Gauge 3: Growth-Inflation Risk ──────────────────────────────────────────

const GROWTH_INFL_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">What this measures</p>
      <p className="text-paper-dim">Growth-Inflation Risk captures the simultaneous occurrence of two adverse economic conditions: elevated consumer price inflation and weak real economic growth. This combination — known as stagflation — is exceptionally damaging because the usual policy tools conflict: raising rates to fight inflation worsens growth, while cutting rates to support growth worsens inflation. The gauge uses 3-year trailing averages to smooth out short-term volatility and focus on persistent trends rather than temporary spikes.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">How it's calculated</p>
      <p className="text-paper-dim">Two z-scores are computed from the full historical record: one for the 3-year trailing average CPI inflation rate, and one for the 3-year trailing average real GDP growth rate. The composite is formed as <span className="text-paper font-mono">(z_CPI − z_RealGrowth) / 2</span>. Subtracting the real growth z-score means that high growth reduces the risk reading, while adding the CPI z-score means high inflation increases it. Dividing by 2 keeps the scale comparable to a single z-score.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Why it matters</p>
      <p className="text-paper-dim">In Dalio's asset cycle framework, stagflation is the worst macro regime for a diversified portfolio. Stocks fall because earnings compress under cost pressure and rate hikes reduce future cash flow valuations. Bonds fall because inflation erodes the real value of fixed coupons, while central banks must raise — not cut — rates to control prices. Cash loses real purchasing power. Only real assets (commodities, TIPS, gold) tend to outperform. A high reading on this gauge signals that investors should rotate away from conventional stocks and bonds and toward inflation-linked assets.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Thresholds</p>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2"><span className="text-loss font-mono w-20">&gt; +1.5</span><span className="text-paper-dim">Stagflationary — severe simultaneous high inflation and weak growth</span></div>
        <div className="flex gap-2"><span className="text-loss font-mono w-20">&gt; +1.0</span><span className="text-paper-dim">Elevated Risk — stagflation signal present and persistent</span></div>
        <div className="flex gap-2"><span className="text-brass-soft font-mono w-20">&gt; +0.25</span><span className="text-paper-dim">Watch — early stagflation warning, trend worth monitoring</span></div>
        <div className="flex gap-2"><span className="text-paper font-mono w-20">±0.25</span><span className="text-paper-dim">Neutral — balanced growth and inflation environment</span></div>
        <div className="flex gap-2"><span className="text-gain font-mono w-20">&lt; −0.25</span><span className="text-paper-dim">Favorable — disinflationary boom or low-inflation growth</span></div>
      </div>
    </div>
  </div>
);

function growthInflAssessment(gauge3) {
  if (gauge3 == null) return null;
  if (gauge3 > 1.5) return {
    label: "Stagflationary",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "Both real growth and inflation are simultaneously far from benign levels — growth is well below average while inflation is well above average. This is the textbook stagflation regime. Conventional monetary policy cannot address both conditions simultaneously: rate hikes that control inflation worsen growth, while cuts that support growth worsen inflation. This configuration historically produces losses across equities and nominal bonds simultaneously. Allocation toward real assets and inflation-linked instruments is most consistent with this environment.",
  };
  if (gauge3 > 1.0) return {
    label: "Elevated Risk",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "The stagflation signal is elevated — the combination of above-average inflation and below-average real growth is meaningful and persistent on a 3-year trailing basis. While not yet at extreme historical levels, this reading signals that the growth-inflation tradeoff is becoming adverse. Central banks face a policy dilemma: the appropriate response to inflation (tighten) conflicts with the appropriate response to weak growth (ease). Asset allocation should begin tilting toward inflation protection and away from long-duration nominal assets.",
  };
  if (gauge3 > 0.25) return {
    label: "Watch — Mild Signal",
    color: "text-brass-soft", border: "border-brass/20", bg: "bg-brass/5",
    text: "An early stagflation signal is present — inflation is running modestly above its historical average while real growth is running below, but neither deviation is severe enough to qualify as a full stagflation episode. The 3-year trailing averages are still being influenced by recent data, and the trend direction matters more than the current level. If inflation continues to run hot while real growth decelerates, this reading will move into elevated territory. Monitoring the trend and trajectory is warranted.",
  };
  if (gauge3 > -0.25) return {
    label: "Neutral",
    color: "text-paper", border: "border-ink-line", bg: "bg-ink/40",
    text: "The growth-inflation environment is broadly balanced. Neither inflation nor real growth is meaningfully deviating from its historical average in a way that creates a policy dilemma. This is consistent with a relatively normal business cycle environment where central banks have flexibility to respond to either direction of shock. No stagflation premium is warranted in asset allocation at this reading.",
  };
  return {
    label: "Favorable",
    color: "text-gain", border: "border-gain/20", bg: "bg-gain/5",
    text: "The growth-inflation environment is favorable — either real growth is running well above average, inflation is running below average, or both. This is the disinflationary boom regime that is most supportive of broad asset returns: equities benefit from strong earnings growth, bonds benefit from low inflation expectations, and the central bank has room to ease if needed. This is the most benign configuration in Dalio's macro framework.",
  };
}

function GrowthInflationDrawer({ open, onClose, latestGauge }) {
  const [rows, setRows] = useState(null);
  const [gaugeHistory, setGaugeHistory] = useState(null);
  const [range, setRange] = useState(1953);

  useEffect(() => {
    if (!open || rows !== null) return;
    Promise.all([
      supabase.from("macro_debt_cycle_computed").select("year,avg3_real,avg3_cpi").order("year"),
      supabase.from("dalio_gauge_readings").select("year,gauge3,z_real_growth_3yr,z_cpi_3yr").order("year"),
    ]).then(([dc, gauge]) => { setRows(dc.data ?? []); setGaugeHistory(gauge.data ?? []); });
  }, [open, rows]);

  const chartData = useMemo(() => {
    if (!rows?.length) return [];
    const reals = rows.filter((r) => r.avg3_real != null).map((r) => Number(r.avg3_real));
    const cpis  = rows.filter((r) => r.avg3_cpi  != null).map((r) => Number(r.avg3_cpi));
    if (!reals.length || !cpis.length) return [];
    const mR = reals.reduce((s, v) => s + v, 0) / reals.length;
    const sdR = Math.sqrt(reals.reduce((s, v) => s + (v - mR) ** 2, 0) / reals.length) || 1;
    const mC = cpis.reduce((s, v) => s + v, 0) / cpis.length;
    const sdC = Math.sqrt(cpis.reduce((s, v) => s + (v - mC) ** 2, 0) / cpis.length) || 1;
    const byYear = Object.fromEntries(
      rows.filter((r) => r.avg3_real != null && r.avg3_cpi != null)
          .map((r) => [r.year, (((Number(r.avg3_cpi) - mC) / sdC) - ((Number(r.avg3_real) - mR) / sdR)) / 2])
    );
    return rows
      .filter((r) => r.year >= range && r.avg3_real != null && r.avg3_cpi != null)
      .map((r) => {
        const zs = byYear[r.year];
        const prev = byYear[r.year - 1];
        return { year: r.year, zScore: Math.round(zs * 1000) / 1000, change: prev != null ? Math.round((zs - prev) * 1000) / 1000 : null };
      });
  }, [rows, range]);

  const tableRows = useMemo(() => {
    const dcMap = Object.fromEntries((rows ?? []).map((r) => [r.year, r]));
    const gaugeMap = Object.fromEntries((gaugeHistory ?? []).map((r) => [r.year, r]));
    const allYears = [...new Set([
      ...(rows ?? []).map((r) => r.year),
      ...(gaugeHistory ?? []).map((r) => r.year),
    ])].sort((a, b) => b - a);
    return allYears
      .map((year) => ({
        year,
        real: dcMap[year]?.avg3_real != null ? Number(dcMap[year].avg3_real) : null,
        cpi: dcMap[year]?.avg3_cpi != null ? Number(dcMap[year].avg3_cpi) : null,
        zReal: gaugeMap[year]?.z_real_growth_3yr != null ? Number(gaugeMap[year].z_real_growth_3yr) : null,
        zCpi: gaugeMap[year]?.z_cpi_3yr != null ? Number(gaugeMap[year].z_cpi_3yr) : null,
        composite: gaugeMap[year]?.gauge3 != null ? Number(gaugeMap[year].gauge3) : null,
      }))
      .filter((r) => r.real != null || r.zReal != null || r.composite != null);
  }, [rows, gaugeHistory]);

  const assessed = growthInflAssessment(latestGauge);
  const assessment = assessed ? (
    <div className={`card p-4 border ${assessed.border} ${assessed.bg}`}>
      <p className="label text-[10px] mb-2">Current Assessment</p>
      <p className={`text-xs font-semibold mb-2 ${assessed.color}`}>{assessed.label}</p>
      <p className="text-[11px] text-paper-dim leading-relaxed">{assessed.text}</p>
    </div>
  ) : null;

  return (
    <BaseGaugeDrawer
      open={open} onClose={onClose}
      title="Growth-Inflation Risk"
      desc="Stagflation z-score · (z_CPI − z_RealGrowth) / 2 · 3yr trailing averages"
      source="macro_debt_cycle_computed · avg3_real, avg3_cpi"
      latestGauge={latestGauge}
      range={range} setRange={setRange}
      loading={rows === null}
      renderChart={() => <StandardZScoreChart chartData={chartData} lineName="Stagflation z" />}
      gaugeHistory={gaugeHistory}
      gaugeKey="gauge3"
      infoContent={GROWTH_INFL_INFO}
      assessment={assessment}
      renderTable={() => (
        <div className="card p-4">
          <p className="label text-[10px] mb-3">Gauge Readings (actual)</p>
          <div className="grid text-[10px] text-paper-dim pb-1.5 mb-1.5 border-b border-ink-line pr-1" style={{ gridTemplateColumns: "1fr repeat(5, 60px)" }}>
            <span>Year</span>
            <span className="text-right">Real%</span>
            <span className="text-right">CPI%</span>
            <span className="text-right">Real z</span>
            <span className="text-right">CPI z</span>
            <span className="text-right">Composite</span>
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
            {tableRows.map((r) => (
              <div key={r.year} className="grid items-center text-xs" style={{ gridTemplateColumns: "1fr repeat(5, 60px)" }}>
                <span className="text-paper-dim">{r.year}</span>
                <span className="num text-right text-paper">
                  {r.real != null ? `${r.real >= 0 ? "+" : ""}${r.real.toFixed(2)}%` : "—"}
                </span>
                <span className="num text-right text-paper">
                  {r.cpi != null ? `${r.cpi.toFixed(2)}%` : "—"}
                </span>
                <span className="num text-right text-paper-dim">
                  {r.zReal != null ? `${r.zReal >= 0 ? "+" : ""}${r.zReal.toFixed(2)}` : "—"}
                </span>
                <span className="num text-right text-paper-dim">
                  {r.zCpi != null ? `${r.zCpi >= 0 ? "+" : ""}${r.zCpi.toFixed(2)}` : "—"}
                </span>
                <span className={`num text-right font-semibold ${r.composite == null ? "text-paper-dim" : r.composite > 1 ? "text-loss" : r.composite < -1 ? "text-gain" : "text-brass-soft"}`}>
                  {r.composite != null ? `${r.composite >= 0 ? "+" : ""}${r.composite.toFixed(2)}` : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    />
  );
}

// ─── Gauge 4: Income Affordability Risk ──────────────────────────────────────

const INCOME_AFFORD_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">What this measures</p>
      <p className="text-paper-dim">Income Affordability Risk measures whether total debt is growing faster than the income needed to service it. When debt growth consistently exceeds income growth, households, corporations, and government find themselves committing an ever-larger share of income to debt repayment rather than consumption and investment. This erosion of affordability — the gap between what is owed and what income is available to pay it — is a classic precursor to credit stress and is particularly sensitive to periods of rapid debt accumulation.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">How it's calculated</p>
      <p className="text-paper-dim">The gauge is the z-score of total debt growth year-over-year, measured against the full history available. A z-score above zero means debt is growing faster than its historical average rate; below zero means it is growing more slowly. This captures the flow of new debt creation, not just the stock. Rapid credit expansion — even from a moderate starting debt level — can quickly create affordability stress if it runs significantly above what income growth can absorb.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Why it matters</p>
      <p className="text-paper-dim">In Dalio's framework, the income affordability dimension transforms a high-but-stable debt burden into an active crisis. When households can no longer afford to service their debt obligations from current income, they are forced to cut spending, sell assets, or default. This simultaneous deleveraging across many borrowers produces the self-reinforcing contraction known as a deflationary debt spiral. The gauge is most dangerous when both elevated and rising — signaling that the rate of over-extension is accelerating, not merely persisting.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Thresholds</p>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2"><span className="text-loss font-mono w-16">&gt; +1.0</span><span className="text-paper-dim">Elevated Risk — debt growing well above norms relative to income</span></div>
        <div className="flex gap-2"><span className="text-brass-soft font-mono w-16">&gt; +0.25</span><span className="text-paper-dim">Watch — above-average debt growth, monitor for acceleration</span></div>
        <div className="flex gap-2"><span className="text-paper font-mono w-16">±0.25</span><span className="text-paper-dim">Neutral — debt growth near historical average</span></div>
        <div className="flex gap-2"><span className="text-gain font-mono w-16">&gt; −1.0</span><span className="text-paper-dim">Healthy — debt growth below average, improving affordability</span></div>
        <div className="flex gap-2"><span className="text-gain font-mono w-16">&lt; −1.0</span><span className="text-paper-dim">Very Favorable — debt growth well below average or declining</span></div>
      </div>
    </div>
  </div>
);

function incomeAffordAssessment(gauge4) {
  if (gauge4 == null) return null;
  if (gauge4 > 1.0) return {
    label: "Elevated Risk",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "Total debt is growing well above its historical average rate relative to income, indicating that borrowers are taking on obligations at a pace that significantly exceeds income growth. The affordability buffer is narrowing: debt service costs are consuming a growing share of income, leaving less for consumption and investment. Historically, sustained periods above this threshold have preceded credit market stress as borrowers reach their affordability limits simultaneously.",
  };
  if (gauge4 > 0.25) return {
    label: "Watch",
    color: "text-brass-soft", border: "border-brass/20", bg: "bg-brass/5",
    text: "Debt is growing modestly faster than its historical average, suggesting the economy is in a moderate credit expansion phase. While not at crisis levels, the rate of debt accumulation is running above the sustainable long-run pace. The key question is whether this is driven by productive investment — which generates future income to service the debt — or consumption-driven borrowing, which does not. Monitor the trend: if debt growth continues to accelerate while income growth remains flat, this reading will move into elevated risk territory.",
  };
  if (gauge4 > -0.25) return {
    label: "Neutral",
    color: "text-paper", border: "border-ink-line", bg: "bg-ink/40",
    text: "Debt growth is near its historical average rate, consistent with a normal credit cycle environment. Income and debt are expanding at comparable rates, maintaining a stable affordability ratio. This reading does not signal imminent stress or unusual opportunity — it reflects a balanced relationship between credit creation and income that is consistent with sustainable long-run growth.",
  };
  if (gauge4 > -1.0) return {
    label: "Healthy",
    color: "text-gain", border: "border-gain/20", bg: "bg-gain/5",
    text: "Debt growth is running below its historical average, meaning the rate of new debt creation is slower than typical. This is a healthy sign from an affordability perspective: existing debt is being paid down or rolled over without aggressive new addition, which gradually improves the ratio of debt to income. This environment is supportive of consumer balance sheet health and reduces the risk of a forced deleveraging cycle.",
  };
  return {
    label: "Very Favorable",
    color: "text-gain", border: "border-gain/20", bg: "bg-gain/5",
    text: "Debt growth is well below its historical average — or debt is actually declining. This reflects active deleveraging or extremely conservative borrowing behavior, which dramatically improves income affordability ratios. While sustained deleveraging can itself be a drag on near-term growth, it sets the foundation for a healthier balance sheet environment and is the most favorable affordability reading in Dalio's framework.",
  };
}

function IncomeAffordabilityDrawer({ open, onClose, latestGauge }) {
  const [rows, setRows] = useState(null);
  const [gaugeHistory, setGaugeHistory] = useState(null);
  const [incomeData, setIncomeData] = useState(null);
  const [range, setRange] = useState(1952);

  useEffect(() => {
    if (!open || rows !== null) return;
    Promise.all([
      supabase.from("macro_credit_cycle").select("year,total_debt_growth_yoy").order("year"),
      supabase.from("dalio_gauge_readings").select("year,gauge4,z_debt_growth_income").order("year"),
      supabase.from("macro_income").select("year,debt_service_pct").not("debt_service_pct", "is", null).order("year"),
    ]).then(([credit, gauge, income]) => {
      setRows(credit.data ?? []);
      setGaugeHistory(gauge.data ?? []);
      setIncomeData(income.data ?? []);
    });
  }, [open, rows]);

  const chartData = useMemo(() => buildZScoreData(rows, "total_debt_growth_yoy", range), [rows, range]);

  const tableRows = useMemo(() => {
    const creditMap = Object.fromEntries(
      (rows ?? []).filter((r) => r.total_debt_growth_yoy != null).map((r) => [r.year, Number(r.total_debt_growth_yoy)])
    );
    const gaugeMap = Object.fromEntries((gaugeHistory ?? []).map((r) => [r.year, r]));
    const debtSvcMap = Object.fromEntries((incomeData ?? []).map((r) => [r.year, Number(r.debt_service_pct)]));
    const allYears = [...new Set([
      ...(rows ?? []).map((r) => r.year),
      ...(gaugeHistory ?? []).map((r) => r.year),
    ])].sort((a, b) => b - a);
    return allYears
      .map((year) => {
        const debtGrowth = creditMap[year] ?? null;
        const prevDebtGrowth = creditMap[year - 1] ?? null;
        return {
          year,
          debtGrowth,
          netDelta: debtGrowth != null && prevDebtGrowth != null ? debtGrowth - prevDebtGrowth : null,
          debtSvc: debtSvcMap[year] ?? null,
          zDebtInc: gaugeMap[year]?.z_debt_growth_income != null ? Number(gaugeMap[year].z_debt_growth_income) : null,
          composite: gaugeMap[year]?.gauge4 != null ? Number(gaugeMap[year].gauge4) : null,
        };
      })
      .filter((r) => r.debtGrowth != null || r.zDebtInc != null || r.composite != null);
  }, [rows, gaugeHistory, incomeData]);

  const assessed = incomeAffordAssessment(latestGauge);
  const assessment = assessed ? (
    <div className={`card p-4 border ${assessed.border} ${assessed.bg}`}>
      <p className="label text-[10px] mb-2">Current Assessment</p>
      <p className={`text-xs font-semibold mb-2 ${assessed.color}`}>{assessed.label}</p>
      <p className="text-[11px] text-paper-dim leading-relaxed">{assessed.text}</p>
    </div>
  ) : null;

  return (
    <BaseGaugeDrawer
      open={open} onClose={onClose}
      title="Income Affordability Risk"
      desc="Total debt growth YoY z-score · high debt growth relative to history = elevated risk"
      source="macro_credit_cycle · total_debt_growth_yoy"
      latestGauge={latestGauge}
      range={range} setRange={setRange}
      loading={rows === null}
      renderChart={() => <StandardZScoreChart chartData={chartData} lineName="Debt Growth z" />}
      gaugeHistory={gaugeHistory}
      gaugeKey="gauge4"
      infoContent={INCOME_AFFORD_INFO}
      assessment={assessment}
      renderTable={() => (
        <div className="card p-4">
          <p className="label text-[10px] mb-3">Gauge Readings (actual)</p>
          <div className="grid text-[10px] text-paper-dim pb-1.5 mb-1.5 border-b border-ink-line pr-1" style={{ gridTemplateColumns: "1fr repeat(5, 62px)" }}>
            <span>Year</span>
            <span className="text-right">Debt Gth%</span>
            <span className="text-right">Net Δ</span>
            <span className="text-right">Debt Svc%</span>
            <span className="text-right">D/Inc z</span>
            <span className="text-right">Composite</span>
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
            {tableRows.map((r) => (
              <div key={r.year} className="grid items-center text-xs" style={{ gridTemplateColumns: "1fr repeat(5, 62px)" }}>
                <span className="text-paper-dim">{r.year}</span>
                <span className="num text-right text-paper">
                  {r.debtGrowth != null ? `${r.debtGrowth >= 0 ? "+" : ""}${r.debtGrowth.toFixed(2)}%` : "—"}
                </span>
                <span className={`num text-right ${r.netDelta == null ? "text-paper-dim" : r.netDelta > 0 ? "text-loss" : r.netDelta < 0 ? "text-gain" : "text-paper-dim"}`}>
                  {r.netDelta != null ? `${r.netDelta >= 0 ? "+" : ""}${r.netDelta.toFixed(2)}%` : "—"}
                </span>
                <span className={`num text-right ${r.debtSvc == null ? "text-paper-dim" : r.debtSvc >= 12 ? "text-loss" : r.debtSvc >= 10.5 ? "text-brass-soft" : "text-gain"}`}>
                  {r.debtSvc != null ? `${r.debtSvc.toFixed(1)}%` : "—"}
                </span>
                <span className="num text-right text-paper-dim">
                  {r.zDebtInc != null ? `${r.zDebtInc >= 0 ? "+" : ""}${r.zDebtInc.toFixed(2)}` : "—"}
                </span>
                <span className={`num text-right font-semibold ${r.composite == null ? "text-paper-dim" : r.composite > 1 ? "text-loss" : r.composite < -1 ? "text-gain" : "text-brass-soft"}`}>
                  {r.composite != null ? `${r.composite >= 0 ? "+" : ""}${r.composite.toFixed(2)}` : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    />
  );
}

// ─── Gauge 5: Reserve Confidence Risk ────────────────────────────────────────

const RESERVE_CONF_INFO = (
  <div className="space-y-4 text-[11px] leading-relaxed">
    <div>
      <p className="text-paper font-semibold mb-1">What this measures</p>
      <p className="text-paper-dim">Reserve Confidence Risk captures the degree to which global central banks and sovereign institutions are reducing their reliance on the US dollar as a reserve currency. It combines two signals: central bank net gold purchases (a direct substitution away from USD-denominated reserves) and US Treasury auction bid-to-cover ratios (which measure the appetite of the global investor base for US government debt). Together, these reflect the market's revealed confidence — or lack thereof — in the dominant reserve currency.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">How it's calculated</p>
      <p className="text-paper-dim">Two z-scores are computed: one for annual central bank net gold purchases (from the World Gold Council), and one for the Treasury auction bid-to-cover ratio. Gold purchases are scored directly — heavy buying is elevated risk, since it signals reserve diversification away from dollar assets. Bid-to-cover is scored inversely — declining demand for Treasury auctions signals reduced confidence in US debt. The two z-scores are averaged to form the composite gauge reading.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Why it matters</p>
      <p className="text-paper-dim">In Dalio's framework, the long-term debt cycle reaches its most dangerous inflection when the reserve currency's credibility is challenged. The United States can sustain an unusually high debt level precisely because the dollar's reserve status allows it to borrow in its own currency at low rates from global savers. If that privilege erodes — through excessive money printing, fiscal instability, or geopolitical fragmentation — foreign demand for US debt weakens, interest rates rise, and the ability to inflate or grow out of the debt burden is diminished. A rising reading on this gauge is one of the clearest signals of late-cycle reserve currency fragility.</p>
    </div>
    <div>
      <p className="text-paper font-semibold mb-1">Thresholds</p>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2"><span className="text-loss font-mono w-16">&gt; +1.5</span><span className="text-paper-dim">Critical — extreme gold accumulation and/or severe Treasury demand decline</span></div>
        <div className="flex gap-2"><span className="text-loss font-mono w-16">&gt; +1.0</span><span className="text-paper-dim">Elevated Risk — meaningful reserve diversification away from USD</span></div>
        <div className="flex gap-2"><span className="text-brass-soft font-mono w-16">&gt; +0.25</span><span className="text-paper-dim">Watch — early signals of reserve reallocation, trend to monitor</span></div>
        <div className="flex gap-2"><span className="text-paper font-mono w-16">±0.25</span><span className="text-paper-dim">Neutral — reserve confidence broadly intact</span></div>
        <div className="flex gap-2"><span className="text-gain font-mono w-16">&lt; −0.25</span><span className="text-paper-dim">Low Risk — strong demand for USD assets and Treasuries</span></div>
      </div>
    </div>
  </div>
);

function reserveConfAssessment(gauge5) {
  if (gauge5 == null) return null;
  if (gauge5 > 1.5) return {
    label: "Critical",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "Central bank gold accumulation is at or near historic extremes, and/or Treasury auction demand has deteriorated severely. This combination signals a meaningful breakdown in global confidence in the US dollar as a reserve asset. The structural foundation that enables US fiscal deficits to be financed at low rates is under genuine strain. Capital flows are rotating away from dollar-denominated assets — if sustained, this would pressure the dollar, raise long-term interest rates, and reduce the US government's ability to inflate away its debt burden.",
  };
  if (gauge5 > 1.0) return {
    label: "Elevated Risk",
    color: "text-loss", border: "border-loss/20", bg: "bg-loss/5",
    text: "Central banks are buying gold at above-average rates and/or Treasury auction bid-to-cover ratios are declining meaningfully. This signals an active, sustained shift in reserve allocation away from the dollar. The magnitude is not yet at historic extremes, but the signal is consistent and directional. In Dalio's framework, this is the phase where reserve currency credibility begins to slip — slowly at first, then quickly. The risk premium on US assets has not yet repriced sharply, but the underlying trend is concerning.",
  };
  if (gauge5 > 0.25) return {
    label: "Watch",
    color: "text-brass-soft", border: "border-brass/20", bg: "bg-brass/5",
    text: "Early signals of reserve reallocation are present — central bank gold buying is modestly above average and/or Treasury auction demand shows some softening. These signals are not severe enough to indicate a crisis of confidence, but they suggest that the marginal appetite for dollar assets among global central banks is declining. In the context of elevated US fiscal deficits and geopolitical fragmentation, this warrants monitoring for signs of acceleration.",
  };
  if (gauge5 > -0.25) return {
    label: "Neutral",
    color: "text-paper", border: "border-ink-line", bg: "bg-ink/40",
    text: "Central bank gold purchases and Treasury auction demand are near their historical averages, indicating that reserve confidence is broadly intact. There is no significant signal of reserve diversification away from the dollar at this level. Global demand for US Treasury debt is in line with historical norms, and the structural advantage of dollar reserve status is not under measurable pressure.",
  };
  return {
    label: "Low Risk",
    color: "text-gain", border: "border-gain/20", bg: "bg-gain/5",
    text: "Central bank gold purchases are below average and/or Treasury auction demand is strong, indicating elevated confidence in the US dollar as a reserve asset. Global savers are actively seeking dollar-denominated assets, which keeps long-term interest rates low and supports the US government's ability to finance its debt at favorable terms. Reserve currency privilege is being actively reinforced rather than eroded.",
  };
}

function ReserveConfidenceDrawer({ open, onClose, latestGauge }) {
  const [rows, setRows] = useState(null);
  const [gaugeHistory, setGaugeHistory] = useState(null);
  const [range, setRange] = useState(1952);

  useEffect(() => {
    if (!open || rows !== null) return;
    Promise.all([
      supabase.from("wgc_gold_purchases").select("year,tonnes").order("year"),
      supabase.from("dalio_gauge_readings").select("year,gauge5,z_cb_gold,z_bid_to_cover").order("year"),
    ]).then(([wgc, gauge]) => { setRows(wgc.data ?? []); setGaugeHistory(gauge.data ?? []); });
  }, [open, rows]);

  const chartData = useMemo(() => buildZScoreData(rows, "tonnes", range), [rows, range]);

  const tableRows = useMemo(() => {
    const wgcMap = Object.fromEntries(
      (rows ?? []).filter((r) => r.tonnes != null).map((r) => [r.year, Number(r.tonnes)])
    );
    const gaugeMap = Object.fromEntries((gaugeHistory ?? []).map((r) => [r.year, r]));
    const allYears = [...new Set([
      ...(rows ?? []).map((r) => r.year),
      ...(gaugeHistory ?? []).map((r) => r.year),
    ])].sort((a, b) => b - a);
    return allYears
      .map((year) => {
        const tonnes = wgcMap[year] ?? null;
        const prevTonnes = wgcMap[year - 1] ?? null;
        return {
          year,
          tonnes,
          netDelta: tonnes != null && prevTonnes != null ? tonnes - prevTonnes : null,
          zCbGold: gaugeMap[year]?.z_cb_gold != null ? Number(gaugeMap[year].z_cb_gold) : null,
          zBidCover: gaugeMap[year]?.z_bid_to_cover != null ? Number(gaugeMap[year].z_bid_to_cover) : null,
          composite: gaugeMap[year]?.gauge5 != null ? Number(gaugeMap[year].gauge5) : null,
        };
      })
      .filter((r) => r.tonnes != null || r.zCbGold != null || r.composite != null);
  }, [rows, gaugeHistory]);

  const assessed = reserveConfAssessment(latestGauge);
  const assessment = assessed ? (
    <div className={`card p-4 border ${assessed.border} ${assessed.bg}`}>
      <p className="label text-[10px] mb-2">Current Assessment</p>
      <p className={`text-xs font-semibold mb-2 ${assessed.color}`}>{assessed.label}</p>
      <p className="text-[11px] text-paper-dim leading-relaxed">{assessed.text}</p>
    </div>
  ) : null;

  return (
    <BaseGaugeDrawer
      open={open} onClose={onClose}
      title="Reserve Confidence Risk"
      desc="CB gold purchases z-score · heavy buying signals declining reserve confidence"
      source="wgc_gold_purchases · tonnes"
      latestGauge={latestGauge}
      range={range} setRange={setRange}
      loading={rows === null}
      renderChart={() => <StandardZScoreChart chartData={chartData} lineName="CB Gold z" />}
      gaugeHistory={gaugeHistory}
      gaugeKey="gauge5"
      infoContent={RESERVE_CONF_INFO}
      assessment={assessment}
      renderTable={() => (
        <div className="card p-4">
          <p className="label text-[10px] mb-3">Gauge Readings (actual)</p>
          <div className="grid text-[10px] text-paper-dim pb-1.5 mb-1.5 border-b border-ink-line pr-1" style={{ gridTemplateColumns: "1fr repeat(5, 60px)" }}>
            <span>Year</span>
            <span className="text-right">CB Gold(t)</span>
            <span className="text-right">Net Δ(t)</span>
            <span className="text-right">CB Gold z</span>
            <span className="text-right">Bid/Cov z</span>
            <span className="text-right">Composite</span>
          </div>
          <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
            {tableRows.map((r) => (
              <div key={r.year} className="grid items-center text-xs" style={{ gridTemplateColumns: "1fr repeat(5, 60px)" }}>
                <span className="text-paper-dim">{r.year}</span>
                <span className="num text-right text-paper">
                  {r.tonnes != null ? Math.round(r.tonnes).toLocaleString() : "—"}
                </span>
                <span className={`num text-right ${r.netDelta == null ? "text-paper-dim" : r.netDelta > 0 ? "text-loss" : r.netDelta < 0 ? "text-gain" : "text-paper-dim"}`}>
                  {r.netDelta != null ? `${r.netDelta >= 0 ? "+" : ""}${Math.round(r.netDelta).toLocaleString()}` : "—"}
                </span>
                <span className="num text-right text-paper-dim">
                  {r.zCbGold != null ? `${r.zCbGold >= 0 ? "+" : ""}${r.zCbGold.toFixed(2)}` : "—"}
                </span>
                <span className="num text-right text-paper-dim">
                  {r.zBidCover != null ? `${r.zBidCover >= 0 ? "+" : ""}${r.zBidCover.toFixed(2)}` : "—"}
                </span>
                <span className={`num text-right font-semibold ${r.composite == null ? "text-paper-dim" : r.composite > 1 ? "text-loss" : r.composite < -1 ? "text-gain" : "text-brass-soft"}`}>
                  {r.composite != null ? `${r.composite >= 0 ? "+" : ""}${r.composite.toFixed(2)}` : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    />
  );
}

// SVG speedometer gauge.
// Scale: z-score from -3 (low risk, green/left) to +3 (elevated risk, red/right).
// Zones: green ≤ -1, brass -1..+1, red ≥ +1.
function SpeedometerGauge({ value, label, desc, year, onClick, statusLabelOverride }) {
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
  const statusLabel = statusLabelOverride ?? (
    status === "elevated"
      ? "Elevated Risk"
      : status === "low"
      ? "Low Risk"
      : status === "neutral"
      ? "Neutral"
      : "—"
  );
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
  const [policyRoomOpen, setPolicyRoomOpen] = useState(false);
  const [growthInflOpen, setGrowthInflOpen] = useState(false);
  const [incomeAffordOpen, setIncomeAffordOpen] = useState(false);
  const [reserveConfOpen, setReserveConfOpen] = useState(false);
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
        {GAUGE_META.map(({ key, label, desc }) => {
          const val = latest[key]?.value ?? null;
          const statusLabelOverride =
            key === "gauge1" ? (debtSustAssessment(val)?.label ?? null)
          : key === "gauge2" ? (policyRoomAssessment(val, null)?.label ?? null)
          : key === "gauge3" ? (growthInflAssessment(val)?.label ?? null)
          : key === "gauge4" ? (incomeAffordAssessment(val)?.label ?? null)
          : key === "gauge5" ? (reserveConfAssessment(val)?.label ?? null)
          : null;
          return (
            <SpeedometerGauge
              key={key}
              value={val}
              year={latest[key]?.year}
              label={label}
              desc={desc}
              statusLabelOverride={statusLabelOverride}
              onClick={
                key === "gauge1" ? () => setDebtSustOpen(true)
              : key === "gauge2" ? () => setPolicyRoomOpen(true)
              : key === "gauge3" ? () => setGrowthInflOpen(true)
              : key === "gauge4" ? () => setIncomeAffordOpen(true)
              : key === "gauge5" ? () => setReserveConfOpen(true)
              : undefined
              }
            />
          );
        })}
      </div>
      <DebtSustainabilityDrawer
        open={debtSustOpen}
        onClose={() => setDebtSustOpen(false)}
        latestGauge={latest?.gauge1?.value ?? null}
        latestGaugeYear={latest?.gauge1?.year ?? null}
      />
      <PolicyRoomDrawer
        open={policyRoomOpen}
        onClose={() => setPolicyRoomOpen(false)}
        latestGauge={latest?.gauge2?.value ?? null}
      />
      <GrowthInflationDrawer
        open={growthInflOpen}
        onClose={() => setGrowthInflOpen(false)}
        latestGauge={latest?.gauge3?.value ?? null}
      />
      <IncomeAffordabilityDrawer
        open={incomeAffordOpen}
        onClose={() => setIncomeAffordOpen(false)}
        latestGauge={latest?.gauge4?.value ?? null}
      />
      <ReserveConfidenceDrawer
        open={reserveConfOpen}
        onClose={() => setReserveConfOpen(false)}
        latestGauge={latest?.gauge5?.value ?? null}
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
