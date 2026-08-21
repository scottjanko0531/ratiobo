-- ============================================================
-- Broaden "Threats Against Members of Congress" into "Threats Against
-- Public Officials" by combining USCP's Congress-specific annual count
-- with Princeton's Threats and Harassment Dataset (THD) -- a broader
-- dataset covering elected/appointed officials, judicial officials, school
-- officials, and election workers. Per confirmation, THD's incident set
-- does not include the USCP-reported Congress incidents, so the two are
-- additive without double-counting.
--
-- big_cycle_metric_history previously kept one row per (metric_key, year)
-- holding only Capitol Police figures. It now needs multiple sources per
-- year, so source_type joins the primary key.
-- ============================================================

alter table public.big_cycle_metric_history drop constraint big_cycle_metric_history_pkey;
alter table public.big_cycle_metric_history add column source_type text;
update public.big_cycle_metric_history set source_type = 'Capitol Police' where metric_key = 'threats_against_congress';
alter table public.big_cycle_metric_history alter column source_type set not null;
alter table public.big_cycle_metric_history add primary key (metric_key, year, source_type);

-- Princeton THD per-year incident totals, aggregated from the raw
-- incident-level export (Threats_HarrassmemtDataset April 2026.xlsx, "Data"
-- sheet: 2192 rows, one per incident, counted by the DATE column's year)
-- after excluding the 240 IDs listed on that file's "Deletions" sheet --
-- confirmed already absent from "Data", so no further filtering was needed.
-- 2026 is a partial year (the file is current only through ~April 2026) and
-- is intentionally left out of the combined index/z-score series until USCP
-- also reports 2026 -- see computeThreatsAgainstCongressUpdate in
-- update-big-cycle-metrics, which uses "USCP has reported this year" as the
-- signal that a year is closed and safe to combine.
insert into public.big_cycle_metric_history (metric_key, year, value_numeric, source_type) values
  ('threats_against_congress', 2022, 374, 'Princeton THD'),
  ('threats_against_congress', 2023, 565, 'Princeton THD'),
  ('threats_against_congress', 2024, 628, 'Princeton THD'),
  ('threats_against_congress', 2025, 552, 'Princeton THD'),
  ('threats_against_congress', 2026, 73, 'Princeton THD')
on conflict (metric_key, year, source_type) do update set value_numeric = excluded.value_numeric;

update public.big_cycle_metrics
set label = 'Threats Against Public Officials',
    source_name = 'US Capitol Police (Threat Assessment Section) + Princeton Threats and Harassment Dataset (THD)'
where key = 'threats_against_congress';
