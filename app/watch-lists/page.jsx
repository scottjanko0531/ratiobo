"use client";
import { useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { supabase } from "../../lib/supabase";
import WatchListItemDrawer from "../../components/WatchListItemDrawer";
import WatchAnalysisPanel from "../../components/WatchAnalysisPanel";

const usd = (v, digits = 2) => {
  if (v == null || isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const gainCls = (v) =>
  v == null ? "text-paper-dim" : Number(v) > 0 ? "text-gain" : Number(v) < 0 ? "text-loss" : "text-paper-dim";

const BLANK_ITEM_FORM = { symbol: "", name: "", asset_type: "", buy_price: "", sell_price: "", notes: "" };

export default function WatchListsPage() {
  const [watchLists, setWatchLists] = useState([]);
  const [itemsMap, setItemsMap]     = useState({}); // watch_list_id -> [items]
  const [marketMap, setMarketMap]   = useState({}); // "symbol|asset_type" -> market_data row
  const [assetTypes, setAssetTypes] = useState([]);
  const [busy, setBusy]             = useState(true);

  const [viewingList, setViewingList]   = useState(null);
  const [editingList, setEditingList]   = useState(null); // "new" | watch_list row
  const [form, setForm]                 = useState({ name: "", description: "" });
  const [formBusy, setFormBusy]         = useState(false);
  const [formError, setFormError]       = useState("");

  const [editingItem, setEditingItem]   = useState(null); // "new" | item row
  const [itemForm, setItemForm]         = useState(BLANK_ITEM_FORM);
  const [itemFormBusy, setItemFormBusy] = useState(false);
  const [itemFormError, setItemFormError] = useState("");
  const [symbolLookupBusy, setSymbolLookupBusy] = useState(false);

  const [detailItem, setDetailItem] = useState(null);

  const [analysis, setAnalysis]         = useState(null); // { scope, title, content, generated_at } | null
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisReq, setAnalysisReq]   = useState(null); // last { scope, watch_list_id, watch_list_item_id, title } for regenerate

  async function load() {
    setBusy(true);
    const [{ data: wlData }, { data: wiData }, { data: mdData }, { data: atData }] = await Promise.all([
      supabase.from("watch_lists").select("*").order("name"),
      supabase.from("watch_list_items").select("*").order("added_at", { ascending: false }),
      supabase.from("market_data").select("symbol, asset_type, price, change_24h_pct, dividend_yield, fetched_at"),
      supabase.from("asset_types").select("code, label").eq("is_active", true).order("sort_order"),
    ]);
    setWatchLists(wlData ?? []);
    const im = {};
    for (const item of wiData ?? []) {
      if (!im[item.watch_list_id]) im[item.watch_list_id] = [];
      im[item.watch_list_id].push(item);
    }
    setItemsMap(im);
    const mm = {};
    for (const r of mdData ?? []) mm[`${r.symbol}|${r.asset_type}`] = r;
    setMarketMap(mm);
    setAssetTypes(atData ?? []);
    setBusy(false);
  }

  useEffect(() => { load(); }, []);

  const itemsFor = (listId) => itemsMap[listId] ?? [];
  const priceFor = (item) => marketMap[`${item.symbol}|${item.asset_type}`] ?? null;
  const isBuyHit  = (item, mkt) => item.buy_price != null && mkt?.price != null && mkt.price <= Number(item.buy_price);
  const isSellHit = (item, mkt) => item.sell_price != null && mkt?.price != null && mkt.price >= Number(item.sell_price);

  function signalCounts(listId) {
    let buy = 0, sell = 0;
    for (const item of itemsFor(listId)) {
      const mkt = priceFor(item);
      if (isBuyHit(item, mkt)) buy++;
      if (isSellHit(item, mkt)) sell++;
    }
    return { buy, sell };
  }

  // ── Watch list CRUD ──────────────────────────────────────────────────────────
  function openNewList() {
    setForm({ name: "", description: "" });
    setFormError("");
    setEditingList("new");
  }

  function openEditList(wl) {
    setForm({ name: wl.name, description: wl.description ?? "" });
    setFormError("");
    setEditingList(wl);
  }

  async function saveList() {
    if (!form.name.trim()) { setFormError("Name is required."); return; }
    setFormBusy(true); setFormError("");
    const { data: { user } } = await supabase.auth.getUser();
    const payload = { name: form.name.trim(), description: form.description.trim() || null, updated_at: new Date().toISOString() };
    let error;
    if (editingList === "new") {
      ({ error } = await supabase.from("watch_lists").insert({ ...payload, user_id: user.id }));
    } else {
      ({ error } = await supabase.from("watch_lists").update(payload).eq("id", editingList.id));
      if (!error && viewingList?.id === editingList.id) setViewingList((l) => ({ ...l, ...payload }));
    }
    setFormBusy(false);
    if (error) { setFormError(error.message); return; }
    setEditingList(null);
    await load();
  }

  async function deleteList(wl) {
    const count = itemsFor(wl.id).length;
    if (!confirm(`Delete "${wl.name}"?${count ? ` This removes all ${count} item${count !== 1 ? "s" : ""} in it.` : ""}`)) return;
    await supabase.from("watch_lists").delete().eq("id", wl.id);
    if (viewingList?.id === wl.id) setViewingList(null);
    load();
  }

  // ── Watch list item CRUD ─────────────────────────────────────────────────────
  function openAddItem() {
    setItemForm(BLANK_ITEM_FORM);
    setItemFormError("");
    setEditingItem("new");
  }

  function openEditItem(item) {
    setItemForm({
      symbol: item.symbol, name: item.name ?? "", asset_type: item.asset_type,
      buy_price: item.buy_price ?? "", sell_price: item.sell_price ?? "", notes: item.notes ?? "",
    });
    setItemFormError("");
    setEditingItem(item);
    setDetailItem(null);
  }

  async function lookupItemSymbol(symbol) {
    if (!symbol.trim()) return;
    setSymbolLookupBusy(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/lookup-symbol?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`);
      if (res.ok) {
        const data = await res.json();
        if (!data.error) {
          setItemForm((prev) => ({ ...prev, name: prev.name || data.name || "", asset_type: prev.asset_type || data.asset_type || "" }));
        }
      }
    } catch (_) { /* autofill is best-effort */ }
    setSymbolLookupBusy(false);
  }

  async function fetchSymbolSummary(symbol, name, asset_type) {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/get-symbol-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, name, asset_type }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.summary ?? null;
    } catch (_) { return null; } // summary is best-effort, never blocks saving
  }

  async function saveItem() {
    if (!itemForm.symbol.trim()) { setItemFormError("Symbol is required."); return; }
    if (!itemForm.asset_type) { setItemFormError("Asset type is required."); return; }
    setItemFormBusy(true); setItemFormError("");
    const symbol = itemForm.symbol.trim().toUpperCase();
    const name = itemForm.name.trim() || null;
    const payload = {
      watch_list_id: viewingList.id,
      symbol,
      name,
      asset_type: itemForm.asset_type,
      buy_price: itemForm.buy_price === "" ? null : Number(itemForm.buy_price),
      sell_price: itemForm.sell_price === "" ? null : Number(itemForm.sell_price),
      notes: itemForm.notes.trim() || null,
    };
    // Only generate a fresh summary for newly added symbols; edits leave the existing one alone.
    if (editingItem === "new") {
      payload.summary = await fetchSymbolSummary(symbol, name, itemForm.asset_type);
    }
    let error;
    if (editingItem === "new") {
      ({ error } = await supabase.from("watch_list_items").insert(payload));
    } else {
      ({ error } = await supabase.from("watch_list_items").update(payload).eq("id", editingItem.id));
    }
    setItemFormBusy(false);
    if (error) { setItemFormError(error.message); return; }
    setEditingItem(null);
    await load();
    // Kick a sync so a brand-new symbol's price shows up without waiting for the 15-min cron.
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/sync-market-data`, { method: "POST" }).catch(() => {});
  }

  async function regenerateSummary(item) {
    setItemFormBusy(true);
    const summary = await fetchSymbolSummary(item.symbol, item.name, item.asset_type);
    await supabase.from("watch_list_items").update({ summary }).eq("id", item.id);
    setItemFormBusy(false);
    await load();
  }

  async function runAnalysis(req) {
    setAnalysisReq(req);
    setAnalysisBusy(true);
    setAnalysisError("");
    setAnalysis((prev) => (prev && prev.title === req.title ? prev : { title: req.title, content: null, generated_at: null }));
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/analyze-watch-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: req.scope,
          watch_list_id: req.watch_list_id,
          watch_list_item_id: req.watch_list_item_id,
          force: req.force ?? false,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setAnalysisError(data.error || "Analysis generation failed.");
      } else {
        setAnalysis({ title: req.title, content: data.content, generated_at: data.generated_at });
      }
    } catch (_) {
      setAnalysisError("Analysis generation failed.");
    }
    setAnalysisBusy(false);
  }

  function analyzeGroup(wl) {
    setDetailItem(null);
    runAnalysis({ scope: "group", watch_list_id: wl.id, title: `${wl.name} — Comparative Analysis` });
  }

  function analyzeItem(item) {
    setDetailItem(null);
    runAnalysis({ scope: "item", watch_list_id: item.watch_list_id, watch_list_item_id: item.id, title: `${item.symbol} — Research Note` });
  }

  async function deleteItem(item) {
    if (!confirm(`Remove ${item.symbol} from this watch list?`)) return;
    await supabase.from("watch_list_items").delete().eq("id", item.id);
    setDetailItem(null);
    load();
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Shell>
      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Watch Lists</h1>
            <p className="text-xs text-paper-dim mt-0.5">Track securities you don't own yet, with buy/sell target prices</p>
          </div>
          <button onClick={openNewList} className="btn text-sm">+ New Watch List</button>
        </div>

        {/* List */}
        {busy ? (
          <p className="text-paper-dim text-sm">Loading…</p>
        ) : watchLists.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-paper-dim text-sm mb-4">No watch lists yet.</p>
            <button onClick={openNewList} className="btn text-sm">Create your first watch list</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {watchLists.map((wl) => {
              const items = itemsFor(wl.id);
              const { buy, sell } = signalCounts(wl.id);
              return (
                <button
                  key={wl.id}
                  onClick={() => setViewingList(wl)}
                  className="card p-4 text-left hover:border-brass/40 transition-colors w-full"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="font-semibold text-sm leading-tight">{wl.name}</p>
                    <span className="label text-[10px] shrink-0 mt-0.5">{items.length} item{items.length !== 1 ? "s" : ""}</span>
                  </div>
                  {wl.description && (
                    <p className="text-xs text-paper-dim mb-3 line-clamp-2 leading-relaxed">{wl.description}</p>
                  )}
                  {(buy > 0 || sell > 0) && (
                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-ink-line">
                      {buy > 0 && <span className="text-xs text-gain font-medium">{buy} at buy target</span>}
                      {sell > 0 && <span className="text-xs text-loss font-medium">{sell} at sell target</span>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Watch list detail drawer ───────────────────────────────────────── */}
      <div className={`fixed inset-0 z-30 ${viewingList ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${viewingList ? "opacity-100" : "opacity-0"}`}
          onClick={() => setViewingList(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-[1120px] bg-ink-soft border-l border-ink-line overflow-y-auto transition-transform duration-300 ${viewingList ? "translate-x-0" : "translate-x-full"}`}>
          {viewingList && (() => {
            const wl = viewingList;
            const items = itemsFor(wl.id);
            return (
              <>
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-4 border-b border-ink-line">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="font-semibold text-base">{wl.name}</p>
                    {wl.description && <p className="text-xs text-paper-dim mt-0.5">{wl.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {items.length > 0 && (
                      <button onClick={() => analyzeGroup(wl)} className="px-3 py-1.5 rounded-lg text-xs border border-brass/40 text-brass-soft hover:bg-brass/10 transition-colors">Analyze Group</button>
                    )}
                    <button onClick={openAddItem} className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors">+ Add Symbol</button>
                    <button onClick={() => openEditList(wl)} className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors">Edit</button>
                    <button onClick={() => setViewingList(null)} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
                  </div>
                </div>

                {/* Items */}
                <div className="px-5 py-4">
                  {items.length === 0 ? (
                    <div className="card p-6 text-center">
                      <p className="text-paper-dim text-sm">No symbols yet.</p>
                      <button onClick={openAddItem} className="btn text-sm mt-3">+ Add Symbol</button>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-ink-line">
                            <th className="label text-left font-medium py-2 pr-3">Symbol</th>
                            <th className="label text-left font-medium py-2 pr-3">Type</th>
                            <th className="label text-right font-medium py-2 pr-2">Price</th>
                            <th className="label text-right font-medium py-2 pr-2">Day Chg %</th>
                            <th className="label text-right font-medium py-2 pr-2">Buy Target</th>
                            <th className="label text-right font-medium py-2 pr-2">Sell Target</th>
                            <th className="label text-left font-medium py-2">Signal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item) => {
                            const mkt = priceFor(item);
                            const buyHit  = isBuyHit(item, mkt);
                            const sellHit = isSellHit(item, mkt);
                            return (
                              <tr
                                key={item.id}
                                className="border-b border-ink-line/40 last:border-0 hover:bg-ink-soft/40 transition-colors cursor-pointer"
                                onClick={() => setDetailItem(item)}
                              >
                                <td className="py-2 pr-3" title={item.summary || undefined}>
                                  <span className="font-medium">{item.symbol}</span>
                                  {item.name && <span className="block text-[10px] text-paper-dim leading-tight">{item.name}</span>}
                                </td>
                                <td className="py-2 pr-3 text-paper-dim">
                                  {(assetTypes ?? []).find((a) => a.code === item.asset_type)?.label ?? item.asset_type}
                                </td>
                                <td className="num text-right py-2 pr-2">{mkt?.price != null ? usd(mkt.price) : "—"}</td>
                                <td className={`num text-right py-2 pr-2 ${gainCls(mkt?.change_24h_pct)}`}>
                                  {mkt?.change_24h_pct == null ? "—" : `${mkt.change_24h_pct > 0 ? "+" : ""}${mkt.change_24h_pct.toFixed(2)}%`}
                                </td>
                                <td className={`num text-right py-2 pr-2 ${buyHit ? "text-gain font-semibold" : "text-paper-dim"}`}>
                                  {item.buy_price != null ? usd(item.buy_price) : "—"}
                                </td>
                                <td className={`num text-right py-2 pr-2 ${sellHit ? "text-loss font-semibold" : "text-paper-dim"}`}>
                                  {item.sell_price != null ? usd(item.sell_price) : "—"}
                                </td>
                                <td className="py-2">
                                  {buyHit && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-gain/30 bg-gain/10 text-gain">BUY</span>}
                                  {sellHit && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-loss/30 bg-loss/10 text-loss">SELL</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* ── Create / Edit watch list drawer ────────────────────────────────── */}
      <div className={`fixed inset-0 z-40 ${editingList ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingList ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingList(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${editingList ? "translate-x-0" : "translate-x-full"}`}>
          {editingList && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">{editingList === "new" ? "New watch list" : "Edit watch list"}</p>
                <button onClick={() => setEditingList(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>

              <div>
                <label className="label block mb-1.5">Name</label>
                <input
                  className="field"
                  placeholder="e.g. AI Infrastructure"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
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

              {formError && <p className="text-loss text-sm">{formError}</p>}

              <button className="btn w-full" onClick={saveList} disabled={formBusy}>
                {formBusy ? "Saving…" : editingList === "new" ? "Create watch list" : "Save changes"}
              </button>

              {editingList !== "new" && (
                <button
                  className="w-full px-3 py-2 text-sm rounded-lg text-paper-dim hover:text-loss border border-ink-line hover:border-loss/40 transition-colors"
                  onClick={() => { setEditingList(null); deleteList(editingList); }}
                >
                  Delete watch list
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Add / Edit item drawer ─────────────────────────────────────────── */}
      <div className={`fixed inset-0 z-50 ${editingItem ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-ink/70 transition-opacity ${editingItem ? "opacity-100" : "opacity-0"}`}
          onClick={() => setEditingItem(null)}
        />
        <div className={`absolute right-0 top-0 h-full w-full max-w-sm bg-ink-soft border-l border-ink-line p-5 space-y-4 overflow-y-auto transition-transform duration-300 ${editingItem ? "translate-x-0" : "translate-x-full"}`}>
          {editingItem && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-medium">{editingItem === "new" ? "Add symbol" : "Edit symbol"}</p>
                <button onClick={() => setEditingItem(null)} className="text-paper-dim hover:text-paper" aria-label="Close">✕</button>
              </div>

              <div>
                <label className="label block mb-1.5">Symbol</label>
                <input
                  className="field uppercase"
                  placeholder="e.g. AAPL"
                  value={itemForm.symbol}
                  disabled={editingItem !== "new"}
                  onChange={(e) => setItemForm((f) => ({ ...f, symbol: e.target.value }))}
                  onBlur={(e) => editingItem === "new" && lookupItemSymbol(e.target.value)}
                />
                {symbolLookupBusy && <p className="text-[10px] text-paper-dim mt-1">Looking up…</p>}
              </div>

              <div>
                <label className="label block mb-1.5">Name</label>
                <input
                  className="field"
                  placeholder="Company / fund name"
                  value={itemForm.name}
                  onChange={(e) => setItemForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>

              <div>
                <label className="label block mb-1.5">Asset type</label>
                <select
                  className="field"
                  value={itemForm.asset_type}
                  onChange={(e) => setItemForm((f) => ({ ...f, asset_type: e.target.value }))}
                >
                  <option value="">Select…</option>
                  {assetTypes.map((a) => (
                    <option key={a.code} value={a.code}>{a.label}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label block mb-1.5">Buy target</label>
                  <input
                    type="number" step="0.01"
                    className="field"
                    placeholder="$"
                    value={itemForm.buy_price}
                    onChange={(e) => setItemForm((f) => ({ ...f, buy_price: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label block mb-1.5">Sell target</label>
                  <input
                    type="number" step="0.01"
                    className="field"
                    placeholder="$"
                    value={itemForm.sell_price}
                    onChange={(e) => setItemForm((f) => ({ ...f, sell_price: e.target.value }))}
                  />
                </div>
              </div>

              <div>
                <label className="label block mb-1.5">Notes</label>
                <textarea
                  className="field min-h-[90px] resize-y"
                  placeholder="Why you're watching this…"
                  value={itemForm.notes}
                  onChange={(e) => setItemForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </div>

              {editingItem !== "new" && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="label">Summary</label>
                    <button
                      type="button"
                      onClick={() => regenerateSummary(editingItem)}
                      disabled={itemFormBusy}
                      className="text-[10px] text-paper-dim hover:text-paper transition-colors"
                    >
                      Regenerate
                    </button>
                  </div>
                  <p className="text-xs text-paper-dim leading-relaxed">
                    {editingItem.summary || "No summary yet."}
                  </p>
                </div>
              )}

              {itemFormError && <p className="text-loss text-sm">{itemFormError}</p>}

              <button className="btn w-full" onClick={saveItem} disabled={itemFormBusy}>
                {itemFormBusy ? "Saving…" : editingItem === "new" ? "Add symbol" : "Save changes"}
              </button>

              {editingItem !== "new" && (
                <button
                  className="w-full px-3 py-2 text-sm rounded-lg text-paper-dim hover:text-loss border border-ink-line hover:border-loss/40 transition-colors"
                  onClick={() => { setEditingItem(null); deleteItem(editingItem); }}
                >
                  Remove from watch list
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <WatchListItemDrawer
        item={detailItem}
        marketRow={detailItem ? priceFor(detailItem) : null}
        assetTypes={assetTypes}
        onClose={() => setDetailItem(null)}
        onEdit={openEditItem}
        onDelete={deleteItem}
        onAnalyze={analyzeItem}
      />

      <WatchAnalysisPanel
        analysis={analysis}
        busy={analysisBusy}
        error={analysisError}
        onClose={() => setAnalysis(null)}
        onRegenerate={() => analysisReq && runAnalysis({ ...analysisReq, force: true })}
      />
    </Shell>
  );
}
