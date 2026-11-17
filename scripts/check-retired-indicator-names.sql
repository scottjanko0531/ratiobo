-- Debt-Cycle Metrics Integrity spec, §5 test checklist: "zero
-- macro_snapshots rows under retired names." Rule 2.1 (CLAUDE.md-adjacent
-- convention for this spec) requires every indicator rename to migrate the
-- existing rows in BOTH macro_indicators and macro_snapshots, not just add
-- the new name alongside the old one. This script fails (non-empty result)
-- if any retired name is still present in either table.
--
-- Run after any migration that renames an indicator. Currently covers the
-- one true rename this spec performed: "CB Gold Reserves (YoY)" ->
-- "Gold Price (YoY)" (Phase 3a). Phase 1a's r-g fix ("Rate vs. GDP Growth
-- Spread") was a REDEFINITION under the same name (rule 2.2 -- backfill
-- the existing name's history, don't rename it), not a rename, so it has
-- no entry here; add a row to RETIRED_NAMES below for any future rename.

with retired_names(name) as (
  values ('CB Gold Reserves (YoY)')
)
select 'macro_indicators' as table_name, mi.name
from public.macro_indicators mi
join retired_names r on mi.name = r.name
union all
select 'macro_snapshots' as table_name, ms.indicator_name
from public.macro_snapshots ms
join retired_names r on ms.indicator_name = r.name;
