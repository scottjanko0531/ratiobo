"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const CUR_YEAR = new Date().getFullYear();

// ── Asset return assumptions (nominal annual) ─────────────────────────────
const ASSET_PARAMS = {
  VTI:  { mu: 0.095, sigma: 0.160 }, IJS:  { mu: 0.100, sigma: 0.200 },
  GLD:  { mu: 0.070, sigma: 0.155 }, TLT:  { mu: 0.045, sigma: 0.140 },
  SHY:  { mu: 0.040, sigma: 0.025 }, DBC:  { mu: 0.050, sigma: 0.200 },
  DBMF: { mu: 0.085, sigma: 0.100 }, VXUS: { mu: 0.075, sigma: 0.170 },
  VWO:  { mu: 0.085, sigma: 0.230 }, SCHP: { mu: 0.042, sigma: 0.065 },
};

const PORTFOLIO_WEIGHTS = {
  standard_gb: { VTI:0.20, IJS:0.20, GLD:0.20, TLT:0.20, SHY:0.20 },
  hedged_gb:   { VTI:0.20, IJS:0.20, GLD:0.20, TLT:0.15, SHY:0.15, DBMF:0.10 },
  bw_modified: { VTI:0.20, VXUS:0.08, VWO:0.05, TLT:0.20, SCHP:0.20, DBC:0.12, GLD:0.12, SHY:0.03 },
};

const PORTFOLIO_LABELS = {
  standard_gb: "Standard GB",
  hedged_gb:   "Hedged GB (+DBMF)",
  bw_modified: "BW Modified",
};

const PORTFOLIO_BREAKDOWN = {
  standard_gb: "VTI 20% · IJS 20% · GLD 20% · TLT 20% · SHY 20%",
  hedged_gb:   "VTI 20% · IJS 20% · GLD 20% · TLT 15% · SHY 15% · DBMF 10%",
  bw_modified: "VTI 20% · VXUS 8% · VWO 5% · TLT 20% · SCHP 20% · DBC 12% · GLD 12% · SHY 3%",
};

const INCOME_TYPES = [
  { value: "employment",     label: "Employment" },
  { value: "social_security",label: "Social Security" },
  { value: "pension",        label: "Pension" },
  { value: "rental",         label: "Rental Income" },
  { value: "annuity",        label: "Annuity" },
  { value: "other",          label: "Other" },
];

const FILING_STATUSES = [
  { value: "married_jointly", label: "Married Filing Jointly" },
  { value: "single",          label: "Single" },
  { value: "married_separate",label: "Married Filing Separately" },
  { value: "head_of_household",label: "Head of Household" },
];

// ── Formatting helpers ───────────────────────────────────────────────────
const fmt$ = (n) => {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtPct = (n) => n == null ? "—" : `${(n * 100).toFixed(1)}%`;
const fmtPctRaw = (n) => n == null ? "—" : `${n.toFixed(1)}%`;

// ── Monte Carlo engine ───────────────────────────────────────────────────
function normalRandom() {
  const u1 = Math.random(), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
}

function getPortfolioParams(key) {
  const w = PORTFOLIO_WEIGHTS[key] ?? PORTFOLIO_WEIGHTS.bw_modified;
  const mu = Object.entries(w).reduce((s, [t, wt]) => s + wt * (ASSET_PARAMS[t]?.mu ?? 0.07), 0);
  const rawVol = Object.entries(w).reduce((s, [t, wt]) => s + wt * (ASSET_PARAMS[t]?.sigma ?? 0.12), 0);
  return { mu, sigma: rawVol * 0.65 }; // 35% diversification credit
}

function runMonteCarlo(profile, portfolioKey, nSims = 1000) {
  const { age, life_expectancy: lifeExp, income_streams: streams = [],
          monthly_expenses: monthlyExp = 0, taxable_assets: tax = 0,
          traditional_assets: trad = 0, roth_assets: roth = 0,
          inflation_rate: infl = 0.03 } = profile;

  const total = (Number(tax) + Number(trad) + Number(roth)) || 0;
  const years = Math.max(1, (Number(lifeExp) || 95) - (Number(age) || 50));
  const { mu, sigma } = getPortfolioParams(portfolioKey);
  const drift = Math.log(1 + mu) - 0.5 * sigma * sigma;

  // Year 1 net cash flow (positive = surplus added to portfolio, negative = withdrawal)
  const y1Income = (streams ?? []).reduce((s, st) => {
    const sy = Number(st.startYear) || CUR_YEAR;
    const ey = st.endYear ? Number(st.endYear) : Infinity;
    return (CUR_YEAR + 1) >= sy && (CUR_YEAR + 1) <= ey ? s + (Number(st.amountMonthly) || 0) * 12 : s;
  }, 0);
  const y1Expenses = Number(monthlyExp) * 12;
  const y1Net = y1Income - y1Expenses;
  const withdrawalRate = total > 0 && y1Net < 0 ? Math.abs(y1Net) / total : 0;

  // Build year-by-year net cash flow schedule (+ = contribution, - = withdrawal)
  const schedule = [];
  for (let y = 1; y <= years; y++) {
    const calYear = CUR_YEAR + y;
    const inflFactor = Math.pow(1 + Number(infl), y);
    const income = (streams ?? []).reduce((s, st) => {
      const sy = Number(st.startYear) || CUR_YEAR;
      const ey = st.endYear ? Number(st.endYear) : Infinity;
      return calYear >= sy && calYear <= ey ? s + (Number(st.amountMonthly) || 0) * 12 : s;
    }, 0);
    const expenses = Number(monthlyExp) * 12 * inflFactor;
    schedule.push(income - expenses);
  }

  // Simulate — surplus years contribute to portfolio; deficit years draw it down
  const paths = Array.from({ length: nSims }, () => [total]);
  for (let y = 0; y < years; y++) {
    const net = schedule[y];
    for (let s = 0; s < nSims; s++) {
      const prev = paths[s][y];
      const ret = Math.exp(drift + sigma * normalRandom()) - 1;
      const next = prev * (1 + ret) + net;
      paths[s].push(Math.max(0, next));
    }
  }

  const survivors = paths.filter(p => p[p.length - 1] > 0).length;

  // Percentile bands
  const bands = [];
  for (let y = 0; y <= years; y++) {
    const vals = paths.map(p => p[y]).sort((a, b) => a - b);
    const p = (pct) => vals[Math.max(0, Math.floor(pct * nSims / 100) - 1)] ?? 0;
    bands.push({ age: Number(age) + y, p5: p(5), p25: p(25), p50: p(50), p75: p(75), p95: p(95) });
  }

  return { probabilityOfSuccess: survivors / nSims, bands, withdrawalRate,
           medianFinal: bands[bands.length - 1].p50, totalPortfolio: total };
}

function getCashFlow(profile) {
  const { age, life_expectancy: lifeExp, income_streams: streams = [],
          monthly_expenses: monthlyExp = 0, inflation_rate: infl = 0.03 } = profile;
  const years = Math.min((lifeExp || 95) - (age || 50), 50); // cap display at 50 years
  const rows = [];
  for (let y = 0; y <= years; y++) {
    const calYear = CUR_YEAR + y;
    const inflFactor = Math.pow(1 + Number(infl), y);
    const income = (streams ?? []).reduce((s, st) => {
      const sy = Number(st.startYear) || CUR_YEAR;
      const ey = st.endYear ? Number(st.endYear) : Infinity;
      return calYear >= sy && calYear <= ey ? s + (Number(st.amountMonthly) || 0) * 12 : s;
    }, 0);
    const expenses = Number(monthlyExp) * 12 * inflFactor;
    rows.push({ age: Number(age) + y, income, expenses, gap: Math.max(0, expenses - income) });
  }
  return rows;
}

// ── SVG Chart: Monte Carlo fan ────────────────────────────────────────────
function FanChart({ bands }) {
  if (!bands?.length || bands.length < 2) return null;
  const W = 640, H = 220, PL = 64, PR = 16, PT = 12, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;

  const maxVal = Math.max(...bands.map(b => b.p95 || 0)) || 1;
  const minAge = bands[0].age, maxAge = bands[bands.length - 1].age;
  const ageRange = maxAge - minAge || 1;

  const xScale = (age) => ((age - minAge) / ageRange) * cW;
  const yScale = (v) => cH - (v / maxVal) * cH;

  const pathFor = (key) =>
    bands.map((b, i) => `${i === 0 ? "M" : "L"}${PL + xScale(b.age).toFixed(1)},${PT + yScale(b[key]).toFixed(1)}`).join(" ");

  const bandPath = (k1, k2) => {
    const fwd = bands.map(b => `${PL + xScale(b.age).toFixed(1)},${PT + yScale(b[k1]).toFixed(1)}`).join(" L ");
    const rev = [...bands].reverse().map(b => `${PL + xScale(b.age).toFixed(1)},${PT + yScale(b[k2]).toFixed(1)}`).join(" L ");
    return `M ${fwd} L ${rev} Z`;
  };

  // Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: maxVal * f, y: PT + yScale(maxVal * f) }));
  // X-axis ticks (every 5 years)
  const xTicks = bands.filter(b => b.age % 5 === 0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      {/* Grid lines */}
      {yTicks.map(({ y }) => (
        <line key={y} x1={PL} y1={y} x2={W - PR} y2={y} stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
      ))}

      {/* 5–95 band */}
      <path d={bandPath("p5", "p95")} fill="currentColor" fillOpacity="0.06" />
      {/* 25–75 band */}
      <path d={bandPath("p25", "p75")} fill="currentColor" fillOpacity="0.10" />
      {/* Median */}
      <path d={pathFor("p50")} fill="none" stroke="#C9A227" strokeWidth="2" strokeLinejoin="round" />

      {/* Y-axis labels */}
      {yTicks.map(({ v, y }) => (
        <text key={v} x={PL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.45">
          {fmt$(v)}
        </text>
      ))}

      {/* X-axis labels */}
      {xTicks.map(b => (
        <text key={b.age} x={PL + xScale(b.age)} y={H - 4} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.45">
          {b.age}
        </text>
      ))}

      {/* Legend */}
      <rect x={PL + 8} y={PT + 6} width={10} height={10} fill="currentColor" fillOpacity="0.06" />
      <text x={PL + 22} y={PT + 15} fontSize="9" fill="currentColor" fillOpacity="0.4">5–95th pct</text>
      <rect x={PL + 78} y={PT + 6} width={10} height={10} fill="currentColor" fillOpacity="0.10" />
      <text x={PL + 92} y={PT + 15} fontSize="9" fill="currentColor" fillOpacity="0.4">25–75th pct</text>
      <line x1={PL + 152} y1={PT + 11} x2={PL + 162} y2={PT + 11} stroke="#C9A227" strokeWidth="2" />
      <text x={PL + 166} y={PT + 15} fontSize="9" fill="currentColor" fillOpacity="0.4">Median</text>
    </svg>
  );
}

// ── SVG Chart: Cash flow bridge ───────────────────────────────────────────
function CashFlowChart({ rows }) {
  if (!rows?.length) return null;
  const W = 640, H = 180, PL = 64, PR = 16, PT = 12, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;

  const maxVal = Math.max(...rows.map(r => Math.max(r.income, r.expenses)), 1);
  const xStep = cW / (rows.length - 1 || 1);
  const yScale = (v) => cH - (v / maxVal) * cH;

  const linePath = (key, color) => {
    const d = rows.map((r, i) => `${i === 0 ? "M" : "L"}${(PL + i * xStep).toFixed(1)},${(PT + yScale(r[key])).toFixed(1)}`).join(" ");
    return <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />;
  };

  // Fill gap area between income and expenses
  const gapPath = (() => {
    const fwd = rows.map((r, i) => `${(PL + i * xStep).toFixed(1)},${(PT + yScale(r.income)).toFixed(1)}`).join(" L ");
    const rev = [...rows].reverse().map((r, i, arr) => {
      const origI = arr.length - 1 - i;
      return `${(PL + origI * xStep).toFixed(1)},${(PT + yScale(r.expenses)).toFixed(1)}`;
    }).join(" L ");
    return `M ${fwd} L ${rev} Z`;
  })();

  const yTicks = [0, 0.5, 1].map(f => ({ v: maxVal * f, y: PT + yScale(maxVal * f) }));
  const xTicks = rows.filter((r, i) => i % 5 === 0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      {yTicks.map(({ y }) => (
        <line key={y} x1={PL} y1={y} x2={W - PR} y2={y} stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
      ))}

      {/* Gap fill (withdrawal zone) */}
      <path d={gapPath} fill="#ef4444" fillOpacity="0.08" />

      {linePath("income", "#22c55e")}
      {linePath("expenses", "#ef4444")}

      {yTicks.map(({ v, y }) => (
        <text key={v} x={PL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.45">
          {fmt$(v)}
        </text>
      ))}
      {xTicks.map((r, i) => (
        <text key={r.age} x={PL + rows.indexOf(r) * xStep} y={H - 4} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.45">
          {r.age}
        </text>
      ))}

      {/* Legend */}
      <line x1={PL + 8} y1={PT + 11} x2={PL + 18} y2={PT + 11} stroke="#22c55e" strokeWidth="1.5" />
      <text x={PL + 22} y={PT + 15} fontSize="9" fill="currentColor" fillOpacity="0.4">Income</text>
      <line x1={PL + 62} y1={PT + 11} x2={PL + 72} y2={PT + 11} stroke="#ef4444" strokeWidth="1.5" />
      <text x={PL + 76} y={PT + 15} fontSize="9" fill="currentColor" fillOpacity="0.4">Expenses (infl-adj)</text>
      <text x={PL + 190} y={PT + 15} fontSize="9" fill="#ef4444" fillOpacity="0.6">▪ withdrawal zone</text>
    </svg>
  );
}

// ── Profile Drawer ─────────────────────────────────────────────────────────
function ProfileDrawer({ open, onClose, initial, onSave, portfolioTotal }) {
  const blank = {
    age: 50, spouse_age: "", life_expectancy: 95, is_retired: false, retirement_year: "",
    income_streams: [], monthly_expenses: 10000,
    taxable_assets: 0, traditional_assets: 0, roth_assets: 0,
    tax_bracket: 22, state_tax_rate: 0, filing_status: "married_jointly",
    inflation_rate: 3, chosen_portfolio: "bw_modified",
  };

  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      if (initial) {
        setForm({
          ...initial,
          tax_bracket: Math.round((initial.tax_bracket || 0.22) * 100),
          state_tax_rate: Math.round((initial.state_tax_rate || 0) * 100),
          inflation_rate: Math.round((initial.inflation_rate || 0.03) * 100),
          spouse_age: initial.spouse_age ?? "",
          retirement_year: initial.retirement_year ?? "",
        });
      } else {
        setForm(blank);
      }
    }
  }, [open, initial]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const addStream = () => set("income_streams", [
    ...(form.income_streams || []),
    { label: "", type: "employment", amountMonthly: 0, startYear: CUR_YEAR, endYear: "" },
  ]);

  const updateStream = (i, k, v) => {
    const s = [...(form.income_streams || [])];
    s[i] = { ...s[i], [k]: v };
    set("income_streams", s);
  };

  const removeStream = (i) => {
    const s = [...(form.income_streams || [])];
    s.splice(i, 1);
    set("income_streams", s);
  };

  const handleSave = async () => {
    setSaving(true);
    const payload = {
      ...form,
      age: Number(form.age),
      spouse_age: form.spouse_age ? Number(form.spouse_age) : null,
      life_expectancy: Number(form.life_expectancy),
      retirement_year: form.retirement_year ? Number(form.retirement_year) : null,
      monthly_expenses: Number(form.monthly_expenses),
      taxable_assets: Number(form.taxable_assets),
      traditional_assets: Number(form.traditional_assets),
      roth_assets: Number(form.roth_assets),
      tax_bracket: Number(form.tax_bracket) / 100,
      state_tax_rate: Number(form.state_tax_rate) / 100,
      inflation_rate: Number(form.inflation_rate) / 100,
      income_streams: (form.income_streams || []).map(s => ({
        ...s,
        amountMonthly: Number(s.amountMonthly),
        startYear: Number(s.startYear),
        endYear: s.endYear ? Number(s.endYear) : null,
      })),
    };
    await onSave(payload);
    setSaving(false);
    onClose();
  };

  const input = "w-full bg-ink border border-ink-line rounded px-2 py-1.5 text-xs text-paper focus:outline-none focus:border-brass/60 [color-scheme:dark]";
  const label = "text-[10px] text-paper-dim mb-0.5 block";

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-md bg-ink border-l border-ink-line flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-line shrink-0">
          <p className="font-medium text-sm">Planning Profile</p>
          <button onClick={onClose} className="text-paper-dim hover:text-paper text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-sm">
          {/* Personal */}
          <section>
            <p className="label text-[10px] uppercase tracking-wider mb-2">Personal</p>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Your Age</span>
                <input type="number" className={input} value={form.age} onChange={e => set("age", e.target.value)} /></div>
              <div><span className={label}>Spouse Age (opt)</span>
                <input type="number" className={input} value={form.spouse_age} placeholder="—" onChange={e => set("spouse_age", e.target.value)} /></div>
              <div><span className={label}>Life Expectancy Target</span>
                <input type="number" className={input} value={form.life_expectancy} onChange={e => set("life_expectancy", e.target.value)} /></div>
              <div><span className={label}>Filing Status</span>
                <select className={input} value={form.filing_status} onChange={e => set("filing_status", e.target.value)}>
                  {FILING_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select></div>
            </div>
          </section>

          {/* Retirement */}
          <section>
            <p className="label text-[10px] uppercase tracking-wider mb-2">Retirement</p>
            <div className="flex items-center gap-3 mb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={!!form.is_retired} onChange={e => set("is_retired", e.target.checked)}
                  className="accent-brass" />
                <span className="text-xs text-paper">Already retired</span>
              </label>
            </div>
            {!form.is_retired && (
              <div><span className={label}>Target Retirement Year</span>
                <input type="number" className={input} value={form.retirement_year} placeholder={CUR_YEAR + 5}
                  onChange={e => set("retirement_year", e.target.value)} /></div>
            )}
          </section>

          {/* Income Streams */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <p className="label text-[10px] uppercase tracking-wider">Income Streams</p>
              <button onClick={addStream} className="text-[10px] text-brass-soft hover:text-brass transition-colors">+ Add</button>
            </div>
            {!(form.income_streams?.length) && (
              <p className="text-xs text-paper-dim/50 italic">No income streams added</p>
            )}
            <div className="space-y-3">
              {(form.income_streams || []).map((st, i) => (
                <div key={i} className="rounded-lg border border-ink-line bg-ink-soft/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <select className="bg-transparent text-[10px] text-brass-soft border-0 outline-none cursor-pointer"
                      value={st.type} onChange={e => updateStream(i, "type", e.target.value)}>
                      {INCOME_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <button onClick={() => removeStream(i)} className="text-paper-dim hover:text-loss text-xs">×</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className={label}>Label</span>
                      <input className={input} value={st.label} placeholder="e.g. Social Security"
                        onChange={e => updateStream(i, "label", e.target.value)} /></div>
                    <div><span className={label}>Amount / Month</span>
                      <input type="number" className={input} value={st.amountMonthly}
                        onChange={e => updateStream(i, "amountMonthly", e.target.value)} /></div>
                    <div><span className={label}>Start Year</span>
                      <input type="number" className={input} value={st.startYear}
                        onChange={e => updateStream(i, "startYear", e.target.value)} /></div>
                    <div><span className={label}>End Year (blank = forever)</span>
                      <input type="number" className={input} value={st.endYear || ""} placeholder="—"
                        onChange={e => updateStream(i, "endYear", e.target.value)} /></div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Expenses */}
          <section>
            <p className="label text-[10px] uppercase tracking-wider mb-2">Living Expenses</p>
            <div><span className={label}>Monthly Expenses (today's $)</span>
              <input type="number" className={input} value={form.monthly_expenses}
                onChange={e => set("monthly_expenses", e.target.value)} /></div>
          </section>

          {/* Asset Breakdown */}
          <section>
            <div className="flex items-center justify-between mb-1">
              <p className="label text-[10px] uppercase tracking-wider">Assets by Account Type</p>
              {portfolioTotal > 0 && (
                <span className="text-[10px] text-paper-dim">Total in RatioBo: {fmt$(portfolioTotal)}</span>
              )}
            </div>
            <p className="text-[10px] text-paper-dim/60 mb-2">Used for tax optimization and withdrawal sequencing</p>
            <div className="space-y-2">
              <div><span className={label}>Taxable (brokerage, joint)</span>
                <input type="number" className={input} value={form.taxable_assets}
                  onChange={e => set("taxable_assets", e.target.value)} /></div>
              <div><span className={label}>Traditional IRA / 401k / 403b</span>
                <input type="number" className={input} value={form.traditional_assets}
                  onChange={e => set("traditional_assets", e.target.value)} /></div>
              <div><span className={label}>Roth IRA / Roth 401k</span>
                <input type="number" className={input} value={form.roth_assets}
                  onChange={e => set("roth_assets", e.target.value)} /></div>
            </div>
          </section>

          {/* Tax */}
          <section>
            <p className="label text-[10px] uppercase tracking-wider mb-2">Tax</p>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Federal Bracket (%)</span>
                <input type="number" className={input} value={form.tax_bracket} step="1" min="0" max="40"
                  onChange={e => set("tax_bracket", e.target.value)} /></div>
              <div><span className={label}>State Rate (%)</span>
                <input type="number" className={input} value={form.state_tax_rate} step="1" min="0" max="15"
                  onChange={e => set("state_tax_rate", e.target.value)} /></div>
            </div>
          </section>

          {/* Assumptions */}
          <section>
            <p className="label text-[10px] uppercase tracking-wider mb-2">Assumptions</p>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Inflation Rate (%)</span>
                <input type="number" className={input} value={form.inflation_rate} step="0.5" min="0" max="10"
                  onChange={e => set("inflation_rate", e.target.value)} /></div>
              <div><span className={label}>Portfolio</span>
                <select className={input} value={form.chosen_portfolio}
                  onChange={e => set("chosen_portfolio", e.target.value)}>
                  {Object.entries(PORTFOLIO_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></div>
            </div>
          </section>
        </div>

        <div className="px-5 py-4 border-t border-ink-line shrink-0">
          <button onClick={handleSave} disabled={saving}
            className="w-full py-2 rounded-lg bg-brass/20 border border-brass/40 text-brass-soft text-sm hover:bg-brass/30 transition-colors disabled:opacity-50">
            {saving ? "Saving…" : "Save Profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────
export default function PlanningPage() {
  const [profile, setProfile]       = useState(null);
  const [portfolioTotal, setPTotal] = useState(0);
  const [drawerOpen, setDrawer]     = useState(false);
  const [mcResults, setMC]          = useState(null);
  const [cashFlow, setCF]           = useState(null);
  const [aiPlan, setAIPlan]         = useState(null);
  const [aiLoading, setAILoading]   = useState(false);
  const [aiError, setAIError]       = useState(null);
  const [mcError, setMCError]       = useState(null);
  const [loading, setLoading]       = useState(true);
  const [userId, setUserId]         = useState(null);

  // Load user, profile, portfolio total
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);

      const [{ data: prof }, { data: holdings }] = await Promise.all([
        supabase.from("planning_profile").select("*").eq("user_id", user.id).single(),
        supabase.from("holdings_valued").select("current_value, asset_type")
          .in("asset_type", ["equity","etf","mutual_fund","crypto","metal","money_market","cd","bond"]),
      ]);

      if (prof) setProfile(prof);
      const total = (holdings ?? []).reduce((s, h) => s + Number(h.current_value || 0), 0);
      setPTotal(total);
      setLoading(false);
    })();
  }, []);

  // Re-run Monte Carlo when profile changes
  useEffect(() => {
    if (!profile) return;
    setMCError(null);
    try {
      const mc = runMonteCarlo(profile, profile.chosen_portfolio || "bw_modified");
      setMC(mc);
      setCF(getCashFlow(profile));
      setAIPlan(null);
    } catch (e) {
      console.error("[MC]", e);
      setMCError(String(e));
    }
  }, [profile]);

  const saveProfile = async (payload) => {
    const { error } = await supabase.from("planning_profile").upsert(
      { ...payload, user_id: userId, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    if (!error) setProfile({ ...payload, user_id: userId });
  };

  const generatePlan = async () => {
    if (!profile || !mcResults) return;
    setAILoading(true);
    setAIError(null);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/financial-plan`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SUPABASE_ANON}`,
          "apikey": SUPABASE_ANON,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile,
          mcResults,
          portfolioLabel: PORTFOLIO_LABELS[profile.chosen_portfolio || "bw_modified"],
          portfolioBreakdown: PORTFOLIO_BREAKDOWN[profile.chosen_portfolio || "bw_modified"],
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setAIPlan(json.plan);
    } catch (e) {
      setAIError(e.message);
    } finally {
      setAILoading(false);
    }
  };

  const successPct = mcResults ? Math.round(mcResults.probabilityOfSuccess * 100) : null;
  const successColor = successPct == null ? "text-paper-dim"
    : successPct >= 85 ? "text-gain" : successPct >= 70 ? "text-brass-soft" : "text-loss";

  const wrPct = mcResults ? (mcResults.withdrawalRate * 100) : null;
  const wrColor = wrPct == null ? "text-paper-dim"
    : wrPct <= 3 ? "text-gain" : wrPct <= 4.5 ? "text-brass-soft" : "text-loss";

  if (loading) return (
    <Shell>
      <div className="flex justify-center py-24">
        <span className="flex items-center gap-1.5">
          <span className="bead animate-pulse" /><span className="bead animate-pulse [animation-delay:150ms]" />
          <span className="bead animate-pulse [animation-delay:300ms]" />
        </span>
      </div>
    </Shell>
  );

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Financial Planning</h1>
          <p className="text-paper-dim text-sm mt-0.5">Retirement projections · Cash flow · Tax strategy</p>
        </div>
        <button onClick={() => setDrawer(true)}
          className="shrink-0 px-3 py-1.5 text-sm rounded-lg border border-ink-line hover:border-brass/60 text-paper-dim hover:text-paper transition-colors">
          {profile ? "Edit Profile" : "Set Up Profile"}
        </button>
      </div>

      {/* No profile yet */}
      {!profile && (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <p className="text-paper-dim text-sm max-w-xs">
            Enter your age, income sources, expenses, and asset breakdown to generate a personalized retirement plan.
          </p>
          <button onClick={() => setDrawer(true)}
            className="px-5 py-2.5 rounded-lg border border-brass/40 bg-brass/10 text-brass-soft text-sm hover:bg-brass/20 transition-colors">
            Get Started
          </button>
        </div>
      )}

      {/* Debug panel — remove once MC is confirmed working */}
      <div className="mb-4 px-3 py-2 rounded border border-ink-line text-[10px] font-mono text-paper-dim space-y-0.5">
        <div>profile: {profile ? `age=${profile.age} lifeExp=${profile.life_expectancy} tax=${profile.taxable_assets} trad=${profile.traditional_assets} roth=${profile.roth_assets} streams=${JSON.stringify(profile.income_streams?.length ?? "null")}` : "null"}</div>
        <div>mcResults: {mcResults ? `bands=${mcResults.bands?.length} p50_final=${mcResults.medianFinal?.toFixed(0)} success=${(mcResults.probabilityOfSuccess*100).toFixed(0)}%` : "null"}</div>
        <div>mcError: {mcError || "none"}</div>
      </div>

      {mcError && (
        <div className="px-3 py-2 rounded-lg border border-loss/30 bg-loss/10 text-xs text-loss mb-4">
          Simulation error: {mcError}
        </div>
      )}

      {profile && mcResults && (
        <div className="space-y-8">
          {/* Portfolio selector */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-paper-dim">Portfolio:</span>
            {Object.entries(PORTFOLIO_LABELS).map(([k, l]) => (
              <button key={k}
                onClick={() => saveProfile({ ...profile, chosen_portfolio: k })}
                className={`px-3 py-1 rounded-lg text-xs border transition-colors ${
                  (profile.chosen_portfolio || "bw_modified") === k
                    ? "border-brass/50 bg-brass/10 text-brass-soft"
                    : "border-ink-line text-paper-dim hover:border-brass/30"
                }`}>
                {l}
              </button>
            ))}
            <span className="text-[10px] text-paper-dim/50 font-mono">
              {PORTFOLIO_BREAKDOWN[profile.chosen_portfolio || "bw_modified"]}
            </span>
          </div>

          {/* Key metrics */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card p-4">
              <p className="label mb-1">Success Rate</p>
              <p className={`text-2xl font-semibold font-mono tabular-nums ${successColor}`}>
                {successPct}%
              </p>
              <p className="text-[10px] text-paper-dim mt-1">
                Probability portfolio outlasts age {profile.life_expectancy}
              </p>
            </div>
            <div className="card p-4">
              <p className="label mb-1">Withdrawal Rate</p>
              <p className={`text-2xl font-semibold font-mono tabular-nums ${wrColor}`}>
                {wrPct?.toFixed(2)}%
              </p>
              <p className="text-[10px] text-paper-dim mt-1">
                {wrPct <= 4 ? "≤ 4% — sustainable" : "> 4% — elevated risk"} · 4% rule threshold
              </p>
            </div>
            <div className="card p-4">
              <p className="label mb-1">Median at Age {profile.life_expectancy}</p>
              <p className="text-2xl font-semibold font-mono tabular-nums text-paper">
                {fmt$(mcResults.medianFinal)}
              </p>
              <p className="text-[10px] text-paper-dim mt-1">
                Starting from {fmt$(mcResults.totalPortfolio)}
              </p>
            </div>
          </div>

          {/* Cash Flow Bridge */}
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider">Cash Flow Bridge</h2>
              <span className="text-[10px] text-paper-dim/50">Income vs. inflation-adjusted expenses · by age</span>
            </div>
            <div className="rounded-lg border border-ink-line p-4">
              <CashFlowChart rows={cashFlow} />
              {cashFlow && (
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-paper-dim">
                  <span>Current income: <span className="text-gain font-mono">
                    {fmt$((profile.income_streams ?? []).reduce((s, st) => s + Number(st.amountMonthly || 0), 0) * 12)}/yr
                  </span></span>
                  <span>Current expenses: <span className="text-paper font-mono">
                    {fmt$(Number(profile.monthly_expenses || 0) * 12)}/yr
                  </span></span>
                  <span>Annual gap: <span className={`font-mono ${
                    cashFlow[0]?.gap > 0 ? "text-loss" : "text-gain"
                  }`}>{cashFlow[0]?.gap > 0 ? `-${fmt$(cashFlow[0].gap)}` : `+${fmt$(Math.abs(cashFlow[0]?.gap ?? 0))}`}/yr</span></span>
                </div>
              )}
            </div>
          </section>

          {/* Monte Carlo */}
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider">Monte Carlo — 1,000 Simulations</h2>
              <span className="text-[10px] text-paper-dim/50">Portfolio value by age</span>
            </div>
            <div className="rounded-lg border border-ink-line p-4">
              <FanChart bands={mcResults.bands} />
              <div className="mt-2 flex flex-wrap gap-4 text-[10px] text-paper-dim/60">
                <span>Return model: {PORTFOLIO_LABELS[profile.chosen_portfolio || "bw_modified"]}</span>
                <span>Inflation: {fmtPct(profile.inflation_rate)}/yr</span>
                <span>Annual rebalancing assumed</span>
              </div>
            </div>
          </section>

          {/* Income Streams Summary */}
          {(profile.income_streams?.length > 0) && (
            <section>
              <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider mb-3">Income Streams</h2>
              <div className="rounded-lg border border-ink-line overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-line bg-ink-soft/30">
                      <th className="text-left py-2 px-4 text-paper-dim font-medium text-xs">Source</th>
                      <th className="text-right py-2 px-4 text-paper-dim font-medium text-xs">Monthly</th>
                      <th className="text-right py-2 px-4 text-paper-dim font-medium text-xs">Annual</th>
                      <th className="text-right py-2 px-4 text-paper-dim font-medium text-xs">Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.income_streams.map((st, i) => (
                      <tr key={i} className="border-b border-ink-line/40 hover:bg-ink-soft/20">
                        <td className="py-2 px-4">
                          <span className="text-xs">{st.label || "—"}</span>
                          <span className="ml-2 text-[10px] text-paper-dim/50">{INCOME_TYPES.find(t => t.value === st.type)?.label}</span>
                        </td>
                        <td className="py-2 px-4 text-right font-mono text-xs">{fmt$(Number(st.amountMonthly))}</td>
                        <td className="py-2 px-4 text-right font-mono text-xs">{fmt$(Number(st.amountMonthly) * 12)}</td>
                        <td className="py-2 px-4 text-right text-xs text-paper-dim">
                          {st.startYear}{st.endYear ? ` – ${st.endYear}` : " →"}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-ink-soft/30">
                      <td className="py-2 px-4 text-xs text-paper-dim">Total (today)</td>
                      <td className="py-2 px-4 text-right font-mono text-xs text-paper">
                        {fmt$(profile.income_streams.reduce((s, st) => s + Number(st.amountMonthly || 0), 0))}
                      </td>
                      <td className="py-2 px-4 text-right font-mono text-xs text-paper">
                        {fmt$(profile.income_streams.reduce((s, st) => s + Number(st.amountMonthly || 0), 0) * 12)}
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Asset breakdown */}
          <section>
            <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider mb-3">Asset Breakdown</h2>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Taxable", val: profile.taxable_assets, note: "Draw 1st — LTCG rates, step-up basis" },
                { label: "Traditional IRA/401k", val: profile.traditional_assets, note: "Draw 2nd — ordinary income on withdrawal" },
                { label: "Roth", val: profile.roth_assets, note: "Draw last — tax-free growth, no RMDs" },
              ].map(({ label, val, note }) => {
                const total = (Number(profile.taxable_assets) + Number(profile.traditional_assets) + Number(profile.roth_assets)) || 1;
                return (
                  <div key={label} className="card p-4">
                    <p className="label mb-1">{label}</p>
                    <p className="text-lg font-semibold font-mono">{fmt$(Number(val))}</p>
                    <p className="text-[10px] text-paper-dim mt-1">{((Number(val) / total) * 100).toFixed(0)}% of total</p>
                    <p className="text-[10px] text-paper-dim/50 mt-1 leading-relaxed">{note}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* AI Plan */}
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium text-paper-dim uppercase tracking-wider">AI Financial Plan</h2>
              {!aiPlan && (
                <button onClick={generatePlan} disabled={aiLoading}
                  className="text-xs px-3 py-1.5 rounded-lg border border-brass/40 text-brass-soft hover:bg-brass/10 transition-colors disabled:opacity-50 flex items-center gap-2">
                  {aiLoading ? (
                    <>
                      <span className="bead animate-pulse w-1.5 h-1.5" />
                      <span>Analyzing…</span>
                    </>
                  ) : "Generate Plan"}
                </button>
              )}
              {aiPlan && (
                <button onClick={generatePlan} disabled={aiLoading}
                  className="text-[10px] text-paper-dim hover:text-paper transition-colors">
                  Regenerate
                </button>
              )}
            </div>

            {aiError && (
              <div className="px-3 py-2 rounded-lg border border-loss/30 bg-loss/10 text-xs text-loss mb-3">{aiError}</div>
            )}

            {!aiPlan && !aiLoading && (
              <div className="rounded-lg border border-ink-line/50 bg-ink-soft/20 px-4 py-8 text-center">
                <p className="text-xs text-paper-dim/60">Click "Generate Plan" to get a personalized analysis from Claude — allocation recommendation, tax optimization, withdrawal sequencing, and key risks.</p>
              </div>
            )}

            {aiPlan && (
              <div className="rounded-lg border border-ink-line bg-ink-soft/20 p-5">
                <div className="prose prose-sm prose-invert max-w-none text-xs leading-relaxed space-y-3">
                  {aiPlan.split("\n").map((line, i) => {
                    if (line.startsWith("### ")) return <h3 key={i} className="text-xs font-semibold text-brass-soft mt-4 mb-1">{line.slice(4)}</h3>;
                    if (line.startsWith("## "))  return <h2 key={i} className="text-sm font-semibold text-paper mt-5 mb-2">{line.slice(3)}</h2>;
                    if (line.startsWith("**") && line.endsWith("**")) return <p key={i} className="font-semibold text-paper">{line.slice(2, -2)}</p>;
                    if (line.startsWith("- ") || line.match(/^\d+\. /)) return <p key={i} className="text-paper-dim pl-3">• {line.replace(/^[-\d]+\.?\s+/, "")}</p>;
                    if (line.trim() === "") return <div key={i} className="h-1" />;
                    return <p key={i} className="text-paper-dim">{line}</p>;
                  })}
                </div>
                <p className="text-[10px] text-paper-dim/30 mt-4 pt-3 border-t border-ink-line/40">
                  Analysis by Claude · Quantitative projections only · Not licensed financial advice
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      <ProfileDrawer
        open={drawerOpen}
        onClose={() => setDrawer(false)}
        initial={profile}
        onSave={saveProfile}
        portfolioTotal={portfolioTotal}
      />
    </Shell>
  );
}
