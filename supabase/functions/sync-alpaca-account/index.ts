import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Alpaca brokerage integration -- Phase 1 (read-only sync). Pulls
// Alpaca's own view of positions/cash/activity into the existing
// accounts/holdings/transactions tables once a day. No order placement.
//
// Exactly one `accounts` row is expected to have sync_provider='alpaca'
// (set once by hand after Scott creates the account via the existing
// UI) -- same "assert exactly one, throw if that invariant ever
// breaks" convention already used for the single rb_strategy=true
// portfolio.
//
// First run (accounts.last_synced_at is null): snapshot path. One
// beg_bal transaction per current position (today's qty + avg cost),
// matching the exact convention app/holdings/page.jsx's saveAdd already
// uses when a holding is created with a non-zero starting balance. No
// attempt to reconstruct Alpaca's full historical fill record.
//
// Every later run: incremental path. holdings.quantity is OVERWRITTEN
// from Alpaca's own /v2/positions and /v2/account every time (not
// delta'd) -- Alpaca's own number is authoritative, so this is
// self-correcting even if a run is ever missed or double-fired, unlike
// the manual UI's two-step delta pattern in lib/cash.js. Activities
// since last_synced_at are mapped into `transactions` rows purely as a
// historical record (dividends/fees/cost basis for holdings_valued);
// they do NOT drive the quantity overwrite, so a missed activity never
// desyncs the actual balance.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALPACA_BASE = "https://api.alpaca.markets";

const apiKeyId = Deno.env.get("ALPACA_API_KEY_ID")!;
const apiSecretKey = Deno.env.get("ALPACA_API_SECRET_KEY")!;

function alpacaHeaders() {
  return { "APCA-API-KEY-ID": apiKeyId, "APCA-API-SECRET-KEY": apiSecretKey };
}

async function alpacaGet(path: string): Promise<unknown> {
  const res = await fetch(`${ALPACA_BASE}${path}`, { headers: alpacaHeaders() });
  if (!res.ok) throw new Error(`Alpaca GET ${path}: HTTP ${res.status} -- ${await res.text()}`);
  return res.json();
}

interface AlpacaAccount {
  cash: string;
  currency: string;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  asset_class: string; // "us_equity" | "crypto"
}

interface AlpacaActivity {
  id: string;
  activity_type: string; // FILL, DIV*, CSD, CSW, FEE, CFEE, INT*, JNL*, ...
  date?: string; // non-trade activities
  transaction_time?: string; // FILL activities
  symbol?: string;
  side?: "buy" | "sell";
  qty?: string;
  price?: string;
  net_amount?: string;
}

function assetClassToAssetType(assetClass: string): string {
  // Known Phase 1 limitation: Alpaca's "us_equity" covers both individual
  // stocks and ETFs with no distinction in the API -- a synced ETF
  // position shows as 'equity', not 'etf'. Revisit only if portfolio
  // logic ever branches on that distinction for synced holdings.
  if (assetClass === "crypto") return "crypto";
  return "equity";
}

function txnTypeForActivity(a: AlpacaActivity): string {
  const t = a.activity_type;
  if (t === "FILL") return a.side === "sell" ? "sell" : "buy";
  if (t.startsWith("DIV")) return "dividend";
  if (t === "CSD") return "transfer_in";
  if (t === "CSW") return "transfer_out";
  if (t === "FEE" || t === "CFEE") return "fee";
  if (t.startsWith("INT")) return "interest";
  return "other"; // JNL*, MA, SPIN, etc. -- deliberate catch-all, not a per-code guess
}

// FILL/DIV activities are tied to a specific symbol's holding (the
// stock itself, cash_holding_id = the account's own cash leg). Every
// other activity type is a pure cash movement -- holding_id is the cash
// holding directly, cash_holding_id stays null -- exactly mirroring
// app/transactions/page.jsx's "isCash" path (no separate leg when the
// picked holding already IS cash).
function isSymbolTiedActivity(a: AlpacaActivity): boolean {
  return a.activity_type === "FILL" || a.activity_type.startsWith("DIV");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const startedAt = new Date().toISOString();
  const detail: Record<string, unknown> = {};

  try {
    if (!apiKeyId || !apiSecretKey) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set");

    const { data: accountRows, error: acctErr } = await supabase
      .from("accounts")
      .select("id, user_id, last_synced_at")
      .eq("sync_provider", "alpaca");
    if (acctErr) throw new Error(`accounts lookup: ${acctErr.message}`);
    if (!accountRows || accountRows.length !== 1) {
      throw new Error(`expected exactly one accounts row with sync_provider='alpaca', found ${accountRows?.length ?? 0}`);
    }
    const account = accountRows[0] as { id: string; user_id: string; last_synced_at: string | null };
    const isFirstRun = account.last_synced_at == null;
    const today = new Date().toISOString().slice(0, 10);

    const alpacaAccount = (await alpacaGet("/v2/account")) as AlpacaAccount;
    const positions = (await alpacaGet("/v2/positions")) as AlpacaPosition[];

    const { data: existingHoldings, error: holdErr } = await supabase
      .from("holdings")
      .select("id, symbol, asset_type, quantity")
      .eq("account_id", account.id);
    if (holdErr) throw new Error(`holdings lookup: ${holdErr.message}`);
    const holdingsBySymbol = new Map((existingHoldings ?? []).map((h) => [h.symbol, h]));

    async function getOrCreateHolding(symbol: string, assetType: string): Promise<{ id: string; symbol: string; asset_type: string; quantity: number }> {
      const existing = holdingsBySymbol.get(symbol);
      if (existing) return existing;
      const { data: created, error } = await supabase
        .from("holdings")
        .insert({ user_id: account.user_id, account_id: account.id, symbol, asset_type: assetType, quantity: 0 })
        .select("id, symbol, asset_type, quantity")
        .single();
      if (error) throw new Error(`holdings insert (${symbol}): ${error.message}`);
      holdingsBySymbol.set(symbol, created);
      return created;
    }

    const cashHolding = await getOrCreateHolding("USD", "cash");

    let txnsWritten = 0;
    let positionsSeeded = 0;

    if (isFirstRun) {
      for (const pos of positions) {
        const holding = await getOrCreateHolding(pos.symbol, assetClassToAssetType(pos.asset_class));
        const qty = Number(pos.qty);
        const price = Number(pos.avg_entry_price);
        const { error: txnErr } = await supabase.from("transactions").insert({
          user_id: account.user_id,
          holding_id: holding.id,
          txn_type: "beg_bal",
          txn_date: today,
          quantity: qty,
          price_per_unit: price,
          amount: qty * price,
          fees: 0,
        });
        if (txnErr) throw new Error(`beg_bal transaction insert (${pos.symbol}): ${txnErr.message}`);
        await supabase.from("holdings").update({ quantity: qty }).eq("id", holding.id);
        positionsSeeded++;
      }
      const cashAmount = Number(alpacaAccount.cash);
      await supabase.from("transactions").insert({
        user_id: account.user_id,
        holding_id: cashHolding.id,
        txn_type: "beg_bal",
        txn_date: today,
        quantity: cashAmount,
        price_per_unit: 1,
        amount: cashAmount,
        fees: 0,
      });
      await supabase.from("holdings").update({ quantity: cashAmount }).eq("id", cashHolding.id);
    } else {
      const positionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));

      // Pull every activity since the last sync, paginated.
      const activities: AlpacaActivity[] = [];
      let pageToken: string | null = null;
      const afterIso = account.last_synced_at!;
      for (;;) {
        const qs = new URLSearchParams({ after: afterIso, direction: "asc", page_size: "100" });
        if (pageToken) qs.set("page_token", pageToken);
        const page = (await alpacaGet(`/v2/account/activities?${qs.toString()}`)) as AlpacaActivity[];
        activities.push(...page);
        if (page.length < 100) break;
        pageToken = page[page.length - 1].id;
      }

      const rows: Record<string, unknown>[] = [];
      for (const a of activities) {
        const txnType = txnTypeForActivity(a);
        const txnDate = (a.transaction_time ?? a.date ?? today).slice(0, 10);
        const tiedToSymbol = isSymbolTiedActivity(a) && a.symbol;
        let holdingId = cashHolding.id;
        let cashHoldingId: string | null = null;
        if (tiedToSymbol) {
          const assetType = assetClassToAssetType(positionsBySymbol.get(a.symbol!)?.asset_class ?? "us_equity");
          const holding = await getOrCreateHolding(a.symbol!, assetType);
          holdingId = holding.id;
          cashHoldingId = cashHolding.id;
        }
        const qty = a.qty != null ? Number(a.qty) : null;
        const price = a.price != null ? Number(a.price) : null;
        const amount = a.net_amount != null ? Number(a.net_amount) : qty != null && price != null ? qty * price : null;
        rows.push({
          user_id: account.user_id,
          holding_id: holdingId,
          cash_holding_id: cashHoldingId,
          txn_type: txnType,
          txn_date: txnDate,
          quantity: qty,
          price_per_unit: price,
          amount: amount != null ? Math.abs(amount) : null,
          fees: 0,
          external_id: a.id,
        });
      }
      if (rows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("transactions")
          .upsert(rows, { onConflict: "external_id", ignoreDuplicates: true });
        if (upsertErr) throw new Error(`transactions upsert: ${upsertErr.message}`);
      }
      txnsWritten = rows.length;

      // Overwrite quantities from Alpaca's own current truth -- both for
      // positions still open and for positions that closed out entirely
      // (no longer in /v2/positions, so quantity must drop to 0).
      const openSymbols = new Set(positions.map((p) => p.symbol));
      for (const pos of positions) {
        const holding = await getOrCreateHolding(pos.symbol, assetClassToAssetType(pos.asset_class));
        await supabase.from("holdings").update({ quantity: Number(pos.qty) }).eq("id", holding.id);
        positionsSeeded++;
      }
      for (const h of existingHoldings ?? []) {
        if (h.asset_type === "cash") continue;
        if (!openSymbols.has(h.symbol) && Number(h.quantity) !== 0) {
          await supabase.from("holdings").update({ quantity: 0 }).eq("id", h.id);
        }
      }
      await supabase.from("holdings").update({ quantity: Number(alpacaAccount.cash) }).eq("id", cashHolding.id);
    }

    await supabase.from("accounts").update({ last_synced_at: new Date().toISOString() }).eq("id", account.id);

    detail.mode = isFirstRun ? "snapshot" : "incremental";
    detail.positionsSeeded = positionsSeeded;
    detail.txnsWritten = txnsWritten;
    await supabase.from("alpaca_sync_job_runs").insert({
      job_name: "sync-alpaca-account", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "ok", detail,
    });

    return new Response(JSON.stringify({ ok: true, ...detail }, null, 2), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    await supabase.from("alpaca_sync_job_runs").insert({
      job_name: "sync-alpaca-account", started_at: startedAt, finished_at: new Date().toISOString(),
      status: "error", detail: { ...detail, error: String(e) },
    });
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
