-- Debt-Cycle Metrics Integrity, Phase 2e (docs/specs/debt-metrics-integrity.md).
-- Widens big_cycle_determinants' refresh_method CHECK constraint to allow
-- 'api_macro_xref' — the value already used by the sibling big_cycle_metrics
-- table for rows computed live from other macro data, not hand-typed. Found
-- live while deploying Phase 2e: the "Debt Burden" determinant's intended
-- refresh_method change (manual -> api_macro_xref, per spec) violated the
-- existing constraint, which only allowed api_fred/api_imf/api_cofer/manual.

alter table public.big_cycle_determinants drop constraint big_cycle_determinants_refresh_method_check;
alter table public.big_cycle_determinants add constraint big_cycle_determinants_refresh_method_check
  check (refresh_method = any (array['api_fred'::text, 'api_imf'::text, 'api_cofer'::text, 'api_macro_xref'::text, 'manual'::text]));
