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

## Bug fix: `phase2` was calling the mutable `getWeightSet`, not mirroring live's flag-off path (2026-10-30)

Caught before it caused a worse version of the same bug `legacyLane`
was fixed for above: `phase2Lane` called the shared (mutable)
`getWeightSet`, same as `phase3Lane`, differing from it only by
variant — so once D-1 shipped and the live inflation reading sat at
"contained" (variant `base` for both), `phase2` and `phase3` produced
IDENTICAL output every day, defeating the entire point of running
them side by side. The intended meaning of the two lanes is a staged
comparison — `phase2` = Phase 2's carry/blend/cap/hold mechanics
alone, against the pre-Phase-3 weight table; `phase3` = the same
mechanics plus D-1's weight revision — i.e. `phase2` should mirror
the live job with `regime_phase3_weights = false`, and `phase3` should
mirror it with the flag on. **Fix:** new `resolveLegacyWeightsFor()`
(`_shared/shadowLanes.ts`), same shape as `resolveWeightsFor()` but
reading the frozen `LEGACY_WEIGHTS` table (no variant, no nb interim
treatment — legacy's `fg_ri.nb` is already 0). `computeBlendLane`
takes a new `useLegacyWeights` flag; `phase2Lane` passes `true`,
`phase3Lane` passes `false`. The live function
(`update-regime-portfolio-targets/index.ts`) was refactored to call
these exact same two functions for its own `wDesired` — the
phase2≡live-flag-off and phase3≡live-flag-on equivalence is now a
structural guarantee (same function call), not a coincidence that
could silently drift, and `tests/shadowLanes.test.ts`'s "phase2/phase3
mirror the live job's regime_phase3_weights gate" block pins it
directly. `RULES_VERSION` bumped to `shadow-v5`.

Today's `phase2`/`phase3` rows (both portfolios) had logged this same
day's earlier nb-interim-treatment rollout as organic `cap_complete`
turnover (`turnover_vs_prev = 5`) rather than a `rules_change` — a
miss of the lane's own standing rule, caught by the same review.
Retagged directly via SQL (no service-role JWT available to call
`?reseed=true` in this environment, same workaround used earlier this
session): `event = rules_change`, `turnover_vs_prev = 0`,
`rules_version = shadow-v5`, `phase2`'s `target_allocations` moved to
the frozen legacy `fg_ri` set (`eq:5/intl:5/em:0/nb:0/tip:20/com:30/
gld:30/cash:10`); `phase3`'s own numbers were already correct
(`eq:25/intl:5/em:0/nb:0/tip:25/com:10/gld:15/cash:20`) and only
needed the retag. Verified after: `regime_shadow_divergence.
phase2_vs_phase3 = 35.0` for both portfolios (not literally "~40" as
first guessed before working the exact numbers, but the same order of
magnitude and the right sign — a real, meaningful gap, not noise), and
`regime_shadow_summary.total_turnover` for both lanes is `NULL` (SQL
`SUM()` over zero matching rows, since every row either lane has ever
written is `seed` or `rules_change` — both excluded by the view's
filter — which is the correct semantic "zero real turnover logged,"
just not the literal integer `0`).

## Phase 4 §6.1/§6.2 shipped, shadow-only (2026-10-31)

Scope for this build: the sector-table half of Phase 4 only. §6.3
(nominal-bond duration by regime) is explicitly **not** built — see
its own entry below — and nothing here changes live behavior by
default; every new code path is gated off (`regime_phase4_sectors`
defaults `false`) or confined to the shadow log.

**§6.1 schema.** `portfolio_sector_targets` generalized exactly as
spec'd: added `bucket text not null default 'eq'` and
`variant text not null default 'base'`; unique key now
`(portfolio_id, bucket, symbol, regime_key, variant)`. Lookup order is
`(regime_key, variant)` first, falling back to `(regime_key, 'base')`
— `resolveSectorRows()` (`_shared/shadowLanes.ts`), the Deno-side
implementation; `app/portfolios/page.jsx`'s client fetch mirrors the
same fallback locally (a Deno module can't be imported into that
bundle).

**§6.2 / D-5, as tabled.** For the one portfolio that has ever used
sector tilts (All Weather With Equity Tilting): Stagflation (`fg_ri`)
**base and high both** get the new 9-symbol table (`XLV 18 / XLP 15 /
XLE 15 / XLF 11 / XLY 10 / XLB 9 / XLK 9 / XLI 8 / XLC 5`) — this
replaced the pre-D-5 base table outright, not just added a sibling.
Reflation (`rg_ri`) **high** is new (`XLE 22 / XLI 16 / XLK 15 / XLF
15 / XLY 10 / XLB 9 / XLV 7 / XLC 6`); `rg_ri`/base and every `rg_fi`/
`fg_fi` row are untouched. XLP is a new symbol with no holding yet —
`computeAllocationDeltas()` (`lib/simulatorKeys.js`) now returns a
separate `unheldSectorTargets` list (sector-tilt symbols with a
nonzero target and literally no linked holding, distinct from the
existing bucket-level `buyRows`) and `app/portfolios/page.jsx` renders
them in Portfolio Actions labeled "unheld target," so XLP's 15% don't
just silently vanish from the eq bucket's visible allocation.

**`phase4` shadow lane.** Asset-level mechanics are identical to
`phase3Lane` — same carry/blend/cap/hold, same D-1 table, same nb
interim treatment — so `phase4Lane` literally **is** `phase3Lane`;
Phase 4 only changes which sector table the orchestrator reads
(variant-aware via `resolveSectorRows`, vs. every other lane's
base-only slice). Seeded from `phase3`'s own current state on its
first-ever run (not the generic `SEED_BASE_KEY` constant) — "phase4 =
phase3 + the new sector tables" means it should start exactly where
phase3 already is — tagged `event = rules_change`, `turnover_vs_prev
= 0`, `turnover_uncapped = null`, mirroring the reseed convention
even though this is a first appearance, not a recompute. `LANE_IDS`/
`CAPPED_LANES` extended; `RULES_VERSION` bumped to `shadow-v6`.

**`regime_phase4_sectors` flag**, default `false` for both
portfolios, same pattern as `regime_auto_shift`/`regime_phase3_weights`.
Unlike those two, there is no server-side "live sector target" to
gate in an edge function — sector tilts have always been a pure
client-side blend in `app/portfolios/page.jsx`, with no
`portfolios`-table column storing them. The gate lives there instead:
with the flag off, the page's sector fetch is pinned to variant
`"base"` regardless of the portfolio's real `regime_blend.variant`
(byte-identical to `phase3`'s own always-base sector lookup); with it
on, it follows the real variant. `phase4` always computes the real
variant-aware table regardless of the flag (mirrors `phase3`'s
`variants_flag_off` convention) — tagged `blocked_reason =
"sectors_flag_off"` informationally when the flag is off and the real
variant isn't `base` and nothing more specific already explains the
row.

**Invariant tests** (`tests/shadowLanes.test.ts`), matching the
phase2/phase3 ones: `resolveSectorRows` exact-variant vs.
fall-back-to-base behavior, `phase4Lane === phase3Lane` identity, and
`resolveSectorRows(..., "base")` vs. `resolveSectorRows(...,
realVariant)` standing in for the live page's flag off/on split
(there's no shared Deno function to assert equality against directly,
since the gate itself is a client-side `.jsx` branch, not an edge
function — the pure-function-level assertion is the closest
equivalent this codebase's no-Supabase-mocking testing convention
allows).

**Same-day staleness, same failure mode as the nb-interim-treatment
incident:** the scheduled run earlier today had already written
`live`/`phase2`/`phase3`'s rows for 2026-10-31 under the pre-D-5
8-symbol table before this migration shipped. Retagged directly via
SQL (same reason as before — no service-role JWT in this
environment): `sector_targets` refreshed to the new 9-symbol set,
`rules_version` bumped to `shadow-v6`, and `event` set to
`rules_change` for `phase2`/`phase3` (the two lanes the reseed
mechanism actually covers — `live` got its `sector_targets` value
refreshed too since leaving it stale serves no purpose, but its
`event` was left alone, since `live` was never part of the reseedable
lane set to begin with). `turnover_vs_prev` was already 0 for all
three and needed no change — sector tables were never part of the
turnover calculation, only asset weights are, so this was a stale
*display* value, never a phantom-turnover risk.

**`regime_shadow_summary` turnover coalesce fix.** `total_turnover`
and `max_single_day_turnover` were `NULL` (not `0`) for any lane whose
every row so far is `seed`/`rules_change` (both excluded by the
view's own `FILTER`) — correct in meaning, wrong in type. Both
aggregates now `coalesce(..., 0)`.

## §6.3 (nb duration by regime) explicitly skipped — Bond Lens governs duration instead

Both regime-driven portfolios already have `use_bond_lens_overlay =
true`, which per the spec's own §6.3 caveat means Bond Lens governs
duration and the `nb` bucket rows should be skipped entirely — so
this phase does not add them, and does not touch
`applyNbInterimTreatment()` (Scott's 2026-10-30 decision) or its
`cash`/`tip` routing, which stays exactly as shipped.

**Decision (Scott, 2026-10-31):** the eventual fix for `nb`'s
duration exposure is **"add IEI as a Bond Lens eligible instrument
when Scott buys it,"** not a `bucket = 'nb'` row set in
`portfolio_sector_targets`. D-6 (§6.3's own decision) is effectively
superseded for both current regime-driven portfolios by this —
Bond Lens's own sleeve math already governs which Treasury duration
is held, so a separate nb-bucket override would either be redundant
with or fight Bond Lens, not complement it. Revisit only if a future
portfolio runs this framework with Bond Lens off.

## Bug fix: Phase 4 had the same base-variant leak as Phase 3's D-1 weights (2026-10-31)

Caught by Scott, not by review: the Phase 4 migration
(`regime_tilt_phase4_d5_sector_tables`) deleted `fg_ri`'s existing
`variant = 'base'` sector row outright and replaced it with D-5's new
9-symbol table (including `XLP`) — the exact same mistake
`legacyLane`/`phase2Lane` were fixed for above, just one layer down:
`resolveSectorRows()` read that same mutable `(regime_key, variant)`
table for **every** lane, so `legacy`/`live`/`phase2`/`phase3` all
picked up `XLP` regardless of `regime_phase4_sectors`, even though the
spec's own intent (confirmed by Scott) is that nothing changes unless
that flag is on. Verified live before fixing: all four non-`phase4`
lanes' same-day rows showed `XLP: 15` in `sector_targets`.

**Fix.** `portfolio_sector_targets` gets a new axis, not an overload
of `variant`: `table_version text` (`'v1'` | `'d5'`), unique key now
`(portfolio_id, bucket, symbol, regime_key, variant, table_version)`.
`'v1'` is restored to the exact pre-D-5 `fg_ri` table (`XLE 24 / XLV
16 / XLB 13 / XLF 10 / XLK 10 / XLC 9 / XLI 9 / XLY 9`, from migration
`20260912_portfolio_sector_targets.sql`) and copied as the frozen
`'v1'` row for every other regime key too; `'d5'` keeps D-5's full
variant-aware table (including the `fg_ri` revision and the new
`rg_ri`/`high` row-set). New `resolveLegacySectorRows(sectorTable,
regimeKey)` (`_shared/shadowLanes.ts`) reads `v1`/`base` only — no
variant concept, mirrors `resolveLegacyWeightsFor()` exactly.
`resolveSectorRows()` is now scoped strictly to `d5`. New
`sectorRowsFor(lane, ...)` dispatcher in
`update-regime-shadow-targets/index.ts`: `phase4` always resolves
`d5`; `live` follows `regime_phase4_sectors` (on → `d5`, off → `v1`,
via `resolveLegacySectorRows`); `legacy`/`phase2`/`phase3` always
resolve `v1`, full stop, regardless of the flag. The
`"sectors_flag_off"` informational tag no longer requires
`variant !== "base"` the way `variants_flag_off` does — D-5 revised
`fg_ri`'s `base` row itself, so `v1` and `d5` disagree even at
`variant = "base"`, unlike the weights case. `RULES_VERSION` bumped to
`shadow-v7`.

**Standing test**, explicitly requested to catch this whole class of
bug going forward, not just this one instance:
`PHASE_FLAG_INVARIANTS` in `tests/shadowLanes.test.ts` asserts, for
every phase-gate flag on record (`regime_phase3_weights`,
`regime_phase4_sectors`), that flag-off output is byte-identical to
the previous phase's lane, and flag-on is byte-identical to the new
phase's lane — generalized so a future Phase 5 flag gets the same
guarantee by adding one array entry, not a new bespoke test block.

**Same-day retag.** The scheduled run earlier today had already
written `live`/`phase2`/`phase3`'s rows for 2026-10-31 (All Weather
With Equity Tilting) with the leaked `d5` `fg_ri` table (`XLP`
included). After deploying the fix, re-invoking the function left
those three rows untouched (the main loop's upsert skips an existing
`(snapshot_date, portfolio_id, lane)` row rather than overwriting it)
— so retagged directly via SQL (no service-role JWT in this
environment, same workaround as every prior same-day correction this
phase): `sector_targets` set back to the frozen `v1` 8-symbol table,
`rules_version = shadow-v7`, `event = rules_change`,
`turnover_vs_prev = 0` (already 0 for all three — sector tables have
never factored into turnover). `regime_shadow_state.
current_sector_targets` updated to match for the same three lanes.
`phase4`'s row was already correct (it's the one lane meant to show
`d5`) and only needed its `rules_version` stamp bumped. Verified after:
only `phase4` shows `XLP` in today's `sector_targets` for this
portfolio; `legacy`/`live`/`phase2`/`phase3` all show the restored
8-symbol `v1` table. The other regime-driven portfolio has no sector
tilt rows at all, so it was unaffected throughout.
