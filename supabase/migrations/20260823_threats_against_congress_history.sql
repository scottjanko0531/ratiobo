-- ============================================================
-- Historical annual series for "Threats Against Members of Congress",
-- backing an index-vs-baseline-year + z-scored-YoY-change view of the
-- metric instead of a bare YoY delta against last year's figure.
--
-- Seed values (2017-2025) are cross-verified against USCP's own annual
-- press releases: each release repeats a trailing 5-year table, so every
-- year here is independently confirmed by at least two releases. USCP's
-- press-release archive 404s for individual year pages before 2022 and no
-- reliable primary source for pre-2017 figures was found, so 2017 is the
-- earliest usable baseline year (not the 10-20 years originally hoped for).
--   2025 release: 9,474 in 2024, 8,008 in 2023, 7,501 in 2022, 9,625 in 2021, 8,613 in 2020
--   2024 release: 8,008 in 2023, 7,501 in 2022, 9,625 in 2021, 8,613 in 2020, 6,955 in 2019, 5,206 in 2018, 3,939 in 2017
--   2023 release: 7,501 in 2022, 9,625 in 2021, 8,613 in 2020, 6,955 in 2019, 5,206 in 2018
--   2022 release: 9,625 in 2021, 8,613 in 2020, 6,955 in 2019, 5,206 in 2018, 3,939 in 2017
-- ============================================================

create table if not exists public.big_cycle_metric_history (
  metric_key    text    not null,
  year          int     not null,
  value_numeric numeric not null,
  primary key (metric_key, year)
);

alter table public.big_cycle_metric_history enable row level security;

-- Reference/derived data, not user-scoped: readable by authenticated users.
-- All writes go through update-big-cycle-metrics using the service role,
-- which bypasses RLS — no client-side write policy is granted on purpose,
-- matching big_cycle_stage_audit_log's precedent.
create policy big_cycle_metric_history_read on public.big_cycle_metric_history
  for select to authenticated using (true);

insert into public.big_cycle_metric_history (metric_key, year, value_numeric) values
  ('threats_against_congress', 2017, 3939),
  ('threats_against_congress', 2018, 5206),
  ('threats_against_congress', 2019, 6955),
  ('threats_against_congress', 2020, 8613),
  ('threats_against_congress', 2021, 9625),
  ('threats_against_congress', 2022, 7501),
  ('threats_against_congress', 2023, 8008),
  ('threats_against_congress', 2024, 9474),
  ('threats_against_congress', 2025, 14938)
on conflict (metric_key, year) do update set value_numeric = excluded.value_numeric;
