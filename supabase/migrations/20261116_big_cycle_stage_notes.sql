-- Debt-Cycle Metrics Integrity, Phase 1c (docs/specs/debt-metrics-integrity.md).
-- One-time explanatory notes for debt-cycle stage recalculations caused by a
-- methodology fix (e.g. the Phase 1a r-g nominal-vs-real correction) rather
-- than a change in fundamentals. Read by DebtCyclePositionCheck.jsx and
-- generate-debt-cycle-brief/index.ts so a stage change from a definition fix
-- is never presented as an improvement. Not hardcoded in either consumer —
-- see docs/specs/debt-metrics-integrity-decisions.md Phase 1 for the note
-- text and reasoning.

create table public.big_cycle_stage_notes (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  note text not null,
  created_at timestamptz not null default now()
);

alter table public.big_cycle_stage_notes enable row level security;

create policy big_cycle_stage_notes_read
  on public.big_cycle_stage_notes
  for select
  to authenticated
  using (true);

comment on table public.big_cycle_stage_notes is
  'One-time explanatory notes for debt-cycle stage recalculations caused by a methodology fix rather than a change in fundamentals (debt-metrics-integrity spec Phase 1c). Read by DebtCyclePositionCheck.jsx and generate-debt-cycle-brief so the stage change is never presented as an improvement.';
