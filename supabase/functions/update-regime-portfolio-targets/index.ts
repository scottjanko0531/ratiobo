import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Same mapping as get-regime-analysis.ts / app/macro/page.jsx's REGIME_META — the
// canonical Dalio four-quadrant labels used everywhere else the regime is displayed.
const REGIME_LABELS: Record<string, string> = {
  rg_fi: "Disinflationary Boom",
  rg_ri: "Reflation",
  fg_ri: "Stagflation",
  fg_fi: "Deflationary Bust",
};
const LABEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(REGIME_LABELS).map(([k, v]) => [v, k]),
);

// Mirrors lib/simulatorKeys.js's REGIME_DEFAULT_WEIGHTS exactly — the same weights
// already used to drive the Simulator's per-regime suggestions, now reused to
// automatically set a regime-driven portfolio's actual target_allocations.
const REGIME_DEFAULT_WEIGHTS: Record<string, Record<string, number>> = {
  rg_fi: { eq: 35, intl: 15, em: 10, nb: 20, tip: 5, com: 5, gld: 5, cash: 5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  rg_ri: { eq: 20, intl: 10, em: 20, nb: 0, tip: 15, com: 20, gld: 10, cash: 5, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_ri: { eq: 5, intl: 5, em: 0, nb: 0, tip: 20, com: 30, gld: 30, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
  fg_fi: { eq: 5, intl: 5, em: 0, nb: 65, tip: 0, com: 0, gld: 15, cash: 10, alt_crypto: 0, alt_re: 0, alt_loan: 0, alt_pp: 0, alt_other: 0 },
};

// Regime shifts must persist for this many days before a regime-driven portfolio's
// target_allocations actually moves — the whole point is to avoid whipsawing a real
// portfolio's targets on a noisy week, since the structural regime itself can wobble
// even though it's already the slowest-moving of the three signals the app computes.
const CONFIRMATION_DAYS = 30;

interface RegimePortfolio {
  id: string; portfolio_name: string;
  current_regime_key: string | null; regime_confirmed_since: string | null;
  pending_regime_key: string | null; pending_regime_since: string | null;
}

function daysBetween(a: string, b: Date): number {
  const diffMs = b.getTime() - new Date(a + "T00:00:00Z").getTime();
  return Math.floor(diffMs / 86_400_000);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // This can run before a human has visited /macro today — ensure Clio's regime
    // analysis exists, same guard analyze-portfolio-health uses.
    const { data: todayRegime } = await sb.from("dalio_regime_analysis").select("analysis_date,structural_regime").eq("analysis_date", todayStr).maybeSingle();
    let structuralLabel = todayRegime?.structural_regime as string | undefined;
    if (!structuralLabel) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/get-regime-analysis`, {
          method: "GET",
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        });
        if (res.ok) {
          const j = await res.json();
          structuralLabel = j?.structural_regime;
        }
      } catch (e) { console.error("[regime-targets] triggering get-regime-analysis:", e); }
    }
    if (!structuralLabel || !LABEL_TO_KEY[structuralLabel]) {
      return json({ error: "structural regime unavailable today", structuralLabel }, 500);
    }
    const liveKey = LABEL_TO_KEY[structuralLabel];

    const { data: portfolios } = await sb
      .from("portfolios")
      .select("id,portfolio_name,current_regime_key,regime_confirmed_since,pending_regime_key,pending_regime_since")
      .eq("strategy_framework", "regime_driven");

    const results: { portfolioId: string; action: string }[] = [];

    for (const pf of (portfolios ?? []) as RegimePortfolio[]) {
      const targets = REGIME_DEFAULT_WEIGHTS[liveKey];

      // First-ever activation: adopt the current regime immediately as the baseline,
      // no 30-day wait — there's nothing to whipsaw away from yet.
      if (!pf.current_regime_key) {
        await sb.from("portfolios").update({
          target_allocations: targets,
          current_regime_key: liveKey,
          regime_confirmed_since: todayStr,
          pending_regime_key: null,
          pending_regime_since: null,
          updated_at: new Date().toISOString(),
        }).eq("id", pf.id);
        await sb.from("portfolio_regime_shifts").insert({
          portfolio_id: pf.id, from_key: null, to_key: liveKey,
          from_label: null, to_label: REGIME_LABELS[liveKey],
        });
        results.push({ portfolioId: pf.id, action: "activated" });
        continue;
      }

      // Live regime matches the already-active target — nothing to do. If a
      // different candidate had been pending, it reverted before confirming, so
      // clear it rather than let a flicker count toward the next confirmation.
      if (liveKey === pf.current_regime_key) {
        if (pf.pending_regime_key) {
          await sb.from("portfolios").update({ pending_regime_key: null, pending_regime_since: null }).eq("id", pf.id);
          results.push({ portfolioId: pf.id, action: "pending_reverted" });
        } else {
          results.push({ portfolioId: pf.id, action: "no_change" });
        }
        continue;
      }

      // Live regime differs from the active target and matches what's already
      // pending — check whether it's been persistent long enough to commit.
      if (liveKey === pf.pending_regime_key && pf.pending_regime_since) {
        const daysPending = daysBetween(pf.pending_regime_since, today);
        if (daysPending >= CONFIRMATION_DAYS) {
          const fromKey = pf.current_regime_key;
          await sb.from("portfolios").update({
            target_allocations: targets,
            current_regime_key: liveKey,
            regime_confirmed_since: todayStr,
            pending_regime_key: null,
            pending_regime_since: null,
            updated_at: new Date().toISOString(),
          }).eq("id", pf.id);
          await sb.from("portfolio_regime_shifts").insert({
            portfolio_id: pf.id, from_key: fromKey, to_key: liveKey,
            from_label: REGIME_LABELS[fromKey] ?? fromKey, to_label: REGIME_LABELS[liveKey],
          });
          results.push({ portfolioId: pf.id, action: "shifted" });
        } else {
          results.push({ portfolioId: pf.id, action: `pending (${daysPending}/${CONFIRMATION_DAYS}d)` });
        }
        continue;
      }

      // New candidate different from both the active target and whatever was
      // pending before — start (or restart) the confirmation clock.
      await sb.from("portfolios").update({ pending_regime_key: liveKey, pending_regime_since: todayStr }).eq("id", pf.id);
      results.push({ portfolioId: pf.id, action: "pending_started" });
    }

    return json({ liveRegimeKey: liveKey, structuralLabel, processed: results.length, results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
