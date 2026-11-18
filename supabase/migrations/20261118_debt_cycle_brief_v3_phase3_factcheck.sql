-- v3 Phase 3 (debt-metrics-integrity-v3 spec). The brief's fact-check pass
-- now runs deterministic regex rules (holdings reference, rebalance
-- instruction, superseded trip-wire claim, stale "this week" auction
-- claim -- see supabase/functions/_shared/briefFactCheck.ts) alongside the
-- existing LLM consistency check. If an issue survives one regenerate
-- attempt, the brief is still published (never silently blocked) but
-- flagged so the UI can show a visible "fact-check flagged: ..." banner
-- instead of presenting a known-bad narrative as clean.
alter table public.dalio_debt_cycle_brief
  add column if not exists fact_check_flagged boolean not null default false,
  add column if not exists fact_check_issues jsonb not null default '[]'::jsonb;

comment on column public.dalio_debt_cycle_brief.fact_check_flagged is
  'v3 Phase 3c (debt-metrics-integrity-v3 spec): true when the fact-checker (deterministic regex rules + LLM consistency check) still flagged an issue after one regenerate attempt. The UI shows a visible "fact-check flagged: ..." banner rather than silently publishing.';
comment on column public.dalio_debt_cycle_brief.fact_check_issues is
  'The fact-check issue strings behind fact_check_flagged; empty array when not flagged.';

-- 3a removed the "Concrete moves" / portfolioGapLines input entirely -- the
-- brief no longer references the user's own holdings at all, so this
-- column has no writer or reader left (confirmed: generate-debt-cycle-brief
-- was its only writer; nothing reads dalio_debt_cycle_brief.portfolio_gap --
-- DebtCyclePositionCheck.jsx's own portfolio-gap panel, also removed in 3b,
-- computed its table independently from holdings_valued, never from this
-- column).
alter table public.dalio_debt_cycle_brief drop column if exists portfolio_gap;
