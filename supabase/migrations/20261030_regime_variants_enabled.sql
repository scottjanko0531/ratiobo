-- Regime Tilt Recalibration Phase 3 — staged-rollout control, parallel
-- to regime_auto_shift: lets Scott re-enable the blend/cap/hold rules
-- (Phase 2) without also turning on high-inflation variants, even
-- once this phase ships. Defaults off for both portfolios.

alter table portfolios add column if not exists regime_variants_enabled boolean not null default false;
