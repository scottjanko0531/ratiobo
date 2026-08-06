// Maps our internal asset_type + symbol to a TradingView widget symbol / support set.
// Shared by HoldingDetailDrawer and WatchListItemDrawer so both price charts stay in sync.
export const MARKET_TYPES = new Set(["equity", "etf", "closed_end_fund", "mutual_fund", "money_market", "bond", "crypto", "metal"]);
export const TV_CHART_TYPES = new Set(["equity", "etf", "closed_end_fund", "crypto", "metal"]);
const METAL_TV_SYMBOLS = { XAU: "TVC:GOLD", XAG: "TVC:SILVER", XPT: "TVC:PLATINUM", XPD: "TVC:PALLADIUM" };

export function getTVSymbol(symbol, assetType) {
  const s = (symbol ?? "").toUpperCase();
  if (assetType === "crypto") return `COINBASE:${s}USD`;
  if (assetType === "metal") return METAL_TV_SYMBOLS[s] ?? `TVC:${s}`;
  return s;
}
