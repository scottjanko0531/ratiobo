import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TO_EMAIL = Deno.env.get("BRIEF_TO_EMAIL") ?? "scott@janko.group";
const FROM_EMAIL = Deno.env.get("BRIEF_FROM_EMAIL") ?? "brief@janko.group";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REGIME_LABELS: Record<string, string> = {
  rg_fi: "Disinflationary Boom",
  rg_ri: "Reflation",
  fg_ri: "Stagflation",
  fg_fi: "Deflationary Bust",
};
const REGIME_COLORS: Record<string, string> = {
  rg_fi: "#22c55e",
  rg_ri: "#C9A227",
  fg_ri: "#ef4444",
  fg_fi: "#6b7280",
};
const QUADRANT_TO_REGIME: Record<string, string> = {
  "High Growth / Low Inflation":  "rg_fi",
  "High Growth / High Inflation": "rg_ri",
  "Low Growth / High Inflation":  "fg_ri",
  "Low Growth / Low Inflation":   "fg_fi",
};

function fmt$(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n: number, digits = 2): string {
  return (n >= 0 ? "+" : "") + n.toFixed(digits) + "%";
}
function fmtNum(n: number, digits = 2): string {
  return (n >= 0 ? "+" : "") + n.toFixed(digits);
}

// ── Colour helpers for HTML email ──────────────────────────────────────────
function gainColor(n: number): string {
  return n > 0 ? "#22c55e" : n < 0 ? "#ef4444" : "#9ca3af";
}

// ── Fetch macro indicators from DB (already refreshed at 6am) ──────────────
async function getMacro(sb: ReturnType<typeof createClient>) {
  const { data } = await sb.from("macro_indicators").select("name,current_value,status,unit");
  return (data ?? []) as { name: string; current_value: number | null; status: string | null; unit: string }[];
}

// ── Fetch latest regime quadrant ───────────────────────────────────────────
async function getRegime(sb: ReturnType<typeof createClient>) {
  const { data } = await sb
    .from("dalio_regime_history")
    .select("structural_key,market_key,forward_key,forward_confidence,period_date")
    .order("period_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// ── Portfolio day-over-day ─────────────────────────────────────────────────
async function getPortfolio(sb: ReturnType<typeof createClient>) {
  // yesterday = most recent completed snapshot; day_before = the one before that
  const { data: dates } = await sb
    .from("portfolio_snapshots")
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .limit(2);
  if (!dates || dates.length < 2) return null;

  const [today, yesterday] = [dates[0].snapshot_date, dates[1].snapshot_date];

  const { data: snap } = await sb.rpc("portfolio_brief", { d_today: today, d_yesterday: yesterday });
  if (snap) return { rows: snap as BriefRow[], today, yesterday };

  // Fallback: manual join if RPC not available
  const { data: todayRows } = await sb
    .from("portfolio_snapshots")
    .select("holding_id, market_value, net_gain")
    .eq("snapshot_date", today);
  const { data: yestRows } = await sb
    .from("portfolio_snapshots")
    .select("holding_id, market_value")
    .eq("snapshot_date", yesterday);
  const { data: holdings } = await sb
    .from("holdings")
    .select("id, symbol, name");

  if (!todayRows || !yestRows || !holdings) return null;

  const yestMap = Object.fromEntries(yestRows.map((r: { holding_id: string; market_value: number }) => [r.holding_id, r.market_value]));
  const holdMap = Object.fromEntries(holdings.map((h: { id: string; symbol: string; name: string }) => [h.id, h]));

  const rows: BriefRow[] = todayRows
    .filter((r: { holding_id: string }) => yestMap[r.holding_id] != null && holdMap[r.holding_id] != null)
    .map((r: { holding_id: string; market_value: number; net_gain: number }) => {
      const prev = Number(yestMap[r.holding_id]);
      const curr = Number(r.market_value);
      const h = holdMap[r.holding_id];
      return {
        symbol: h.symbol,
        name: h.name,
        market_value: curr,
        net_gain: Number(r.net_gain),
        day_change: curr - prev,
        day_pct: prev > 0 ? ((curr - prev) / prev) * 100 : 0,
      };
    });

  return { rows, today, yesterday };
}

interface BriefRow {
  symbol: string;
  name: string;
  market_value: number;
  net_gain: number;
  day_change: number;
  day_pct: number;
}

// ── Build HTML email ───────────────────────────────────────────────────────
function buildEmail(params: {
  macro: { name: string; current_value: number | null; status: string | null; unit: string }[];
  regime: { structural_key: string; market_key: string; forward_key: string | null; forward_confidence: number | null; period_date: string } | null;
  portfolio: { rows: BriefRow[]; today: string; yesterday: string } | null;
  date: string;
}): { subject: string; html: string } {
  const { macro, regime, portfolio, date } = params;
  const get = (name: string) => { const i = macro.find(x => x.name === name); return i?.current_value != null ? Number(i.current_value) : null; };

  const gdp      = get("Real GDP Growth");
  const cpi      = get("CPI (YoY)");
  const coreCpi  = get("Core CPI (YoY)");
  const ppi      = get("PPI (YoY)");
  const breakeven = get("10Y Breakeven Inflation") ?? 2.5;
  const t10y2y   = get("2yr/10yr Yield Spread");
  const hySpread = get("HY Credit Spread (OAS)");
  const lei      = get("Conference Board LEI");
  const inflExp  = get("Consumer Inflation Expectations");
  const sloos    = get("Sr Loan Officer Survey");
  const unrate   = get("Unemployment Rate");
  const debtGdp  = get("Total Debt / GDP");

  // Regime
  const regimeKey = regime?.structural_key ?? null;
  const regimeLabel = regimeKey ? (REGIME_LABELS[regimeKey] ?? regimeKey) : "Unknown";
  const regimeColor = regimeKey ? (REGIME_COLORS[regimeKey] ?? "#9ca3af") : "#9ca3af";
  const fwdLabel = regime?.forward_key ? (REGIME_LABELS[regime.forward_key] ?? regime.forward_key) : null;
  const fwdConf = regime?.forward_confidence ?? null;
  const marketKey = regime?.market_key ?? null;
  const divergence = regimeKey && marketKey && regimeKey !== marketKey;

  // Portfolio totals
  const totalValue = portfolio?.rows.reduce((s, r) => s + r.market_value, 0) ?? 0;
  const totalGain  = portfolio?.rows.reduce((s, r) => s + r.net_gain, 0) ?? 0;
  const dayChange  = portfolio?.rows.reduce((s, r) => s + r.day_change, 0) ?? 0;
  const dayPct     = totalValue > 0 ? (dayChange / (totalValue - dayChange)) * 100 : 0;

  // Top movers (by absolute $ change, min $100 move to filter noise)
  const movers = portfolio
    ? [...portfolio.rows]
        .filter(r => Math.abs(r.day_change) >= 100)
        .sort((a, b) => Math.abs(b.day_change) - Math.abs(a.day_change))
        .slice(0, 8)
    : [];
  const gainers = movers.filter(r => r.day_change > 0).slice(0, 4);
  const losers  = movers.filter(r => r.day_change < 0).slice(0, 4);

  // Watches
  const watches: string[] = [];
  if (sloos != null && sloos > 40) watches.push(`Bank lending standards tight (SLOOS ${sloos.toFixed(0)})`);
  if (t10y2y != null && t10y2y < 0) watches.push(`Yield curve inverted (2/10: ${t10y2y.toFixed(2)}%)`);
  if (inflExp != null && inflExp > 4.5) watches.push(`Consumer inflation expectations elevated (${inflExp.toFixed(1)}%)`);
  if (unrate != null && unrate > 5.5) watches.push(`Unemployment rising (${unrate.toFixed(1)}%)`);
  if (hySpread != null && hySpread > 6) watches.push(`HY spreads wide (${hySpread.toFixed(1)}%)`);
  if (divergence) watches.push(`Structural/market regime divergence: ${REGIME_LABELS[regimeKey!]} vs ${REGIME_LABELS[marketKey!]}`);

  const subject = `RatioBo Brief · ${regimeLabel} · Portfolio ${dayChange >= 0 ? "+" : ""}${fmt$(dayChange)} · ${date}`;

  const moverRow = (r: BriefRow) => `
    <tr>
      <td style="padding:4px 8px 4px 0;font-weight:600;color:#f1f5f9;">${r.symbol}</td>
      <td style="padding:4px 8px;color:#9ca3af;font-size:11px;">${r.name.length > 28 ? r.name.slice(0, 28) + "…" : r.name}</td>
      <td style="padding:4px 0 4px 8px;text-align:right;font-family:monospace;color:${gainColor(r.day_change)};">${r.day_change >= 0 ? "+" : ""}${fmt$(r.day_change)}</td>
      <td style="padding:4px 0 4px 8px;text-align:right;font-family:monospace;color:${gainColor(r.day_change)};font-size:11px;">${fmtPct(r.day_pct, 1)}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:24px 16px;">
  <tr><td>

    <!-- Header -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td>
          <p style="margin:0;font-size:20px;font-weight:700;color:#f1f5f9;">RatioBo</p>
          <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Daily Macro Brief · ${date}</p>
        </td>
        <td style="text-align:right;vertical-align:top;">
          <span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${regimeColor}22;border:1px solid ${regimeColor}44;color:${regimeColor};font-size:12px;font-weight:600;">${regimeLabel}</span>
        </td>
      </tr>
    </table>

    <!-- Macro Summary -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1f2e;border-radius:8px;border:1px solid #2a3240;padding:0;margin-bottom:16px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 12px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Macro Regime</p>

        ${fwdLabel && fwdLabel !== regimeLabel ? `
        <p style="margin:0 0 10px;font-size:12px;color:#9ca3af;">
          Forward signal → <strong style="color:#C9A227;">${fwdLabel}</strong>${fwdConf != null ? ` <span style="color:#6b7280;">(${fwdConf}% confidence)</span>` : ""}
        </p>` : ""}

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
          <tr>
            ${gdp != null ? `<td style="padding:4px 12px 4px 0;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Real GDP</p>
              <p style="margin:2px 0 0;font-size:16px;font-weight:700;font-family:monospace;color:${gainColor(gdp)};">${fmtNum(gdp, 1)}%</p>
            </td>` : ""}
            ${cpi != null ? `<td style="padding:4px 12px;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">CPI</p>
              <p style="margin:2px 0 0;font-size:16px;font-weight:700;font-family:monospace;color:${cpi > 3 ? "#ef4444" : cpi > 2 ? "#C9A227" : "#22c55e"};">${cpi.toFixed(1)}%</p>
            </td>` : ""}
            ${coreCpi != null ? `<td style="padding:4px 12px;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Core CPI</p>
              <p style="margin:2px 0 0;font-size:16px;font-weight:700;font-family:monospace;color:${coreCpi > 3 ? "#ef4444" : coreCpi > 2 ? "#C9A227" : "#22c55e"};">${coreCpi.toFixed(1)}%</p>
            </td>` : ""}
            ${ppi != null ? `<td style="padding:4px 0;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">PPI</p>
              <p style="margin:2px 0 0;font-size:16px;font-weight:700;font-family:monospace;color:${ppi > 3 ? "#ef4444" : ppi > 0 ? "#C9A227" : "#22c55e"};">${ppi >= 0 ? "+" : ""}${ppi.toFixed(1)}%</p>
            </td>` : ""}
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
          <tr>
            ${t10y2y != null ? `<td style="padding:4px 12px 4px 0;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">2/10 Curve</p>
              <p style="margin:2px 0 0;font-size:14px;font-weight:600;font-family:monospace;color:${t10y2y < 0 ? "#ef4444" : t10y2y < 0.5 ? "#C9A227" : "#22c55e"};">${fmtNum(t10y2y, 2)}%</p>
            </td>` : ""}
            ${hySpread != null ? `<td style="padding:4px 12px;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">HY Spread</p>
              <p style="margin:2px 0 0;font-size:14px;font-weight:600;font-family:monospace;color:${hySpread > 6 ? "#ef4444" : hySpread > 4 ? "#C9A227" : "#22c55e"};">${hySpread.toFixed(1)}%</p>
            </td>` : ""}
            ${lei != null ? `<td style="padding:4px 12px;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">LEI</p>
              <p style="margin:2px 0 0;font-size:14px;font-weight:600;font-family:monospace;color:${gainColor(lei)};">${fmtNum(lei, 1)}%</p>
            </td>` : ""}
            ${breakeven != null ? `<td style="padding:4px 0;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">10Y BE</p>
              <p style="margin:2px 0 0;font-size:14px;font-weight:600;font-family:monospace;color:#9ca3af;">${breakeven.toFixed(2)}%</p>
            </td>` : ""}
          </tr>
        </table>

        ${watches.length > 0 ? `
        <div style="border-top:1px solid #2a3240;padding-top:10px;margin-top:2px;">
          <p style="margin:0;font-size:11px;color:#C9A227;">⚑ Watch: ${watches.join(" · ")}</p>
        </div>` : ""}
      </td></tr>
    </table>

    <!-- Portfolio -->
    ${portfolio ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1f2e;border-radius:8px;border:1px solid #2a3240;margin-bottom:16px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 12px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Portfolio · ${portfolio.yesterday}</p>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
          <tr>
            <td style="padding-right:20px;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Total Value</p>
              <p style="margin:2px 0 0;font-size:20px;font-weight:700;color:#f1f5f9;">${fmt$(totalValue)}</p>
            </td>
            <td style="padding-right:20px;">
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Day P&amp;L</p>
              <p style="margin:2px 0 0;font-size:20px;font-weight:700;color:${gainColor(dayChange)};">${dayChange >= 0 ? "+" : ""}${fmt$(dayChange)}</p>
              <p style="margin:2px 0 0;font-size:11px;font-family:monospace;color:${gainColor(dayChange)};">${fmtPct(dayPct, 2)}</p>
            </td>
            <td>
              <p style="margin:0;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Unrealized G/L</p>
              <p style="margin:2px 0 0;font-size:20px;font-weight:700;color:${gainColor(totalGain)};">${totalGain >= 0 ? "+" : ""}${fmt$(totalGain)}</p>
            </td>
          </tr>
        </table>

        ${movers.length > 0 ? `
        <div style="border-top:1px solid #2a3240;padding-top:12px;">
          <p style="margin:0 0 8px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Top Movers</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${gainers.map(moverRow).join("")}
            ${gainers.length > 0 && losers.length > 0 ? `<tr><td colspan="4" style="height:4px;"></td></tr>` : ""}
            ${losers.map(moverRow).join("")}
          </table>
        </div>` : ""}
      </td></tr>
    </table>` : ""}

    <!-- Footer -->
    <p style="margin:16px 0 0;font-size:10px;color:#374151;text-align:center;">
      RatioBo · Macro data refreshed 6am UTC · Portfolio as of prior close ·
      <a href="https://www.ratiobo.com/macro" style="color:#4b5563;text-decoration:none;">View dashboard →</a>
    </p>

  </td></tr>
</table>
</body>
</html>`;

  return { subject, html };
}

// ── Main handler ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

    const [macro, regime, portfolio] = await Promise.all([
      getMacro(sb),
      getRegime(sb),
      getPortfolio(sb),
    ]);

    const { subject, html } = buildEmail({ macro, regime, portfolio, date });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: TO_EMAIL, subject, html }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend error ${res.status}: ${err}`);
    }

    const result = await res.json();
    return new Response(JSON.stringify({ ok: true, id: result.id, subject }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("[daily-brief]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
