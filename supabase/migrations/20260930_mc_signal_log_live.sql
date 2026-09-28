-- Market Conditions Overlay — live-record view (Phase 3 prerequisite).
-- mc_signal_log was populated by a single backfill-equivalent run covering
-- the full 1993-10-29-present history in one shot (market-conditions-
-- compute doubles as both "nightly" and "backfill" -- see its own header
-- comment), so every historical row shares roughly the same computed_at
-- regardless of how far in the past its own `date` is. Any performance
-- number computed over the raw table would silently mix that backfill
-- with genuine forward-looking nightly writes, which is exactly the
-- in-sample/out-of-sample conflation this whole robustness arc has been
-- careful to keep separate (see DECISIONS.md throughout).
--
-- mc_signal_log_live keeps only rows written close to their own signal
-- date -- computed_at within 4 calendar days AFTER `date` -- which in
-- practice is "written by a nightly run near the signal date," not a
-- backfill. Does not alter or delete any mc_signal_log row (that table
-- stays exactly as append-only/immutable as it already was); this is a
-- read-only filter, nothing more.
create view mc_signal_log_live
  with (security_invoker = true) as
select *
from mc_signal_log
where computed_at::date <= date + 4;

comment on view mc_signal_log_live is 'mc_signal_log filtered to rows written within 4 days of their own signal date -- excludes the initial full-history backfill, keeping only genuine near-real-time nightly writes. This is the TRUE out-of-sample performance record; mc_signal_log itself mixes backfill and live rows and should not be used for performance claims. See DECISIONS.md.';

grant select on mc_signal_log_live to authenticated;
