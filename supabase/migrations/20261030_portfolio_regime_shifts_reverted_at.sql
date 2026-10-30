-- Regime Tilt Recalibration Phase 2: All Weather Alpha's 10/30 06:55 UTC
-- shift (id 12, rg_fi->... applied=true) was written by the OLD rules,
-- moments before its regime_auto_shift hold was set. Scott asked to
-- correct the portfolio's live state to what Phase 2's rules actually
-- produce today (carry blocks the base move; the near-term blend is
-- itself blocked by the 21-day minimum hold since the real 10/21
-- shift) and to mark that row reverted rather than delete it.

alter table portfolio_regime_shifts add column if not exists reverted_at timestamptz;
