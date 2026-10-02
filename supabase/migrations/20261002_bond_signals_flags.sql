-- Bond Lens overlay -- Phase B needs somewhere to persist per-day
-- "missing input / degraded" flags (spec §4 Phase B acceptance: "missing
-- inputs are reweighted and flagged, never silently zeroed"). Not in the
-- original Phase A bond_signals shape since that was written before any
-- module existed to populate it -- same role as market_conditions_scores'
-- own flags column.
alter table bond_signals add column flags jsonb not null default '{}'::jsonb;
