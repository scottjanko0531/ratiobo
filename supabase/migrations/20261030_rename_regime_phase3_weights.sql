-- Regime Tilt Recalibration Phase 3 — renamed from
-- regime_variants_enabled: its real scope is wider than just
-- high-inflation variants. With this flag off, the live job must use
-- the pre-Phase-3 weight SETS entirely (D-1 changed fg_ri's base
-- numbers themselves, not just added a new high tier) -- so turning
-- on regime_auto_shift alone tests Phase 2's rules against the
-- original weights, not a mix of old rules and new numbers.

alter table portfolios rename column regime_variants_enabled to regime_phase3_weights;
