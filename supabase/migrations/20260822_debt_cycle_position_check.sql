-- ============================================================
-- Debt Cycle Position Check — MP-stage classifier v2 audit trail
-- (stage + which conditions/trip-wires fired + raw inputs, per run) and the
-- Debt Cycle Brief narrative cache (sibling to dalio_regime_analysis).
-- ============================================================

create table if not exists public.big_cycle_stage_audit_log (
  id               uuid        primary key default gen_random_uuid(),
  run_at           timestamptz not null default now(),
  cycle_id         uuid        not null references public.big_cycle_cycles(id),
  stage            text        not null,          -- 'MP1' | 'MP1 (strained)' | 'MP2' | 'MP3'
  previous_stage   text,                           -- null if unchanged this run or no prior row
  conditions       jsonb       not null,            -- ClassifierResult.conditions
  raw_inputs       jsonb       not null,            -- ClassifierResult.rawInputs
  trip_wires       jsonb       not null default '{}'::jsonb, -- current armed/not-armed state of all 4
  trend_confidence text        not null default 'normal',    -- 'normal' | 'low' | 'unknown'
  created_at       timestamptz not null default now()
);

create index if not exists big_cycle_stage_audit_log_cycle_run_idx
  on public.big_cycle_stage_audit_log (cycle_id, run_at desc);

create table if not exists public.dalio_debt_cycle_brief (
  id                  uuid        primary key default gen_random_uuid(),
  brief_date          date        not null unique,
  narrative           text        not null,
  stage               text        not null,
  stage_audit_id      uuid        references public.big_cycle_stage_audit_log(id),
  benchmarks_compared jsonb,
  trip_wires_fired    jsonb,
  portfolio_gap       jsonb,
  generated_at        timestamptz not null default now()
);

alter table public.big_cycle_stage_audit_log enable row level security;
alter table public.dalio_debt_cycle_brief    enable row level security;

-- Reference/derived data, not user-scoped: readable by authenticated users.
-- All writes go through update-big-cycle-metrics / generate-debt-cycle-brief
-- using the service role, which bypasses RLS — no client-side write policy
-- is granted on purpose, matching big_cycle_events' precedent.
create policy big_cycle_stage_audit_log_read on public.big_cycle_stage_audit_log
  for select to authenticated using (true);
create policy dalio_debt_cycle_brief_read on public.dalio_debt_cycle_brief
  for select to authenticated using (true);

-- Surface Federal Debt / Tax Revenue as its own Big Cycle card — informational
-- checkpoint for the benchmark comparison table, not a classifier gate.
insert into public.big_cycle_metrics
  (cycle_id, key, label, source_name, source_url, refresh_method, sort_order, last_updated)
values
  ('da204e3f-ae22-47dd-95bb-2844d4f75685', 'debt_tax_revenue_multiple',
   'Federal Debt / Tax Revenue',
   'Macro dashboard, Long-Term Debt Cycle layer', null,
   'api_macro_xref', 19, now())
on conflict (key) do nothing;
