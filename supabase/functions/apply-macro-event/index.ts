import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Same debt-cycle row id used by update-big-cycle-metrics's threshold classifier
// and detect-macro-events. This is the only place a *detected event* is allowed
// to flip big_cycle_stages — always behind an explicit human confirm click.
const DEBT_CYCLE_ID = "da204e3f-ae22-47dd-95bb-2844d4f75685";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { event_id, action } = await req.json();
    if (!event_id || (action !== "confirm" && action !== "dismiss")) {
      return json({ error: "event_id and action ('confirm'|'dismiss') required" }, 400);
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: event, error: fetchErr } = await sb
      .from("big_cycle_events")
      .select("*")
      .eq("id", event_id)
      .single();
    if (fetchErr || !event) return json({ error: "event not found" }, 404);
    if (event.status !== "pending") return json({ error: `event already ${event.status}` }, 409);

    const now = new Date().toISOString();

    if (action === "dismiss") {
      await sb.from("big_cycle_events").update({ status: "dismissed", reviewed_at: now }).eq("id", event_id);
      return json({ status: "dismissed", event_id });
    }

    // action === "confirm"
    let stageApplied: string | null = null;
    if (event.suggested_stage) {
      await sb.from("big_cycle_stages").update({ is_current: false }).eq("cycle_id", DEBT_CYCLE_ID);
      const { error: stageErr } = await sb
        .from("big_cycle_stages")
        .update({ is_current: true })
        .eq("cycle_id", DEBT_CYCLE_ID)
        .eq("label", event.suggested_stage);
      if (stageErr) {
        console.error("[apply-macro-event] stage write:", stageErr);
        return json({ error: "failed to apply stage change" }, 500);
      }
      stageApplied = event.suggested_stage;
    }

    await sb.from("big_cycle_events").update({ status: "applied", reviewed_at: now }).eq("id", event_id);
    return json({ status: "applied", event_id, stage_applied: stageApplied });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
