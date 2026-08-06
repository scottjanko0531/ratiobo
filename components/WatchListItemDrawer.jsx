"use client";
import { useState } from "react";
import { MARKET_TYPES, TV_CHART_TYPES, getTVSymbol } from "../lib/tvSymbol";

const usd = (n, digits = 2) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

function EyeIcon({ open }) {
  return open ? (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M1 8c1.5-3.5 4-5 7-5s5.5 1.5 7 5c-1.5 3.5-4 5-7 5s-5.5-1.5-7-5z"/>
      <circle cx="8" cy="8" r="2"/>
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 2l12 12"/>
      <path d="M6.7 6.8A2 2 0 009.2 9.3M4.3 4.6C2.6 5.7 1.5 7 1.5 8c0 0 2 4.5 6.5 4.5 1.2 0 2.3-.3 3.2-.8M8.5 3.6C12.3 3.9 14.5 8 14.5 8s-.6 1.4-1.8 2.6"/>
    </svg>
  );
}

export default function WatchListItemDrawer({ item, marketRow, assetTypes, onClose, onEdit, onDelete }) {
  const [showTVChart, setShowTVChart] = useState(true);
  if (!item) return null;

  const price = marketRow?.price ?? null;
  const changePct = marketRow?.change_24h_pct ?? null;
  const buyHit = item.buy_price != null && price != null && price <= Number(item.buy_price);
  const sellHit = item.sell_price != null && price != null && price >= Number(item.sell_price);

  return (
    <div className={`fixed inset-0 z-40 ${item ? "" : "pointer-events-none"}`}>
      <div
        className={`absolute inset-0 bg-ink/70 transition-opacity ${item ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div className="absolute right-0 top-0 h-full w-full max-w-[760px] bg-ink-soft border-l border-ink-line overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-line">
          <div>
            <p className="font-semibold text-base">
              {item.symbol}
              {item.name && <span className="font-normal text-paper-dim ml-2">{item.name}</span>}
            </p>
            <p className="text-xs text-paper-dim mt-0.5">
              {(assetTypes ?? []).find((a) => a.code === item.asset_type)?.label ?? item.asset_type}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onEdit(item)} className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors">Edit</button>
            <button onClick={() => onDelete(item)} className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-loss hover:border-loss/40 transition-colors">Remove</button>
            <button onClick={onClose} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
          </div>
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px border-b border-ink-line">
          {[
            { label: "Price", val: usd(price) },
            { label: "Day Chg %", val: changePct == null ? "—" : `${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%`, cls: changePct == null ? "text-paper-dim" : changePct > 0 ? "text-gain" : changePct < 0 ? "text-loss" : "" },
            { label: "Buy Target", val: item.buy_price != null ? usd(item.buy_price) : "—", cls: buyHit ? "text-gain" : "" },
            { label: "Sell Target", val: item.sell_price != null ? usd(item.sell_price) : "—", cls: sellHit ? "text-loss" : "" },
          ].map(({ label, val, cls }) => (
            <div key={label} className="px-3 py-3">
              <p className="label text-[10px] mb-0.5 uppercase tracking-wide">{label}</p>
              <p className={`num text-sm font-medium ${cls ?? ""}`}>{val}</p>
            </div>
          ))}
        </div>

        {(buyHit || sellHit) && (
          <div className={`px-5 py-2.5 text-xs font-medium border-b border-ink-line ${buyHit ? "bg-gain/10 text-gain" : "bg-loss/10 text-loss"}`}>
            {buyHit
              ? `Price has reached your buy target of ${usd(item.buy_price)}`
              : `Price has reached your sell target of ${usd(item.sell_price)}`}
          </div>
        )}

        {/* Chart */}
        {TV_CHART_TYPES.has(item.asset_type) ? (
          <div className="border-b border-ink-line">
            <div className="flex items-center justify-between px-5 py-2.5">
              <p className="label text-xs">Price chart</p>
              <button onClick={() => setShowTVChart((v) => !v)} className={`p-1 rounded transition-colors ${showTVChart ? "text-paper hover:text-paper-dim" : "text-paper-dim hover:text-paper"}`} aria-label="Toggle chart">
                <EyeIcon open={showTVChart} />
              </button>
            </div>
            {showTVChart && (
              <iframe
                key={item.symbol}
                src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(getTVSymbol(item.symbol, item.asset_type))}&interval=D&theme=dark&style=1&locale=en&hide_top_toolbar=0&allow_symbol_change=0&save_image=0`}
                width="100%" height="420" frameBorder="0" allowTransparency="true" scrolling="no"
              />
            )}
          </div>
        ) : MARKET_TYPES.has(item.asset_type) && (
          <div className="border-b border-ink-line px-5 py-3">
            <p className="label text-xs mb-0.5">Price chart</p>
            <p className="text-xs text-paper-dim">Chart unavailable for this asset type.</p>
          </div>
        )}

        {item.notes && (
          <div className="px-5 py-4 border-b border-ink-line">
            <p className="label text-xs mb-1.5">Notes</p>
            <p className="text-sm text-paper-dim whitespace-pre-wrap">{item.notes}</p>
          </div>
        )}

        {marketRow?.fetched_at && (
          <div className="px-5 py-3 text-[10px] text-paper-dim/60">
            Price last synced {new Date(marketRow.fetched_at).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
}
