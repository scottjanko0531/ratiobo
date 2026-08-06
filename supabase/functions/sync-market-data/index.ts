import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CRYPTO_ID_MAP: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple",
  ADA: "cardano", DOGE: "dogecoin", DOT: "polkadot", LTC: "litecoin",
  LINK: "chainlink", AVAX: "avalanche-2",
};
const CRYPTO_SYMBOL_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(CRYPTO_ID_MAP).map(([sym, id]) => [id, sym]),
);

const METAL_MAP: Record<string, { symbol: string; name: string }> = {
  gold:      { symbol: "XAU", name: "Gold (oz)" },
  silver:    { symbol: "XAG", name: "Silver (oz)" },
  platinum:  { symbol: "XPT", name: "Platinum (oz)" },
  palladium: { symbol: "XPD", name: "Palladium (oz)" },
};

type PriceRow = {
  symbol: string;
  asset_type: string;
  name: string | null;
  price: number;
  currency: string;
  change_24h_pct: number | null;
  dividend_yield: number | null;
  source: string;
  fetched_at: string;
};

async function fetchCrypto(symbols: string[]): Promise<{ rows: PriceRow[]; errors: string[] }> {
  const errors: string[] = [];
  const ids = symbols.map((s) => CRYPTO_ID_MAP[s.toUpperCase()]).filter(Boolean);
  const unmapped = symbols.filter((s) => !CRYPTO_ID_MAP[s.toUpperCase()]);
  if (unmapped.length) errors.push(`crypto: unmapped symbols ${unmapped.join(", ")}`);
  if (!ids.length) return { rows: [], errors };

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`;
  const headers: Record<string, string> = {};
  const cgKey = Deno.env.get("COINGECKO_API_KEY");
  if (cgKey) headers["x-cg-demo-api-key"] = cgKey;

  const res = await fetch(url, { headers });
  if (!res.ok) { errors.push(`crypto: CoinGecko HTTP ${res.status}`); return { rows: [], errors }; }
  const data = await res.json();
  const now = new Date().toISOString();
  const rows: PriceRow[] = [];
  for (const [id, vals] of Object.entries<Record<string, number>>(data)) {
    const symbol = CRYPTO_SYMBOL_BY_ID[id];
    if (!symbol || vals.usd == null) continue;
    rows.push({ symbol, asset_type: "crypto", name: null, price: vals.usd, currency: "USD",
      change_24h_pct: vals.usd_24h_change != null ? Math.round(vals.usd_24h_change * 100) / 100 : null,
      dividend_yield: null, source: "coingecko", fetched_at: now });
  }
  return { rows, errors };
}

async function fetchMetals(): Promise<{ rows: PriceRow[]; errors: string[] }> {
  const errors: string[] = [];
  const key = Deno.env.get("METALS_DEV_API_KEY");
  if (key) {
    try {
      const res = await fetch(`https://api.metals.dev/v1/latest?api_key=${key}&currency=USD&unit=toz`);
      const data = await res.json();
      if (res.ok && data.status === "success" && data.metals) {
        const now = new Date().toISOString();
        const rows: PriceRow[] = [];
        for (const [metal, info] of Object.entries(METAL_MAP)) {
          const price = data.metals[metal];
          if (typeof price === "number")
            rows.push({ symbol: info.symbol, asset_type: "metal", name: info.name, price,
              currency: "USD", change_24h_pct: null, dividend_yield: null, source: "metals.dev", fetched_at: now });
        }
        return { rows, errors };
      }
      errors.push(`metals: metals.dev failed (${data.error_message ?? `HTTP ${res.status}`}), trying fallback`);
    } catch (e) {
      errors.push(`metals: metals.dev error (${e instanceof Error ? e.message : String(e)}), trying fallback`);
    }
  } else {
    errors.push("metals: METALS_DEV_API_KEY not set, using fallback");
  }

  const fallback = [{ api: "XAU", symbol: "XAU", name: "Gold (oz)" }, { api: "XAG", symbol: "XAG", name: "Silver (oz)" }];
  const rows: PriceRow[] = [];
  const now = new Date().toISOString();
  for (const m of fallback) {
    try {
      const res = await fetch(`https://api.gold-api.com/price/${m.api}`);
      if (!res.ok) { errors.push(`metals fallback: ${m.symbol} HTTP ${res.status}`); continue; }
      const data = await res.json();
      if (typeof data.price === "number")
        rows.push({ symbol: m.symbol, asset_type: "metal", name: m.name, price: data.price,
          currency: "USD", change_24h_pct: null, dividend_yield: null, source: "gold-api.com", fetched_at: now });
    } catch (e) {
      errors.push(`metals fallback: ${m.symbol} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { rows, errors };
}

async function fetchEquities(symbols: string[]): Promise<{ rows: PriceRow[]; errors: string[] }> {
  const key = Deno.env.get("FINNHUB_API_KEY");
  if (!key) return { rows: [], errors: ["equities: FINNHUB_API_KEY not set (skipping)"] };
  const errors: string[] = [];
  const rows: PriceRow[] = [];
  const now = new Date().toISOString();
  for (const symbol of symbols) {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`);
    if (!res.ok) { errors.push(`equities: ${symbol} HTTP ${res.status}`); continue; }
    const q = await res.json();
    if (q.c && q.c > 0) {
      rows.push({ symbol, asset_type: "equity", name: null, price: q.c, currency: "USD",
        change_24h_pct: q.dp != null ? Math.round(q.dp * 100) / 100 : null,
        dividend_yield: null, source: "finnhub", fetched_at: now });
    } else {
      errors.push(`equities: ${symbol} returned no price from Finnhub (c=${q.c ?? "null"})`);
    }
  }
  return { rows, errors };
}

// Mutual funds: NAV-priced once daily (Vanguard, Fidelity, etc.).
// Uses Yahoo Finance v8 chart endpoint per symbol — more reliable server-side than batch v7.
async function fetchMutualFunds(symbols: string[]): Promise<{ rows: PriceRow[]; errors: string[] }> {
  const errors: string[] = [];
  if (!symbols.length) return { rows: [], errors };

  const rows: PriceRow[] = [];
  const now = new Date().toISOString();

  await Promise.all(symbols.map(async (symbol) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://finance.yahoo.com/",
          "Origin": "https://finance.yahoo.com",
        },
      });
      if (!res.ok) {
        const res2 = await fetch(
          `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              "Accept": "application/json, */*",
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://finance.yahoo.com/",
            },
          }
        );
        if (!res2.ok) {
          errors.push(`mutual_fund: ${symbol} HTTP ${res.status} (query1) and ${res2.status} (query2)`);
          return;
        }
        const json2 = await res2.json() as Record<string, unknown>;
        const r2 = parseYahooChart(symbol, json2, now);
        if (r2.error) { errors.push(r2.error); return; }
        rows.push(r2.row!);
        return;
      }
      const json = await res.json() as Record<string, unknown>;
      const r = parseYahooChart(symbol, json, now);
      if (r.error) { errors.push(r.error); return; }
      rows.push(r.row!);
    } catch (e) {
      errors.push(`mutual_fund: ${symbol} fetch error — ${e instanceof Error ? e.message : String(e)}`);
    }
  }));

  return { rows, errors };
}

function parseYahooChart(
  symbol: string,
  json: Record<string, unknown>,
  now: string,
): { row?: PriceRow; error?: string } {
  const result = ((json?.chart as Record<string, unknown>)?.result) as Record<string, unknown>[] | null;
  if (!Array.isArray(result) || !result[0]) {
    const errMsg = ((json?.chart as Record<string, unknown>)?.error as Record<string, string>)?.description ?? "no result";
    return { error: `mutual_fund: ${symbol} — ${errMsg}` };
  }
  const meta = result[0].meta as Record<string, number> | undefined;
  const price = meta?.regularMarketPrice;
  if (!price || price <= 0) {
    return { error: `mutual_fund: ${symbol} — no price in meta (got ${price ?? "null"})` };
  }
  const prevClose = meta?.chartPreviousClose ?? meta?.previousClose;
  const changePct = prevClose && prevClose > 0
    ? Math.round(((price - prevClose) / prevClose) * 10000) / 100
    : null;
  return {
    row: { symbol, asset_type: "mutual_fund", name: null, price, currency: "USD",
      change_24h_pct: changePct, dividend_yield: null, source: "yahoo_finance", fetched_at: now },
  };
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: heldRows, error: heldErr } = await supabase.from("holdings").select("symbol, asset_type");
  const { data: mdRows,   error: mdErr   } = await supabase.from("market_data").select("symbol, asset_type");
  const { data: watchRows, error: watchErr } = await supabase.from("watch_list_items").select("symbol, asset_type");

  if (heldErr || mdErr || watchErr) {
    return new Response(
      JSON.stringify({ ok: false, error: heldErr?.message ?? mdErr?.message ?? watchErr?.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const wanted = new Map<string, { symbol: string; asset_type: string }>();
  for (const r of [...(heldRows ?? []), ...(mdRows ?? []), ...(watchRows ?? [])]) {
    wanted.set(`${r.symbol}|${r.asset_type}`, r);
  }

  const cryptoSymbols     = [...wanted.values()].filter((r) => r.asset_type === "crypto").map((r) => r.symbol);
  const equityEtfSymbols  = [...wanted.values()].filter((r) => ["equity","etf"].includes(r.asset_type)).map((r) => r.symbol);
  const mutualFundSymbols = [...wanted.values()].filter((r) => r.asset_type === "mutual_fund").map((r) => r.symbol);

  const [crypto, metals, equities, mutualFunds] = await Promise.all([
    cryptoSymbols.length     ? fetchCrypto(cryptoSymbols)         : Promise.resolve({ rows: [], errors: [] }),
    fetchMetals(),
    equityEtfSymbols.length  ? fetchEquities(equityEtfSymbols)    : Promise.resolve({ rows: [], errors: [] }),
    mutualFundSymbols.length ? fetchMutualFunds(mutualFundSymbols) : Promise.resolve({ rows: [], errors: [] }),
  ]);

  for (const row of equities.rows) {
    const match = [...wanted.values()].find((w) => w.symbol === row.symbol && ["equity","etf"].includes(w.asset_type));
    if (match) row.asset_type = match.asset_type;
  }

  const allRows   = [...crypto.rows, ...metals.rows, ...equities.rows, ...mutualFunds.rows];
  const allErrors = [...crypto.errors, ...metals.errors, ...equities.errors, ...mutualFunds.errors];

  let upserted = 0;
  if (allRows.length) {
    const { error: upErr, count } = await supabase
      .from("market_data")
      .upsert(allRows, { onConflict: "symbol,asset_type", count: "exact" });
    if (upErr) allErrors.push(`upsert: ${upErr.message}`);
    else upserted = count ?? allRows.length;
  }

  return new Response(
    JSON.stringify({ ok: true, upserted, notes: allErrors }),
    { headers: { "Content-Type": "application/json" } },
  );
});
