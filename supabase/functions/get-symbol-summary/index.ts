import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { symbol, name, asset_type } = await req.json();
    if (!symbol) {
      return new Response(JSON.stringify({ error: "symbol required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    if (!ANTHROPIC_KEY) {
      return new Response(JSON.stringify({ summary: null }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const label = name ? `${name} (${symbol})` : symbol;
    const typeHint = asset_type ? ` It is being added to a watch list as asset type "${asset_type}".` : "";

    const prompt = `Write a brief, current summary of ${label} for an investor's watch list.${typeHint}

Style example: "MP Materials (NYSE: MP) — Operates Mountain Pass, California, the only U.S. mine currently producing separated rare-earth oxide at commercial scale. Building the \\"Independence\\" magnet facility in Fort Worth to go fully mine-to-magnet. DoD holds a ~15% equity stake and guarantees a price floor."

Lead with what it does or represents and why it matters right now — the core business or role, plus any especially notable structural facts (major stakeholders, unique market position, recent strategic moves). No fluff, no "is a company that", no disclaimers, no markdown, no leading dash or ticker restatement (the UI already shows those). Plain prose, 1-2 sentences, under 55 words. If you're not confident about specifics for this exact symbol, give a factual, general description of what it is instead of guessing at details.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ summary: null }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const j = await res.json();
    const summary = (j.content?.[0]?.text as string | undefined)?.trim() || null;
    return new Response(JSON.stringify({ summary }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
