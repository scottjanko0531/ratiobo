-- Debt-Cycle Metrics Integrity, Phase 3a (docs/specs/debt-metrics-integrity.md).
-- Rename "CB Gold Reserves (YoY)" -> "Gold Price (YoY)" per CLAUDE.md rule
-- 2.1 (indicator name strings are keys across macro_indicators,
-- macro_snapshots, and fetch-macro-data's own INDICATORS array). This card
-- has only ever measured the YoY change in the gold PRICE (COMEX GC=F) --
-- never actual central-bank reserve holdings -- so the old name was always
-- a misnomer. Actual CB purchase tonnage is the new, separate "Central
-- Bank Gold Purchases (4Q, tonnes)" card (wgc_gold_purchases).
--
-- Applied live 2026-11-17. A plain two-statement rename (UPDATE
-- macro_indicators.name, UPDATE macro_snapshots.indicator_name) does NOT
-- work here: macro_snapshots.indicator_name carries a non-deferrable FK to
-- macro_indicators.name (a natural-key reference, ON DELETE CASCADE, no ON
-- UPDATE CASCADE). Renaming macro_indicators.name first breaks the FK for
-- every existing macro_snapshots row still pointing at the old name;
-- renaming macro_snapshots first fails because the new name doesn't exist
-- yet in macro_indicators. Making the constraint deferrable mid-transaction
-- also failed live ("cannot ALTER TABLE because it has pending trigger
-- events"). Worked around by inserting a new macro_indicators row under the
-- new name (copying every other column), repointing macro_snapshots at it,
-- then deleting the old row -- the FK is satisfied at every step since the
-- new name always exists before anything references it. macro_indicators.id
-- is not referenced by any other table (confirmed via pg_constraint before
-- doing this), so a new id for this row is safe.

insert into public.macro_indicators
  (name, layer, layer_name, description, fred_series_id, current_value, previous_value, change_value, unit, status, data_source, sort_order, last_fetched_at, created_at, updated_at, is_manual, metadata)
select
  'Gold Price (YoY)', layer, layer_name, description, fred_series_id, current_value, previous_value, change_value, unit, status, data_source, sort_order, last_fetched_at, created_at, updated_at, is_manual, metadata
from public.macro_indicators
where name = 'CB Gold Reserves (YoY)';

update public.macro_snapshots
  set indicator_name = 'Gold Price (YoY)'
  where indicator_name = 'CB Gold Reserves (YoY)';

delete from public.macro_indicators
  where name = 'CB Gold Reserves (YoY)';
