-- Regime Shadow Targets Log spec §1 (prerequisite): the reverted_at
-- column (added in the prior migration) records WHEN a shift was
-- superseded; this adds revert_note to record WHY, without deleting
-- the superseded row.

alter table portfolio_regime_shifts add column if not exists revert_note text;

update portfolio_regime_shifts
set revert_note = 'All Weather Alpha shifted to full Reflation under the pre-Phase-2 rules at 2026-10-30 06:55 UTC, before its regime_auto_shift hold was set. Reverted same-day to the Phase 2 result for the real signal state: carry protects the Stagflation base, and the near-term blend toward Reflation is itself blocked by the 21-day minimum hold stemming from the real 2026-10-21 shift (clears ~2026-11-11). See docs/specs/regime-tilt-recalibration-decisions.md.'
where id = 12;
