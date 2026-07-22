"use client";
import { useEffect, useState, useCallback } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";
import { SIMULATOR_KEYS, resolveSimulatorKey } from "../../lib/simulatorKeys";

const usd = (v) => {
  if (v == null || isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtPct = (v, digits = 2) => {
  if (v == null || isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
};

const gainCls = (v) =>
  v == null ? "text-paper-dim" : Number(v) > 0 ? "text-gain" : Number(v) < 0 ? "text-loss" : "text-paper-dim";

export default function PortfoliosPage() {
  const [portfolios, setPortfolios]           = useState([]);
  const [phMap, setPhMap]                     = useState({}); // portfolio_id -> [holding_id]
  const [holdings, setHoldings]               = useState([]);
  const [accountMap, setAccountMap]           = useState({});
  const [snapMap, setSnapMap]                 = useState({});
  const [periodSnaps, setPeriodSnaps]         = useState({ month: {}, qtr: {}, year: {} });
  const [allTransactions, setAllTransactions] = useState([]);
  const [busy, setBusy]                       = useState(true);

  const [viewingPortfolio, setViewingPortfolio] = useState(null);
  const [editingPortfolio, setEditingPortfolio] = useState(null); // "new" | portfolio obj
  const [form, setForm]     = useState({ portfolio_name: "", description: "", strategy_detail: "" });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");

  // ── Data load ────────────────────────────────────────────────────────────────
  async function load() {
    setBusy(true);
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    const ds    = (d) => d.toISOString().slice(0, 10);
    const sub   = (d, n) => { const r = new Date(d); r.setDate(r.getDate() - n); return r; };
    const monthSnap = ds(sub(new Date(now.getFullYear(), now.getMonth(), 1), 1));
    const qtrSnap   = ds(sub(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1), 1));
    const yearSnap  = `${now.getFullYear() - 1}-12-31`;
    const toMap     = (rows) => { const m = {}; for (const r of rows ?? []) m[r.holding_id] = Number(r.market_value ?? 0); return m; };

    const [
      { data: pfData },
      { data: phData },
      { data: hvData },
      { data: acData },
      { data: snaps },
      { data: txns },
      { data: mo },
      { data: qtr },
      { data: yr },
    ] = await Promise.all([
      supabase.from("portfolios").select("*").order("portfolio_name"),
      supabase.from("portfolio_holdings").select("portfolio_id, holding_id"),
      supabase.from("holdings_valued").select("*"),
      supabase.from("accounts").select("id, name"),
      supabase.from("portfolio_snapshots").select("holding_id, market_value").eq("snapshot_date", today),
      supabase.from("transactions").select("holding_id, txn_type, txn_date, amount, is_reinvested"),
      supabase.rpc("snapshot_at", { snap_date: monthSnap }),
      supabase.rpc("snapshot_at", { snap_date: qtrSnap }),
      supabase.rpc("snapshot_at", { snap_date: yearSnap }),
    ]);

    setPortfolios(pfData ?? []);

    const pm = {};
    for (const ph of phData ?? []) {
      if (!pm[ph.portfolio_id]) pm[ph.portfolio_id] = [];
      pm[ph.portfolio_id].push(ph.holding_id);
    }
    setPhMap(pm);
    setHoldings(hvData ?? []);

    const am = {};
    for (const a of acData ?? []) am[a.id] = a.name;
    setAccountMap(am);

    const sm = {};
    for (const s of snaps ?? []) sm[s.holding_id] = Number(s.market_value ?? 0);
    setSnapMap(sm);

    setPeriodSnaps({ month: toMap(mo), qtr: toMap(qtr), year: toMap(yr) });
    setAllTransactions(txns ?? []);
    setBusy(false);
  }

  useEffect(() => { load(); }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const holdingsFor = useCallback((pfId) => {
    const ids = new Set(phMap[pfId] ?? []);
    return holdings.filter((h) => ids.has(h.id));
  }, [phMap, holdings]);

  function summary(pfId) {
    const hs = holdingsFor(pfId);
    if (hs.length === 0) return { totalValue: 0, costBasis: 0, totalGain: 0, returnPct: null, dayChg: null, monthChg: null, qtrChg: null, ytdChg: null, count: 0 };

    const totalValue = hs.reduce((s, h) => s + Number(h.current_value ?? 0), 0);
    const costBasis  = hs.reduce((s, h) => s + Number(h.cost_basis  ?? 0), 0);

    const hIds = new Set(hs.map((h) => h.id));
    let income = 0, reinvested = 0;
    for (const t of allTransactions) {
      if (!hIds.has(t.holding_id)) continue;
      const amt = Number(t.amount ?? 0);
      if ((t.txn_type === "dividend" || t.txn_type === "interest") && !t.is_reinvested) income += amt;
      if (t.txn_type === "fee") income -= amt;
      if (t.is_reinvested) reinvested += amt;
    }
    const netGain   = hs.reduce((s, h) => s + Number(h.net_gain ?? 0), 0);
    const totalGain = netGain + reinvested + income;
    const origCost  = costBasis - reinvested;
    const returnPct = origCost > 0 ? (totalGain / origCost) * 100 : null;

    const periodChg = (snap) => {
      let prev = 0, found = 0;
      for (const h of hs) { if (snap[h.id] != null) { prev += snap[h.id]; found++; } }
      return found > 0 ? totalValue - prev : null;
    };

    const dayChg = (() => {
      let prev = 0, found = 0;
      for (const h of hs) { if (snapMap[h.id] != null) { prev += snapMap[h.id]; found++; } }
      return found > 0 ? totalValue - prev : null;
    })();

    return {
      totalValue, costBasis, totalGain, returnPct, income, count: hs.length,
      dayChg, monthChg: periodChg(periodSnaps.month), qtrChg: periodChg(periodSnaps.qtr), ytdChg: periodChg(periodSnaps.year),
    };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  function openNew() {
    setForm({ portfolio_name: "", description: "", strategy_detail: "" });
    setFormError("");
    setEditingPortfolio("new");
  }

  function openEdit(pf) {
    setForm({ portfolio_name: pf.portfolio_name, description: pf.description ?? "", strategy_detail: pf.strategy_detail ?? "" });
    setFormError("");
    setEditingPortfolio(pf);
  }

  async function savePortfolio() {
    if (!form.portfolio_name.trim()) { setFormError("Name is required."); return; }
    setFormBusy(true); setFormError("");
    const { data: { user } } = await supabase.auth.getUser();
    const payload = {
      portfolio_name:  form.portfolio_name.trim(),
      description:     form.description.trim()     || null,
      strategy_detail: form.strategy_detail.trim() || null,
      updated_at:      new Date().toISOString(),
    };
    let error;
    if (editingPortfolio === "new") {
      ({ error } = await supabase.from("portfolios").insert({ ...payload, user_id: user.id }));
    } else {
      ({ error } = await supabase.from("portfolios").update(payload).eq("id", editingPortfolio.id));
      if (!error && viewingPortfolio?.id === editingPortfolio.id) {
        setViewingPortfolio((p) => ({ ...p, ...payload }));
      }
    }
    setFormBusy(false);
    if (error) { setFormError(error.message); return; }
    setEditingPortfolio(null);
    await load();
  }

  async function deletePortfolio(pf) {
    if (!confirm(`Delete "${pf.portfolio_name}"? Holdings will not be deleted.`)) return;
    await supabase.from("portfolios").delete().eq("id", pf.id);
    if (viewingPortfolio?.id === pf.id) setViewingPortfolio(null);
    load();
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Strategy Portfolios</h1>
            <p className="text-xs text-paper-dim mt-0.5">Group holdings into named strategies for focused tracking</p>
          </div>
          <button onClick={openNew} className="btn text-sm">+ New Portfolio</button>
        </div>

        {/* List */}
        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : portfolios.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-paper-dim text-sm mb-4">No portfolios yet.</p>
            <button onClick={openNew} className="btn text-sm">Create your first portfolio</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {portfolios.map((pf) => {
              const s = summary(pf.id);
              return (
                <button
                  key={pf.id}
                  onClick={() => setViewingPortfolio(pf)}
                  className="card p-4 text-left hover:border-brass/40 transition-colors w-full"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="font-semibold text-sm leading-tight">{pf.portfolio_name}</p>
                    <span className="label text-[10px] shrink-0 mt-0.5">{s.count} holdings</span>
                  </div>
                  {pf.description && (
                    <p className="text-xs text-paper-dim mb-3 line-clamp-2 leading-relaxed">{pf.description}</p>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3">
                    <div>
                      <p className="label text-[10px]">Total Value</p>
                      <p className="num text-sm font-medium">{s.count > 0 ? usd(s.totalValue) : "—"}</p>
                    </div>
                    <div>
                      <p className="label text-[10px]">Total Gain</p>
                      <p className={`num text-sm font-medium ${s.count > 0 ? gainCls(s.totalGain) : "text-paper-dim"}`}>
                        {s.count > 0 ? `${s.totalGain > 0 ? "+" : ""}${usd(s.totalGain)}` : "—"}
                      </p>
                    </div>
                    {s.dayChg != null && (
                      <div className="col-span-2">
                        <p className="label text-[10px]">Day Chg</p>
                        <p className={`num text-xs ${gainCls(s.dayChg)}`}>
                          {s.dayChg > 0 ? "+" : ""}{usd(s.dayChg)}
                        </p>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Detail drawer ──────────────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${viewingPortfolio ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${viewingPortfolio ? "opacity-100" : "opacity-0"}`}
          onClick={() => setViewingPortfolio(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-[1400px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${viewingPortfolio ? "translate-x-0" : "translate-x-full"}`}>
          {viewingPortfolio && (() => {
            const pf = viewingPortfolio;
            const hs = holdingsFor(pf.id);
            const s  = summary(pf.id);

            const periodPct = (chg) => {
              if (chg == null) return null;
              const base = s.totalValue - chg;
              return base > 0 ? (chg / base) * 100 : null;
            };

            return (
              <>
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-4 border-b border-ink-line">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="font-semibold text-base">{pf.portfolio_name}</p>
                    {pf.description && <p className="text-xs text-paper-dim mt-0.5">{pf.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => openEdit(pf)} className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors">Edit</button>
                    <button onClick={() => setViewingPortfolio(null)} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
                  </div>
                </div>

                {/* Strategy detail */}
                {pf.strategy_detail && (
                  <div className="px-5 py-3 border-b border-ink-line bg-ink/30">
                    <p className="label text-[10px] mb-1">Strategy</p>
                    <p className="text-xs text-paper-dim leading-relaxed whitespace-pre-wrap">{pf.strategy_detail}</p>
                  </div>
                )}

                {/* Summary metrics */}
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-px border-b border-ink-line">
                  {[
                    { label: "Total Value", val: usd(s.totalValue), cls: "" },
                    { label: "Cost Basis",  val: usd(s.costBasis),  cls: "" },
                    { label: "Total Gain",  val: `${s.totalGain > 0 ? "+" : ""}${usd(s.totalGain)}`, cls: gainCls(s.totalGain) },
                    { label: "Return",      val: fmtPct(s.returnPct), cls: gainCls(s.returnPct) },
                  ].map(({ label, val, cls }) => (
                    <div key={label} className="px-3 py-3">
                      <p className="text-[10px] uppercase tracking-wide text-paper-dim mb-0.5">{label}</p>
                      <p className={`num text-sm font-medium ${cls}`}>{val}</p>
                    </div>
                  ))}
                  {[
                    { label: "Day Chg",  chg: s.dayChg },
                    { label: "Mo Chg",   chg: s.monthChg },
                    { label: "Qtr Chg",  chg: s.qtrChg },
                    { label: "YTD Chg",  chg: s.ytdChg },
                  ].map(({ label, chg }) => (
                    <div key={label} className="px-3 py-3">
                      <p className="text-[10px] uppercase tracking-wide text-paper-dim mb-0.5">{label}</p>
                      <p className={`num text-sm font-medium ${gainCls(chg)}`}>
                        {chg == null ? "—" : `${chg > 0 ? "+" : ""}${usd(chg)}`}
                      </p>
                      {chg != null && periodPct(chg) != null && (
                        <p className={`num text-[10px] ${gainCls(chg)}`}>{fmtPct(periodPct(chg))}</p>
                      )}
                    </div>
                  ))}
                </div>

                {/* Holdings grouped by simulator bucket */}
                <div className="px-5 py-4">
                  <p className="label mb-3">Holdings ({hs.length})</p>
                  {hs.length === 0 ? (
                    <div className="card p-6 text-center">
                      <p className="text-paper-dim text-sm">No holdings assigned yet.</p>
                      <p className="text-xs text-paper-dim mt-1">Open a holding from the Holdings page and assign it to this portfolio.</p>
                    </div>
                  ) : (() => {
                    // Group by BW simulator bucket in canonical order
                    const byKey = {};
                    for (const h of hs) {
                      const key = resolveSimulatorKey(h) ?? "unassigned";
                      if (!byKey[key]) byKey[key] = [];
                      byKey[key].push(h);
                    }
                    const groups = [
                      ...SIMULATOR_KEYS.map(({ key, label }) => ({ key, label, items: byKey[key] ?? [] })).filter(g => g.items.length > 0),
                      ...(byKey.unassigned?.length ? [{ key: "unassigned", label: "Unassigned", items: byKey.unassigned }] : []),
                    ];

                    // Total gain per holding = cap gain + dividends + interest - fees
                    const holdingTotalGain = (h) =>
                      Number(h.net_gain ?? 0) + Number(h.total_dividends ?? 0) + Number(h.total_interest ?? 0) - Number(h.total_fees ?? 0);
                    const holdingReturnPct = (h) => {
                      const cb = Number(h.cost_basis ?? 0);
                      return cb > 0 ? (holdingTotalGain(h) / cb) * 100 : null;
                    };

                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-ink-line">
                              <th className="label text-left font-medium py-2 pr-3">Symbol</th>
                              <th className="label text-left font-medium py-2 pr-3">Account</th>
                              <th className="label text-right font-medium py-2 pr-2">Value</th>
                              <th className="label text-right font-medium py-2 pr-2">Cost Basis</th>
                              <th className="label text-right font-medium py-2 pr-2">Total Gain</th>
                              <th className="label text-right font-medium py-2 pr-2">Return %</th>
                              <th className="label text-right font-medium py-2">Day Chg</th>
                            </tr>
                          </thead>
                          <tbody>
                            {groups.map(({ key, label, items }) => {
                              const groupValue     = items.reduce((sum, h) => sum + Number(h.current_value ?? 0), 0);
                              const groupCost      = items.reduce((sum, h) => sum + Number(h.cost_basis ?? 0), 0);
                              const groupPct       = s.totalValue > 0 ? (groupValue / s.totalValue) * 100 : 0;
                              const groupTotalGain = items.reduce((sum, h) => sum + holdingTotalGain(h), 0);
                              const groupReturnPct = groupCost > 0 ? (groupTotalGain / groupCost) * 100 : null;
                              return [
                                /* Group header row */
                                <tr key={`g-${key}`} className="bg-ink/40 border-y border-ink-line">
                                  <td colSpan={2} className="py-1.5 pr-3">
                                    <div className="flex items-center gap-2.5">
                                      <span className="label text-[11px] font-semibold text-brass-soft">{label}</span>
                                      <div className="flex-1 max-w-[100px] h-1.5 bg-ink-line rounded-full overflow-hidden">
                                        <div className="h-full bg-brass/60 rounded-full" style={{ width: `${Math.min(groupPct, 100)}%` }} />
                                      </div>
                                      <span className="num text-[11px] font-semibold text-paper">{groupPct.toFixed(1)}%</span>
                                      <span className="label text-[10px] text-paper-dim">{items.length} holding{items.length !== 1 ? "s" : ""}</span>
                                    </div>
                                  </td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] font-semibold">{usd(groupValue)}</td>
                                  <td className="num text-right py-1.5 pr-2 text-[11px] text-paper-dim">{usd(groupCost)}</td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupTotalGain)}`}>
                                    {groupTotalGain > 0 ? "+" : ""}{usd(groupTotalGain)}
                                  </td>
                                  <td className={`num text-right py-1.5 pr-2 text-[11px] font-semibold ${gainCls(groupReturnPct)}`}>
                                    {fmtPct(groupReturnPct)}
                                  </td>
                                  <td className="py-1.5" />
                                </tr>,
                                /* Holding rows */
                                ...items.map((h) => {
                                  const dayChg   = snapMap[h.id] != null ? Number(h.current_value ?? 0) - snapMap[h.id] : null;
                                  const tGain    = holdingTotalGain(h);
                                  const retPct   = holdingReturnPct(h);
                                  return (
                                    <tr key={h.id} className="border-b border-ink-line/40 last:border-0 hover:bg-ink-soft/40 transition-colors">
                                      <td className="py-2 pr-3 pl-3">
                                        <span className="font-medium">{h.symbol}</span>
                                        {h.name && <span className="block text-[10px] text-paper-dim leading-tight">{h.name}</span>}
                                      </td>
                                      <td className="py-2 pr-3 pl-3 text-paper-dim">{h.account_id ? (accountMap[h.account_id] ?? "—") : "—"}</td>
                                      <td className="num text-right py-2 pr-2">{usd(h.current_value)}</td>
                                      <td className="num text-right py-2 pr-2 text-paper-dim">{usd(h.cost_basis)}</td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(tGain)}`}>{tGain > 0 ? "+" : ""}{usd(tGain)}</td>
                                      <td className={`num text-right py-2 pr-2 ${gainCls(retPct)}`}>{fmtPct(retPct)}</td>
                                      <td className={`num text-right py-2 ${gainCls(dayChg)}`}>
                                        {dayChg == null ? "—" : `${dayChg > 0 ? "+" : ""}${usd(dayChg)}`}
                                      </td>
                                    </tr>
                                  );
                                }),
                              ];
                            })}
                          </tbody>
                          <tfoot className="border-t-2 border-ink-line">
                            <tr>
                              <td colSpan={2} className="py-2 label text-[10px]">Total ({hs.length} holdings)</td>
                              <td className="num text-right py-2 pr-2 font-medium">{usd(s.totalValue)}</td>
                              <td className="num text-right py-2 pr-2 text-paper-dim">{usd(s.costBasis)}</td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.totalGain)}`}>
                                {s.totalGain > 0 ? "+" : ""}{usd(s.totalGain)}
                              </td>
                              <td className={`num text-right py-2 pr-2 font-medium ${gainCls(s.returnPct)}`}>
                                {fmtPct(s.returnPct)}
                              </td>
                              <td className={`num text-right py-2 font-medium ${gainCls(s.dayChg)}`}>
                                {s.dayChg == null ? "—" : `${s.dayChg > 0 ? "+" : ""}${usd(s.dayChg)}`}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* ── Create / Edit drawer ───────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-40 ${editingPortfolio ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingPortfolio ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingPortfolio(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${editingPortfolio ? "translate-x-0" : "translate-x-full"}`}>
          {editingPortfolio && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">{editingPortfolio === "new" ? "New portfolio" : "Edit portfolio"}</p>
                <button onClick={() => setEditingPortfolio(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>

              <div>
                <label className="label block mb-1.5">Portfolio name</label>
                <input
                  className="field"
                  placeholder="e.g. Dalio All Weather"
                  value={form.portfolio_name}
                  onChange={(e) => setForm((f) => ({ ...f, portfolio_name: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Description</label>
                <input
                  className="field"
                  placeholder="Short one-line summary"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Strategy detail</label>
                <textarea
                  className="field min-h-[140px] resize-y"
                  placeholder="Describe the investment thesis, allocation rules, or target weights…"
                  value={form.strategy_detail}
                  onChange={(e) => setForm((f) => ({ ...f, strategy_detail: e.target.value }))}
                />
              </div>

              {formError && <p className="text-loss text-sm">{formError}</p>}

              <button className="btn w-full" onClick={savePortfolio} disabled={formBusy}>
                {formBusy ? "Saving…" : editingPortfolio === "new" ? "Create portfolio" : "Save changes"}
              </button>

              {editingPortfolio !== "new" && (
                <button
                  className="w-full px-3 py-2 text-sm rounded-lg text-paper-dim hover:text-loss border border-ink-line hover:border-loss/40 transition-colors"
                  onClick={() => { setEditingPortfolio(null); deletePortfolio(editingPortfolio); }}
                >
                  Delete portfolio
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
