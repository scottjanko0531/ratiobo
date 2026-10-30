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
written hours earlier under the old weights, went stale until
re-seeded same-day via the new `rules_change` mechanism below, rather
than waiting a day for it to self-correct — see that entry.)

## Standing rule: `rules_change` reseed on a shared weight table change (2026-10-30)

A same-day weight-table edit (D-1, above) left `phase2`'s already-
written row for the day holding the pre-change numbers, which would
have logged ~40 points of phantom turnover over the next 2-3 days as
`capTurnover` "caught up" to a definition change that was never a real
decision. **Decision:** whenever a shared weight table changes, every
affected lane gets reseeded at the new weights the same day — the
lane's own decision-state (base/near key, λ, variant) is left exactly
as it was, only the underlying numbers at those same coordinates are
recomputed via `resolveWeightsFor()` (`_shared/shadowLanes.ts`). The
written row gets `event = "rules_change"`, `turnover_vs_prev = 0`,
`turnover_uncapped = null` — `regime_shadow_summary`'s shift/turnover
aggregates exclude `rules_change` rows the same way they already
exclude `seed`. Done via `update-regime-shadow-targets`'s
`?reseed=true` (service-role only, same gate as `?recompute=true`),
and `RULES_VERSION` gets bumped whenever this happens, even if no lane
function itself changed.

## `legacy` lane uses frozen weights, not the shared `getWeightSet` (2026-10-30)

Caught before it caused a silent correctness bug: `legacyLane` was
calling the same mutable `getWeightSet` as `phase2`/`phase3`, so the
very next time it swapped into `fg_ri` it would have used D-1's
revised base instead of the pre-Phase-2 numbers it's supposed to
represent — no longer a faithful old-rules baseline. **Decision:**
`legacyLane` now reads from a new frozen `LEGACY_WEIGHTS` constant
(`_shared/regimeWeights.ts` / `lib/simulatorKeys.js`) that never
changes, decoupled entirely from `REGIME_WEIGHT_SETS`. Today the two
tables agree on `rg_fi`/`rg_ri`/`fg_fi` (D-1 didn't touch them) and
differ only on `fg_ri` — a test (`tests/shadowLanes.test.ts`) pins
this exact divergence so a future accidental revert back to the
shared table fails immediately once the tables disagree.

## `regime_phase3_weights`: staged-rollout flag (2026-10-30, renamed same day)

Not a numbered decision in the spec, but logged for the same reason
the Phase 2 safety-gate convention (`regime_auto_shift`) was. Shipped
first as `regime_variants_enabled`, then renamed: its real scope is
wider than "variants" — D-1 changed `fg_ri`'s **base** numbers
themselves, not just added a `high` tier, so gating only the variant
tier would have left the live job using the new base weights even
with the flag off. With `regime_phase3_weights = false`, the live job
now uses the frozen pre-Phase-3 weight SETS entirely (`LEGACY_WEIGHTS`
in `_shared/regimeWeights.ts`) — so re-enabling `regime_auto_shift`
alone tests Phase 2's rules against the original numbers, a clean
single-variable test. Defaults `false` for both portfolios. The
`phase3` shadow lane ignores this flag entirely by design (it always
shows what phase3-weights-on would produce) — the live function
instead records `regime_blend.variant` as the real computed variant
regardless of the flag, so the value is visible even while gated off.

## `fg_ri` nb interim treatment: route to cash/TIPS until IEI is held (2026-10-30)

D-1's revised `fg_ri` base (above) introduced a new 15-20% `nb`
target where the pre-Phase-3 table had none. Checked how `nb` maps to
real holdings before shipping it: 100% TLT today, zero IEI held in
either regime-driven portfolio — so applying the new base as-is would
buy a pure long-duration bet in Stagflation, the exact duration
exposure the paper's own evidence (spec §5.2/§6.3) argues against
until a shorter-duration instrument (IEI) is actually available to
split it against. **Decision (Scott):** route `fg_ri`'s `nb` target
evenly into `cash`/`tip` instead, until a portfolio holds IEI —
implemented as a small override alongside the existing weight sets,
not a change to the D-1 numbers themselves. New
`applyNbInterimTreatment(key, weights, hasIEI)`
(`_shared/regimeWeights.ts` / `lib/simulatorKeys.js`) is scoped
strictly to `key === "fg_ri"`: `rg_fi`/`fg_fi`'s `nb` targets are
unchanged from pre-Phase-3 (not new exposure D-1 introduced), so
they're out of scope. Wired into every consumer of `getWeightSet` for
`fg_ri`: `resolveWeightsFor()` (and so `phase2Lane`/`phase3Lane` and
the `?reseed=true` endpoint) and the live function's own weight
resolution, each gated per-portfolio by a live `portfolio_holdings` →
`holdings` (`symbol = 'IEI'`, `quantity > 0`) lookup. Not applied to
`legacyLane` (frozen at `LEGACY_WEIGHTS`, where `fg_ri.nb` is already
0) or to the live function's `regime_phase3_weights = false` path
(same reason). `RULES_VERSION` bumped to `shadow-v4`. Verified live
2026-10-30: both regime-driven portfolios hold no IEI, so `phase2`/
`phase3`'s `fg_ri` rows show `nb: 0, cash: 20, tip: 25` (the 20-point
`nb` split 10/10 into `cash`/`tip` on top of each base's existing
10/15) rather than `nb: 20`. Revisit once Phase 4 ships an IEI-backed
short-duration sleeve — at that point `hasIEI` flips true per
portfolio and this override stops firing on its own, no code change
needed.
