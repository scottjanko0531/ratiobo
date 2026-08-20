-- ============================================================
-- Big Cycle — automatic policy-event detection
-- Detected events (e.g. a Fed/Treasury yield-curve-control announcement)
-- land here as "pending" with an AI-suggested debt-cycle stage. A human
-- must confirm before the suggested stage is ever applied to
-- big_cycle_stages — see supabase/functions/apply-macro-event.
-- ============================================================

create table if not exists public.big_cycle_events (
  id              uuid        primary key default gen_random_uuid(),
  detected_at     timestamptz not null default now(),
  event_type      text        not null,
  headline        text        not null,
  source_url      text,
  source_name     text,
  summary         text        not null,
  confidence      text        not null default 'medium',
  suggested_stage text,
  stage_rationale text,
  status          text        not null default 'pending',  -- pending | applied | dismissed
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists big_cycle_events_status_idx
  on public.big_cycle_events (status, detected_at desc);

-- Scan log so the UI can show "last checked" even when a run finds nothing —
-- mirrors china_watch_refresh_log.
create table if not exists public.big_cycle_event_scans (
  id           uuid        primary key default gen_random_uuid(),
  run_at       timestamptz not null default now(),
  status       text        not null,  -- ok | error
  events_found int         not null default 0,
  summary      text
);

alter table public.big_cycle_events      enable row level security;
alter table public.big_cycle_event_scans enable row level security;

-- Reference/derived data, not user-scoped: readable by authenticated users.
-- All writes (inserts, status transitions, and the DEBT_CYCLE stage flip on
-- confirm) go through the detect-macro-events / apply-macro-event edge
-- functions using the service role, which bypasses RLS — no client-side
-- write policy is granted here on purpose, since a stage flip on
-- big_cycle_stages should only ever happen through that one reviewed path.
create policy big_cycle_events_read on public.big_cycle_events
  for select to authenticated using (true);
create policy big_cycle_event_scans_read on public.big_cycle_event_scans
  for select to authenticated using (true);
