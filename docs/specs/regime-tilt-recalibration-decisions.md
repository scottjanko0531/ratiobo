# Regime Tilt Recalibration — decisions log

## D-0: Oct 2025 CPI gap interpolation, classifier-only (2026-10-29)

`CPIAUCSL` is missing Oct 2025 (government shutdown) — confirmed via
`bond_raw_series` (956 rows spanning 1947-01 to 2026-09, one short of
the 957 a continuous series would have). Left as a genuine gap, it
nulls out Dec 2025's own CPI YoY (classification month = data month +
2), and nulls any acceleration horizon whose 3/6/9-month window touches
it — in practice this was dragging several 2026 rows' `accel_vote` to
`mixed` that would otherwise have resolved cleanly (confirmed on the
live Jun and Sep 2026 rows before the fix).

**Decision:** interpolate the single missing month as the geometric
mean of Sep and Nov 2025, inside `classifyInflationRegime`'s own input
only (`supabase/functions/_shared/inflationRegime.ts`) — never written
to `bond_raw_series`, and hardcoded to this one date (`"2025-10-01"`),
not a general gap-filling policy. A no-op if the real print is ever
backfilled (the code checks `cpi.has(GAP_MONTH)` first).

**Verification:** re-ran the full history after the change — all five
historical replication windows (1969-71, 1974-76, 1979-81 Stagflation;
2021-22 Overheating; 2023-24 Stagflation) are unaffected, since every
affected month falls after all of them. The previously-`mixed` Jun and
Sep 2026 `accel_vote` rows now resolve to `accelerating`/`decelerating`.

## D-9: Borderline margin threshold, ±0.25 points (2026-10-29)

Spec's proposed default, confirmed as-is. `cpi_margin` (CPI YoY minus
its own trailing 75th percentile) within ±0.25 percentage points marks
a reading "borderline" on the `/macro` tile and in Clio's SIGNAL 1b
block, so neither describes an oscillating-at-the-threshold reading as
a firm call. With the live Sep 2026 reading at a 0.18pt margin, this is
presently live and active (flagged borderline).

## Confirm-by date: estimate only, no BLS release calendar (2026-10-29)

The spec allowed either a real BLS CPI release-calendar lookup or a
2nd-Wednesday-of-next-month estimate (labeled "est."). No BLS release
calendar exists anywhere in this repo, and building/maintaining one was
judged out of scope for what the spec itself calls a small follow-up
phase. Scott confirmed: estimate only, always labeled "est." — not
tracked as a numbered decision since the spec already sanctioned this
option directly, but recorded here since it's a real scope choice.

## D-1: high-inflation weight table, approved as tabled (2026-10-30)

The §5.2 table — including `fg_ri` base itself changing (10%eq/60%-
real-assets → 25/5/0/20/15/10/15/10), not just a new `high` sibling —
confirmed as-is, no edits. Flagged explicitly before building: since
`getWeightSet` is one shared function, this change lands on the
`phase2` shadow lane too, not just `phase3` (by the shadow log's own
`rules_version` design — confirmed live: the first `phase3` row landed
with the new `fg_ri` base while `phase2`'s same-day row, already
written hours earlier under the old weights, stayed stale until the
next day's run recomputes fresh against a date with no existing row).

## `regime_variants_enabled`: staged-rollout flag (2026-10-30)

Not a numbered decision in the spec, but logged for the same reason
the Phase 2 safety-gate convention (`regime_auto_shift`) was. A second,
independent lever: a portfolio can have auto-shift back on (applying
the carry/blend/cap/hold rules) while still holding high-inflation
variants off. Defaults `false` for both portfolios. The `phase3` shadow
lane ignores this flag entirely by design (it always shows what
variants-on would produce) — the live function instead records
`regime_blend.variant` as the real computed variant regardless of the
flag, applying `base` weights only when gated off, so the value is
visible even while the flag stays off.
