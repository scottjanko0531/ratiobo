import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const fmt$ = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const fmtPct = (n: number) => (n * 100).toFixed(1) + "%";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json() as {
      profile: Record<string, unknown>;
      mcResults: {
        probabilityOfSuccess: number;
        withdrawalRate: number;
        medianFinal: number;
        totalPortfolio: number;
      };
      portfolioLabel: string;
      portfolioBreakdown: string;
    };

    const { profile, mcResults, portfolioLabel, portfolioBreakdown } = body;

    // Pull current macro regime
    const { data: regime } = await supabase
      .from("macro_regime_history")
      .select("structural_key, market_key, forward_key, forward_confidence")
      .order("period_date", { ascending: false })
      .limit(1)
      .single();

    const REGIME_LABELS: Record<string, string> = {
      rg_fi: "Disinflationary Boom",
      rg_ri: "Reflation",
      fg_ri: "Stagflation",
      fg_fi: "Deflationary Bust",
    };

    const age = Number(profile.age);
    const spouseAge = profile.spouse_age ? Number(profile.spouse_age) : null;
    const lifeExp = Number(profile.life_expectancy) || 95;
    const isRetired = Boolean(profile.is_retired);
    const retirementYear = profile.retirement_year ? Number(profile.retirement_year) : null;
    const monthlyExpenses = Number(profile.monthly_expenses) || 0;
    const taxBracket = Number(profile.tax_bracket) || 0.22;
    const stateTax = Number(profile.state_tax_rate) || 0;
    const filingStatus = String(profile.filing_status || "married_jointly");
    const inflationRate = Number(profile.inflation_rate) || 0.03;
    const taxableAssets = Number(profile.taxable_assets) || 0;
    const traditionalAssets = Number(profile.traditional_assets) || 0;
    const rothAssets = Number(profile.roth_assets) || 0;
    const incomeStreams = (profile.income_streams as { label: string; amountMonthly: number; startYear: number; endYear?: number; type: string }[]) || [];

    const totalIncome = incomeStreams.reduce((s, st) => s + st.amountMonthly * 12, 0);
    const annualExpenses = monthlyExpenses * 12;
    const currentYear = new Date().getFullYear();

    const incomeList = incomeStreams.length
      ? incomeStreams.map(s =>
          `  • ${s.label}: ${fmt$(s.amountMonthly)}/mo` +
          (s.startYear > currentYear ? ` (starts ${s.startYear})` : "") +
          (s.endYear ? ` → ends ${s.endYear}` : " (ongoing)")
        ).join("\n")
      : "  • None entered";

    const regimeStr = regime
      ? `${REGIME_LABELS[regime.market_key as string] ?? regime.market_key} (forward: ${REGIME_LABELS[regime.forward_key as string] ?? regime.forward_key}, ${regime.forward_confidence}% confidence)`
      : "Unknown";

    const successPct = Math.round(mcResults.probabilityOfSuccess * 100);
    const wrPct = (mcResults.withdrawalRate * 100).toFixed(2);

    const prompt = `You are a personal financial planning advisor analyzing someone's retirement and investment situation. Provide concrete, actionable recommendations — not generic advice.

## Client Profile
- Age: ${age}${spouseAge ? `, spouse age: ${spouseAge}` : ""}
- Life expectancy target: ${lifeExp}
- Status: ${isRetired ? "Retired" : retirementYear ? `Planning to retire in ${retirementYear} (${retirementYear - currentYear} years)` : "Working, no firm retirement date"}
- Filing status: ${filingStatus.replace("_", " ")}
- Tax bracket: ${fmtPct(taxBracket)} federal${stateTax > 0 ? ` + ${fmtPct(stateTax)} state` : ""}

## Financial Position
Total investable assets: ${fmt$(mcResults.totalPortfolio)}
- Taxable accounts: ${fmt$(taxableAssets)} (${mcResults.totalPortfolio > 0 ? ((taxableAssets / mcResults.totalPortfolio) * 100).toFixed(0) : 0}%)
- Traditional IRA/401k: ${fmt$(traditionalAssets)} (${mcResults.totalPortfolio > 0 ? ((traditionalAssets / mcResults.totalPortfolio) * 100).toFixed(0) : 0}%)
- Roth: ${fmt$(rothAssets)} (${mcResults.totalPortfolio > 0 ? ((rothAssets / mcResults.totalPortfolio) * 100).toFixed(0) : 0}%)

## Income Streams
Annual income today: ${fmt$(totalIncome)}
${incomeList}

## Expenses & Withdrawal Need
Monthly living expenses: ${fmt$(monthlyExpenses)}/mo (${fmt$(annualExpenses)}/yr)
Annual income/expense gap: ${totalIncome >= annualExpenses ? `Surplus of ${fmt$(totalIncome - annualExpenses)}` : `Shortfall of ${fmt$(annualExpenses - totalIncome)} — must draw from portfolio`}
Implied portfolio withdrawal rate: ${wrPct}% (4% rule threshold = sustainable; >4% = risk zone)
Inflation assumption: ${fmtPct(inflationRate)}/yr

## Monte Carlo Results (1,000 simulations)
Portfolio: ${portfolioLabel} — ${portfolioBreakdown}
Probability of success (not running out before age ${lifeExp}): ${successPct}%
Median portfolio at age ${lifeExp}: ${fmt$(mcResults.medianFinal)}

## Current Macro Regime
${regimeStr}

---

Provide a structured financial plan with these sections:

### 1. Plan Assessment
One paragraph: Is this plan on track? What's the primary risk? Be direct.

### 2. Immediate Action Items (next 90 days)
3–5 specific, numbered steps. Make them concrete (e.g., "Move $X from taxable to [specific instrument]", not "consider diversifying").

### 3. Allocation Recommendation
Given their age, income needs, and the current macro regime, recommend:
- Specific portfolio allocation (use the portfolios available: Standard GB, Hedged GB, or BW Modified — or suggest a blend)
- Where each account type (taxable, IRA, Roth) should hold which assets (asset location strategy)
- Any rebalancing needed from current allocation

### 4. Tax Optimization
- Roth conversion opportunity assessment (given their bracket and trajectory)
- Withdrawal sequencing: which accounts to draw from first and why
- Any tax-loss harvesting or gain management to consider

### 5. Risks to Watch
2–3 specific risks to this plan (not generic), with a monitoring trigger for each (e.g., "If [X] happens, do [Y]").

Be direct, specific, and reference their actual numbers. No disclaimers or generic caveats within the plan itself — the user understands this is quantitative analysis, not licensed advice.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const json = await res.json() as { content: { type: string; text: string }[] };
    const text = json.content.find(b => b.type === "text")?.text ?? "";

    return new Response(JSON.stringify({ ok: true, plan: text }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[financial-plan]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
